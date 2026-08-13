/* Daily Rally — vehicle dynamics.
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
export const TICK_RATE = 120;

export const CAR = {
  mass: 1230,
  izz: 1580,
  a: 1.21,           // CG -> front axle
  b: 1.39,           // CG -> rear axle
  h: 0.5,            // CG height (weight transfer)
  wheelR: 0.31,
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
  gears: [3.9, 2.65, 1.95, 1.52, 1.22, 1.0],
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
    pitch: 0, roll: 0,           // rendered body attitude
    pitchV: 0, rollV: 0,
    groundPitch: 0, groundRoll: 0,
    sigma: 0, steer: 0,
    throttle: 0, brake: 0, handbrake: false,
    gear: 1, rpm: CAR.idle,
    wheelspin: 0, slip: 0, skid: 0,
    surface: "road", zone: "road",
    axSmooth: 0,
    damage: 0, lastImpact: 0, crashTimer: 0,
    tick: 0,
    s: 0, d: 0, roadGrade: 0,
    offRoadT: 0,
    stuckT: 0,
    dead: false,
  };
}

export function resetCar(car, stage) {
  const fresh = makeCar();
  Object.assign(car, fresh);
  const i = Math.round(stage.startS / 2);
  car.x = stage.geo.x[i];
  car.z = stage.geo.z[i];
  car.y = stage.geo.y[i];
  car.yaw = stage.geo.heading[i];
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
  const gF = stage.groundHeight(car.x + cosY * 1.3, car.z + sinY * 1.3, car.s);
  const gS = stage.groundHeight(car.x - sinY * 0.8, car.z + cosY * 0.8, car.s);
  const groundY = gC.y;
  const fwdSlope = gF ? (gF.y - gC.y) / 1.3 : 0;   // dy per metre forward
  const latSlope = gS ? (gS.y - gC.y) / 0.8 : 0;   // dy per metre toward +d
  car.groundPitch = Math.atan(fwdSlope);
  car.groundRoll = Math.atan(latSlope);
  car.zone = gC.on;
  car.s = gC.rq.s;
  car.d = gC.rq.d;
  car.roadGrade = gC.rq.grade;

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
    if (needed < -G * LIFTOFF && car.vx > 8) {
      car.airborne = true;
      car.airTime = 0;
      ev.tookOff = true;   // vyUp is left as-is: it is the speed we really had
    } else {
      car.y = groundY;
      car.vyUp = targetVy;
    }
  }

  if (car.airborne) {
    car.airTime += DT;
    car.vyUp -= G * DT;
    car.y += car.vyUp * DT;
    // small pitch authority in the air (brake = nose down, throttle = nose up)
    car.pitchV += (car.throttle * 1.6 - car.brake * 2.2) * DT;
    // world-frame ballistic travel
    const wvx = car.vx * cosY - car.vyLat * -sinY;
    const wvz = car.vx * sinY + car.vyLat * cosY;
    car.x += (car.vx * cosY - car.vyLat * sinY) * DT;
    car.z += (car.vx * sinY + car.vyLat * cosY) * DT;
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
      car.vyUp = 0;
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
    const alphaF = Math.atan((car.vyLat + CAR.a * car.omega) / vxA) - car.steer * Math.sign(car.vx >= 0 ? 1 : -1);
    const alphaR = Math.atan((car.vyLat - CAR.b * car.omega) / vxA);

    // ---- loads with longitudinal transfer
    const L = CAR.a + CAR.b;
    let fzF = (m * G * CAR.b) / L - (m * car.axSmooth * CAR.h) / L;
    let fzR = (m * G * CAR.a) / L + (m * car.axSmooth * CAR.h) / L;
    fzF = Math.max(m * 1.2, fzF); fzR = Math.max(m * 1.2, fzR);

    // ---- longitudinal forces
    const eng = engineForce(car, muLong);
    let driveF = eng * CAR.frontDrive;
    let driveR = eng * (1 - CAR.frontDrive);
    let brakeF = car.brake * CAR.brakeForce * CAR.brakeBias;
    let brakeR = car.brake * CAR.brakeForce * (1 - CAR.brakeBias);
    let rearMuLat = mu, rearC = C;
    if (car.handbrake) {
      brakeR += 9000;
      driveR = 0;
      rearMuLat = mu * 0.35;
      rearC = C + 0.5;
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
    const latScaleF = Math.sqrt(Math.max(0.08, 1 - useF * useF));
    const latScaleR = Math.sqrt(Math.max(0.08, 1 - useR * useR));
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
    car.omega -= car.omega * Math.min(0.9, 0.15 + Math.abs(car.vx) * 0.014) * DT * 2.2;
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

  // ---- body attitude springs (rendering only)
  const targetPitch = car.airborne ? car.pitch + car.pitchV * DT : car.groundPitch - car.axSmooth * 0.012;
  const targetRoll = car.airborne ? car.roll * 0.99 : car.groundRoll + (car.vx * car.omega) * 0.02;
  if (car.airborne) {
    car.pitch += car.pitchV * DT;
    car.pitch = Math.max(-0.5, Math.min(0.5, car.pitch));
  } else {
    car.pitchV = 0;
    car.pitch += (targetPitch - car.pitch) * 0.12;
  }
  car.roll += (Math.max(-0.4, Math.min(0.4, targetRoll)) - car.roll) * 0.1;

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
