/* Gravl — vehicle dynamics.
 *
 * A single-track (bicycle) model with longitudinal weight transfer, a
 * Pacejka-style tyre curve per surface, a friction ellipse coupling
 * longitudinal and lateral grip, AWD drivetrain with an automatic box,
 * handbrake rear-grip cut, airborne flight and landing scrub.
 *
 * Runs at a fixed 120 Hz. Absolutely deterministic: identical inputs on the
 * identical stage produce identical runs. No Math.random(), no wall clock.
 * DOM-free so the node test harness can drive it.
 */

import { hash32 } from "./daily.js";
import { G } from "./track.js";

export const DT = 1 / 120;

/* Downward acceleration demand, in g, at which the car leaves the road. A point
 * mass lifts at exactly 1 g; real suspension droops to chase the surface, so
 * the car hangs on past that. Tuned by sweep: demand scales with v², and at 1 g
 * the car goes light over every rolling crest at 150 km/h - constant grip
 * dropouts, and the bot could no longer bring a third of the candidate stages
 * home. At 2 g the jumps and sharp crests still launch it cleanly. */
const LIFTOFF = 2.0;

/* How hard the car is helped to follow the wheel. 0 is the raw physics model,
 * which needs sim-grade correction to keep on the road; 1 is firmly arcade.
 * See the arcade stability block in step(). */
const STABILITY = 0.8;
export const TICK_RATE = 120;

export const CAR = {
  mass: 1230,
  izz: 1580,
  a: 1.21,           // CG -> front axle
  b: 1.39,           // CG -> rear axle
  h: 0.5,            // CG height (weight transfer)
  wheelR: 0.31,
  halfTrack: 0.78,   // wheel centre out from the centreline (contact patches)
  power: 206000,     // W at the crank
  drivetrainEff: 0.84,
  frontDrive: 0.42,  // AWD torque split
  cda: 0.72,         // drag area * Cd
  rho: 1.22,
  rr: 0.014,         // rolling resistance
  brakeForce: 15200, // total N at full pedal
  brakeBias: 0.62,
  steerMax0: 0.62,   // rad at standstill
  steerFade: 900,    // higher = keeps more steering at speed
  /* Top gear is geared to the rev limiter at VCAP (57 m/s, 205 km/h) rather
   * than the 224 km/h it used to run out to. The speed profile assumes VCAP,
   * so anything above it was speed the player could carry into a corner that
   * had been sized without it - which is one of the reasons a "flat" corner
   * was never flat. Rally stages do not run past 200 km/h anyway. */
  gears: [3.9, 2.65, 1.95, 1.52, 1.3, 1.12],
  finalDrive: 3.75,
  shiftUp: 6900,
  shiftDown: 3400,
  idle: 1100,
  redline: 7400,
  colliderR: 0.95,
};

/* Useful steering authority around the neutral point: grip-limited curvature
 * for the speed plus a slip allowance. Keys command an angle *relative to the
 * front axle's zero-slip angle*, so full countersteer is always reachable in
 * a slide while straight-line steering stays surgical at speed. */
export function steerMaxAt(v) {
  const gripCurv = (9.2 * (CAR.a + CAR.b) * 1.15) / Math.max(24, v * v);
  return Math.min(CAR.steerMax0, gripCurv + 0.105);
}

/* Front-axle neutral angle: where the fronts would roll slip-free. Fades out
 * at low speed where the estimate gets noisy. */
export function neutralSteer(car) {
  const vxa = Math.max(2, Math.abs(car.vx));
  const ramp = Math.min(1, Math.max(0, (Math.abs(car.vx) - 2.5) / 6));
  const n = Math.atan((car.vyLat + CAR.a * car.omega) / vxa) * ramp;
  return Math.max(-0.5, Math.min(0.5, n));
}

/* Digital steering: keys press a *rate*, not an angle. Attack slows as the
 * angle builds, centre return is quick, and crossing to the opposite lock is
 * quickest of all so countersteer feels instant. sigma is -1..1. */
export function updateSteer(st, dir, v, dt) {
  const speedT = Math.min(1, v / 42);
  // coerce: a stray undefined here poisons sigma with NaN, and in a
  // deterministic sim that quietly corrupts every value downstream forever
  dir = dir > 0 ? 1 : dir < 0 ? -1 : 0;
  if (dir !== 0) {
    const opposite = st.sigma * dir < -0.02;
    const base = opposite ? 5.2 : 3.4 - speedT * 1.5;
    const taper = opposite ? 1 : 1 - Math.abs(st.sigma) * 0.45;
    st.sigma += dir * base * taper * dt;
  } else {
    const ret = 4.6 - speedT * 1.4;
    if (Math.abs(st.sigma) <= ret * dt) st.sigma = 0;
    else st.sigma -= Math.sign(st.sigma) * ret * dt;
  }
  st.sigma = Math.max(-1, Math.min(1, st.sigma));
  return st.sigma;
}

