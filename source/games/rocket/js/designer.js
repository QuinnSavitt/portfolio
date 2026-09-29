/* Daily Rocket — the design office.
 *
 * Builds sensible rockets for a day from the catalog: the Flight Director's
 * reference (whose flight is the par), the sturdy starter a newcomer gets
 * handed, and the rival companies' takes. One deterministic enumeration over
 * a small design space is shared by every style; the generator then
 * test-flies the result, so these only need to be plausible, not optimal.
 * Leaving room above them is the point of the game.
 */

import {
  PARTS, stageStats, massProps, aeroTerms, centreOfPressure, hardwareCost, fullFlow, exhaustV, partCounts
} from "./parts.js";
import { airAt } from "./world.js";

const TANK_SETS = [
  ["tankS"], ["tankM"], ["tankS", "tankM"], ["tankM", "tankM"], ["tankS", "tankM", "tankM"],
  ["tankM", "tankM", "tankM"], ["tankL"], ["tankM", "tankM", "tankM", "tankM"], ["tankM", "tankL"],
  ["tankM", "tankM", "tankL"], ["tankL", "tankL"], ["tankM", "tankL", "tankL"], ["tankL", "tankL", "tankL"]
];
const BOOSTERS = ["none", "fleaR", "hammerR",
  ["hornet", ["tankM"]], ["hornet", ["tankL"]], ["hornet", ["tankM", "tankM"]],
  ["ox", ["tankL"]], ["ox", ["tankL", "tankL"]], ["hammer", []], ["flea", []]];

export const FUEL_PRICE = 30;

/* Rough Δv a mission asks of a sensible flight. The audition decides for
 * real; this only sizes the first guess. */
export function requiredDv(day) {
  const w = day.world, g = w.g, type = day.mission.type;
  const air = w.rho0;
  const dragK = air > 3 ? 0.55 : air > 0.5 ? 0.22 : air > 0.05 ? 0.05 : 0;
  if (type === "sounding") {
    const h = day.ribbon.y - day.launch.y;
    const v = Math.sqrt(2 * g * h);
    const vTerm = air > 0.05 ? Math.min(v, 140 / Math.sqrt(air)) : v;
    return v * (1.3 + dragK * 0.8) + vTerm * 1.35 + 90;
  }
  let total = 0, from = day.launch;
  for (const leg of day.legs) {
    const D = Math.abs(leg.approach.x - from.x);
    if (type === "gates") {
      const t = D / 45 + 25;
      total += g * t * 0.8 + 320 + dragK * 260;
    } else {
      const up = Math.max(0, leg.clearY - from.y);
      const ya = Math.max(up, D * day.loft);
      const vy = Math.sqrt(2 * g * ya);
      const tf = vy / g + Math.sqrt((2 * Math.max(10, ya - (leg.approach.y - from.y))) / g);
      const v = Math.hypot(D / tf, vy);
      // a heavier ride home costs proportionally more
      const heavier = leg === day.legs[day.legs.length - 1] && day.legs.length > 1 ? 1.25 : 1;
      total += (v * (2.5 + dragK * 1.6) + 110 + (air > 3 ? 180 : 0)) * heavier;
    }
    from = leg.target;
  }
  return total;
}

function evaluate(build, day) {
  const w = day.world;
  const S = stageStats(build, w.g, airAt(w, day.launch.y).p);
  const stages = S.stages;
  let dv = 0;
  for (const s of stages) { dv += s.dv; }
  const top = stages[stages.length - 1];
  const A = S.assembly;
  let mDry = top.liquidProp * 0.25;
  for (const p of A.parts) { if (p.seg === A.segCount - 1) { mDry += p.dry; } }
  // the lander works in the air at the pad, not in vacuum; and can it hover
  // at minimum throttle? (a Hornet on a probe cannot)
  const pLand = airAt(w, day.legs[day.legs.length - 1].target.y).p;
  let tMin = 0, tLand = 0;
  for (const p of A.parts) {
    if (p.seg === A.segCount - 1 && (p.kind === "engine" || p.kind === "pod") && !p.blocked) {
      const t = fullFlow(p.def) * exhaustV(p.def, pLand);
      tLand += t;
      tMin += t * p.def.minThr;
    }
  }
  const ev = {
    dv, twr0: stages[0].twr, landTWR: tLand / (mDry * w.g), stages,
    hover: tMin < mDry * w.g * 0.9,
    stable: true, prop: 0, hw: hardwareCost(build), A
  };
  for (const s of stages) { ev.prop += s.liquidProp; }
  ev.cost = ev.hw + ev.prop * FUEL_PRICE * 0.7;
  ev.deadStage = stages.some((s, i) => i < stages.length - 1 && s.engines === 0);
  return ev;
}

