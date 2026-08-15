/* Daily Rally — pace-note ladder check.
 *
 * A pace note is a promise about what the driver has to do. This drives a
 * synthetic corner of each severity, in each environment, with escalating
 * inputs - hold the throttle, lift, brake - and reports the cheapest one that
 * gets through. It has to match what SEV says the severity means, or the
 * notes are lying.
 *
 * It also re-measures usable lateral grip on a skidpad, because track.js
 * derives every corner radius from LAT_USABLE: if the tyre model drifts away
 * from that constant, corners quietly stop meaning what they say.
 *
 * Imported by rally-test.mjs; also runnable on its own for the full table:
 *   node tools/rally-ladder.mjs
 */
import { pathToFileURL } from "url";
import path from "path";

const jsDir = path.resolve(import.meta.dirname, "../source/games/rally/js") + path.sep;
const base = pathToFileURL(jsDir).href;
const { DS, G, ENVS, SURFACES, SEV, VCAP, LAT_USABLE, sevRadius } = await import(base + "track.js");
const { makeCar, step, botInput, DT } = await import(base + "physics.js");

const OFF = { lat: 0.6, long: 0.55, drag: 3.2 };

/* Mirror of track.js refSpeed. Kept here rather than exported so the harness
 * fails loudly if the two ever disagree about how fast a stage runs. */
const LONGEST_STRAIGHT = 220;
function refSpeed(env, grip) {
  const len = LONGEST_STRAIGHT * (env.straightScale || 1);
  let v = 20;
  for (let s = 0; s < len; s += DS) {
    const drag = (0.36 * v * v) / 1230 + 0.012 * G;
    const acc = Math.min(grip.long * G * 0.9, 195000 / (1230 * v)) - drag;
    v = Math.sqrt(Math.max(1, v * v + 2 * Math.max(0.4, acc) * DS));
  }
  return Math.min(VCAP, v);
}

/* A stage-shaped object holding one corner: straight, clothoid, arc,
 * clothoid, straight. Curvature is laid out the way compile() does it so the
 * rig tests the corner the game actually builds, not a bare arc. */
function makeRig(R, A, hw, grip, S0 = 320, S2 = 120) {
  const Lc = Math.min(90, Math.max(8, Math.min(R * 0.5, R * A * 0.42)));  // mirrors compile()
  const k = 1 / R;
  const arcLen = Math.max(0.06, A - k * Lc) / k;
  const total = S0 + Lc + arcLen + Lc + S2;
  const n = Math.round(total / DS) + 1;
  const x = new Float64Array(n), z = new Float64Array(n), y = new Float64Array(n);
  const heading = new Float64Array(n), grade = new Float64Array(n);
  const curv = new Float64Array(n), hwArr = new Float64Array(n), camb = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const s = i * DS;
    hwArr[i] = hw;
    if (s < S0) curv[i] = 0;
    else if (s < S0 + Lc) curv[i] = k * ((s - S0) / Lc);
    else if (s < S0 + Lc + arcLen) curv[i] = k;
    else if (s < S0 + Lc + arcLen + Lc) curv[i] = k * (1 - (s - S0 - Lc - arcLen) / Lc);
    else curv[i] = 0;
  }
  let hx = 0, hz = 0, th = 0;
  for (let i = 0; i < n; i++) {
    x[i] = hx; z[i] = hz; heading[i] = th;
    th += curv[i] * DS;
    hx += Math.cos(th) * DS; hz += Math.sin(th) * DS;
  }

  /* Nearest sample, then project onto the neighbouring segments - the same
   * shape as the real roadQuery, hint window included, because a hairpin's
   * two legs pass close enough to be mistaken for each other. */
  function roadQuery(px, pz, hintS) {
    const hintI = hintS != null ? Math.round(hintS / DS) : null;
    const lo = hintI != null ? Math.max(0, hintI - 40) : 0;
    const hi = hintI != null ? Math.min(n - 1, hintI + 40) : n - 1;
    let best = lo, bestD2 = Infinity;
    for (let i = lo; i <= hi; i++) {
      const d2 = (x[i] - px) ** 2 + (z[i] - pz) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    let bi = best, bt = 0, bd2 = Infinity;
    for (let i = Math.max(0, best - 2); i < Math.min(n - 1, best + 2); i++) {
      const bx = x[i + 1] - x[i], bz = z[i + 1] - z[i];
      const len2 = bx * bx + bz * bz;
      const t = Math.max(0, Math.min(1, len2 > 0 ? ((px - x[i]) * bx + (pz - z[i]) * bz) / len2 : 0));
      const d2 = (px - x[i] - bx * t) ** 2 + (pz - z[i] - bz * t) ** 2;
      if (d2 < bd2) { bd2 = d2; bi = i; bt = t; }
    }
    const ox = px - (x[bi] + (x[bi + 1] - x[bi]) * bt);
    const oz = pz - (z[bi] + (z[bi + 1] - z[bi]) * bt);
    const sign = Math.cos(heading[bi]) * oz - Math.sin(heading[bi]) * ox > 0 ? 1 : -1;
    return {
      s: (bi + bt) * DS, d: sign * Math.sqrt(bd2), y: 0, hw, camberT: 0, grade: 0,
      curv: curv[bi], flag: 0, heading: heading[bi], idx: bi,
    };
  }
  function groundHeight(px, pz, hintS) {
    const rq = roadQuery(px, pz, hintS);
    const ad = Math.abs(rq.d);
    if (ad <= hw) return { y: 0, on: "road", rq };
    if (ad <= hw + 0.9) return { y: -(ad - hw) * 0.12, on: "shoulder", rq };
    return { y: -0.4, on: "off", rq };
  }
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    v[i] = curv[i] > 1e-6 ? Math.sqrt((grip.lat * LAT_USABLE * G) / curv[i]) : 80;
  }
  return {
    geo: { n, x, z, y, heading, grade }, curvArr: curv, cambArr: camb, hwArr,
    flagArr: new Uint8Array(n), grip, offroad: OFF, surfKey: "gravel",
    roadQuery, groundHeight, colliderHash: new Map(), profile: { v },
    length: total, S0, R, A, hw, Lc, cornerLen: Lc + arcLen + Lc, vEntry: 0,
  };
}

