/* Overcrest — special events.
 *
 * An event is a section-level takeover: for six hundred to a thousand
 * metres the ordinary mood machine stands aside and the road becomes one
 * deliberate thing — a run of tunnels, a viaduct, a descent that only goes
 * down, a plain so flat there is nothing to steer around.
 *
 * Three rules the bible is firm about, and they shape this whole file:
 *
 *   "Do not overuse events. They should remain surprising."
 * so events are rare, spaced by kilometres, and gated on run distance —
 * the strangest ones cannot happen until a journey has earned them.
 *
 *   The world must stay honest.
 * so an event never PAINTS a crossing where the ground would not carry
 * one. What it does is lean on the detection thresholds (`spanBias`) so
 * that a stretch of merely-hilly ground becomes a stretch of tunnels. The
 * rock is still real rock; the event only asks for more of it.
 *
 *   ...and therefore an event can fail.
 * If the landscape does not deliver what was asked for, the event is
 * DROPPED before anything is announced (`want`, checked against the
 * candidate section). A codriver calling tunnels that are not there is a
 * worse bug than a leg with no event in it.
 *
 * Deterministic per (seed, sectionIndex). Pure data + arithmetic, DOM-free.
 */

import { rng, hashCombine } from "../core/rng.js";
import { str, corner, F_LAKE_L, F_LAKE_R } from "./roadgen.js";
import { TUNNEL, BRIDGE } from "./spans.js";

/* How often a tier may appear, and how far into a run it unlocks. Distance
 * is the gate that makes a long journey feel like it went somewhere. */
export const RARITY = {
  uncommon: { weight: 1.0, minRunS: 2600 },
  rare: { weight: 0.42, minRunS: 7000 },
  veryRare: { weight: 0.14, minRunS: 22000 },
};

export const EVENT_GAP = 2400;      // metres of ordinary road between events
const BASE_CHANCE = 0.26;           // per eligible section, before rarity

/* ------------------------------------------------------------- the events */

