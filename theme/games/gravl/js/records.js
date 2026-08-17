/* Gravl — persistence and sharing.
 *
 * There is no server and no leaderboard. The social loop is Wordle's:
 * a copy-paste result your friends have to beat. The emoji sector grades
 * are measured against the stage's deterministic ideal pace, so the same
 * message means the same thing on everyone's phone.
 */

import { localDayKey } from "./daily.js";
import { DS } from "./track.js";

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

/* -------------------------------------------------------------- settings */

export function getSettings() {
  return readJSON("settings", {
    ghost: true, voice: true, audio: true, quality: "high", camera: 0,
  });
}
export function saveSettings(s) {
  write("settings", JSON.stringify(s));
}

/* -------------------------------------------------------------- sharing */

/* The stage's ideal (bot) time for each sector, the shared yardstick every
 * player's emoji grades are measured against. */
export function sectorIdeals(stage) {
  const t = stage.profile.timeAt;
  const i1 = Math.min(t.length - 1, Math.round(stage.splitS[0] / DS));
  const i2 = Math.min(t.length - 1, Math.round(stage.splitS[1] / DS));
  return [t[i1], t[i2] - t[i1], stage.botTime - t[i2]];
}

export function sectorEmoji(actual, ideal) {
  if (!(ideal > 0) || !(actual > 0)) return "⬜";
  const r = actual / ideal;
  if (r <= 1.1) return "🟪";     // basically flying
  if (r <= 1.22) return "🟩";
  if (r <= 1.4) return "🟨";
  return "🟥";
}

export function shareText(stage, rec) {
  const flagEmoji = { FI: "🇫🇮", GB: "🏴󠁧󠁢󠁷󠁬󠁳󠁿", SE: "🇸🇪", MC: "🇲🇨", GR: "🇬🇷", MA: "🇲🇦" };
  const surf = { gravel: "🌲", gravelWet: "🌧️", tarmac: "🏔️", tarmacWet: "🌧️", snow: "❄️", dirt: "🏜️" };
  const lines = [];
  lines.push("GRAVL #" + stage.number + " 🏁");
  lines.push((flagEmoji[stage.env.flag] || "") + " " + stage.env.name + " · " +
    (surf[stage.surfKey] || "") + " " + stage.surfaceName + " · " + stage.kmText);
  const tries = rec.attempts + (rec.attempts === 1 ? " attempt" : " attempts");
  if (rec.best != null) {
    lines.push("");
    lines.push("⏱️ " + fmtShare(rec.best) + " (" + tries + ")");
    if (rec.blind != null) {
      lines.push(rec.blind === rec.best
        ? "🕶️ blind run — first try"
        : "🕶️ blind " + fmtShare(rec.blind));
    }
    if (rec.sectors) {
      const ideals = sectorIdeals(stage);
      lines.push(
        sectorEmoji(rec.sectors[0], ideals[0]) +
        sectorEmoji(rec.sectors[1], ideals[1]) +
        sectorEmoji(rec.sectors[2], ideals[2])
      );
    }
  } else {
    lines.push("");
    lines.push("💥 no finish yet (" + tries + ")");
  }
  lines.push("");
  lines.push("Beat it. " + shareUrl());
  return lines.join("\n");
}

/* Canonical, not window.location.origin: a run played on a deploy preview or
 * the netlify.app domain must not leak that URL into shared messages. */
function shareUrl() {
  return "https://quinnsavitt.com/games/gravl/";
}

function fmtShare(t) {
  const ms = Math.round(t * 1000);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rem = ms % 1000;
  if (m > 0) return m + ":" + String(s).padStart(2, "0") + "." + String(rem).padStart(3, "0");
  return s + "." + String(rem).padStart(3, "0");
}