export function makeCar() {
  return {
    x: 0, y: 0, z: 0,
    yaw: 0,
    vx: 0,        // body-frame forward speed
    vyLat: 0,     // body-frame lateral speed
    omega: 0,     // yaw rate
    vyUp: 0,      // world vertical speed while airborne
    airborne: false,
    airTime: 0,
    groundStick: 0,   // s of takeoff hysteresis after a landing
    /* Rendered body attitude. Nose-up and right-side-up are positive, which
     * is what the in-air pitch authority and the load-transfer terms below
     * have always assumed - it was only the renderer that read them upside
     * down. */
    pitch: 0, roll: 0,
    pitchV: 0, rollV: 0,
    groundPitch: 0, groundRoll: 0,
    /* Render-only chassis: the ground height under each of the four wheels
     * and the body height riding on them. Sampled only when car.visual is
     * set, so the stage audition does not pay for four extra ground queries
     * a tick on a drive nobody ever sees. */
    visual: false,
    contact: [0, 0, 0, 0],
    contactOK: false,
    bodyY: 0,
    pitchLoad: 0, rollLoad: 0,   // dive/squat/lean, springed on top of the ground
    wasAir: false,
    airBlend: 0, airPitch: 0, airRoll: 0,   // attitude carried out of a landing
    sigma: 0, steer: 0,
    throttle: 0, brake: 0, handbrake: false, hbBlend: 0,
    gear: 1, rpm: CAR.idle,
    wheelspin: 0, slip: 0, skid: 0,
    surface: "road", zone: "road",
    axSmooth: 0,
    alphaFs: 0, alphaRs: 0,      // slip angles after tyre relaxation
    damage: 0, lastImpact: 0, crashTimer: 0,
    tick: 0,
    s: 0, d: 0, roadGrade: 0,
    offRoadT: 0,
    stuckT: 0,
    dead: false,
  };
}

export function resetCar(car, stage) {
  const visual = car.visual;
  Object.assign(car, makeCar());
  car.visual = visual;
  const i = Math.round(stage.startS / 2);
  car.x = stage.geo.x[i];
  car.z = stage.geo.z[i];
  car.y = stage.geo.y[i];
  car.yaw = stage.geo.heading[i];
  car.bodyY = car.y;
  car.s = stage.startS;
}

/* Deterministic "noise" for surface rumble: pure function of tick+position */
function rumble(car) {
  const h = hash32((car.tick * 2654435761) ^ (Math.round(car.x * 7) * 40503) ^ Math.round(car.z * 7));
  return h / 4294967296 - 0.5;
}

function engineForce(car, surfaceGripLong) {
  // rpm follows wheel speed through the box
  const ratio = CAR.gears[car.gear - 1] * CAR.finalDrive;
  const wheelRpm = (Math.max(0, car.vx) / CAR.wheelR) * (60 / (2 * Math.PI));
  let rpm = Math.max(CAR.idle, wheelRpm * ratio);

  // automatic shifts
  if (rpm > CAR.shiftUp && car.gear < CAR.gears.length) { car.gear++; }
  else if (rpm < CAR.shiftDown && car.gear > 1) { car.gear--; }
  const r2 = CAR.gears[car.gear - 1] * CAR.finalDrive;
  rpm = Math.max(CAR.idle, wheelRpm * r2);

  // torque curve: flat-ish with peak mid range
  const t = Math.min(1, rpm / CAR.redline);
  const torque = 430 * (0.55 + 0.75 * Math.sin(Math.PI * Math.min(1, t * 1.12)) ) * (t > 0.97 ? 0.4 : 1);
  let force = (torque * r2 * CAR.drivetrainEff) / CAR.wheelR;
  // don't let 1st gear produce absurd force
  force = Math.min(force, 11800);
  car.rpm = car.rpm + (rpm + (car.wheelspin > 0.2 ? 1300 : 0) - car.rpm) * 0.25;
  car.rpm = Math.min(car.rpm, CAR.redline + 150);
  return force * car.throttle * (car.damage > 60 ? 0.92 : 1) * (car.damage > 120 ? 0.9 : 1);
}

/* Tyre lateral force: mu*Fz * sin(C * atan(B * slip)). Returns per-axle. */
function tyreLat(alpha, fz, mu, B, C) {
  return -mu * fz * Math.sin(C * Math.atan(B * alpha));
}

/* One 120 Hz physics step.
 * input: {dir: -1|0|1, throttle: 0..1, brake: 0..1, handbrake: bool}
 * Returns event flags for audio/HUD. */
