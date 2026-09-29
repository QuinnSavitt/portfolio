/* Overcrest — atmosphere model: time of day and weather.
 *
 * TIME. The clock runs in day fractions (0 = midnight, 0.5 = noon). A run
 * starts mid-morning. Time does not pass evenly: golden hours are stretched
 * and deep night is shortened, because those are the minutes worth seeing
 * and the ones worth not overstaying. Keyframed palettes (sky, horizon,
 * fog, sun colour/strength, ambient, ground brightness) blend by phase and
 * are laid OVER a biome's daylight palette by the renderer.
 *
 * WEATHER. Fronts live along the road: two slow deterministic noise fields
 * over distance decide cloud cover and precipitation; fog is a third. The
 * car experiences whatever front it is inside, blended over ~40 s so rain
 * arrives like rain. Wetness (0..1) is what the tyres feel; it lags the
 * rain (a wet road stays wet after the shower).
 *
 * DOM-free; the renderer reads `world.sky` each frame.
 */

import { hashCombine } from "../core/rng.js";

export const DAY_SECONDS = 33 * 60;      // one full day at neutral pace (was 40: owner asked for a little quicker)

/* phase speed multipliers: night runs fast, golden hours run slow */
function phaseSpeed(u) {
  if (u < 0.19 || u > 0.9) return 1.55;    // deep night
  if (u < 0.3) return 0.75;                // dawn
  if (u > 0.72 && u < 0.88) return 0.7;    // golden hour → dusk
  return 1.0;
}

/* Sky keyframes. Colours as 0xRRGGBB; sun = {col, k}; amb = hemisphere
 * intensity; ground = multiplier on terrain/prop lighting; warm = 0..1
 * pushes the biome palette toward warm light. */
const KEYS = [
  { u: 0.00, top: 0x090d1a, hor: 0x141b2a, fog: 0x0f151f, sun: 0x9fb4d8, k: 0.06, amb: 0.22, ground: 0.24, warm: 0, stars: 1 },
  { u: 0.17, top: 0x0c1226, hor: 0x1b2438, fog: 0x141c2a, sun: 0x9fb4d8, k: 0.06, amb: 0.24, ground: 0.26, warm: 0, stars: 1 },
  { u: 0.22, top: 0x27305a, hor: 0x8a5f70, fog: 0x4c4658, sun: 0xff9a70, k: 0.18, amb: 0.4, ground: 0.42, warm: 0.5, stars: 0.5 },
  { u: 0.27, top: 0x5f86c0, hor: 0xffb47c, fog: 0xd8a888, sun: 0xffb070, k: 0.72, amb: 0.62, ground: 0.72, warm: 0.7, stars: 0 },
  { u: 0.34, top: 0x6fa5c9, hor: 0xe6ebe4, fog: 0xc9d8d6, sun: 0xfff2d9, k: 1.0, amb: 0.72, ground: 1.0, warm: 0.15, stars: 0 },
  { u: 0.50, top: 0x6a9fc4, hor: 0xecefe6, fog: 0xcfdcd8, sun: 0xffffff, k: 1.08, amb: 0.76, ground: 1.04, warm: 0, stars: 0 },
  { u: 0.66, top: 0x6f9fc6, hor: 0xe8ebe0, fog: 0xccd8d2, sun: 0xfff4dc, k: 1.0, amb: 0.72, ground: 1.0, warm: 0.15, stars: 0 },
  { u: 0.76, top: 0x6584bd, hor: 0xffd28e, fog: 0xe6c39c, sun: 0xffc272, k: 0.92, amb: 0.64, ground: 0.92, warm: 0.7, stars: 0 },
  { u: 0.81, top: 0x4a5c9a, hor: 0xff8f5e, fog: 0xd29c82, sun: 0xff9250, k: 0.62, amb: 0.5, ground: 0.72, warm: 0.85, stars: 0 },
  { u: 0.86, top: 0x1c2750, hor: 0x6e5c88, fog: 0x3f4262, sun: 0xd88a80, k: 0.2, amb: 0.36, ground: 0.42, warm: 0.4, stars: 0.5 },
  { u: 0.92, top: 0x0a0f1e, hor: 0x161e2e, fog: 0x101722, sun: 0x9fb4d8, k: 0.06, amb: 0.22, ground: 0.24, warm: 0, stars: 1 },
  { u: 1.00, top: 0x090d1a, hor: 0x141b2a, fog: 0x0f151f, sun: 0x9fb4d8, k: 0.06, amb: 0.22, ground: 0.24, warm: 0, stars: 1 },
];

