/* Daily Rally — persistence and the (simulated) world.
 *
 * A static site has no server, so the "global leaderboard" is a simulated
 * field: a deterministic distribution anchored to the stage's bot time.
 * It is identical for every player on the same day — if you and a friend
 * post the same time you get the same rank — which keeps it honest as a
 * shared yardstick. The UI labels it as a sim field.
 */

import { hash32, localDayKey, rng } from "./daily.js";

const PREFIX = "qs-rally-";

function read(key) {
  try { return window.localStorage.getItem(PREFIX + key); } catch (e) { return null; }
}
function write(key, value) {
  try { window.localStorage.setItem(PREFIX + key, value); return true; } catch (e) { return false; }
}
function readJSON(key, fallback) {
  const raw = read(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

/* ------------------------------------------------------------ day records */

export function getDayRecord(day) {
  return readJSON("day-" + day, {
    blind: null,          // first completed run
    best: null,           // fastest run
    attempts: 0,
    splits: null,         // best run's split times [s1, s2]
    sectors: null,        // best run's sector times [a, b, c]
    ghost: null,          // best run ghost b64
  });
}

export function saveDayRecord(day, rec) {
  write("day-" + day, JSON.stringify(rec));
}

/* Record a completed run; returns flags about what it achieved. */
export function recordRun(day, run) {
  const rec = getDayRecord(day);
  rec.attempts++;
  const out = { firstEver: rec.blind == null, newBest: false, prevBest: rec.best };
  if (rec.blind == null) rec.blind = run.time;
  if (rec.best == null || run.time < rec.best) {
    out.newBest = true;
    rec.best = run.time;
    rec.splits = run.splits;
    rec.sectors = run.sectors;
    rec.ghost = run.ghost;
  }
  saveDayRecord(day, rec);
  bumpStats(day, run, out);
  markPlayedToday();
  return out;
}

export function bumpAttempts(day) {
  const rec = getDayRecord(day);
  rec.attempts++;
  saveDayRecord(day, rec);
}

/* the games hub reads this key to show the "played today" badge */
function markPlayedToday() {
  try { window.localStorage.setItem("qs-game-rally-played", localDayKey()); } catch (e) { /* no-op */ }
}

/* ------------------------------------------------------------- statistics */

export function getStats() {
  return readJSON("stats", {
    days: 0, attempts: 0, finishes: 0,
    bestPercentile: null, sumPercentile: 0, percentileCount: 0,
    top10: 0, top1: 0,
    streak: 0, lastDay: null,
  });
}

function bumpStats(day, run, flags) {
  const st = getStats();
  st.attempts++;
  st.finishes++;
  if (flags.firstEver) {
    st.days++;
    if (st.lastDay === day - 1) st.streak++;
    else st.streak = 1;
    st.lastDay = day;
  }
  write("stats", JSON.stringify(st));
}

export function notePercentile(pct) {
  const st = getStats();
  if (st.bestPercentile == null || pct < st.bestPercentile) st.bestPercentile = pct;
  st.sumPercentile += pct;
  st.percentileCount++;
  if (pct <= 10) st.top10++;
  if (pct <= 1) st.top1++;
  write("stats", JSON.stringify(st));
}

/* -------------------------------------------------------------- settings */

export function getSettings() {
  return readJSON("settings", {
    ghost: true, voice: true, audio: true, quality: "high", camera: 0,
  });
}
export function saveSettings(s) {
  write("settings", JSON.stringify(s));
}

/* ------------------------------------------------------- simulated field */

export function fieldFor(stage) {
  const T = stage.botTime;
  const seed = hash32(stage.seed ^ 0xf1e1d);
  const r = rng(seed);
  const wr = T * 1.008 + r() * T * 0.006;
  const median = T * 1.31 + r() * T * 0.04;
  const k = 2.05;
  const lambda = (median - wr) / Math.pow(Math.LN2, 1 / k);
  const size = 4200 + (seed % 4800);

  // fraction of the field faster than time t
  function fasterFrac(t) {
    if (t <= wr) return 0;
    return Math.max(0, Math.min(1, 1 - Math.exp(-Math.pow((t - wr) / lambda, k))));
  }
  function rank(t) {
    if (t <= wr) return 1;
    return Math.min(size, 1 + Math.floor(fasterFrac(t) * size));
  }
  function percentile(t) {
    return Math.max(0.02, Math.min(100, fasterFrac(t) * 100));
  }
  // time needed to reach a percentile (inverse CDF)
  function timeForPercentile(p) {
    const f = p / 100;
    return wr + lambda * Math.pow(-Math.log(1 - f), 1 / k);
  }

  // three deterministic rivals to chase
  const rivalNames = ["Aksel V.", "Miko S.", "Robyn K."];
  const rivals = rivalNames.map((name, i) => {
    const jr = rng(hash32(seed + i * 977));
    const base = [1.068, 1.125, 1.185][i];
    return { name, time: T * (base + (jr() - 0.5) * 0.03) };
  });

  return { wr, median, size, rank, percentile, timeForPercentile, rivals, botTime: T };
}

/* -------------------------------------------------------------- sharing */

export function shareText(stage, rec, field) {
  const flagEmoji = { FI: "🇫🇮", GB: "🏴", SE: "🇸🇪", MC: "🇲🇨", GR: "🇬🇷", MA: "🇲🇦" };
  const surf = { gravel: "🌲", gravelWet: "🌧️", tarmac: "🏔️", tarmacWet: "🌧️", snow: "❄️", dirt: "🏜️" };
  const lines = [];
  lines.push("DAILY RALLY #" + stage.number + " 🏁");
  lines.push((flagEmoji[stage.env.flag] || "") + " " + stage.env.name + " — " + stage.stageName);
  lines.push((surf[stage.surfKey] || "") + " " + stage.surfaceName + " · " + stage.weather.label + " · " + stage.kmText);
  if (rec.best != null) {
    lines.push("");
    lines.push("⏱️ " + fmtShare(rec.best));
    const pct = field.percentile(rec.best);
    lines.push("🏆 #" + field.rank(rec.best) + " · top " + (pct < 1 ? pct.toFixed(1) : Math.ceil(pct)) + "% (sim field)");
  }
  if (rec.blind != null && rec.blind !== rec.best) {
    lines.push("🕶️ blind: " + fmtShare(rec.blind));
  }
  if (rec.sectors) {
    lines.push("S1 " + fmtShare(rec.sectors[0]) + " · S2 " + fmtShare(rec.sectors[1]) + " · S3 " + fmtShare(rec.sectors[2]));
  }
  lines.push("");
  lines.push("Beat it.");
  return lines.join("\n");
}

function fmtShare(t) {
  const ms = Math.round(t * 1000);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rem = ms % 1000;
  if (m > 0) return m + ":" + String(s).padStart(2, "0") + "." + String(rem).padStart(3, "0");
  return s + "." + String(rem).padStart(3, "0");
}
