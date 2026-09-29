/* Daily Rocket — deterministic daily generation.
 *
 * Everything a player sees today derives from the UTC day index: the world
 * and its weather, the contract, the terrain, the target, the parts in the
 * shed. A candidate day gets a reference rocket from the design office and
 * the autopilot test-flies it; if the flight fails, the design gets more
 * margin, and then the whole day gets gentler, so a published daily is
 * machine-verified flyable. That flight is the par: its time sets the
 * schedule, its costs set the fee, its ledger is the number to beat.
 */

import { rng, hash32 } from "./daily.js";
import { WORLDS } from "./world.js";
import { buildTerrain } from "./terrain.js";
import { PARTS, PART_ORDER, partCounts, hardwareCost, REFUND } from "./parts.js";
import { createSim, step, settleDebris, MAX_T } from "./physics.js";
import { createBot, botInput } from "./bot.js";
import { catalogue, pick, STYLES, FUEL_PRICE } from "./designer.js";
import { ledger } from "./score.js";

export const RULES = "3.0.0";
export const PAR_SKILL = 0.85;

const WORLD_WEIGHTS = [["terra", 3], ["rust", 2.4], ["selene", 2.4], ["mistral", 1.8]];
const TYPE_WEIGHTS = {
  terra: [["hop", 2], ["mesa", 1.4], ["canyon", 1.3], ["barge", 1.6], ["sounding", 1.3], ["gates", 1.2], ["rescue", 1.2]],
  rust: [["hop", 2], ["mesa", 1.6], ["canyon", 1.6], ["sounding", 1.2], ["gates", 1.2], ["rescue", 1.3]],
  selene: [["hop", 2], ["mesa", 1.5], ["canyon", 1.8], ["sounding", 1], ["rescue", 1.6]],
  mistral: [["hop", 2], ["mesa", 1.2], ["canyon", 1], ["barge", 1.4], ["sounding", 0.8], ["gates", 1.3], ["rescue", 1]]
};
const RANGE = { terra: [1600, 4000], rust: [1400, 3400], selene: [1000, 2500], mistral: [700, 1500] };
const RELIEF = { terra: [40, 100], rust: [60, 150], selene: [50, 130], mistral: [30, 80] };
const RIBBON = { terra: [2400, 5000], rust: [1500, 3000], selene: [700, 1400], mistral: [700, 1400] };
const LOFT = { terra: 0.25, rust: 0.22, selene: 0.16, mistral: 0.3 };

const NAMES = {
  hop: ["Outpost Run", "Supply Hop", "Relay Drop", "Courier Hop", "Short Haul", "Milk Run"],
  mesa: ["Mesa Drop", "Tabletop", "High Shelf", "Butte Delivery"],
  canyon: ["Canyon Courier", "Into the Rift", "Slot Drop", "Deep Delivery"],
  barge: ["Barge Catch", "Deck Landing", "Sea Drop", "Moving Target"],
  sounding: ["Sounding Flight", "Sky Sample", "Ceiling Run", "Up and Back"],
  gates: ["Survey Line", "Slalom", "Ring Run", "Ring Road"],
  rescue: ["Rescue Run", "Round Trip", "Pickup", "Bring Them Home"]
};
const OUTPOSTS = ["Outpost Kilo", "Camp Bravo", "Station Juniper", "Relay Nine", "Depot Ember",
  "Camp Hollis", "Station Vega", "Outpost Marrow", "Camp Tamsin", "Depot Larch", "Base Oriel"];
const CARGO = {
  probe: ["a seismometer", "a weather station", "ice-core samples", "a survey probe", "a radio relay"],
  cargo: ["spare parts", "medical supplies", "a greenhouse kit", "seed stock", "a water recycler", "the mail"],
  crew: ["two surveyors", "a relief crew", "the station doctor", "a very nervous inspector"],
  freight: ["a drilling rig", "a pallet of reactor shielding", "a pressurised greenhouse", "a crated rover"]
};
const PICKUPS = [
  ["two stranded surveyors", 180], ["a crate of core samples", 140], ["the broken rover's brain", 110],
  ["an injured geologist and her kit", 160], ["a year of weather logs, on paper", 90], ["a failed reactor module", 220]
];