function lerpHex(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

export function skyAt(u) {
  u = ((u % 1) + 1) % 1;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].u <= u) i++;
  const A = KEYS[i], B = KEYS[i + 1];
  const t0 = (u - A.u) / Math.max(1e-6, B.u - A.u);
  const t = t0 * t0 * (3 - 2 * t0);
  return {
    top: lerpHex(A.top, B.top, t), hor: lerpHex(A.hor, B.hor, t), fog: lerpHex(A.fog, B.fog, t),
    sun: lerpHex(A.sun, B.sun, t), k: A.k + (B.k - A.k) * t, amb: A.amb + (B.amb - A.amb) * t,
    ground: A.ground + (B.ground - A.ground) * t, warm: A.warm + (B.warm - A.warm) * t,
    stars: A.stars + (B.stars - A.stars) * t,
  };
}

/* Sun direction (unit vector, y up) for a day fraction; the moon is the
 * same path half a day later. */
export function sunDir(u) {
  const a = (u - 0.25) * Math.PI * 2;      // 0 at sunrise, π at sunset
  const elev = Math.sin(a) * 0.95;
  const az = a - Math.PI / 2;
  const cosE = Math.sqrt(Math.max(0, 1 - elev * elev));
  return { x: Math.cos(az) * cosE * -1, y: elev, z: Math.sin(az) * cosE, elev };
}

/* deterministic 1-D value noise over distance */
function n1(seed, x) {
  const i = Math.floor(x), f = x - i;
  const h = (k) => { let v = seed ^ Math.imul(k, 0x27d4eb2f); v = Math.imul(v ^ (v >>> 15), 0x2c1b3c6d); v ^= v >>> 13; return (v >>> 0) / 4294967296; };
  const a = h(i), b = h(i + 1);
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}

/* Front fields along the road. Returns targets for the point s. */
export function weatherAt(seed, s, biome, arc) {
  const km = s / 1000;
  const cloud = n1(hashCombine(seed, 0xc10d), km / 5.5) * 0.7 + n1(hashCombine(seed, 0xc10e), km / 1.7) * 0.3;
  const wet = n1(hashCombine(seed, 0x2a1e), km / 4.2);
  const fogN = n1(hashCombine(seed, 0xf06), km / 3.1);
  /* the biome may arrive as a lookup (the game passes "whatever country
   * is at s") or as a fixed def (the harness does) — resolve it here, or
   * every country quietly gets the default appetite */
  const bio = typeof biome === "function" ? biome(s) : biome;
  const w = bio && bio.weather ? bio.weather : { rain: 0.5, fog: 0.4, cloud: 0.5 };
  // rain needs cloud; fog is its own animal (valleys, mornings)
  let overcast = Math.max(0, Math.min(1, (cloud - (0.62 - w.cloud * 0.25)) / 0.3));
  let rain = Math.max(0, Math.min(1, (wet - (0.72 - w.rain * 0.22)) / 0.2)) * Math.max(0.35, overcast);
  let fog = Math.max(0, Math.min(1, (fogN - (0.78 - w.fog * 0.2)) / 0.16));
  /* The director's weather arc for the leg: a storm leg leans the same
   * fronts wetter, a fair leg holds them back. The fronts still build and
   * clear over kilometres — the arc changes what they amount to. */
  if (arc) {
    overcast = Math.min(1, overcast * arc.cloud);
    rain = Math.min(1, rain * arc.rain);
    fog = Math.min(1, fog * arc.fog);
  }
  return { overcast, rain, fog };
}

