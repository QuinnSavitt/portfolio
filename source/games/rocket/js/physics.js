/* Daily Rocket — 2D rigid-body flight.
 *
 * Fixed 1/120 s step, independent of rendering. Same day + same build + same
 * input timeline = bit-identical flight, which is what lets the generator
 * machine-verify days and makes scores comparable.
 *
 * World frame: +x downrange, +y up. `ang` is tilt from vertical, positive
 * leaning right (clockwise). Body axis a = (sin, cos); right-hand normal
 * n = (cos, -sin). Torque and angular velocity are clockwise-positive.
 *
 * Every vessel (the rocket and each dropped stage) is the same kind of body:
 * a list of parts in a shared local frame, a CoM velocity, a spin. Forces
 * are summed per part — thrust at each nozzle, Barrowman-style normal force
 * at each aero term, a canopy at each chute — so stability, weathervaning,
 * pitch damping and tumbling all fall out of the geometry.
 *
 * Input per tick: { rot -1..1, throttle 0..1, stage bool, chute bool,
 * retro bool }. Rotation is rate-command with limited authority: the flight
 * computer asks for a spin rate and gets whatever torque the reaction
 * wheels, gimbals and thrusters can supply against the air.
 */

import {
  massProps, aeroTerms, exhaustV, fullFlow, isEngine,
  LEG_V, LEG_H, BARE_V, BARE_H, TILT_MAX, CHUTE_Q, assemble, G0, FIN_CTRL
} from "./parts.js";
import { airAt, windAt } from "./world.js";

export const DT = 1 / 120;
export const MAX_T = 300;
export const RATE = 1.2;         // rad/s commanded rotation rate
const SPOOL_UP = 3.2, SPOOL_DOWN = 7;
const OMEGA_MAX = 14;
const GRACE = 0.7;               // s after liftoff where ground contact is ignored
const DEBRIS_OK = 10;            // m/s — a stage landing slower than this is recovered

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export function normAngle(a) {
  while (a > Math.PI) { a -= Math.PI * 2; }
  while (a < -Math.PI) { a += Math.PI * 2; }
  return a;
}

// ---------------------------------------------------------------- vessels

function newVessel(parts, role, id) {
  return {
    id, role, parts,
    x: 0, y: 0, ang: 0, vx: 0, vy: 0, angVel: 0,
    resting: role === "main", unpinnedAt: -1e9,
    legsOut: true, chute: 0, chuteState: "stowed",
    terms: null, points: null, dirty: true, chutes: [], hasLegs: false,
    alive: true, fate: null, mp: null
  };
}

function refresh(v) {
  if (!v.dirty) { return; }
  v.terms = aeroTerms(v.parts, v.legsOut);
  v.points = contactPoints(v);
  v.hasLegs = v.parts.some((p) => p.kind === "legs");
  v.chutes = v.parts.filter((p) => p.kind === "chute");
  v.dirty = false;
}
export { refresh as refreshVessel };

function contactPoints(v) {
  const pts = [];
  let bottom = null;
  for (const p of v.parts) {
    if (!p.radial && (!bottom || p.s0 < bottom.s0)) { bottom = p; }
  }
  for (const p of v.parts) {
    if (p.kind === "legs" && v.legsOut) {
      pts.push({ c: p.footC, s: p.footS, foot: "leg" });
      continue;
    }
    const bare = p === bottom;
    const inset = p.kind === "engine" ? 0.08 : 0;
    pts.push({ c: p.c - p.w / 2 + inset, s: p.s0, foot: bare ? "bare" : null });
    pts.push({ c: p.c + p.w / 2 - inset, s: p.s0, foot: bare ? "bare" : null });
    if (p.kind === "fins") {
      pts.push({ c: p.c + p.side * p.w / 2, s: p.s0 + p.h * 0.45, foot: null });
    } else {
      pts.push({ c: p.c - p.w / 2, s: p.s1, foot: null });
      pts.push({ c: p.c + p.w / 2, s: p.s1, foot: null });
    }
  }
  return pts;
}

/* world position of a local (c, s) point */
export function toWorld(v, c, s) {
  const sa = Math.sin(v.ang), ca = Math.cos(v.ang);
  return { x: v.x + s * sa + c * ca, y: v.y + s * ca - c * sa };
}

export function comWorld(v) {
  const mp = v.mp || massProps(v.parts);
  return toWorld(v, mp.c, mp.s);
}

/* velocity of a local point, given the CoM velocity */
function pointVel(v, mp, c, s) {
  const ra = s - mp.s, rn = c - mp.c;
  const sa = Math.sin(v.ang), ca = Math.cos(v.ang);
  // v + w (ra n - rn a),  n = (ca, -sa), a = (sa, ca)
  return {
    x: v.vx + v.angVel * (ra * ca - rn * sa),
    y: v.vy + v.angVel * (-ra * sa - rn * ca)
  };
}

// ------------------------------------------------------------ the target

