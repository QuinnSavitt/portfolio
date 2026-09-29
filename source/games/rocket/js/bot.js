/* Daily Rocket — deterministic autopilot.
 *
 * Three jobs: the generator test-flies every candidate day with it (so a
 * published daily is machine-verified flyable, and its result is the par);
 * the rival companies on the day's board are this bot flying their own
 * builds; and ?bot=1 lets a human watch it. It drives the same physics
 * through the same input contract as a player — no shortcuts.
 *
 * Plan: light the stack, boost onto a ballistic arc that arrives above the
 * target (velocity-to-be-gained steering, with a drag-aware coast predictor
 * deciding cutoff), coast with the tail into the wind, then a TWR-aware
 * velocity-field landing: sink limits from the braking distance this engine
 * can actually produce, drift squeezed out near the ground, flare late.
 * Sounding days climb to the ribbon first; gate days thread the gates.
 */

import {
  thrustNow, coast, currentSeg, stagePropellant, simTarget, simLeg, comWorld,
  clearance, normAngle, RATE
} from "./physics.js";

const TILT_MAX = 1.1;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* velocity that puts a point mass on a drag-free arc from (x0,y0) through
 * an apex at height ya, coming down through (x1, y1) */
function arcVelocity(x0, y0, x1, y1, ya, g) {
  ya = Math.max(ya, y0 + 1, y1 + 1);
  const vy = Math.sqrt(2 * g * (ya - y0));
  const t = vy / g + Math.sqrt((2 * (ya - y1)) / g);
  return { vx: (x1 - x0) / t, vy, t };
}

export function createBot(skill) {
  return { skill: skill == null ? 0.85 : skill, phase: "pad", pred: null, predTick: -99, stageT: -9 };
}

function wantsStage(sim, v, bot) {
  const ev = sim.stageEvents[sim.nextEvent];
  if (!ev) { return false; }
  if (ev.type === "ignite") { return true; }
  if (sim.t - bot.stageT < 0.6) { return false; }
  const seg = currentSeg(v);
  if (ev.type === "boosters") {
    return v.parts.every((p) => !(p.radial && p.kind === "srb" && p.seg === ev.seg) || p.prop <= 0);
  }
  if (ev.type === "separate" && ev.seg === seg) {
    // spent when nothing in the stage can push any more
    const liquid = stagePropellant(v, seg);
    for (const p of v.parts) {
      if (p.seg !== seg || !p.lit) { continue; }
      if (p.kind === "srb" && p.prop > 0) { return false; }
      if ((p.kind === "engine" || p.kind === "pod") && liquid.prop > 0.5) { return false; }
    }
    return true;
  }
  return false;
}

/* rotation command that turns toward `tilt` without overshooting, given the
 * torque authority the rocket actually has */
function steer(sim, v, tilt) {
  const err = normAngle(tilt - v.ang);
  const mp = v.mp;
  const amax = Math.max(0.1, (sim.authority || 2000) / (mp ? mp.I : 5000));
  const want = Math.sign(err) * Math.min(RATE, Math.sqrt(2 * amax * 0.55 * Math.abs(err)), Math.abs(err) * 3.5);
  const rot = clamp((want - v.angVel * 0.35) / RATE, -1, 1);
  return { rot, err };
}

