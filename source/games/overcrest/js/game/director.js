/* Overcrest — the journey director.
 *
 * v1 decided only WHERE: which country each offered route leads into.
 * v2 composes the journey: how hard a leg runs (a difficulty band that
 * ramps and then breathes), how a leg is SHAPED inside itself (an
 * intensity wave, so four kilometres breathe instead of running at one
 * pitch), what the sky is planning (weather arcs — a storm leg builds and
 * clears rather than flickering), and how far apart the spectacle sits.
 *
 * Everything here is a pure function of (seed, legIndex) — the director
 * has no state to save because the journey IS its state: replaying the
 * same choices on the same seed reconstructs every decision it ever made.
 * DOM-free.
 */

import { rng, hashCombine } from "../core/rng.js";
import { BIOMES } from "../world/biomes.js";

/* ------------------------------------------------------------ countries */

/* Assign biomes to a set of offered routes (mutates and returns them). */
export function assignBiomes(seed, legIndex, currentKey, legsInBiome, routes) {
  const r = rng(hashCombine(seed, 0xd1e + legIndex * 31));
  const cur = BIOMES[currentKey];
  const neigh = Object.entries(cur.neighbours || {}).filter(([k]) => BIOMES[k]);
  const pickNeighbour = () => {
    if (!neigh.length) return currentKey;
    return r.weighted(neigh.map(([k, w]) => ({ k, w }))).k;
  };
  const n = routes.length;
  let leaving = 0;
  /* The Verge is a place you visit, not a place you stay: two legs at most
   * before every road leads back out. */
  const stayCap = currentKey === "verge" ? 2 : 4;
  routes.forEach((route, i) => {
    let key = currentKey;
    const mustLeave = legsInBiome >= stayCap || (legsInBiome >= 2 && i === n - 1 && leaving === 0);
    const mayLeave = legsInBiome >= 1 && r.chance(legsInBiome >= 3 ? 0.7 : 0.35);
    if (mustLeave || (mayLeave && i > 0)) { key = pickNeighbour(); if (key !== currentKey) leaving++; }
    route.biome = key;
    route.biomeName = BIOMES[key].name;
    route.changes = key !== currentKey;
    if (route.changes) {
      route.desc = route.desc + " Crosses into " + route.biomeName + ".";
      route.len = Math.round((route.len + 400) / 100) * 100;   // room for the transition
    }
  });
  /* THE VERGE. On no country's neighbour map — deep into a journey (leg 12,
   * roughly forty kilometres) the LAST offered route may cross over. Rare,
   * never the first card, and gated on distance so it reads as having gone
   * somewhere: the bible's surrealism rule, written as a map edge that only
   * exists once the journey has earned it. The card says where it goes; the
   * director never says more. */
  if (legIndex >= 12 && currentKey !== "verge" && BIOMES.verge && r.chance(0.22)) {
    const route = routes[n - 1];
    if (!route.changes) route.len = Math.round((route.len + 400) / 100) * 100;
    route.biome = "verge";
    route.biomeName = BIOMES.verge.name;
    route.changes = true;
    route.desc = route.desc.replace(/ Crosses into [^.]+\./, "") + " Crosses into The Verge.";
  }
  return routes;
}

/* ----------------------------------------------------------- difficulty
 *
 * The bible's band: 1–4 early, drifting up to oscillate in 4–8. Tier 10
 * exists but is only ever ENTERED by choosing it — a danger-3 card adds
 * its own two steps on top for that leg, so the spike is brief and the
 * player signed for it. `heat` is the tier folded to 0..1 for systems
 * that want a knob rather than a number. */
export function tierFor(seed, legIndex, chosenDanger, daring) {
  let base;
  if (legIndex <= 0) base = 1;
  else if (legIndex === 1) base = 2;
  else if (legIndex === 2) base = 3;
  else {
    const r = rng(hashCombine(seed, 0x71e8 + legIndex * 7));
    base = 4 + Math.floor(r() * 5) * 0.999;                 // 4..8
    // never two extremes back to back: pull toward the middle of the band
    const prev = rng(hashCombine(seed, 0x71e8 + (legIndex - 1) * 7));
    const pb = 4 + Math.floor(prev() * 5) * 0.999;
    if (Math.abs(base - pb) > 3) base = (base + pb) / 2;
    /* The departure lean (Addendum I): arrive at the waystation in the
     * zone and the road dares more; arrive ragged and it breathes. A lean
     * INSIDE the band — never past 8 without a chosen danger (tier 10
     * stays something you only ever enter by choosing it), never below a
     * breath, and never touching the teaching ramp of the first legs. */
    if (daring) base = Math.max(3, Math.min(8, base + daring));
  }
  const spice = chosenDanger >= 3 ? 2 : 0;
  return Math.min(10, Math.round(base + spice));
}