function isStable(day, ev) {
  // thin air barely pushes; with the fins recalled, gimbals will have to do
  if (day.world.rho0 < 0.5 || day.banned.fins) { return true; }
  const mp = massProps(ev.A.parts);
  const cp = centreOfPressure(aeroTerms(ev.A.parts, false));
  return cp != null && cp < mp.s - 0.1;
}

/* lander = [nose?] payload tanks... engine (legs on the engine) */
function lander(day, engine, tanks, fins, chutes) {
  const air = day.world.rho0 > 0.05;
  const st = [];
  if (air && !day.banned.nose) { st.push({ p: "nose" }); }
  const pay = { p: day.payload.id };
  if (chutes) { pay.r = "chute"; }
  st.push(pay);
  tanks.forEach((t, i) => {
    const e = { p: t };
    if (i === tanks.length - 1 && fins) { e.r = fins; }
    st.push(e);
  });
  st.push(day.banned.legs ? { p: engine } : { p: engine, r: "legs" });
  return st;
}

function withBooster(top, bk, fins) {
  if (bk === "none") { return top; }
  if (typeof bk === "string") {
    const stack = top.map((x) => ({ ...x }));
    let ti = -1;
    for (let i = stack.length - 1; i >= 0; i--) { if (PARTS[stack[i].p].kind === "tank") { ti = i; break; } }
    if (ti < 0) { return null; }
    if (stack[ti].r) {
      let ti2 = -1;
      for (let i = ti - 1; i >= 0; i--) { if (PARTS[stack[i].p].kind === "tank") { ti2 = i; break; } }
      if (ti2 < 0) { return null; }
      stack[ti2].r = stack[ti].r;
    }
    stack[ti].r = bk;
    return stack;
  }
  const [eng, tanks] = bk;
  const st = top.concat([{ p: "decoupler" }]);
  tanks.forEach((t, i) => {
    const e = { p: t };
    if (i === tanks.length - 1 && fins) { e.r = fins; }
    st.push(e);
  });
  const last = { p: eng };
  if (!tanks.length && fins) { last.r = fins; }
  st.push(last);
  return st;
}

const usesBanned = (day, build) => build.stack.some((e) => day.banned[e.p] || (e.r && day.banned[e.r]));

/* Every plausible rocket for the day, evaluated once. */
export { evaluate };

export function catalogue(day) {
  const w = day.world;
  const air = w.rho0 > 0.05;
  const finsOpts = air ? [null, "fins", "finsL"].filter((f) => !f || !day.banned[f]) : [null];
  const chuteOpts = w.rho0 > 2 ? [false, true] : [false];
  const list = [];
  for (const e of ["pip", "hornet", "heron"]) {
    for (const tanks of TANK_SETS) {
      for (const fins of finsOpts) {
        for (const chutes of chuteOpts) {
          for (const bk of BOOSTERS) {
            const stack = withBooster(lander(day, e, tanks, fins, chutes), bk, fins);
            if (!stack) { continue; }
            const build = { stack };
            if (usesBanned(day, build)) { continue; }
            const ev = evaluate(build, day);
            if (ev.deadStage || !ev.hover || ev.twr0 < 1.25 || ev.landTWR < 1.8) { continue; }
            list.push({ build, ev, engine: e, bk });
          }
        }
      }
    }
  }
  list.sort((a, b) => a.ev.cost - b.ev.cost);
  return { list, need: requiredDv(day) };
}