export function botInput(sim, bot) {
  const out = { rot: 0, throttle: 0, stage: false, chute: false, retro: false };
  if (sim.done) { return out; }
  const day = sim.day, w = day.world, v = sim.main;
  const skill = bot.skill;

  if (!sim.ignited) { out.stage = true; out.throttle = 1; bot.stageT = sim.t; return out; }
  if (wantsStage(sim, v, bot)) { out.stage = true; bot.stageT = sim.t; }

  // a new leg (after a pickup) starts the plan over from the pad
  if (bot.leg !== sim.leg) {
    bot.leg = sim.leg; bot.phase = "pad"; bot.boostT = 0; bot.fixes = 0; bot.predTick = -99;
  }
  const L = simLeg(sim);
  const com = comWorld(v);
  const tn = thrustNow(sim, v);
  const m = tn.m;
  const acc = tn.T / m;
  const tg = simTarget(sim);
  const dir = L.approach.x >= com.x ? 1 : -1;
  const hPad = com.y - tg.y;
  const clr = clearance(sim, v);
  const g = w.g;

  // refresh the coast prediction ~10 times a second
  if (sim.tick - bot.predTick >= 12) {
    bot.pred = coast(sim, v, { floor: L.approach.y, dt: 0.2, tMax: 150 });
    bot.predTick = sim.tick;
  }
  const pred = bot.pred;

  if (bot.phase === "pad") {
    bot.phase = day.mission.type === "sounding" ? "climb" : day.gates ? "gates" : "boost";
    // in soup-thick air a ballistic arc dies in the drag: fly there under power
    if (bot.phase === "boost" && w.rho0 > 2) { bot.phase = "land"; }
    bot.boostT = 0;
  }

  // ---------------------------------------------------------- sounding
  if (bot.phase === "climb" || bot.phase === "coastUp") {
    const apexNeed = day.ribbon.y + 20 + (1 - skill) * 100;
    if (sim.tick % 6 === 0 || !bot.up) { bot.up = coast(sim, v, { dt: 0.25, tMax: 200, floor: -1e9 }); }
    const upP = bot.up;
    const dx = L.approach.x - com.x;
    const tFlight = Math.max(20, Math.sqrt((2 * Math.max(1, apexNeed - com.y)) / g) * 2);
    const vxWant = clamp(dx / tFlight, -30, 30);
    const tilt = clr < 20 ? 0 : clamp((vxWant - v.vx) * 0.05, -0.15, 0.15);
    out.rot = steer(sim, v, tilt).rot;
    if (bot.phase === "climb") {
      out.throttle = 1;
      if (upP.apex >= apexNeed && sim.t > 2 && tn.solid <= 0) { out.throttle = 0; bot.phase = "coastUp"; }
      if (acc <= 0 && !out.stage && sim.nextEvent >= sim.stageEvents.length) { bot.phase = "coastUp"; }
      return out;
    }
    if (!sim.ribbon && upP.apex < day.ribbon.y + 4 && v.vy > 0 && acc > 0) { out.throttle = 1; }
    if (sim.ribbon && v.vy < 0) { bot.phase = "coast"; }
    else if (!sim.ribbon && v.vy < -2 && acc > 0) { bot.phase = "climb"; }
    else { return out; }
  }

  // ---------------------------------------------------------- rings
  if (bot.phase === "gates") {
    const gi = sim.gates.findIndex((x) => !x);
    if (gi < 0) { bot.phase = "land"; }
    else {
      const gt = day.gates[gi];
      return fly(sim, v, bot, out, { tx: gt.x, ty: gt.y, pass: true, acc, m, g, com, clr, gate: gt });
    }
  }

  // ---------------------------------------------------------- boost
  const aimX = (() => {
    // aim a little short: the landing burn carries us forward while it
    // kills the horizontal speed
    const aH = Math.max(0.6, acc * 0.55);
    const vxArr = pred ? pred.vx - tg.vx : 0;
    return L.approach.x - (vxArr * Math.abs(vxArr)) / (2 * aH) * 0.7;
  })();

  if (bot.phase === "boost") {
    const ap = L.approach;
    const span = Math.abs(aimX - com.x);
    const ya = Math.max(L.clearY, ap.y + span * day.loft, com.y + 30);
    const arc = arcVelocity(com.x, com.y, aimX, ap.y, ya, g);
    const dvx = arc.vx - v.vx, dvy = arc.vy - v.vy;
    const dvm = Math.hypot(dvx, dvy);
    const ahead = pred && (dir > 0 ? pred.x >= aimX - 4 : pred.x <= aimX + 4);
    const reached = ahead && pred.clear > 30 && pred.apex >= L.clearY - 5;
    // velocity-to-be-gained over a ~2.5 s time constant, plus holding up
    // our own weight; a monster engine on a light rocket gets throttled
    let ax, ay;
    if (dvm > 3 || !pred) { ax = dvx / 2.5; ay = Math.max(-g * 0.5, dvy / 2.5) + g; }
    else { const vs = Math.max(1, Math.hypot(v.vx, v.vy)); ax = (v.vx / vs) * 3; ay = (v.vy / vs) * 3 + g; }
    let tilt = clamp(Math.atan2(ax, Math.max(0.1, ay)), -TILT_MAX, TILT_MAX);
    if (clr < 12 || sim.t < 0.8) { tilt = 0; }
    const s = steer(sim, v, tilt);
    out.rot = s.rot;
    let thr = acc > 0 ? Math.hypot(ax, ay) / acc : 1;
    if (clr < 12) { thr = Math.max(thr, Math.min(1, (g * 1.6) / Math.max(0.1, acc))); }
    if (Math.abs(s.err) > 0.6 && clr > 25) { thr *= 0.3; }
    out.throttle = clamp(thr, 0, 1);
    if (reached && tn.solid <= 0 && sim.t > 1.5 && clr > 25) {
      out.throttle = 0;
      bot.phase = "coast";
    }
    if (acc <= 0 && !out.stage && sim.nextEvent >= sim.stageEvents.length) { bot.phase = "coast"; }
    // an arc that never arrives (drag, weak engine): fly the rest under power
    bot.boostT += 1 / 120;
    if (bot.phase === "boost" && bot.boostT > 30) { bot.phase = "land"; }
    return out;
  }

  // ---------------------------------------------------------- correct
  if (bot.phase === "correct") {
    const tLeft = Math.max(3, pred ? pred.t : 10);
    const vxNeed = (aimX - com.x) / tLeft + (pred ? 0 : 0);
    const dvx = vxNeed - v.vx;
    const ax = clamp(dvx / 1.5, -acc, acc), ay = g;
    const s = steer(sim, v, clamp(Math.atan2(ax, ay), -TILT_MAX, TILT_MAX));
    out.rot = s.rot;
    out.throttle = acc > 0 ? clamp(Math.hypot(ax, ay) / acc, 0, 1) : 0;
    if (Math.abs(s.err) > 0.4) { out.throttle *= 0.2; }
    if (!pred || Math.abs(pred.x - aimX) < 12 + L.target.half * 0.3 || Math.abs(dvx) < 0.5) {
      bot.phase = "coast"; out.throttle = 0;
    }
    if (pred && pred.t < 4) { bot.phase = "coast"; }
    return out;
  }

  // ---------------------------------------------------------- coast
  if (bot.phase === "coast") {
    const vs = Math.hypot(v.vx, v.vy);
    const retro = vs > 3 ? Math.atan2(-v.vx, -v.vy) : 0;
    out.rot = steer(sim, v, clamp(retro, -TILT_MAX * 1.3, TILT_MAX * 1.3)).rot;
    out.throttle = 0;
    maybeChute(sim, v, out, tg, com);
    const aUp = Math.max(0.3, acc - g);
    const dx = tg.x - com.x;
    const floorH = Math.min(hPad, clr);
    const brakeH = v.vy < 0 ? (v.vy * v.vy) / (2 * aUp * 0.62) + 40 : 0;
    const aHh = Math.max(0.5, acc * 0.6);
    const rvx = v.vx - tg.vx;
    const hBrake = (rvx * rvx) / (2 * aHh * 0.5) + 60;
    if ((v.vy < 0 && floorH < brakeH) || (pred && pred.clear < 25 && v.vy < 0) ||
        (Math.abs(dx) < hBrake && Math.sign(rvx) === Math.sign(dx) && hPad < 400 && v.vy < 0)) {
      bot.phase = "land";
    } else if (pred && pred.t > 5 && (bot.fixes || 0) < 4 && acc > 0 &&
               Math.abs(pred.x - aimX) > 45 + L.target.half) {
      bot.fixes = (bot.fixes || 0) + 1;
      bot.phase = "correct";
    }
    if (bot.phase !== "land") { return out; }
  }

  // ---------------------------------------------------------- landing
  maybeChute(sim, v, out, tg, com);
  return fly(sim, v, bot, out, { tx: tg.x, ty: tg.y, pass: false, acc, m, g, com, clr, tvx: tg.vx, hPad });
}

