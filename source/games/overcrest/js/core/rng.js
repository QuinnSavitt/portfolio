/* Overcrest — deterministic randomness.
 *
 * Every stream of randomness in the game derives from one run seed through
 * hashCombine, so the entire journey — roads, weather, cards, props — is a
 * pure function of (seed, choices). No Math.random() anywhere in sim code;
 * the node harness greps for it.
 */

export function hash32(x) {
  x = x >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

export function hashCombine(a, b) {
  // boost-style mix; order-sensitive
  a = a >>> 0; b = b >>> 0;
  return hash32((a ^ (b + 0x9e3779b9 + ((a << 6) >>> 0) + (a >>> 2))) >>> 0);
}

export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return hash32(h);
}

/* mulberry32 with the helper surface the generators expect */
export function rng(seed) {
  let a = seed >>> 0;
  const r = function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1)); // inclusive
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.chance = (p) => r() < p;
  r.weighted = (arr) => {
    let total = 0;
    for (const it of arr) total += it.w;
    let x = r() * total;
    for (const it of arr) { x -= it.w; if (x <= 0) return it; }
    return arr[arr.length - 1];
  };
  r.state = () => a;      // for save/resume of long-lived streams
  r.setState = (s) => { a = s >>> 0; };
  return r;
}

/* ------------------------------------------------------------- run seeds */

const SEED_A = [
  "AMBER", "BIRCH", "CEDAR", "DUSK", "EMBER", "FROST", "GRAVEL", "HOLLOW",
  "IRON", "JUNIPER", "KESTREL", "LANTERN", "MOSS", "NORTH", "OTTER", "PINE",
  "QUARRY", "RIDGE", "SUMMIT", "THISTLE", "UPLAND", "VALLEY", "WILLOW", "YARROW",
];
const SEED_B = [
  "ARROW", "BROOK", "CREST", "DRIFT", "ECHO", "FALCON", "GLOW", "HARE",
  "ISLE", "JAY", "KNOLL", "LOON", "MIRROR", "NIGHT", "OWL", "PASS",
  "QUIET", "RAVEN", "STONE", "TRAIL", "UNDER", "VEIL", "WREN", "ZENITH",
];

/* A human-friendly seed like "BIRCH-FALCON-47", derived from an entropy int
 * (the only place a wall clock is allowed is *creating* a brand new seed in
 * the UI layer — everything downstream is pure). */
export function seedName(entropy) {
  const h = hash32(entropy);
  const a = SEED_A[h % SEED_A.length];
  const b = SEED_B[hash32(h ^ 0x5eed) % SEED_B.length];
  const num = hash32(h ^ 0xbeef) % 100;
  return `${a}-${b}-${num}`;
}

/* Any typed string is a valid seed; canonical names round-trip. */
export function seedFromString(str) {
  return hashString(String(str).trim().toUpperCase());
}
