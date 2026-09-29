/* Daily Rocket — the contract ledger, local records, sharing.
 *
 * The score is profit. The customer pays a fee on delivery; you pay for the
 * hardware you fly, the propellant you burn, and get most of the hardware
 * back for anything that lands intact (the rocket itself on the pad, and
 * any stage that parachutes home). Bonuses pay for precision, a soft
 * touchdown, beating the schedule, and threading gates cleanly. Every
 * engineering and piloting decision lands on one line of this ledger.
 */

import { PARTS, REFUND, hardwareCost } from "./parts.js";
import { dayIndex } from "./daily.js";

export const ECON = {
  fuel: 30,         // $ per kg of liquid propellant burned
  precision: 8000,  // dead centre of the pad (steep: the last metre is worth most)
  touchdown: 4000,  // a feather landing, dead level
  schedule: 16000,  // arriving instantly; scales down to nothing at the deadline
  gate: 2500        // per ring, flown through its middle
};

const PREFIX = "qs-rocket-";
const HUB_KEY = "qs-game-rocket-played";
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function partsCost(parts) {
  let c = 0;
  for (const p of parts) { if (p.kind !== "payload") { c += p.def.cost; } }
  return c;
}

/* The full ledger for a finished sim. `fee` and `deadline` come from the
 * day (the generator derives them from the par flight). */
export function ledger(sim, day, fee, deadline) {
  fee = fee != null ? fee : day.fee;
  deadline = deadline != null ? deadline : day.deadline;
  const ec = day.econ || {};
  const refundK = ec.refund != null ? ec.refund : REFUND;
  const fuelPrice = ECON.fuel * (ec.fuel || 1);
  const lines = [];
  const add = (key, label, value, detail) => {
    lines.push({ key, label, value: Math.round(value), detail: detail || "" });
  };
  const ok = !!sim.success;
  const hw = hardwareCost(sim.build);

  if (ok) { add("fee", "Contract fee", fee, day.mission.name); }
  add("hardware", "Hardware", -hw, "every part on the pad");

  let refund = 0, stages = 0;
  for (const d of sim.landed) { refund += partsCost(d.parts) * refundK; stages++; }
  if (ok) { refund += partsCost(sim.main.parts) * refundK; }
  if (refund > 0) {
    add("refund", "Recovered hardware", refund,
      (ok ? "rocket" : "") + (stages ? (ok ? " + " : "") + stages + " stage" + (stages > 1 ? "s" : "") : "") +
      " · " + Math.round(refundK * 100) + "% back");
  }
  add("fuel", "Propellant", -sim.liquidBurned * fuelPrice,
    Math.round(sim.liquidBurned) + " kg burned" + (fuelPrice !== ECON.fuel ? " at $" + fuelPrice + "/kg" : ""));

  let stats = { time: sim.t, fuel: sim.liquidBurned, hardware: hw };
  if (ok) {
    const L = sim.landing;
    const dist = Math.abs(L.distance);
    const half = day.barge ? day.barge.half : day.legs[day.legs.length - 1].target.half;
    add("precision", "Precision", ECON.precision * (ec.precision || 1) * Math.pow(clamp01(1 - dist / half), 2.5),
      dist.toFixed(2) + " m from centre");
    const soft = clamp01(1 - L.speed / L.vLim);
    const level = clamp01(1 - L.tilt / Math.max(0.05, L.tipLimit));
    add("touchdown", "Touchdown", ECON.touchdown * Math.pow(soft, 1.25) * (0.6 + 0.4 * level),
      L.speed.toFixed(2) + " m/s" + (L.tilt > 0.02 ? " · " + (L.tilt * 57.3).toFixed(1) + "°" : ""));
    add("schedule", "Schedule", ECON.schedule * (ec.schedule || 1) * clamp01((deadline - sim.t) / deadline),
      sim.t.toFixed(1) + " s of " + Math.round(deadline));
    if (day.gates) {
      let g = 0;
      for (const x of sim.gates) { if (x) { g += ECON.gate * Math.pow(clamp01(1 - x.err), 1.5); } }
      add("gates", "Gates", g, sim.gates.length + " threaded");
    }
    stats = {
      time: sim.t, fuel: sim.liquidBurned, hardware: hw, distance: dist, impact: L.speed,
      tilt: L.tilt, stagesRecovered: stages
    };
  }
  let total = 0;
  for (const l of lines) { total += l.value; }
  return { ok, total: Math.round(total), lines, stats, outcome: sim.outcome, message: sim.message };
}

/* Stars against the day's par (the Flight Director's own flight). */
export function rating(day, profit, ok) {
  if (!ok) { return { stars: 0, label: "Contract lost", emoji: "\u{1F4A5}" }; }
  const par = day.par.total, fee = day.fee;
  if (profit >= par + fee * 0.07) { return { stars: 4, label: "Ace", emoji: "\u{1F48E}" }; }
  if (profit >= par) { return { stars: 3, label: "Beat the par", emoji: "⭐⭐⭐" }; }
  if (profit >= par - fee * 0.08) { return { stars: 2, label: "Solid", emoji: "⭐⭐" }; }
  return { stars: 1, label: "Delivered", emoji: "⭐" };
}

