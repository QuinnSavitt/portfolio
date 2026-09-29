/* Overcrest — the streaming world.
 *
 * The endless road lives in ring buffers: a window of centreline samples
 * (about 2 km, sliding with the car) plus per-section prop/collider lists.
 * Everything ahead is generated section by section (see roadgen.js),
 * validated against the recent past for self-intersection, and culled
 * behind. The whole thing is a pure function of the run seed.
 *
 * One analytic ground function serves physics, prop placement and terrain
 * meshes alike: road deck inside the corridor, shoulder, ditch, then a
 * value-noise landscape that the road elevation fades into. Where two legs
 * of road run close (switchbacks), nearby legs blend by distance so the
 * terrain between them is single-valued — no floating shelves.
 *
 * DOM-free; the node harness drives it headless.
 */

import { rng, hashCombine } from "../core/rng.js";
import { G, VCAP } from "../sim/physics.js";
import { surfaceParams } from "../sim/surfaces.js";
import { DS, F_LAKE_L, F_LAKE_R, F_WAY, F_BRIDGE, F_TUNNEL, F_SPAN, WS_APPROACH, WS_APRON, makeGen, genSection, commitSection } from "./roadgen.js";
import { SPAN, TUNNEL, BRIDGE, detectSpans, spanStrength } from "./spans.js";
import { pickEvent, eventDelivered, nameEvent } from "./events.js";
import { BIOMES, START_BIOME, BIOME_INDEX, BIOME_LIST, regionAt, regionCount, REGION_INDEX, REGION_BY_INDEX, propClearance } from "./biomes.js";
import { placePickups } from "../game/pickups.js";

const CAP = 16384;                 // ring capacity (power of two), ~41 km
const MASK = CAP - 1;
const CELL = 24;                   // road-query cell size, m
const CELLC = 8;                   // collider cell size, m (physics contract)
const AHEAD = 1250;                // m of road kept generated ahead
const BEHIND = 450;                // m kept behind before culling

const SURF_IDS = ["gravel", "tarmac", "dirt", "snow", "ice", "mud"];
/* Marks that never get a collider: flat, drivable, soft, or far away. A
 * snow pole yields, a fence is wire, a boardwalk is a step, a hot pool is
 * water, a granite tower is a hundred metres off. The one wall the bible
 * forbids is the invisible one — everything here is honest to drive over. */
const UNARMED_MARKS = new Set(["snowpole", "fence", "hedge", "snowblock", "boardwalk", "hotpool", "geyser", "granitetower"]);
const gradeTargetFloor = 9;        // m/s: never ask the profile to crawl over a brow
const SURF_IDX = Object.fromEntries(SURF_IDS.map((s, i) => [s, i]));

/* -------------------------------------------------- deterministic noise */

