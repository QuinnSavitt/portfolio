/* Daily Rocket — seed plumbing.
 *
 * Everything competitive derives from one integer: the UTC day index.
 * Epoch matches the other daily games: 2026-01-01 is #1. No Math.random and
 * no wall-clock reads (beyond the date) anywhere downstream of this file.
 */

export const EPOCH = Date.UTC(2026, 0, 1);
const DAY_MS = 86400000;

export function hash32(n) {
  n |= 0;
  n = Math.imul(n ^ (n >>> 16), 2246822507);
  n = Math.imul(n ^ (n >>> 13), 3266489909);
  return (n ^ (n >>> 16)) >>> 0;
}

/* mulberry32 — small, fast, identical in every browser and in Node. */
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
  return f;
}

export function dayIndex(now) {
  const d = now || new Date();
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((utc - EPOCH) / DAY_MS);
}

export function msUntilReset(now) {
  const d = now || new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - d.getTime();
}

/* Smooth deterministic 1D value noise in [-1, 1]. Used for gusts and terrain.
 * `salt` separates independent channels drawn from the same day. */
export function noise1d(t, salt) {
  const i0 = Math.floor(t);
  const f = t - i0;
  const s = f * f * (3 - 2 * f);
  const a = (hash32(Math.imul(i0, 374761393) + salt) / 4294967296) * 2 - 1;
  const b = (hash32(Math.imul(i0 + 1, 374761393) + salt) / 4294967296) * 2 - 1;
  return a + (b - a) * s;
}