function maybeChute(sim, v, out, tg, com) {
  if (!v.chutes.length || v.chuteState !== "stowed" || sim.lastRho <= 0.05) { return; }
  if (v.vy > -3) { return; }
  const dx = Math.abs(tg.x - com.x);
  // only once we are nearly over the pad: a canopy kills forward speed
  if (sim.lastQ < 9000 * 0.7 && dx < 60 + Math.abs(v.vx) * 1.5) { out.chute = true; }
}

/* Velocity-field flight to a point: through it (gates) or onto it (pad). */
function fly(sim, v, bot, out, o) {
  const day = sim.day;
  const skill = bot.skill;
  const { acc, m, g, com, clr } = o;
  const tvx = o.tvx || 0;
  const cruise = 26 + skill * 30;
  const dx = o.tx - com.x;
  const dy = o.ty - com.y;
  const dist = Math.hypot(dx, dy);
  const alt = Math.max(0, clr);
  const maxUp = Math.max(0.4, acc - g);
  const vSafe = Math.sqrt(2 * maxUp * alt * 0.55) + 1.2;
  const L = simLeg(sim);
  const rim = L.approach.rim != null ? L.approach.rim : o.ty;
  const landingRun = !o.pass && Math.abs(dx) < 16 + Math.min(12, L.target.half * 0.3) && (com.y - rim) < 240;

  let vdx, vdy;
  if (landingRun) {
    const hCap = Math.max(0.8, Math.min(8, alt * 0.2));
    vdx = tvx + clamp(dx * 0.35, -hCap, hCap);
    const sink = 1.0 + (1 - skill) * 1.2 + alt * (0.07 + skill * 0.06);
    vdy = -Math.min(sink, vSafe * 0.8);
    const brakeAlt = (v.vy < 0 ? (v.vy * v.vy - 2.4) / (2 * maxUp * 0.8) : 0) + 4;
    if (alt < Math.max(brakeAlt, 6 + 30 / maxUp)) { vdy = Math.max(vdy, -1.6); }
  } else if (o.pass) {
    // ease into a lead-in point so the momentum doesn't carry us past it
    // ease in so the momentum doesn't carry us wide of the ring
    const sp = Math.min(cruise, 14 + dist * 0.3);
    vdx = (dx / dist) * sp;
    vdy = (dy / dist) * sp;
  } else {
    const aH = Math.sqrt(Math.max(0.5, acc * acc - g * g));
    // sideways braking only gets what the vertical leaves over
    const share = v.vy < -8 ? 0.22 : 0.32;
    const vStop = Math.sqrt(2 * aH * share * Math.abs(dx)) + 3;
    const vCap = Math.min(Math.max(cruise, 40), vStop);
    vdx = tvx + clamp(dx * 0.45, -vCap, vCap);
    // hold a hover height over the pad (above a canyon rim if there is one)
    const holdY = Math.max(o.ty, rim) + (o.pass ? 0 : 55);
    vdy = clamp((holdY - com.y) * 0.45, -cruise, cruise * 0.8);
  }
  if (vdy < -vSafe) { vdy = -vSafe; }

  // terrain lookahead: never fly into a ridge or a canyon wall
  if (!landingRun) {
    const d = v.vx >= 0 ? 1 : -1;
    let need = day.terrain.surfaceAt(com.x) + 35;
    const margin = o.gate ? 40 : 70;
    // stop looking where we mean to go down to (the pad, or the gate ahead)
    const stopAt = o.gate ? ((o.gate.x - com.x) * d > 0 ? Math.abs(o.gate.x - com.x) : Infinity) : Math.abs(dx);
    for (let ahead = 30; ahead <= 360; ahead += 30) {
      if (stopAt < ahead * 0.8) { break; }
      need = Math.max(need, day.terrain.surfaceAt(com.x + d * ahead) + margin);
    }
    if (com.y < need) {
      vdy = Math.max(vdy, Math.min(30, (need - com.y) * 0.6));
      // give the climb the thrust: ease off the forward speed
      vdx = tvx + (vdx - tvx) * clamp(1 - (need - com.y) / 90, 0.15, 1);
    }
  }

  const tn = thrustNow(sim, v);
  const kv = 0.75 + skill * 0.35;
  // what the air is already doing to us (drag, lift off the fins) is fed forward
  const ax = (vdx - v.vx) * kv - (sim.aeroFx || 0) / m;
  let ay = (vdy - v.vy) * kv + g - (sim.aeroFy || 0) / m;
  const Tx = ax * m;
  let Ty = ay * m;
  // high up, it may flip and burn downward (low gravity will not help us);
  // near the ground the engine always points at the ground
  const high = o.pass && alt > 150 && com.y - o.ty > 50 && v.vy > 4 && ay < 0 && tn.solid <= 0;
  if (high) { ay = Math.max(ay, -Math.max(2, g)); Ty = ay * m; }
  if (!high && Ty < m * g * 0.06) { Ty = m * g * 0.06; }
  // well clear of the ground a cruise may lean nearly flat (thick air lifts)
  const lean = !landingRun && alt > 60 && (o.pass || Math.abs(dx) > 150) ? 1.45 : TILT_MAX;
  let tmax = high ? 2.6 : lean;
  // vertical first: never lean so far that the engine can't hold what it must
  let vertCap = Infinity;
  if (!high && tn.T > 0) { vertCap = Math.acos(clamp(Ty / tn.T, 0, 1)) + 0.05; tmax = Math.min(tmax, vertCap); }
  const free = Math.atan2(Tx, Ty);
  let tilt = clamp(free, -tmax, tmax);
  if (landingRun && alt < 7) { tilt = clamp(tilt, -0.05, 0.05); }
  let throttle = tn.T > 0 ? Math.hypot(Tx, Ty) / tn.T : 0;
  // the lean limit (not the vertical budget) is what bites: at full throttle
  // the steep lean would lift us, so burn only what the vertical wants
  if (!high && tn.T > 0 && Math.abs(free) > lean && vertCap > lean) {
    // floor: half our weight, less whatever the air is already holding up
    const floor = Math.max(0, m * g * 0.5 - Math.max(0, sim.aeroFy || 0));
    throttle = Math.min(throttle, Math.max(Ty, floor) / (Math.cos(tilt) * tn.T));
  }
  if (alt < 12 && !landingRun) {
    // just off the ground the lean is held small, so the sideways part of
    // the ask can't be delivered: burn only for what the vertical needs
    tilt = clamp(tilt, -0.2, 0.2);
    if (tn.T > 0) { throttle = Math.min(throttle, Math.max(Ty, m * g * 1.3) / (Math.cos(tilt) * tn.T)); }
  }
  const s = steer(sim, v, tilt);
  // don't blast while pointing the wrong way — except in the final flare,
  // where a crooked burn still mostly lifts and cutting it is a crash
  if (!(landingRun && alt < 45)) {
    // only the share of thrust that points where we want is worth burning
    const aim = Math.cos(s.err);
    throttle *= clamp((aim - 0.55) / 0.4, 0, 1);
  }
  // an engine that will not throttle that low: pulse rather than overdo it
  if (tn.liquid > 0 && throttle > 0 && tn.Tmin > 0 && tn.solid <= 0) {
    if (throttle < (tn.Tmin / tn.T) * 0.55) { throttle = 0; }
  }
  out.rot = s.rot;
  out.throttle = clamp(throttle, 0, 1);
  return out;
}