export const EVENTS = [
  {
    key: "tunnels",
    name: "The Tunnel Network",
    banner: "TUNNEL NETWORK",
    rarity: "rare",
    len: [700, 1000],
    mood: "flow",
    call: "tunnels now, one after another",
    /* Ask the crossing detector for tunnels at a little over half its
     * usual appetite for rock, and let them sit closer together than the
     * world would normally allow — daylight between bores is the whole
     * shape of the thing. */
    spanBias: { tunnel: 0.52, bridge: 1, gap: 130 },
    want: { kind: TUNNEL, count: 2 },
    build(gen, r, b) {
      /* Fast and open between the bores: a tunnel network is about rhythm
       * and light, and a hairpin inside a mountain is just unpleasant. */
      const ops = [];
      for (let i = 0; i < 5; i++) {
        ops.push(str(r.range(120, 200)));
        if (r.chance(0.55)) ops.push(corner(gen, r, b, r.pick([5, 6, 6, "flat"])));
      }
      return ops;
    },
  },
  {
    key: "viaduct",
    name: "The Viaduct",
    banner: "THE VIADUCT",
    rarity: "rare",
    len: [520, 760],
    mood: "fast",
    call: "big bridge coming. nothing either side of you",
    spanBias: { tunnel: 1, bridge: 0.5, gap: 200 },
    want: { kind: BRIDGE, count: 1, minLen: 200 },
    build(gen, r, b) {
      const ops = [str(r.range(150, 240)), corner(gen, r, b, r.pick([6, "flat"]))];
      ops.push(str(r.range(220, 320)));
      if (r.chance(0.6)) ops.push(corner(gen, r, b, 6));
      ops.push(str(r.range(120, 200)));
      return ops;
    },
  },
  {
    key: "village",
    name: "The Village Below",
    banner: "THE VILLAGE BELOW",
    rarity: "uncommon",
    /* Measured (27 km forced per country): Heartland cannot drop ten
     * metres at all and Norrland almost never — an event that cannot
     * deliver is dead content. Redgate delivers handsomely but stays out
     * on identity: that country's whole voice is that nobody lives there. */
    biomes: ["costa", "aspenvale", "thornmoor", "kaldbrekka", "highline", "kurotani", "sandreach", "ventisca"],
    len: [620, 900],
    mood: "flow",
    call: "village down in the valley",
    /* The road rides a shoulder with real fall on one side, and a hamlet
     * stands on the floor below — always there by day, and after dusk its
     * windows come up with the night, which is the bible's "lit village
     * far below in the dark" without a single scripted light. The event
     * needs the geology to provide the "below" (needsDrop), and fails
     * honestly where it does not. */
    needsDrop: { drop: 10, lat: 48, run: 30 },
    village: true,
    build(gen, r, b) {
      /* Gentle flowing road: sweepers and breathing room, so the eye is
       * free to wander down to the rooftops. */
      const ops = [str(r.range(120, 190)), corner(gen, r, b, r.pick([5, 6]))];
      ops.push(str(r.range(160, 260)));
      ops.push(corner(gen, r, b, r.pick([4, 5, 6])));
      ops.push(str(r.range(140, 220)));
      if (r.chance(0.5)) ops.push(corner(gen, r, b, 6));
      ops.push(str(r.range(100, 170)));
      return ops;
    },
  },
  {
    key: "suspension",
    name: "The Suspension Bridge",
    banner: "THE SUSPENSION BRIDGE",
    rarity: "rare",
    /* Only countries whose geology can actually deliver a 15 m gorge —
     * measured: Norrland's relief tops out around 8 m and Kaldbrekka's
     * around 14, so the event would be a permanent honest-fail there,
     * which is dead content wearing a rarity tier. */
    biomes: ["aspenvale", "costa", "thornmoor", "highline", "kurotani"],
    len: [560, 820],
    mood: "fast",
    call: "the great bridge. a long way down under you",
    /* Ask the landscape for one deep, long crossing. The towers and
     * cables are dressing on a bridge the ground honestly carries —
     * `minDepth` is what keeps a suspension bridge from being built over
     * a ditch, which would read as a folly, not a landmark. */
    spanBias: { tunnel: 1, bridge: 0.42, gap: 260 },
    want: { kind: BRIDGE, count: 1, minLen: 240, minDepth: 15 },
    suspension: true,
    build(gen, r, b) {
      const ops = [str(r.range(160, 240)), corner(gen, r, b, r.pick([6, "flat"]))];
      ops.push(str(r.range(280, 380)));
      if (r.chance(0.55)) ops.push(corner(gen, r, b, "flat"));
      ops.push(str(r.range(140, 220)));
      return ops;
    },
  },
  {
    key: "saltflat",
    name: "The Flats",
    banner: "THE FLATS",
    rarity: "rare",
    biomes: ["redgate"],
    len: [800, 1150],
    mood: "fast",
    width: 2.05,               // the road opens out until the edges stop mattering
    terr: 0.07,                // and the land goes dead flat to the horizon
    trend: 0,
    call: "flat out from here. there is nothing out there",
    build(gen, r, b) {
      /* Bible: "salt-flat speed section (VCAP territory, no corners,
       * everything hazy)". Two barely-there kinks in a kilometre, purely
       * so the horizon moves and the eye has something to hold. */
      const ops = [str(r.range(300, 420))];
      ops.push(corner(gen, r, b, "flat"));
      ops.push(str(r.range(260, 380)));
      if (r.chance(0.6)) { ops.push(corner(gen, r, b, "flat")); ops.push(str(r.range(180, 300))); }
      return ops;
    },
    marks: [{ type: "saltpost", lat: [16, 16], line: 90 }],
  },
  {
    key: "descent",
    name: "The Long Descent",
    banner: "THE LONG DESCENT",
    rarity: "uncommon",
    len: [640, 980],
    mood: "tech",
    trend: -1.45,              // multiples of the biome's own trend limit
    call: "long way down from here. save the brakes",
    build(gen, r, b) {
      /* Downhill is where a rally road is at its most demanding, so this
       * one is corners: linked, tightening, and never a rest. */
      const ops = [str(r.range(60, 110))];
      for (let i = 0; i < 5; i++) {
        ops.push(corner(gen, r, b, r.pick([2, 3, 3, 4, 4, 5])));
        ops.push(str(r.range(20, 55)));
      }
      if (r.chance(0.5)) ops.push(corner(gen, r, b, "hp"));
      return ops;
    },
  },
  {
    key: "pass",
    name: "The Pass",
    banner: "THE PASS",
    rarity: "uncommon",
    len: [620, 940],
    mood: "flow",
    trend: 1.4,
    call: "climbing to the pass. big view at the top",
    build(gen, r, b) {
      const ops = [];
      for (let i = 0; i < 4; i++) {
        ops.push(str(r.range(70, 130)));
        ops.push(corner(gen, r, b, r.pick([3, 4, 4, 5, "hp"])));
      }
      // the last straight carries the crest, so the view arrives at speed
      ops.push(str(r.range(150, 220), { kind: "crest", at: 0.72 }));
      return ops;
    },
    marks: [{ type: "cairn", perKm: 5, lat: [4, 12] }],
  },
  {
    key: "windfarm",
    name: "The Wind Farm",
    banner: "THE WIND FARM",
    rarity: "uncommon",
    len: [600, 900],
    mood: "fast",
    call: "turbines ahead. the road runs right under them",
    build(gen, r, b) {
      const ops = [str(r.range(200, 320), r.chance(0.4) ? { kind: "crest", at: 0.5 } : null)];
      ops.push(corner(gen, r, b, r.pick([5, 6, "flat"])));
      ops.push(str(r.range(180, 300)));
      if (r.chance(0.7)) { ops.push(corner(gen, r, b, "flat")); ops.push(str(r.range(140, 220))); }
      return ops;
    },
    /* Bible: "highway beneath massive wind turbines". They are 40 m tall,
     * so they want distance — close up they are a wall, and the point is
     * the scale you read against the horizon. */
    marks: [{ type: "turbine", perKm: 9, lat: [45, 190] }],
  },
  {
    key: "ford",
    name: "The Ford",
    banner: "THE FORD",
    rarity: "uncommon",
    len: [520, 760],
    mood: "flow",
    ford: 26,                  // metres of water across the road
    call: "water across the road in a moment. slow for it",
    build(gen, r, b) {
      /* Approach, the hollow the water sits in, and enough road afterwards
       * to gather the car up: a ford is a grip event, and the mistake it
       * punishes is made before it, not in it. */
      const ops = [str(r.range(110, 170)), corner(gen, r, b, r.pick([4, 5]))];
      ops.push(str(r.range(150, 210), { kind: "dip", at: 0.55 }));
      ops.push(corner(gen, r, b, r.pick([3, 4, 5])));
      ops.push(str(r.range(120, 190)));
      return ops;
    },
  },
  {
    key: "canyon",
    name: "The Canyon",
    banner: "THE CANYON",
    rarity: "rare",
    len: [700, 1050],
    mood: "flow",
    walls: 26,                 // metres of rock standing up either side
    terr: 0.5,
    trend: -0.4,
    call: "into the canyon. walls both sides, no run-off",
    build(gen, r, b) {
      /* A canyon road follows the water that cut it: long sweepers that
       * you cannot see the end of, and nowhere at all to put a mistake. */
      const ops = [];
      for (let i = 0; i < 5; i++) {
        ops.push(str(r.range(90, 160)));
        ops.push(corner(gen, r, b, r.pick([4, 5, 5, 6])));
      }
      return ops;
    },
    marks: [{ type: "waterfall", perKm: 2.2, lat: [9, 16] }],
  },
  {
    key: "circuit",
    name: "The Old Circuit",
    banner: "THE OLD CIRCUIT",
    rarity: "rare",
    len: [620, 900],
    mood: "tech",
    surf: "tarmac",            // somebody laid this, a long time ago
    width: 1.25,
    trend: 0,
    call: "old racing surface. kerbs on the apexes, use them",
    build(gen, r, b) {
      /* Bible: "abandoned rally circuit (old tarmac, painted kerbs)". A
       * circuit is not a road: the corners are deliberate, evenly spaced
       * and repeat, which is exactly what a road generator is built never
       * to do — so it reads as man-made the moment you are on it. */
      const ops = [];
      const d0 = r.chance(0.5) ? 1 : -1;
      for (let i = 0; i < 4; i++) {
        ops.push(str(r.range(90, 140)));
        ops.push(corner(gen, r, b, r.pick([3, 4]), { dir: i % 2 ? -d0 : d0 }));
        ops.push(str(r.range(40, 70)));
        ops.push(corner(gen, r, b, r.pick([2, 3]), { dir: i % 2 ? d0 : -d0 }));
      }
      return ops;
    },
    marks: [{ type: "kerb", line: 5, lat: [0.25, 0.25], onCorner: 0.006, hug: true }],
  },
  {
    key: "observatory",
    name: "The Observatory",
    banner: "THE OBSERVATORY",
    rarity: "rare",
    minRunKm: 0,
    len: [600, 880],
    mood: "flow",
    trend: 1.25,
    call: "observatory on the ridge. the road goes right past it",
    build(gen, r, b) {
      const ops = [];
      for (let i = 0; i < 4; i++) {
        ops.push(str(r.range(90, 150)));
        ops.push(corner(gen, r, b, r.pick([4, 5, 5, 6])));
      }
      ops.push(str(r.range(140, 200), { kind: "crest", at: 0.6 }));
      return ops;
    },
    // one building, on the high side, two thirds of the way through
    marks: [{ type: "observatory", once: 0.66, lat: [14, 22], side: "uphill" }],
  },
  {
    key: "levelcrossing",
    name: "The Level Crossing",
    banner: "LEVEL CROSSING",
    rarity: "uncommon",
    len: [520, 780],
    mood: "calm",
    terr: 0.35,                // rail country is flat country
    trend: 0,
    call: "level crossing. straight over the rails",
    build(gen, r, b) {
      /* Rails demand a flat straight to cross on; the corners sit either
       * side of it, so the crossing itself is read at speed, dead ahead. */
      const ops = [str(r.range(90, 140)), corner(gen, r, b, r.pick([5, 6]))];
      ops.push(str(r.range(220, 300)));
      ops.push(corner(gen, r, b, r.pick([4, 5])));
      ops.push(str(r.range(110, 180)));
      return ops;
    },
    // the rails cross mid-event, on the long straight
    marks: [{ type: "railline", once: 0.5, onRoad: true, lat: [0, 0] }],
  },
  {
    key: "radiomast",
    name: "The Radio Mast",
    banner: "THE RADIO MAST",
    rarity: "uncommon",
    len: [600, 880],
    mood: "flow",
    trend: 1.1,
    call: "mast on the ridge. you will be seeing it for a while",
    build(gen, r, b) {
      const ops = [];
      for (let i = 0; i < 4; i++) {
        ops.push(str(r.range(90, 150)));
        ops.push(corner(gen, r, b, r.pick([4, 5, 5, 6])));
      }
      ops.push(str(r.range(130, 190), { kind: "crest", at: 0.65 }));
      return ops;
    },
    marks: [{ type: "radiomast", once: 0.68, lat: [13, 20], side: "uphill" }],
  },
  {
    key: "monastery",
    name: "The Monastery",
    banner: "THE MONASTERY",
    rarity: "rare",
    len: [620, 900],
    mood: "flow",
    trend: 0.85,
    call: "old monastery up on the hill. walls and sky now",
    build(gen, r, b) {
      /* A pilgrim road: patient, climbing, arriving. The switchback pair
       * below the ruin is the one place it asks anything of you. */
      const ops = [str(r.range(120, 180)), corner(gen, r, b, r.pick([4, 5]))];
      ops.push(str(r.range(70, 110)));
      ops.push(corner(gen, r, b, r.pick([2, 3])));
      ops.push(corner(gen, r, b, r.pick([2, 3])));
      ops.push(str(r.range(90, 140)));
      ops.push(corner(gen, r, b, r.pick([5, 6])));
      ops.push(str(r.range(110, 170)));
      return ops;
    },
    marks: [
      { type: "monastery", once: 0.62, lat: [15, 24], side: "uphill" },
      { type: "milestone", line: 120, lat: [1.2, 1.8] },
    ],
  },
  {
    key: "wreck",
    name: "The Wreck",
    banner: "THE WRECK",
    rarity: "rare",
    biomes: ["norrland", "costa"],
    len: [560, 820],
    mood: "calm",
    trend: -0.3,
    call: "down along the water. there is a wreck in the shallows",
    build(gen, r, b) {
      /* The event OWNS its lakeside: every straight and sweeper carries
       * the water flag on one chosen side, so the shore the hull needs is
       * a promise the road itself makes. */
      const side = r.chance(0.5) ? F_LAKE_L : F_LAKE_R;
      const away = side === F_LAKE_L ? 1 : -1;
      const ops = [str(r.range(80, 130), null, side)];
      ops.push(corner(gen, r, b, r.pick([5, 6]), { dir: r.chance(0.7) ? away : -away, flags: side }));
      ops.push(str(r.range(140, 220), null, side));
      ops.push(corner(gen, r, b, r.pick([4, 5]), { dir: away, flags: side }));
      ops.push(str(r.range(90, 150), null, side));
      return ops;
    },
    marks: [{ type: "shipwreck", once: 0.45, lat: [7, 14], side: "water" }],
  },
  {
    key: "damroad",
    name: "The Dam Road",
    banner: "THE DAM ROAD",
    rarity: "rare",
    biomes: ["norrland", "thornmoor", "aspenvale", "highline", "kurotani"],   // moor reservoirs and mountain dams
    len: [560, 800],
    mood: "calm",
    terr: 0.45,
    trend: 0,
    call: "across the dam. water one side, keep it neat",
    build(gen, r, b) {
      /* The road IS the dam: the crest is dead straight and dead level,
       * with the reservoir lying against it — the event owns its water
       * the way the wreck owns its shore. Concrete posts pace the crest;
       * the intake tower stands out in the water. */
      const side = r.chance(0.5) ? F_LAKE_L : F_LAKE_R;
      const away = side === F_LAKE_L ? 1 : -1;
      const ops = [str(r.range(90, 140))];
      ops.push(corner(gen, r, b, r.pick([5, 6]), { dir: away }));
      ops.push(str(r.range(240, 340), null, side));
      ops.push(corner(gen, r, b, r.pick([4, 5]), { dir: -away, flags: side }));
      ops.push(str(r.range(100, 160)));
      return ops;
    },
    marks: [
      { type: "dampost", line: 9, lat: [0.7, 1.0], side: "water" },
      { type: "intaketower", once: 0.5, lat: [9, 15], side: "water" },
    ],
  },
  {
    key: "flooded",
    name: "The Flooded Road",
    banner: "THE FLOODED ROAD",
    rarity: "uncommon",
    len: [560, 820],
    mood: "calm",
    ford: 120,                 // the rains took a whole stretch, not a dip
    terr: 0.55,
    trend: -0.25,
    call: "the rains took the road ahead. long water, keep it steady",
    build(gen, r, b) {
      /* The Ford is a splash; this is a commitment. A hundred and twenty
       * metres of standing water in the low ground, and the mistake it
       * punishes is arrogance rather than speed. */
      const ops = [str(r.range(100, 150)), corner(gen, r, b, r.pick([4, 5]))];
      ops.push(str(r.range(220, 300), { kind: "dip", at: 0.5 }));
      ops.push(corner(gen, r, b, r.pick([3, 4])));
      ops.push(str(r.range(110, 170)));
      return ops;
    },
  },
  {
    key: "detour",
    name: "The Detour",
    banner: "CONSTRUCTION DETOUR",
    rarity: "uncommon",
    len: [520, 720],
    mood: "tech",
    surf: "dirt",
    width: 0.85,               // a temporary road is never as wide as the real one
    call: "roadworks. narrow detour, watch the cones",
    build(gen, r, b) {
      /* A deviation nobody meant to keep: tight, fussy corners at working
       * pace, cones pinching the verge, a barrier at each end. */
      const ops = [str(r.range(70, 110))];
      for (let i = 0; i < 4; i++) {
        ops.push(corner(gen, r, b, r.pick([2, 3, 3, 4])));
        ops.push(str(r.range(40, 80)));
      }
      return ops;
    },
    marks: [
      { type: "barrier", once: 0.04, lat: [2.6, 3.2], facing: true },
      { type: "cone", line: 8, lat: [0.5, 0.8], hug: true },
      { type: "barrier", once: 0.96, lat: [2.6, 3.2], facing: true },
    ],
  },
  {
    key: "stadium",
    name: "The Rally Stadium",
    banner: "THE STADIUM",
    rarity: "rare",
    len: [560, 800],
    mood: "tech",
    surf: "dirt",
    width: 1.45,
    terr: 0.25,
    trend: 0,
    call: "into the stadium. big jump, then the hairpin. show off",
    build(gen, r, b) {
      /* Bible: "an empty arena with a jump and a hairpin". The stand is
       * empty and the kerbs are painted anyway — somebody drove here for
       * a crowd once, and today the crowd is you. A corner sets the
       * arrival speed for the jump — dirt-honest corner sizing raised the
       * old flat-out approach to a landing that hurt. */
      const ops = [str(r.range(90, 130))];
      ops.push(corner(gen, r, b, r.pick([4, 5])));
      ops.push(str(r.range(110, 160), { kind: "jump", at: 0.62 }));
      ops.push(str(r.range(60, 100)));
      ops.push(corner(gen, r, b, "hp"));
      ops.push(str(r.range(80, 120)));
      ops.push(corner(gen, r, b, r.pick([3, 4])));
      ops.push(str(r.range(90, 140)));
      return ops;
    },
    marks: [
      { type: "grandstand", once: 0.5, lat: [30, 42], facing: true },
      { type: "kerb", line: 5, lat: [0.25, 0.25], onCorner: 0.006, hug: true },
    ],
  },
  {
    key: "gallery",
    name: "The Gallery",
    banner: "THE GALLERY",
    rarity: "rare",
    noSpans: true,
    biomes: ["aspenvale", "kaldbrekka", "highline"],
    len: [560, 820],
    mood: "flow",
    trend: 0.35,
    call: "under the gallery. concrete overhead, keep your line",
    build(gen, r, b) {
      /* An avalanche gallery follows the contour of the slope that made
       * it necessary: long linked sweepers, never a hairpin — nobody
       * builds a colonnade around one. */
      const ops = [str(r.range(80, 130))];
      for (let i = 0; i < 4; i++) {
        ops.push(corner(gen, r, b, r.pick([5, 5, 6, 6])));
        ops.push(str(r.range(70, 120)));
      }
      return ops;
    },
    /* Posts both sides (visible pillars with real colliders — the wall the
     * bible allows), a roof spanning the deck, all on a tight rhythm. The
     * corner berth would scatter the colonnade, so the posts decline it. */
    marks: [
      { type: "gallerypost", line: 7, lat: [1.1, 1.3], noBerth: true },
      { type: "galleryroof", line: 7, onRoad: true, lat: [0, 0] },
    ],
  },
  {
    key: "frozenlake",
    name: "The Frozen Lake",
    banner: "THE FROZEN LAKE",
    rarity: "rare",
    noSpans: true,
    biomes: ["kaldbrekka"],
    len: [600, 860],
    mood: "calm",
    surf: "ice",
    terr: 0.12,
    trend: 0,
    call: "out onto the ice. gentle with everything",
    build(gen, r, b) {
      /* The road goes ACROSS the lake — ice both sides, dead flat, the
       * corners sized for glare ice (grip 0.38 makes them enormous, which
       * is the entire experience: quarter-kilometre arcs you commit to
       * three hundred metres early). The event owns its water the way the
       * wreck owns its shore. */
      const both = F_LAKE_L | F_LAKE_R;
      const ops = [str(r.range(90, 140))];
      ops.push(corner(gen, r, b, r.pick([5, 6])));
      ops.push(str(r.range(200, 280), null, both));
      ops.push(corner(gen, r, b, "flat", { flags: both }));
      ops.push(str(r.range(180, 260), null, both));
      ops.push(corner(gen, r, b, r.pick([5, 6])));
      ops.push(str(r.range(90, 140)));
      return ops;
    },
    /* One ice-fishing hut out on the lake — a building standing on the
     * water is the single image that says FROZEN. */
    marks: [{ type: "cabin", once: 0.5, lat: [12, 20], side: "water" }],
  },
  {
    key: "avalanche",
    name: "The Avalanche",
    banner: "AVALANCHE DEBRIS",
    rarity: "uncommon",
    noSpans: true,
    clearRocks: true,
    biomes: ["kaldbrekka", "aspenvale", "highline"],
    len: [520, 760],
    mood: "tech",
    surf: "snow",
    width: 0.9,
    /* A slide DEPOSITS in the flat runout at the slope's foot — the event
     * is a debris plain, not a mid-slope gallery run (which is what the
     * gallery is for). */
    terr: 0.55,
    trend: 0,
    call: "avalanche came through here. thread the lane, no hurry",
    build(gen, r, b) {
      /* The plows cut a lane through, and it THREADS: tight, snow-sized
       * corners at working pace, the Detour's shape in white. Slow is what
       * makes it safe — the first drafts ran open corners at rally speed
       * and a single wide moment became a hundred-metre sail across the
       * runout (fast) or a boulder (faster). NO brows, NO jumps — debris
       * past a blind crest is the sentence the bible forbids, and marks
       * skip the blind-corridor treatment props get. */
      const ops = [str(r.range(70, 110))];
      for (let i = 0; i < 4; i++) {
        ops.push(corner(gen, r, b, r.pick([2, 3, 3, 4])));
        ops.push(str(r.range(40, 80)));
      }
      return ops;
    },
    /* Debris stands back far enough that a wheel dropped off the verge at
     * speed does not find it — the event is the narrow lane and the sight
     * of the slide, not an ambush (measured: blocks at 1.6 m caught a bot
     * running 1 m wide on snow at 86 km/h). */
    marks: [{ type: "snowblock", perKm: 22, lat: [2.8, 8] }],
  },
  /* ---- THE TOWNS (2026-08-31). Quinn: "villages should make more
   * appearances, maybe even some small towns?" The Village Below is a
   * place seen from above; these are places driven THROUGH — houses at
   * the roadside squared up to the lane, walls and lamps, and (in a town)
   * a chapel over the roofs. Every country but The Verge, where nobody
   * lives. The road stays a rally road: gentle, flowing, a village corner
   * or two, no brows in a street. The houses are real colliders at their
   * real size — a hamlet is the one place the bible's visible wall is a
   * front door. */
  {
    key: "hamlet",
    name: "The Hamlet",
    banner: "THROUGH THE HAMLET",
    rarity: "uncommon",
    biomes: ["norrland", "costa", "redgate", "thornmoor", "heartland", "aspenvale", "kaldbrekka",
      "sandreach", "highline", "cauldron", "kurotani", "ventisca"],
    len: [480, 700],
    mood: "calm",
    /* houses stand on level ground: the terrain calms under the event so
     * a cabin is not perched on a bank with daylight under one corner */
    terr: 0.7,
    trend: 0,
    call: "houses ahead. through the village, keep it tidy",
    build(gen, r, b) {
      const ops = [str(r.range(90, 140)), corner(gen, r, b, r.pick([4, 5]))];
      ops.push(str(r.range(150, 220)));                  // the street
      ops.push(corner(gen, r, b, r.pick([3, 4])));       // the village corner
      ops.push(str(r.range(100, 160)));
      if (r.chance(0.5)) ops.push(corner(gen, r, b, r.pick([5, 6])));
      ops.push(str(r.range(70, 110)));
      return ops;
    },
    marks: [
      { type: "dwelling", perKm: 30, lat: [3.4, 6.5], facing: "road", colliderR: 2.1, gap: 11 },
      { type: "fence", lat: [2.2, 2.4], line: 7 },
      { type: "lamppost", lat: [1.5, 1.5], line: 34, colliderR: 0.3 },
    ],
  },
  {
    key: "town",
    name: "The Market Town",
    banner: "MARKET TOWN",
    rarity: "rare",
    biomes: ["heartland", "norrland", "costa", "thornmoor", "aspenvale", "kaldbrekka", "redgate",
      "sandreach", "highline", "cauldron", "kurotani", "ventisca"],
    len: [760, 1000],
    mood: "calm",
    terr: 0.6,
    trend: 0,
    width: 1.12,
    call: "a town. proper streets, and a square. mind the walls",
    build(gen, r, b) {
      const ops = [str(r.range(110, 150)), corner(gen, r, b, 4)];
      ops.push(str(r.range(200, 260)));                  // the high street
      ops.push(corner(gen, r, b, "flat"));
      ops.push(str(r.range(80, 120)));
      ops.push(corner(gen, r, b, r.pick([3, 4])));       // round the square
      ops.push(str(r.range(160, 220)));
      if (r.chance(0.6)) ops.push(corner(gen, r, b, 5));
      ops.push(str(r.range(80, 120)));
      return ops;
    },
    marks: [
      { type: "dwelling", perKm: 46, lat: [3.2, 5.5], facing: "road", colliderR: 2.1, gap: 9 },
      { type: "chapel", once: 0.5, lat: [7.5, 11], facing: "road", colliderR: 4 },
      { type: "wall", lat: [2.0, 2.2], line: 6 },
      { type: "lamppost", lat: [1.5, 1.5], line: 24, colliderR: 0.3 },
    ],
  },
];