/* The day's twist: a rule change that moves where the best answer lives.
 * Each one pushes a different lever of the ledger or the build. */
export const TWISTS = {
  fuel: { name: "Fuel shortage", text: "Propellant costs three times the usual. Every kilo burned hurts.", econ: { fuel: 3 } },
  rush: { name: "Rush order", text: "The schedule bonus is tripled and the deadline is tight. Fly fast.", econ: { schedule: 3 }, rush: true },
  precise: { name: "Precision contract", text: "Half-size pad, double pay for hitting its centre.", econ: { precision: 2 }, padK: 0.55 },
  reuse: { name: "Reusability grant", text: "Anything that lands intact refunds 95% of its hardware.", econ: { refund: 0.95 } },
  expend: { name: "Expendable only", text: "No refurbishment today: nothing you land is refunded. Build cheap.", econ: { refund: 0 } },
  budget: { name: "Tight budget", text: "Hardware budget capped at {v}.", limit: "budget" },
  ceiling: { name: "Low hangar", text: "The assembly hall is only {v} tall. Build wide, not tall.", limit: "height" },
  padmass: { name: "Light pad", text: "The launch pad is rated for {v}. Lean designs only.", limit: "mass" },
  nolegs: { name: "No legs", text: "The shed is out of landing legs. Touch down on the bell: 2 m/s, dead level.", ban: ["legs"] },
  nofins: { name: "Fin recall", text: "Every fin is recalled for inspection. Fly it on gimbals and gyros.", ban: ["fins", "finsL"], air: true },
  gale: { name: "Gale warning", text: "Strong winds and savage gusts all day.", air: true, gale: true },
  freight: { name: "Heavy freight", text: "The customer is shipping 1.1 tonnes today.", payload: "freight", not: ["sounding"] },
  supplier: { name: "Single supplier", text: "Only one engine model in the shed.", shed: "supplier" },
  scarce: { name: "Bare shelves", text: "The shed holds barely more than one rocket's worth of parts.", shed: "scarce" }
};
const TWIST_WEIGHTS = [["fuel", 1.2], ["rush", 1.2], ["precise", 1.1], ["reuse", 0.9], ["expend", 0.8],
  ["budget", 1], ["ceiling", 1], ["padmass", 0.9], ["nolegs", 0.7], ["nofins", 0.6], ["gale", 0.8],
  ["freight", 0.9], ["supplier", 0.8], ["scarce", 0.7]];

function weighted(r, table) {
  let tot = 0;
  for (const [, w] of table) { tot += w; }
  let x = r() * tot;
  for (const [k, w] of table) { x -= w; if (x <= 0) { return k; } }
  return table[table.length - 1][0];
}

const km = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m");
const money = (n) => "$" + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function rollTwists(r, variant, wid, type) {
  if (variant >= 3) { return []; }
  const roll = r();
  const n = roll < 0.16 ? 0 : roll < 0.84 || variant >= 2 ? 1 : 2;
  const out = [];
  const air = wid !== "selene";
  for (let tries = 0; out.length < n && tries < 12; tries++) {
    const id = weighted(r, TWIST_WEIGHTS);
    const t = TWISTS[id];
    if (out.includes(id)) { continue; }
    if (t.air && !air) { continue; }
    if (t.not && t.not.includes(type)) { continue; }
    // two twists must pull on different levers
    if (out.some((o) => (TWISTS[o].econ && t.econ) || (TWISTS[o].limit && t.limit) || (TWISTS[o].shed && t.shed))) { continue; }
    out.push(id);
  }
  return out;
}

// -------------------------------------------------------------- candidate