export function step(car, stage, input) {
  car.tick++;
  const ev = { landed: 0, impact: 0, tookOff: false };

  // ---- controls
  updateSteer(car, input.dir, Math.abs(car.vx), DT);
  const steerLim = steerMaxAt(Math.abs(car.vx)) * (car.damage > 90 ? 0.86 : 1);
  const neutral = car.airborne ? 0 : neutralSteer(car);
  car.steer = Math.max(-CAR.steerMax0, Math.min(CAR.steerMax0, neutral + car.sigma * steerLim));
  const thrTarget = input.throttle, brkTarget = input.brake;
  car.throttle += Math.max(-8 * DT, Math.min(8 * DT, thrTarget - car.throttle));
  car.brake += Math.max(-10 * DT, Math.min(10 * DT, brkTarget - car.brake));
  car.handbrake = !!input.handbrake;
  /* Blend the lever in and out over ~120 ms. Everything the handbrake touches
   * used to switch on the frame the key went down - rear grip, drive, and the
   * whole stability assist at once - so the car became a different vehicle
   * between two consecutive frames and a keyboard could not catch what came
   * next. Same authority, reached over a tenth of a second. */
  car.hbBlend += ((car.handbrake ? 1 : 0) - car.hbBlend) * Math.min(1, 9 * DT);

  // ---- ground sampling (s-hint keeps us on the right leg of the road)
  let gC = stage.groundHeight(car.x, car.z, car.s);
  if (!gC) {
    // beyond the mapped corridor: coast on remembered ground, bleed speed hard
    car.oobT = (car.oobT || 0) + DT;
    if (car.oobT > 6) { car.dead = true; return ev; }
    gC = car.lastG || { y: car.y, on: "off", rq: { s: car.s, d: car.d, y: car.y, hw: 4, camberT: 0, grade: 0, curv: 0, flag: 0, heading: car.yaw, idx: 0 } };
    gC = { y: gC.y, on: "off", rq: gC.rq };
    car.vx *= 1 - 0.8 * DT;
  } else {
    car.oobT = 0;
    car.lastG = gC;
  }
  const cosY = Math.cos(car.yaw), sinY = Math.sin(car.yaw);
  /* Axle-to-axle ground sampling. The old one-sided probe (centre -> 1.3 m
   * ahead) measured the road ahead, not the chord the wheels actually sit
   * on: on a crest the body pitched nose-down while parked on the apex and
   * buried its nose in the far side; dips did the reverse. Same story for
   * roll with its single side probe. The front probe also stretches with
   * speed, so a short elevation kink stops reading as a cliff at 200 km/h
   * (this slope feeds the liftoff test below). */
  const lookF = Math.max(CAR.a, Math.abs(car.vx) * 0.06);
  const gF = stage.groundHeight(car.x + cosY * lookF, car.z + sinY * lookF, car.s);
  const gR = stage.groundHeight(car.x - cosY * CAR.b, car.z - sinY * CAR.b, car.s);
  const gS = stage.groundHeight(car.x - sinY * 0.8, car.z + cosY * 0.8, car.s);
  const gS2 = stage.groundHeight(car.x + sinY * 0.8, car.z - cosY * 0.8, car.s);
  const groundY = gC.y;
  const yF = gF ? gF.y : gC.y, yR = gR ? gR.y : gC.y;
  const fwdSlope = (yF - yR) / (lookF + CAR.b);
  const latSlope = gS && gS2 ? (gS.y - gS2.y) / 1.6 : gS ? (gS.y - gC.y) / 0.8 : 0;
  car.groundPitch = Math.atan(fwdSlope);
  car.groundRoll = Math.atan(latSlope);
  car.zone = gC.on;
  car.s = gC.rq.s;
  car.d = gC.rq.d;
  car.roadGrade = gC.rq.grade;

  /* ---- contact patches (render only)
   * The two probes above are physics probes: the front one stretches with
   * speed so that a jump is seen coming, and roll is read from a pair of
   * points either side of the CG. Right for gravity and for the liftoff
   * test, wrong for drawing a car - at 180 km/h down a hill they describe a
   * plane the wheels are nowhere near, which is why the tyres floated over
   * every descent. These four sample the ground exactly where the wheels
   * are, in the order the renderer expects: front +d, front -d, rear +d,
   * rear -d. */
  if (car.visual) {
    const c = car.contact;
    for (let i = 0; i < 4; i++) {
      const wx = i < 2 ? CAR.a : -CAR.b;
      const wz = i & 1 ? -CAR.halfTrack : CAR.halfTrack;
      const g = stage.groundHeight(car.x + cosY * wx - sinY * wz, car.z + sinY * wx + cosY * wz, car.s);
      c[i] = g ? g.y : gC.y;
    }
    car.contactOK = true;
  }

  // ---- surface parameters
  let mu, B, C, muLong, extraDrag = 0, rumbleAmt = 0;
  const grip = stage.grip, off = stage.offroad;
  if (gC.on === "road") {
    mu = grip.lat; muLong = grip.long; B = grip.B; C = grip.C;
    rumbleAmt = stage.surfKey === "tarmac" || stage.surfKey === "tarmacWet" ? 0.02 : 0.12;
    car.offRoadT = 0;
  } else if (gC.on === "shoulder") {
    mu = grip.lat * 0.8; muLong = grip.long * 0.8; B = grip.B * 0.8; C = grip.C + 0.1;
    extraDrag = 1.2; rumbleAmt = 0.3;
  } else if (gC.on === "bank") {
    mu = off.lat; muLong = off.long; B = 5; C = 1.9;
    extraDrag = off.drag * 2.2; rumbleAmt = 0.5;
  } else if (gC.on === "void") {
    mu = 0.1; muLong = 0.1; B = 4; C = 2; extraDrag = 0;
  } else { // ditch / off
    mu = off.lat; muLong = off.long; B = 6; C = 1.8;
    extraDrag = off.drag * (gC.on === "ditch" ? 1.6 : 1);
    rumbleAmt = 0.55;
    car.offRoadT += DT;
  }

  const m = CAR.mass;

  // ---- airborne?
  if (!car.airborne) {
    /* The road can push up but it cannot pull down, so the car leaves it as
     * soon as following the surface would take more than 1 g of downward
     * acceleration. targetVy is the vertical velocity the ground ahead asks
     * for; against the velocity we already carry that is the acceleration.
     *
     * The old test compared the slope ahead with the slope just travelled and
     * fired when the road bent UPWARD - inverted, so it never triggered on a
     * crest and instead went off in compressions, launching the car downward
     * at a speed it never had. Jumps could not get the car airborne at all. */
    const targetVy = fwdSlope * car.vx;
    const needed = (targetVy - car.vyUp) / DT;
    car.groundStick = Math.max(0, car.groundStick - DT);
    // fresh off a landing the suspension is loaded: it takes real commitment
    // to leave the ground again, which is what stops washboard micro-hops
    const liftAt = G * LIFTOFF * (car.groundStick > 0 ? 2.5 : 1);
    if (needed < -liftAt && car.vx > 8) {
      car.airborne = true;
      car.airTime = 0;
      ev.tookOff = true;   // vyUp is left as-is: it is the speed we really had
    } else {
      /* Rest on the chord between the axles, never below the ground under
       * the car's middle: a crest shorter than the wheelbase carries the car
       * on its apex. This is what keeps the body from clipping into hills. */
      car.y = Math.max(groundY, (yF + yR) / 2);
      car.vyUp = targetVy;
    }
  }

  if (car.airborne) {
    car.airTime += DT;
    car.vyUp -= G * DT;
    car.y += car.vyUp * DT;
    // small pitch authority in the air (brake = nose down, throttle = nose up)
    car.pitchV += (car.throttle * 1.6 - car.brake * 2.2) * DT;
    /* and a slow trim towards the flight path, so a long jump comes down
     * pointing roughly where it is going rather than pinned at whatever
     * angle the throttle left it at. */
    car.pitch += (Math.atan2(car.vyUp, Math.max(6, Math.abs(car.vx))) - car.pitch) * 1.1 * DT;
    // world-frame ballistic travel (wvx also feeds the landing misalignment
    // check — its lateral term used to carry a flipped sign)
    const wvx = car.vx * cosY - car.vyLat * sinY;
    const wvz = car.vx * sinY + car.vyLat * cosY;
    car.x += wvx * DT;
    car.z += wvz * DT;
    car.omega *= 0.995;
    car.yaw += car.omega * DT;

    if (car.y <= groundY) {
      // ---- landing
      car.y = groundY;
      car.airborne = false;
      /* Closing speed against the ground, bounded by what the flight could
       * actually have built up. fwdSlope is a finite difference over a
       * piecewise-linear elevation profile, so it steps between samples; a
       * kink seeds vyUp with that step and the car "lands" at 14 m/s after
       * 50 ms of air, collecting phantom damage and a big speed scrub on a
       * road it never left. Free fall plus a little slack for landing on a
       * rising slope is the physical ceiling. */
      const closing = Math.max(0, -(car.vyUp - fwdSlope * car.vx));
      const impact = Math.min(closing, G * car.airTime + 1.5);
      // orientation mismatch scrubs speed
      const velYaw = Math.atan2(wvz, wvx);
      let mis = Math.abs(((velYaw - car.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      mis = Math.min(mis, 1.2);
      const scrub = Math.min(0.28, impact * 0.014 + mis * 0.1);
      car.vx *= 1 - scrub;
      car.vyLat *= 0.82;
      /* Land *following the ground*, not at vyUp = 0. Zeroing it meant the
       * very next tick read any downhill under the landing as a >2 g demand
       * and relaunched the car — every descending landing turned into a
       * patter of micro-flights, each one scrubbing speed and kicking the
       * nose. That was the bounce. */
      car.vyUp = fwdSlope * car.vx;
      car.groundStick = 0.15;
      ev.landed = impact;
      car.pitchV -= impact * 0.05;
      if (impact > 9.5) { car.damage += (impact - 9.5) * 6; ev.impact = impact; }
    }
    car.updateVisual = true;
  }

  if (!car.airborne) {
    // ---- slip angles
    const vxA = Math.max(0.5, Math.abs(car.vx));
    const lowSpeed = Math.min(1, vxA / 3.5);
    const alphaFraw = Math.atan((car.vyLat + CAR.a * car.omega) / vxA) - car.steer * Math.sign(car.vx >= 0 ? 1 : -1);
    const alphaRraw = Math.atan((car.vyLat - CAR.b * car.omega) / vxA);

    /* Tyre relaxation: a tyre builds cornering force over a length of travel,
     * it does not appear the instant the wheel moves. Without this a stab at
     * the wheel spiked the yaw rate to over twice its steady value, which is
     * what made quick corners feel like they snapped away on turn-in. Steady
     * state is untouched, so the grip ceiling is exactly where it was. */
    const relax = Math.min(1, (Math.abs(car.vx) * DT) / 0.55);
    car.alphaFs += (alphaFraw - car.alphaFs) * relax;
    car.alphaRs += (alphaRraw - car.alphaRs) * relax;
    const alphaF = car.alphaFs, alphaR = car.alphaRs;

    // ---- loads with longitudinal transfer
    const L = CAR.a + CAR.b;
    let fzF = (m * G * CAR.b) / L - (m * car.axSmooth * CAR.h) / L;
    let fzR = (m * G * CAR.a) / L + (m * car.axSmooth * CAR.h) / L;
    fzF = Math.max(m * 1.2, fzF); fzR = Math.max(m * 1.2, fzR);

    // ---- longitudinal forces
    const eng = engineForce(car, muLong);
    /* Torque split shifts forward as the rear takes on lateral load, the way a
     * modern rally centre diff does. Taking drive off the loaded axle and
     * putting it on the one with capacity to spare pulls the car through the
     * corner instead of spitting it round. */
    const rearLoad = Math.min(1, Math.abs(alphaR) / 0.16);
    const splitF = CAR.frontDrive + 0.20 * rearLoad;
    let driveF = eng * splitF;
    let driveR = eng * (1 - splitF);
    let brakeF = car.brake * CAR.brakeForce * CAR.brakeBias;
    let brakeR = car.brake * CAR.brakeForce * (1 - CAR.brakeBias);
    /* Handbrake: lock the rear, take the drive off it, and let go of most of
     * its cornering force so the car pivots. Enough to break the rear away
     * and rotate the car, but not the total grip wipeout it used to be - that
     * pitched it round faster than anyone could catch, so the handbrake was a
     * trap everywhere except a true hairpin. */
    const hb = car.hbBlend;
    let rearMuLat = mu * (1 - 0.62 * hb), rearC = C + 0.5 * hb;
    if (hb > 0.001) {
      brakeR += 8500 * hb;
      driveR *= 1 - hb;
    }
    // engine braking
    if (car.throttle < 0.05 && Math.abs(car.vx) > 2) {
      brakeF += 260; brakeR += 340;
    }
    const dirV = car.vx >= 0 ? 1 : -1;
    // reverse: brake key acts as reverse gear at near-standstill
    let reverseF = 0;
    if (car.brake > 0.3 && car.vx < 0.6 && car.vx > -8) {
      reverseF = -3600 * car.brake;
      brakeF = 0; brakeR = 0;
    }

    // traction limits + wheelspin
    const tracF = muLong * fzF, tracR = muLong * fzR;
    let spin = 0;
    if (driveF > tracF) { spin += (driveF - tracF) / tracF; driveF = tracF * 0.94; }
    if (driveR > tracR) { spin += (driveR - tracR) / tracR; driveR = tracR * 0.96; }

    /* Traction budget. An axle already working hard sideways cannot also lay
     * down full drive - the brake side has modulated for this all along, the
     * drive side never did. Without it, going flat mid-corner drove the rear
     * straight to the friction-ellipse floor and span the car, so a lighter
     * corner could never be taken flat or on a lift. Slip angle is the honest
     * measure of how much the axle is already spending sideways. */
    const PEAK = 0.16;                       // ~ where the tyre curve peaks
    const latUseF = Math.min(1, Math.abs(alphaF) / PEAK);
    const latUseR = Math.min(1, Math.abs(alphaR) / PEAK);
    driveF = Math.min(driveF, tracF * (1 - 0.30 * latUseF));
    driveR = Math.min(driveR, tracR * (1 - 0.62 * latUseR));
    car.wheelspin += (Math.min(1, spin) - car.wheelspin) * 0.12;
    // EBD-style modulation: while steering, keep some tyre capacity lateral
    // instead of locking everything into braking (footbrake only, not handbrake)
    const steering = Math.abs(car.steer) > 0.03 && Math.abs(car.vx) > 6;
    const brakeCapF = tracF * (steering ? 0.78 : 1);
    const brakeCapR = tracR * (steering && !car.handbrake ? 0.72 : 1);
    let fxF = driveF - Math.min(brakeF, brakeCapF) * dirV;
    let fxR = driveR - Math.min(brakeR, brakeCapR) * dirV;
    if (reverseF) { fxR = reverseF; fxF = reverseF * 0.6; }

    // ---- lateral forces with friction ellipse
    const useF = Math.min(1, Math.abs(fxF) / (mu * fzF));
    const useR = Math.min(1, Math.abs(fxR) / (rearMuLat * fzR));
    /* Floor on the ellipse: a saturated axle keeps roughly half its cornering
     * force rather than almost none. Real tyres do not fall off that cliff,
     * and the cliff is what made every mistake terminal instead of catchable. */
    const latScaleF = Math.sqrt(Math.max(0.25, 1 - useF * useF));
    const latScaleR = Math.sqrt(Math.max(0.25, 1 - useR * useR));
    let fyF = tyreLat(alphaF, fzF, mu, B, C) * latScaleF * lowSpeed;
    let fyR = tyreLat(alphaR, fzR, rearMuLat, B, rearC) * latScaleR * lowSpeed;

    // ---- drag, rolling resistance, slopes
    const drag = 0.5 * CAR.rho * CAR.cda * car.vx * Math.abs(car.vx);
    const rr = CAR.rr * m * G * dirV * Math.min(1, Math.abs(car.vx));
    const slopeFx = -m * G * Math.sin(car.groundPitch);
    const slopeFy = -m * G * Math.sin(car.groundRoll);
    const offDrag = extraDrag * m * 0.1 * Math.min(1, Math.abs(car.vx) / 8) * dirV;

    // snowbank shove: press the car back toward the road
    let bankFy = 0;
    if (gC.on === "bank") {
      const toRoad = -Math.sign(car.d);
      const worldPush = 5.2 * m;
      // convert a world-lateral push (perp to road) into body frame approx
      const roadHead = gC.rq.heading;
      const rel = car.yaw - roadHead;
      bankFy = worldPush * toRoad * Math.cos(rel);
      car.vx *= 0.995;
    }

    const fx = fxF + fxR - drag - rr + slopeFx - offDrag;
    const fy = fyF + fyR + slopeFy + bankFy;

    // ---- integrate body frame
    const ax = fx / m + car.vyLat * car.omega;
    const ay = fy / m - car.vx * car.omega;
    car.vx += ax * DT;
    car.vyLat += ay * DT;
    car.axSmooth += ((fx / m) - car.axSmooth) * 0.1;
    const yawAcc = (CAR.a * fyF * Math.cos(car.steer) - CAR.b * fyR) / CAR.izz;
    car.omega += yawAcc * DT;
    // mild speed-dependent yaw damping (tyre relaxation / aligning torque)
    car.omega -= car.omega * Math.min(0.9, 0.18 + Math.abs(car.vx) * 0.014) * DT * 2.8;

    /* Big-slide damping. A rally car lives at a lively angle, so nothing here
     * touches a normal slide; past about 26 degrees of body slip, though, the
     * old model would keep winding the car up until it was facing backwards
     * with nothing the driver could do. Bleeding yaw rate only in that region
     * keeps a slide a slide - it does not make the car faster, it makes the
     * moment survivable. */
    const betaNow = Math.abs(Math.atan2(car.vyLat, Math.max(4, Math.abs(car.vx))));
    // pull the handbrake and you have asked for the big angle - let it come
    const excess = betaNow - (0.45 + 0.5 * hb);
    if (excess > 0) {
      car.omega -= car.omega * Math.min(0.8, excess * 2.4) * DT * 2.0;
    }

    /* ---- arcade stability ------------------------------------------------
     * This is a game you play on a keyboard with three steering positions and
     * a human reaction time, not a simulator. A physically honest rally car
     * needs constant delicate correction, which is unplayable with those
     * controls - so the car is helped to do what the driver asked.
     *
     * Both assists fade out in proportion to how much slide the driver is
     * deliberately calling for, so the handbrake and a bootful of steering
     * still hang the tail out and the ceiling stays where it was.
     *
     * The handbrake fades them a long way but not to nothing. It asks for
     * rotation; it does not ask to be handed a different car. With no assist
     * at all there was nothing holding the slide together, and the tail went
     * past catching in the time it takes to notice - a quarter of it still
     * lets the back come round hard, at a rate a person can answer.
     */
    const wantSlide = Math.min(1, Math.abs(car.sigma) * 1.3);
    const assist = STABILITY * (1 - 0.7 * wantSlide) * (1 - 0.75 * hb);
    if (assist > 0 && Math.abs(car.vx) > 3) {
      // the car goes where it points: bleed off sideways drift
      car.vyLat -= car.vyLat * Math.min(1, assist * 3.0 * DT);
      // and turns as much as the wheel asks, up to what grip actually allows
      const gripOmega = (mu * G * 1.05) / Math.max(6, Math.abs(car.vx));
      const kinematic = (car.vx / (CAR.a + CAR.b)) * Math.tan(car.steer);
      const targetOmega = Math.max(-gripOmega, Math.min(gripOmega, kinematic));
      car.omega += (targetOmega - car.omega) * Math.min(1, assist * 2.4 * DT);
    }
    car.yaw += car.omega * DT;

    // rumble wobble on loose stuff (cosmetic magnitudes, deterministic)
    if (rumbleAmt > 0.05 && Math.abs(car.vx) > 8) {
      car.omega += rumble(car) * rumbleAmt * 0.02;
    }

    // slide metrics for audio/particles
    car.slip = Math.abs(Math.atan2(car.vyLat, Math.max(3, Math.abs(car.vx))));
    car.skid = Math.min(1, Math.max(car.slip * 2.4 - 0.18, car.wheelspin) + (car.handbrake && Math.abs(car.vx) > 4 ? 0.5 : 0));

    // ---- world position
    car.x += (car.vx * cosY - car.vyLat * sinY) * DT;
    car.z += (car.vx * sinY + car.vyLat * cosY) * DT;
  }

  // ---- collisions
  const cx = Math.floor(car.x / 8), cz = Math.floor(car.z / 8);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const arr = stage.colliderHash.get((cx + dx) + "," + (cz + dz));
    if (!arr) continue;
    for (const c of arr) {
      if (Math.abs(c.y - car.y) > 3.4) continue;
      const ox = car.x - c.x, oz = car.z - c.z;
      const rr2 = (c.r + CAR.colliderR);
      const d2 = ox * ox + oz * oz;
      if (d2 >= rr2 * rr2 || d2 < 1e-9) continue;
      const dist = Math.sqrt(d2);
      const nx = ox / dist, nz = oz / dist;
      // push out
      const pen = rr2 - dist;
      car.x += nx * pen;
      car.z += nz * pen;
      // world velocity
      const cY = Math.cos(car.yaw), sY = Math.sin(car.yaw);
      let wvx = car.vx * cY - car.vyLat * sY;
      let wvz = car.vx * sY + car.vyLat * cY;
      const vn = wvx * nx + wvz * nz;
      if (vn < 0) {
        const impact = -vn;
        wvx -= 1.35 * vn * nx;
        wvz -= 1.35 * vn * nz;
        wvx *= 0.72; wvz *= 0.72;
        car.vx = wvx * cY + wvz * sY;
        car.vyLat = -wvx * sY + wvz * cY;
        car.omega += (nx * sY - nz * cY) * impact * 0.06;
        car.damage += impact * 3.2;
        car.lastImpact = impact;
        if (impact > ev.impact) ev.impact = impact;
        if (impact > 8) car.crashTimer = 1.6;
      }
    }
  }

  /* ---- body attitude and ride height (rendering only)
   * Split in two, because the two halves want opposite things. Where the car
   * sits is kinematics - the wheels are on the ground, so the chassis follows
   * the plane through the four contact patches almost exactly, and only
   * enough spring is left in it to take the fizz out of rough terrain. How
   * the car leans is the body on its dampers - dive, squat and roll are
   * genuinely laggy, so they spring on top. Running one soft spring for both
   * (which is what this used to be) buys a bit of weight in the corners and
   * pays for it with wheels that hang off the road all the way down a hill.
   * None of it feeds back into the simulation: runs stay bit-identical. */
  if (car.airborne) {
    car.pitch = Math.max(-0.5, Math.min(0.5, car.pitch + car.pitchV * DT));
    car.roll *= 0.99;
    car.bodyY = car.y;
    car.wasAir = true;
  } else {
    const c = car.contact;
    const fwd = car.contactOK
      ? Math.atan(((c[0] + c[1]) - (c[2] + c[3])) / (2 * (CAR.a + CAR.b)))
      : car.groundPitch;
    const lat = car.contactOK
      ? Math.atan(((c[0] + c[2]) - (c[1] + c[3])) / (4 * CAR.halfTrack))
      : car.groundRoll;
    /* Load transfer: braking dives the nose, power lifts it, and the body
     * leans out of the corner (vx*omega is the lateral acceleration, signed
     * towards the inside of the turn). Held to what the suspension can
     * actually travel - about 3.5 degrees of dive and 6 of roll at the limit.
     * The old gains were twice these, from back when the renderer drew both
     * upside down and the lean had to be enormous to read as anything. */
    car.pitchV = 0;
    car.pitchLoad += (Math.max(-0.06, Math.min(0.06, car.axSmooth * 0.0065)) - car.pitchLoad) * 0.12;
    car.rollLoad += (Math.max(-0.1, Math.min(0.1, car.vx * car.omega * 0.0095)) - car.rollLoad) * 0.1;
    /* Whatever attitude the car was flying at is bled off over a fifth of a
     * second rather than sprung away, so a nose-high landing plants its
     * wheels while the body is still coming down. */
    if (car.wasAir) {
      car.wasAir = false;
      car.airBlend = 1;
      /* Clamped hard: once the tyres are down the chassis is theirs, and a
       * car cannot sit 30 degrees nose-high on four wheels no matter how it
       * was flying. What is left reads as the slam of the landing. */
      car.airPitch = Math.max(-0.12, Math.min(0.12, car.pitch - fwd - car.pitchLoad));
      car.airRoll = Math.max(-0.1, Math.min(0.1, car.roll - lat - car.rollLoad));
      // set, not sprung: the tyres are down on this tick, not three later
      car.pitch = fwd + car.pitchLoad + car.airPitch;
      car.roll = lat + car.rollLoad + car.airRoll;
    }
    car.airBlend = Math.max(0, car.airBlend - DT / 0.18);
    const ease = car.airBlend * car.airBlend * (3 - 2 * car.airBlend);
    const targetPitch = fwd + car.pitchLoad + car.airPitch * ease;
    const targetRoll = lat + car.rollLoad + car.airRoll * ease;
    car.pitch += (Math.max(-0.7, Math.min(0.7, targetPitch)) - car.pitch) * 0.4;
    car.roll += (Math.max(-0.45, Math.min(0.45, targetRoll)) - car.roll) * 0.4;
    /* Ride height off the same four patches, never below the ground under
     * the car's belly - a crest shorter than the wheelbase carries it on the
     * apex. car.y keeps the speed-stretched probe it needs for landings, so
     * the two differ by a few centimetres over broken ground; that gap is
     * exactly what the suspension travel in the renderer takes up. */
    const chord = car.contactOK
      ? ((c[0] + c[1]) * CAR.b + (c[2] + c[3]) * CAR.a) / (2 * (CAR.a + CAR.b))
      : car.y;
    car.bodyY += (Math.max(groundY, chord) - car.bodyY) * 0.6;
  }

  if (car.crashTimer > 0) car.crashTimer -= DT;

  // stuck detection: barely moving with throttle demanded
  if (Math.abs(car.vx) < 0.7 && input.throttle > 0.5) car.stuckT += DT;
  else car.stuckT = 0;

  return ev;
}

/* ------------------------------------------------------------- bot driver
 * Follows the centreline via pure pursuit and the stage speed profile via a
 * bang-bang throttle. Used by the node harness to test-drive every stage,
 * and to sanity-check pace notes against reality. */
export function botInput(car, stage, profile, skill) {
  const q = stage.roadQuery(car.x, car.z, car.s);
  if (!q) {
    // out past the corridor: aim back at the road using the last known s
    const ti = Math.min(stage.geo.n - 1, Math.round((car.s + 10) / 2));
    const dx = stage.geo.x[ti] - car.x, dz = stage.geo.z[ti] - car.z;
    const localZ = -Math.sin(car.yaw) * dx + Math.cos(car.yaw) * dz;
    const localX = Math.cos(car.yaw) * dx + Math.sin(car.yaw) * dz;
    if (localX < 0) return { dir: localZ > 0 ? 1 : -1, throttle: 0.45, brake: 0, handbrake: false };
    return { dir: localZ > 1 ? 1 : localZ < -1 ? -1 : 0, throttle: 0.55, brake: 0, handbrake: false };
  }
  const v = Math.max(1, car.vx);
  const sk = skill == null ? 0.95 : skill;

  // unstick: nose against something it can't climb -> back away, then retry
  if (car.botRev == null) car.botRev = 0;
  if (car.botRev > 0) {
    car.botRev -= DT;
    return { dir: car.d > 0 ? -1 : 1, throttle: 0, brake: 1, handbrake: false };
  }
  if (car.stuckT > 1.2) { car.botRev = 1.4; car.stuckT = 0; }

  // slide state: body sideslip angle. Normal rally slides live below ~20 deg;
  // only treat genuinely big moments as "sliding".
  const beta = Math.atan2(car.vyLat, Math.max(4, Math.abs(car.vx)));
  const sliding = Math.abs(beta) > 0.35 || Math.abs(car.omega) > 1.5;

  const L = CAR.a + CAR.b;
  let steerDes;
  if (sliding) {
    // countersteer: point the fronts at the direction of travel
    steerDes = beta * 1.15;
  } else {
    // curvature feedforward + Stanley-style heading/cross-track correction
    const fi = Math.min(stage.geo.n - 1, Math.round((q.s + Math.max(5, v * 0.42)) / 2));
    const ff = Math.atan(L * stage.curvArr[fi] * 1.08);
    const hi = Math.min(stage.geo.n - 1, Math.round((q.s + 3) / 2));
    let psi = stage.geo.heading[hi] - car.yaw;
    while (psi > Math.PI) psi -= Math.PI * 2;
    while (psi < -Math.PI) psi += Math.PI * 2;
    const cross = Math.atan((-q.d * 1.15) / Math.max(4, v));
    steerDes = ff + Math.max(-0.5, Math.min(0.5, psi)) * 0.85 + cross;
    // never demand more curvature than grip allows
    const kLim = (stage.grip.lat * G * 0.95) / Math.max(30, v * v);
    const dLim = Math.atan(L * kLim) + 0.1;
    steerDes = Math.max(-dLim, Math.min(dLim, steerDes));
  }
  let dir = 0;
  const err = steerDes - car.steer;
  if (err > 0.006) dir = 1;
  else if (err < -0.006) dir = -1;

  // speed control: look at the profile a braking distance ahead
  const decel = Math.max(1.5, stage.grip.long * G * 0.55 + q.grade * G * 0.8);
  let vTarget = 99;
  for (let ahead = 0; ahead < 200; ahead += 8) {
    const ii = Math.min(stage.geo.n - 1, Math.round((q.s + ahead) / 2));
    const vAllowed = profile.v[ii] * sk;
    const vNow = Math.sqrt(vAllowed * vAllowed + 2 * decel * ahead);
    if (vNow < vTarget) vTarget = vNow;
  }
  let throttle = 0, brake = 0;
  if (v < vTarget - 0.4) throttle = 1;
  else if (v > vTarget + 0.6) brake = Math.min(1, (v - vTarget) * 0.3);
  // discipline: taper the brake as the wheel loads up, but keep enough pedal
  // to finish the job (the EBD in step() protects the rear axle)
  if (Math.abs(car.steer) > steerMaxAt(v) * 0.6) brake = Math.min(brake, 0.55);
  if (sliding) {
    // freewheel + countersteer at speed; once nearly stopped, kill the
    // pirouette with the brake instead of ballet-spinning on the grass
    throttle = 0;
    brake = Math.abs(car.vx) < 6 ? 1 : 0;
  } else if (car.slip > 0.3) throttle = Math.min(throttle, 0.5);

  // recovery: well off the road -> creep back toward the centreline
  if (Math.abs(car.d) > q.hw + 1.5 && Math.abs(car.vx) < 14 && !sliding) {
    const ti2 = Math.min(stage.geo.n - 1, Math.round((q.s + 12) / 2));
    const dx2 = stage.geo.x[ti2] - car.x, dz2 = stage.geo.z[ti2] - car.z;
    const localZ2 = -Math.sin(car.yaw) * dx2 + Math.cos(car.yaw) * dz2;
    const localX2 = Math.cos(car.yaw) * dx2 + Math.sin(car.yaw) * dz2;
    if (localX2 < 0) {
      // target is behind: three-point turn, slowly
      return { dir: localZ2 > 0 ? 1 : -1, throttle: 0.5, brake: 0, handbrake: false };
    }
    dir = localZ2 > 0.5 ? 1 : localZ2 < -0.5 ? -1 : 0;
    return { dir, throttle: 0.6, brake: 0, handbrake: false };
  }

  return { dir, throttle, brake, handbrake: false };
}