export const EVENT_BY_KEY = Object.fromEntries(EVENTS.map((e) => [e.key, e]));

/* ---------------------------------------------------------------- names
 *
 * "Every landmark gets a name." A generic banner reading THE VIADUCT four
 * times in a journey is furniture; SKARNES VIADUCT and then, an hour
 * later, KVITFJELL VIADUCT are two places you went. The place-word comes
 * from the country you are in, so a name also tells you where you are
 * without a word of UI, and it is derived from (seed, position) — the same
 * crossing is the same place on the same seed, for as long as the seed
 * exists, which is what makes a journey worth telling someone about. */
const PLACES = {
  norrland: ["Skarnes", "Vindkall", "Bjørnfoss", "Tyrilund", "Hovden", "Storlia",
    "Rennedal", "Kvitfjell", "Aursund", "Melhus", "Grimsdal", "Sælv", "Hafslo", "Nordvik"],
  costa: ["Salvara", "Montebro", "Cala Vento", "Pietrafina", "Valdoro", "Aguablanca",
    "Serrafino", "Portovecchio", "Mirasol", "Capraia", "Santarem", "Barranca"],
  redgate: ["Cinder Wash", "Dry Fork", "Ochre Draw", "Hollow Bend", "Sunstone",
    "Red Mesa", "Coyote Flat", "Bone Spring", "Kiln", "Rattle Creek", "Ambergap"],
  thornmoor: ["Wychfell", "Blackmire", "Cold Edge", "Hagstone", "Netherclough",
    "Windgate", "Mosswick", "Greyholme", "Thackray", "Bleaklow", "Lantern Fell", "Foulsyke"],
  heartland: ["Appleford", "Longmead", "Goldacre", "Millbrook", "Wychcombe",
    "Harrowgate", "Elmsworth", "Fallowden", "Threshfield", "Copsely", "Barleywick", "Ottermere"],
  aspenvale: ["Silverthorn", "Elkford", "Grey Saddle", "Larkrise", "Coldbrook",
    "Marmot Hollow", "Stonepine", "Highwater", "Aspen Gate", "Ptarmigan", "Sawtooth", "Vailhorn"],
  kaldbrekka: ["Ísafell", "Svartvik", "Fannheim", "Jøkulby", "Hrafnholt", "Kaldalón",
    "Bjørnøy", "Snæfoss", "Vetrmyr", "Ulvsund", "Ravnbrekk", "Frostheim"],
  verge: ["Meridian", "Farfall", "Aphelion", "Vantage", "Ultima", "Loom",
    "Skylight", "Enda", "The Stray", "Nowhere"],
  // the park countries (2026-08-31): every name invented, none on a map
  sandreach: ["Redwater", "Hoodoo Bench", "Sentinel Wash", "Chimney Fork", "Ochre Narrows", "Sunspire",
    "Dry Cottonwood", "Slickrock", "Wallcreek", "Tallow Point", "Bonewash", "Copper Sink"],
  highline: ["Cedar Hollow", "Goat Ledge", "Sighing Wall", "Loon Reach", "Sunfall", "Avalanche Bench",
    "Larch Gate", "Flourwater", "Marmot Pass", "Weathervane", "Kintlow", "Two Cedars"],
  cauldron: ["Fumarole", "Sulphur Bend", "Old Steam", "Kettle Basin", "Wallow Meadow", "Emberhole",
    "Boiling Fork", "Cinder Meadow", "Sinter Bench", "Whistle Vent", "Grey Snag", "Mudcup"],
  kurotani: ["Kiriyama", "Sugitani", "Takamori", "Kumogoe", "Shirataki", "Yamabuki",
    "Tsukiyo", "Akebono", "Iwakage", "Momijidani", "Kazehara", "Yukimine"],
  ventisca: ["Puesto Viento", "Laguna Gris", "Cerro Hueso", "Estancia Lenga", "Paso del Zorro", "Bahia Quieta",
    "Piedra Alta", "Rio Palido", "Cuatro Torres", "Puerto Ceniza", "Lago Plomo", "Chorrillo Frio"],
};

