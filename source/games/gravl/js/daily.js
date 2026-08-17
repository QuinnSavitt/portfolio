/* Gravl — deterministic daily seed plumbing.
 *
 * Every player worldwide derives today's stage from one integer: the UTC
 * day index. Same day -> same seed -> same road, car, weather, physics.
 * Nothing in the competitive path may read Math.random() or the wall clock
 * beyond the calendar date.
 */

/* Gravl #1 = 2026-08-17, the day of the rebrand — numbering restarted from 1
 * (the Daily Rally era used the shared 2026-01-01 epoch that Daily Rocket
 * still uses). Records live under a fresh key namespace for the same reason:
 * old day indices must never collide with new ones. */
export const EPOCH = Date.UTC(2026, 7, 17);
const DAY_MS = 86400000;

export function hash32(n) {
  n |= 0;
  n = Math.imul(n ^ (n >>> 16), 2246822507);
  n = Math.imul(n ^ (n >>> 13), 3266489909);
  return (n ^ (n >>> 16)) >>> 0;
}

export function hashCombine(a, b) {
  return hash32((a ^ Math.imul(b, 2654435761)) >>> 0);
}

/* mulberry32 — tiny, fast, bit-identical across every browser and node. */
export function rng(seed) {
  let a = seed >>> 0;
  const f = function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (lo, hi) => lo + f() * (hi - lo);
  f.int = (lo, hi) => Math.floor(lo + f() * (hi - lo + 1));
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  f.chance = (p) => f() < p;
  /* Weighted pick from [{w: number, ...}, ...] */
  f.weighted = (arr) => {
    let total = 0;
    for (const item of arr) total += item.w;
    let roll = f() * total;
    for (const item of arr) {
      roll -= item.w;
      if (roll <= 0) return item;
    }
    return arr[arr.length - 1];
  };
  return f;
}

export function dayIndex(now) {
  const d = now || new Date();
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((utc - EPOCH) / DAY_MS);
}

export function msUntilReset(now) {
  const d = now || new Date();
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return next - d.getTime();
}

export function daySeed(day) {
  return hash32((Math.imul(day, 0x9e3779b1) ^ 0x52414c59) >>> 0); // ^ "RALY"
}

/* Local calendar day string, the format the games hub stamps plays with. */
export function localDayKey(date) {
  const now = date || new Date();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return now.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (d < 10 ? "0" : "") + d;
}

export function fmtCountdown(ms) {
  const left = Math.max(ms, 0);
  const h = Math.floor(left / 3600000);
  const m = Math.floor((left % 3600000) / 60000);
  const s = Math.floor((left % 60000) / 1000);
  const p = (v) => (v < 10 ? "0" : "") + v;
  return p(h) + ":" + p(m) + ":" + p(s);
}

/* Race times are counted in physics ticks; format as M:SS.mmm or SS.mmm */
export function fmtTime(t, forceMin) {
  if (t == null || !isFinite(t)) return "--.---";
  const ms = Math.round(t * 1000);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rem = ms % 1000;
  const p3 = (v) => String(v).padStart(3, "0");
  if (m > 0 || forceMin) return m + ":" + String(s).padStart(2, "0") + "." + p3(rem);
  return s + "." + p3(rem);
}

/* Signed delta, e.g. "-0.417" / "+0.022" */
export function fmtDelta(dt) {
  if (dt == null || !isFinite(dt)) return "";
  const sign = dt <= -0.0005 ? "−" : "+";
  return sign + Math.abs(dt).toFixed(3);
}