export function makeAtmosphere(seed, biome, opts) {
  opts = opts || {};
  const A = {
    u: opts.startU != null ? opts.startU : 0.335,     // mid-morning
    dayLen: opts.dayLen || DAY_SECONDS,
    // current, smoothed weather the car is inside
    overcast: 0, rain: 0, fog: 0, wetness: 0,
    // targets (what the front ahead says)
    tOvercast: 0, tRain: 0, tFog: 0,
    // codriver bookkeeping
    lastRainCall: 0, rainCalled: false,
  };

  function tick(dt, s) {
    /* opts.pace: the director's hand on the clock — a clamped lean (never
     * a time-lapse) used to aim deep night so dawn lands somewhere worth
     * arriving at. Pure function of sim state, so replays agree. */
    const pace = opts.pace ? opts.pace(A.u) : 1;
    A.u = (A.u + (dt / A.dayLen) * phaseSpeed(A.u) * pace) % 1;
    const w = opts.force || weatherAt(seed, s, biome, opts.arc && opts.arc(s));
    A.tOvercast = w.overcast; A.tRain = w.rain; A.tFog = w.fog;
    const k = 1 - Math.exp(-dt / 40);         // fronts arrive over ~40 s
    A.overcast += (A.tOvercast - A.overcast) * k;
    A.rain += (A.tRain - A.rain) * k;
    A.fog += (A.tFog - A.fog) * (1 - Math.exp(-dt / 25));
    // wetness: rises with rain, dries slowly (~3 min) after
    const wetTarget = A.rain > 0.15 ? Math.min(1, A.rain * 1.3) : 0;
    const kw = wetTarget > A.wetness ? 1 - Math.exp(-dt / 30) : 1 - Math.exp(-dt / 180);
    A.wetness += (wetTarget - A.wetness) * kw;
  }

  /* what lies 700 m ahead — for the codriver */
  function ahead(s) { return weatherAt(seed, s + 700, biome, opts.arc && opts.arc(s + 700)); }

  /* `night` and `golden` are how much of each the hour is, 0–1 — the two
   * numbers the grade and the lights both want, computed once here so the
   * renderer and the post chain can never disagree about what time it is. */
  function nightAmount(u) {
    if (u > 0.26 && u < 0.72) return 0;                       // day
    if (u <= 0.26) return Math.min(1, (0.26 - u) / 0.09);     // dawn side
    return Math.min(1, (u - 0.72) / 0.11);                    // dusk side
  }
  function goldenAmount(u) {
    const dawn = 1 - Math.min(1, Math.abs(u - 0.27) / 0.06);
    const dusk = 1 - Math.min(1, Math.abs(u - 0.76) / 0.07);
    return Math.max(0, Math.max(dawn, dusk));
  }

  /* `storm` is how much of a STORM this rain is, 0–1: past half rain the
   * front stops being weather and starts being an event — the sky goes
   * slate (scene), the rain leans in the wind (effects), the grade darkens
   * (post), the wind bed swells (ambience), the music turns (music), and
   * the front throws its own lightning (main). One number, read by all. */
  function stormAmount() { return Math.max(0, Math.min(1, (A.rain - 0.5) / 0.4)); }

  function snapshot() {
    const sky = skyAt(A.u);
    /* what the SKY shows: rain only ever falls out of cloud, but the rain
     * field is allowed to run ahead of the cloud field (a biome's appetite
     * lets it), which put showers under a broken blue sky (owner: "cloud
     * coverage does not match the weather"). The snapshot closes the sky
     * over any real rain, so every reader — the cloud layer, the grade,
     * the postcards — agrees with the water actually falling. */
    const overcast = Math.max(A.overcast, Math.min(1, A.rain * 1.25));
    return {
      u: A.u, sky, sun: sunDir(A.u),
      overcast, rain: A.rain, fog: A.fog, wetness: A.wetness,
      night: nightAmount(A.u), golden: goldenAmount(A.u),
      storm: stormAmount(),
    };
  }

  return { A, tick, ahead, snapshot, skyAt, sunDir };
}