export const STYLES = {
  // the Flight Director: sensible margins, flies the par
  director: { margin: 1.25, twr: 1.45, landTWR: 2.2 },
  // what a newcomer is handed: sturdy, forgiving, pricey
  starter: { margin: 1.5, twr: 1.5, landTWR: 2.4, prefer: "dv", costCap: 1.3 },
  // rivals
  brute: { margin: 1.8, twr: 1.8, landTWR: 2.6, prefer: "dv", costCap: 1.8 },
  thrift: { margin: 1.06, twr: 1.3, landTWR: 2.0, recover: true },
  lofty: { margin: 1.4, twr: 1.4, landTWR: 2.3, recover: true, gyro: true }
};

/* Does a build break any of today's rules? Returns plain-English problems. */
export function violations(day, build, ev) {
  const out = [];
  const L = day.limits || {};
  if (!ev && (L.budget || L.height || L.mass)) { ev = evaluate(build, day); }
  if (L.budget && ev.hw > L.budget) { out.push("Over the hardware budget"); }
  if (L.height && ev.A.height > L.height + 1e-6) { out.push("Too tall for the hangar"); }
  if (L.mass && ev.stages[0].m0 > L.mass) { out.push("Too heavy for the pad"); }
  return out;
}

function fits(build, inv) {
  if (!inv) { return true; }
  const n = partCounts(build);
  for (const k in n) { if ((inv[k] || 0) < n[k]) { return false; } }
  return true;
}

/* Cheapest catalogue entry that satisfies a style, with its habits applied. */
export function pick(day, cat, style, marginMul, inv) {
  const need = cat.need * style.margin * (marginMul || 1);
  if (style.prefer === "dv") {
    // the most Δv money can buy within a ceiling over the cheapest option
    const ok = [];
    for (const c of cat.list) {
      const b = pickOne(day, c, style, need, inv);
      if (b) { ok.push({ c, b }); }
    }
    if (!ok.length) { return null; }
    const cap = ok[0].c.ev.cost * style.costCap;
    let best = ok[0];
    for (const o of ok) { if (o.c.ev.cost <= cap && o.c.ev.dv > best.c.ev.dv) { best = o; } }
    return best.b;
  }
  for (const c of cat.list) {
    const b = pickOne(day, c, style, need, inv);
    if (b) { return b; }
  }
  return null;
}

function pickOne(day, c, style, need, inv) {
  const ev = c.ev;
  if (usesBanned(day, c.build)) { return null; }
  if (violations(day, c.build, ev).length) { return null; }
  if (ev.dv < need || ev.twr0 < style.twr || ev.landTWR < style.landTWR) { return null; }
  // solids cannot be throttled: more kick than the climb needs is an overshoot
  const solidCap = { sounding: 0.6, gates: 0.12 }[day.mission.type] || 0.4;
  if (ev.stages[0].dvSolid > (need / style.margin) * solidCap) { return null; }
  if (!c.checked) { c.checked = true; c.stableOk = isStable(day, ev); }
  if (!c.stableOk) { return null; }
  const b = applyHabits(day, c.build, style);
  if (!fits(b, inv) || violations(day, b).length) { return fits(c.build, inv) ? c.build : null; }
  return b;
}

function applyHabits(day, build, style) {
  const stack = build.stack.map((e) => ({ ...e }));
  if (style.recover && day.world.rho0 > 0.05 && !day.banned.chute) {
    const di = stack.findIndex((e) => e.p === "decoupler");
    if (di >= 0 && !stack[di].r) { stack[di].r = "chute"; }
  }
  if (style.gyro && !day.banned.gyro) {
    const pi = stack.findIndex((e) => PARTS[e.p].kind === "payload");
    stack.splice(pi + 1, 0, { p: "gyro" });
  }
  return { stack };
}