export function candidate(index, variant) {
  const seed = hash32(Math.imul(index, 2654435761) + 7777 + variant * 7919);
  const r = rng(seed);
  const soft = 1 - variant * 0.16;

  const wid = weighted(r, WORLD_WEIGHTS);
  const wd = WORLDS[wid];
  const type = weighted(r, TYPE_WEIGHTS[wid]);
  const twists = rollTwists(r, variant, wid, type);
  const has = (id) => twists.includes(id);
  const gale = has("gale") ? 1 : 0;

  const world = {
    id: wid, name: wd.name, atmo: wd.atmo, pal: wd.pal, p0: wd.p0,
    g: +r.range(wd.g[0], wd.g[1]).toFixed(2),
    rho0: +r.range(wd.rho0[0], wd.rho0[1]).toFixed(3),
    scaleH: Math.round(r.range(wd.scaleH[0], wd.scaleH[1])),
    wind: +(r.range(wd.wind[0], wd.wind[1]) * soft * (gale ? 1.7 : 1) + gale * 3).toFixed(1),
    windDir: r.chance(0.5) ? -1 : 1,
    gust: +(r.range(wd.gust[0], wd.gust[1]) * soft * (gale ? 2.6 : 1) + gale * 2).toFixed(1)
  };

  let payId = type === "sounding" ? (r.chance(0.7) ? "probe" : "cargo")
    : weighted(r, [["probe", 4], ["cargo", 4], ["crew", 2]]);
  if (has("freight")) { payId = "freight"; }
  if (type === "rescue" && payId === "probe") { payId = "crew"; }
  const flavour = r.pick(CARGO[payId]);
  const outpost = r.pick(OUTPOSTS);

  const rangeK = type === "rescue" ? 0.55 : 1;
  const D = Math.round((r.range(RANGE[wid][0], RANGE[wid][1]) * rangeK * (1 - variant * 0.12)) / 50) * 50;
  const padHalf = Math.max(7, Math.round((r.range(11, 21) + variant * 4) * (has("precise") ? TWISTS.precise.padK : 1)));
  const relief = r.range(RELIEF[wid][0], RELIEF[wid][1]) * soft;

  // ---- terrain features for the job
  const opts = { relief, extentL: -900, extentR: D + 1600, ridges: [], shelves: [] };
  let targetX = D;
  let mesa = null, canyon = null, coast = null, barge = null, ribbon = null, gates = null;

  if (type !== "barge" && type !== "sounding" && r.chance(type === "gates" ? 0.8 : 0.5)) {
    opts.ridges.push({
      x: D * r.range(0.38, 0.62), w: Math.max(130, D * r.range(0.06, 0.11)),
      h: r.range(140, 380) * soft * (wid === "selene" ? 1.2 : 1) * (type === "rescue" ? 0.7 : 1)
    });
  }
  if (type === "hop" && r.chance(0.35)) {
    opts.ridges.push({ x: D * r.range(0.15, 0.3), w: Math.max(90, D * 0.05), h: r.range(60, 160) * soft });
  }
  const shelf = type === "rescue" ? weighted(r, [["plain", 2], ["mesa", 1], ["canyon", 1]]) : type;
  const rk = type === "rescue" ? 0.7 : 1;
  if (shelf === "mesa") {
    mesa = { x: D, half: padHalf + r.range(25, 55), h: r.range(110, 260) * soft * rk, edge: r.range(25, 45) };
    opts.mesa = mesa;
  } else if (shelf === "canyon") {
    canyon = { x: D, half: padHalf + r.range(10, 26) + variant * 6, depth: r.range(110, 250) * soft * rk, wall: r.range(18, 32) };
    opts.canyon = canyon;
  } else if (type === "barge") {
    coast = { x: D - r.range(450, 850), depth: 40 };
    opts.coast = coast;
    opts.extentR = D + 1800;
  } else if (type === "sounding") {
    targetX = Math.round(r.range(250, 550) / 10) * 10;
    opts.extentR = 2600;
    opts.extentL = -2200;
    ribbon = { h: Math.round((r.range(RIBBON[wid][0], RIBBON[wid][1]) * soft) / 100) * 100 };
  }

  opts.shelves.push({ x: 0, half: 55, blend: 130 });
  if (canyon) {
    opts.shelves.push({ x: targetX, half: Math.min(padHalf + 6, canyon.half - 2), blend: 1 });
  } else if (mesa) {
    opts.shelves.push({ x: targetX, half: padHalf + 8, blend: 14 });
  } else if (type !== "barge") {
    opts.shelves.push({ x: targetX, half: padHalf + 12, blend: 110 });
  }

  const terrain = buildTerrain(r, seed, opts);
  const launch = { x: 0, y: terrain.shelves[0].y };

  let target;
  if (type === "barge") {
    const deck = terrain.seaLevel + 2.4;
    // the barge drifts on the swell: a slow sway, never faster than a legged
    // touchdown can forgive
    const period = Math.round(r.range(24, 40));
    const vmax = r.range(1.2, 3.2) * soft;
    barge = {
      x0: D, amp: Math.round((vmax * period) / (Math.PI * 2)), period,
      half: Math.max(9, Math.round((r.range(13, 18) + variant * 3) * (has("precise") ? 0.7 : 1))), deck
    };
    target = { x: D, y: deck, half: barge.half };
  } else {
    target = { x: targetX, y: terrain.shelves[1].y, half: padHalf };
  }

  let rim = null;
  if (canyon) {
    rim = Math.max(terrain.heightAt(targetX - canyon.half - canyon.wall - 5),
      terrain.heightAt(targetX + canyon.half + canyon.wall + 5));
  }
  const approach = { x: target.x, y: Math.max(target.y, rim == null ? -Infinity : rim) + 90, rim };
  const between = terrain.maxBetween(launch.x + 80, target.x - Math.sign(target.x) * (target.half + 60));
  const legs = [{ target, approach, clearY: Math.max(between + 110, approach.y + 20) }];

  let pickup = null;
  if (type === "rescue") {
    pickup = r.pick(PICKUPS);
    legs[0].pickup = pickup[1];
    legs[0].pickupText = pickup[0];
    const home = { x: 0, y: launch.y, half: Math.max(8, Math.round(padHalf * 1.1)) };
    const hApp = { x: 0, y: launch.y + 90, rim: null };
    legs.push({
      target: home, approach: hApp,
      clearY: Math.max(between + 110, hApp.y + 20, (rim == null ? -Infinity : rim) + 110)
    });
  }

  if (type === "gates") {
    gates = [];
    const fr = [0.24, 0.5, 0.76];
    for (let i = 0; i < 3; i++) {
      const gx = Math.round(D * (fr[i] + r.range(-0.05, 0.05)));
      const ground = terrain.maxBetween(gx - 120, gx + 120);
      gates.push({ x: gx, y: Math.round(ground + r.range(80, 200)), half: Math.round(r.range(24, 34) + variant * 5) });
    }
  }

  if (ribbon) {
    ribbon.y = launch.y + ribbon.h;
    ribbon.label = km(ribbon.h) + " line";
  }

  // ---- words
  const name = r.pick(NAMES[type]);
  const where = type === "sounding" ? "" : km(Math.abs(target.x));
  const place = mesa ? ", on top of a " + Math.round(mesa.h) + " m mesa"
    : canyon ? ", at the bottom of a " + Math.round(canyon.depth) + " m canyon" : "";
  const briefs = {
    hop: "Deliver " + flavour + " to " + outpost + ", " + where + " downrange.",
    mesa: "Deliver " + flavour + " to " + outpost + place + ", " + where + " out.",
    canyon: "Deliver " + flavour + " to the camp" + place + ", " + where + " out.",
    barge: "Deliver " + flavour + " to the recovery barge " + where + " offshore. It will not hold still.",
    sounding: "Carry " + flavour + " above the " + (ribbon ? ribbon.label : "") + ", then bring it home to the pad.",
    gates: "Fly through the three survey rings, then deliver " + flavour + " to " + outpost + ", " + where + " out.",
    rescue: "Fly " + flavour + " out to " + outpost + place + " (" + where + " out), land, pick up " +
      (pickup ? pickup[0] + " (+" + pickup[1] + " kg)" : "") + ", and bring everyone home to the launch pad."
  };

  // parts the shed is short of today (plus whatever the twist takes away)
  const banned = {};
  if (r.chance(0.16)) { banned.nose = true; }
  if (r.chance(0.18)) { banned.pip = true; }
  if (r.chance(0.12)) { banned.heron = true; }
  if (r.chance(0.12)) { banned.finsL = true; }
  for (const id of twists) { for (const b of TWISTS[id].ban || []) { banned[b] = true; } }

  const econ = { fuel: 1, precision: 1, schedule: 1, refund: null };
  for (const id of twists) {
    const e = TWISTS[id].econ || {};
    for (const k in e) { econ[k] = e[k]; }
  }

  return {
    index, number: index + 1, seed, variant, rules: RULES,
    world,
    mission: { type, name, brief: briefs[type], outpost, flavour },
    payload: PARTS[payId],
    terrain, launch, legs, target: legs[legs.length - 1].target, loft: LOFT[wid],
    mesa, canyon, coast, barge, ribbon, gates,
    banned, twistIds: twists, econ, limits: {},
    gustSeed: hash32(seed ^ 0x5bf03635)
  };
}

