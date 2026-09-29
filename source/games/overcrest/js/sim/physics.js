/* Overcrest — the vehicle engine. Original, built for this game.
 *
 * A four-corner model: each wheel carries its own vertical load (static +
 * longitudinal + lateral weight transfer), pushes through its own friction
 * disc, and the car's motion is the sum of what the four contact patches
 * actually did. Weight transfer isn't a garnish here — lift-off rotation,
 * Scandinavian flicks and braking stability all emerge from the loads.
 *
 * The tire law is a soft-knee saturation: F = grip·Fz·tanh(α/bite)·fade.
 * `bite` is how sharply a surface takes slip angle, `fade` how edgy it is
 * past the peak — tarmac is pointy and punishing, gravel and snow take an
 * angle and hold it, which is what makes long slides feel serene.
 *
 * Vertical motion is a real degree of freedom: a virtual suspension
 * (spring + damper that can only push) chases the ground. Crests unload
 * it, jumps happen when the ground falls away faster than it can follow,
 * compressions press the car into the road and briefly GIVE grip. No
 * glue-to-ground anywhere.
 *
 * Conventions (Y-up render frame, XZ ground plane):
 *   heading yaw: forward = (cos yaw, sin yaw) in (x,z)
 *   right      = (-sin yaw, cos yaw); body +y (vy) is RIGHTWARD velocity
 *   positive yaw rate / steer / curvature = a right-hand turn on screen
 *
 * Fixed 120 Hz. Deterministic: no Math.random, no wall clock, DOM-free.
 */

import { surfaceParams, groundParams } from "./surfaces.js";

export const DT = 1 / 120;
export const TICK_RATE = 120;
export const G = 9.81;

export const KESTREL = {
  mass: 1150,
  izz: 1480,
  a: 1.14,            // CG -> front axle
  b: 1.36,            // CG -> rear axle
  track: 1.52,
  h: 0.47,            // CG height
  wheelR: 0.30,

  // virtual suspension (whole-car vertical DOF)
  suspHz: 3.4,
  suspZeta: 0.75,
  droop: 0.24,        // m of extension before the wheels leave the ground

  // engine: turbo inline-4
  idle: 1000,
  redline: 7600,
  peakTorque: 330,    // Nm before turbo
  turboMax: 0.38,     // extra torque fraction at full boost pressure
  gears: [3.25, 2.20, 1.62, 1.27, 1.08, 1.00],
  finalDrive: 4.15,
  shiftUp: 7100,
  shiftDown: 3300,
  shiftCut: 0.13,     // s of torque dip on a shift
  driveEff: 0.85,
  splitFront: 0.45,   // AWD torque split

  cda: 0.70,
  rho: 1.2,
  brakeForce: 16000,
  brakeBias: 0.60,    // front share
  steer0: 0.46,       // rad, standstill lock

  // collision capsule: two circles along the body axis
  capsule: [ { px: 1.05, r: 0.85 }, { px: -1.05, r: 0.85 } ],
};

/* Top speed with stock gearing (6th at the limiter). The road generator
 * sizes "flat" corners against this so the promise holds at any arrival. */
export const VCAP = 57.5;

/* Wheel layout: py > 0 is the RIGHT side. Order: FL, FR, RL, RR.
 * Exported because the car MESH hangs its wheels on exactly these points —
 * the contact patches the sim reasons about and the rubber you can see have
 * to be the same four places, or the car floats. */
export const WHEELS = [
  { px: KESTREL.a, py: -KESTREL.track / 2, front: true },
  { px: KESTREL.a, py: KESTREL.track / 2, front: true },
  { px: -KESTREL.b, py: -KESTREL.track / 2, front: false },
  { px: -KESTREL.b, py: KESTREL.track / 2, front: false },
];

const SUSP_W = 2 * Math.PI * KESTREL.suspHz;
const SUSP_K = KESTREL.mass * SUSP_W * SUSP_W;
const SUSP_D = 2 * KESTREL.suspZeta * KESTREL.mass * SUSP_W;
const SUSP_REST = G / (SUSP_W * SUSP_W);   // static compression

export const DEFAULT_MODS = Object.freeze({
  power: 1,
  grip: 1,
  brake: 1,
  drag: 1,
  stability: 1,      // scales path damper + slide stabilizer
  slideCeiling: 0,   // radians added before the stabilizer wakes up
  boostPower: 1,
  damageScale: 1,
  airSteer: 0,       // rad/s² of airborne yaw authority per full stick
  landing: 1,        // scales landing scrub + landing damage
  offDrag: 1,        // scales off-road drag
  lift: 1,           // scales the take-off kick: >1 flies further, <1 hugs the deck
  rollResist: 1,     // scales the rollover budget: >1 is harder to trip over
  landWheels: 0,     // 0..1 added to the chance a rolled car settles on its wheels
});