export function bargeAt(day, t) {
  const b = day.barge;
  if (!b) { return null; }
  const w = (Math.PI * 2) / b.period;
  return {
    x: b.x0 + b.amp * Math.sin(w * t),
    vx: b.amp * w * Math.cos(w * t),
    y: b.deck, half: b.half
  };
}

/* where the current leg of the job wants you: a pad, or the barge deck */
export function targetAt(day, t, leg) {
  if (day.barge) {
    const b = bargeAt(day, t);
    return { x: b.x, y: b.y, half: b.half, vx: b.vx };
  }
  const tg = day.legs[Math.min(leg || 0, day.legs.length - 1)].target;
  return { x: tg.x, y: tg.y, half: tg.half, vx: 0 };
}

export function simTarget(sim) { return targetAt(sim.day, sim.t, sim.leg); }
export function simLeg(sim) { return sim.day.legs[Math.min(sim.leg, sim.day.legs.length - 1)]; }

/* the surface under x at mission time t, and what it is */
export function groundAt(sim, x) {
  const day = sim.day;
  if (day.barge) {
    const b = bargeAt(day, sim.t);
    if (Math.abs(x - b.x) <= b.half + 1.5) { return { y: b.y, vx: b.vx, kind: "barge" }; }
  }
  const tr = day.terrain;
  const g = tr.heightAt(x);
  if (g < tr.seaLevel) { return { y: tr.seaLevel, vx: 0, kind: "water" }; }
  return { y: g, vx: 0, kind: "ground" };
}

// ------------------------------------------------------------------ sim

export function createSim(day, build) {
  const A = assemble(build);
  const main = newVessel(A.parts, "main", 1);
  const sim = {
    day, build, main, debris: [], wrecks: [], landed: [], serial: 1,
    events: [], stageEvents: A.events, nextEvent: 0, leg: 0,
    t: 0, tick: 0, ignited: false, done: false, outcome: null, message: "",
    thr: 0, thrCmd: 0, hold: 0, retro: false,
    liquidBurned: 0, solidBurned: 0, monoBurned: 0,
    gates: day.gates ? day.gates.map(() => null) : [],
    ribbon: false, maxAlt: 0, maxQ: 0, maxSpeed: 0, touchdowns: 0,
    landing: null, authority: 0, aeroTorque: 0, lastQ: 0, lastRho: 0, agl: 0,
    aeroFx: 0, aeroFy: 0
  };
  refresh(main);
  seat(main, day.launch.x, day.launch.y);
  main.mp = massProps(main.parts);
  return sim;
}

/* stand a vessel upright with its lowest contact point on height y at x */
function seat(v, x, y) {
  refresh(v);
  let sMin = Infinity;
  for (const p of v.points) { if (p.s < sMin) { sMin = p.s; } }
  v.ang = 0; v.angVel = 0; v.vx = 0; v.vy = 0;
  v.x = x;
  v.y = y - sMin;
}

/* lowest point of the vessel above whatever is under it */
export function clearance(sim, v) {
  refresh(v);
  let low = Infinity;
  for (const p of v.points) {
    const w = toWorld(v, p.c, p.s);
    low = Math.min(low, w.y - groundAt(sim, w.x).y);
  }
  return low;
}

function push(sim, e) { e.t = sim.t; sim.events.push(e); }

// ----------------------------------------------------------- staging

function lightSeg(v, seg) {
  for (const p of v.parts) {
    if (p.seg === seg && isEngine(p.def) && !p.blocked) { p.lit = true; }
  }
}

function split(sim, v, pick, push0) {
  const mp = massProps(v.parts);
  const keep = [], go = [];
  for (const p of v.parts) { (pick(p) ? go : keep).push(p); }
  if (!go.length || !keep.length) { return null; }
  const d = newVessel(go, "debris", ++sim.serial);
  d.x = v.x; d.y = v.y; d.ang = v.ang; d.angVel = v.angVel;
  d.legsOut = false; d.resting = false;
  const mpD = massProps(go);
  const vd = pointVel(v, mp, mpD.c, mpD.s);
  d.vx = vd.x; d.vy = vd.y;
  v.parts = keep;
  const mpK = massProps(keep);
  const vk = pointVel(v, mp, mpK.c, mpK.s);
  v.vx = vk.x; v.vy = vk.y;
  // spring the pieces apart along push0 (a world direction, applied to v)
  if (push0) {
    const mu = (mpD.m * mpK.m) / (mpD.m + mpK.m);
    const J = mu * push0.dv;
    v.vx += (push0.x * J) / mpK.m; v.vy += (push0.y * J) / mpK.m;
    d.vx -= (push0.x * J) / mpD.m; d.vy -= (push0.y * J) / mpD.m;
    if (push0.spin) { d.angVel += push0.spin; }
  }
  v.dirty = true; d.dirty = true;
  v.mp = mpK; d.mp = mpD;
  refresh(v); refresh(d);
  sim.debris.push(d);
  return d;
}