// --------------------------------------------------------------- flights

export function flyBuild(day, build, skill, maxT) {
  const sim = createSim(day, build);
  const bot = createBot(skill);
  const limit = Math.round((maxT || MAX_T) * 120) + 2;
  for (let i = 0; i < limit && !sim.done; i++) { step(sim, botInput(sim, bot)); }
  if (!sim.done) { sim.outcome = "timeout"; sim.done = true; }
  if (sim.success) { settleDebris(sim); }
  return sim;
}

function roundTo(v, k) { return Math.round(v / k) * k; }

// ------------------------------------------------------------------- day

const cache = new Map();

/* Twists that cap the build are set from what the day actually allows: a
 * little above the leanest rocket that could do the job. */
function setLimits(day, cat) {
  const need = cat.need * STYLES.director.margin;
  const ok = cat.list.filter((c) => c.ev.dv >= need && c.ev.twr0 >= STYLES.director.twr &&
    c.ev.landTWR >= STYLES.director.landTWR);
  if (!ok.length) { return; }
  for (const id of day.twistIds) {
    const t = TWISTS[id];
    if (t.limit === "budget") {
      const lo = Math.min(...ok.map((c) => c.ev.hw));
      day.limits.budget = Math.round((lo * 1.12 + 1500) / 500) * 500;
    } else if (t.limit === "height") {
      const lo = Math.min(...ok.map((c) => c.ev.A.height));
      day.limits.height = Math.ceil((lo + 0.9) * 2) / 2;
    } else if (t.limit === "mass") {
      const lo = Math.min(...ok.map((c) => c.ev.stages[0].m0));
      day.limits.mass = Math.round((lo * 1.08 + 60) / 50) * 50;
    }
  }
}