/* Deterministic micro-noise (surface rumble): pure function of its inputs. */
function noise1(tick, x, z) {
  let h = (tick * 0x9e3779b1) ^ (Math.round(x * 11) * 0x85ebca77) ^ (Math.round(z * 11) * 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296 - 0.5;
}

export function makeCar() {
  return {
    // pose
    x: 0, y: 0, z: 0, yaw: 0,
    // body-frame velocity (+vy = rightward), yaw rate
    vx: 0, vy: 0, omega: 0,
    // vertical DOF
    vyUp: 0, grounded: true, airTime: 0, landTimer: 0,
    // steering
    sigma: 0, steer: 0,
    // pedals
    throttle: 0, brake: 0, handbrake: false, hbBlend: 0, boosting: false,
    // drivetrain
    gear: 1, rpm: KESTREL.idle, shiftTimer: 0, turbo: 0, wheelspin: 0,
    // attitude (render)
    pitch: 0, roll: 0, pitchV: 0,
    groundPitch: 0, groundRoll: 0,
    // ground height under each wheel (FL, FR, RL, RR) — the renderer hangs
    // the wheels off these so all four stay on the deck over broken ground
    wheelY: [0, 0, 0, 0],
    holding: false,
    // tyre relaxation states (per axle)
    alphaF: 0, alphaR: 0,
    // smoothed accelerations for load transfer
    axS: 0, ayS: 0,
    // ground bookkeeping
    surface: "gravel", zone: "road", loadScale: 1,
    s: 0, d: 0, roadGrade: 0, lastG: null, oobT: 0,
    // feel metrics
    beta: 0, slip: 0, skid: 0,
    // damage & recovery
    damage: 0, lastImpact: 0, crashTimer: 0, stuckT: 0, offRoadT: 0, deepOff: 0,
    /* THE THREE ENDS (Phase 25.2): rollover budget and tumble, the roof,
     * deep water, and the fall — see rolloverStep and the ground block */
    rollE: 0, rollT: 0, rollDir: 1, rollSpin: 0, onRoof: false, rolls: 0, sideTrip: 0, offGrip: 0,
    rollV: 0, rollDx: 0, rollDz: 0,        // the tumble's travel: sideways speed and world direction at the trip
    rollAng: Math.PI * 2, rollDur: 1.4, rollRoof: false,   // the tumble's shape, decided at the trip
    inWater: 0, waterT: 0, drowned: false, lastGroundY: null, plunged: false,
    /* damage with a memory: WHERE the car was hit shapes how it drives.
     * pullDir: the wheel tugs gently toward the side that took the hit.
     * softW: the wheel nearest the hit runs a little soft. Both retune,
     * never punish — the bible's rule is a story, not a death spiral. */
    pullDir: 0, softW: -1,
    // the car wears its journey: mud gathers off the tarmac, dries to dust
    mud: 0, mudWet: 0,
    // and per wheel: the wheel that ran the verge dirties ITS arch
    mudW: [0, 0, 0, 0],
    // bump-stop transient (m/s of compression the cap could not absorb)
    suspHit: 0,
    // stuck detection: progress anchor (see the stuck block in step)
    stAnchorX: 0, stAnchorZ: 0,
    tick: 0,
  };
}

/* Steering lock: the wheel must reach kinematic angle PLUS the slip angle
 * the tire needs to build its force (≈ 2.2·bite at the peak) — a lock that
 * ignores slip can never load the fronts at speed and the car understeers
 * off every fast corner. Generous past the limit: Overcrest steers into
 * slides on purpose. */
export function steerLockAt(v, grip, bite) {
  const L = KESTREL.a + KESTREL.b;
  const gripLock = Math.atan((L * grip * G * 1.2) / Math.max(30, v * v));
  // kinematic angle + a bit past the tyre's peak: full lock loads the
  // fronts fully but does not throw them far past the peak into a wash
  return Math.min(KESTREL.steer0, gripLock * 1.15 + 2.1 * (bite || 0.062) + 0.03 * Math.min(1, 12 / Math.max(1, v)));
}

/* Digital steering: keys press a rate. Fast attack when the wheel is
 * centred, slower as lock builds, quickest of all when correcting a slide;
 * a shade calmer at speed so a tap places the car rather than pitching it.
 *
 * STEER_ATTACK is a live tuning knob (`?steer=0.75` via setSteerFeel):
 * it scales the initial attack only — corrections and the return to
 * centre keep their speed, because a slide must always be catchable.
 * Here because of a hands-on report ("twitchy at base form", 2026-08-25):
 * the rates were tuned on Norrland gravel, and the journey now OPENS on
 * Heartland tarmac, whose sharper tyre builds force much faster for the
 * same tap. The dialled-in number decides the per-surface fix. */
let STEER_ATTACK = 1;
export function setSteerFeel(k) { STEER_ATTACK = Math.max(0.4, Math.min(1.4, k || 1)); }
function updateSteerDigital(car, dir, dt, v) {
  dir = dir > 0 ? 1 : dir < 0 ? -1 : 0;   // NaN here would poison the sim
  const correcting = dir !== 0 && dir * Math.sign(car.vy || 0) > 0 && Math.abs(car.beta) > 0.12;
  const speedCalm = 1 - 0.3 * Math.min(1, (v || 0) / 45);
  if (dir !== 0) {
    const crossing = car.sigma * dir < -0.02;
    let rate = crossing ? 6.5 : 4.6 * STEER_ATTACK * (1 - 0.5 * Math.abs(car.sigma)) * speedCalm;
    if (correcting) rate *= 1.7;
    car.sigma += dir * rate * dt;
  } else {
    const ret = 5.6;
    if (Math.abs(car.sigma) <= ret * dt) car.sigma = 0;
    else car.sigma -= Math.sign(car.sigma) * ret * dt;
  }
  car.sigma = Math.max(-1, Math.min(1, car.sigma));
}

/* Analog: the stick is a sigma target, chased fast (rate floor beats noise). */
function updateSteerAnalog(car, target, dt) {
  const err = target - car.sigma;
  const rate = Math.max(7, Math.abs(err) * 20);
  car.sigma += Math.sign(err) * Math.min(Math.abs(err), rate * dt);
  car.sigma = Math.max(-1, Math.min(1, car.sigma));
}

/* Engine torque with turbo pressure; returns wheel force. */
function drivetrain(car, input, mods, dt, ev) {
  const K = KESTREL;
  // rpm follows wheel speed through the box
  const ratio = K.gears[car.gear - 1] * K.finalDrive;
  const wheelRps = Math.max(0, car.vx) / K.wheelR;
  let rpm = Math.max(K.idle, wheelRps * ratio * (60 / (2 * Math.PI)));

  /* the hurt engine's early limiter (used below) — and the box must SHIFT
   * under it, or a deep redline traps the car a gear down forever */
  const red = K.redline - 900 * Math.min(1, Math.max(0, (car.damage - 55) / 45));
  const shiftUp = Math.min(K.shiftUp, red - 180);

  // automatic box with kickdown
  if (car.shiftTimer > 0) car.shiftTimer -= dt;
  else if (rpm > shiftUp && car.gear < K.gears.length) { car.gear++; car.shiftTimer = K.shiftCut; ev.gearChange = car.gear; }
  else if (rpm < K.shiftDown && car.gear > 1) { car.gear--; car.shiftTimer = K.shiftCut; ev.gearChange = car.gear; }
  else if (input.throttle > 0.9 && car.gear > 1 && rpm < 4600) {
    const downRatio = K.gears[car.gear - 2] * K.finalDrive;
    const downRpm = wheelRps * downRatio * (60 / (2 * Math.PI));
    if (downRpm < shiftUp - 400) { car.gear--; car.shiftTimer = K.shiftCut; ev.gearChange = car.gear; }
  }
  const r2 = K.gears[car.gear - 1] * K.finalDrive;
  rpm = Math.max(K.idle, wheelRps * r2 * (60 / (2 * Math.PI)));

  // turbo pressure: spools with load, collapses on lift
  const spoolTarget = car.throttle * Math.max(0, Math.min(1, (rpm - 2600) / 2600));
  const tau = spoolTarget > car.turbo ? 0.5 : 0.12;
  const turboWas = car.turbo;
  car.turbo += (spoolTarget - car.turbo) * Math.min(1, dt / tau);
  if (turboWas > 0.5 && car.throttle < 0.2 && !ev.blowOff) ev.blowOff = true;

  // torque bell: peak near 4300, ~68% at idle and redline; limiter fuel-cut.
  // A hurt engine will not rev out — the limiter arrives early (see `red`
  // above the shifter), which is what actually costs top speed on a car
  // that is otherwise gearing-bound. Deepened to −900 rpm by damage 100
  // (owner: "damage isn't punishing enough"); the harness floor is 86%.
  const t = Math.max(0, Math.min(1, (rpm - K.idle) / (K.redline - K.idle)));
  let torque = K.peakTorque * (0.5 + 0.5 * Math.sin(Math.PI * (0.12 + 0.76 * t)));
  if (rpm >= red) torque *= 0.15;                       // fuel cut
  torque *= 1 + K.turboMax * car.turbo;
  if (car.shiftTimer > 0) torque *= 0.15;               // shift cut

  let force = (torque * r2 * K.driveEff) / K.wheelR;
  force = Math.min(force, 12500);                        // 1st-gear sanity
  // a hurt engine fades in, gently: up to −10%, never a cliff
  /* a wreck is DOWN ON POWER — deepened (owner: "damage isn't punishing
   * enough"): −22% by damage 100, was −10% (the harness keeps the floor:
   * top speed at damage 100 must stay ≥ 86% of fresh — a story, not a
   * death spiral) */
  const dmg = 1 - 0.22 * Math.min(1, Math.max(0, (car.damage - 55) / 45));
  const boost = car.boosting ? 1 + 0.35 * mods.boostPower : 1;
  force *= car.throttle * mods.power * dmg * boost;

  // audio rpm: flare with wheelspin
  const targetRpm = rpm + car.wheelspin * 1400;
  car.rpm += (targetRpm - car.rpm) * Math.min(1, dt * 16);
  car.rpm = Math.min(car.rpm, K.redline + 200);
  return force;
}

/* The tire law. α in rad, returns signed lateral force (opposes slip). */
function latForce(alpha, fz, p) {
  const knee = Math.tanh(alpha / p.bite);
  const excess = Math.abs(alpha) - 2 * p.bite;
  const fade = excess > 0 ? 1 / (1 + p.fade * excess * excess) : 1;
  return -p.grip * fz * knee * fade;
}

/* One 120 Hz step.
 * input: {dir, steerAnalog, throttle, brake, handbrake, boost}
 * world: groundHeight(x,z,sHint) -> {y,on,rq{...,surf}} | null; colliderHash;
 *        wetness 0..1; offroadKey
 * mods:  DEFAULT_MODS-shaped snapshot (souvenir pipeline output)
 */
export function step(car, world, input, mods) {
  if (!mods) mods = DEFAULT_MODS;
  const K = KESTREL;
  const m = K.mass;
  car.tick++;
  const ev = { tookOff: false, landed: 0, air: 0, impact: 0, surface: null, gearChange: 0, blowOff: false, rolled: false, settled: null, drowned: false, plunged: 0, collider: null };
  car.sideTrip = 0;

  // ---------------------------------------------------------------- ground
  const cosY = Math.cos(car.yaw), sinY = Math.sin(car.yaw);
  const fwdX = cosY, fwdZ = sinY;
  const rgtX = -sinY, rgtZ = cosY;

  let gC = world.groundHeight(car.x, car.z, car.s);
  if (!gC) {
    // past the mapped world: coast on the last known ground, bleed speed;
    // the game layer watches oobT and walks the car back to the road.
    car.oobT += DT;
    gC = car.lastG || { y: car.y, on: "off", rq: { s: car.s, d: car.d, hw: 4, grade: 0, curv: 0, heading: car.yaw, surf: car.surface } };
    car.vx *= 1 - 0.7 * DT;
  } else {
    car.oobT = 0;
    car.lastG = gC;
  }
  const rq = gC.rq;
  car.zone = gC.on;
  car.s = rq.s;
  car.d = rq.d;
  car.roadGrade = rq.grade || 0;
  /* DEEP WATER (a lake or the sea beyond its shore — never the shallow
   * water a ford lays across the road): the car wades and slows hard, and
   * once it has stopped in it, it is stranded. The run layer decides what
   * that costs; `drowned` fires once per swim. */
  const inWater = !!(gC.water || gC.ground === "water");
  car.inWater = inWater ? 1 : 0;
  if (inWater) {
    car.vx *= 1 - 2.2 * DT; car.vy *= 1 - 2.2 * DT;
    car.waterT += DT;
    if (car.waterT > 1.2 && Math.abs(car.vx) < 3 && !car.drowned) { car.drowned = true; ev.drowned = true; }
  } else car.waterT = 0;

  // wheel-corner ground probes → plane the car sits on
  const wy = car.wheelY;
  for (let i = 0; i < 4; i++) {
    const w = WHEELS[i];
    const g = world.groundHeight(
      car.x + fwdX * w.px + rgtX * w.py,
      car.z + fwdZ * w.px + rgtZ * w.py,
      car.s
    );
    wy[i] = g ? g.y : gC.y;
  }
  const yFL = wy[0], yFR = wy[1], yRL = wy[2], yRR = wy[3];
  const yFront = (yFL + yFR) / 2, yRear = (yRL + yRR) / 2;
  const yLeft = (yFL + yRL) / 2, yRight = (yFR + yRR) / 2;
  const groundY = (yFront * K.b + yRear * K.a) / (K.a + K.b);  // under the CG
  const fwdSlope = (yFront - yRear) / (K.a + K.b);
  const latSlope = (yRight - yLeft) / K.track;
  car.groundPitch = Math.atan(fwdSlope);
  car.groundRoll = Math.atan(latSlope);

  // surface change event (only on the road — verges don't count)
  if (rq.surf && rq.surf !== car.surface && gC.on === "road") {
    ev.surface = { from: car.surface, to: rq.surf };
    car.surface = rq.surf;
  }

  // ------------------------------------------------------------ suspension
  const compression = groundY - car.y;                 // + = pressed up
  const groundVel = fwdSlope * car.vx + latSlope * car.vy;
  const cDot = groundVel - car.vyUp;
  let suspF = 0;
  const wasGrounded = car.grounded;
  if (compression > -K.droop) {
    /* capped: a kerb-height step under the wheels is a jolt, not a launch
     * ramp — the hard floor below catches anything the cap lets through */
    suspF = Math.min(3.6 * m * G, Math.max(0, SUSP_K * (compression + SUSP_REST) + SUSP_D * cDot));
    car.grounded = suspF > 0 || compression > -SUSP_REST;
    // bottomed out: the force cap is the bump stop — the audio hears it
    if (suspF >= 3.59 * m * G) car.suspHit = Math.max(car.suspHit, Math.abs(cDot));
  } else {
    car.grounded = false;
  }
  car.loadScale = Math.max(0, Math.min(1.7, suspF / (m * G)));
  car.suspHit = Math.max(0, car.suspHit - 14 * DT);

  // vertical integration (suspension can push, gravity always pulls)
  car.vyUp += (suspF / m - G) * DT;
  car.y += car.vyUp * DT;
  // never sink through the ground: hard floor with damped rebound
  if (car.y < groundY - 0.35) { car.y = groundY - 0.35; car.vyUp = Math.max(car.vyUp, cDot * 0.4); car.suspHit = Math.max(car.suspHit, Math.abs(cDot)); }

  // takeoff / landing bookkeeping
  if (wasGrounded && !car.grounded && car.vx > 7) {
    ev.tookOff = true;
    car.airTime = 0;
    /* the LIFT mod (souvenir pipeline): a kick added at the instant the
     * wheels leave the deck — a Helium Bottle flies further, a Lead Sled
     * barely gets up. Landing impact stays bounded by the flight itself
     * (G·airTime + 2 below), so a big lift costs airtime and a harder
     * landing, never a spike; a negative kick is caught by the hard floor. */
    if (mods.lift !== 1) car.vyUp += (mods.lift - 1) * 2.4;
  }
  if (!car.grounded) {
    car.airTime += DT;
  } else if (!wasGrounded) {
    // landed: impact = closing speed, bounded by what the flight could build
    const closing = Math.max(0, -(car.vyUp - groundVel));
    const impact = Math.min(closing, G * car.airTime + 2);
    ev.landed = impact;
    ev.air = car.airTime;
    /* THE FALL: a drop of more than a dozen metres from the last ground the
     * car stood on — off a viaduct, over a cliff lip — is an incident
     * whatever the landing did to the bodywork (a hit cap must not make a
     * gorge survivable). Once per fall; the run layer clears it. */
    const drop = (car.lastGroundY != null ? car.lastGroundY : car.y) - car.y;
    if (drop > 12 && !car.plunged) { car.plunged = true; ev.plunged = drop; }
    car.landTimer = 0.25;
    car.pitchV -= impact * 0.04;
    // sideways landings scrub speed and straighten the car a little
    const mis = Math.min(0.9, Math.abs(car.beta));
    const scrub = Math.min(0.24, impact * 0.011 + mis * 0.1) * mods.landing;
    car.vx *= 1 - scrub;
    car.vy *= 0.8;
    car.yaw += Math.sign(car.beta) * Math.min(0.06, mis * 0.12);
    if (impact > 8.5) { car.damage += (impact - 8.5) * 5 * mods.damageScale * mods.landing; ev.impact = Math.max(ev.impact, impact); ev.landImpact = true; }
    car.airTime = 0;
  }
  if (car.landTimer > 0) car.landTimer -= DT;
  if (car.grounded) car.lastGroundY = car.y;

  // ---------------------------------------------------------------- pedals
  /* `hold` is the parking brake the game layer pulls when the car is meant
   * to STAY somewhere — waiting at a waystation, or after the run is over.
   * It is not the brake pedal: the pedal turns into reverse at a standstill
   * (deliberately — that is how you back out of a ditch), and a state that
   * held the pedal down would quietly drive the car away backwards. */
  // a tumbling car, or one on its roof, answers nobody's pedals
  const hold = !!input.hold || car.rollT > 0 || car.onRoof;
  car.holding = hold;
  if (hold) { input = { ...input, throttle: 0, brake: 1, handbrake: false, boost: false, dir: 0, steerAnalog: 0 }; }
  car.throttle += Math.max(-8 * DT, Math.min(8 * DT, input.throttle - car.throttle));
  car.brake += Math.max(-10 * DT, Math.min(10 * DT, input.brake - car.brake));
  car.handbrake = !!input.handbrake;
  car.hbBlend += ((car.handbrake ? 1 : 0) - car.hbBlend) * Math.min(1, 9 * DT);
  car.boosting = !!input.boost;
  const hb = car.hbBlend;

  // ------------------------------------------------------- surface params
  const wet = world.wetness || 0;
  const road = surfaceParams(rq.surf || car.surface, wet);
  const offG = groundParams(world.offroadKey || "grass", wet);
  let params, extraDrag = 0, roughAmt;
  if (gC.on === "road") {
    params = road; roughAmt = road.rough;
    car.offRoadT = 0;
  } else if (gC.on === "shoulder") {
    params = { grip: road.grip * 0.82, bite: road.bite * 1.15, fade: road.fade * 0.6, roll: road.roll, rough: 0.8 };
    extraDrag = 1.1; roughAmt = 0.8;
  } else {
    /* SOFT GROUND deepens with distance from the road (owner order
     * 2026-08-26: "a punishment for going too far off-road — it's a rally
     * game, not an offroading game"). The verge and the recovery corridor
     * — the first six metres past the shoulder — drive exactly as they
     * always did, so a run-off moment and the way back cost what they
     * cost before. Past that, ground no road ever compacted bogs the car
     * down: drag climbs and grip fades until, twenty-odd metres out,
     * cross-country is a crawl. Honest and visible (it is the same field
     * you can see), biome-flavoured through the country's own off-road
     * surface, and never a wall — recovery works unchanged, and the way
     * back is simply the road. */
    const deep = Math.min(1, Math.max(0, (Math.abs(rq.d) - rq.hw - 6) / 16));
    params = { grip: offG.grip * (1 - 0.22 * deep), bite: 0.13, fade: 0.6, roll: 0.03 + 0.05 * deep, rough: offG.rough };
    extraDrag = offG.drag * mods.offDrag * (1 + 10 * deep);
    roughAmt = offG.rough;
    car.offRoadT += DT;
    car.deepOff = deep;
    car.offGrip = offG.grip;                 // the rollover reads whether this ground GRABS
  }
  if (gC.on !== "off") { car.deepOff = 0; car.offGrip = 0; }
  // worn grip is a RAMP from damage 50, not a cliff at 90: −8% by 110
  const gripMul = mods.grip * (1 - 0.08 * Math.min(1, Math.max(0, (car.damage - 50) / 60)));
  const muW = params.grip * gripMul;

  // -------------------------------------------------------------- steering
  car.beta = Math.atan2(car.vy, Math.max(3.5, Math.abs(car.vx)));
  if (input.steerAnalog != null) updateSteerAnalog(car, input.steerAnalog, DT);
  else updateSteerDigital(car, input.dir, DT, Math.abs(car.vx));
  const lock = steerLockAt(Math.abs(car.vx), muW, params.bite);
  // countersteer reach: steering toward the direction of travel extends lock
  const correcting = car.sigma * car.vy > 0 && Math.abs(car.beta) > 0.1;
  const reach = correcting ? Math.min(0.4, Math.abs(car.beta) * 0.55) : 0;
  // a steering rack, not a servo: the wheel reaches its angle over ~60 ms
  let steerWant = car.sigma * (lock + reach);
  /* A bent track rod: past ~45 damage the wheel pulls gently toward the
   * side that took the hit. Constant LATERAL acceleration (≈0.4 m/s² at
   * full effect), so it is the same small correction at any speed — a
   * thing you hold against without thinking, never a fight. */
  if (car.pullDir !== 0 && car.damage > 45) {
    const pk = Math.min(1, (car.damage - 45) / 55);
    steerWant += car.pullDir * pk * Math.atan((0.4 * (K.a + K.b)) / Math.max(60, car.vx * car.vx));
  }
  car.steer += (steerWant - car.steer) * Math.min(1, DT / 0.035);
  const delta = car.grounded ? car.steer : car.steer * 0.5;

  // ------------------------------------------------------------- airborne
  if (!car.grounded) {
    // world velocity is conserved; the body frame rotates under it
    let wvx = car.vx * cosY - car.vy * sinY;
    let wvz = car.vx * sinY + car.vy * cosY;
    car.x += wvx * DT;
    car.z += wvz * DT;
    if (mods.airSteer > 0) car.omega += car.sigma * mods.airSteer * DT;
    car.omega *= 1 - 0.5 * DT;
    car.yaw += car.omega * DT;
    const c2 = Math.cos(car.yaw), s2 = Math.sin(car.yaw);
    car.vx = wvx * c2 + wvz * s2;
    car.vy = -wvx * s2 + wvz * c2;
    // pitch authority: throttle nose-up, brake nose-down
    car.pitchV += (car.throttle * 1.5 - car.brake * 2.1) * DT;
    car.pitch += car.pitchV * DT;
    car.pitch = Math.max(-0.55, Math.min(0.55, car.pitch));
    car.roll *= 1 - 1.5 * DT;
    car.wheelspin *= 1 - 3 * DT;
    drivetrain(car, input, mods, DT, ev);   // revs flare in the air
  } else {
    // ------------------------------------------------------- ground forces
    const vxA = Math.max(0.6, Math.abs(car.vx));
    /* The low-speed fade exists to kill tyre jitter at rest — it must gate
     * on TOTAL planar speed, not forward speed. Gated on |vx| alone it
     * stripped a sideways-sliding car of its lateral grip (vx ≈ 1, vy ≈ 20
     * → 31% grip), so nothing could check the slide while the bot's own
     * thrust kept feeding it — measured pumping to 39.7 m/s of lateral
     * speed at walking pace. A fast car is a fast car in any direction. */
    const lowSpeed = Math.min(1, Math.hypot(car.vx, car.vy) / 3.2);

    // axle slip angles with tyre relaxation (force builds over travel)
    const dirV = car.vx >= 0 ? 1 : -1;
    const aFraw = Math.atan((car.vy + K.a * car.omega) / vxA) - delta * dirV;
    const aRraw = Math.atan((car.vy - K.b * car.omega) / vxA);
    const relax = Math.min(1, (Math.abs(car.vx) * DT) / 0.3);
    car.alphaF += (aFraw - car.alphaF) * relax;
    car.alphaR += (aRraw - car.alphaR) * relax;

    // per-wheel vertical loads: static + longitudinal + lateral transfer
    const L = K.a + K.b;
    const FzF_tot = Math.max(m * 1.0, (m * G * K.b) / L - (m * car.axS * K.h) / L);
    const FzR_tot = Math.max(m * 1.0, (m * G * K.a) / L + (m * car.axS * K.h) / L);
    const dWaxle = (m * car.ayS * K.h) / (2 * K.track);   // per-axle side shift
    const loads = [
      Math.max(0, FzF_tot / 2 + dWaxle), // FL: ay>0 (right turn) loads the LEFT
      Math.max(0, FzF_tot / 2 - dWaxle),
      Math.max(0, FzR_tot / 2 + dWaxle),
      Math.max(0, FzR_tot / 2 - dWaxle),
    ];
    for (let i = 0; i < 4; i++) loads[i] *= car.loadScale;

    // drive & brake demands
    const engF = drivetrain(car, input, mods, DT, ev);
    const driveFront = (engF * K.splitFront) / 2;
    const driveRear = (engF * (1 - K.splitFront) * (1 - hb)) / 2;
    let brakeFront = (car.brake * K.brakeForce * K.brakeBias * mods.brake) / 2;
    let brakeRear = (car.brake * K.brakeForce * (1 - K.brakeBias) * mods.brake) / 2;
    if (car.throttle < 0.05 && Math.abs(car.vx) > 2) { brakeFront += 140; brakeRear += 180; } // engine braking
    let reverseF = 0;
    /* Reverse only engages on a car that is actually at rest-ish IN TOTAL,
     * not merely in vx: a spun car sliding at high LATERAL speed still
     * satisfies the vx window, and feeding it 3400 N while the reverse-
     * travel yaw instability rotates the frame pumps |vy| without bound —
     * measured at 39.7 m/s of sideways speed, at "walking pace", into a
     * rock. Reversing is for ditches, not for pirouettes. */
    if (!hold && car.brake > 0.3 && car.vx < 0.5 && car.vx > -7.5 && Math.abs(car.vy) < 6) {
      reverseF = -3400 * car.brake;
      brakeFront = 0; brakeRear = 0;
    }

    // slide stabilizer: deep slides make the rear dig in and stabilize —
    // suspended while the handbrake asks for rotation
    const beta0 = 0.42 + (mods.slideCeiling || 0);
    const digIn = Math.abs(car.beta) > beta0 && hb < 0.5
      ? 1 + 0.5 * Math.min(1, (Math.abs(car.beta) - beta0) / 0.35) * mods.stability
      : 1;

    let Fx = 0, Fy = 0, M = 0, spin = 0;
    for (let i = 0; i < 4; i++) {
      const w = WHEELS[i];
      const fz = loads[i];
      if (fz < 1) continue;
      const alpha = w.front ? car.alphaF : car.alphaR;
      const p = params;

      // lateral demand from the law
      /* Front-limited balance (what makes a car feel safe AND fun): the rear
       * axle has a little more grip and hangs on further past its peak, so
       * at the limit the FRONT washes wide first — you feel it push, you
       * lift, it tucks in. A rear that lets go first is a spin waiting for
       * a keyboard. (Telemetry 2026-08-18: 153 km/h, 3° of steer, the rear
       * walked out over a full second. Not any more.) */
      let gripW = muW * (w.front ? 0.98 : 1.1);
      /* One soft corner: the wheel nearest the last big hit gives up a few
       * percent. Enough to feel the car load unevenly in one direction of
       * corner; never enough to spin it. */
      if (i === car.softW && car.damage > 30) {
        gripW *= 1 - 0.05 * Math.min(1, (car.damage - 30) / 60);
      }
      const fadeW = w.front ? p.fade : p.fade * 0.65;
      let fyW = latForce(alpha, fz, { grip: gripW, bite: p.bite, fade: fadeW }) * lowSpeed;
      if (!w.front) {
        fyW *= (1 - 0.7 * hb) * digIn;    // handbrake lets go; stabilizer digs in
      }

      // longitudinal demand
      let fxW;
      if (reverseF) {
        fxW = reverseF / 4;
      } else if (!w.front && hb > 0.01) {
        // locked rear: kinetic drag opposing motion + whatever pedal asks
        fxW = -Math.sign(car.vx) * muW * fz * 0.8 * hb - Math.min(brakeRear, muW * fz) * Math.sign(car.vx) * (1 - hb);
      } else {
        const drive = w.front ? driveFront : driveRear;
        const brake = w.front ? brakeFront : brakeRear;
        fxW = drive - brake * Math.sign(car.vx || 1);
        const cap = muW * fz * 0.95;
        if (drive > cap) spin += (drive - cap) / Math.max(1, cap);
      }

      /* friction disc, lateral first: steering keeps up to 92% of the disc
       * if it asks, longitudinal gets what's left. Pure braking gets the
       * whole disc; trail-braking automatically keeps the car steerable. */
      const cap = gripW * fz;
      const fyAllowed = Math.max(-cap * 0.97, Math.min(cap * 0.97, fyW));
      const fxBudget = Math.sqrt(Math.max(0, cap * cap - fyAllowed * fyAllowed));
      const fxAllowed = Math.max(-fxBudget, Math.min(fxBudget, fxW));
      fxW = fxAllowed;
      fyW = fyAllowed;

      // rotate front wheel forces by steer into the body frame
      let fxB = fxW, fyB = fyW;
      if (w.front) {
        const cd = Math.cos(delta), sd = Math.sin(delta);
        fxB = fxW * cd - fyW * sd;
        fyB = fxW * sd + fyW * cd;
      }
      Fx += fxB;
      Fy += fyB;
      M += w.px * fyB - w.py * fxB;
    }
    car.wheelspin += (Math.min(1, spin) - car.wheelspin) * 0.12;

    // aero, rolling, slope, off-road drag — bent panels catch the air
    const dragMul = mods.drag * (car.boosting ? 0.88 : 1)
      * (1 + 0.14 * Math.min(1, Math.max(0, (car.damage - 55) / 45)));
    Fx -= 0.5 * K.rho * K.cda * car.vx * Math.abs(car.vx) * dragMul;
    Fx -= params.roll * m * G * Math.sign(car.vx) * Math.min(1, Math.abs(car.vx));
    Fx -= m * G * Math.sin(car.groundPitch);
    Fy -= m * G * Math.sin(car.groundRoll);
    Fx -= extraDrag * m * 0.1 * Math.min(1, Math.abs(car.vx) / 8) * Math.sign(car.vx || 1);

    // integrate body frame (with rotating-frame terms)
    car.vx += (Fx / m + car.vy * car.omega) * DT;
    car.vy += (Fy / m - car.vx * car.omega) * DT;
    car.omega += (M / K.izz) * DT;
    /* deep-slide yaw damping: past ~35° of body slip the car stops winding
     * itself up — a slide stays a slide instead of becoming a spin. Only
     * bleeds yaw rate that is still ADDING to the slide; a countersteer that
     * is already bringing it back is left alone. Souvenirs can loosen it. */
    const deep = Math.abs(car.beta) - 0.45 - (mods.slideCeiling || 0);
    if (deep > 0 && car.omega * car.beta < 0) {   // velocity sits at yaw+β: ω·β<0 widens the slide
      car.omega -= car.omega * Math.min(0.75, deep * 2.2) * mods.stability * DT * 2.4;
    }
    car.axS += ((Fx / m) - car.axS) * Math.min(1, DT / 0.09);
    car.ayS += ((Fy / m) - car.ayS) * Math.min(1, DT / 0.09);

    // path damper: hands off, the car straightens and stops wandering
    const intent = Math.max(Math.abs(car.sigma), hb);
    if (intent < 0.12 && Math.abs(car.vx) > 4) {
      const ease = (0.12 - intent) / 0.12;
      const omegaTrack = (car.vx / L) * Math.tan(delta);
      car.omega += (omegaTrack - car.omega) * Math.min(1, 1.4 * ease * mods.stability * DT);
      car.vy -= car.vy * Math.min(1, 1.1 * ease * mods.stability * DT);
    }

    car.yaw += car.omega * DT;

    // rumble: loose surfaces talk through the chassis
    if (roughAmt > 0.1 && Math.abs(car.vx) > 8) {
      car.omega += noise1(car.tick, car.x, car.z) * roughAmt * 0.009;
    }

    // held: once the last of the speed is gone, the car stays put
    if (hold && Math.abs(car.vx) < 1.2) { car.vx = 0; car.vy = 0; car.omega = 0; car.axS = 0; car.ayS = 0; }

    // position
    car.x += (car.vx * cosY - car.vy * sinY) * DT;
    car.z += (car.vx * sinY + car.vy * cosY) * DT;

    /* Attitude springs (render): the chassis sits on the plane through the
     * four contact patches, then dives and leans on its springs. The GROUND
     * part is never clamped — clamp it and the body stops following camber,
     * which lifts the inside wheels clean off a banked road. Only the body's
     * own lean is bounded. Signs: +pitch = nose up (so braking, axS < 0,
     * dips it), +roll = right side high (so a right-hand turn, ayS > 0,
     * leans the car onto its outside/left springs). */
    const targetPitch = car.groundPitch + Math.max(-0.055, Math.min(0.055, car.axS * 0.007));
    const targetRoll = car.groundRoll + Math.max(-0.075, Math.min(0.075, car.ayS * 0.014));
    car.pitchV = 0;
    car.pitch += (targetPitch - car.pitch) * 0.14;
    car.roll += (targetRoll - car.roll) * 0.12;
  }

  /* ------------------------------------------------------------------ mud
   * The car wears where it has been: verges and wet gravel coat it, dry
   * tarmac slowly shakes it off. `mud` is how much, `mudWet` whether it is
   * fresh brown spatter or dried-out dust — the renderer tints from both.
   * Pure sim state, so a resumed run's car looks the way it left. */
  if (car.grounded && Math.abs(car.vx) > 3) {
    const spd = Math.min(1, Math.abs(car.vx) / 14);
    let gather = 0;
    if (gC.on === "off") gather = 0.022 * (0.5 + wet);
    else if (gC.on === "shoulder") gather = 0.014 * (0.5 + wet);
    else if ((rq.surf || car.surface) !== "tarmac") gather = 0.006 * (0.3 + 1.6 * wet);
    else if (wet > 0.2) gather = 0.005 * wet;
    if (gather > 0) car.mud = Math.min(1, car.mud + gather * spd * DT);
    else car.mud = Math.max(0, car.mud - 0.0035 * spd * DT);
    car.mudWet += ((gather > 0 && wet > 0.15 ? 1 : 0) - car.mudWet) * Math.min(1, DT / 30);

    /* Per wheel: the arch over the wheel that actually ran the dirt. Each
     * wheel's lateral offset from the centreline is the car's plus its own
     * position swung through the heading error — no extra ground queries,
     * just the geometry the step already knows. */
    const hErr = car.yaw - rq.heading;
    const ceW = Math.cos(hErr), seW = Math.sin(hErr);
    for (let i = 0; i < 4; i++) {
      const w = WHEELS[i];
      const adW = Math.abs(rq.d + w.py * ceW + w.px * seW);
      let gW = 0;
      if (gC.on === "off" || adW > rq.hw + 0.15) gW = 0.03 * (0.5 + wet);
      else if (adW > rq.hw - 0.35) gW = 0.012 * (0.5 + wet);
      if (gW > 0) car.mudW[i] = Math.min(1, car.mudW[i] + gW * spd * DT);
      else car.mudW[i] = Math.max(0, car.mudW[i] - 0.005 * spd * DT);
    }
  }

  // ---------------------------------------------------------- feel metrics
  car.slip = Math.abs(car.beta);
  car.skid = Math.min(1, Math.max(0, car.slip * 2.2 - 0.16) + car.wheelspin * 0.8 + (car.handbrake && Math.abs(car.vx) > 4 ? 0.45 : 0));

  // ------------------------------------------------------------ collisions
  const capsule = K.capsule;
  const cellX = Math.floor(car.x / 8), cellZ = Math.floor(car.z / 8);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const arr = world.colliderHash.get((cellX + dx) + "," + (cellZ + dz));
    if (!arr) continue;
    for (const c of arr) {
      if (Math.abs(c.y - car.y) > 3.2) continue;
      for (const seg of capsule) {
        const px = car.x + fwdX * seg.px, pz = car.z + fwdZ * seg.px;
        const ox = px - c.x, oz = pz - c.z;
        const rr = c.r + seg.r;
        const d2 = ox * ox + oz * oz;
        if (d2 >= rr * rr || d2 < 1e-9) continue;
        const dist = Math.sqrt(d2);
        const nx = ox / dist, nz = oz / dist;
        const pen = rr - dist;
        car.x += nx * pen;
        car.z += nz * pen;
        let wvx = car.vx * cosY - car.vy * sinY;
        let wvz = car.vx * sinY + car.vy * cosY;
        const vn = wvx * nx + wvz * nz;
        if (vn < 0) {
          const impact = -vn;
          wvx -= 1.28 * vn * nx;
          wvz -= 1.28 * vn * nz;
          wvx *= 0.9; wvz *= 0.9;
          car.vx = wvx * cosY + wvz * sinY;
          car.vy = -wvx * sinY + wvz * cosY;
          // nose gets pushed away from the obstacle; a rear hit swings the tail
          const nRight = nx * rgtX + nz * rgtZ;
          car.omega += nRight * impact * (seg.px > 0 ? 0.085 : -0.065);
          // a side-on hit is a trip (the rollover budget reads it below)
          if (Math.abs(nRight) > 0.5) car.sideTrip = Math.max(car.sideTrip, impact * Math.abs(nRight));
          car.damage += impact * 3.0 * mods.damageScale;
          /* the hit leaves a memory: which side took it (the wheel pulls
           * that way once damage builds) and which corner runs soft. The
           * normal points obstacle→car, so obstacle-on-the-right is n
           * pointing LEFT. Head-on, parity picks a front corner. */
          if (impact > 6) {
            const sideHit = Math.abs(nRight) > 0.35 ? -Math.sign(nRight) : 0;
            if (sideHit !== 0) car.pullDir = sideHit;
            const fr = seg.px > 0 ? 0 : 2;
            car.softW = fr + (sideHit > 0 ? 1 : sideHit < 0 ? 0 : (car.tick & 1));
          }
          car.lastImpact = impact;
          /* the thing that was hit, for the tick's hardest hit: the game
           * layer reads its identity (the marshals' book knows when you
           * have met the same tree twice) */
          if (impact > ev.impact) { ev.impact = impact; ev.collider = c; }
          if (impact > 8) car.crashTimer = 1.5;
        }
      }
    }
  }

  // damaged cars track a little crooked (deterministic wobble)
  if (car.damage > 40 && Math.abs(car.vx) > 10 && car.grounded) {
    car.omega += noise1(car.tick * 3, 7, 13) * 0.004 * Math.min(1, (car.damage - 40) / 60);
  }

  if (car.crashTimer > 0) car.crashTimer -= DT;
  /* Stuck means trying and going nowhere — however it fails to go. The old
   * test (standstill + throttle) never saw a car BOUNCING off a rock it
   * could not pass: full throttle, plenty of |vx|, zero progress. Anchor
   * the position instead; escaping the anchor is the only way out. */
  if (input.throttle > 0.5) {
    const md = Math.hypot(car.x - car.stAnchorX, car.z - car.stAnchorZ);
    if (md > 3) { car.stAnchorX = car.x; car.stAnchorZ = car.z; car.stuckT = 0; }
    /* ...but a car above 3 m/s inside a 3 m anchor cannot stay there: it
     * either escapes within the second or it is turning a circle that
     * will. Only the slow car feeds the clock — which is what lets a
     * glare-ice launch (0.38 g, three metres takes 1.3 s) count as the
     * progress it is, while a car bouncing off a rock (vx spikes, speed
     * never sustained) still runs the clock down. */
    else if (car.vx < 3) car.stuckT += DT;
  } else {
    car.stuckT = 0;
    car.stAnchorX = car.x; car.stAnchorZ = car.z;
  }

  rolloverStep(car, ev, mods, gC.on);
  return ev;
}