const SUFFIX = {
  village: "",
  tunnels: "Tunnels", viaduct: "Viaduct", suspension: "Bridge", saltflat: "Flats", descent: "Descent",
  pass: "Pass", windfarm: "Wind Farm", ford: "Ford", canyon: "Canyon",
  circuit: "Circuit", observatory: "Observatory",
  levelcrossing: "Crossing", radiomast: "Mast", monastery: "Monastery", wreck: "Wreck",
  damroad: "Dam", flooded: "Water", detour: "Detour", stadium: "Stadium",
  gallery: "Gallery", frozenlake: "Ice Road", avalanche: "Slide",
  hamlet: "", town: "",
};

export function nameEvent(ev, seed, s, biomeKey, used) {
  const list = PLACES[biomeKey] || PLACES.norrland;
  const r = rng(hashCombine(seed, 0x1a4d + Math.round(s)));
  /* Walk on from the rolled index until the place-word is one this
   * journey has not used lately. Three landmarks called Santarem in one
   * run reads as a bug even though each name was drawn honestly. */
  /* An empty suffix is a real choice: a village is not "Hovden Village",
   * it is Hovden. */
  const suffix = SUFFIX[ev.key] != null ? SUFFIX[ev.key] : ev.name;
  /* Walk on from the rolled index until the place-word is one this
   * journey has not used lately, and does not stutter against the suffix.
   * Three landmarks called Santarem in one run reads as a bug even though
   * each name was drawn honestly — and "The Coyote Flat Flats" reads as
   * one whether or not it is. */
  const stutters = (p) => {
    if (!suffix) return false;
    const last = p.split(" ").pop().toLowerCase();
    const suf = suffix.split(" ")[0].toLowerCase();
    return last === suf || suf.startsWith(last) || last.startsWith(suf);
  };
  let idx = Math.floor(r() * list.length);
  const recent = used ? used.slice(-6) : [];
  for (let k = 0; k < list.length && (recent.includes(list[idx]) || stutters(list[idx])); k++) {
    idx = (idx + 1) % list.length;
  }
  const place = list[idx];
  /* Redgate's place-words are already two words of English; "Cinder Wash
   * Tunnels" is a mouthful where "The Cinder Wash Tunnels" is a place. */
  if (!suffix) return { name: place, place };
  return { name: (place.includes(" ") ? "The " : "") + place + " " + suffix, place };
}

