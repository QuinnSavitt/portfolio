/* Overcrest — crossings: the road goes THROUGH things and OVER things.
 *
 * The landscape is value noise laid around the road: a "hills" field that
 * says how far above or below the deck the far ground wants to sit. Where
 * that field stands well above the road, the generator used to carve an
 * endless open trench — a quarry with a rally stage at the bottom, and one
 * of the few places the world admitted it was drawn rather than built.
 * Where it falls well below, the road rode a kilometre-long earth berm.
 *
 * Both are the same lie from opposite sides, and both have the same fix:
 * a span. Rock over the road is a TUNNEL; a valley under it is a BRIDGE.
 * Detection is geography, not decoration — a span happens where the ground
 * demands one, so the same seed always builds the same crossings.
 *
 * Pure data + arithmetic; DOM-free, allocation-light, no RNG (the noise
 * field is the randomness, and it is already deterministic).
 */

export const TUNNEL = 1, BRIDGE = -1;

export const SPAN = {
  /* geometry, all metres and all relative to the deck */
  boreHalf: 3.0,       // deck edge → inner face of the tunnel wall
  roofH: 6.2,          // deck → underside of the tunnel roof
  wallT: 0.6,
  /* rock left ON TOP of the roof. Without it the ground outside the wall
   * levels off at exactly roof height and the slab pokes out of the
   * hillside like a plank — the tunnel has to be a hole in a hill, not a
   * lid laid over a trench. */
  roofCover: 2.4,
  roofSpread: 9.5,   // how far the roof reaches out at mid-span (buried)
  minVoid: 9.5,        // a bridge is never over less air than this
  parapet: 0.92,       // bridge parapet height above the deck
  deckT: 0.85,         // bridge deck slab thickness
  pierStep: 27,        // metres between piers
  kerb: 0.55,          // bridge: deck edge → outside face of the parapet

  /* detection */
  minLen: 78,          // a crossing shorter than this is a culvert, not a span
  maxLen: 430,
  minGap: 520,         // metres of ordinary road between two spans
  ramp: 11,            // portal ease: metres over which the span reaches full
  tunnelMinRock: 10.4,  // need at least this much rock over the bore
  bridgeMinDrop: 9.0,  // and this much air under the deck
  tunnelFrac: 0.70,    // ...or this fraction of the local hill amplitude
  bridgeFrac: 0.66,
  shoulderFrac: 0.62,  // a run extends outwards while it still holds this much
};

/* Threshold pair (up, down) for one sample given the local hill amplitude.
 *
 * `bias` is how a special event asks the landscape for more than it would
 * normally give: {tunnel, bridge} scale the thresholds down, so ground
 * that is merely hilly starts qualifying. It never invents rock — the
 * crossing still lands where the noise says the rock is — which is why an
 * event that asks for tunnels can honestly come up empty and be dropped. */
export function thresholds(amp, bias) {
  const bt = (bias && bias.tunnel) || 1, bb = (bias && bias.bridge) || 1;
  return [
    Math.max(SPAN.tunnelMinRock, SPAN.tunnelFrac * amp) * bt,
    -Math.max(SPAN.bridgeMinDrop, SPAN.bridgeFrac * amp) * bb,
  ];
}

/* Find spans in a run of samples.
 *
 *   rel[j]    signed metres the far landscape sits above the deck
 *   amp[j]    local hill amplitude (thresholds scale with it, so a flat
 *             country gets crossings at the same rate as a dramatic one)
 *   block[j]  truthy where a span is forbidden (waystation aprons, water)
 *   sOf(j)    road distance of sample j
 *
 * Returns [{kind, j0, j1}] — inclusive sample indices into the run.
 * Spans are separated by SPAN.minGap and never touch a blocked sample.
 */
export function detectSpans(rel, amp, block, sOf, opts) {
  opts = opts || {};
  const bias = opts.bias || null;
  const minGap = (bias && bias.gap) || SPAN.minGap;
  const n = rel.length;
  const out = [];
  let lastEnd = opts.lastSpanEndS != null ? opts.lastSpanEndS : -1e9;
  let j = 0;
  while (j < n) {
    if (block[j]) { j++; continue; }
    const [up, dn] = thresholds(amp[j], bias);
    const kind = rel[j] > up ? TUNNEL : rel[j] < dn ? BRIDGE : 0;
    if (!kind) { j++; continue; }
    // core: while the sample still clears its own threshold
    let k = j;
    while (k + 1 < n && !block[k + 1]) {
      const [u2, d2] = thresholds(amp[k + 1], bias);
      if (kind === TUNNEL ? rel[k + 1] > u2 : rel[k + 1] < d2) k++;
      else break;
    }
    const coreLen = sOf(k) - sOf(j);
    if (coreLen < SPAN.minLen * 0.55) { j = k + 1; continue; }
    /* Extend into the shoulders of the hill (or the sides of the valley):
     * a portal belongs where the rock starts, not where it is deepest. */
    let a = j, b = k;
    while (a > 0 && !block[a - 1]) {
      const [u2, d2] = thresholds(amp[a - 1], bias);
      const t = SPAN.shoulderFrac;
      if (kind === TUNNEL ? rel[a - 1] > u2 * t : rel[a - 1] < d2 * t) a--;
      else break;
    }
    while (b + 1 < n && !block[b + 1]) {
      const [u2, d2] = thresholds(amp[b + 1], bias);
      const t = SPAN.shoulderFrac;
      if (kind === TUNNEL ? rel[b + 1] > u2 * t : rel[b + 1] < d2 * t) b++;
      else break;
    }
    let len = sOf(b) - sOf(a);
    if (len > SPAN.maxLen) {
      // keep the deepest part: shrink evenly toward the core
      const trim = Math.round(((len - SPAN.maxLen) / (sOf(1) - sOf(0) || 2.5)) / 2);
      a += trim; b -= trim;
      len = sOf(b) - sOf(a);
    }
    if (len < SPAN.minLen || sOf(a) - lastEnd < minGap) { j = k + 1; continue; }
    out.push({ kind, j0: a, j1: b });
    lastEnd = sOf(b);
    j = b + 1;
  }
  return out;
}

/* How enclosed / exposed a point along a span is: 0 at the portals, 1 in
 * the middle. The ramp is short on purpose — a tunnel mouth is an edge. */
export function spanStrength(span, s) {
  if (s < span.s0 || s > span.s1) return 0;
  const t = Math.min(s - span.s0, span.s1 - s) / SPAN.ramp;
  return t >= 1 ? 1 : t <= 0 ? 0 : t * t * (3 - 2 * t);
}