// ------------------------------------------------------------- storage

function read(key, fallback) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}

function write(key, value) {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) { return false; }
}

const dayKey = (day) => "d" + day.index + "-" + day.rules;

export function loadDay(day) {
  return read(dayKey(day), { attempts: 0, first: null, best: null, ghost: null, build: null });
}

export function saveBuild(day, build) {
  const rec = loadDay(day);
  rec.build = build;
  write(dayKey(day), rec);
}

/* ghost: [x*10, y*10, ang*100] per 0.1 s */
export function compressGhost(samples) {
  const out = [];
  for (const p of samples) { out.push(Math.round(p.x * 10), Math.round(p.y * 10), Math.round(p.a * 100)); }
  return out;
}

export function loadGhost(day) {
  const rec = loadDay(day);
  if (!rec.ghost || rec.ghost.length < 6) { return null; }
  const pts = [];
  for (let i = 0; i + 2 < rec.ghost.length; i += 3) {
    pts.push({ x: rec.ghost[i] / 10, y: rec.ghost[i + 1] / 10, a: rec.ghost[i + 2] / 100 });
  }
  return pts;
}

/* Records what happened; returns what changed so the result screen can
 * shout about it. The blind run is the first attempt, whatever happened —
 * it can never be replaced. */
export function submit(day, result, build, ghostSamples) {
  const rec = loadDay(day);
  rec.attempts = (rec.attempts || 0) + 1;
  rec.build = build;
  const entry = {
    total: result.total, ok: result.ok, stars: rating(day, result.total, result.ok).stars,
    stats: result.stats, build, at: rec.attempts,
    lines: result.lines.map((l) => [l.key, l.value])
  };
  let isFirst = false, isBest = false;
  if (!rec.first) { rec.first = entry; isFirst = true; }
  if (result.ok && (!rec.best || entry.total > rec.best.total)) {
    rec.best = entry;
    isBest = true;
    if (ghostSamples && ghostSamples.length) { rec.ghost = compressGhost(ghostSamples); }
  }
  write(dayKey(day), rec);

  if (day.index === dayIndex()) {
    const s = lifetimeStats();
    if (s.lastDay !== day.index) {
      s.played++;
      s.streak = s.lastDay === day.index - 1 ? (s.streak || 0) + 1 : 1;
      s.lastDay = day.index;
    }
    s.flights = (s.flights || 0) + 1;
    if (result.ok) { s.landed++; } else { s.crashed++; }
    s.recovered = (s.recovered || 0) + (result.stats.stagesRecovered || 0);
    write("stats", s);
    try {
      const now = new Date();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      window.localStorage.setItem(HUB_KEY, now.getFullYear() + "-" + mm + "-" + dd);
    } catch (e) { /* private mode */ }
  }
  return { record: rec, isFirst, isBest };
}

export function lifetimeStats() {
  return read("stats", { played: 0, landed: 0, crashed: 0, streak: 0, lastDay: null, flights: 0, recovered: 0 });
}

// --------------------------------------------------------------- share

export const money = (n) => (n < 0 ? "-$" : "$") + String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/* a tiny rocket silhouette from the build, in emoji-free text */
function silhouette(build) {
  const glyph = { payload: "▲", nose: "", tank: "█", engine: "▼", srb: "┃", decoupler: "═", gyro: "◆" };
  return build.stack.map((e) => glyph[PARTS[e.p].kind] || "").join("");
}

export function shareText(day, result, rec, board) {
  const lines = [];
  const r = rating(day, result.total, result.ok);
  lines.push("Daily Rocket #" + day.number + " \u{1F680} " + day.world.name + " · " + day.mission.name);
  if (result.ok) {
    lines.push("\u{1F4B0} " + money(result.total) + " profit " + r.emoji);
    const s = result.stats;
    lines.push("\u{1F3AF} " + s.distance.toFixed(2) + " m · ⏱ " + s.time.toFixed(1) + " s · ⛽ " +
      Math.round(s.fuel) + " kg" + (s.stagesRecovered ? " · \u{1FA82} stage recovered" : ""));
  } else {
    lines.push("\u{1F4A5} " + money(result.total) + " (contract lost)");
  }
  if (board && board.rank) { lines.push("\u{1F3C6} " + board.rank + " of " + board.of + " on today's board"); }
  lines.push(silhouette(result.build || rec.build || { stack: [] }) + (rec && rec.attempts === 1 ? "  first try" : "  attempt " + (rec ? rec.attempts : 1)));
  // canonical domain, not window.location: previews must not leak their URL
  lines.push("https://quinnsavitt.com/games/rocket/");
  return lines.join("\n");
}