/* Pedal policies. Steering comes from the bot; each policy holds the arrival
 * speed down the approach, so what is being measured is the corner and not
 * how much road there was to build speed on. */
function hold(rig, car) {
  const dv = rig.vEntry - car.vx;
  return {
    throttle: Math.max(0, Math.min(1, dv * 0.5)),
    brake: Math.max(0, Math.min(1, -dv * 0.3)),
    handbrake: false,
  };
}
const POLICIES = {
  flat: (rig, car) => (car.s < rig.S0 ? hold(rig, car) : { throttle: 1, brake: 0, handbrake: false }),
  lift: (rig, car) => {
    if (car.s > rig.S0 - 120 && car.s < rig.S0 + rig.cornerLen * 0.55) {
      return { throttle: 0, brake: 0, handbrake: false };
    }
    return car.s < rig.S0 ? hold(rig, car) : { throttle: 1, brake: 0, handbrake: false };
  },
  brake: (rig, car) => {
    /* Aim a few percent under the theoretical limit. Nobody turns into a
     * hairpin at exactly the friction ceiling, and modelling a driver who
     * does makes the tightest corners pass or fail on a tenth of a metre. */
    const vC = Math.sqrt(rig.grip.lat * LAT_USABLE * G * rig.R) * 0.94;
    const dist = rig.S0 - car.s;
    const vAllow = dist > 0 ? Math.sqrt(vC * vC + 2 * rig.grip.long * G * 0.8 * dist) : vC;
    if (car.vx > vAllow + 0.4) return { throttle: 0, brake: Math.min(1, (car.vx - vAllow) * 0.35), handbrake: false };
    if (car.s > rig.S0 + rig.cornerLen * 0.5) return { throttle: 1, brake: 0, handbrake: false };
    if (car.s < rig.S0) return hold(rig, car);
    return { throttle: car.vx < vC ? 0.55 : 0, brake: 0, handbrake: false };
  },
  /* A tap at turn-in, wheel held into the corner while the tail comes round -
   * the bot would countersteer and fight the technique. */
  handbrake: (rig, car) => {
    const p = POLICIES.brake(rig, car);
    if (car.hbT == null) car.hbT = 0;
    if (car.s > rig.S0 + rig.Lc * 0.5 && car.hbT < 0.36 && car.vx > 4) {
      car.hbT += DT;
      return { throttle: 0.25, brake: 0, handbrake: true, dir: 1 };
    }
    return { ...p, handbrake: false };
  },
};
const ORDER = ["flat", "lift", "brake"];

function driveRig(rig, policy, vEntry) {
  const car = makeCar();
  car.vx = vEntry; car.gear = 6; car.rpm = 5200;
  rig.vEntry = vEntry;
  let worstD = 0, t = 0;
  for (let i = 0; i < 120 * 60; i++) {
    const bi = botInput(car, rig, rig.profile, 1.0);
    const p = POLICIES[policy](rig, car);
    step(car, rig, { dir: p.dir != null ? p.dir : bi.dir, ...p });
    t += DT;
    if (car.s > rig.S0 - 30) worstD = Math.max(worstD, Math.abs(car.d));
    if (!isFinite(car.x) || car.damage > 40) return { ok: false, reason: "crash", t, worstD };
    if (car.s >= rig.length - 8) return { ok: worstD <= rig.hw + 0.05, worstD, t, vExit: car.vx };
    if (car.vx < 1 && i > 240) return { ok: false, reason: "stopped", t, worstD };
  }
  return { ok: false, reason: "timeout", t, worstD };
}