function doStage(sim) {
  const ev = sim.stageEvents[sim.nextEvent];
  if (!ev) { return; }
  const v = sim.main;
  sim.nextEvent++;
  const sa = Math.sin(v.ang), ca = Math.cos(v.ang);
  const com = comWorld(v);
  if (ev.type === "ignite") {
    sim.ignited = true;
    lightSeg(v, 0);
    push(sim, { type: "ignite", x: com.x, y: com.y });
  } else if (ev.type === "boosters") {
    for (const side of [-1, 1]) {
      // push the main body away from the booster: booster on the right (+n)
      // leaves toward +n, so the core gets a nudge toward -n
      const d = split(sim, v, (p) => p.radial && p.kind === "srb" && p.seg === ev.seg && p.side === side,
        { x: -side * ca, y: side * sa, dv: 2.4, spin: side * 0.4 });
      if (d) { push(sim, { type: "boosters", x: com.x, y: com.y, id: d.id, side }); }
    }
  } else if (ev.type === "separate") {
    const d = split(sim, v, (p) => p.seg <= ev.seg, { x: sa, y: ca, dv: 2.2, spin: 0 });
    lightSeg(v, ev.seg + 1);
    sim.thr = Math.min(sim.thr, 0.5);
    push(sim, { type: "separate", x: com.x, y: com.y, id: d ? d.id : 0 });
  }
}

// -------------------------------------------------------------- engines

/* Burns this tick's propellant; returns the thrusting parts and the torque
 * the gimbals could make if asked. */
function runEngines(sim, v, mp, pAtm, throttle) {
  const thrusts = [];
  let gimbal = 0;
  const bySeg = {};
  for (const p of v.parts) {
    if (!p.lit || p.blocked) { continue; }
    if (p.kind === "engine" || p.kind === "pod") {
      let th = throttle;
      if (th > 0.004 && th < p.def.minThr) { th = p.def.minThr; }
      if (th <= 0.004) { p.burning = 0; continue; }
      (bySeg[p.seg] = bySeg[p.seg] || []).push({ p, th, flow: fullFlow(p.def) * th });
    } else if (p.kind === "srb") {
      if (p.prop <= 0) { p.burning = 0; continue; }
      const flow = fullFlow(p.def);
      const used = Math.min(p.prop, flow * DT);
      p.prop -= used;
      if (v.role === "main") { sim.solidBurned += used; }
      const frac = used / (flow * DT);
      const T = flow * exhaustV(p.def, pAtm) * frac;
      p.burning = frac;
      thrusts.push({ p, T });
      if (p.prop <= 0) { p.prop = 0; push(sim, { type: "burnout", id: v.id, part: p.idx }); }
    }
  }
  for (const key in bySeg) {
    const seg = +key;
    const list = bySeg[key];
    let avail = 0;
    const tanks = [];
    for (const t of v.parts) { if (t.kind === "tank" && t.seg === seg) { tanks.push(t); avail += t.prop; } }
    let want = 0;
    for (const e of list) { want += e.flow * DT; }
    const k = want > 0 ? Math.min(1, avail / want) : 0;
    if (k <= 0) {
      for (const e of list) { e.p.burning = 0; }
      if (!v["dry" + seg]) {
        v["dry" + seg] = true;
        push(sim, { type: "flameout", id: v.id, seg, main: v.role === "main" });
      }
      continue;
    }
    const used = want * k;
    for (const t of tanks) { t.prop -= used * (t.prop / avail); if (t.prop < 1e-9) { t.prop = 0; } }
    if (v.role === "main") { sim.liquidBurned += used; }
    for (const e of list) {
      const T = e.flow * k * exhaustV(e.p.def, pAtm);
      e.p.burning = e.th * k;
      thrusts.push({ p: e.p, T });
      gimbal += T * Math.sin(e.p.def.gimbal) * Math.abs(e.p.s0 - mp.s);
    }
  }
  return { thrusts, gimbal };
}

// ----------------------------------------------------------- step one body

