/* Overcrest — seating props on the terrain the renderer actually DRAWS.
 *
 * THREE-free (the stance.js pattern), because the harness must be able to
 * hold this to account: Quinn's hands-on #5 report was "props are not well
 * placed on the ground, often in the sky", and the mechanism was a gap
 * between two grounds. The PLACER seats a prop on the analytic ground of
 * its own road sample (groundAtSample — exact point, alt-leg blending off);
 * the BLANKET draws groundHeight(px, pz, null) — nearest leg, blending on —
 * sampled on a 3 m lattice and joined with linear triangles. Between those
 * two surfaces lies up to ~1.5 m of daylight (measured across 9,720 props:
 * trees worst, on curvy detail noise far off the deck), and a trunk base
 * with daylight under it reads as flying.
 *
 * The cure is to seat the VISUAL prop on the exact triangle the blanket
 * will draw under it. vertGround() is the one definition of a blanket
 * vertex (unhinted ground + the bridge-drop rule), shared by
 * buildTerrainCell and the seater so the two cannot drift apart; the
 * seater then interpolates the renderer's own triangulation (quad a,c,b /
 * b,c,d — the "/" diagonal). Colliders deliberately keep the ANALYTIC
 * height: physics drives on the analytic ground, and a collider must stay
 * inside its vertical window against the road the car is actually on.
 */
import { SPAN } from "../world/spans.js";

/* Blanket vertices that resolve ON a deck are tucked this far below it.
 * The ribbon draws the road at deck + 0.035; between lattice vertices the
 * blanket is a CHORD, and across a dip the chord stands above the sagging
 * deck — measured at 6–20 cm over ~1 per 2 km of road: a patch of grass
 * lying on the tarmac (hands-on #5, "a dip in the road has grass over
 * it"). Tucking deck vertices under the ribbon gives every chord that
 * much sag budget; the step at the deck edge hides under the ribbon's
 * shoulder. */
export const DECK_TUCK = 0.16;

/* One vertex of the terrain blanket. Returns {y, g, structural}:
 * `structural` marks the bridge-drop case where the blanket paints the
 * valley floor UNDER a span — ground that belongs to a structure, not to
 * anything a prop should be seated against.
 *
 * Beyond the road-query corridor (72–96 m from the nearest sample) a
 * hinted vertex takes the FAR SHELL's own ground: world.farGround from
 * the nearest live sample. It used to take the profile of the cell's
 * HINT sample instead — a sample chosen by road distance from the car,
 * not by nearness to the vertex, so on a graded road the two surfaces
 * stood metres apart where they overlapped (tools/_seamprobe.mjs
 * measured 2–5 m at 90–150 m out), and the coarse shell sliced up
 * through the blanket's outer cells as a shelf. One definition, one
 * surface; the shell's own inside/outside rule (vertGround inside the
 * corridor, farGround beyond) is now the blanket's too. Render-only by
 * contract, as before: physics and the seater never come out here. */
export function vertGround(world, px, pz, hintS) {
  let g = world.groundHeight(px, pz, null);
  if (!g && hintS != null) {
    const hintI = Math.round(hintS / world.DS - 1);
    const ni = world.nearestSampleFar(px, pz, hintI);
    const fg = ni >= 0 ? world.farGround(px, pz, ni) : null;
    if (fg) g = { y: fg.y, water: fg.water, on: "off", ground: null, rq: { s: fg.s, i: fg.i, span: 0 } };
  }
  let y = g ? g.y : 0;
  let structural = false;
  if (g && g.rq && g.rq.span < 0 && g.on !== "off") {
    /* Under an OVERPASS the space below the deck is another road, and that
     * road's ground is real; under an ordinary bridge the blanket drops to
     * the valley floor and the space belongs to the structure. */
    const gc = g.rq.over ? world.crossGround(g.rq.over - 1, px, pz, g.rq.i) : null;
    if (gc) { y = gc.y; g = gc; }
    else {
      y = g.rq.y - Math.max(SPAN.minVoid, -(g.rq.relief || 0)) * -g.rq.span;
      g = { ...g, on: "off" };
      structural = true;
    }
  }
  if (g && g.on === "road") y -= DECK_TUCK;
  return { y, g, structural };
}

/* A seater for one build pass: corner heights cached on the lattice (a
 * clump of trees shares most of its corners). `step` is the blanket's
 * CURRENT vertex pitch — CELL/RES, which the detail setting changes. */
export function makeSeater(world, step) {
  const cache = new Map();
  function corner(cx, cz) {
    const key = cx + "," + cz;
    let c = cache.get(key);
    if (c === undefined) {
      const v = vertGround(world, cx * step, cz * step, null);
      c = (!v.g || v.structural) ? null : v.y;
      cache.set(key, c);
    }
    return c;
  }
  return function seat(x, z) {
    const gx0 = Math.floor(x / step), gz0 = Math.floor(z / step);
    const ya = corner(gx0, gz0), yb = corner(gx0 + 1, gz0);
    const yc = corner(gx0, gz0 + 1), yd = corner(gx0 + 1, gz0 + 1);
    if (ya == null || yb == null || yc == null || yd == null) return null;
    const fx = x / step - gx0, fz = z / step - gz0;
    return fx + fz < 1
      ? ya + (yb - ya) * fx + (yc - ya) * fz
      : yd + (yc - yd) * (1 - fx) + (yb - yd) * (1 - fz);
  };
}