/* -------------------------------------------------------- the leg plan
 *
 * One object per (seed, legIndex): everything the generator and the sky
 * need to give this leg a shape of its own. */

const ARCS = [
  { key: "fair", w: 3.0, cloud: 0.75, rain: 0.55, fog: 0.7 },     // the sky stands back
  { key: "neutral", w: 4.0, cloud: 1, rain: 1, fog: 1 },
  { key: "brooding", w: 1.6, cloud: 1.45, rain: 0.9, fog: 1.0 },  // heavy sky, dry road
  { key: "wet", w: 1.2, cloud: 1.35, rain: 1.7, fog: 0.9 },       // the storm leg
  { key: "murk", w: 0.9, cloud: 1.05, rain: 0.8, fog: 1.75 },     // the fog leg
];

export function legPlan(seed, legIndex, chosenDanger, depFlow) {
  const r = rng(hashCombine(seed, 0xd1c7 + legIndex * 19));
  /* The director reads the DEPARTURE (Addendum I): the flow tier the player
   * left the previous waystation with, sampled once at the boundary and
   * recorded beside the route choice — so a resumed run replays the same
   * lean (the danger-pick pattern; the plan stays a pure function of its
   * inputs). Unknown (an old save, a headless tool that does not track
   * flow) means neutral, which is also what every leg was before the lean
   * existed. The lean touches the tier — and through it the heat and the
   * intensity waves — and the event spacing (`daring` read by pickEvent).
   * It must NEVER touch the weather: the sky does not answer your driving. */
  const daring = depFlow == null ? 0 : depFlow >= 4 ? 1 : depFlow <= 1 ? -1 : 0;
  const tier = tierFor(seed, legIndex, chosenDanger || 0, daring);
  /* Never two identical non-neutral arcs in a row: a second consecutive
   * storm leg reads as broken weather, not drama. */
  let arc = r.weighted(ARCS.map((a) => ({ a, w: a.w }))).a;
  if (legIndex > 0 && arc.key !== "neutral") {
    // the previous leg's arc is that stream's FIRST draw, same as ours
    const pr = rng(hashCombine(seed, 0xd1c7 + (legIndex - 1) * 19));
    const prevArc = pr.weighted(ARCS.map((a) => ({ a, w: a.w }))).a;
    if (prevArc.key === arc.key) arc = ARCS[1];
  }
  return {
    legIndex,
    tier,
    daring,
    heat: (tier - 1) / 9,                                   // 0..1
    wave: {
      len: 1500 + r() * 900,                                // one full breath: 1.5–2.4 km
      phase: r() * Math.PI * 2,
    },
    arc,
  };
}

/* The wave and heat MATH lives in world/roadgen.js (the generator's side
 * of the contract); this module only authors the plan data, so the
 * layering stays one-way: game/ imports world/, never the reverse. */

/* ------------------------------------------------- routes read the build
 *
 * "Routes should interact with builds." Souvenirs carry tags; tags point
 * at the roads they pay out on. Two or more souvenirs pointing the same
 * way is a specialization, and the card that feeds it gets ONE quiet
 * marker — never an explanation. Protect the "ohhhh". */
const TAG_ROADS = {
  drift: ["tech"], flow: ["flow"], speed: ["fast"], "no-brake": ["fast", "flow"],
  jump: ["crests"], boost: ["fast"], offroad: ["crests"], pickup: ["tech"],
  momentum: ["fast"], precision: ["tech"],
};

export function buildAffinity(defs) {
  const score = {};
  for (const d of defs || []) {
    for (const tag of d.tags || []) {
      for (const road of TAG_ROADS[tag] || []) score[road] = (score[road] || 0) + 1;
    }
  }
  return score;
}

export function markSuitedRoutes(routes, defs) {
  const aff = buildAffinity(defs);
  for (const r of routes) r.suits = (aff[r.key] || 0) >= 2;
  return routes;
}