function stepBody(sim, v, input) {
  const day = sim.day, w = day.world;
  refresh(v);
  const mp = massProps(v.parts);
  v.mp = mp;
  const sa = Math.sin(v.ang), ca = Math.cos(v.ang);
  const com = toWorld(v, mp.c, mp.s);
  const isMain = v.role === "main";

  const air = airAt(w, com.y);
  const agl = com.y - groundAt(sim, com.x).y;
  const wind = windAt(day, agl, sim.t);

  // ---- throttle & engines
  let throttle = 0;
  if (isMain) {
    const want = clamp(input.throttle || 0, 0, 1);
    sim.thrCmd = want;
    sim.thr += clamp(want - sim.thr, -SPOOL_DOWN * DT, SPOOL_UP * DT);
    if (sim.thr < 0.003 && want <= 0) { sim.thr = 0; }
    throttle = sim.thr;
  }
  // dropped liquid stages shut down; dropped solids burn on regardless
  const eng = runEngines(sim, v, mp, air.p, throttle);

  // ---- resting on the ground: pinned until thrust beats weight
  if (v.resting) {
    const g = groundAt(sim, com.x);
    let T = 0;
    for (const e of eng.thrusts) { T += e.T; }
    if (g.kind === "barge") { v.x += g.vx * DT; }
    if (T > mp.m * w.g * 1.02) {
      v.resting = false;
      v.unpinnedAt = sim.t;
      push(sim, { type: "liftoff", x: com.x, y: com.y });
    } else {
      v.vx = g.vx; v.vy = 0; v.angVel = 0;
      if (isMain) { sim.authority = 0; sim.aeroTorque = 0; sim.agl = 0; }
      return;
    }
  }

  // ---- forces
  let fx = 0, fy = -mp.m * w.g, tq = 0;
  for (const e of eng.thrusts) {
    fx += sa * e.T; fy += ca * e.T;
    tq += -(e.p.c - mp.c) * e.T;
  }

  let tqAero = 0;
  const fx0 = fx, fy0 = fy;
  if (air.rho > 0) {
    const half = 0.5 * air.rho;
    for (const t of v.terms) {
      const ra = t.s - mp.s, rn = t.c - mp.c;
      const pvx = v.vx + v.angVel * (ra * ca - rn * sa) - wind;
      const pvy = v.vy + v.angVel * (-ra * sa - rn * ca);
      const ua = pvx * sa + pvy * ca;
      const un = pvx * ca - pvy * sa;
      const Fn = -half * (t.N * un * Math.abs(ua) + t.X * un * Math.abs(un));
      const Fa = -half * t.D * ua * Math.abs(ua);
      fx += Fn * ca + Fa * sa;
      fy += -Fn * sa + Fa * ca;
      tqAero += ra * Fn - rn * Fa;
    }
    // canopies pull from their attach point along the airflow
    if (v.chute > 0 && v.chuteState === "open" && v.chutes.length) {
      let cda = 0, cs = 0, cc = 0;
      for (const p of v.chutes) { cda += p.def.cda; cs += p.s1; cc += p.c; }
      cs /= v.chutes.length; cc /= v.chutes.length;
      cda *= v.chute;
      const ra = cs - mp.s, rn = cc - mp.c;
      const pvx = v.vx + v.angVel * (ra * ca - rn * sa) - wind;
      const pvy = v.vy + v.angVel * (-ra * sa - rn * ca);
      const sp = Math.hypot(pvx, pvy);
      const F = half * cda * sp;
      const cfx = -F * pvx, cfy = -F * pvy;
      fx += cfx; fy += cfy;
      const Fn = cfx * ca - cfy * sa, Fa = cfx * sa + cfy * ca;
      tqAero += ra * Fn - rn * Fa;
      // the swinging canopy soaks up spin
      tqAero -= v.angVel * cda * half * sp * 0.6;
    }
  }
  tq += tqAero;
  if (isMain) { sim.aeroFx = fx - fx0; sim.aeroFy = fy - fy0; }

  const speedAir = Math.hypot(v.vx - wind, v.vy);
  const q = 0.5 * air.rho * speedAir * speedAir;

  // ---- control torque (the rocket's flight computer)
  if (isMain) {
    let wheel = 0, rcsMax = 0;
    // fins double as control surfaces: authority grows with dynamic pressure
    for (const t of v.terms) {
      if (t.fin) { wheel += q * t.N * FIN_CTRL * Math.abs(t.s - mp.s); }
    }
    for (const p of v.parts) {
      if (p.def.wheel) { wheel += p.def.wheel; }
      if (p.kind === "rcs" && p.mono > 0) {
        rcsMax += p.def.force * Math.max(0.6, Math.abs((p.s0 + p.s1) / 2 - mp.s));
      }
    }
    const auth = wheel + eng.gimbal + rcsMax;
    sim.authority = auth;
    sim.aeroTorque = tqAero;
    const rot = clamp(input.rot || 0, -1, 1);
    let wt;
    const amax = Math.max(0.05, auth / mp.I);
    if (Math.abs(rot) > 0.02) {
      wt = rot * RATE;
      // hold where the spin will actually stop once the stick is let go
      sim.hold = normAngle(v.ang + (v.angVel * Math.abs(v.angVel)) / (2 * amax * 0.8));
    } else {
      let target = sim.hold;
      if (sim.retro) {
        const vs = Math.hypot(v.vx, v.vy);
        target = vs > 1.5 ? Math.atan2(-v.vx, -v.vy) : 0;
        if (Math.abs(target) > Math.PI / 2 && vs < 6) { target = 0; } // no flipping over at a crawl
        sim.hold = v.ang;
      }
      const err = normAngle(target - v.ang);
      const mag = Math.min(RATE, Math.sqrt(2 * amax * 0.6 * Math.abs(err)), Math.abs(err) * 4);
      wt = Math.sign(err) * mag;
    }
    const want = mp.I * (wt - v.angVel) * 9 - tqAero;
    const tc = clamp(want, -auth, auth);
    tq += tc;
    // thrusters pay for whatever the wheels and gimbals could not cover
    const extra = Math.max(0, Math.abs(tc) - wheel - eng.gimbal);
    const frac = rcsMax > 0 ? Math.min(1, extra / rcsMax) : 0;
    for (const p of v.parts) {
      if (p.kind !== "rcs") { continue; }
      if (frac > 0 && p.mono > 0) {
        const u = Math.min(p.mono, (p.def.force / (220 * G0)) * frac * DT);
        p.mono -= u; sim.monoBurned += u;
        p.puff = frac * Math.sign(tc);
      } else { p.puff = 0; }
    }
  }

  // ---- integrate (semi-implicit Euler about the CoM)
  v.vx += (fx / mp.m) * DT;
  v.vy += (fy / mp.m) * DT;
  v.angVel = clamp(v.angVel + (tq / mp.I) * DT, -OMEGA_MAX, OMEGA_MAX);
  v.ang = normAngle(v.ang + v.angVel * DT);
  const nx = com.x + v.vx * DT, ny = com.y + v.vy * DT;
  const sb = Math.sin(v.ang), cb = Math.cos(v.ang);
  v.x = nx - (mp.s * sb + mp.c * cb);
  v.y = ny - (mp.s * cb - mp.c * sb);

  if (isMain) {
    sim.lastQ = q; sim.lastRho = air.rho; sim.lastWind = wind;
    sim.maxQ = Math.max(sim.maxQ, q);
    sim.maxSpeed = Math.max(sim.maxSpeed, Math.hypot(v.vx, v.vy));
    sim.agl = agl;
  }

  // ---- canopies: inflate, tear; stages open theirs automatically
  if (v.chutes.length) {
    if (v.chuteState === "open") {
      v.chute = Math.min(1, v.chute + DT / 1.3);
      if (q > CHUTE_Q * 1.3) {
        v.chuteState = "torn"; v.chute = 0;
        push(sim, { type: "chuteTorn", id: v.id, main: isMain });
      }
    } else if (!isMain && v.chuteState === "stowed" && air.rho > 0 &&
               v.vy < -2 && q < CHUTE_Q * 0.6 && agl < 5000) {
      openChute(sim, v, q);
    }
  }

  // ---- legs fold away on the climb and drop for the landing
  if (v.hasLegs) {
    if (v.legsOut && isMain && v.vy > 4 && agl > 45 && sim.t - v.unpinnedAt > 1) {
      v.legsOut = false; v.dirty = true;
      push(sim, { type: "legs", id: v.id, out: false });
    } else if (!v.legsOut && v.vy < -0.5 && agl < 170) {
      v.legsOut = true; v.dirty = true;
      push(sim, { type: "legs", id: v.id, out: true });
    }
  }

  contact(sim, v, mp);
}