function latticeHash(seed, ix, iz) {
  let h = seed ^ Math.imul(ix, 0x27d4eb2f) ^ Math.imul(iz, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function makeNoise2(seed) {
  return function (px, pz) {
    const ix = Math.floor(px), iz = Math.floor(pz);
    const fx = px - ix, fz = pz - iz;
    // smootherstep interpolation
    const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const sz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    const a = latticeHash(seed, ix, iz), b = latticeHash(seed, ix + 1, iz);
    const c = latticeHash(seed, ix, iz + 1), d = latticeHash(seed, ix + 1, iz + 1);
    return (a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz) * 2 - 1;
  };
}

function smoothstep(t) { return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); }

/* ------------------------------------------------------------ the world */

export function makeWorld(seed, opts) {
  opts = opts || {};
  const biome = BIOMES[opts.biome || START_BIOME];

  // ring buffers
  const X = new Float64Array(CAP), Z = new Float64Array(CAP);
  const Y = new Float32Array(CAP), HD = new Float32Array(CAP);
  const KV = new Float32Array(CAP), CB = new Float32Array(CAP);
  const HW = new Float32Array(CAP), GR = new Float32Array(CAP);
  const SF = new Uint8Array(CAP), FL = new Uint8Array(CAP);
  const VMAX = new Float32Array(CAP), PROF = new Float32Array(CAP);
  const NOBRK = new Uint8Array(CAP);
  // biome per sample: current, previous, and blend 0→1 across a transition
  const BI = new Uint8Array(CAP), BP = new Uint8Array(CAP), BT = new Float32Array(CAP);
  const TRANSITION_LEN = 520;      // m over which one country becomes the next
  /* micro-regions: the same idea one scale down. A country is made of
   * places — lakeshore, deep forest, high moor — and the road walks them in
   * order, so a leg reads as travel instead of four kilometres of the same. */
  const RG = new Uint8Array(CAP), RP = new Uint8Array(CAP), RT = new Float32Array(CAP);
  /* crossings: SPN is the signed span strength (+ tunnel, − bridge, 0 in
   * the open, eased at the portals) and RLF is the metres the far
   * landscape stands above the deck — the fact the span was built from. */
  const SPN = new Float32Array(CAP), RLF = new Float32Array(CAP);
  /* road over road: where a deck stands above another live leg, OVR holds
   * (that lower leg's sample index + 1), 0 elsewhere. The ground under an
   * overpass is the other road's ground, and this is how it is found. */
  const OVR = new Int32Array(CAP);
  /* Special events may reshape the land they run across: EVT scales the
   * terrain (the Flats go dead flat), EVW stands a wall up close on both
   * sides (a canyon is a tunnel with the roof off), and EVS marks samples
   * belonging to a sub-feature the event owns — the water in a ford. */
  const EVT = new Float32Array(CAP);
  const EVW = new Float32Array(CAP);
  const EVS = new Uint8Array(CAP);
  /* The Old Road (Phase 11's hidden roads): OLD carries the strip's signed
   * lateral offset (0 = none), OLDK its 0..1 strength ramp along the road. */
  const OLD = new Float32Array(CAP);
  const OLDK = new Float32Array(CAP);
  const SUB_FORD = 1;
  const REGION_BLEND = 260;        // m over which one region becomes the next
  const REGION_MIN = 620, REGION_MAX = 1150;

  const cellIndex = new Map();     // "cx,cz" -> array of global sample indices
  const colliderHash = new Map();  // "cx,cz" (8 m) -> array of {x,y,z,r}

  const detailN = makeNoise2(hashCombine(seed, 0x7e44a1));
  const hillN = makeNoise2(hashCombine(seed, 0x1b23c9));
  const clumpN = makeNoise2(hashCombine(seed, 0x55dd77));

  const world = {
    seed, biome, DS,
    iFirst: 0, iNext: 0,
    sections: [],
    notes: [],                     // {s, kind, grade?, dir?, mods?, endS}
    wetness: 0,
    night: 0, rainNow: 0,          // main mirrors the sky here for the souvenirs
    offroadKey: biome.ground,
    // legs & waystations
    legIndex: 0,
    legEndS: (opts.firstLegLen || 2800),   // where the next waystation apron begins
    hold: false,                   // generation paused at a waystation until a route is chosen
    waystations: [],               // [{index, s, sectionIndex, x, z, heading}]
    aprons: [],                    // [{s0, s1}] flat pull-off spans
    spans: [],                     // [{kind, s0, s1, i0, i1, depth}] bridges & tunnels
    oldRoads: [],                  // [{s0, s1, lat}] hidden strips (bounded, recent)
    events: [],                    // [{key, name, banner, s0, s1}] special events, live
    markStats: {},                 // per mark type: {ok, span, water, clearance, noground}
    // road-over-road: overpasses laid / laid retroactively / merged into
    // an existing bridge / declined (blocked ground) / declined because
    // the older section was built / props removed from under a new deck
    crossStats: { laid: 0, retro: 0, adopted: 0, declined: 0, skipBuilt: 0, pruned: 0 },
    eventKeys: [],                 // every event this run has produced, in order
    placeNames: [],                // ...and the place-words they were named after
    lastEventS: -1e9,
    pendingEvent: null,            // the HUD/codriver pick this up on arrival
    route: null,
    // biome transition state (set when a route into a new biome is chosen)
    prevBiome: biome, transitionS: -1e9,
    // hooks the renderer subscribes to
    onSectionAdded: null,
    onSectionRemoved: null,
    // API filled below
  };

  const gen = makeGen(seed, biome, 0, 0, 0);

  /* biome + blend for a sample index / a distance */
  function biomeAtIndex(i) {
    const m = i & MASK;
    return { biome: BIOME_LIST[BI[m]], prev: BIOME_LIST[BP[m]], t: BT[m] };
  }
  function regionAtIndex(i) {
    const m = i & MASK;
    return { region: REGION_BY_INDEX[RG[m]], prev: REGION_BY_INDEX[RP[m]], t: RT[m] };
  }
  function regionOf(s) {
    let i = Math.round(s / DS - 1);
    if (i < world.iFirst) i = world.iFirst;
    if (i >= world.iNext) i = world.iNext - 1;
    if (i < world.iFirst) return { region: regionAt(world.biome.key, 0), prev: regionAt(world.biome.key, 0), t: 1 };
    return regionAtIndex(i);
  }
  /* Region multipliers at a sample, blended across the change. */
  function regionMul(i) {
    const rr = regionAtIndex(i);
    const a = rr.prev || rr.region, b = rr.region, t = rr.t;
    if (!b) return { hills: 1, detail: 1, shape: null };
    if (t >= 1 || a === b) return { hills: b.hills, detail: b.detail, shape: b.shape || null };
    const L = (x, y) => x + (y - x) * t;
    return {
      hills: L(a.hills, b.hills),
      detail: L(a.detail, b.detail),
      shape: b.shape || a.shape ? L(a.shape || 1, b.shape || 1) : null,
    };
  }

  function biomeAt(s) {
    let i = Math.round(s / DS - 1);
    if (i < world.iFirst) i = world.iFirst;
    if (i >= world.iNext) i = world.iNext - 1;
    if (i < world.iFirst) return { biome: world.biome, prev: world.biome, t: 1 };
    return biomeAtIndex(i);
  }
  /* blended terrain parameters between two biomes */
  function terrParams(bA, bB, t) {
    if (t >= 1 || bA === bB) return bB;
    if (t <= 0) return bA;
    const L = (a, b) => a + (b - a) * t;
    return {
      ground: t < 0.5 ? bA.ground : bB.ground,
      ditch: L(bA.ditch, bB.ditch),
      terrDetail: [L(bA.terrDetail[0], bB.terrDetail[0]), L(bA.terrDetail[1], bB.terrDetail[1])],
      terrHills: [L(bA.terrHills[0], bB.terrHills[0]), L(bA.terrHills[1], bB.terrHills[1])],
      hillShape: L(bA.hillShape || 1, bB.hillShape || 1),
      waterDrop: L(bA.waterDrop, bB.waterDrop),
    };
  }

  function cellKey(x, z) { return Math.floor(x / CELL) + "," + Math.floor(z / CELL); }

  function addToCell(i) {
    const key = cellKey(X[i & MASK], Z[i & MASK]);
    let arr = cellIndex.get(key);
    if (!arr) cellIndex.set(key, (arr = []));
    arr.push(i);
  }

  function removeFromCell(i) {
    const key = cellKey(X[i & MASK], Z[i & MASK]);
    const arr = cellIndex.get(key);
    if (!arr) return;
    const at = arr.indexOf(i);
    if (at >= 0) { arr[at] = arr[arr.length - 1]; arr.pop(); }
    if (!arr.length) cellIndex.delete(key);
  }

  function addCollider(c) {
    const key = Math.floor(c.x / CELLC) + "," + Math.floor(c.z / CELLC);
    let arr = colliderHash.get(key);
    if (!arr) colliderHash.set(key, (arr = []));
    arr.push(c);
    return { key, c };
  }

  function removeCollider(ref) {
    const arr = colliderHash.get(ref.key);
    if (!arr) return;
    const at = arr.indexOf(ref.c);
    if (at >= 0) { arr[at] = arr[arr.length - 1]; arr.pop(); }
    if (!arr.length) colliderHash.delete(ref.key);
  }

  /* ------------------------------------------------------------ queries */

  function sampleNear(s) {
    let i = Math.round(s / DS - 1);
    if (i < world.iFirst) i = world.iFirst;
    if (i >= world.iNext) i = world.iNext - 1;
    if (i < world.iFirst) return null;
    const m = i & MASK;
    return {
      i, s: (i + 1) * DS,
      x: X[m], z: Z[m], y: Y[m],
      heading: HD[m], curv: KV[m], hw: HW[m], grade: GR[m],
      surf: SURF_IDS[SF[m]],
    };
  }

  function profileAt(s) {
    let i = Math.round(s / DS - 1);
    if (i < world.iFirst) i = world.iFirst;
    if (i >= world.iNext) return VCAP;
    return PROF[i & MASK];
  }

  /* Nearest-centreline search. hintS keeps association coherent where two
   * legs of the road pass close (switchbacks). Also finds the nearest
   * *other* leg so terrain between legs can blend. */
  function roadQuery(px, pz, hintS) {
    const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
    const hintI = hintS != null ? Math.round(hintS / DS - 1) : null;
    let best = -1, bestD2 = Infinity;
    let bestH = -1, bestHD2 = Infinity;
    let alt = -1, altD2 = Infinity;
    for (let radius = 1; radius <= 3 && best < 0; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const arr = cellIndex.get((cx + dx) + "," + (cz + dz));
          if (!arr) continue;
          for (let k = 0; k < arr.length; k++) {
            const i = arr[k];
            const m = i & MASK;
            const ddx = X[m] - px, ddz = Z[m] - pz;
            const d2 = ddx * ddx + ddz * ddz;
            if (d2 < bestD2) {
              if (best >= 0 && Math.abs(best - i) > 40 && bestD2 < altD2) { alt = best; altD2 = bestD2; }
              bestD2 = d2; best = i;
            } else if (d2 < altD2 && best >= 0 && Math.abs(best - i) > 40) {
              alt = i; altD2 = d2;
            }
            if (hintI != null && Math.abs(i - hintI) < 24 && d2 < bestHD2) { bestHD2 = d2; bestH = i; }
          }
        }
      }
    }
    /* The hint deliberately OVERRIDES the nearest leg. It exists for the
     * car, where "which road am I on" has to stay stable through a
     * switchback even at the moment the other leg is closer — weaken it
     * and a steep hairpin descent hands the bot to the wrong road and it
     * drives off the map. Callers that do not want that (the terrain
     * builder — see below) pass no hint at all. */
    if (bestH >= 0 && bestHD2 < 900) best = bestH;
    if (best < 0) return null;

    // refine: project onto the polyline segments around `best`
    let bi = best, bt = 0, bd2 = Infinity;
    const lo = Math.max(world.iFirst, best - 2), hi = Math.min(world.iNext - 2, best + 2);
    for (let i = lo; i <= hi; i++) {
      const m0 = i & MASK, m1 = (i + 1) & MASK;
      const ax = X[m0], az = Z[m0];
      const bx = X[m1] - ax, bz = Z[m1] - az;
      const len2 = bx * bx + bz * bz;
      let t = len2 > 0 ? ((px - ax) * bx + (pz - az) * bz) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + bx * t, qz = az + bz * t;
      const d2 = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
      if (d2 < bd2) { bd2 = d2; bi = i; bt = t; }
    }
    const m0 = bi & MASK, m1 = Math.min(world.iNext - 1, bi + 1) & MASK;
    const lerp = (A) => A[m0] + (A[m1] - A[m0]) * bt;
    const tx = Math.cos(HD[m0]), tz = Math.sin(HD[m0]);
    const qx = X[m0] + (X[m1] - X[m0]) * bt;
    const qz = Z[m0] + (Z[m1] - Z[m0]) * bt;
    const ox = px - qx, oz = pz - qz;
    const d = tx * oz - tz * ox;          // + = right of travel
    return {
      s: (bi + bt + 1) * DS,
      d,
      y: lerp(Y),
      hw: lerp(HW),
      camberT: lerp(CB),
      grade: lerp(GR),
      curv: KV[m0],
      heading: HD[m0],
      flag: FL[m0],
      surf: SURF_IDS[SF[m0]],
      i: bi,
      span: lerp(SPN), relief: lerp(RLF), wall: lerp(EVW), sub: EVS[m0],
      over: OVR[m0],
      altI: alt, altD2,
    };
  }

  /* Terrain parameters at a sample: the country's, scaled by the region.
   * (Shared by the ground function and by crossing detection, which has to
   * ask the same question — how high does the land want to be here?) */
  function terrParamsAt(i) {
    const bi = biomeAtIndex(i);
    const bBase = terrParams(bi.prev, bi.biome, bi.t);
    const rm = regionMul(i);
    const ef = EVT[i & MASK] || 1;
    if (ef === 1 && rm.hills === 1 && rm.detail === 1 && !rm.shape) return bBase;
    return {
      ...bBase,
      terrDetail: [bBase.terrDetail[0] * rm.detail * ef, bBase.terrDetail[1]],
      terrHills: [bBase.terrHills[0] * rm.hills * ef, bBase.terrHills[1]],
      hillShape: rm.shape || bBase.hillShape,
    };
  }

  /* The value-noise landscape the road was cut into, at a point beside it.
   * Expressed relative to the deck, reached over 16 m (detail) and 44 m
   * (hills), with nearby legs of road blended in so switchbacks stay
   * single-valued. The ceiling clamp lives in the caller: a tunnel wall is
   * supposed to stand over the road. */
  function landscapeY(rq, px, pz, b, ad, hw) {
    const detail = detailN(px / b.terrDetail[1], pz / b.terrDetail[1]) * b.terrDetail[0];
    let hn = hillN(px / b.terrHills[1], pz / b.terrHills[1]);
    if (b.hillShape > 1.01) hn = Math.sign(hn) * Math.pow(Math.abs(hn), 1 / b.hillShape);
    const hills = hn * b.terrHills[0];
    const reach = smoothstep((ad - hw) / 16);
    const reachFar = smoothstep((ad - hw) / 44);
    let terrY = rq.y + detail * reach + hills * reachFar;
    if (rq.altI >= 0 && rq.altD2 < 3600) {
      const am = rq.altI & MASK;
      /* A leg that is a BRIDGE there contributes no landscape — its deck
       * is standing in the air, and blending ground halfway up toward it
       * grows exactly the shelf the near-road ceiling clamp exists to
       * stop. (Tunnels keep blending: a bore is in the ground.) */
      if (SPN[am] >= 0) {
        const w = Math.max(0, 1 - Math.sqrt(rq.altD2) / 60);
        terrY = terrY * (1 - w * 0.5) + (Y[am] + detail * reach) * (w * 0.5);
      }
    }
    return terrY;
  }

  /* The ground beside a crossing.
   *
   * TUNNEL — a flat bore floor out to the wall, and then rock: the wall
   * jumps to roof height within a couple of metres so the bore is a hole
   * with sides, not a trench with a lid. Past that the natural hillside
   * takes over again (it is higher than the roof, which is why there is a
   * tunnel here at all), so the hill sits on top of the bore as one solid
   * mass. The near-road ceiling clamp is deliberately skipped.
   *
   * BRIDGE — a kerb, and then nothing. The ground falls to the valley
   * floor within about three metres of the deck edge, which is the whole
   * point of a bridge: there is no shoulder to run onto. Physics only
   * learns that the hard way if the parapet is missed, and the parapet is
   * a real collider (a visible wall, never an invisible one).
   */
  function spanProfile(rq, px, pz, b, ad, hw, edgeY) {
    const sp = rq.span;
    if (sp > 0) {
      const bore = hw + SPAN.boreHalf;
      if (ad <= bore) {
        return { y: edgeY - 0.03 - (ad - hw) * 0.02, on: "shoulder", ground: null, rq, tunnel: sp };
      }
      /* A 3 m terrain grid can draw neither a vertical face nor a roof, so
       * the bore is made of three cooperating facts: the ground stays flat
       * for a couple of metres BEHIND the wall (or alternating grid
       * vertices land inside and outside the bore and saw a row of teeth
       * along the floor), it then climbs past roof height, and the
       * renderer's roof reaches out over the climb (SPAN.roofSpread) so
       * that from inside you see wall, and from outside a hill with a hole
       * in it rather than a slab lying on the hillside. */
      const wallY = edgeY + (SPAN.roofH + SPAN.roofCover) * sp * smoothstep((ad - bore - 2.4) / 3.0);
      const nat = landscapeY(rq, px, pz, b, ad, hw);
      return { y: Math.max(nat, wallY), on: "off", ground: b.ground, rq, tunnel: sp, wall: true };
    }
    // bridge: sp < 0
    const u = -sp;
    const drop = Math.max(SPAN.minVoid, -(rq.relief || 0)) * u;
    if (ad <= hw + SPAN.kerb) {
      return { y: edgeY - (ad - hw) * 0.08, on: "shoulder", ground: null, rq, bridge: u };
    }
    const nat = landscapeY(rq, px, pz, b, ad, hw);
    const t = smoothstep((ad - hw - SPAN.kerb) / 2.2);
    const floorY = Math.min(nat, edgeY - drop);
    /* An overpass: the ground under this deck is another road's — deck,
     * shoulder and ditch, resolved from the LOWER leg rather than
     * invented from the noise. The WHOLE off-deck shape hands over as the
     * span reaches full strength (not just the floor): the ordinary
     * bridge profile eases from the kerb over a couple of metres, and
     * that ease is a skirt of terrain hanging from the deck edge — hidden
     * over a valley, but standing ON the carriageway when the edge cuts
     * across a road below. At full strength there is no skirt: the other
     * road is simply the ground, and the deck is pure structure above it. */
    if (rq.over && !rq.noCross) {
      const g2 = crossGround(rq.over - 1, px, pz, rq.i);
      if (g2) {
        if (u >= 0.999) return g2;
        const yShape = (edgeY - 0.3) * (1 - t) + floorY * t;
        const y2 = yShape * (1 - u) + g2.y * u;
        if (u > 0.5) return { y: y2, on: g2.on, ground: g2.ground, rq: g2.rq, bridge: u, voidSide: t > 0.5 };
        return { y: y2, on: "off", ground: b.ground, rq, bridge: u, voidSide: t > 0.5 };
      }
    }
    const y = (edgeY - 0.3) * (1 - t) + floorY * t;
    return { y, on: "off", ground: b.ground, rq, bridge: u, voidSide: t > 0.5 };
  }

  /* The ground of the OTHER road under a crossing: re-resolve the point
   * against the lower leg, hinted at its s so the query locks through the
   * stacked-deck ambiguity, with the crossing branch disarmed so two
   * decks can never resolve through each other. `pi` is the deck sample's
   * recorded partner — an estimate at the padded ends, so the hint walks
   * a little way along the lower leg before giving up; `deckI` is the
   * deck's own sample, which is never an acceptable answer. */
  function crossGround(pi, px, pz, deckI) {
    for (const off of [0, -24, 24, -48, 48]) {
      const q = roadQuery(px, pz, (pi + off + 1) * DS);
      if (!q) return null;
      if (Math.abs(q.i - pi) > 120) continue;                       // somewhere else entirely
      if (deckI != null && Math.abs(q.i - deckI) < 13) continue;    // resolved back onto the deck
      q.noCross = true;
      return profileFrom(q, px, pz);
    }
    return null;
  }

  /* How far above the deck the far landscape stands at a sample, and the
   * local hill amplitude the thresholds scale against. This is the only
   * input crossing detection has — geography, not decoration. */
  function reliefAtSample(i) {
    const m = i & MASK;
    const b = terrParamsAt(i);
    let hn = hillN(X[m] / b.terrHills[1], Z[m] / b.terrHills[1]);
    if (b.hillShape > 1.01) hn = Math.sign(hn) * Math.pow(Math.abs(hn), 1 / b.hillShape);
    return { rel: hn * b.terrHills[0], amp: b.terrHills[0] };
  }

  /* Ground profile given a resolved road association. Single source of
   * truth for physics, props and terrain meshes. */
  function profileFrom(rq, px, pz) {
    const ad = Math.abs(rq.d);
    const hw = rq.hw;
    const b = terrParamsAt(rq.i);
    if (ad <= hw) {
      return { y: rq.y + rq.camberT * rq.d, on: "road", ground: null, rq };
    }
    const edgeY = rq.y + rq.camberT * (rq.d > 0 ? hw : -hw);
    // waystation apron: a flat pull-off on the right that fades in and out
    // along the road so its edges never step (a step under one wheel is a
    // launch ramp to a stiff suspension)
    let apronT = 0;
    if ((rq.flag & F_WAY) && rq.d > 0) {
      for (const ap of world.aprons) {
        if (rq.s >= ap.s0 - 1 && rq.s <= ap.s1 + 1) { apronT = smoothstep(Math.min(rq.s - ap.s0, ap.s1 - rq.s) / 18); break; }
      }
    }
    if (apronT >= 0.999) {
      if (ad <= hw + 19) return { y: edgeY - 0.02, on: "road", ground: null, rq, apron: true };
      if (ad <= hw + 21) return { y: edgeY - (ad - hw - 19) * 0.15, on: "shoulder", ground: null, rq };
    }
    /* Crossings. Inside a span the road is not sitting ON the landscape,
     * it is passing THROUGH it or OVER it, so the ordinary verge → ditch →
     * hillside profile is simply the wrong shape and has to stand aside. */
    if (rq.span) {
      const g = spanProfile(rq, px, pz, b, ad, hw, edgeY);
      if (g) return g;
    }
    if (ad <= hw + 1.1) {
      return { y: edgeY - (ad - hw) * 0.1, on: "shoulder", ground: null, rq };
    }
    // water on the flagged side: a lake a step below the road, or the sea a
    // long way below a cliff — the drop says which
    const lakeSide = (rq.flag & F_LAKE_L) ? -1 : (rq.flag & F_LAKE_R) ? 1 : 0;
    if (lakeSide !== 0 && Math.sign(rq.d) === lakeSide && ad > hw + 3.5) {
      const drop = Math.max(1.2, b.waterDrop);
      const run = drop > 4 ? 9 : 6;                     // cliffs fall faster
      const lakeY = rq.y - drop;
      const t = smoothstep((ad - hw - 3.5) / run);
      const shape = drop > 4 ? Math.pow(t, 0.6) : t;    // cliff: convex lip, then plunge
      const y = edgeY - 0.1 - shape * (edgeY - 0.1 - lakeY);
      return { y, on: "off", ground: t > 0.85 ? "water" : b.ground, rq, water: t > 0.85 };
    }
    // ditch, then landscape (hillShape > 1 flattens tops into mesas)
    const dd = ad - hw - 1.1;
    const dip = dd < 2.2 ? Math.sin(Math.min(1, dd / 2.2) * Math.PI) * b.ditch : 0;
    /* The landscape, with nearby legs blended in (see landscapeY) — but
     * never let that blend lift the ground ABOVE the deck it is beside:
     * pulled halfway toward a leg twenty metres higher up the hill, the
     * terrain grew a shelf that hung over the lower road — the "texture
     * floating above the road". Ground next to a road is at most a kerb
     * higher than that road, and beyond a few metres it is free again. */
    let terrY = landscapeY(rq, px, pz, b, ad, hw);
    const nearRoad = smoothstep(1 - (ad - hw) / 26);
    if (nearRoad > 0) {
      const ceiling = edgeY + 1.6 + (1 - nearRoad) * 40;
      if (terrY > ceiling) terrY = ceiling;
    }
    const t = smoothstep(dd / 14);
    let y = (edgeY - 0.11 - dip) * (1 - t) + terrY * t;
    /* Canyon walls. Same shape as a tunnel bore with the roof taken off,
     * and the same lesson applies: the rise starts a few metres out so the
     * 3 m terrain grid has somewhere to put the transition, and it is a
     * MAX rather than a replacement, so a wall never digs a hole in ground
     * that was already higher than it. */
    if (rq.wall > 0) {
      const start = hw + 3.4;
      if (ad > start) y = Math.max(y, edgeY + rq.wall * smoothstep((ad - start) / 5.5));
    }
    if (apronT > 0 && ad <= hw + 21) {
      // partial apron: lift the natural ground toward the flat pull-off
      const apY = ad <= hw + 19 ? edgeY - 0.02 : edgeY - (ad - hw - 19) * 0.15;
      y = y * (1 - apronT) + apY * apronT;
      return { y, on: apronT > 0.5 ? "shoulder" : "off", ground: b.ground, rq };
    }
    /* The Old Road (hidden roads): within its band the ground rides flat
     * just under deck height and answers "shoulder" — cracked old tarmac
     * drives like a rough shoulder, which is what taking the unmarked line
     * should feel like. Both ramps are smooth (the salt-flat lesson: a
     * flatten with a hard edge is a cliff): strength eases along the road
     * via OLDK, the bed eases across its own edges here. */
    const oldLat = OLD[rq.i & MASK];
    if (oldLat !== 0 && Math.sign(rq.d) === Math.sign(oldLat)) {
      const across = Math.abs(ad - Math.abs(oldLat));
      if (across < 8) {
        const bandT = smoothstep((5.2 - across) / 2.8) * (OLDK[rq.i & MASK] || 0);
        if (bandT > 0.01) {
          const bedY = rq.y - 0.4;
          y = y * (1 - bandT) + bedY * bandT;
          if (bandT > 0.85 && across < 3.6) return { y, on: "shoulder", ground: null, rq, oldRoad: true };
        }
      }
    }
    return { y, on: "off", ground: b.ground, rq };
  }

  function groundHeight(px, pz, hintS) {
    const rq = roadQuery(px, pz, hintS);
    if (!rq) return null;
    return profileFrom(rq, px, pz);
  }

  /* Ground at a KNOWN sample + lateral offset — used by prop placement and
   * terrain vertices that already know their leg (never re-derived by
   * proximity, so far verts can't grab the wrong leg's elevation). */
  function groundAtSample(i, lat) {
    if (i < world.iFirst || i >= world.iNext) return null;
    const m = i & MASK;
    const rx = -Math.sin(HD[m]), rz = Math.cos(HD[m]);
    const px = X[m] + rx * lat, pz = Z[m] + rz * lat;
    const rq = {
      s: (i + 1) * DS, d: lat, y: Y[m], hw: HW[m], camberT: CB[m],
      grade: GR[m], curv: KV[m], heading: HD[m], flag: FL[m],
      surf: SURF_IDS[SF[m]], i, span: SPN[m], relief: RLF[m], wall: EVW[m], sub: EVS[m],
      over: OVR[m],
      altI: -1, altD2: Infinity,
    };
    const g = profileFrom(rq, px, pz);
    g.x = px; g.z = pz;
    return g;
  }

  /* The landscape far beyond roadQuery's cell-hash corridor, for the
   * renderer's FAR SHELL — the coarse ground that keeps the world from
   * visibly ending at the blanket's edge. Same noise fields, same blended
   * terrain parameters as landscapeY, evaluated AT the point with reach
   * saturated (the shell only exists past the corridor, where reach is 1
   * anyway), and relative to the nearest live road sample's elevation so
   * the two surfaces agree where they meet. None of profileFrom's
   * near-road shaping (ditches, aprons, walls, ceiling clamps) — all of
   * that lives inside the corridor the near blanket owns.
   *
   * RENDER-ONLY by contract: nothing in the sim may ever read this. */
  function nearestSampleFar(px, pz, hintI) {
    let best = -1, bestD2 = Infinity;
    if (hintI != null && hintI >= world.iFirst && hintI < world.iNext) {
      /* refine around a caller-supplied neighbour (the far cell's centre)
       * — a shell vertex sits within ~70 m of its cell centre, so ±96
       * samples (240 m of road) around the centre's own nearest is
       * enough, and skipping the full ring scan here is what keeps a
       * cell build off the frame budget */
      const lo = Math.max(world.iFirst, hintI - 96), hi = Math.min(world.iNext - 1, hintI + 96);
      // even indices only: the blanket and the shell hint differently and
      // must still land on the SAME sample, or their surfaces disagree
      for (let i = lo + (lo & 1); i <= hi; i += 2) {
        const m = i & MASK;
        const dx = X[m] - px, dz = Z[m] - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      return best;
    }
    // coarse scan of the whole live ring (a stride of 16 = 40 m of road)
    for (let i = world.iFirst; i < world.iNext; i += 16) {
      const m = i & MASK;
      const dx = X[m] - px, dz = Z[m] - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    if (best < 0) return -1;
    const lo = Math.max(world.iFirst, best - 16), hi = Math.min(world.iNext - 1, best + 16);
    for (let i = lo; i <= hi; i++) {
      const m = i & MASK;
      const dx = X[m] - px, dz = Z[m] - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    return best;
  }

  function farGround(px, pz, nearI) {
    if (nearI < world.iFirst || nearI >= world.iNext) return null;
    const m = nearI & MASK;
    const b = terrParamsAt(nearI);
    const detail = detailN(px / b.terrDetail[1], pz / b.terrDetail[1]) * b.terrDetail[0];
    let hn = hillN(px / b.terrHills[1], pz / b.terrHills[1]);
    if (b.hillShape > 1.01) hn = Math.sign(hn) * Math.pow(Math.abs(hn), 1 / b.hillShape);
    let y = Y[m] + detail + hn * b.terrHills[0];
    /* a lake (or the sea) on the flagged side holds its level out into the
     * shell: where the hills dip below it there is water, where they rise
     * there is shore — the noise draws the far bank */
    let water = false;
    const lakeSide = (FL[m] & F_LAKE_L) ? -1 : (FL[m] & F_LAKE_R) ? 1 : 0;
    if (lakeSide !== 0) {
      const rx = -Math.sin(HD[m]), rz = Math.cos(HD[m]);
      const lat = (px - X[m]) * rx + (pz - Z[m]) * rz;
      if (Math.sign(lat) === lakeSide) {
        const lakeY = Y[m] - Math.max(1.2, b.waterDrop);
        if (y < lakeY + 0.5) { y = lakeY; water = true; }
      }
    }
    return { y, water, s: (nearI + 1) * DS, rel: y - Y[m], i: nearI };
  }

  /* ----------------------------------------------------- section intake */

  /* Self-intersection.
   *
   * The old rule exempted the last 150 m of road outright, on the grounds
   * that a corner must be allowed to come back past itself. That is true
   * of an arc a few dozen metres long, and wildly over-generous at 150:
   * a steep technical descent could spiral, stacking one deck two and a
   * half metres beside another and three metres below it. Everything
   * downstream then misbehaves in ways that look like other bugs — trees
   * placed legitimately beside the upper road stand in the middle of the
   * lower one, and a collider three metres overhead is inside the
   * physics' vertical window, so the car hits a spruce that is above it.
   *
   * A hairpin is ~13–19 samples of arc plus its eases, so 20 samples of
   * exemption is all any single corner needs. Between there and 60 the
   * road may still double back — that is what a switchback IS — but it has
   * to leave 15 m, or 8 m of height, which is what makes the two legs read
   * as two roads. Past 60 samples the old 26 m stands.
   *
   * Separation is measured between THE TWO SAMPLES, not from the head of
   * the ring. Using `iNext - i` looks equivalent and is not: a sample 30
   * behind when it was laid becomes 90 behind two sections later, so a
   * pairing that was legal at generation time silently becomes illegal,
   * and the generator can find itself standing somewhere no new section
   * can legally start from. Every candidate then fails and the rescue has
   * nowhere to go. `(iNext + j) - i` is a fact about the pair and never
   * changes. */
  /* The vertical exemption, with the WALL in mind (hands-on #5: "the road
   * leads right into a mountain"). Nine metres of height clears a tree and
   * the collision window — but the terrain blanket is a HEIGHTFIELD, one y
   * per (x,z), and between two near-PARALLEL legs it must draw the whole
   * cliff joining them. Measured on a real seed: legs 7.7 m apart in XZ
   * with 20.8 m of height put a fifteen-metre wall face across the lower
   * deck. So the exemption now asks what kind of pairing this is:
   *  - TRANSVERSE (a genuine crossing): brief overlap, findCrossings lays
   *    a bridge, and the blanket resolves the space under it (OVR) —
   *    exempt on angle alone, any lateral distance, as before.
   *  - NEAR-PARALLEL (a stacked switchback run): the wall between the
   *    decks needs ground to stand on — the pair must ALSO be far enough
   *    apart in XZ that the face stands off the lower road. Shallow-angle
   *    crossings fail both tests on purpose: their bridges were the long
   *    ugly ones, and the generator finds a steeper line. */
  function vertClear(hdA, hdB, dyRaw, d2xz, k) {
    const dy = Math.abs(dyRaw);
    if (dy <= 9) return false;
    if (Math.abs(Math.sin(hdA - hdB)) >= 0.57) return true;   // ≳ 35°: a crossing
    /* scaled by the rescue's relax factor like every other separation rule
     * — an escape valve that doesn't open is not a valve (seed 87 of the
     * 400-sweep proved it: trapped generator, one unvalidated section) */
    const need = (12 + 0.5 * (dy - 9)) * (k || 1);
    return d2xz >= need * need;
  }

  function validateSection(sec, relax) {
    const k = relax || 1;
    /* Step 2 for speed, but the LAST sample is checked whatever the
     * parity: it is where the next section starts from, so leaving it
     * unchecked can park the generator somewhere no section can legally
     * begin — and then every candidate fails and the rescue has nowhere
     * to go. (One seed in fifty, thirteen kilometres in.) */
    /* ...and against ITSELF. A section is up to 600 m of road and can
     * perfectly well come back past its own beginning — which is how a
     * road ended up running 2.8 m from itself with five metres of height
     * between: both samples belonged to the same candidate, so neither was
     * ever compared to the other, and the generator then stood at the end
     * of it in a spot where no following section could legally start. */
    const selfCells = new Map();
    for (let j = 0; j < sec.n; j = (j + 2 < sec.n || j === sec.n - 1) ? j + 2 : sec.n - 1) {
      const px = sec.xs[j], pz = sec.zs[j], py = sec.ys[j];
      const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const own = selfCells.get((cx + dx) + "," + (cz + dz));
        if (own) {
          for (const j2 of own) {
            const back = j - j2;
            if (back < 20) continue;
            const ddx = sec.xs[j2] - px, ddz = sec.zs[j2] - pz;
            const near = (back < 60 ? 14 : back < 140 ? 20 : 26) * k;
            const d2s = ddx * ddx + ddz * ddz;
            if (d2s >= near * near) continue;
            if (vertClear(sec.hd[j], sec.hd[j2], sec.ys[j2] - py, d2s, k)) continue;
            return false;
          }
        }
        const arr = cellIndex.get((cx + dx) + "," + (cz + dz));
        if (!arr) continue;
        for (const i of arr) {
          const back = (world.iNext + j) - i;
          if (back < 20) continue;                 // the corner we are in
          const m = i & MASK;
          const ddx = X[m] - px, ddz = Z[m] - pz;
          const d2 = ddx * ddx + ddz * ddz;
          /* The further apart two pieces of road are along the road, the
           * further apart they have to be on the ground — a switchback is
           * legitimate, a spiral is not. */
          const near = (back < 60 ? 14 : back < 140 ? 20 : 26) * k;
          if (d2 >= near * near) continue;
          /* ...unless one is properly above the other AND the pairing is
           * one the world can actually draw — see vertClear above. (The
           * transverse half is the exemption a real bridge over a lower
           * leg needs — 7a.2.) */
          if (vertClear(sec.hd[j], HD[m], Y[m] - py, d2, k)) continue;
          return false;
        }
      }
      const key = cx + "," + cz;
      let bucket = selfCells.get(key);
      if (!bucket) selfCells.set(key, (bucket = []));
      bucket.push(j);
    }
    return true;
  }

  /* Nothing may stand on a road — ANY road, not just the one it was
   * measured from.
   *
   * Props are placed perpendicular to a sample: `lat = hw + margin + …`,
   * which guarantees they clear their OWN piece of road and guarantees
   * nothing at all about the piece fifteen metres further on. Where the
   * road switches back tightly and drops at the same time, a spruce set
   * 3.2 m off the inside of one corner lands in the middle of the next
   * one, two metres lower — a tree growing out of the racing line, and a
   * 24 m/s impact for a bot that was under the pace and on the deck.
   *
   * One nearest-leg query per prop settles it. `roadQuery` with no hint
   * finds the closest centreline anywhere nearby, so this is the general
   * statement of the rule the recovery corridors were only ever making
   * locally: the road and its shoulder belong to the car. */
  function clearOfRoad(px, pz, clear) {
    const q = roadQuery(px, pz, null);
    return !q || Math.abs(q.d) > q.hw + (clear == null ? 1.8 : clear) + 0.35;
  }
  /* The same question asked about a whole prop rather than a point. */
  function propClearOfRoad(p, aligned) {
    const q = roadQuery(p.x, p.z, null);
    if (!q) return true;
    const need = propClearance(p.type, p.scale, q.curv, aligned);
    return Math.abs(q.d) > q.hw + need + 0.35;
  }

  /* ------------------------------------------------ the old road (hidden)
   *
   * Phase 11's "hidden roads that exist only if you take an unmarked
   * line", built honestly: beside a rare ordinary straight lies a strip of
   * abandoned roadbed — flat, drivable, faded slabs, a few pickups — and
   * NOTHING announces it. No note, no call, no banner: the discovery is
   * looking sideways at the right moment and taking the line. The strip's
   * ground is the profile's business (the OLD/OLDK rings), its keep-out is
   * placeProps', its furniture is laid at record creation, and the diary
   * quietly remembers a strip actually driven (main.js). Deterministic per
   * (seed, sectionIndex), like every other fact about the road. */
  function findOldRoad(sec, i0) {
    if (sec.sectionIndex < 3 || sec.eventRec || sec.waystationS != null) return;
    if (sec.spans && sec.spans.length) return;
    const r = rng(hashCombine(seed, 0x01dc + sec.sectionIndex * 13));
    /* spacing promise (2026-08-31): a flat one-in-six per eligible section
     * left whole journeys without a strip; past eight kilometres since the
     * last one the odds jump, so "hidden" never quietly becomes "absent" */
    const since = (i0 + 1) * DS - (world.lastOldRoadS == null ? -1e9 : world.lastOldRoadS);
    if (!r.chance(since > 8000 ? 0.45 : 0.16)) return;
    /* an eligible run: straight-ish, gentle land (an old road survived
     * where the land let it), no water, no aprons, no crossings */
    const need = 100;
    let j0 = -1, run = 0;
    for (let j = 0; j < sec.n; j++) {
      const m = (i0 + j) & MASK;
      const ok = Math.abs(KV[m]) < 1 / 240 && Math.abs(RLF[m]) < 6
        && !(FL[m] & (F_LAKE_L | F_LAKE_R | F_WAY | F_SPAN)) && !EVW[m];
      if (ok) { if (run === 0) j0 = j; run++; if (run >= need + 50) break; }
      else run = 0;
    }
    if (run < need) return;
    const j1 = j0 + Math.min(run, 150) - 1;
    const side = r.chance(0.5) ? 1 : -1;
    const lat = side * (HW[(i0 + j0) & MASK] + 11 + r() * 4);
    for (let j = j0; j <= j1; j++) {
      const m = (i0 + j) & MASK;
      OLD[m] = lat;
      OLDK[m] = smoothstep(Math.min(j - j0, j1 - j) / 24);
    }
    sec.oldRoad = { s0: (i0 + j0 + 1) * DS, s1: (i0 + j1 + 1) * DS, lat };
    world.oldRoads.push(sec.oldRoad);
    world.lastOldRoadS = sec.oldRoad.s1;
    if (world.oldRoads.length > 12) world.oldRoads.shift();
  }

  function placeProps(sec, i0) {
    const b = sec.biome;
    const r = rng(hashCombine(seed, 0x9c0 + sec.sectionIndex));
    const props = [];
    const colliderRefs = [];
    const sStart = (i0 + 1) * DS;
    const sEnd = sStart + sec.n * DS;

    /* "Never from a rock two feet past a blind crest." Where the profile
     * says the car is light or flying — over a brow, off a jump — it
     * cannot swerve and cannot see, so the verge there keeps a landing
     * corridor: no boulders at all, and the trees stand further back. The
     * bible states the sentence outright; this is the generator obeying it. */
    const blind = [];
    const blindFrom = (feats) => {
      for (const f of feats || []) {
        if (f.kind === "jump") blind.push([f.s - 12, f.s + 70]);
        else if (f.kind === "crest") blind.push([f.s - 8, f.s + 34]);
      }
    };
    blindFrom(sec.feats);
    // a brow in the last metres of the previous section blinds THIS one's
    // first metres — zones do not respect section boundaries
    const prevSec = world.sections[world.sections.length - 1];
    if (prevSec) blindFrom(prevSec.feats);
    const inBlind = (s) => {
      for (const z of blind) if (s >= z[0] && s <= z[1]) return true;
      return false;
    };

    // nothing stands ON the old road: taking the unmarked line must find
    // a drivable strip, not a tree that spawned across it
    const onOldRoad = (m, lat) => {
      const ol = OLD[m];
      return ol !== 0 && Math.sign(lat) === Math.sign(ol) && Math.abs(Math.abs(lat) - Math.abs(ol)) < 8;
    };

    /* Vegetation follows the region, not just the country: the deep forest
     * closes in, the high moor is bare, the wash fills with scrub. Stepping
     * by the region's own spacing means density changes are real spacing
     * changes, not just a gate. */
    const regStep = (sMid) => {
      const rr = regionOf(sMid);
      const a = rr.prev || rr.region, c = rr.region, t = rr.t;
      const L = (x, y) => x + (y - x) * t;
      return { step: L(a.step, c.step), trees: L(a.trees, c.trees), rock: L(a.rock, c.rock) };
    };
    for (let s = sStart; s < sEnd; s += b.treeStep * regStep(s).step) {
      const i = Math.round(s / DS - 1);
      const m = i & MASK;
      const flags = FL[m];
      // nothing grows on a bridge deck or inside a tunnel
      if (flags & F_SPAN) continue;
      const reg = regStep(s);
      // in a transition, trees come from whichever country this sample is
      // mostly in — the mix itself is the geography changing
      const bi = biomeAtIndex(i);
      const bHere = bi.t < 1 && r() > bi.t ? bi.prev : bi.biome;
      /* a region may plant its own species (a burn is snags, a planted
       * avenue is one tree): the list follows whichever region the sample
       * is mostly in, and only for the sample's own country */
      const rrT = regionOf(s);
      const regHere = rrT.t >= 0.5 || !rrT.prev ? rrT.region : rrT.prev;
      const treeTypes = regHere && regHere.treeTypes && bHere === bi.biome ? regHere.treeTypes : bHere.trees;
      const lakeSide = (flags & F_LAKE_L) ? -1 : (flags & F_LAKE_R) ? 1 : 0;
      // cliff coasts: a low stone wall along the water side (with colliders)
      if (b.walls && lakeSide !== 0 && !(flags & F_WAY) && ((i - i0) % 2 === 0)) {
        const gW = groundAtSample(i, lakeSide * (HW[m] + 1.9));
        if (gW && !gW.water && clearOfRoad(gW.x, gW.z, propClearance("wall", 1, KV[m], true))) {
          props.push({ type: "wall", s, x: gW.x, y: gW.y, z: gW.z, scale: 1, rot: -HD[m] });
          colliderRefs.push(addCollider({ x: gW.x, y: gW.y, z: gW.z, r: 0.6 }));
        }
      }
      for (let side = -1; side <= 1; side += 2) {
        if ((flags & F_WAY) && side === 1) continue;     // the apron is clear
        /* Clumped forest: a noise gate opens and closes groves. One octave
         * at a single wavelength gave the forest a heartbeat — groves and
         * clearings at a steady 34 m, visible as density waves down the
         * road. Two octaves at an awkward ratio, and the groves come in
         * the sizes a forest actually has. */
        const gate = clumpN(s / 67, side * 13.7) * 0.64 + clumpN(s / 21.3, side * 5.1) * 0.36;
        if (gate < 1 - Math.min(0.98, bHere.treeDensity * reg.trees) * 2) continue;
        /* recovery corridor: the outside of a real corner gets a wider
         * tree-free margin — running wide should cost time, not the run */
        const k = KV[m];
        const outside = Math.sign(-k);      // +curv turns right → outside is left
        let margin = 3.2;
        if (Math.abs(k) > 0.0025 && side === outside) {
          margin = 3.2 + Math.min(6, Math.abs(k) * 900);
        }
        if (inBlind(s)) margin = Math.max(margin, 6.5);   // landing corridor
        const pick = r.weighted(treeTypes.map(([t, w]) => ({ t, w }))).t;
        const scale = r.range(0.8, 1.45);
        // a big tree's canopy reaches further than its trunk: stand it back
        const depth = Math.abs(clumpN(s / 13.7, side * 7.3) * 0.7 + clumpN(s / 4.3, side * 19.1) * 0.3);
        const lat = side * (HW[m] + margin + scale * 1.1 + depth * 34);
        if (lakeSide === side && Math.abs(lat) > HW[m] + 3) continue;   // no trees in the lake
        if (onOldRoad(m, lat)) continue;
        const g = groundAtSample(i, lat);
        if (!g || g.water || !clearOfRoad(g.x, g.z, propClearance(pick, scale, KV[m], false))) continue;
        props.push({ type: pick, s, x: g.x, y: g.y, z: g.z, scale, rot: r() * Math.PI * 2, biome: bHere.key });
        if (Math.abs(lat) < HW[m] + 13) {
          const solid = pick === "shrub" ? 0.3 : pick === "cactus" ? 0.35 : 0.5;
          colliderRefs.push(addCollider({ x: g.x, y: g.y, z: g.z, r: solid * scale + 0.12 }));
        }
      }
      // occasional roadside boulder — kept honest: never on the racing line,
      // never on the apron, and never in a blind zone, where the car parks
      // itself or flies and in either case cannot swerve. An event can
      // clear them outright (the avalanche's plows did): a drift two metres
      // wide on snow ending on a boulder is a wall the road put there
      if (r.chance(b.rockP * reg.rock * b.treeStep / 30) && !inBlind(s)
        && !(sec.event && sec.event.clearRocks)) {
        const side = r.chance(0.5) ? -1 : 1;
        const lat = side * (HW[m] + r.range(2.2, 4.5));
        const g = (flags & F_WAY) && side === 1 || onOldRoad(m, lat) ? null : groundAtSample(i, lat);
        const rkType = b.rockType || "rock";
        const scale = r.range(0.7, 1.6);
        if (g && !g.water && clearOfRoad(g.x, g.z, propClearance(rkType, scale, KV[m], false))) {
          props.push({ type: rkType, s, x: g.x, y: g.y, z: g.z, scale, rot: r() * Math.PI * 2, biome: b.key });
          colliderRefs.push(addCollider({ x: g.x, y: g.y, z: g.z, r: 0.62 * scale }));
        }
      }
      // desert mesas: big flat-topped blocks far off the road, on the horizon side
      if (b.mesaP && r.chance(b.mesaP * b.treeStep / 120)) {
        const side = r.chance(0.5) ? -1 : 1;
        const lat = side * r.range(70, 130);
        const g = groundAtSample(i, lat);
        if (g) props.push({ type: "mesa", s, x: g.x, y: g.y - 2, z: g.z, scale: r.range(0.8, 1.7), rot: r() * Math.PI * 2, biome: b.key, noSeat: true });
      }
    }

    /* ---- region marks: the things people built here.
     *
     * Vegetation already says what the climate is. This says the road goes
     * somewhere — a boathouse means a boat, a cairn means somebody crossed
     * this moor in fog, a run of snow poles means the road is driven in
     * winter. Two placement rhythms, because they are two different
     * things: scattered (a landmark now and then) and LINED (poles, fences
     * and terrace walls, which are only convincing when they are regular —
     * scattered, the same objects read as litter).
     *
     * Marks obey the same rules as everything else beside the road: never
     * on the racing line, never inside a crossing, never on the apron, and
     * a wider berth on the outside of a real corner. */
    const markR = rng(hashCombine(seed, 0x3a71 + sec.sectionIndex));
    const lastMarkS = {};     // per type+side: where the last one stood (mark.gap)
    const uphillAt = (i) => {
      const gL = groundAtSample(i, -(HW[i & MASK] + 12));
      const gR = groundAtSample(i, HW[i & MASK] + 12);
      if (!gL || !gR) return 1;
      return gL.y > gR.y ? -1 : 1;
    };
    const placeMark = (i, mark, side) => {
      /* markStats: one counter per rejection reason, per mark type — a
       * mark that silently never places is the most invisible kind of
       * broken (the kerbs, the raillines, now the snowfences), and this
       * is the print statement that finds it in one run. */
      const stat = (why) => {
        const st = world.markStats[mark.type] || (world.markStats[mark.type] = {});
        st[why] = (st[why] || 0) + 1;
        return why === "ok";
      };
      const m = i & MASK;
      if (FL[m] & (F_WAY | F_SPAN)) return stat("span");
      /* Some built things belong ON the deck — rails over the road, a
       * cattle grid. Flat, drivable, road-aligned, no collider, and no
       * clearance test, because overlapping the road is the entire idea. */
      if (mark.onRoad) {
        const g = groundAtSample(i, 0);
        if (!g) return stat("noground");
        props.push({
          type: mark.type, s: (i + 1) * DS, x: g.x, y: g.y, z: g.z,
          scale: 1, rot: -HD[m], biome: sec.biome.key,
        });
        return stat("ok");
      }
      const k = KV[m];
      const outside = Math.sign(-k);
      /* Deck furniture (`hug`): kerbs and cones BELONG at the road's edge —
       * flat, paint-height, meant to be clipped by a wheel. The recovery
       * berth that keeps trees off a corner exit was shoving every outside
       * kerb five metres into the grass (and the inside row failed the
       * clearance test and never placed at all — the Old Circuit ran that
       * way, unnoticed, until the stadium's hairpin made it obvious). Hug
       * marks skip the berth, skip the clearance test, and never get a
       * collider — an invisible wall painted like a kerb is exactly the
       * wall the bible forbids. */
      const hug = !!mark.hug;
      /* `noBerth`: structure that BELONGS at a fixed offset (a gallery's
       * colonnade) — the corner berth would scatter its rhythm. It keeps
       * its collider: a visible pillar is the wall the bible allows. */
      const extra = !hug && !mark.noBerth && Math.abs(k) > 0.0025 && side === outside ? Math.min(5, Math.abs(k) * 700) : 0;
      const near = mark.lat[0] + (mark.lat[1] - mark.lat[0]) * markR();
      const lat = side * (HW[m] + near + extra);
      if (onOldRoad(m, lat)) return stat("oldroad");
      const g = groundAtSample(i, lat);
      if (!g) return stat("noground");
      const wantsWater = mark.side === "water";
      if (!wantsWater && g.water) return stat("water");
      const scale = 0.9 + markR() * 0.28;
      if (!hug && !clearOfRoad(g.x, g.z, propClearance(mark.type, scale, KV[m], !!mark.line))) return stat("clearance");
      const s = (i + 1) * DS;
      /* `gap`: houses need elbow room — two cabins through each other read
       * as one broken building. Per type and side; a rejected site above
       * never spends the gap. */
      if (mark.gap) {
        const gk = mark.type + side;
        if (lastMarkS[gk] != null && s - lastMarkS[gk] < mark.gap) return stat("gap");
        lastMarkS[gk] = s;
      }
      /* `facing`: a built structure that must square up to the road (a
       * grandstand, a barrier) — a random rotation reads as dropped, not
       * built. Scattered landmarks keep their random settle. `facing:
       * "road"` also turns the thing's FRONT (+Z in the part frame) toward
       * the deck on either side — a house looks at its street. */
      props.push({
        type: mark.type, s, x: g.x, y: g.y, z: g.z,
        scale, rot: mark.facing === "road" ? -HD[m] + (side > 0 ? Math.PI : 0)
          : (mark.line || mark.facing) ? -HD[m] : markR() * Math.PI * 2,
        biome: sec.biome.key, cr: mark.colliderR,
      });
      /* snowblock is avalanche debris: a chunk of compacted snow YIELDS —
       * clipping one is a scrub, not a wall. A field of hard colliders
       * beside a snow lane turned every wide moment into a wedge. */
      const armed = !hug && !UNARMED_MARKS.has(mark.type);
      /* `colliderR`: a building's real footprint (a house is not a post) */
      const cr = mark.colliderR || 0.7;
      if (armed && Math.abs(lat) < HW[m] + 9 + cr) {
        colliderRefs.push(addCollider({ x: g.x, y: g.y, z: g.z, r: cr }));
      }
      /* CLUSTER (hands-on #5: "things like haybales should be clustered,
       * not just randomly around") — where reality groups objects (bales
       * in a worked field, peat stacks along a cutting, racks by the
       * shore, a wood stack or two together), the mark stands a small
       * group around the anchor instead of a lone object. One shared lean
       * across the group's rotations (bales come off the baler parallel),
       * a jitter each; every satellite passes the same road and water
       * rules as the anchor. Satellites draw only from markR — the marks'
       * own derived stream — so nothing else in the world moves. */
      if (mark.cluster && !mark.line && !mark.onRoad && !hug) {
        const [lo, hi, rad] = mark.cluster;
        const n = lo + Math.floor(markR() * (hi - lo + 1));
        const baseRot = markR() * Math.PI * 2;
        for (let c = 0; c < n; c++) {
          const ang = markR() * Math.PI * 2;
          const dist = rad * (0.3 + 0.7 * Math.sqrt(markR()));
          const sx = g.x + Math.cos(ang) * dist, sz = g.z + Math.sin(ang) * dist;
          const cScale = 0.86 + markR() * 0.3;
          const rotJit = (markR() - 0.5) * 0.6;
          const gs = groundHeight(sx, sz, null);
          if (!gs || (!wantsWater && gs.water)) continue;
          if (!clearOfRoad(sx, sz, propClearance(mark.type, cScale, KV[m], false))) continue;
          /* a satellite honours the anchor's berth: drifting road-ward of
           * it would stand a bale in the corner's run-off — the wall the
           * berth exists to prevent */
          if (gs.rq && Math.abs(gs.rq.d) < HW[m] + mark.lat[0] + extra) continue;
          props.push({
            type: mark.type, s, x: sx, y: gs.y, z: sz,
            scale: cScale, rot: baseRot + rotJit, biome: sec.biome.key,
          });
          if (armed && Math.abs(lat) < HW[m] + 9 + rad) {
            colliderRefs.push(addCollider({ x: sx, y: gs.y, z: sz, r: 0.7 }));
          }
        }
      }
      return stat("ok");
    };
    const onceDone = new Set();
    for (let s = sStart; s < sEnd; s += 6) {
      /* An event's own marks REPLACE the region's for as long as it runs —
       * a wind farm is not a place that also happens to have cairns. */
      const rr = regionOf(s);
      const marks = (sec.event && sec.event.marks)
        || (rr.region && rr.region.marks && !(rr.t < 0.5 && rr.prev && rr.prev.marks !== rr.region.marks) ? rr.region.marks : null);
      if (!marks) continue;
      const i = Math.round(s / DS - 1);
      if (i < world.iFirst || i >= world.iNext) continue;
      const m = i & MASK;
      for (const mark of marks) {
        /* A hero landmark: exactly one, at a chosen point through the
         * section — and it RETRIES until it stands. The old six-metre
         * window silently swallowed the hero if its one chance fell on a
         * span or failed clearance; an observatory that is the point of
         * the event cannot be allowed to just not happen. A water-sided
         * hero (a wreck) additionally waits for real frontage. */
        if (mark.once != null) {
          const at = sStart + (sEnd - sStart) * mark.once;
          if (s <= at || onceDone.has(mark)) continue;
          let side;
          if (mark.side === "water") {
            side = (FL[m] & F_LAKE_L) ? -1 : (FL[m] & F_LAKE_R) ? 1 : 0;
            if (!side) continue;                 // keep walking to the shore
          } else side = mark.side === "uphill" ? uphillAt(i) : mark.side === "downhill" ? -uphillAt(i) : markR.chance(0.5) ? -1 : 1;
          if (placeMark(i, mark, side)) onceDone.add(mark);
          continue;
        }
        // kerbs belong on corners, not on straights
        if (mark.onCorner && Math.abs(KV[m]) < mark.onCorner) continue;
        if (mark.line) {
          // a regular run: place on the exact grid so the rhythm is real
          if (Math.round(s / 6) % Math.max(1, Math.round(mark.line / 6)) !== 0) continue;
          const sides = mark.onRoad ? [1]        // a roof spans the deck once, not per side
            : mark.side === "uphill" ? [uphillAt(i)]
              : mark.side === "downhill" ? [-uphillAt(i)]
              : mark.side === "water" ? [(FL[m] & F_LAKE_L) ? -1 : (FL[m] & F_LAKE_R) ? 1 : 0]
                : [-1, 1];
          for (const side of sides) if (side) placeMark(i, mark, side);
        } else {
          if (!markR.chance((mark.perKm * 6) / 1000)) continue;
          let side;
          if (mark.side === "water") {
            side = (FL[m] & F_LAKE_L) ? -1 : (FL[m] & F_LAKE_R) ? 1 : 0;
            if (!side) continue;
          } else if (mark.side === "uphill") side = uphillAt(i);
          else if (mark.side === "downhill") side = -uphillAt(i);
          else side = markR.chance(0.5) ? -1 : 1;
          placeMark(i, mark, side);
        }
      }
    }

    /* Crossings get the one thing that makes them safe to drive: an edge
     * you can feel. A bridge parapet and a tunnel wall are the same object
     * to physics — a line of colliders at deck height, close enough
     * together that a car cannot thread between two of them. They are also
     * the one kind of wall the bible allows, because they are visible: the
     * renderer draws exactly this line. */
    for (const span of sec.spans || []) spanColliders(span, colliderRefs);

    // waystation structure at the apron's middle, set back on the right
    if (sec.waystationS != null) {
      const i = Math.round(sec.waystationS / DS - 1);
      const m = i & MASK;
      const g = groundAtSample(i, HW[m] + 14.5);
      if (g) {
        /* the shed sits ON THE CONCRETE, at the apron's own height (road
         * edge − 2 cm). The sample above runs before this section's apron
         * is registered a page below, so its y is the NATURAL hillside —
         * which the apron then flattens away, leaving the building
         * floating above its pad (owner) or buried in it. */
        const wsY = Y[m] + CB[m] * HW[m] - 0.02;
        props.push({ type: "waystation", s: sec.waystationS, x: g.x, y: wsY, z: g.z, scale: 1, rot: -HD[m], index: world.waystations.length, biome: b.key, strange: strangeWs(world.waystations.length, sec.waystationS) });
        // a sign a little before the apron, on the right shoulder
        const iS = Math.round((sec.waystationS - WS_APRON * 0.5 - 30) / DS - 1);
        const gS = groundAtSample(iS, HW[iS & MASK] + 2.2);
        if (gS) props.push({ type: "waysign", s: sec.waystationS - WS_APRON * 0.5 - 30, x: gS.x, y: gS.y, z: gS.z, scale: 1, rot: -HD[iS & MASK], biome: b.key });
      }
    }
    /* The Village Below: a hamlet on the valley floor the drop-site probe
     * found. Real ground under every cabin, none on water, none on a
     * slope it would float off, all clear of every road — and at night
     * the shared window material lights the whole cluster. */
    if (sec.event && sec.event.village && sec.villageSite) {
      const site = sec.villageSite;
      const want = 5 + Math.floor(r() * 3);
      let placed = 0;
      for (let k = 0; k < want * 4 && placed < want; k++) {
        const i = site.i0 + Math.round(r() * (site.i1 - site.i0));
        const m = i & MASK;
        const lat = site.side * (42 + r() * 34);
        const g = groundAtSample(i, lat);
        if (!g || g.water) continue;
        const g2 = groundAtSample(i, lat + site.side * 3);
        if (!g2 || Math.abs(g2.y - g.y) > 1.5) continue;   // too steep to stand on
        if (Y[m] - g.y < sec.event.needsDrop.drop * 0.7) continue;
        if (!clearOfRoad(g.x, g.z, 3)) continue;
        props.push({ type: b.cabinType || "cabin", s: (i + 1) * DS, x: g.x, y: g.y - 0.12, z: g.z, scale: 0.85 + r() * 0.3, rot: r() * Math.PI * 2, biome: b.key });
        placed++;
      }
      sec.villagePlaced = placed;
    }
    // water gets a dwelling on the far shore sometimes — a light in the trees,
    // a white villa above the sea
    if (sec.hasLake && r.chance(b.cabinP)) {
      const i = i0 + Math.floor(sec.n / 2);
      const m = i & MASK;
      const side = (FL[m] & F_LAKE_L) ? -1 : 1;
      const far = b.waterDrop > 4 ? -(HW[m] + 22) : (HW[m] + 55);   // villas sit landward on a cliff coast
      const g = groundAtSample(i, side * far);
      if (g && !g.water) props.push({ type: b.cabinType || "cabin", s: (i + 1) * DS, x: g.x, y: b.waterDrop > 4 ? g.y : Math.max(g.y, Y[m] - 1.2), z: g.z, scale: 1, rot: r() * Math.PI * 2, biome: b.key, noSeat: true });
    }
    return { props, colliderRefs };
  }

  /* Lay crossings over a freshly appended section.
   *
   * Nothing here is a choice: the landscape either stands over the road or
   * falls away under it, and a span is where that is true for long enough
   * to be worth building. Blocked on waystation aprons (the road has to
   * stay neutral there so any route can follow it) and on water — a bridge
   * over a lake is a fine idea and a bad first one, because the lake
   * profile already owns that side of the road.
   *
   * `depth` is the metres of rock above / air below at the deepest sample,
   * which is what the renderer builds piers and portals against. */
  function findSpans(sec, i0) {
    const n = sec.n;
    if (n < 8) return;
    const rel = new Float64Array(n), amp = new Float64Array(n);
    const block = new Uint8Array(n);
    for (let j = 0; j < n; j++) {
      const i = i0 + j, m = i & MASK;
      const r = reliefAtSample(i);
      rel[j] = r.rel; amp[j] = r.amp;
      RLF[m] = r.rel;
      if (FL[m] & (F_WAY | F_LAKE_L | F_LAKE_R)) block[j] = 1;
    }
    // keep clear of the apron either side of a waystation, not just on it
    if (sec.waystationS != null) for (let j = 0; j < n; j++) block[j] = 1;
    /* Some events refuse crossings outright: laying snow over a natural
     * curved bridge put a low-grip surface between two parapets with no
     * shoulder — the bot pinballed wall to wall at 126 km/h. A gallery,
     * a debris field or a lake crossing has no business bridging anyway. */
    if (sec.event && sec.event.noSpans) return;
    const sOf = (j) => (i0 + j + 1) * DS;
    const last = world.spans.length ? world.spans[world.spans.length - 1].s1 : -1e9;
    const bias = sec.event && sec.event.spanBias;
    const found = detectSpans(rel, amp, block, sOf, { lastSpanEndS: last, bias });
    if (!found.length) return;
    sec.spans = [];
    for (const f of found) {
      const span = {
        kind: f.kind, s0: sOf(f.j0), s1: sOf(f.j1),
        i0: i0 + f.j0, i1: i0 + f.j1,
        depth: 0, sectionIndex: sec.sectionIndex,
      };
      for (let j = f.j0; j <= f.j1; j++) {
        const i = i0 + j, m = i & MASK;
        const st = spanStrength(span, sOf(j));
        SPN[m] = f.kind === TUNNEL ? st : -st;
        FL[m] |= f.kind === TUNNEL ? F_TUNNEL : F_BRIDGE;
        const d = Math.abs(rel[j]);
        if (d > span.depth) span.depth = d;
      }
      world.spans.push(span);
      sec.spans.push(span);
      // the suspension event dresses the bridge it asked for (towers,
      // cables) — only on a span that really meets its promise
      if (sec.event && sec.event.suspension && f.kind === BRIDGE
        && span.s1 - span.s0 >= ((sec.event.want && sec.event.want.minLen) || 0)
        && span.depth >= ((sec.event.want && sec.event.want.minDepth) || 0)) span.suspension = true;
      /* The Verge: a bridge with nothing under it. Deck, kerbs and
       * parapets stay honest colliders — only the piers are missing,
       * which is the whole point ("roads that should not hold themselves
       * up"). Physics never touched piers anyway; this is a fact about
       * what the renderer will refuse to draw. */
      if (f.kind === BRIDGE && sec.biome.verge) span.floating = true;
      /* Cold country crossings. A bore is sheltered — its floor is grit,
       * not snow — and an exposed deck can carry ice ("ice under bridges",
       * straight from the bible). Laid HERE, before the speed profile
       * reads the samples, so the vmax over an iced deck comes from the
       * tyre law and the codriver's caution is a fact. */
      if (sec.biome.cold || (gen.region && gen.region.cold)) {
        if (f.kind === TUNNEL) {
          for (let j = f.j0; j <= f.j1; j++) SF[(i0 + j) & MASK] = SURF_IDX.gravel;
        } else {
          /* Ice only lands on a STRAIGHT-ISH deck — wind-scoured straights
           * are where black ice really lives, and a curved deck between
           * parapets was sized for the biome's grip, not for 0.38: glare
           * ice on a corner with no shoulder breaks the promise twice. */
          let maxK = 0;
          for (let j = f.j0; j <= f.j1; j++) maxK = Math.max(maxK, Math.abs(KV[(i0 + j) & MASK]));
          if (maxK < 1 / 300 && rng(hashCombine(seed, 0x1ce0 + span.i0))() < 0.6) {
            span.iced = true;
            for (let j = f.j0; j <= f.j1; j++) SF[(i0 + j) & MASK] = SURF_IDX.ice;
          }
        }
      }
      /* The codriver calls it before it arrives, and the call runs until
       * the far portal so a chained corner on the exit reads as one
       * breath ("into the tunnel, into three left"). */
      insertNote({
        s: span.s0 - 26, endS: span.s1, atS: span.s0,
        kind: f.kind === TUNNEL ? "tunnel" : "bridge", iced: !!span.iced,
      });
    }
  }

  /* Parapets and bore walls as physics: factored so a bridge laid
   * retroactively (an overpass on an already-committed section) gets the
   * same wall the ones laid at intake get. Centres set so the collider's
   * inner face lands on the face the renderer draws. */
  function spanColliders(span, colliderRefs) {
    const tunnel = span.kind === TUNNEL;
    const lat = tunnel ? SPAN.boreHalf + 0.9 : SPAN.kerb + 0.82;
    const step = Math.max(1, Math.round(2.6 / DS));
    for (let i = span.i0; i <= span.i1; i += step) {
      const m = i & MASK;
      const st = spanStrength(span, (i + 1) * DS);
      if (st < 0.22) continue;            // the portals stay open
      const rx = -Math.sin(HD[m]), rz = Math.cos(HD[m]);
      for (const side of [-1, 1]) {
        const off = side * (HW[m] + lat);
        colliderRefs.push(addCollider({
          x: X[m] + rx * off, y: Y[m] + 0.5, z: Z[m] + rz * off,
          r: tunnel ? 1.0 : 0.85,
        }));
      }
    }
  }

  /* -------------------------------------------- road over road (7a.2)
   *
   * validateSection's vertical exemption makes it legal for a section to
   * pass more than nine metres above or below an older live leg — a
   * spiral descent stacking over itself, a climb coming back across the
   * valley road. Measured before this existed: about once every sixteen
   * kilometres on ordinary seeds, and nothing bridged it — the terrain
   * blanket filled the air between the decks with whatever the two legs'
   * blends said.
   *
   * The rule: the UPPER leg gets a real bridge — deck, parapets, piers,
   * codriver call, all owned by the span machinery that already exists —
   * and the ground under it is resolved from the LOWER leg, which keeps
   * its deck, shoulders and ditch (see spanProfile / crossGround). When
   * the new section is the lower one, the bridge is laid retroactively on
   * the older section; that is legal exactly while the older section has
   * no mesh (the pruneOverlaid rule), which the generation lead
   * guarantees in practice — the rare built case is counted and declined,
   * leaving the status quo ante. */
  function findCrossings(sec, i0) {
    const n = sec.n;
    const match = new Int32Array(n).fill(-1);
    const mdy = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const px = sec.xs[j], pz = sec.zs[j], py = sec.ys[j];
      const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
      /* The nearest OVERLAPPING candidate — not the nearest leg. In a
       * braided multi-deck stack the closest older sample can be a leg
       * ten metres to the side while a farther one sits directly below;
       * matching nearest-anything silently missed a third of the decks
       * in a triple stack. */
      let bi = -1, bd2 = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const arr = cellIndex.get((cx + dx) + "," + (cz + dz));
        if (!arr) continue;
        for (const iOld of arr) {
          if ((i0 + j) - iOld < 20) continue;      // the corner we are in
          const mo = iOld & MASK;
          const ddx = X[mo] - px, ddz = Z[mo] - pz;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 >= bd2) continue;
          const reach = HW[mo] + sec.hws[j] + 1.6; // the decks actually overlap
          if (d2 >= reach * reach) continue;
          if (Math.abs(py - Y[mo]) <= 8.7) continue;
          bd2 = d2; bi = iOld;
        }
      }
      if (bi < 0) continue;
      match[j] = bi; mdy[j] = py - Y[bi & MASK];
    }
    // cluster the matches into runs; a shallow crossing angle can flicker
    // in and out of overlap, so short gaps merge
    const runs = [];
    let cur = null;
    for (let j = 0; j < n; j++) {
      if (match[j] < 0) continue;
      const sg = mdy[j] > 0 ? 1 : -1;
      if (cur && j - cur.jB <= 8 && sg === cur.sign) cur.jB = j;
      else runs.push((cur = { jA: j, jB: j, sign: sg }));
    }
    for (const run of runs) {
      /* A waystation section is neutral ground (the apron must accept any
       * route that follows), so it never carries a deck of its own — but
       * an older leg standing over it still gets its bridge. The first
       * version returned early for waystation sections, which skipped a
       * whole descending triple-stack without even counting it. */
      if (sec.waystationS != null && run.sign > 0) { world.crossStats.declined++; continue; }
      layCrossing(sec, i0, run, match);
    }
  }

  function layCrossing(sec, i0, run, match) {
    const CS = world.crossStats;
    const onNew = run.sign > 0;            // new samples stand above the old leg
    let iA, iB;
    if (onNew) { iA = i0 + run.jA; iB = i0 + run.jB; }
    else {
      iA = Infinity; iB = -Infinity;
      for (let j = run.jA; j <= run.jB; j++) {
        const p = match[j];
        if (p < 0) continue;
        if (p < iA) iA = p;
        if (p > iB) iB = p;
      }
      if (!(iB >= iA)) return;
    }
    // the deck reaches past the overlap so the abutments stand clear of
    // the road below
    const PAD = 10;
    iA = Math.max(world.iFirst, iA - PAD);
    iB = Math.min(world.iNext - 1, iB + PAD);
    // a span may not stand on waystation ground, on a lake profile, or in
    // a tunnel — trim, and if nothing usable is left, decline (which is
    // exactly the world as it was)
    const blocked = (i) => (FL[i & MASK] & (F_WAY | F_LAKE_L | F_LAKE_R)) !== 0 || SPN[i & MASK] > 0;
    while (iA <= iB && blocked(iA)) iA++;
    while (iB >= iA && blocked(iB)) iB--;
    let clear = iB - iA >= 16;
    for (let i = iA; clear && i <= iB; i++) if (blocked(i)) clear = false;
    if (!clear) { CS.declined++; return; }
    /* A BRIDGE already standing on part of the range — the landscape
     * detector got there first, or an earlier crossing of a multi-deck
     * stack — is not a conflict, it is the same structure: adopt it,
     * extend it to the union, and let it carry the over marks. Without
     * this the crossing was declined and the natural bridge's floor
     * stayed noise-invented — a shelf of ground hanging over the road
     * below (about one crossing in ten hits this). */
    let adopt = null;
    for (const sp of world.spans) {
      if (sp.kind !== BRIDGE || sp.i1 < iA || sp.i0 > iB) continue;
      adopt = sp; break;
    }
    let ownerRec = null;
    const ownIdx = adopt ? adopt.sectionIndex : null;
    if (adopt && ownIdx !== sec.sectionIndex) {
      for (const rec of world.sections) if (rec.index === ownIdx) { ownerRec = rec; break; }
      if (ownerRec && ownerRec.built) {
        // its mesh exists; the range must not grow, but the samples it
        // already covers can still learn what they stand over
        iA = Math.max(iA, adopt.i0); iB = Math.min(iB, adopt.i1);
        if (iB < iA) { CS.skipBuilt++; return; }
      }
    } else if (!adopt && iA < i0) {
      for (const rec of world.sections) if (iA >= rec.i0 && iA <= rec.i1) { ownerRec = rec; break; }
      if (!ownerRec) { CS.declined++; return; }
      if (ownerRec.built) { CS.skipBuilt++; return; }
    }
    const span = adopt || {
      kind: BRIDGE, s0: (iA + 1) * DS, s1: (iB + 1) * DS,
      i0: iA, i1: iB, depth: 0,
      sectionIndex: ownerRec ? ownerRec.index : sec.sectionIndex,
      over: true,
    };
    // the crossing range itself (over marks live here), and the union
    // range an adopted span grows to
    const cA = iA, cB = iB;
    const grown = [];                    // sub-ranges an adoption grew by
    const oldS0 = adopt ? adopt.s0 : 0;
    if (adopt) {
      if (cA < adopt.i0) grown.push([cA, adopt.i0 - 1]);
      if (cB > adopt.i1) grown.push([adopt.i1 + 1, cB]);
      span.i0 = Math.min(span.i0, cA); span.i1 = Math.max(span.i1, cB);
      span.s0 = (span.i0 + 1) * DS; span.s1 = (span.i1 + 1) * DS;
      span.over = true;
    }
    // deck sample → the lower-leg sample it stands over (nearest match;
    // the pads clamp to the run's edges, which is close enough for the
    // hinted re-resolution to lock on)
    const pairs = [];
    for (let j = run.jA; j <= run.jB; j++) {
      if (match[j] < 0) continue;
      pairs.push(onNew ? { deck: i0 + j, low: match[j] } : { deck: match[j], low: i0 + j });
    }
    pairs.sort((a, b) => a.deck - b.deck);
    /* Where the LOWER passage is, in its own road distance — the renderer
     * builds an ascending deck early off this, so it already stands
     * overhead when the car passes underneath. */
    let loMin = Infinity, loMax = -Infinity;
    for (const pr of pairs) { if (pr.low < loMin) loMin = pr.low; if (pr.low > loMax) loMax = pr.low; }
    const u0 = (loMin + 1) * DS, u1 = (loMax + 1) * DS;
    span.underS0 = span.underS0 == null ? u0 : Math.min(span.underS0, u0);
    span.underS1 = span.underS1 == null ? u1 : Math.max(span.underS1, u1);
    let pk = 0, maxDy = adopt ? adopt.depth : 0;
    for (let i = span.i0; i <= span.i1; i++) {
      const m = i & MASK;
      SPN[m] = -spanStrength(span, (i + 1) * DS);
      FL[m] |= F_BRIDGE;
      if (i < cA || i > cB) continue;    // strength over the union, marks on the crossing
      while (pk < pairs.length - 1 && pairs[pk + 1].deck <= i) pk++;
      let pr = pairs[pk];
      if (pk < pairs.length - 1 && Math.abs(pairs[pk + 1].deck - i) < Math.abs(pr.deck - i)) pr = pairs[pk + 1];
      OVR[m] = pr.low + 1;
      const dy = Math.abs(Y[m] - Y[pr.low & MASK]);
      if (dy > maxDy) maxDy = dy;
    }
    span.depth = maxDy;
    if (adopt) {
      // colliders for the grown sub-ranges of an already-placed section
      // (a span still on the current section gets its colliders in
      // placeProps, from the updated range)
      if (ownerRec) for (const [a, b] of grown) {
        spanColliders({ ...span, i0: a, i1: b }, ownerRec.colliderRefs);
      }
      // the bridge's note learns what it now is (and where it now starts)
      const ni = world.notes.findIndex((nn) => nn.kind === "bridge" && Math.abs(nn.atS - oldS0) < 1);
      if (ni >= 0) {
        const nn = world.notes.splice(ni, 1)[0];
        nn.s = span.s0 - 26; nn.atS = span.s0; nn.endS = span.s1; nn.over = true;
        insertNote(nn);
      }
      CS.adopted++;
    } else {
      // world.spans stays ordered by s0 (findSpans reads the tail for its
      // minimum-gap rule); a retro span lands mid-array
      let k = world.spans.length;
      while (k > 0 && world.spans[k - 1].s0 > span.s0) k--;
      world.spans.splice(k, 0, span);
      if (ownerRec) {
        (ownerRec.spans || (ownerRec.spans = [])).push(span);
        spanColliders(span, ownerRec.colliderRefs);
        CS.retro++;
      } else {
        // the current section's own samples: placeProps (which runs after
        // this) lays the parapet colliders and keeps the deck free of props
        (sec.spans || (sec.spans = [])).push(span);
        CS.laid++;
      }
      insertNote({ s: span.s0 - 26, endS: span.s1, atS: span.s0, kind: "bridge", over: true });
    }
    /* The road below must SURVIVE until the deck is crossed. Culling is
     * measured along the road, and the leg under an overpass can be a
     * kilometre back along it while standing zero metres away in space —
     * left alone, the road the player is looking down at would be culled
     * (mesh, colliders and all) just as they arrive. The lower section is
     * held until the car is well past the deck. */
    const holdS = span.s1 + 120;
    for (const pr of pairs) {
      if (pr.low >= i0) { if (!(sec.keepUntilS > holdS)) sec.keepUntilS = holdS; continue; }
      for (const rec of world.sections) {
        if (pr.low >= rec.i0 && pr.low <= rec.i1) {
          if (!(rec.keepUntilS > holdS)) rec.keepUntilS = holdS;
          break;
        }
      }
    }
    pruneUnderCrossing(span);
  }

  /* Props whose world just changed: a tree on the upper verge whose
   * ground fell away when the deck became a bridge, or one under the deck
   * with a canopy that would grow through it. Same legality rule as
   * pruneOverlaid — only sections with no mesh yet. */
  function pruneUnderCrossing(span) {
    const CS = world.crossStats;
    const list = world.sections;
    // span sample positions, strided — a cheap reach test per prop
    const sx = [], sz = [], sy = [];
    for (let i = span.i0; i <= span.i1; i += 4) {
      const m = i & MASK;
      sx.push(X[m]); sz.push(Z[m]); sy.push(Y[m]);
    }
    for (let k = Math.max(0, list.length - 8); k < list.length; k++) {
      const rec = list[k];
      if (rec.built || !rec.props.length) continue;
      let removed = 0;
      for (let pi = rec.props.length - 1; pi >= 0; pi--) {
        const p = rec.props[pi];
        if (p.type === "waystation" || p.type === "waysign") continue;
        let near = false, under = false;
        for (let q = 0; q < sx.length; q++) {
          const dd = (sx[q] - p.x) * (sx[q] - p.x) + (sz[q] - p.z) * (sz[q] - p.z);
          if (dd < 34 * 34) near = true;
          if (dd < 8 * 8 && sy[q] - p.y > -1 && sy[q] - p.y < 14) under = true;
          if (under) break;
        }
        if (!near) continue;
        // the ground under it moved (it floats or is buried), or it
        // stands under the deck close enough to grow through it
        let gone = under;
        if (!gone) {
          const g = groundHeight(p.x, p.z, null);
          if (g && Math.abs(g.y - p.y) > 1.4) gone = true;
        }
        if (!gone) continue;
        rec.props.splice(pi, 1);
        removed++;
      }
      if (removed) { CS.pruned += removed; rebuildColliders(rec); }
    }
  }

  /* Would this candidate section produce the crossings its event asked
   * for? Run the same detection over the candidate's own geometry, using
   * the generator's current biome and region rather than the sample rings
   * (which do not exist for it yet). Cheap — a noise lookup per sample —
   * and it is the difference between "tunnels ahead" being a promise and
   * being a lie. */
  function candidateSpans(sec) {
    const bBase = gen.biome;
    const rm = gen.region || { hills: 1, detail: 1, shape: null };
    const b = {
      terrHills: [bBase.terrHills[0] * rm.hills, bBase.terrHills[1]],
      hillShape: rm.shape || bBase.hillShape,
    };
    const n = sec.n;
    const rel = new Float64Array(n), amp = new Float64Array(n);
    const block = new Uint8Array(n);
    for (let j = 0; j < n; j++) {
      let hn = hillN(sec.xs[j] / b.terrHills[1], sec.zs[j] / b.terrHills[1]);
      if (b.hillShape > 1.01) hn = Math.sign(hn) * Math.pow(Math.abs(hn), 1 / b.hillShape);
      rel[j] = hn * b.terrHills[0];
      amp[j] = b.terrHills[0];
      if (sec.fls[j] & (F_WAY | F_LAKE_L | F_LAKE_R)) block[j] = 1;
    }
    const sOf = (j) => gen.s + (j + 1) * DS;
    const last = world.spans.length ? world.spans[world.spans.length - 1].s1 : -1e9;
    const bias = sec.event && sec.event.spanBias;
    return detectSpans(rel, amp, block, sOf, { lastSpanEndS: last, bias })
      .map((f) => {
        // depth too: an event may require it (a suspension bridge over a
        // shallow dip is a folly), and a promise tested without it lies
        let depth = 0;
        for (let j = f.j0; j <= f.j1; j++) depth = Math.max(depth, Math.abs(rel[j]));
        return { kind: f.kind, s0: sOf(f.j0), s1: sOf(f.j1), depth };
      });
  }

  /* Can this event's geology needs plausibly be met anywhere NEAR the
   * generator? A fan of noise probes ahead of the cursor — cheap, and it
   * keeps pickEvent from burning its roll on a village with no valley or
   * a suspension bridge with no gorge. Feasible is not a guarantee; the
   * candidate retries and the delivery gate still have the last word. */
  function eventFeasible(ev) {
    const needDrop = ev.needsDrop ? ev.needsDrop.drop - 2 : 0;
    const needDepth = ev.want && ev.want.minDepth ? ev.want.minDepth * 0.85 : 0;
    if (!needDrop && !needDepth) return true;
    const bBase = gen.biome;
    const rm = gen.region || { hills: 1, shape: null };
    const amp = bBase.terrHills[0] * rm.hills;
    const lam = bBase.terrHills[1];
    const shape = rm.shape || bBase.hillShape;
    let hits = 0;
    for (let d = 140; d <= 740; d += 120) {
      for (let a = -1.1; a <= 1.1; a += 0.55) {
        const th = gen.heading + a;
        const px = gen.x + Math.cos(th) * d, pz = gen.z + Math.sin(th) * d;
        let hn = hillN(px / lam, pz / lam);
        if (shape > 1.01) hn = Math.sign(hn) * Math.pow(Math.abs(hn), 1 / shape);
        const rel = hn * amp;
        if (needDrop && rel < -needDrop) hits++;
        if (needDepth && rel < -needDepth) hits++;
        if (hits >= 3) return true;
      }
    }
    return false;
  }

  /* Would this candidate's geology put real ground-fall beside the road?
   * The village event's pre-commit half — same noise the ground function
   * uses, sampled out at the site latitude, so a candidate line that runs
   * along a shelf gets retried the way a span candidate does. The
   * authoritative test (findDropSite) runs on the committed samples. */
  function candidateDrop(sec, ev) {
    const nd = ev.needsDrop;
    const bBase = gen.biome;
    const rm = gen.region || { hills: 1, shape: null };
    const amp = bBase.terrHills[0] * rm.hills;
    const lam = bBase.terrHills[1];
    const shape = rm.shape || bBase.hillShape;
    const jA = Math.floor(sec.n * 0.15), jB = Math.floor(sec.n * 0.85);
    for (const side of [-1, 1]) {
      let run = 0;
      for (let j = jA; j <= jB; j += 2) {
        const rx = -Math.sin(sec.hd[j]), rz = Math.cos(sec.hd[j]);
        const px = sec.xs[j] + rx * side * nd.lat, pz = sec.zs[j] + rz * side * nd.lat;
        let hn = hillN(px / lam, pz / lam);
        if (shape > 1.01) hn = Math.sign(hn) * Math.pow(Math.abs(hn), 1 / shape);
        if (hn * amp < -(nd.drop - 2)) { run += 2; if (run >= nd.run) return true; }
        else run = 0;
      }
    }
    return false;
  }

  /* ...and did the committed ground really deliver it? The longest run of
   * samples with land (not water) standing `drop` metres below the deck,
   * on one side — where the hamlet will stand. */
  function findDropSite(sec, i0) {
    const nd = sec.event.needsDrop;
    const jA = Math.floor(sec.n * 0.15), jB = Math.floor(sec.n * 0.85);
    let best = null;
    for (const side of [-1, 1]) {
      let a = -1, run = 0;
      for (let j = jA; j <= jB; j += 2) {
        const i = i0 + j;
        const g = groundAtSample(i, side * nd.lat);
        const ok = g && !g.water && (Y[i & MASK] - g.y) >= nd.drop;
        if (ok) {
          if (a < 0) a = i;
          run += 2;
          if (!best || run > best.run) best = { side, i0: a, i1: i, run };
        } else { a = -1; run = 0; }
      }
    }
    if (!best || best.run < nd.run) return false;
    sec.villageSite = best;
    return true;
  }

  /* What an event does to the samples themselves: canyon walls that build
   * up and fall away over the span, a surface it lays down, and any
   * sub-feature it owns (the water in a ford). Kept apart from the phrase
   * compiler because none of it is geometry — it is what the road is MADE
   * of and what stands beside it. */
  function applyEventShape(sec, i0) {
    const ev = sec.event;
    if (!ev) return;
    const n = sec.n;
    const sStart = (i0 + 1) * DS, sEnd = sStart + n * DS;
    if (ev.walls) {
      /* Ease in and out over 90 m: a canyon that starts at full height in
       * one sample is a wall the road drives into, not a place it enters. */
      const ramp = 90;
      for (let j = 0; j < n; j++) {
        const s = sStart + j * DS;
        const t = Math.min(1, Math.min(s - sStart, sEnd - s) / ramp);
        EVW[(i0 + j) & MASK] = ev.walls * smoothstep(t);
      }
    }
    if (ev.surf && SURF_IDX[ev.surf] != null) {
      for (let j = 0; j < n; j++) SF[(i0 + j) & MASK] = SURF_IDX[ev.surf];
    }
    if (ev.ford) {
      /* A ford is a short crossing, not a section: put it where the
       * section's own dip is, so the water sits in the hollow rather than
       * lying on a slope. */
      let at = sStart + (sEnd - sStart) * 0.55;
      for (const f of sec.feats) if (f.kind === "dip") { at = f.s; break; }
      const half = ev.ford * 0.5;
      const iA = Math.max(i0, Math.round((at - half) / DS - 1));
      const iB = Math.min(i0 + n - 1, Math.round((at + half) / DS - 1));
      const rec = { s0: (iA + 1) * DS, s1: (iB + 1) * DS };
      for (let i = iA; i <= iB; i++) {
        const m = i & MASK;
        EVS[m] = SUB_FORD;
        SF[m] = SURF_IDX.mud;          // real grip loss, and the codriver notices
      }
      sec.ford = rec;
      insertNote({ s: rec.s0 - 70, endS: rec.s1, atS: rec.s0, kind: "ford", noChain: true });
    }
  }

  /* One waystation in eight, deep enough into a run to be earned, is a
   * STRANGE OUTPOST — teal lamp, an aerial nobody explains, a better
   * stocked shelf. Not advertised anywhere; the codriver's "odd one, this"
   * and the light are the whole announcement. Deterministic per (seed,
   * index) like everything a save must reproduce. */
  const strangeWs = (index, s) => opts.forceStrange
    ? true
    : s > 12000 && rng(hashCombine(seed, 0x57a9 + index * 31))() < 0.12;

  function appendSection(sec) {
    const i0 = world.iNext;
    /* Where the surface flips inside a country transition. Normally where
     * the new country has mostly arrived (t = 0.5) — but the whole blend
     * zone's corners were sized by the NEW country's generator, so a
     * low-grip surface (snow) must never linger under corners sized for a
     * grippier one: leaving Kaldbrekka, the snow hands over almost at the
     * frontier instead. Entering it is the safe direction (snow-sized
     * corners on gravel) and keeps the mid-blend flip. */
    const surfPrev = world.prevBiome.surf, surfNew = sec.biome.surf;
    const surfThr = surfaceParams(surfPrev, 0).grip < surfaceParams(surfNew, 0).grip - 0.1 ? 0.12 : 0.5;
    const regionSurf = gen.region && gen.region.surf ? SURF_IDX[gen.region.surf] : null;
    for (let j = 0; j < sec.n; j++) {
      const i = i0 + j;
      const m = i & MASK;
      X[m] = sec.xs[j]; Z[m] = sec.zs[j]; Y[m] = sec.ys[j];
      HD[m] = sec.hd[j]; KV[m] = sec.kv[j]; CB[m] = sec.cb[j];
      HW[m] = sec.hws[j]; FL[m] = sec.fls[j];
      NOBRK[m] = 0; SPN[m] = 0; RLF[m] = 0; OVR[m] = 0;
      /* The event flatten RAMPS at its edges the way the canyon's walls
       * do. A hard step in the terrain multiplier stood a cliff in the
       * ground exactly at the event boundary, one length off the deck —
       * the salt flats have carried twenty-metre boundary cliffs since
       * they were built, unmet because nothing ever left that deck; the
       * avalanche's snow finally sent a car off to find one (39.7 m/s
       * landing, measured). Chained same-event sections skip the head
       * ramp so a forced run stays flat inside itself. */
      if (sec.event && sec.event.terr) {
        const sHere0 = (i + 1) * DS;
        const sA = (i0 + 1) * DS, sB = sA + sec.n * DS;
        const prevRec = world.sections[world.sections.length - 1];
        const cont = prevRec && prevRec.event && prevRec.event.key === sec.event.key;
        if (cont && j === 0) {
          // the previous section ramped its tail back toward 1 not knowing
          // the event would continue — flatten it again, or the seam keeps
          // a 90 m V-notch of un-flattened ground (the samples are ~1 km
          // ahead of the car; nothing has drawn them yet)
          for (let k = i0 - 1; k >= i0 - 36 && k >= world.iFirst; k--) {
            EVT[k & MASK] = sec.event.terr;
          }
        }
        const tIn = cont ? 1 : Math.min(1, (sHere0 - sA) / 90);
        const tOut = Math.min(1, (sB - sHere0) / 90);
        EVT[m] = 1 + (sec.event.terr - 1) * smoothstep(Math.min(tIn, tOut));
      } else EVT[m] = 1;
      EVW[m] = 0; EVS[m] = 0;
      OLD[m] = 0; OLDK[m] = 0;
      // biome + transition blend for this sample
      const sHere = (i + 1) * DS;
      const t = Math.max(0, Math.min(1, (sHere - world.transitionS) / TRANSITION_LEN));
      BI[m] = BIOME_INDEX[sec.biome.key];
      BP[m] = BIOME_INDEX[world.prevBiome.key];
      BT[m] = t;
      // micro-region + its own, faster blend
      RG[m] = REGION_INDEX[gen.region.key];
      RP[m] = REGION_INDEX[(gen.prevRegion || gen.region).key];
      RT[m] = Math.max(0, Math.min(1, (sHere - gen.regionTransS) / REGION_BLEND));
      // the surface changes where the new country has mostly arrived
      // (or, past a snow country's frontier, almost immediately — above),
      // and a region that lays its own surface owns its whole section,
      // because its corners were sized for it
      SF[m] = regionSurf != null ? regionSurf : SURF_IDX[t < surfThr ? surfPrev : surfNew];
      world.iNext = i + 1;
      addToCell(i);
    }
    sec.biomeKey = sec.biome.key;
    /* Width eases between countries too (narrow coast lanes, wide desert
     * tracks). An event that doubles the road — the Flats — gets a faster
     * ease, or a kilometre of salt pan would spend half of itself still
     * opening out; it is still ~190 m, which reads as the road widening
     * rather than stepping. */
    if (sec.n > 2) {
      const rate = sec.event && sec.event.width ? 0.06 : 0.02;
      let hwPrev = HW[(i0 - 1) & MASK];
      if (i0 <= world.iFirst) hwPrev = HW[i0 & MASK];
      for (let j = 0; j < sec.n; j++) {
        const m = (i0 + j) & MASK;
        HW[m] = hwPrev + Math.max(-rate, Math.min(rate, HW[m] - hwPrev));
        hwPrev = HW[m];
      }
    }
    // round off the join with the previous section: each section's elevation
    // is smooth inside itself, but a clamped climb meeting a clamped descent
    // at the seam is a kink the car would fly off. Three light passes over
    // ±7 samples either side (endpoints pinned) — nothing here is rendered
    // yet, it is ~1 km ahead of the car.
    if (i0 - 8 >= world.iFirst && sec.n > 8) {
      for (let pass = 0; pass < 3; pass++) {
        let prev = Y[(i0 - 8) & MASK];
        for (let i = i0 - 7; i <= i0 + 6; i++) {
          const m = i & MASK, cur = Y[m], nxt = Y[(i + 1) & MASK];
          Y[m] = (prev + 2 * cur + nxt) / 4;
          prev = cur;
        }
      }
    }
    // grade by central difference
    for (let j = 0; j < sec.n; j++) {
      const i = i0 + j;
      const mPrev = Math.max(world.iFirst, i - 1) & MASK;
      const mNext = Math.min(world.iNext - 1, i + 1) & MASK;
      GR[i & MASK] = (Y[mNext] - Y[mPrev]) / (2 * DS);
    }
    applyEventShape(sec, i0);
    findSpans(sec, i0);
    findCrossings(sec, i0);
    findOldRoad(sec, i0);
    // no-brake spans across jumps and crests (you cannot brake in the air)
    for (const f of sec.feats) {
      const from = f.kind === "jump" ? f.s - 6 : f.kind === "crest" ? f.s - 4 : null;
      if (from == null) continue;
      const to = f.kind === "jump" ? f.s + 58 : f.s + 24;
      for (let i = Math.max(world.iFirst, Math.round(from / DS - 1)); i <= Math.min(world.iNext - 1, Math.round(to / DS - 1)); i++) {
        NOBRK[i & MASK] = 1;
      }
    }
    // vmax from curvature, camber help, surface
    for (let j = 0; j < sec.n; j++) {
      const i = i0 + j;
      const m = i & MASK;
      const k = Math.abs(KV[m]);
      const bank = -CB[m] * Math.sign(KV[m] || 1);
      const mu = surfaceParams(SURF_IDS[SF[m]], 0).grip * 0.88 * (1 + Math.max(-0.3, Math.min(0.3, bank * 5)));
      VMAX[m] = k > 1e-5 ? Math.min(VCAP, Math.sqrt((mu * G) / k)) : VCAP;
    }
    /* Brows: where the road curves DOWNWARD (y'' < 0) a car at speed goes
     * light, then flies. The profile caps speed so the ground stays under
     * the wheels (≈1.25 g of downward demand) and trims grip where it goes
     * light — except across explicit jump ramps, which are meant to fly. */
    const jumpSpan = [];
    for (const f of sec.feats) if (f.kind === "jump") jumpSpan.push([f.s - 12, f.s + 60]);
    // ...including the previous section's last samples, whose brows can only
    // be measured now that the road beyond them exists (clamped elevation
    // kinks like to sit exactly on section boundaries)
    for (let j = -2; j < sec.n - 2; j++) {
      const i = i0 + j;
      if (i - 2 < world.iFirst) continue;
      const m = i & MASK;
      const sHere = (i + 1) * DS;
      let onJump = false;
      for (const [a, b] of jumpSpan) if (sHere >= a && sHere <= b) onJump = true;
      if (onJump) continue;
      const ypp = (Y[(i + 2) & MASK] - 2 * Y[m] + Y[(i - 2) & MASK]) / ((2 * DS) * (2 * DS));
      if (ypp < -1e-5) {
        const vFly = Math.sqrt((1.0 * G) / -ypp);
        VMAX[m] = Math.min(VMAX[m], Math.max(gradeTargetFloor, vFly));
        // going light costs grip in whatever corner sits on the brow
        const light = Math.min(0.5, (VMAX[m] * VMAX[m] * -ypp) / G);
        VMAX[m] *= 1 - light * 0.35;
      }
    }
    recomputeProfile();

    /* The event only becomes real once the ground has delivered what it
     * asked for. If it has not, the section stays — it is a perfectly good
     * fast open stretch — but nothing is announced, no banner fires, and
     * the cooldown does not start. Silence beats a broken promise. */
    // the geology refused it: remember which, so the next section's pick
    // is near-certain and never the same event (events.js `burned`)
    if (sec.event && !eventDelivered(sec.event, sec.spans || [])) { gen.burnedKey = sec.event.key; sec.event = null; }
    if (sec.event && sec.event.needsDrop && !findDropSite(sec, i0)) { gen.burnedKey = sec.event.key; sec.event = null; }
    if (sec.event) {
      const s0 = (i0 + 1) * DS;
      const named = nameEvent(sec.event, seed, s0, sec.biome.key, world.placeNames);
      const name = named.name;
      world.placeNames.push(named.place);
      const rec = {
        key: sec.event.key, name, banner: name.toUpperCase(),
        kind: sec.event.name, s0, s1: world.iNext * DS, def: sec.event,
      };
      world.events.push(rec);
      if (world.events.length > 6) world.events.shift();
      world.eventKeys.push(rec.key);
      world.lastEventS = rec.s1;
      gen.burnedKey = null;
      sec.eventRec = rec;
      /* Called far enough out to be a heads-up rather than a surprise —
       * an event is a thing you should see coming and have time to feel
       * something about. */
      insertNote({
        s: rec.s0 - 150, endS: rec.s0 + 40, atS: rec.s0,
        kind: "event", call: sec.event.call, name, banner: rec.banner, noChain: true,
      });
    }

    sec.hasLake = sec.fls.some((f) => f & (F_LAKE_L | F_LAKE_R));
    const { props, colliderRefs } = placeProps(sec, i0);
    const record = {
      index: sec.sectionIndex, i0, i1: world.iNext - 1,
      s0: (i0 + 1) * DS, s1: world.iNext * DS,
      mood: sec.mood, props, colliderRefs,
      biomeKey: sec.biome.key,             // the renderer paints the road from this
      event: sec.eventRec || null,         // the special event that owns it, if any
      feats: sec.feats,                    // what the road actually built here
      spans: sec.spans || [],              // bridges & tunnels crossing it
      acceptedBy: sec.acceptedBy,
      ford: sec.ford || null,              // water across the road, if any
      hasLake: sec.hasLake,
      keepUntilS: sec.keepUntilS || 0,     // held past normal culling (a deck above it)
      pickups: [],
    };
    record.pickups = placePickups(world, sec, i0, seed);
    /* The old road's furniture: faded slabs down the strip and a few
     * pickups — the reward for the unmarked line, never announced. Laid
     * after commit so groundAtSample answers with the strip's own bed. */
    if (sec.oldRoad) {
      const orr = sec.oldRoad;
      record.oldRoad = orr;
      const rr = rng(hashCombine(seed, 0x01dd + sec.sectionIndex));
      for (let s = orr.s0 + 12; s < orr.s1 - 12; s += 8.5) {
        const i = Math.round(s / DS - 1), m = i & MASK;
        if (OLDK[m] < 0.6) continue;
        const g = groundAtSample(i, orr.lat + (rr() - 0.5) * 1.2);
        if (!g) continue;
        record.props.push({ type: "oldslab", s, x: g.x, y: g.y + 0.04, z: g.z, scale: 1, rot: -HD[m], biome: sec.biome.key });
      }
      for (let k = 0; k < 3; k++) {
        const s = orr.s0 + (orr.s1 - orr.s0) * (0.3 + 0.2 * k);
        const i = Math.round(s / DS - 1);
        const g = groundAtSample(i, orr.lat);
        if (!g) continue;
        const kind = k === 1 ? "wrench" : rr.chance(0.5) ? "canister" : "grit";
        record.pickups.push({ kind, x: g.x, y: g.y + 0.85, z: g.z, s, side: Math.sign(orr.lat), taken: false, sectionIndex: sec.sectionIndex });
      }
    }
    world.sections.push(record);
    for (const n of sec.notes) insertNote(n);
    if (sec.waystationS != null) {
      const i = Math.round(sec.waystationS / DS - 1);
      const m = i & MASK;
      const ws = { index: world.waystations.length, s: sec.waystationS, sectionIndex: sec.sectionIndex, x: X[m], z: Z[m], heading: HD[m], legIndex: world.legIndex, strange: strangeWs(world.waystations.length, sec.waystationS) };
      world.waystations.push(ws);
      world.aprons.push({ s0: sec.waystationS - WS_APRON * 0.5, s1: sec.waystationS + WS_APRON * 0.5 });
      if (world.aprons.length > 4) world.aprons.shift();
      record.waystation = ws;
      /* `s` is where the call is MADE; `atS` is what it is about. Without
       * the second field the HUD chip counted down to the call itself and
       * blinked out 650 m short of any waystation — a promise the road
       * then failed to keep twice per leg. */
      // ...and the call itself leads the note by roughly a hundred metres,
      // so the "six hundred" note sits at five hundred to be spoken honestly
      insertNote({ s: sec.waystationS - 500, endS: sec.waystationS - 500, atS: sec.waystationS, kind: "waystation", distSpoken: "six hundred", strange: ws.strange, noChain: true });
      insertNote({ s: sec.waystationS - 190, endS: sec.waystationS - 190, atS: sec.waystationS, kind: "waystation", distSpoken: "ahead, pull in", noChain: true });
    }
    pruneOverlaid(record);
    if (world.onSectionAdded) world.onSectionAdded(record);
  }

  /* `clearOfRoad` stops a prop being placed on road that already exists.
   * This is the other half: road that arrives LATER. A section laid two
   * hundred metres of road after a spruce can run straight through it, and
   * then the car hits a tree that is, correctly, beside a road — just not
   * this one. Sections within reach of the frontier have not been built
   * yet, so removing the prop removes it for good rather than leaving a
   * ghost. */
  function pruneOverlaid(fresh) {
    const list = world.sections;
    for (let k = Math.max(0, list.length - 4); k < list.length; k++) {
      const sec = list[k];
      if (sec === fresh || !sec.props.length) continue;
      if (sec.built) continue;                 // already a mesh; leave it alone
      let removed = 0;
      for (let pi = sec.props.length - 1; pi >= 0; pi--) {
        const p = sec.props[pi];
        if (p.type === "waystation" || p.type === "waysign") continue;
        // onRoad marks stand on the road BY DESIGN — pruning them for it
        // deleted every level crossing the moment the next section arrived.
        // Hug marks (kerbs, cones) live at their own deck's edge for the
        // same reason: nearest-leg clearance is the wrong question for them
        if (p.type === "railline" || p.type === "cattlegrid" || p.type === "kerb" || p.type === "cone" || p.type === "galleryroof") continue;
        if (propClearOfRoad(p, p.type === "wall" || p.type === "terrace" || p.type === "fence" || p.type === "snowpole")) continue;
        sec.props.splice(pi, 1);
        removed++;
      }
      if (removed) rebuildColliders(sec);
    }
  }

  /* Colliders are pooled per section and do not know their prop, so the
   * honest cheap move after any prune is to rebuild the section's
   * collider set from the props that survived — AND from its spans: the
   * first version of this rebuild forgot the parapets and bore walls,
   * which are colliders in colliderRefs but are not props, so one pruned
   * tree on a section with a bridge quietly disarmed the bridge. */
  function rebuildColliders(sec) {
    for (const ref of sec.colliderRefs) removeCollider(ref);
    sec.colliderRefs.length = 0;
    for (const p of sec.props) {
      // a mark placed with its own footprint keeps it (a house, a chapel)
      if (p.cr != null) { sec.colliderRefs.push(addCollider({ x: p.x, y: p.y, z: p.z, r: p.cr })); continue; }
      const r = p.type === "shrub" ? 0.3 : p.type === "cactus" ? 0.35
        : p.type === "wall" ? 0.6 : p.type === "mesa" ? 0
        : p.type === "railline" || p.type === "cattlegrid" || p.type === "galleryroof" ? 0
        : p.type === "kerb" || p.type === "cone" || p.type === "oldslab" || UNARMED_MARKS.has(p.type) ? 0
        : 0.5;   // flat/drivable/soft things never come back armed
      if (!r) continue;
      sec.colliderRefs.push(addCollider({ x: p.x, y: p.y, z: p.z, r: r * (p.scale || 1) + 0.12 }));
    }
    for (const span of sec.spans || []) spanColliders(span, sec.colliderRefs);
  }

  function insertNote(n) {
    const arr = world.notes;
    let i = arr.length;
    while (i > 0 && arr[i - 1].s > n.s) i--;
    arr.splice(i, 0, n);
  }

  function recomputeProfile() {
    const last = world.iNext - 1;
    if (last < world.iFirst) return;
    PROF[last & MASK] = VMAX[last & MASK];
    for (let i = last - 1; i >= world.iFirst; i--) {
      const m = i & MASK, mn = (i + 1) & MASK;
      if (NOBRK[m]) {
        PROF[m] = Math.min(VMAX[m], PROF[mn]);
      } else {
        const mu = surfaceParams(SURF_IDS[SF[m]], 0).grip;
        const decel = Math.max(2, mu * G * 0.62 + GR[m] * G);
        PROF[m] = Math.min(VMAX[m], Math.sqrt(PROF[mn] * PROF[mn] + 2 * decel * DS));
      }
    }
    for (let i = world.iFirst + 1; i <= last; i++) {
      const m = i & MASK, mp = (i - 1) & MASK;
      const v = Math.max(3, PROF[mp]);
      const acc = Math.max(0.4, Math.min(6.2, 140 / v) - 0.00037 * v * v - GR[m] * G - 0.15);
      PROF[m] = Math.min(PROF[m], Math.sqrt(v * v + 2 * acc * DS));
    }
  }

  function cullBehind(carS) {
    while (world.sections.length > 1 && world.sections[0].s1 < carS - BEHIND
      && !(world.sections[0].keepUntilS > carS - BEHIND)) {
      const sec = world.sections.shift();
      if (sec.spans && sec.spans.length) {
        world.spans = world.spans.filter((sp) => !sec.spans.includes(sp));
      }
      if (sec.event) world.events = world.events.filter((e) => e !== sec.event);
      for (let i = sec.i0; i <= sec.i1; i++) removeFromCell(i);
      for (const ref of sec.colliderRefs) removeCollider(ref);
      world.iFirst = sec.i1 + 1;
      const cutS = (world.iFirst + 1) * DS;
      while (world.notes.length && world.notes[0].endS < cutS) world.notes.shift();
      if (world.onSectionRemoved) world.onSectionRemoved(sec);
    }
  }

  /* Keep the road generated AHEAD metres past `s`, cull far behind. */
  /* Walk the country's ring of regions. The road spends REGION_MIN–MAX
   * metres in each before moving to the next — always the next, never a
   * shuffle, because "lakeshore, then forest, then up onto the moor" is a
   * journey and a random order is a playlist. Waystation sections are
   * neutral ground and never start a new region. */
  function advanceRegion(isWay) {
    const key = gen.biome.key;
    if (!gen.region) {
      /* ?region= debug: start the ring at a chosen region. Rare ring
       * content — a snow line four regions in — is unreachable in under
       * five minutes of driving otherwise, and unreached means unlooked-at. */
      let idx0 = 0;
      if (opts.startRegion) {
        for (let k = 0; k < regionCount(key); k++) {
          if (regionAt(key, k).key === opts.startRegion) { idx0 = k; break; }
        }
      }
      gen.region = regionAt(key, idx0);
      gen.prevRegion = gen.region;
      gen.regionIdx = idx0;
      gen.regionStartS = gen.s;
      gen.regionTransS = -1e9;
      return;
    }
    if (isWay) return;
    const r = rng(hashCombine(seed, 0x5e91 + Math.round(gen.regionStartS)));
    const span = REGION_MIN + (REGION_MAX - REGION_MIN) * r();
    if (gen.s - gen.regionStartS < span) return;
    gen.prevRegion = gen.region;
    gen.regionIdx = (gen.regionIdx + 1) % regionCount(key);
    gen.region = regionAt(key, gen.regionIdx);
    gen.regionStartS = gen.s;
    gen.regionTransS = gen.s;
    world.pendingRegion = gen.region;      // the codriver mentions it on arrival
  }

  /* The way out.
   *
   * "Point away from the nearby road" is not good enough — averaging
   * directions can aim straight down a corridor that closes 150 m later,
   * which is exactly the pocket the generator gets stuck in. So march
   * instead: cast rays every 22° and walk each one out until road comes
   * within reach, then take the bearing with the most room, tie-broken
   * toward carrying straight on so the escape reads as a road decision
   * rather than a panic. */
  function clearanceAlong(bx, bz) {
    for (let d = 30; d <= 320; d += 20) {
      const px = gen.x + bx * d, pz = gen.z + bz * d;
      const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const arr = cellIndex.get((cx + dx) + "," + (cz + dz));
        if (!arr) continue;
        for (const i of arr) {
          if ((world.iNext + Math.round(d / DS)) - i < 20) continue;
          const m = i & MASK;
          const ox = X[m] - px, oz = Z[m] - pz;
          if (ox * ox + oz * oz < 28 * 28) return d;
        }
      }
    }
    return 1e9;
  }

  function escapeBearing() {
    let best = gen.heading, bestScore = -1e9;
    for (let k = 0; k < 16; k++) {
      const a = gen.heading + (k / 16) * Math.PI * 2;
      const room = Math.min(340, clearanceAlong(Math.cos(a), Math.sin(a)));
      // prefer room, then prefer not turning much
      const turn = Math.abs(Math.atan2(Math.sin(a - gen.heading), Math.cos(a - gen.heading)));
      const score = room - turn * 26;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }

  function ensure(s) {
    // what the car is driving on right now (physics reads these)
    const here = biomeAt(s);
    world.offroadKey = (here.t < 0.5 ? here.prev : here.biome).ground;
    world.hereBiome = here;
    world.hereRegion = regionOf(s);
    // a region may own its verges too — above the snow line the run-off
    // is a drift that catches a wheel, not the valley's grass
    const hrg = world.hereRegion;
    const hereReg = hrg && (hrg.t < 0.5 ? hrg.prev : hrg.region);
    if (hereReg && hereReg.ground) world.offroadKey = hereReg.ground;
    let guard = 0;
    while (!world.hold && gen.s < s + AHEAD && guard++ < 24) {
      const room = world.legEndS - gen.s;
      const isWay = room < 60;
      advanceRegion(isWay);
      /* Does a special event take this section over? Asked once per
       * section, deterministic per (seed, sectionIndex), and gated on
       * distance into the run, room before the next waystation, the
       * country, and how long it has been since the last one. */
      const event = isWay ? null : pickEvent({
        seed, sectionIndex: gen.sectionIndex, s: gen.s, biomeKey: gen.biome.key,
        room, lastEventS: world.lastEventS, recent: world.eventKeys,
        heat: gen.legPlan ? gen.legPlan.heat : 0,
        daring: gen.legPlan ? gen.legPlan.daring || 0 : 0,
        force: opts.forceEvent,
        burned: gen.burnedKey || null,
        feasible: (ev) => eventFeasible(ev),
      });
      let sec = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        const candidate = genSection(gen, attempt, {
          waystation: isWay, maxLen: isWay || event ? null : room - 20, event,
        });
        if (!validateSection(candidate)) continue;
        /* An event that asked the landscape for crossings gets a few
         * rolls of the geometry before we give up on it — each attempt is
         * a different line across the same noise field, so a different
         * amount of rock. Three failures and it drops to an ordinary
         * section rather than announcing something that is not there. */
        if (event && event.want && attempt < 3 && !eventDelivered(event, candidateSpans(candidate))) continue;
        if (event && event.needsDrop && attempt < 3 && !candidateDrop(candidate, event)) continue;
        sec = candidate;
        sec.acceptedBy = 'normal';
        break;
      }
      /* Every candidate collided with road already laid. Accepting one
       * anyway — which is what used to happen "statistically near-never" —
       * puts two decks a couple of metres apart, and then everything
       * downstream misbehaves in ways that look like other bugs: trees
       * placed legitimately beside one road stand in the middle of the
       * other, and a collider three metres overhead is still inside the
       * physics' vertical window, so the car hits a birch that is above
       * it. (A relentless technical descent does this reliably, which is
       * how it was found.) So: pick a bearing that points at empty ground
       * and drive out in a straight line first. */
      /* A waystation section is fixed geometry — approach, apron, depart,
       * all straight — so its four "attempts" are the same road four
       * times, and if that road collides there is no alternative to find.
       * Drive out first and let the waystation land a couple of hundred
       * metres later; the leg is not measured that finely. */
      // fan out from the emptiest bearing, then further, then back the way
      // we came (computed only when something has actually gone wrong)
      const spreadB = [0, 0.5, -0.5, 1.0, -1.0, 1.7, -1.7, 2.4, -2.4, 3.0];
      const baseB = sec ? 0 : escapeBearing();
      if (!sec) {
        for (const short of [false, true]) {
          for (let k = 0; k < spreadB.length && !sec; k++) {
            gen.bearing = baseB + spreadB[k];
            for (let attempt = 0; attempt < 2; attempt++) {
              const candidate = genSection(gen, 200 + (short ? 90 : 0) + k * 8 + attempt, { escape: true, escapeShort: short });
              if (validateSection(candidate)) { sec = candidate; sec.acceptedBy = 'escape'; break; }
            }
          }
          if (sec) break;
        }
      }
      /* Still boxed in — roughly once every six hundred kilometres, in a
       * pocket the road has wrapped itself around. Rather than accept
       * something wholly unchecked, relax the separation and take the
       * least bad option: the roads may end up closer than the rule likes,
       * but they will not be on top of each other, and `pruneOverlaid`
       * below cleans up anything the new road now stands on. */
      if (!sec) {
        /* the two softest steps exist for the once-per-thousands-of-km
         * pocket (gen-400's seed 87) where even 0.4 finds nothing: a road
         * checked at 0.18 still refuses direct overlap, which is strictly
         * better than the unchecked acceptance below it */
        for (const relax of [0.75, 0.55, 0.4, 0.28, 0.18]) {
          for (let k = 0; k < spreadB.length && !sec; k++) {
            gen.bearing = baseB + spreadB[k];
            for (const short of [true, false]) {
              const candidate = genSection(gen, 300 + k * 4 + (short ? 2 : 0), { escape: true, escapeShort: short });
              if (validateSection(candidate, relax)) { sec = candidate; sec.acceptedBy = 'relax' + relax; break; }
            }
          }
          if (sec) break;
        }
      }
      if (!sec) {
        world.rejects = (world.rejects || 0) + 1;
        world.rejectAt = gen.s;
        sec = genSection(gen, 0, { escape: true });
      }
      const laidWaystation = sec.waystationS != null;
      appendSection(sec);
      commitSection(gen, sec);
      if (isWay && laidWaystation) {
        world.hold = true;      // wait for the route choice
        if (opts.onHold) opts.onHold(world);   // headless tools auto-choose
      }
    }
    cullBehind(s);
  }

  /* The player chose a route at the waystation: release generation. */
  /* Switch country at the frontier. The one joint both the route system
   * and the debug teleport use, so regions, transitions and palettes
   * always follow the same way. */
  function jumpBiome(key) {
    if (!BIOMES[key] || BIOMES[key] === world.biome) return;
    world.prevBiome = world.biome;
    world.biome = BIOMES[key];
    gen.biome = world.biome;
    world.transitionS = gen.s;
    // a new country starts at the head of its own ring of regions
    gen.prevRegion = gen.region;
    gen.regionIdx = 0;
    gen.region = regionAt(world.biome.key, 0);
    gen.regionStartS = gen.s;
    gen.regionTransS = gen.s;
  }

  function chooseRoute(route) {
    world.route = route;
    gen.route = route;
    world.legIndex++;
    /* The director's plan for this leg — intensity wave, heat, weather
     * arc — authored in game/director.js, consumed here as plain data.
     * A chosen danger-3 card is how tier 10 is ever entered. */
    world.legPlan = opts.plan ? opts.plan(world.legIndex, route.danger || 0) : null;
    gen.legPlan = world.legPlan;
    gen.legStartS = gen.s;
    world.legStartS = gen.s;
    const ws = world.waystations[world.waystations.length - 1];
    world.legEndS = (ws ? ws.s : gen.s) + route.len;
    // a route into another country: the transition begins where the road
    // resumes past the waystation and takes TRANSITION_LEN metres
    if (route.biome && BIOMES[route.biome] && BIOMES[route.biome] !== world.biome) {
      jumpBiome(route.biome);
    }
    world.hold = false;
  }

  function nextWaystation(carS) {
    for (const ws of world.waystations) if (ws.s > carS - 20) return ws;
    return null;
  }

  /* ------------------------------------------------------------- expose */
  world.roadQuery = roadQuery;
  world.groundHeight = groundHeight;
  world.groundAtSample = groundAtSample;
  world.sampleNear = sampleNear;
  world.profileAt = profileAt;
  world.ensure = ensure;
  world.colliderHash = colliderHash;
  world.frontierS = () => gen.s;
  world.chooseRoute = chooseRoute;
  world.jumpBiome = jumpBiome;    // debug: mid-run country teleport
  // the hidden strip the car is beside, if any (the diary asks)
  world.oldRoadAt = (s) => {
    for (const o of world.oldRoads) if (s >= o.s0 - 20 && s <= o.s1 + 20) return o;
    return null;
  };
  world.nextWaystation = nextWaystation;
  world.setFirstRoute = (route) => {
    gen.route = route; world.route = route;
    /* `?leg1=` (opts.firstLegLen) survives the opener being set — this
     * line used to clobber it, which quietly killed the "force a
     * waystation" debug param in the browser while the roadmap said it
     * was delivered (found trying to screenshot a waystation) */
    world.legEndS = opts.firstLegLen || route.len;
    world.legPlan = opts.plan ? opts.plan(0, route.danger || 0) : null;
    gen.legPlan = world.legPlan;
    gen.legStartS = 0;
    world.legStartS = 0;
  };
  world.biomeAt = biomeAt;
  /* The crossing the car is inside, and how enclosed it is (0 at a portal,
   * 1 in the middle) — the lighting, the fog and the engine reverb all
   * read this, and so does the harness. */
  world.spanAt = (s) => {
    for (const sp of world.spans) if (s >= sp.s0 && s <= sp.s1) return sp;
    return null;
  };
  world.eventAt = (s) => {
    for (const e of world.events) if (s >= e.s0 && s <= e.s1) return e;
    return null;
  };
  world.spanEnclosure = (s) => {
    const sp = world.spanAt(s);
    if (!sp || sp.kind !== TUNNEL) return 0;
    return spanStrength(sp, s);
  };
  world.regionOf = regionOf;
  world.regionMul = regionMul;
  world.crossGround = crossGround;
  // the far shell's ground (render-only: the sim never reads these)
  world.nearestSampleFar = nearestSampleFar;
  world.farGround = farGround;
  /* ONE definition of where an overpass pier may stand, shared by the
   * renderer and the harness: never on, or within a car's width of, the
   * road the deck crosses. */
  world.pierFootClear = (i) => {
    const m = i & MASK;
    if (!OVR[m]) return true;              // not an overpass deck: nothing below
    const px = X[m], pz = Z[m], py = Y[m];
    const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const arr = cellIndex.get((cx + dx) + "," + (cz + dz));
      if (!arr) continue;
      for (const j of arr) {
        if (Math.abs(j - i) < 13) continue;                    // the deck itself
        const mj = j & MASK;
        if (Y[mj] > py - 3) continue;                          // not below the deck
        if (Math.hypot(X[mj] - px, Z[mj] - pz) < HW[mj] + 3.5) return false;
      }
    }
    return true;
  };
  world.overAt = (i) => OVR[i & MASK];
  world.hereBiome = { biome, prev: biome, t: 1 };
  world.ring = { X, Z, Y, HD, KV, CB, HW, GR, SF, FL, RLF, EVW, OLD, MASK, SURF_IDS };

  return world;
}
