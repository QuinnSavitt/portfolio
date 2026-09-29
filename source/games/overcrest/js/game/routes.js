/* Overcrest — route cards.
 *
 * At each waystation the journey forks. A route is a personality laid over
 * the generator: mood weights, length, appetite for crests/jumps/lakes, a
 * danger rating and a promise. Names are composed from the biome's own
 * vocabulary so "Sawmill Cut" and "Long Meadows" feel like places on a
 * map, not menu options. Deterministic per (seed, legIndex).
 */

import { rng, hashCombine } from "../core/rng.js";

/* Exported so the harness can measure the real cards rather than a copy of
 * them: a route that stops changing the road is a card that lies. */
export const ARCHETYPES = [
  {
    key: "flow", tag: "FLOWING", desc: "Long sweepers and linked fives. Settle in.",
    moodBias: { calm: 0.8, flow: 3.2, tech: 0.4, fast: 1.2 }, crest: 1.1, jump: 0.7, lake: 1.2,
    len: [3000, 4400], danger: 1,
  },
  {
    key: "tech", tag: "TECHNICAL", desc: "Tight and busy: hairpins, S-bends, no rest.",
    moodBias: { calm: 0.5, flow: 1, tech: 3.4, fast: 0.4 }, crest: 0.6, jump: 0.3, lake: 0.4,
    len: [2600, 3600], danger: 3,
  },
  {
    key: "fast", tag: "FAST", desc: "Open road, big straights, flat-out sixths.",
    moodBias: { calm: 1, flow: 1.4, tech: 0.3, fast: 3.4 }, crest: 1.1, jump: 1.25, lake: 0.6,
    len: [3600, 5200], danger: 2,
  },
  {
    /* Brows live in the phrases that fast and flowing roads use, so this
     * card has to send the road there — leaning on tech instead just
     * produced a busy road with nothing to fly over, and FAST was quietly
     * out-cresting the crest route. */
    key: "crests", tag: "CRESTS", desc: "The road climbs and drops. Blind brows all the way.",
    moodBias: { calm: 1, flow: 2, tech: 0.45, fast: 2.4 }, crest: 3.2, jump: 1.4, lake: 0.3,
    len: [2800, 4000], danger: 3,
  },
  {
    key: "calm", tag: "EASY", desc: "Gentle. Lakes and long straights. Breathe.",
    moodBias: { calm: 3.6, flow: 1.4, tech: 0.2, fast: 0.6 }, crest: 0.6, jump: 0.3, lake: 2.4,
    len: [2600, 3400], danger: 1,
  },
  {
    key: "mixed", tag: "MIXED", desc: "A bit of everything. Busy, then not.",
    moodBias: { calm: 1, flow: 1, tech: 1, fast: 1 }, crest: 1, jump: 1, lake: 1,
    len: [3000, 4400], danger: 2,
  },
];

const NAME_A = ["Sawmill", "Lakeshore", "Old Timber", "Ridge", "Long Meadow", "Birch", "Ferry", "Marsh", "Church", "North", "Kettle", "Owl", "Charcoal", "Elk", "Quarry", "Winter"];
const NAME_B = { flow: ["Run", "Road", "Sweep"], tech: ["Cut", "Twist", "Ladder"], fast: ["Straight", "Express", "Line"], crests: ["Brows", "Rise", "Backs"], calm: ["Lane", "Way", "Shore"], mixed: ["Route", "Road", "Track"] };

/* `bias` is THE DECK's route half ({len, crest, jump, lake} multipliers from
 * the build) laid over every card AFTER the deal — the rng stream is never
 * touched, so a ledger of the bias per leg replays the same deal with the
 * same lean (main keeps that ledger beside the departure tiers). Length
 * rounds to the hundred like the deal did and stays inside what a leg can
 * be; appetites are the generator's own multipliers. */
export function routesFor(seed, legIndex, extra, avoidKey, bias) {
  const out = dealRoutes(seed, legIndex, extra, avoidKey);
  if (bias) {
    for (const o of out) {
      if (bias.len && bias.len !== 1) o.len = Math.max(1500, Math.min(8000, Math.round((o.len * bias.len) / 100) * 100));
      if (bias.crest && bias.crest !== 1) o.crest = o.crest * bias.crest;
      if (bias.jump && bias.jump !== 1) o.jump = o.jump * bias.jump;
      if (bias.lake && bias.lake !== 1) o.lake = o.lake * bias.lake;
    }
  }
  return out;
}

function dealRoutes(seed, legIndex, extra, avoidKey) {
  const r = rng(hashCombine(seed, 0x707 + legIndex * 13));
  const n = (r.chance(0.35) ? 3 : 2) + (extra || 0);   // extra: souvenirs add options
  /* Anti-repetition: the archetype just driven is off the table this stop
   * (the director's memory, one entry long — enough to stop TECHNICAL →
   * TECHNICAL → TECHNICAL without making the deck feel managed). */
  const pool = ARCHETYPES.filter((a) => a.key !== avoidKey);
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    const at = Math.floor(r() * pool.length);
    const a = pool.splice(at, 1)[0];
    const len = Math.round(r.range(a.len[0], a.len[1]) / 100) * 100;
    const nameA = r.pick(NAME_A);
    const nameB = r.pick(NAME_B[a.key]);
    out.push({
      key: a.key, tag: a.tag, desc: a.desc,
      name: nameA + " " + nameB,
      moodBias: a.moodBias, crest: a.crest, jump: a.jump, lake: a.lake,
      len, danger: a.danger,
      reward: a.danger >= 3 ? "rare pick likelier" : a.danger === 2 ? "steady" : "gentle",
    });
  }
  return out;
}

/* Leg 1 is not a choice: a warm opener that teaches by road. */
export const OPENER = {
  key: "opener", tag: "OPENER", name: "Home Road", desc: "The way out. Learn the car.",
  moodBias: { calm: 2.5, flow: 2, tech: 0.3, fast: 0.6 }, crest: 0.8, jump: 0.5, lake: 1.5,
  len: 2800, danger: 1, reward: "gentle",
};