function openChute(sim, v, q) {
  if (q > CHUTE_Q) {
    v.chuteState = "torn";
    push(sim, { type: "chuteTorn", id: v.id, main: v.role === "main" });
  } else {
    v.chuteState = "open"; v.chute = 0.02;
    push(sim, { type: "chuteOpen", id: v.id, main: v.role === "main" });
  }
}

// -------------------------------------------------------------- contact

function contact(sim, v, mp) {
  refresh(v);
  let worst = 0, hit = null;
  const touch = [];
  for (const p of v.points) {
    const wp = toWorld(v, p.c, p.s);
    const g = groundAt(sim, wp.x);
    const pen = g.y - wp.y;
    if (pen > 0) {
      const t = { p, wp, g, pen };
      touch.push(t);
      if (pen > worst) { worst = pen; hit = t; }
    }
  }
  if (!touch.length) { return; }
  const isMain = v.role === "main";

  // just lifted off: the feet are still kissing the ground
  if (isMain && sim.t - v.unpinnedAt < GRACE) {
    v.y += worst;
    if (v.vy < 0) { v.vy = 0; }
    return;
  }

  const pv = pointVel(v, mp, hit.p.c, hit.p.s);
  const rvx = pv.x - hit.g.vx, rvy = pv.y;
  const impact = Math.hypot(rvx, rvy);
  const com = toWorld(v, mp.c, mp.s);

  if (!isMain) {
    if (hit.g.kind === "water") {
      v.alive = false; v.fate = "sunk";
      push(sim, { type: "splash", x: hit.wp.x, y: hit.g.y, id: v.id, big: false });
    } else if (impact < DEBRIS_OK) {
      v.alive = false; v.fate = "recovered";
      push(sim, { type: "recovered", x: com.x, y: com.y, id: v.id });
    } else {
      v.alive = false; v.fate = "wrecked";
      push(sim, { type: "explosion", x: com.x, y: com.y, id: v.id, size: Math.min(1, mp.m / 1500) });
    }
    return;
  }

  // ---- the rocket
  if (touch.some((t) => t.g.kind === "water")) {
    return fail(sim, "splash", "Splashed down in the sea. The payload sank.", com, impact);
  }
  const offFoot = touch.some((t) => !t.p.foot);
  const legFoot = touch.some((t) => t.p.foot === "leg");
  const vLim = legFoot ? LEG_V : BARE_V, hLim = legFoot ? LEG_H : BARE_H;

  // footprint for the tip-over test
  let hw, hcg;
  const legs = v.parts.filter((p) => p.kind === "legs");
  let bottom = null;
  for (const p of v.parts) { if (!p.radial && (!bottom || p.s0 < bottom.s0)) { bottom = p; } }
  if (legFoot && legs.length) {
    hw = 0; let fs = Infinity;
    for (const p of legs) { hw = Math.max(hw, Math.abs(p.footC)); fs = Math.min(fs, p.footS); }
    hcg = mp.s - fs;
  } else {
    hw = bottom ? bottom.w / 2 : 0.5;
    hcg = mp.s - (bottom ? bottom.s0 : 0);
  }
  const tipLimit = Math.min(TILT_MAX, Math.atan2(hw, Math.max(0.5, hcg)) - 0.05);
  const slope = hit.g.kind === "ground" ? Math.atan(sim.day.terrain.slopeAt(hit.wp.x)) : 0;
  const tilt = normAngle(v.ang - slope);

  const dT = targetDistance(sim, com.x);
  const onTarget = dT.on && (sim.day.barge ? hit.g.kind === "barge" : Math.abs(hit.g.y - simTarget(sim).y) < 3);
  sim.landing = {
    vertical: rvy, horizontal: rvx, speed: impact, tilt: Math.abs(tilt),
    distance: dT.d, onTarget, legs: legFoot, vLim, hLim, tipLimit
  };

  let why = null;
  if (offFoot) {
    why = impact > 9 ? "Hit the ground at " + impact.toFixed(0) + " m/s. Nothing survived."
      : "Came down on its side. It is not built for that.";
  } else if (Math.abs(rvy) > vLim * 2.4) {
    why = "Hit the ground at " + impact.toFixed(1) + " m/s. Nothing survived.";
  } else if (Math.abs(rvy) > vLim || Math.abs(rvx) > hLim) {
    why = "Touched down at " + impact.toFixed(1) + " m/s" +
      (legFoot ? "" : " on the engine bell (no legs: 2 m/s max)") + ". It folded.";
  } else if (Math.abs(tilt) > tipLimit) {
    why = "Landed " + Math.round(Math.abs(tilt) * 57.3) + "° off level and toppled" +
      (tipLimit < 0.12 ? " — the footprint is too narrow for the height." : ".");
  } else if (Math.abs(slope) > tipLimit * 0.85) {
    why = "Set down on a " + Math.round(Math.abs(slope) * 57.3) + "° slope. It slid and tipped.";
  }
  if (why) { return fail(sim, "crash", why, com, impact); }

  // survivable: settle onto the ground
  sim.touchdowns++;
  v.resting = true;
  v.ang = slope; v.angVel = 0; v.vx = hit.g.vx; v.vy = 0;
  sim.hold = slope;
  let low = Infinity;
  for (const p of v.points) {
    const wp = toWorld(v, p.c, p.s);
    low = Math.min(low, wp.y - groundAt(sim, wp.x).y);
  }
  v.y -= low;
  push(sim, { type: "touchdown", x: com.x, y: com.y - (mp.s - (bottom ? bottom.s0 : 0)), speed: impact, onTarget, legs: legFoot });

  if (onTarget) {
    const miss = missing(sim);
    if (miss) { push(sim, { type: "note", text: miss }); }
    else if (sim.leg < sim.day.legs.length - 1) {
      // a stop on the way: take on the pickup, then the next leg begins
      const leg = simLeg(sim);
      const pay = v.parts.find((p) => p.kind === "payload");
      if (pay && leg.pickup) { pay.dry += leg.pickup; }
      sim.leg++;
      sim.stops = (sim.stops || 0) + 1;
      push(sim, { type: "pickup", x: com.x, y: com.y, kg: leg.pickup || 0, text: leg.pickupText || "" });
    } else { finish(sim, "landed", "Delivered."); }
  }
}