/* ---------------------------------------------------------------- rollover
 * The Kestrel does not roll from cornering — its static stability factor
 * (half-track over CG height) is 1.6 g and the tyres give out long before
 * that. Rally cars roll from TRIPPING: sliding sideways into ground that
 * grabs — the soft field past the recovery corridor, a trunk or kerb taken
 * side-on, a sideways landing. It is the sideways kinetic energy that gets
 * turned into rotation, so the budget is that energy against the work of
 * lifting the CG over the outer wheels (E_ROLL): a slide through the bog
 * spends it over a quarter-second, an impact spends it at once. Absurd
 * grip builds get one more way over — sustained lateral load past the
 * factor lifts the inside wheels regardless. `rollResist` (souvenirs)
 * scales the whole budget; `landWheels` biases how the car settles.
 *
 * A rolled car tumbles for ROLL_T per full turn (rollSpin is the render's
 * angle), loses most of its speed, takes a real hit, and settles on its
 * wheels or on its roof — decided at the trip, deterministically. On its
 * roof it is held where it lies until the run layer rescues it or ends
 * the journey. */
const ROLL_T = 1.4;
const E_ROLL = KESTREL.mass * G * (Math.hypot(KESTREL.track / 2, KESTREL.h) - KESTREL.h);
function rolloverStep(car, ev, mods, zone) {
  const rr = mods.rollResist || 1;
  if (car.rollT > 0) {
    car.rollT -= DT;
    const dur = car.rollDur || ROLL_T;
    const u = 1 - Math.max(0, car.rollT) / dur;
    /* the tumble WHIPS over the first edge with the slide's energy and dies
     * out through the roll. The old smoothstep started from zero rate, so
     * the car tripped, hesitated, then spun (owner: "rolls are still
     * awkward") — a trip is violent at the trip, not a beat later. */
    const su = u * (2 - u);
    const prevHalf = Math.floor(Math.abs(car.rollSpin || 0) / Math.PI + 1e-4);
    car.rollSpin = car.rollDir * (car.rollAng || Math.PI * 2) * su;
    /* each half-turn puts a corner or a face into the ground: a real roll
     * is a series of impacts, not a rotisserie (owner, pass three: "rolls
     * are still awkward"). The pulses reach the game layer, which already
     * knows what an impact deserves (thump, shake, dust, rumble) — but
     * never the damage ledger: the roll charged its price at the trip. */
    if (Math.floor(Math.abs(car.rollSpin) / Math.PI + 1e-4) > prevHalf) {
      ev.impact = Math.max(ev.impact, 3.2 + (car.rollV || 0) * 0.3);
      car.suspHit = Math.max(car.suspHit || 0, 2.2);
    }
    // and the shell pivots a little as it goes over: nothing tumbles clean
    car.yaw += car.rollDir * 0.45 * (1 - u) * DT;
    /* and the car keeps GOING: the sideways energy that tripped it carries
     * it across the ground while it goes over, dying out through the roll.
     * The old step zeroed the slide at the trip, so the car stopped dead at
     * an invisible line and spun in place (owner's words, near enough). */
    const sp = (car.rollV || 0) * (1 - u);
    car.x += car.rollDx * sp * DT; car.z += car.rollDz * sp * DT;
    car.vx *= 1 - 2.4 * DT; car.vy = 0; car.omega = 0;
    if (car.rollT <= 0) {
      car.rollT = 0;
      car.onRoof = !!car.rollRoof;
      car.rollSpin = car.onRoof ? car.rollDir * Math.PI : 0;
      ev.settled = car.onRoof ? "roof" : "wheels";
      // the last face lands with a slam, the roof hardest of all
      ev.impact = Math.max(ev.impact, car.onRoof ? 7 : 5);
      car.suspHit = Math.max(car.suspHit || 0, 3);
      /* and the settle is never free (owner: "a roll should cause some
       * damage even if it ends up landing"): the trip charged ~20, the
       * landing bends a little more — wheels lightly, the roof harder */
      car.damage += Math.max(5, (car.onRoof ? 22 : 14) * mods.damageScale);
    }
    return;
  }
  if (car.onRoof) { car.rollSpin = car.rollDir * Math.PI; return; }
  car.rollSpin = 0;
  car.rollE *= Math.exp(-DT / 1.0);
  if (!car.grounded) return;
  const vyAbs = Math.abs(car.vy);
  const keFrac = (0.5 * KESTREL.mass * vyAbs * vyAbs) / E_ROLL;
  /* tuned (harness `ends`): the deep field — twelve metres and more past
   * the shoulder, where the ground bogs — converts a slide's sideways
   * energy within a tenth of a second (soft ground kills sideways speed at
   * ~12 m/s², so a slower conversion never catches it): past ~16 km/h of
   * sideways speed the car goes over, 14 km/h never does; the road, the
   * shoulder and the recovery corridor never trip at all. And only ground
   * that GRABS trips: grass, scrub and rock in full, sand and peat in part,
   * a snowfield or water not at all — a car sailing across deep snow slides
   * (the snowbank it finds is a collider, and that hit trips it). */
  let inst = 0, cont = 0;
  const grab = Math.max(0, Math.min(1, ((car.offGrip || 0) - 0.3) / 0.28));
  /* THE ROLL IS A DEEP-FIELD MECHANIC (owner: rolls "happen barely off the
   * road when I hit things — it should be a specific mechanic for when the
   * car goes too far off, preserving the current damage function"). One
   * gate rules every trip source: zero on the road, the verge and the
   * corridor, opening over the deep field past the trip line. Hits and
   * hard landings near the road stay what they always were — damage.
   * The trip line sits well out from the road on a straight car and moves
   * IN as the damage builds (owner: "more damage should lead to a shorter
   * roll point"): deepOff 0.6 (~15.6 m past the edge) fresh, ~0.42
   * (~12.7 m) for a wreck at damage 120+. */
  const tripLine = 0.6 - 0.18 * Math.min(1, car.damage / 120);
  const deepGate = zone === "off" ? Math.max(0, Math.min(1, (car.deepOff - tripLine) / 0.15)) : 0;
  if (deepGate > 0 && vyAbs > 2) cont = 0.45 * car.deepOff * grab * deepGate;
  if (ev.landed > 4 && vyAbs > 3) inst += 0.22 * Math.min(1, ev.landed / 10) * deepGate;
  if (car.sideTrip > 2 && vyAbs > 2.5) inst += 0.4 * Math.min(1, car.sideTrip / 8) * deepGate;
  car.rollE += (inst * keFrac + cont * keFrac * (DT / 0.1)) / rr;
  /* the cornering ceiling sits ABOVE what stock tyres can pull (dry tarmac
   * is 1.48 g; the factor is 1.62): only a grip-stacked build ever gets
   * here, and it gets here by cornering at two g for a second or more —
   * and on the road even that now only SIMMERS the budget (quarter rate):
   * the full ceiling waits for the deep field like every other trip */
  const latG = Math.abs(car.ayS) / G;
  if (latG > 1.75 * rr) car.rollE += (latG - 1.75 * rr) * (DT / 0.3) * (0.25 + 0.75 * deepGate);
  if (car.rollE >= 1) {
    car.rollE = 0;
    car.rollDir = car.vy !== 0 ? Math.sign(car.vy) : car.ayS !== 0 ? Math.sign(car.ayS) : 1;
    // the slide's sideways speed becomes the tumble's travel (world frame:
    // +vy is the car's left, which is (-sin yaw, cos yaw))
    car.rollV = Math.min(9, vyAbs * 0.85);
    car.rollDx = -Math.sin(car.yaw) * car.rollDir; car.rollDz = Math.cos(car.yaw) * car.rollDir;
    /* the landing is decided NOW, so the tumble ends exactly where the car
     * does: deciding roof-or-wheels at the settle meant a full turn and
     * then a half-turn SNAP onto the roof. A little under half end on the
     * roof (with one push in hand a journey expects three rolls, not two,
     * before the road gives up on it); a violent trip goes over TWICE; a
     * roof landing stops on the odd half-turn, so it slams, never snaps. */
    const pRoof = Math.max(0, Math.min(1, 0.45 - (mods.landWheels || 0)));
    car.rollRoof = (noise1(car.tick, car.x, car.z) + 0.5) < pRoof;
    const turns = car.rollV > 6.5 ? 2 : 1;
    car.rollAng = (car.rollRoof ? turns - 0.5 : turns) * Math.PI * 2;
    car.rollDur = ROLL_T * (car.rollAng / (Math.PI * 2));
    car.rollT = car.rollDur;
    car.vx *= 0.35; car.vy = 0; car.omega = 0;
    // a roll is EXPENSIVE now (owner): ~30 at the trip + the settle slam
    // (14 wheels / 22 roof) — two rolls and a journey is in real trouble
    car.damage += Math.max(9, 30 * mods.damageScale);
    car.crashTimer = 1.5;
    car.rolls++;
    ev.rolled = true;
    ev.impact = Math.max(ev.impact, 9);
  }
}

