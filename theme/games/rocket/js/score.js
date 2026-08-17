/* Daily Rocket — scoring, local records, sharing.
 *
 * Scoring is transparent: every run returns its individual terms so the
 * result screen can show exactly where the missing points went. Time and
 * fuel terms are normalised against the day's par (measured by the audition
 * bot), so absolute medal thresholds mean the same thing on every day.
 */

import { V_LAND } from "./physics.js";
import { dayIndex } from "./daily.js";

const PREFIX = "qs-rocket-";
const HUB_KEY = "qs-game-rocket-played";

export const MEDALS = [
  { id: "platinum", label: "Platinum", emoji: "\u{1F48E}", min: 9300 },
  { id: "gold", label: "Gold", emoji: "\u{1F947}", min: 8000 },
  { id: "silver", label: "Silver", emoji: "\u{1F948}", min: 6000 },
  { id: "bronze", label: "Bronze", emoji: "\u{1F949}", min: 1 }
];

export function medalFor(total, failed) {
  if (failed) { return null; }
  for (const m of MEDALS) { if (total >= m.min) { return m; } }
  return null;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function score(ship, day) {
  const lines = [];
  let total = 0;
  const add = (key, label, value, detail) => {
    value = Math.round(value);
    lines.push({ key, label, value, detail: detail || "" });
    total += value;
  };

  const beaconPts = ship.collected * 800;

  if (!ship.success) {
    return {
      total: 0, lines: [], failed: true, medal: null, message: ship.message,
      stats: { beacons: ship.collected, time: ship.t }
    };
  }

  const l = ship.landing;
  add("land", "Touchdown", 2000, "on the pad");

  const soft = clamp01(1 - l.speed / V_LAND);
  add("soft", "Soft landing", 1500 * Math.pow(soft, 1.15), l.speed.toFixed(1) + " m/s");

  const dist = Math.abs(l.distance);
  const acc = clamp01(1 - dist / day.pad.halfW);
  add("acc", "Accuracy", 1500 * Math.pow(acc, 1.3), dist.toFixed(1) + " m off centre");

  add("beacons", "Beacons", beaconPts, ship.collected + " of " + day.beacons.length);

  const pt = day.par.time;
  add("time", "Flight time", 1500 * clamp01(1 - (ship.t - pt * 0.75) / (pt * 1.5)),
    ship.t.toFixed(1) + " s");

  const pf = Math.max(20, day.par.fuel);
  add("fuel", "Fuel economy", 1100 * clamp01(1 - (ship.fuelBurned - pf * 0.6) / (pf * 1.2)),
    Math.round(ship.fuelBurned) + " kg burned");

  total = Math.round(total);
  return {
    total, lines, failed: false, medal: medalFor(total, false), message: ship.message,
    stats: {
      beacons: ship.collected,
      time: ship.t,
      impact: l.speed,
      distance: dist,
      fuelLeftFrac: ship.fuelLoaded > 0 ? ship.fuel / ship.fuelLoaded : 0,
      fuelBurned: ship.fuelBurned,
      touchdowns: ship.touchdowns
    }
  };
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
  return read(dayKey(day), { attempts: 0, first: null, best: null, ghost: null });
}

export function compressGhost(samples) {
  // [x*10, y*10, ang*100] per sample, implicit 0.15 s cadence
  const out = [];
  for (const p of samples) {
    out.push(Math.round(p.x * 10), Math.round(p.y * 10), Math.round(p.ang * 100));
  }
  return out;
}

export function loadGhost(day) {
  const rec = loadDay(day);
  if (!rec.ghost || rec.ghost.length < 6) { return null; }
  const pts = [];
  for (let i = 0; i + 2 < rec.ghost.length; i += 3) {
    pts.push({ t: (i / 3) * 0.15, x: rec.ghost[i] / 10, y: rec.ghost[i + 1] / 10, ang: rec.ghost[i + 2] / 100 });
  }
  return pts;
}

/* Records what happened; returns what changed so the result screen can
 * shout about it. The blind run is the first completed attempt, success or
 * not — it can never be replaced. */
export function submit(day, result, ship, loadout, ghostSamples) {
  const rec = loadDay(day);
  rec.attempts = (rec.attempts || 0) + 1;

  let isFirst = false, isBest = false;
  const entry = result.failed ? null : {
    total: result.total, medal: result.medal ? result.medal.id : null,
    stats: result.stats, loadout, at: rec.attempts
  };

  if (!rec.first) {
    rec.first = entry || { total: 0, failed: true, at: rec.attempts };
    isFirst = true;
  }
  if (entry && (!rec.best || entry.total > rec.best.total)) {
    rec.best = entry;
    isBest = true;
    if (ghostSamples && ghostSamples.length) { rec.ghost = compressGhost(ghostSamples); }
  }
  write(dayKey(day), rec);

  // lifetime stats + hub badge, but only for the real current day
  if (day.index === dayIndex()) {
    const s = read("stats", { played: 0, landed: 0, crashed: 0, best: 0, streak: 0, lastDay: null });
    if (s.lastDay !== day.index) {
      s.played++;
      s.streak = s.lastDay === day.index - 1 ? (s.streak || 0) + 1 : 1;
      s.lastDay = day.index;
    }
    if (result.failed) { s.crashed++; } else { s.landed++; }
    if (!result.failed && result.total > (s.best || 0)) { s.best = result.total; }
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
  return read("stats", { played: 0, landed: 0, crashed: 0, best: 0, streak: 0, lastDay: null });
}

// --------------------------------------------------------------- share

const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function shareText(day, result, rec) {
  const lines = [];
  const medal = result.failed ? "\u{1F4A5}" : (result.medal ? result.medal.emoji : "");
  lines.push("Daily Rocket #" + day.number + " " + medal + " " +
    (result.failed ? "crashed" : fmt(result.total)));
  lines.push(day.world.name + " · " + day.mission.name);

  const sat = "🛰️";
  const b = result.stats ? result.stats.beacons : 0;
  let row = Array(b + 1).join(sat) || "—";
  if (!result.failed) {
    row += "  " + result.stats.impact.toFixed(1) + " m/s · ⛽ " +
      Math.round(result.stats.fuelLeftFrac * 100) + "% left · ⏱ " +
      result.stats.time.toFixed(1) + "s";
  }
  lines.push(row);
  if (rec && rec.attempts === 1) { lines.push("first try"); }
  // canonical domain, not window.location: previews must not leak their URL
  lines.push("https://quinnsavitt.com/games/rocket/");
  return lines.join("\n");
}