export function targetDistance(sim, x) {
  const tg = simTarget(sim);
  const d = x - tg.x;
  return { d, on: Math.abs(d) <= tg.half };
}

function missing(sim) {
  const day = sim.day;
  if (sim.leg < day.legs.length - 1) { return null; }
  if (day.ribbon && !sim.ribbon) { return "On the pad — but you never reached the " + day.ribbon.label + "."; }
  const left = sim.gates.filter((g) => !g).length;
  if (left) { return "On the pad — but " + left + " ring" + (left > 1 ? "s" : "") + " still to fly through."; }
  return null;
}

function fail(sim, outcome, message, com, impact) {
  sim.main.alive = false;
  push(sim, {
    type: outcome === "splash" ? "splash" : "explosion", x: com.x, y: com.y,
    id: sim.main.id, big: true, size: 1, main: true, impact: impact || 0
  });
  finish(sim, outcome, message);
}

function finish(sim, outcome, message) {
  if (sim.done) { return; }
  sim.done = true;
  // the flight is over: engines go quiet (the sim no longer steps them)
  for (const p of sim.main.parts) { p.burning = 0; p.puff = 0; }
  sim.thr = 0;
  sim.outcome = outcome;
  sim.message = message;
  sim.success = outcome === "landed";
  push(sim, { type: "finish", outcome });
}

