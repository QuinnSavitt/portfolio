/* Overcrest — where standing water actually stands.
 *
 * THREE-free (the stance/seat pattern) so the harness can hold it to
 * account: hands-on #5's report was "puddles on the roads are never well
 * placed", and the old ford sheet was the loudest case — it rode the deck
 * a hand proud, following slope and camber, which is how water ends up
 * lying on a hillside. A pond has one law: it is LEVEL, and its shoreline
 * falls where the ground rises through the surface.
 *
 * pondPlan finds that surface for a ford: the lowest deck point across the
 * event's span sets the water table, the pond fills its whole hollow (a
 * bounded reach past the event's bounds if the dip continues), and each
 * end either meets a real bank (deck above water) or is tapered out by the
 * renderer (openA/openB). chunks.js draws exactly this plan; the harness
 * asserts it against the ring.
 */

export const POND_DEPTH = 0.14;   // water table above the lowest deck point
export const POND_REACH = 40;     // samples the pond may spread past the event
export const POND_FULL = 0.22;    // depth at which the pond reaches full width

/* ring: {Y, MASK} — the world's sample ring. Returns null when the ford's
 * span lies outside the section. shoreHalf(i) is the half-width FRACTION
 * of the deck (the ribbon's lanePoint latFrac) the water reaches at i. */
export function pondPlan(ring, sec, ford, DS) {
  const { Y, MASK } = ring;
  const iA0 = Math.max(sec.i0, Math.round(ford.s0 / DS - 1));
  const iB0 = Math.min(sec.i1, Math.round(ford.s1 / DS - 1));
  if (iA0 > iB0) return null;
  let minY = Infinity;
  for (let i = iA0; i <= iB0; i++) minY = Math.min(minY, Y[i & MASK]);
  const level = minY + POND_DEPTH;
  let iA = iA0, iB = iB0;
  while (iA > sec.i0 && iA > iA0 - POND_REACH && Y[(iA - 1) & MASK] < level) iA--;
  while (iB < sec.i1 && iB < iB0 + POND_REACH && Y[(iB + 1) & MASK] < level) iB++;
  /* an end that stopped at the fill cap (not at a real bank) still sits
   * under water — the renderer tapers it instead of cutting an edge */
  const openA = iA > sec.i0 && Y[(iA - 1) & MASK] < level;
  const openB = iB < sec.i1 && Y[(iB + 1) & MASK] < level;
  const shoreHalf = (i) => {
    const depth = level - Y[i & MASK];
    let e = depth <= 0 ? 0 : 1.14 * Math.min(1, Math.sqrt(depth / POND_FULL));
    if (openA) e = Math.min(e, 1.14 * Math.min(1, (i - iA) / 3));
    if (openB) e = Math.min(e, 1.14 * Math.min(1, (iB - i) / 3));
    return e;
  };
  return { level, iA, iB, openA, openB, shoreHalf };
}