function twistText(day) {
  return day.twistIds.map((id) => {
    const t = TWISTS[id];
    let v = "";
    if (t.limit === "budget") { v = money(day.limits.budget); }
    if (t.limit === "height") { v = day.limits.height.toFixed(1) + " m"; }
    if (t.limit === "mass") { v = String(day.limits.mass).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " kg"; }
    return { id, name: t.name, text: t.text.replace("{v}", v) };
  });
}

export function generateDay(index, fresh) {
  if (!fresh && cache.has(index)) { return cache.get(index); }
  let day = null, parSim = null, ref = null, cat = null;
  outer:
  for (let v = 0; v < 4; v++) {
    day = candidate(index, v);
    cat = catalogue(day);
    setLimits(day, cat);
    for (const mm of [1, 1.3, 1.7]) {
      ref = pick(day, cat, STYLES.director, mm);
      if (!ref) { continue; }
      if (day.twistIds.includes("supplier")) { lockEngines(day, ref); }
      parSim = flyBuild(day, ref, PAR_SKILL);
      if (parSim.success) { break outer; }
    }
  }

  // economics from the par flight
  const hw = hardwareCost(ref || { stack: [] });
  const t = parSim ? parSim.t : 120;
  day.deadline = day.twistIds.includes("rush")
    ? Math.max(25, Math.round((t * 1.3 + 4) / 5) * 5)
    : Math.max(30, Math.round((t * 1.8 + 8) / 5) * 5);
  // the fee covers a sensible flight and leaves a margin worth fighting over
  const refundK = day.econ.refund != null ? day.econ.refund : REFUND;
  const parCost = hw * (1 - refundK * 0.8) + (parSim ? parSim.liquidBurned : 0) * FUEL_PRICE * day.econ.fuel;
  day.fee = Math.max(30000, roundTo(20000 + parCost * 1.4, 5000));
  day.refBuild = ref;
  day.par = parSim ? ledger(parSim, day, day.fee, day.deadline) : { ok: false, total: 0, lines: [], stats: {} };
  day.par.ok = !!(parSim && parSim.success);
  day.par.outcome = parSim ? parSim.outcome : "none";
  day.twists = twistText(day);

  // the newcomer's rocket and the rivals' designs; the shed stocks them all
  const scarce = day.twistIds.includes("scarce");
  if (scarce) {
    day.inventory = stockShed(day, [ref], true);
    day.starter = ref;
  } else {
    day.starter = pick(day, cat, STYLES.starter) || ref;
  }
  const inv = scarce ? day.inventory : null;
  day.rivalBuilds = {
    brute: pick(day, cat, STYLES.brute, 1, inv) || day.starter,
    thrift: pick(day, cat, STYLES.thrift, 1, inv) || ref,
    lofty: pick(day, cat, STYLES.lofty, 1, inv) || ref
  };
  if (!scarce) {
    day.inventory = stockShed(day, [ref, day.starter, day.rivalBuilds.brute, day.rivalBuilds.thrift, day.rivalBuilds.lofty]);
  }
  if (!fresh) { cache.set(index, day); }
  return day;
}