// ---------------------------------------------------------------- step

export function step(sim, input) {
  if (sim.done) { return; }
  input = input || {};
  const day = sim.day;
  const v = sim.main;

  if (input.stage) { doStage(sim); }
  if (input.chute && v.chutes.length && sim.ignited) {
    if (v.chuteState === "stowed") {
      const com = comWorld(v);
      const air = airAt(day.world, com.y);
      const wind = windAt(day, com.y - groundAt(sim, com.x).y, sim.t);
      const sp = Math.hypot(v.vx - wind, v.vy);
      openChute(sim, v, 0.5 * air.rho * sp * sp);
      if (air.rho <= 0) { push(sim, { type: "note", text: "No air to catch — the canopies just flap." }); }
    } else if (v.chuteState === "open") {
      v.chuteState = "cut"; v.chute = 0;
      push(sim, { type: "chuteCut", id: v.id });
    }
  }
  sim.retro = !!input.retro;

  if (!sim.ignited) { return; } // on the pad, clock stopped

  stepBody(sim, v, input);
  for (const d of sim.debris) { if (d.alive) { stepBody(sim, d, null); } }
  retire(sim);

  sim.t += DT;
  sim.tick++;
  if (sim.done) { return; }

  // mission bookkeeping
  const com = comWorld(v);
  sim.maxAlt = Math.max(sim.maxAlt, com.y - day.launch.y);
  if (day.ribbon && !sim.ribbon && com.y >= day.ribbon.y) {
    sim.ribbon = true;
    push(sim, { type: "ribbon", x: com.x, y: com.y });
  }
  if (day.gates) {
    for (let i = 0; i < day.gates.length; i++) {
      const gt = day.gates[i];
      if (sim.gates[i]) { continue; }
      const d = Math.hypot(com.x - gt.x, com.y - gt.y);
      if (d <= gt.half) {
        sim.gates[i] = { err: d / gt.half, t: sim.t };
        push(sim, { type: "gate", index: i, x: gt.x, y: gt.y, err: d / gt.half });
      }
    }
  }

  // stranded: sitting somewhere that isn't the job, with no way to fly
  if (v.resting) {
    if (!canLift(sim, v)) {
      v.strandT = (v.strandT || 0) + DT;
      if (v.strandT > 1.5) {
        const onPad = targetDistance(sim, com.x).on;
        finish(sim, "stranded", onPad
          ? "Parked on the pad without finishing the job, and nothing left to burn."
          : sim.touchdowns > 0 ? "Down safe, but short of the pad with no way to lift off again."
            : "Never beat gravity. It needs more thrust or less mass.");
      }
    } else { v.strandT = 0; }
  }

  const tr = day.terrain;
  if (com.x < tr.x0 + 30 || com.x > tr.x1 - 30) {
    finish(sim, "lost", "Flew off the edge of the mission map.");
  } else if (com.y - day.launch.y > 60000) {
    finish(sim, "lost", "Kept going. Space has it now.");
  } else if (sim.t >= MAX_T) {
    finish(sim, "timeout", "Mission clock ran out.");
  }
}

function canLift(sim, v) {
  const w = sim.day.world;
  const mp = massProps(v.parts);
  let T = 0;
  for (const p of v.parts) {
    if (!p.lit || p.blocked) { continue; }
    if (p.kind === "srb" && p.prop > 0) { T += fullFlow(p.def) * exhaustV(p.def, 0); }
    if (p.kind === "engine" || p.kind === "pod") {
      const fuel = v.parts.some((t) => t.kind === "tank" && t.seg === p.seg && t.prop > 0.5);
      if (fuel) { T += p.def.thrust; }
    }
  }
  if (T > mp.m * w.g * 1.02) { return true; }
  return sim.nextEvent < sim.stageEvents.length; // a stage might still light something
}

