/* Overcrest — surface model.
 *
 * Each surface is described in the terms the Overcrest tire law actually
 * uses (see physics.js):
 *
 *   grip  — peak friction coefficient (disc radius = grip · load)
 *   bite  — slip angle, in radians, where the tyre has taken ~76% of its
 *           peak (the tanh knee). Small bite = sharp, pointy response
 *           (tarmac); big bite = the surface takes an angle before it
 *           pushes back (snow wants to be driven sideways).
 *   fade  — edginess past the peak: force ×= 1/(1 + fade·(|α|−2·bite)²).
 *           Tarmac punishes overdriving; loose surfaces barely care, which
 *           is what makes long gravel slides feel serene.
 *   roll  — extra rolling resistance coefficient.
 *   rough — rumble amplitude for feel/audio.
 *   wetGrip / wetBite — multipliers at full wetness (rain arrives as a
 *           continuous scalar, never a light switch).
 */

/* Retuned 2026-08-18 after the first hands-on drive ("feels like ice"):
 * bite roughly a third sharper everywhere so the tyre answers small slip
 * angles decisively, and a real peak (fade up) so overdriving is felt. */
/* Grip is deliberately generous — this is a fun, easy version of a rally
 * car, not a simulator. The road generator sizes corners from these same
 * numbers, so more grip means tighter roads at the same calls, not an
 * easier road. */
export const SURFACES = {
  tarmac: { grip: 1.48, bite: 0.050, fade: 6.5, roll: 0.010, rough: 0.06, wetGrip: 0.74, wetBite: 1.25, name: "Tarmac" },
  gravel: { grip: 1.18, bite: 0.062, fade: 2.8, roll: 0.016, rough: 0.45, wetGrip: 0.88, wetBite: 1.05, name: "Gravel" },
  dirt:   { grip: 1.06, bite: 0.070, fade: 2.4, roll: 0.018, rough: 0.55, wetGrip: 0.82, wetBite: 1.10, name: "Dirt" },
  snow:   { grip: 0.66, bite: 0.105, fade: 1.2, roll: 0.024, rough: 0.30, wetGrip: 1.0,  wetBite: 1.0,  name: "Snow" },
  ice:    { grip: 0.38, bite: 0.150, fade: 0.5, roll: 0.008, rough: 0.10, wetGrip: 1.0,  wetBite: 1.0,  name: "Ice" },
  mud:    { grip: 0.84, bite: 0.090, fade: 1.8, roll: 0.040, rough: 0.60, wetGrip: 0.90, wetBite: 1.05, name: "Mud" },
};

/* Ground beside and beyond the road, per biome ground key. */
export const GROUNDS = {
  grass:     { grip: 0.58, drag: 3.5, rough: 0.65, name: "grass" },
  scrub:     { grip: 0.62, drag: 3.2, rough: 0.70, name: "scrub" },
  sand:      { grip: 0.52, drag: 5.5, rough: 0.55, name: "sand" },
  snowfield: { grip: 0.30, drag: 8.0, rough: 0.45, name: "snowfield" },
  peat:      { grip: 0.48, drag: 6.0, rough: 0.75, name: "peat" },
  rockflat:  { grip: 0.75, drag: 2.4, rough: 0.85, name: "rock" },
  water:     { grip: 0.25, drag: 14,  rough: 0.40, name: "water" },
};

/* Resolve surface id + wetness 0..1 into tire-law parameters. */
export function surfaceParams(id, wetness) {
  const s = SURFACES[id] || SURFACES.gravel;
  const w = Math.max(0, Math.min(1, wetness || 0));
  return {
    grip: s.grip * (1 - (1 - s.wetGrip) * w),
    bite: s.bite * (1 + (s.wetBite - 1) * w),
    fade: s.fade * (1 - 0.45 * w),     // wet surfaces let go more gently
    roll: s.roll,
    rough: s.rough,
    id,
    name: s.name,
  };
}

/* Off-road params blended a little by wetness too (wet grass is soap). */
export function groundParams(key, wetness) {
  const g = GROUNDS[key] || GROUNDS.grass;
  const w = Math.max(0, Math.min(1, wetness || 0));
  return { grip: g.grip * (1 - 0.2 * w), drag: g.drag, rough: g.rough, name: g.name };
}