/* ------------------------------------------------------------- bot driver
 * Pursuit steering + speed-profile pedals. Drives the endless road for the
 * harness, tunes the handling against measurable laps, and powers ?bot=1. */
export function botInput(car, world, skill) {
  const q = world.roadQuery(car.x, car.z, car.s);
  const sk = skill == null ? 0.92 : skill;
  if (!q) {
    const t = world.sampleNear(car.s + 12);
    if (!t) return { dir: 0, throttle: 0.3, brake: 0, handbrake: false };
    const dx = t.x - car.x, dz = t.z - car.z;
    const lz = -Math.sin(car.yaw) * dx + Math.cos(car.yaw) * dz;
    const lx = Math.cos(car.yaw) * dx + Math.sin(car.yaw) * dz;
    if (lx < 0) return { dir: lz > 0 ? 1 : -1, throttle: 0.4, brake: 0, handbrake: false };
    return { dir: lz > 1 ? 1 : lz < -1 ? -1 : 0, throttle: 0.55, brake: 0, handbrake: false };
  }
  const v = Math.max(1, car.vx);

  if (car.botRev == null) car.botRev = 0;
  if (car.botRev > 0) {
    car.botRev -= DT;
    return { dir: car.d > 0 ? -1 : 1, throttle: 0, brake: 1, handbrake: false };
  }
  /* 2.6 s, not 1.2: stuckT counts lack of PROGRESS now (see step), and a
   * slow off-road crawl at 2 m/s legitimately takes ~1.5 s to escape the
   * 3 m anchor — a hair-trigger here made the bot lunge-reverse-lunge
   * across every soft field instead of just driving out of it. */
  if (car.stuckT > 2.6) { car.botRev = 1.4; car.stuckT = 0; }

  /* a slide is a thing that happens at speed: at walking pace a big slip
   * angle is just a car being pushed sideways down a slope, and treating
   * that as a drift (throttle off, brake on) is how the soak's bot sat on
   * a snowfield for fifteen minutes */
  const sliding = v > 4 && (Math.abs(car.beta) > 0.34 || Math.abs(car.omega) > 1.6);
  const grip = surfaceParams(q.surf || "gravel", world.wetness || 0);
  const L = KESTREL.a + KESTREL.b;

  let steerDes, psiAbs = 0;
  if (sliding) {
    steerDes = Math.sign(car.vy) * Math.min(0.5, Math.abs(car.beta) * 1.1);
  } else {
    const ahead = world.sampleNear(q.s + Math.max(6, v * 0.45));
    const ff = Math.atan(L * (ahead ? ahead.curv : q.curv) * 1.05);
    const near = world.sampleNear(q.s + 4);
    let psi = (near ? near.heading : q.heading) - car.yaw;
    while (psi > Math.PI) psi -= Math.PI * 2;
    while (psi < -Math.PI) psi += Math.PI * 2;
    psiAbs = Math.abs(psi);
    const cross = Math.atan((-q.d * 1.1) / Math.max(4, v));
    // damp against the yaw rate the road wants: no hunting around the limit
    const omegaWant = v * (ahead ? ahead.curv : q.curv);
    steerDes = ff + Math.max(-0.5, Math.min(0.5, psi)) * 0.7 + cross - 0.28 * (car.omega - omegaWant);
    const kLim = (grip.grip * G * 0.95) / Math.max(30, v * v);
    const dLim = Math.atan(L * kLim) + 0.1;
    steerDes = Math.max(-dLim, Math.min(dLim, steerDes));
  }
  // the bot steers like a pad: it asks for an angle, not a key rate. The
  // physics maps a stick to sigma·lock, so hand it steerDes/lock directly
  // (steer = sigma·(lock + reach); the reach only exists in slides).
  let dir = 0;
  const err = steerDes - car.steer;
  if (err > 0.006) dir = 1;
  else if (err < -0.006) dir = -1;
  const lockNow = steerLockAt(v, grip.grip, grip.bite);
  const want = Math.max(-1, Math.min(1, steerDes / Math.max(0.02, lockNow)));
  // a human wrist, not a servo: ease toward the wanted angle
  if (car.botSig == null) car.botSig = 0;
  car.botSig += (want - car.botSig) * (sliding ? 0.25 : 0.1);
  const steerAnalog = car.botSig;

  const decel = Math.max(1.6, grip.grip * G * 0.6 + q.grade * G * 0.8);
  let vTarget = 99;
  for (let d = 0; d < 210; d += 10) {
    const vAllowed = world.profileAt(q.s + d) * sk;
    const vHere = Math.sqrt(vAllowed * vAllowed + 2 * decel * d);
    if (vHere < vTarget) vTarget = vHere;
  }
  let throttle = 0, brake = 0;
  if (v < vTarget - 0.4) throttle = 1;
  else if (v > vTarget + 0.6) brake = Math.min(1, (v - vTarget) * 0.3);
  if (Math.abs(car.steer) > steerLockAt(v, grip.grip, grip.bite) * 0.65) brake = Math.min(brake, 0.5);
  if (sliding) {
    throttle = 0;
    brake = Math.abs(car.vx) < 6 ? 1 : 0;
  } else if (car.slip > 0.3) throttle = Math.min(throttle, 0.5);
  // feather the throttle when the tyres are already working sideways
  const latUse = Math.min(1, Math.abs(car.ayS) / (grip.grip * G));
  if (latUse > 0.7) throttle = Math.min(throttle, Math.max(0.15, 1 - (latUse - 0.7) * 2.6));
  /* straighten before you floor it (2026-08-31): rejoining the road at
   * fifty degrees under full throttle on snow shot the bot straight across
   * it into the far field, where it stayed. Slow and crooked means steer
   * first; the throttle comes back as the nose comes round. */
  if (psiAbs > 0.55 && v < 12) throttle = Math.min(throttle, 0.3);

  if (Math.abs(car.d) > q.hw + 1.6 && Math.abs(car.vx) < 14 && !sliding) {
    const t2 = world.sampleNear(q.s + 14);
    if (t2) {
      const dx2 = t2.x - car.x, dz2 = t2.z - car.z;
      const lz2 = -Math.sin(car.yaw) * dx2 + Math.cos(car.yaw) * dz2;
      const lx2 = Math.cos(car.yaw) * dx2 + Math.sin(car.yaw) * dz2;
      if (lx2 < 0) return { dir: lz2 > 0 ? 1 : -1, throttle: 0.5, brake: 0, handbrake: false };
      dir = lz2 > 0.5 ? 1 : lz2 < -0.5 ? -1 : 0;
      // pointing well away from the road: turn first, then drive
      const aligned = Math.abs(Math.atan2(lz2, lx2)) < 0.7;
      return { dir, throttle: aligned ? 0.6 : 0.35, brake: 0, handbrake: false };
    }
  }

  return { dir, steerAnalog, throttle, brake, handbrake: false };
}