function retire(sim) {
  for (let i = sim.debris.length - 1; i >= 0; i--) {
    const d = sim.debris[i];
    if (d.alive) {
      const com = comWorld(d);
      const tr = sim.day.terrain;
      if (com.x < tr.x0 || com.x > tr.x1 || com.y - sim.day.launch.y > 60000) {
        d.alive = false; d.fate = "lost";
      }
    }
    if (!d.alive) {
      sim.debris.splice(i, 1);
      (d.fate === "recovered" ? sim.landed : sim.wrecks).push(d);
    }
  }
}

/* After the rocket is done, let any stages still falling finish their fall
 * so recovery can be scored. Deterministic; runs in a blink. */
export function settleDebris(sim) {
  let guard = 0;
  while (sim.debris.length && guard < 120 * 120) {
    for (const d of sim.debris) { if (d.alive) { stepBody(sim, d, null); } }
    retire(sim);
    sim.t += DT;
    guard++;
  }
  for (const d of sim.debris) { d.alive = false; d.fate = "lost"; sim.wrecks.push(d); }
  sim.debris.length = 0;
}

// ------------------------------------------------------ telemetry helpers

/* Thrust available at full throttle right now, and the vessel's mass. */
export function thrustNow(sim, v) {
  const mp = v.mp || massProps(v.parts);
  const com = toWorld(v, mp.c, mp.s);
  const air = airAt(sim.day.world, com.y);
  let T = 0, Tmin = 0, liquid = 0, solid = 0;
  for (const p of v.parts) {
    if (!p.lit || p.blocked) { continue; }
    if (p.kind === "srb") {
      if (p.prop > 0) { const t = fullFlow(p.def) * exhaustV(p.def, air.p); T += t; Tmin += t; solid += t; }
    } else if (p.kind === "engine" || p.kind === "pod") {
      let fuel = false;
      for (const t of v.parts) { if (t.kind === "tank" && t.seg === p.seg && t.prop > 0) { fuel = true; break; } }
      if (!fuel) { continue; }
      const t = fullFlow(p.def) * exhaustV(p.def, air.p);
      T += t; liquid += t;
      Tmin += t * p.def.minThr;
    }
  }
  return { T, Tmin, liquid, solid, m: mp.m, air };
}

export function stagePropellant(v, seg) {
  let prop = 0, max = 0;
  for (const p of v.parts) {
    if (p.seg !== seg) { continue; }
    if (p.kind === "tank") { prop += p.prop; max += p.propMax * p.fill; }
    else if (p.kind === "srb") { prop += p.prop; max += p.propMax; }
  }
  return { prop, max };
}

export function currentSeg(v) {
  let lo = Infinity;
  for (const p of v.parts) { if (!p.radial && p.seg < lo) { lo = p.seg; } }
  return lo === Infinity ? 0 : lo;
}

/* Where would the rocket come down if nothing else happened? Point-mass
 * coast with gravity and the vessel's axial drag. Used by the HUD arc and
 * by the autopilot. Stops where it meets `floor` on the way down, or the
 * surface. `clear` is the lowest height over the terrain along the way. */
export function coast(sim, v, opts) {
  opts = opts || {};
  const day = sim.day, w = day.world;
  refresh(v);
  const mp = v.mp || massProps(v.parts);
  const c0 = toWorld(v, mp.c, mp.s);
  let x = c0.x, y = c0.y, vx = v.vx, vy = v.vy;
  let cda = 0;
  for (const t of v.terms) { cda += t.D; }
  if (v.chuteState === "open") { for (const p of v.chutes) { cda += p.def.cda * Math.max(v.chute, 0.5); } }
  if (opts.cda != null) { cda = opts.cda; }
  const m = mp.m;
  const dt = opts.dt || 0.1;
  const tMax = opts.tMax || 90;
  const floor = opts.floor;
  const pts = opts.points ? [{ x, y }] : null;
  let sLow = Infinity;
  for (const p of v.points) { sLow = Math.min(sLow, p.s); }
  sLow -= mp.s;
  let t = 0, clear = Infinity, apex = y, hit = false;
  let nextPt = 0.5;
  while (t < tMax) {
    const rho = w.rho0 > 0 ? w.rho0 * Math.exp(-Math.max(0, y) / w.scaleH) : 0;
    const wind = rho > 0 ? windAt(day, 400, sim.t + t) : 0;
    const rx = vx - wind, ry = vy;
    const sp = Math.hypot(rx, ry);
    const k = (0.5 * rho * cda * sp) / m;
    vx += -k * rx * dt;
    vy += (-w.g - k * ry) * dt;
    x += vx * dt; y += vy * dt; t += dt;
    if (y > apex) { apex = y; }
    const g = day.terrain.surfaceAt(x);
    const h = y + sLow - g;
    if (h < clear) { clear = h; }
    if (pts && t >= nextPt) { pts.push({ x, y }); nextPt += 0.5; }
    if (floor != null && vy < 0 && y <= floor) { break; }
    if (h <= 0) { hit = true; break; }
  }
  if (pts) { pts.push({ x, y }); }
  return { pts, x, y, t, vx, vy, clear, apex, hit };
}