/* Usable lateral grip the tyre model really delivers, as a fraction of the
 * table's peak. track.js sizes every corner off LAT_USABLE, so this is the
 * assumption that has to keep holding. */
function skidpadFraction(grip, R) {
  const rig = makeRig(R, Math.PI * 1.4, 60, grip, 40, 40);
  let held = 0;
  for (let v = 6; v <= 70; v += 1.5) {
    const car = makeCar();
    car.vx = v; car.gear = 4; car.rpm = 4000;
    rig.vEntry = v;
    let ok = true;
    for (let i = 0; i < 120 * 25; i++) {
      const bi = botInput(car, rig, rig.profile, 1.0);
      step(car, rig, { dir: bi.dir, ...hold(rig, car) });
      if (car.s > rig.S0 + 40 && Math.abs(car.d) > 1.6) { ok = false; break; }
      if (!isFinite(car.x) || car.s >= rig.length - 8) break;
    }
    if (ok) held = v; else break;
  }
  return (held * held) / (G * R) / grip.lat;
}

export function ladderCheck(verbose) {
  let fails = 0;
  const log = (s) => console.log(s);

  // --- grip constant still honest?
  const fracs = [];
  for (const key of ["gravel", "snow", "tarmac"]) {
    for (const R of [60, 120, 220]) fracs.push(skidpadFraction(SURFACES[key], R));
  }
  const lo = Math.min(...fracs), hi = Math.max(...fracs);
  const gripOk = lo > LAT_USABLE - 0.14 && hi < LAT_USABLE + 0.14;
  if (!gripOk) fails++;
  log(`skidpad: usable lateral grip ${lo.toFixed(2)}-${hi.toFixed(2)} of table ` +
      `(LAT_USABLE=${LAT_USABLE}) ${gripOk ? "OK" : "OFF — corner radii are mis-sized"}`);

  // --- does each severity need the input its note promises?
  for (const env of ENVS) {
    const grip = SURFACES[env.surfKey];
    const vRef = refSpeed(env, grip);
    if (verbose) {
      log(`\n${env.name} (${env.surfKey}, half-width ${env.baseHalfWidth} m, pace ${(vRef * 3.6).toFixed(0)} km/h)`);
      log("  sev    R(m)  ang   corner    promises    needs");
    }
    for (const key of ["6", "5", "4", "3", "2", "1", "sq", "hp"]) {
      const band = SEV[key];
      const R = sevRadius(key, vRef, grip, null, env.baseHalfWidth + 8);   // mirrors buildPlan
      const A = (((band.a[0] + band.a[1]) / 2) * Math.PI) / 180;
      const rig = makeRig(R, A, env.baseHalfWidth, grip);
      // fast corners sit at the end of long straights, so they are tested at
      // the car's top speed; the rest at the stage's own pace
      const vEntry = band.need === "flat" ? VCAP : vRef;
      let need = "IMPOSSIBLE";
      for (const p of ORDER) if (driveRig(rig, p, vEntry).ok) { need = p; break; }

      /* The rig gives every corner a long approach, so the brake pedal alone
       * can always make a hairpin - it cannot prove the lever is *required*.
       * What it can prove is that the lever is not a trap: pulling it has to
       * get through too. */
      let ok, shown = need;
      if (band.need === "handbrake") {
        const hb = driveRig(rig, "handbrake", vEntry);
        ok = need !== "IMPOSSIBLE" && hb.ok;
        shown = `${need}, lever ${hb.ok ? "ok" : "FAILS"}`;
      } else {
        ok = need === band.need;
      }
      if (!ok) fails++;
      if (verbose || !ok) {
        log(`  ${key.padEnd(4)} ${R.toFixed(0).padStart(6)} ${((A * 180) / Math.PI).toFixed(0).padStart(4)}  ` +
            `${(Math.sqrt(grip.lat * LAT_USABLE * G * R) * 3.6).toFixed(0).padStart(4)} km/h  ` +
            `${band.need.padEnd(11)} ${shown}${ok ? "" : "   <-- note is lying"}` +
            (verbose ? "" : `   [${env.id}]`));
      }
    }
  }
  return fails;
}

if (process.argv[1] && process.argv[1].endsWith("rally-ladder.mjs")) {
  const fails = ladderCheck(true);
  console.log(fails === 0 ? "\nLADDER OK" : `\nLADDER: ${fails} severities do not need what they promise`);
}