/* Single supplier: whatever engine the reference flies is the only one in
 * the shed, so ban the rest before anyone else designs. */
function lockEngines(day, ref) {
  const keep = new Set(ref.stack.map((e) => e.p).filter((id) => PARTS[id].kind === "engine"));
  for (const id of ["pip", "hornet", "heron", "ox"]) { if (!keep.has(id)) { day.banned[id] = true; } }
  day.banned.pod = true;
}

function stockShed(day, builds, scarce) {
  const inv = {};
  for (const b of builds) {
    if (!b) { continue; }
    const n = partCounts(b);
    for (const k in n) { inv[k] = Math.max(inv[k] || 0, n[k]); }
  }
  const r = rng(hash32(day.seed ^ 0x2545f491));
  if (scarce) {
    // one spare tank of whatever size is in use, nothing else
    const t = ["tankS", "tankM", "tankL"].filter((k) => inv[k]);
    if (t.length) { const k = r.pick(t); inv[k]++; }
    return inv;
  }
  // a little slack on the basics, and a few curiosities
  for (const k of ["tankS", "tankM", "decoupler"]) {
    if (!day.banned[k]) { inv[k] = (inv[k] || 0) + r.int(1, 2); }
  }
  for (const k of PART_ORDER) {
    if (day.banned[k] || inv[k]) { continue; }
    if (r.chance(0.45)) { inv[k] = r.int(1, 2); }
  }
  if (day.world.rho0 <= 0.05) { delete inv.chute; delete inv.nose; }
  return inv;
}

// --------------------------------------------------------------- rivals

export const RIVALS = [
  { id: "brute", name: "Brute Force Aerospace", skill: 0.72, blurb: "Bigger is safer." },
  { id: "lofty", name: "Lofty & Daughters", skill: 0.84, blurb: "Brings everything home." },
  { id: "thrift", name: "Thrift Launch Co.", skill: 0.97, blurb: "Not one kilo more than needed." }
];

/* Today's board: the par and three rival companies, all flown by the same
 * deterministic autopilot. Computed on demand (it is a few extra flights). */
export function board(day) {
  if (day.board) { return day.board; }
  const rows = [{ id: "par", name: "Flight Director (par)", total: day.par.total, ok: day.par.ok, build: day.refBuild }];
  for (const rv of RIVALS) {
    const b = day.rivalBuilds[rv.id];
    const sim = flyBuild(day, b, rv.skill);
    const L = ledger(sim, day);
    rows.push({ id: rv.id, name: rv.name, total: L.total, ok: L.ok, build: b, outcome: sim.outcome, blurb: rv.blurb });
  }
  day.board = rows;
  return rows;
}