/* --------------------------------------------------------------- picking */

/* Which event, if any, takes over the section about to be generated.
 *
 * ctx: { seed, sectionIndex, s, biomeKey, room, lastEventS, recent[] }
 *   room       metres available before the next waystation
 *   recent     event keys already seen this run, most recent last
 */
export function pickEvent(ctx) {
  if (ctx.force) return EVENT_BY_KEY[ctx.force] || null;
  /* Drought counts from the last event — or from the start of the run,
   * NOT from minus infinity: a journey must not open at maximum boost. */
  const drought = ctx.s - (ctx.lastEventS == null ? 0 : ctx.lastEventS);
  if (drought < EVENT_GAP) return null;
  const r = rng(hashCombine(ctx.seed, 0xe7e7 + ctx.sectionIndex));
  /* Spectacle spacing is a pacing problem: never two events close together
   * (the gap above), and never a long stretch with nothing — a drought
   * raises the odds until something happens, and a hot leg leans in a
   * little. The cap keeps a lucky streak from turning events into wallpaper. */
  /* The boost's job is a PROMISE, not a lean: past ~3.6 km of drought the
   * chance climbs steeply enough that a dead ten kilometres cannot happen
   * — by 8 km every eligible section is at ~70%, by 9.5 km at 85%. The
   * old, gentler curve still let an unlucky seed go 11 km dry (found the
   * day a fourth country re-rolled the director's dice; only ~15 sections
   * in a window are even eligible once waystation room is subtracted, so
   * the tail was fatter than the mean gap suggested). */
  /* The departure lean, spectacle half (Addendum I): a leg entered in the
   * zone opens the boost sooner — spectacle comes sooner — and a ragged
   * one later, so the road breathes. ±700 m on the start line only: the
   * PROMISE (a dead ten kilometres cannot happen) holds at either lean. */
  const from = 3600 - (ctx.daring || 0) * 700;
  /* 2026-08-31: the curve steepened (÷2600 → ÷1800) after a 140 km
   * director journey went 11.6 km dry on a run of failed 50–70% rolls;
   * now every eligible section past ~7.5 km of drought sits at the cap.
   * A BURNED slot (an event picked and then refused by the geology) hands
   * the next section a near-certain pick of something else. */
  const boost = 1 + Math.min(3.2, Math.max(0, drought - from) / 1800);
  const heat = 1 + (ctx.heat || 0) * 0.25;
  const chance = ctx.burned ? 0.9 : Math.min(0.9, BASE_CHANCE * boost * heat);
  if (!r.chance(chance)) return null;

  const pool = [];
  for (const ev of EVENTS) {
    const tier = RARITY[ev.rarity];
    if (ctx.s < tier.minRunS) continue;
    if (ctx.burned && ev.key === ctx.burned) continue;   // not the one the ground just refused
    if (ev.biomes && !ev.biomes.includes(ctx.biomeKey)) continue;
    if (ctx.room != null && ctx.room < ev.len[1] + 140) continue;
    /* Geology screening: an event that needs the ground to fall away (a
     * village's valley, a suspension bridge's gorge) is not PICKED where
     * a cheap probe of the noise field says the ground cannot deliver —
     * otherwise the roll burns the slot, the delivery gate nulls it, and
     * enough burned slots in a row make the dead ten kilometres the
     * drought boost exists to prevent. Feasible ≠ guaranteed; the
     * delivery gate still has the last word. */
    if (ctx.feasible && !ctx.feasible(ev)) continue;
    /* Anti-repeat with a long memory: the same event twice in one journey
     * is the fastest way to turn a surprise into furniture. */
    const recent = ctx.recent || [];
    const seen = recent.includes(ev.key);
    const since = recent.length - 1 - recent.lastIndexOf(ev.key);
    const stale = !seen ? 1 : since >= 5 ? 0.35 : 0.08;
    pool.push({ ev, w: tier.weight * stale });
  }
  if (!pool.length) return null;
  return r.weighted(pool).ev;
}

/* Did the landscape actually deliver what the event asked for? Called on a
 * candidate section, before anything is announced or committed. */
export function eventDelivered(ev, spans) {
  if (!ev.want) return true;
  const w = ev.want;
  let n = 0;
  for (const sp of spans) {
    if (sp.kind !== w.kind) continue;
    if (w.minLen && sp.s1 - sp.s0 < w.minLen) continue;
    if (w.minDepth && !(sp.depth >= w.minDepth)) continue;
    n++;
  }
  return n >= (w.count || 1);
}
