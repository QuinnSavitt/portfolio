/* Gravl — time of day.
 *
 * A stage is lit by one of five times of day, drawn deterministically from the
 * daily seed alongside the environment and the weather. This module owns the
 * whole axis: the table, the draw, and the transform that bends an
 * environment's palette to the hour.
 *
 * It deliberately knows nothing about three.js. `applyDaylight` takes the
 * plain palette object world.js already builds and returns another one, so the
 * lighting can be reasoned about — and tested — without a renderer.
 *
 * Composition order is environment -> weather -> time of day. Time of day goes
 * last because it is the strongest signal: an overcast noon and an overcast
 * midnight should not be a shade apart.
 */

import { rng, hash32 } from "./daily.js";

/* Colour mixing on plain hex ints, so this module stays renderer-free.
 * THREE.Color would pull three.js into the physics/test path for no reason. */
function mixHex(a, b, k) {
  if (k <= 0) return a;
  const t = Math.max(0, Math.min(1, k));
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/* ------------------------------------------------------------ the table
 *
 * `sunEl` is the sun's height as a fraction of straight up (0 = on the
 * horizon, 1 = overhead) and `sunAz` swings it around the stage, so low sun
 * rakes across the road and picks out the camber. Every intensity is a
 * multiplier on the environment's own figure rather than an absolute, so
 * Wales stays duller than the desert at every hour.
 *
 * `afternoon` is the identity entry: it reproduces exactly what the game
 * looked like before this module existed, which keeps it as the reference
 * point the other four are judged against.
 */
export const TIMES_OF_DAY = [
  {
    id: "sunrise", label: "Sunrise", w: 2,
    sunEl: 0.13, sunAz: -0.9,
    sunTint: 0xffb27a, sunMix: 0.7, sunInt: 0.8,
    hemiSkyTint: 0xf0b48e, hemiSkyMix: 0.4, hemiInt: 0.9,
    skyTopTint: 0x4c6ea6, skyTopMix: 0.45, skyHorTint: 0xf6a878, skyHorMix: 0.62,
    fogTint: 0xe8b48c, fogMix: 0.5,
    ambient: 0, headlights: true, stars: 0, unlit: 0.72,
  },
  {
    id: "morning", label: "Morning", w: 4,
    sunEl: 0.52, sunAz: -0.7,
    sunTint: 0xfff6e2, sunMix: 0.35, sunInt: 0.98,
    hemiSkyTint: 0xdcecff, hemiSkyMix: 0.2, hemiInt: 0.98,
    skyTopTint: 0x74a6de, skyTopMix: 0.2, skyHorTint: 0xf2f6fa, skyHorMix: 0.22,
    fogTint: 0xe8eef4, fogMix: 0.2,
    ambient: 0, headlights: false, stars: 0, unlit: 1,
  },
  {
    /* Identity: no tints, no multipliers, and a sun angle that reproduces the
     * fixed vector world.js used before this module existed - (-0.55, 0.85,
     * 0.35), normalised. Any stage that draws this hour is pixel-for-pixel
     * what the game shipped with, which makes it the reference the other four
     * are judged against. */
    id: "afternoon", label: "Afternoon", w: 5,
    sunEl: 0.803, sunAz: 0.819,
    sunTint: 0xffffff, sunMix: 0, sunInt: 1,
    hemiSkyTint: 0xffffff, hemiSkyMix: 0, hemiInt: 1,
    skyTopTint: 0xffffff, skyTopMix: 0, skyHorTint: 0xffffff, skyHorMix: 0,
    fogTint: 0xffffff, fogMix: 0,
    ambient: 0, headlights: false, stars: 0, unlit: 1,
  },
  {
    /* The colour constants are lifted from the old `sunset` weather branch in
     * world.js, which this replaces, so days that drew sunset weather keep
     * their palette. The sun itself sits lower than the old fixed vector did,
     * which is the point of moving this onto its own axis. */
    id: "sunset", label: "Sunset", w: 2,
    sunEl: 0.15, sunAz: 0.92,
    sunTint: 0xffca8a, sunMix: 0.85, sunInt: 0.9,
    hemiSkyTint: 0xe8a878, hemiSkyMix: 0.35, hemiInt: 0.92,
    skyTopTint: 0x7a5f8e, skyTopMix: 0.45, skyHorTint: 0xf2b56a, skyHorMix: 0.55,
    fogTint: 0xe0b184, fogMix: 0.45,
    ambient: 0, headlights: true, stars: 0, unlit: 0.8,
  },
  {
    /* Moonlight, not darkness. A rally stage the player cannot read is not a
     * harder stage, it is an unfair one - so the moon stays bright enough to
     * shape the terrain and the headlights do the close work. */
    id: "night", label: "Night", w: 2,
    sunEl: 0.6, sunAz: 0.35,
    sunTint: 0x9db4d8, sunMix: 0.92, sunInt: 0.26,
    hemiSkyTint: 0x2c3a58, hemiSkyMix: 0.85, hemiInt: 0.42,
    skyTopTint: 0x070b18, skyTopMix: 0.93, skyHorTint: 0x1a2338, skyHorMix: 0.86,
    fogTint: 0x101728, fogMix: 0.86,
    ambient: 0.1, headlights: true, stars: 420, unlit: 0.3,
  },
];

const BY_ID = {};
for (const t of TIMES_OF_DAY) BY_ID[t.id] = t;

export function timeOfDayInfo(id) {
  return BY_ID[id] || BY_ID.afternoon;
}

/* --------------------------------------------------------------- the draw */

/* Its own RNG stream, seeded from the base seed with its own constant.
 *
 * This matters more than it looks. Stage generation already draws from
 * several independent streams, and taking time of day from any of them would
 * shift every draw after it - silently regenerating every stage that has ever
 * been published, including days players already hold records on. A separate
 * stream leaves all of them bit-identical.
 */
export function pickTimeOfDay(baseSeed, weatherId) {
  /* `sunset` predates this module as a *weather* id, which it never really
   * was - it describes an hour, not a sky condition. Rather than remove it
   * from the environment weather tables (which would change the weighted draw
   * and therefore reshuffle published stages), a stage that drew it simply
   * pins the hour and skips the roll. */
  if (weatherId === "sunset") return "sunset";

  const tr = rng(hash32((baseSeed ^ 0x54494d45) >>> 0));
  return tr.weighted(TIMES_OF_DAY).id;
}

/* -------------------------------------------------------- the transform */

/* Bends an environment palette (already weather-adjusted) to the hour.
 * Returns a new object; the input is not modified. */
export function applyDaylight(pal, todId) {
  const t = timeOfDayInfo(todId);
  const out = Object.assign({}, pal);

  out.sun = mixHex(pal.sun, t.sunTint, t.sunMix);
  out.sunInt = pal.sunInt * t.sunInt;
  out.hemi = mixHex(pal.hemi, t.hemiSkyTint, t.hemiSkyMix);
  out.hemiInt = pal.hemiInt * t.hemiInt;
  out.skyTop = mixHex(pal.skyTop, t.skyTopTint, t.skyTopMix);
  out.skyHor = mixHex(pal.skyHor, t.skyHorTint, t.skyHorMix);
  out.fog = mixHex(pal.fog, t.fogTint, t.fogMix);

  /* The mountain ring and far ground disc sit at the edge of the world, where
   * aerial perspective should have washed them into the sky long before the
   * fog plane reaches them. Pulling them toward the fog colour keeps the
   * horizon from reading as a hard band, which is most obvious at night. */
  out.mountain = mixHex(pal.mountain, t.fogTint, t.fogMix * 0.85);
  out.far = mixHex(pal.far, t.fogTint, t.fogMix * 0.7);

  /* Particles are drawn with PointsMaterial, which ignores lights entirely -
   * so dust and precipitation keep full daylight brightness however dark the
   * scene gets, and at night they read as glowing orbs. Renderers should
   * scale those colours by this. */
  out.unlitDim = t.unlit;

  out.ambient = t.ambient;
  out.headlights = t.headlights;
  out.stars = t.stars;
  out.sunEl = t.sunEl;
  out.sunAz = t.sunAz;
  out.todLabel = t.label;
  return out;
}

/* Sun (or moon) direction as a unit-ish vector, for whatever the renderer
 * wants to do with it. Kept here so the angle lives beside the table. */
export function sunDirection(todId) {
  const t = timeOfDayInfo(todId);
  const el = t.sunEl;
  const horizontal = Math.sqrt(Math.max(0, 1 - el * el));
  return { x: Math.cos(t.sunAz * Math.PI) * horizontal, y: el, z: Math.sin(t.sunAz * Math.PI) * horizontal };
}
