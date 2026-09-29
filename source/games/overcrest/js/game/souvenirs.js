/* Overcrest — souvenirs and parts.
 *
 * A souvenir is a rule hung on the car. Every one should make you think
 * "okay, now I want to drive differently." Parts are honest, feelable stat
 * bumps and stay minor by design.
 *
 * THE ROGUELIKE LAW (Phase 25, 2026-08-30): a run should be able to come
 * apart in the player's favour. The bible asks for builds that break the
 * game in different ways, so the catalog is written in a roguelike's
 * grammar rather than as a list of bonuses:
 *   SCALERS      grow for the whole journey with NO cap of their own — the
 *                clamps in build.js are the only wall. The "this build is
 *                completely broken" engine.
 *   ECHOES       `echo(ctx, state, name, data)` asks for an event to be heard
 *                again — by every souvenir (return true) or by one (its entry).
 *   AMPLIFIERS   `amp` pushes every OTHER souvenir's passives further from stock.
 *   CONVERTERS   turn one meter into another: boost held → power, condition
 *                lost → flow, boost → blood.
 *   THE DECK     ownership-only mods that change what the WORLD deals: how
 *                many pickups and which kinds, how long the routes are and
 *                what they crave, what the shelf will and won't stock.
 *   COUNTERS     souvenirs that read the build (tags, rarities, how many).
 *   COPIERS      souvenirs that replay another souvenir's passives.
 * Duplicates were merged, unfeelable numbers made feelable, and every
 * souvenir must still react ALONE on the bench (`builds` mode).
 *
 * Definition shape (see build.js for the pipeline):
 *   { id, kind, name, rarity: common|odd|rare|exotic|fabled, tags[], blurb, rule,
 *     init(ctx)→state, mods(ctx,state)→partial, tick(ctx,state,dt),
 *     on: { eventName(ctx,state,data) }, onDamage(ctx,state,{delta,impact,landing})→allowed,
 *     echo(ctx,state,name,data)→bool|entry, amp: number,
 *     appearIf(stats)→bool, modeOnly: "sweep" }
 *
 * ctx: { car, R (run state), world, bus, B (the build), time(), boost(n), flow(n),
 *        repair(n), damage(n), sweep(metres), note(text), spawnPickup(kind, ahead) }
 *
 * Events: driftStart driftSwitch driftTick driftEnd brakeAfter tookOff landed
 *   collision nearMiss cornerDone pickup gearChange blowOff handbrake eventEnter
 *   border legStart waystation flowTier boostStart boostEnd grace remark.
 *
 * World-facing mods (pickup*, route*) MUST come from ownership alone — never
 * from state — or a resumed run regenerates a different road. The bench
 * asserts it.
 */

const S = (o) => Object.assign({ kind: "souvenir", tags: [] }, o);
const P = (o) => Object.assign({ kind: "part", rarity: "common", tags: ["part"] }, o);

/* Re-entrancy guard for the souvenirs that read OTHER souvenirs' mods (the
 * mirrors): a mirror looking at a mirror returns nothing instead of
 * recursing forever. */
let _mirror = false;

const KMH = (c) => Math.abs(c.car.vx) * 3.6;
const NIGHT = (c) => (c.world.night || 0) > 0.5;
const RAIN = (c) => (c.world.rainNow || 0) > 0.3;
const COLD = (c) => (c.world.coldNow || 0) > 0.5;
const ICY = (c) => c.car.surface === "snow" || c.car.surface === "ice";
const tagCount = (c, tag) => { let n = 0; for (const sv of c.B.souvenirs) if ((sv.def.tags || []).includes(tag)) n++; return n; };
/* a small deterministic hash for the gambling souvenirs — never Math.random */
const h32 = (x) => { x = Math.imul(x ^ (x >>> 16), 0x45d9f3b); x = Math.imul(x ^ (x >>> 16), 0x45d9f3b); return (x ^ (x >>> 16)) >>> 0; };
/* the deck's keys never travel through a mirror: a copy may depend on
 * state, and the road ahead must only ever depend on ownership */
const WORLD_KEYS = new Set(["pickupDensity", "pickupCanister", "pickupWrench", "pickupGrit", "pickupPennant", "routeLen", "routeCrest", "routeJump", "routeLake"]);
/* Copy another souvenir's passives (the mirrors): numbers only, never the
 * shelf/route counts, a hit cap or the deck; `k` scales a multiplier's
 * distance from 1 (0.5 = half strength, 1 = as is). */
function copyMods(c, sv, k) {
  if (_mirror || !sv || !sv.def.mods) return null;
  _mirror = true;
  try {
    const part = sv.def.mods(c, sv.state) || {};
    const out = {};
    for (const key in part) {
      const v = part[key];
      if (typeof v !== "number" || key === "hitCap" || key === "extraRoutes" || key === "extraCards" || key === "luckBonus" || WORLD_KEYS.has(key)) continue;
      out[key] = (key === "slideCeiling" || key === "airSteer") ? v * k : 1 + (v - 1) * k;
    }
    return out;
  } finally { _mirror = false; }
}

export const SOUVENIRS = [
  // ---------------------------------------------------------------- drift
  S({
    id: "pendulum", name: "Pendulum", rarity: "odd", tags: ["drift", "flow"],
    blurb: "A brass bob on a chain. It only ticks when the car swings.",
    rule: "Each clean slide switch (left→right or right→left within 1.3 s) adds a stack: +25% flow gain per stack, up to 6. Stacks fade after 4 s without a switch.",
    init: () => ({ stacks: 0, since: 0 }),
    mods: (c, st) => ({ flowGain: 1 + 0.25 * st.stacks }),
    on: {
      driftSwitch(c, st) { st.stacks = Math.min(6, st.stacks + 1); st.since = 0; c.note("Pendulum ×" + st.stacks); },
    },
    tick(c, st, dt) { st.since += dt; if (st.since > 4 && st.stacks > 0) { st.stacks--; st.since = 2.5; } },
  }),
  S({
    id: "tail-dancer", name: "Tail Dancer", rarity: "common", tags: ["drift", "boost"],
    blurb: "A ribbon tied to the wing. It streams best sideways.",
    rule: "Every second spent sideways charges +6 boost.",
    on: { driftTick(c, st, d) { c.boost(6 * d.dt); } },
  }),
  S({
    id: "loose-leash", name: "Loose Leash", rarity: "odd", tags: ["drift"],
    blurb: "A dog lead, cut. The car goes further before it comes back.",
    rule: "The slide ceiling rises: the car holds bigger angles before it self-straightens. Sliding builds flow ×1.5. Path damping is a little softer.",
    mods: () => ({ slideCeiling: 0.22, stability: 0.85 }),
    on: { driftTick(c, st, d) { c.flow(1.25 * d.dt); } },
  }),
  // -------------------------------------------------------------- the crew
  /* The camera crew's cards (owner, pass six): shots are required now and
   * announced by the codriver, so the crew earned a corner of the catalog.
   * They hook the "shot" event main emits when a cut completes. */
  S({
    id: "press-pass", name: "Press Pass", rarity: "odd", tags: ["crew", "boost"],
    blurb: "Laminated, creased, signed by nobody in particular.",
    rule: "Every shot the crew completes: +7 boost.",
    on: { shot(c) { c.boost(7); c.note("Press Pass +7"); } },
  }),
  S({
    id: "front-page", name: "Front Page", rarity: "rare", tags: ["crew", "score"],
    blurb: "Tomorrow's paper needs today's corner.",
    rule: "Every completed shot pays 500 points. The roll shot pays 1200, a crash sells.",
    on: { shot(c, st, d) { const n = d && d.kind === "roll" ? 1200 : 500; c.R.score += n; c.note("Front Page +" + n); } },
  }),
  S({
    id: "clapperboard", name: "Clapperboard", rarity: "odd", tags: ["crew"],
    blurb: "Scene one, take always.",
    rule: "The crew sets up in two thirds the time, so more shots find you.",
    mods: () => ({ cutRate: 0.66 }),
  }),
  // -------------------------------------------------------------- no-brake
  S({
    id: "red-line-ribbon", name: "Red Line Ribbon", rarity: "odd", tags: ["speed", "no-brake"],
    blurb: "A strip of red tape over the brake light. Someone was making a point.",
    rule: "Every second without braking adds +2% engine power, up to +30%. Touching the brake resets it.",
    init: () => ({ pow: 0 }),
    mods: (c, st) => ({ power: 1 + st.pow }),
    tick(c, st, dt) { const brk = c.car.brake > 0.2; if (brk) st.pow = 0; else if (Math.abs(c.car.vx) > 8) st.pow = Math.min(0.3, st.pow + 0.02 * dt); },
  }),
  S({
    id: "ghost-pedal", name: "Ghost Pedal", rarity: "common", tags: ["no-brake", "boost"],
    blurb: "A pedal that isn’t connected to anything. Press it and see.",
    rule: "When you finally brake after 8+ s without it, the streak cashes out as boost: +3 per second, up to +45.",
    on: { brakeAfter(c, st, d) { if (d.seconds >= 8) { const n = Math.min(45, d.seconds * 3); c.boost(n); c.note("Ghost Pedal +" + Math.round(n)); } } },
  }),
  // ------------------------------------------------------------------ jump
  S({
    id: "skipping-stone", name: "Skipping Stone", rarity: "odd", tags: ["jump", "boost"],
    blurb: "A flat river stone. It wants to touch down lightly and go again.",
    rule: "A clean landing gives +18 boost. Land again within 6 s of the last and each one adds +8 more.",
    init: () => ({ chain: 0, since: 99 }),
    on: { landed(c, st, d) { if (!d.clean || d.air < 0.25) return; st.chain = st.since < 6 ? st.chain + 1 : 0; st.since = 0; const n = 18 + 8 * st.chain; c.boost(n); c.note("Skipping Stone +" + n); } },
    tick(c, st, dt) { st.since += dt; },
  }),
  S({
    id: "kite-string", name: "Kite String", rarity: "rare", tags: ["jump", "flow"],
    blurb: "You can steer a kite. Why not a car?",
    rule: "The car answers the wheel in the air. Flow does not decay while airborne.",
    mods: () => ({ airSteer: 2.2 }),
    tick(c, st, dt) { if (!c.car.grounded) c.flow(1.1 * dt); },   // cancels the base decay
  }),
  S({
    id: "feather-charm", name: "Feather Charm", rarity: "common", tags: ["jump", "durability"],
    blurb: "Hangs from the mirror. Landings feel like someone caught the car.",
    rule: "Landing scrub and landing damage are halved. Five clean landings in a leg, and landings stop hurting at all until the next waystation.",
    init: () => ({ n: 0 }),
    mods: (c, st) => ({ landing: st.n >= 5 ? 0.25 : 0.5 }),
    on: {
      landed(c, st, d) { if (d.clean && d.air > 0.25) { st.n++; if (st.n === 5) c.note("Feather: caught"); } },
      legStart(c, st) { st.n = 0; }, waystation(c, st) { st.n = 0; },
    },
  }),
  // ---------------------------------------------------------------- damage
  S({
    id: "scrapheart", name: "Scrapheart", rarity: "odd", tags: ["damage", "power"],
    blurb: "A dented locket with a spark plug inside. It beats harder when hurt.",
    rule: "+4% engine power for every 10% condition lost, up to +36%.",
    mods: (c) => ({ power: 1 + Math.min(0.36, Math.floor((100 - c.R.condition) / 10) * 0.04) }),
  }),
  S({
    id: "second-wind", name: "Second Wind", rarity: "rare", tags: ["damage", "boost"],
    blurb: "A rescue whistle on a lanyard. One breath per leg.",
    rule: "The first big hit each leg does no damage and gives +40 boost instead.",
    init: () => ({ ready: true }),
    on: { legStart(c, st) { st.ready = true; }, waystation(c, st) { st.ready = true; } },
    onDamage(c, st, d) { if (st.ready && d.delta >= 6 && !d.landing) { st.ready = false; c.boost(40); c.note("Second Wind"); return 0; } return d.delta; },
  }),
  S({
    id: "patchwork-plating", name: "Patchwork Plating", rarity: "common", tags: ["damage", "durability"],
    blurb: "Panels off three other cars. None of them match.",
    rule: "No single hit can do more than 12 damage. Repairs are 30% less effective.",
    mods: () => ({ hitCap: 12, repairMul: 0.7 }),
  }),
  // ------------------------------------------------------------------ flow
  S({
    id: "metronome", name: "Metronome", rarity: "common", tags: ["flow"],
    blurb: "It ticks on the dash. You start to drive to it.",
    rule: "Flow decays half as fast.",
    mods: () => ({ flowDecay: 0.5 }),
  }),
  S({
    id: "overture", name: "Overture", rarity: "rare", tags: ["flow", "boost"],
    blurb: "A conductor’s baton, tucked into the door pocket. When the piece comes together, it plays.",
    rule: "At full flow (tier 5), boost fires by itself for 1.5 s every 8 s, free.",
    init: () => ({ t: 0 }),
    tick(c, st, dt) { st.t += dt; },
    mods: (c, st) => ({ autoBoost: c.R.tier >= 5 && (st.t % 8) < 1.5 }),
  }),
  // --------------------------------------------------------------- pickups
  S({
    id: "magpie-feather", name: "Magpie Feather", rarity: "odd", tags: ["pickup", "drift"],
    blurb: "Black and white and greedy. It likes shiny things taken at an angle.",
    rule: "Pickups collected while sliding count double.",
    on: { pickup(c, st, d) { if (d.sliding && !d.echo) { d.repeat = true; c.note("Magpie ×2"); } } },
  }),
  S({
    id: "tin-whistle", name: "Tin Whistle", rarity: "common", tags: ["pickup"],
    blurb: "Pickups hear it coming and lean toward the road.",
    rule: "Pickup reach is doubled.",
    mods: () => ({ pickupMagnet: 2 }),
  }),
  // ------------------------------------------------------------- near miss
  S({
    id: "slipstream-bell", name: "Slipstream Bell", rarity: "odd", tags: ["speed", "boost"],
    blurb: "A bicycle bell on the roll cage. It rings when the trees get close.",
    rule: "A near miss at speed (a tree within arm’s reach above 60 km/h) gives +10 boost and +6 flow.",
    on: { nearMiss(c) { c.boost(10); c.flow(6); c.note("Bell!"); } },
  }),
  // -------------------------------------------------------------- off-road
  S({
    id: "mudlark", name: "Mudlark", rarity: "odd", tags: ["offroad", "boost"],
    blurb: "A pair of boots that never dried out.",
    rule: "Off-road drag halved. Rejoin the road after 1+ s off it and gain +12 boost.",
    mods: () => ({ offDrag: 0.5 }),
    init: () => ({ offT: 0 }),
    tick(c, st, dt) { if (c.car.zone === "off") st.offT += dt; else { if (st.offT > 1 && c.car.zone === "road") { c.boost(12); c.note("Mudlark +12"); } st.offT = 0; } },
  }),
  // ---------------------------------------------------------------- routes
  S({
    id: "cartographers-pen", name: "Cartographer’s Pen", rarity: "rare", tags: ["route"],
    blurb: "It draws roads that were always there.",
    rule: "Waystations offer one extra route.",
    mods: () => ({ extraRoutes: 1 }),
  }),
  S({
    id: "waystation-bell", name: "Waystation Bell", rarity: "rare", tags: ["route"],
    blurb: "Ring it and the mechanic brings out the good box.",
    rule: "Waystations offer four cards instead of three.",
    mods: () => ({ extraCards: 1 }),
  }),
  // ------------------------------------------------------------- momentum
  S({
    id: "flywheel", name: "Flywheel", rarity: "odd", tags: ["momentum", "boost"],
    blurb: "A disc of old iron. It hates stopping more than you do.",
    rule: "Above 100 km/h it charges (+3/s, up to 30). Drop under 60 km/h and the charge cashes out as boost.",
    init: () => ({ charge: 0 }),
    tick(c, st, dt) {
      const v = Math.abs(c.car.vx);
      if (v > 27.8) st.charge = Math.min(30, st.charge + 3 * dt);
      else if (v < 16.7 && st.charge > 4) { c.boost(st.charge); c.note("Flywheel +" + Math.round(st.charge)); st.charge = 0; }
    },
  }),
  S({
    id: "tall-gear", name: "Tall Gear", rarity: "common", tags: ["momentum", "speed"],
    blurb: "A gear lever knob a size too big. It only wakes up in the tall ones.",
    rule: "In fifth or sixth: +20% power. In first or second: −20%. Keep it in the tall gear.",
    mods: (c) => (c.car.gear >= 5 ? { power: 1.2 } : c.car.gear <= 2 ? { power: 0.8 } : {}),
  }),
  S({
    id: "downhill-ledger", name: "Downhill Ledger", rarity: "odd", tags: ["momentum", "flow"],
    blurb: "An accountant’s notebook. Every metre of descent is entered as profit.",
    rule: "Descending builds flow. The longer the drop, the richer the line.",
    init: () => ({ lastY: null }),
    tick(c, st, dt) {
      const y = c.car.y;
      if (st.lastY != null && c.car.grounded) { const dy = st.lastY - y; if (dy > 0.015) c.flow(Math.min(3, dy * 28) * dt * 8); }
      st.lastY = y;
    },
  }),
  // ---------------------------------------------------------------- speed
  S({
    id: "vmax-locket", name: "Vmax Locket", rarity: "rare", tags: ["speed", "boost"],
    blurb: "There is a number engraved inside. It is wrong now.",
    rule: "Every new top speed this LEG pays +8 boost. The number is wiped at every waystation, so there is always a record to beat.",
    init: () => ({ best: 0 }),
    on: { legStart(c, st) { st.best = 0; }, waystation(c, st) { st.best = 0; } },
    tick(c, st) {
      const v = Math.abs(c.car.vx);
      if (v > st.best + 2) { st.best = v; if (v > 33) { c.boost(8); c.note("Vmax " + Math.round(v * 3.6)); } }
    },
  }),
  S({
    id: "century-coin", name: "Century Coin", rarity: "odd", tags: ["speed", "boost"],
    blurb: "A coin from a country that no longer exists. Heads means faster.",
    rule: "Every unbroken 10 s above 100 km/h flips it. Heads: your boost doubles. Tails: it halves.",
    init: () => ({ t: 0, flips: 0 }),
    tick(c, st, dt) {
      if (Math.abs(c.car.vx) > 27.8) {
        st.t += dt;
        if (st.t >= 10) {
          st.t -= 10; st.flips++;
          const heads = h32(st.flips * 7919 + Math.floor(c.time() * 3)) % 2 === 0;
          c.R.boost = heads ? Math.min(100, c.R.boost * 2) : c.R.boost * 0.5;
          c.note(heads ? "Heads!" : "Tails…");
        }
      } else st.t = 0;
    },
  }),
  // ------------------------------------------------------------ precision
  S({
    id: "chalk-line", name: "Chalk Line", rarity: "common", tags: ["precision", "flow"],
    blurb: "A snapped line of blue chalk. The road remembers where it was.",
    rule: "Each clean corner +2 flow. Five clean in a row: +15 boost, and the line resets.",
    init: () => ({ streak: 0 }),
    on: {
      cornerDone(c, st, d) {
        if (!d.clean) { st.streak = 0; return; }
        st.streak++; c.flow(2);
        if (st.streak >= 5) { st.streak = 0; c.boost(15); c.note("Chalk Line +15"); }
      },
    },
  }),
  S({
    id: "surgeons-gloves", name: "Surgeon’s Gloves", rarity: "rare", tags: ["precision", "durability"],
    blurb: "Thin white leather. Steady hands hit nothing.",
    rule: "Each clean corner in a row shrugs 4% more damage (up to 20%). Any impact drops the gloves.",
    init: () => ({ streak: 0 }),
    mods: (c, st) => ({ damageScale: 1 - 0.04 * Math.min(5, st.streak) }),
    on: {
      cornerDone(c, st, d) { if (d.clean) st.streak++; },
      collision(c, st) { st.streak = 0; },
    },
  }),
  // ---------------------------------------------------------------- combo
  S({
    id: "daisy-chain", name: "Daisy Chain", rarity: "rare", tags: ["combo", "boost"],
    blurb: "Every flower holds the next one up.",
    rule: "Two different tricks within 2 s of each other (a slide into a jump, a near miss out of a corner) pay +10 boost.",
    init: () => ({ name: "", t: -9 }),
    on: (() => {
      const link = (n) => (c, st, d) => {
        if (n === "cornerDone" && !(d && d.clean)) return;
        const now = c.time();
        if (st.name && st.name !== n && now - st.t < 2) { c.boost(10); c.note("Daisy Chain"); }
        st.name = n; st.t = now;
      };
      return { driftEnd: link("driftEnd"), landed: link("landed"), nearMiss: link("nearMiss"), pickup: link("pickup"), brakeAfter: link("brakeAfter"), cornerDone: link("cornerDone") };
    })(),
  }),
  S({
    id: "echo-chamber", name: "Echo Chamber", rarity: "exotic", tags: ["combo", "boost"],
    blurb: "A cave in a jar. Everything you put in comes back smaller.",
    rule: "Every 25 boost gained from anywhere echoes back +8 more.",
    init: () => ({ last: null, acc: 0 }),
    tick(c, st) {
      const b = c.R.boost;
      if (st.last != null) {
        st.acc += Math.max(0, b - st.last);
        if (st.acc >= 25) { st.acc -= 25; c.boost(8); c.note("Echo +8"); }
      }
      st.last = c.R.boost;
    },
  }),
  // -------------------------------------------------------------- weather
  /* The rain and cold cards only reach the shelf once the journey has met
   * the weather — a dead card in a dry run was the shelf's worst habit. */
  S({
    id: "rain-reader", name: "Rain Reader", rarity: "odd", tags: ["weather", "flow"],
    appearIf: (st) => (st.rainDist || 0) > 400,
    blurb: "A paperback left open on the dash, warped by water. The wipers keep time.",
    rule: "In rain: +8% grip and flow builds ×1.3. Dry, it is just a book.",
    mods: (c) => (RAIN(c) ? { grip: 1.08, flowGain: 1.3 } : {}),
  }),
  S({
    id: "storm-chaser", name: "Storm Chaser", rarity: "rare", tags: ["weather", "boost"],
    appearIf: (st) => (st.rainDist || 0) > 400,
    blurb: "A cracked barometer that points at BAD and means it well.",
    rule: "While it rains, +1.5 boost a second.",
    tick(c, st, dt) { if (RAIN(c)) c.boost(1.5 * dt); },
  }),
  S({
    id: "moth-lantern", name: "Moth Lantern", rarity: "odd", tags: ["weather", "power"],
    blurb: "It should draw moths. It draws road.",
    rule: "At night: +10% power and flow decays ×0.7.",
    mods: (c) => (NIGHT(c) ? { power: 1.1, flowDecay: 0.7 } : {}),
  }),
  // ------------------------------------------------------------- recovery
  S({
    id: "bounce-back", name: "Bounce Back", rarity: "odd", tags: ["recovery", "flow"],
    blurb: "A rubber ball from a vending machine. It has opinions about setbacks.",
    rule: "For 3 s after any hit: +15% grip and flow builds ×2. Shake it off.",
    init: () => ({ t: 0 }),
    mods: (c, st) => (st.t > 0 ? { grip: 1.15, flowGain: 2 } : {}),
    on: { collision(c, st) { st.t = 3; } },
    tick(c, st, dt) { if (st.t > 0) st.t -= dt; },
  }),
  // ----------------------------------------------------- pickups & powerups
  S({
    id: "lodestone", name: "Lodestone", rarity: "rare", tags: ["pickup", "durability"],
    blurb: "A magnet that prefers whole cars to broken ones.",
    rule: "Every third pickup is also a wrench: +15 condition.",
    init: () => ({ n: 0 }),
    on: { pickup(c, st) { if (++st.n % 3 === 0) { c.repair(15); c.note("Lodestone +15"); } } },
  }),
  S({
    id: "preserves-jar", name: "Preserves Jar", rarity: "exotic", tags: ["powerup", "durability"],
    blurb: "A jam jar, scalded clean. Some things keep.",
    rule: "Picking up a pennant while one already flies stores it in the jar for later.",
    init: () => ({ spare: false }),
    on: { pickup(c, st, d) { if (d.kind === "pennant" && c.R.shield && !st.spare) { st.spare = true; c.note("Jarred"); } } },
    onDamage(c, st, d) {
      if (st.spare && !c.R.shield && d.delta >= 6 && !d.landing) { st.spare = false; c.note("From the jar!"); return 0; }
      return d.delta;
    },
  }),
  S({
    id: "toll-jar", name: "Toll Jar", rarity: "common", tags: ["pickup", "flow"],
    blurb: "Loose change for a road with no tolls. Spend it on style.",
    rule: "Every pickup also adds +6 flow.",
    on: { pickup(c) { c.flow(6); } },
  }),
  // ---------------------------------------------------------------- boost
  S({
    id: "afterburner-coil", name: "Afterburner Coil", rarity: "rare", tags: ["boost"],
    blurb: "It glows a colour the dashboard warning light doesn’t have a word for.",
    rule: "Boost hits 20% harder and drains 25% faster.",
    mods: () => ({ boostPower: 1.2, boostDrain: 1.25 }),
  }),
  S({
    id: "slow-fuse", name: "Slow Fuse", rarity: "odd", tags: ["boost"],
    blurb: "Cut from a stick of theatre dynamite. All hiss, long burn.",
    rule: "Boost is 15% softer but drains 40% slower.",
    mods: () => ({ boostPower: 0.85, boostDrain: 0.6 }),
  }),
  // ----------------------------------------------------------- durability
  S({
    id: "oak-heart", name: "Oak Heart", rarity: "common", tags: ["durability"],
    blurb: "A knot of oak, sanded smooth by a worried thumb.",
    rule: "All damage −15%. Under 30 condition, −50%: the oak holds.",
    mods: (c) => ({ damageScale: c.R.condition < 30 ? 0.5 : 0.85 }),
  }),
  S({
    id: "rust-never-sleeps", name: "Rust Never Sleeps", rarity: "exotic", tags: ["damage", "power"],
    blurb: "A flake of rust in a locket. It is patient and it is hungry.",
    rule: "+18% power, always. The car quietly loses condition while you enjoy it.",
    mods: () => ({ power: 1.18 }),
    tick(c, st, dt) { if (c.R.state === "driving") c.damage(0.045 * dt); },
  }),
  // --------------------------------------------------------------- no-brake
  S({
    id: "one-pedal-manifesto", name: "One-Pedal Manifesto", rarity: "exotic", tags: ["no-brake", "flow"],
    blurb: "A pamphlet, badly printed, entirely sincere.",
    rule: "Brakes 30% weaker. Flow builds ×1.4, always. Commit.",
    mods: () => ({ brake: 0.7, flowGain: 1.4 }),
  }),
  // ------------------------------------------------------------------ jump
  S({
    id: "trampoline-patch", name: "Trampoline Patch", rarity: "exotic", tags: ["jump", "power"],
    blurb: "A square of taut black weave riveted under the floor.",
    rule: "A clean landing arms the patch for 8 s: the next take-off kicks half again as hard, and the car lands with +25% power for 2 s. Chain the brows.",
    init: () => ({ arm: 0, pw: 0 }),
    mods: (c, st) => {
      const o = {};
      if (st.arm > 0) o.lift = 1.5;
      if (st.pw > 0) o.power = 1.25;
      return o;
    },
    on: {
      landed(c, st, d) { if (d.clean && d.air > 0.25) { st.arm = 8; st.pw = 2; } },
      tookOff(c, st) { if (st.arm > 0) { st.arm = 0; c.note("Boing"); } },
    },
    tick(c, st, dt) { if (st.arm > 0) st.arm -= dt; if (st.pw > 0) st.pw -= dt; },
  }),
  // ----------------------------------------------------------------- drift
  S({
    id: "long-way-round", name: "Long Way Round", rarity: "rare", tags: ["drift", "boost"],
    blurb: "A postcard that took eleven years to arrive. Worth it.",
    rule: "A slide held past 2.5 s pays +10 boost per second of it (up to +40).",
    on: { driftEnd(c, st, d) { if (d.duration > 2.5) { const n = Math.min(40, Math.round(d.duration * 10)); c.boost(n); c.note("Long Way +" + n); } } },
  }),
  // ----------------------------------------------------------------- luck
  S({
    id: "lucky-cap", name: "Lucky Cap", rarity: "odd", tags: ["route"],
    blurb: "Worn backwards, obviously.",
    rule: "Rarer souvenirs turn up at waystations more often.",
    mods: () => ({ luckBonus: 0.4 }),
  }),
  // ----------------------------------------------- souvenirs reading souvenirs
  S({
    id: "chorus-locket", name: "Chorus Locket", rarity: "rare", tags: ["combo", "power"],
    blurb: "A locket with room for many photographs. It likes company.",
    rule: "+3% power and +3% flow gain for every souvenir carried. No limit.",
    mods: (c) => {
      const n = c.B.souvenirs.length;
      return { power: 1 + 0.03 * n, flowGain: 1 + 0.03 * n };
    },
  }),
  S({
    id: "matched-set", name: "Matched Set", rarity: "odd", tags: ["combo", "durability"],
    blurb: "Two of anything is a collection. The car approves of collections.",
    rule: "+1% grip, and +3% more for every tag two of your souvenirs share. No limit.",
    mods: (c) => {
      const count = {};
      let pairs = 0;
      for (const sv of c.B.souvenirs) {
        for (const t of sv.def.tags || []) {
          count[t] = (count[t] || 0) + 1;
          if (count[t] === 2) pairs++;
        }
      }
      return { grip: 1.01 + 0.03 * pairs };
    },
  }),
  S({
    id: "tuning-fork", name: "Tuning Fork", rarity: "exotic", tags: ["combo", "boost"],
    blurb: "Strike one thing and it answers with another.",
    rule: "Whenever another souvenir fires, +3 boost. If nothing has spoken for 45 s, it hums on its own: +6 flow.",
    init: () => ({ lastT: -1, quiet: 0 }),
    tick(c, st, dt) {
      const log = c.B.log;
      if (st.lastT < 0) { st.lastT = c.time(); return; }
      let foreign = 0, newest = st.lastT;
      for (const l of log) {
        if (l.t > st.lastT) { if (!l.text.startsWith("Fork")) foreign++; if (l.t > newest) newest = l.t; }
      }
      st.lastT = Math.max(newest, st.lastT);
      if (foreign) { st.quiet = 0; c.boost(3 * foreign); c.note("Fork +" + 3 * foreign); }
      else { st.quiet += dt; if (st.quiet > 45) { st.quiet = 0; c.flow(6); c.note("Fork hums"); } }
    },
  }),
  // -------------------------------------------------------- weather, deeper
  S({
    id: "frost-candle", name: "Frost Candle", rarity: "odd", tags: ["weather", "durability"],
    blurb: "It burns cold. The panels remember winter and stiffen.",
    rule: "Between dusk and dawn, all damage −20%.",
    mods: (c) => (NIGHT(c) ? { damageScale: 0.8 } : {}),
  }),
  S({
    id: "petrichor-vial", name: "Petrichor Vial", rarity: "rare", tags: ["weather", "boost"],
    appearIf: (st) => (st.rainDist || 0) > 400,
    blurb: "The smell of rain arriving, stoppered. Uncork it by driving into the weather.",
    rule: "The first minute after rain begins pays +1 boost a second.",
    init: () => ({ was: null, t: 0 }),
    tick(c, st, dt) {
      const rain = RAIN(c);
      if (st.was === null) { st.was = rain; return; }
      if (rain && !st.was) { st.t = 60; c.note("Petrichor"); }
      st.was = rain;
      if (st.t > 0) { st.t -= dt; c.boost(1 * dt); }
    },
  }),
  // ------------------------------------------------------------ the cold
  S({
    id: "studded-tyres", name: "Studded Tyres", rarity: "odd", tags: ["weather", "offroad"],
    appearIf: (st) => (st.coldDist || 0) > 400,
    blurb: "Four hundred tungsten teeth. They know exactly one season.",
    rule: "On snow and ice: +14% grip. On tarmac the studs sing, and cost 3%.",
    /* Reads the surface actually under the car — so they bite on an iced
     * bridge in Norrland, not just in the snow countries. */
    mods: (c) => (ICY(c) ? { grip: 1.14 } : c.car.surface === "tarmac" ? { grip: 0.97 } : {}),
  }),
  S({
    id: "reindeer-hide", name: "Reindeer Hide", rarity: "odd", tags: ["weather", "durability"],
    appearIf: (st) => (st.coldDist || 0) > 400,
    blurb: "Thrown over the seat. The whole car relaxes about winter.",
    rule: "In cold country: all damage −18% and flow drains ×0.85. Home ground.",
    mods: (c) => (COLD(c) ? { damageScale: 0.82, flowDecay: 0.85 } : {}),
  }),
  S({
    id: "aurora-glass", name: "Aurora Glass", rarity: "exotic", tags: ["weather", "boost"],
    appearIf: (st) => (st.coldDist || 0) > 400,
    blurb: "A shard of northern sky, annealed. It remembers the dance.",
    rule: "While the sky dances: +2.5 boost a second and flow barely drains. Hums on any clear cold night.",
    tick(c, st, dt) {
      const au = c.world.auroraNow || 0;
      if (au > 0.1) c.boost(2.5 * dt * au);
      else if (NIGHT(c) && COLD(c) && (c.world.rainNow || 0) < 0.1) c.boost(0.5 * dt);
    },
    mods: (c) => ((c.world.auroraNow || 0) > 0.1 ? { flowDecay: 0.5 } : {}),
  }),
  // ---------------------------------------------- earned by the journey
  /* These carry `appearIf(stats)`: the waystation shelf only stocks them
   * once the run has DONE the thing — six night kilometres, three borders,
   * seven hundred metres of climb. Phase 11's rule holds: none of it is
   * announced. The reward for a long night is that the night things exist. */
  S({
    id: "owls-eye", name: "Owl's Eye", rarity: "rare", tags: ["weather", "flow"],
    appearIf: (st) => st.nightDist > 6000,
    blurb: "It was watching the dark with you the whole way. Now it rides along.",
    rule: "At night: flow drains ×0.55 and every clean corner pays +1 boost.",
    mods: (c) => (NIGHT(c) ? { flowDecay: 0.55 } : {}),
    on: { cornerDone(c, st, d) { if (d && d.clean && NIGHT(c)) c.boost(1); } },
  }),
  S({
    id: "border-stone", name: "Border Stone", rarity: "exotic", tags: ["journey", "power"],
    appearIf: (st) => st.countries >= 3,
    blurb: "A chip off a milestone from a frontier nobody guards any more.",
    rule: "+6% power and +3% grip for every country this journey has crossed. No limit.",
    mods: (c) => { const n = c.world.countriesNow || 1; return { power: 1 + 0.06 * n, grip: 1 + 0.03 * n }; },
  }),
  S({
    id: "pass-key", name: "Pass Key", rarity: "odd", tags: ["journey", "momentum"],
    appearIf: (st) => st.climb > 700,
    blurb: "Stamped brass, worn smooth. It opens nothing except the mountains.",
    rule: "Climbing: +10% power. Descending: +8% brakes. Flat roads owe it nothing.",
    mods: (c) => (c.car.groundPitch > 0.03 ? { power: 1.1 } : c.car.groundPitch < -0.03 ? { brake: 1.08 } : {}),
  }),
  // ------------------------------------------------------- surface & pace
  S({
    id: "gravel-psalm", name: "Gravel Psalm", rarity: "common", tags: ["offroad", "flow"],
    blurb: "A hymn sheet for roads that were never paved.",
    rule: "Flow builds ×1.25 on gravel and dirt; ×0.9 on tarmac. Pick your roads.",
    mods: (c) => (c.car.surface === "tarmac" ? { flowGain: 0.9 } : { flowGain: 1.25 }),
  }),
  S({
    id: "patient-stone", name: "Patient Stone", rarity: "common", tags: ["flow"],
    blurb: "A river pebble. It has never hurried and it is doing fine.",
    rule: "Flow drains 10% slower, and barely at all under 60 km/h.",
    mods: (c) => ({ flowDecay: Math.abs(c.car.vx) < 16.7 ? 0.05 : 0.9 }),
  }),
  S({
    id: "two-stroke-heart", name: "Two-Stroke Heart", rarity: "odd", tags: ["speed", "power"],
    blurb: "It beats hardest right after the beat changes.",
    rule: "Every gear change: +12% power for 2.5 s.",
    init: () => ({ t: 0 }),
    mods: (c, st) => (st.t > 0 ? { power: 1.12 } : {}),
    on: { gearChange(c, st) { st.t = 2.5; } },
    tick(c, st, dt) { if (st.t > 0) st.t -= dt; },
  }),
  // ---------------------------------------------------------- the journey
  S({
    id: "borrowed-map", name: "Borrowed Map", rarity: "odd", tags: ["route", "flow"],
    blurb: "Someone else's creases, someone else's coffee ring. Their favourite border is marked.",
    rule: "Crossing into a new country: +30 flow and +15 boost.",
    on: { border(c) { c.flow(30); c.boost(15); c.note("New country"); } },
  }),
  S({
    id: "hitchhikers-thumb", name: "Hitchhiker’s Thumb", rarity: "rare", tags: ["route", "boost"],
    blurb: "Carved from oak, worn from use. It approves of long roads.",
    rule: "Departing a waystation pays +1 boost per 100 m of the route you chose.",
    on: {
      legStart(c, st, d) {
        if (d.route && d.route.len) {
          const n = Math.min(80, Math.round(d.route.len * 0.01));
          c.boost(n); c.note("Thumb +" + n);
        }
      },
    },
  }),
  S({
    id: "stray-bolt", name: "Stray Bolt", rarity: "common", tags: ["damage", "boost"],
    blurb: "It fell off something and never looked back.",
    rule: "Every hit pays +6 boost. Pain is fuel.",
    on: { collision(c) { c.boost(6); c.note("Bolt +6"); } },
  }),
  // ---------------------------------------------------------------- fabled
  S({
    id: "perpetual-motion", name: "Perpetual Motion", rarity: "fabled", tags: ["speed", "boost"],
    blurb: "A toy of steel balls that should have stopped years ago.",
    rule: "Above 150 km/h, boost drains 70% slower and every second at speed adds +2 boost.",
    mods: (c) => ({ boostDrain: Math.abs(c.car.vx) > 41.7 ? 0.3 : 1 }),
    tick(c, st, dt) { if (Math.abs(c.car.vx) > 41.7) c.boost(2 * dt); },
  }),
  S({
    id: "the-long-now", name: "The Long Now", rarity: "fabled", tags: ["flow", "precision"],
    blurb: "A clock with one hand. It only tells you whether you are still going.",
    rule: "Reach flow 80 in a leg and flow cannot fall below 40 until the next waystation.",
    init: () => ({ armed: false }),
    on: { legStart(c, st) { st.armed = false; }, waystation(c, st) { st.armed = false; } },
    tick(c, st) {
      if (c.R.flow >= 80) st.armed = true;
      if (st.armed && c.R.flow < 40) c.flow(40 - c.R.flow);
    },
  }),
  S({
    id: "meridian-stone", name: "Meridian Stone", rarity: "fabled", tags: ["speed", "power"],
    blurb: "A milestone chip from the road every road is measured from.",
    rule: "Every kilometre of the journey adds +0.6% power and +0.3% grip, without limit. The road makes the car.",
    mods: (c) => { const km = c.R.dist / 1000; return { power: 1 + 0.006 * km, grip: 1 + 0.003 * km }; },
  }),
  // ------------------------------------------ souvenirs MODIFYING souvenirs
  /* The bible's "modify other artifacts" tier, delivered literally: these
   * read another souvenir's passive rule and replay it. All carry a solo
   * baseline (the bench's law: every souvenir must react alone). */
  S({
    id: "understudy", name: "The Understudy", rarity: "exotic", tags: ["combo"],
    blurb: "It watches the rarest thing in the car and mouths the words.",
    rule: "Copies the rarest other souvenir's passive effects at half strength. Alone, it rehearses: flow ×1.05.",
    mods: (c, st) => {
      if (_mirror) return {};
      const RANK = { common: 0, odd: 1, rare: 2, exotic: 3, fabled: 4 };
      let best = null;
      for (const sv of c.B.souvenirs) {
        if (sv.state === st || !sv.def.mods) continue;
        if (!best || (RANK[sv.def.rarity] || 0) > (RANK[best.def.rarity] || 0)) best = sv;
      }
      return copyMods(c, best, 0.5) || { flowGain: 1.05 };
    },
  }),
  S({
    id: "whetstone", name: "Whetstone", rarity: "exotic", tags: ["combo"],
    blurb: "Kept in the glovebox for whatever comes next.",
    rule: "The souvenir taken right after this one has its passive effects applied twice. Until then it hones the car itself: +4% power.",
    mods: (c, st) => {
      const i = c.B.souvenirs.findIndex((s) => s.state === st);
      const nxt = i >= 0 ? c.B.souvenirs[i + 1] : null;
      return copyMods(c, nxt, 1) || (_mirror ? {} : { power: 1.04 });
    },
  }),
  // ------------------------------------------- conjured onto the road
  /* Combo-spawned pickups: these three close Phase 13's last mechanism —
   * driving well makes the road itself give something back, through
   * ctx.spawnPickup (a real pickup, on the real road, ahead). */
  S({
    id: "breadcrumb-tin", name: "Breadcrumb Tin", rarity: "odd", tags: ["pickup", "precision"],
    blurb: "It rattles when the driving is tidy, and it is never quite empty.",
    rule: "Every fifth clean corner drops a boost canister on the road ahead.",
    init: () => ({ n: 0 }),
    on: {
      cornerDone(c, st, d) {
        if (!d.clean) return;
        if (++st.n >= 5) { st.n = 0; if (c.spawnPickup("canister", 150)) c.note("Breadcrumbs ahead"); }
      },
    },
  }),
  S({
    id: "smoke-signal", name: "Smoke Signal", rarity: "rare", tags: ["drift", "pickup"],
    blurb: "Somebody downwind reads it and leaves something out for you.",
    rule: "A slide held past 2.8 s conjures a pickup 200 m up the road.",
    on: {
      driftEnd(c, st, d) {
        if (d.duration < 2.8) return;
        const kinds = ["canister", "grit", "wrench"];
        const k = kinds[Math.floor(c.time() * 7.3) % 3];
        if (c.spawnPickup(k, 200)) c.note("Signal answered");
      },
    },
  }),
  S({
    id: "pennant-string", name: "Pennant String", rarity: "exotic", tags: ["powerup", "flow"],
    blurb: "Bunting from a rally that never quite ended.",
    rule: "The first time flow reaches tier 4 each leg, a pennant is hung on the road ahead.",
    init: () => ({ hung: false }),
    on: {
      legStart(c, st) { st.hung = false; },
      waystation(c, st) { st.hung = false; },
      flowTier(c, st, d) {
        if (d.up && d.tier >= 4 && !st.hung) { st.hung = true; if (c.spawnPickup("pennant", 250)) c.note("Pennant hung"); }
      },
    },
  }),
  // --------------------------------------------------- the back forty
  S({
    id: "slip-angle-diary", name: "Slip Angle Diary", rarity: "odd", tags: ["drift", "flow"],
    blurb: "Every page is a protractor. The good entries are past thirty degrees.",
    rule: "Ending a slide that peaked past ~25° pays flow equal to half the angle.",
    on: { driftEnd(c, st, d) { if (d.peak > 0.44) { const n = Math.min(25, Math.round(d.peak * 57.3 * 0.5)); c.flow(n); c.note("Diary +" + n); } } },
  }),
  S({
    id: "counterweight", name: "Counterweight", rarity: "odd", tags: ["drift", "precision"],
    blurb: "A sash weight on a strap. Sideways, the pedals feel bolted down.",
    rule: "While sliding, and for a moment after, brakes are 25% stronger.",
    init: () => ({ t: 0 }),
    mods: (c, st) => (st.t > 0 ? { brake: 1.25 } : {}),
    on: { driftStart(c, st) { st.t = 1.2; }, driftTick(c, st) { st.t = 1.2; } },
    tick(c, st, dt) { if (st.t > 0) st.t -= dt; },
  }),
  S({
    id: "iron-shoes", name: "Iron Shoes", rarity: "odd", tags: ["momentum", "power"],
    blurb: "Heavy, loud, and utterly uninterested in stopping.",
    rule: "+8% power, brakes 25% weaker. Momentum is a decision.",
    mods: () => ({ power: 1.08, brake: 0.75 }),
  }),
  S({
    id: "plumb-line", name: "Plumb Line", rarity: "odd", tags: ["precision"],
    blurb: "It hangs dead straight however the road argues.",
    rule: "Every 10 s on the road without sliding adds a stack: +4% grip each, no limit. One slide drops the lot.",
    init: () => ({ t: 0, n: 0 }),
    mods: (c, st) => ({ grip: 1 + 0.04 * st.n }),
    tick(c, st, dt) {
      if (c.car.zone === "road" && Math.abs(c.car.beta) < 0.2 && Math.abs(c.car.vx) > 10) {
        st.t += dt;
        if (st.t >= 10) { st.t -= 10; st.n++; c.note("Plumb ×" + st.n); }
      } else st.t = 0;
    },
    on: { driftStart(c, st) { if (st.n > 0) { st.n = 0; c.note("Plumb drops"); } } },
  }),
  S({
    id: "coiled-spring", name: "Coiled Spring", rarity: "rare", tags: ["jump", "power"],
    blurb: "Salvaged from a pogo stick that cleared a barn.",
    rule: "Each clean landing winds it: +5% power per coil, no limit. Any hit lets it all go.",
    init: () => ({ n: 0 }),
    mods: (c, st) => ({ power: 1 + 0.05 * st.n }),
    on: {
      landed(c, st, d) { if (d.clean && d.air > 0.25) { st.n++; c.note("Spring ×" + st.n); } },
      collision(c, st) { if (st.n > 0) { st.n = 0; c.note("Sproing"); } },
    },
  }),
  S({
    id: "hang-gliders-envy", name: "Hang Glider's Envy", rarity: "odd", tags: ["jump", "flow"],
    blurb: "A postcard of somewhere with thermals, taped to the sun visor.",
    rule: "Leaving the ground pays +2 flow, and while airborne flow builds +4 a second. The ground is a technicality.",
    tick(c, st, dt) { if (!c.car.grounded) c.flow(4 * dt); },
    on: { tookOff(c) { c.flow(2); } },
  }),
  S({
    id: "dented-bell", name: "Dented Bell", rarity: "common", tags: ["damage", "flow"],
    blurb: "It rings truest where it is dented.",
    rule: "Every hit pays +12 flow, and no hit ever knocks the flow down. The journey keeps score differently.",
    mods: () => ({ impactFlowLoss: 0 }),
    on: { collision(c) { c.flow(12); } },
  }),
  S({
    id: "scar-tissue", name: "Scar Tissue", rarity: "odd", tags: ["damage", "durability"],
    blurb: "The panels remember every hedge and flinch less each time.",
    rule: "Each collision hardens the car: −3% damage taken from then on. No limit.",
    init: () => ({ n: 0 }),
    mods: (c, st) => ({ damageScale: Math.max(0.05, 1 - 0.03 * st.n) }),
    on: { collision(c, st) { st.n++; c.note("Scar ×" + st.n); } },
  }),
  S({
    id: "blood-from-stone", name: "Blood From Stone", rarity: "rare", tags: ["damage", "boost"],
    blurb: "A dry pebble that only gives when the car is bleeding.",
    rule: "While condition is under 60: +1.2 boost a second.",
    tick(c, st, dt) { if (c.R.condition < 60) c.boost(1.2 * dt); },
    on: { collision(c) { c.note("The stone stirs"); } },
  }),
  S({
    id: "glass-jaw", name: "Glass Jaw", rarity: "exotic", tags: ["damage", "power"],
    blurb: "A crystal figurine of a boxer, guard down, grinning.",
    rule: "+25% power while condition is 88 or better. Every hit lands 35% harder. Don't get touched.",
    mods: (c) => ({ power: c.R.condition >= 88 ? 1.25 : 1, damageScale: 1.35 }),
  }),
  S({
    id: "jewellers-loupe", name: "Jeweller's Loupe", rarity: "rare", tags: ["precision", "combo"],
    blurb: "Screwed into the eye of somebody who inspects corners for flaws.",
    rule: "Every clean corner is inspected twice: each souvenir that listens for clean corners hears it again.",
    echo: (c, st, name, d) => name === "cornerDone" && !!d.clean,
  }),
  S({
    id: "switchboard", name: "Switchboard", rarity: "rare", tags: ["combo"],
    blurb: "Every lamp on it is another souvenir calling in. Sometimes the line crosses.",
    rule: "Every fourth thing that happens to the car happens twice: the fourth event of any kind is heard by every souvenir again.",
    init: () => ({ n: 0 }),
    echo: (c, st) => { if (++st.n >= 4) { st.n = 0; return true; } return false; },
  }),
  S({
    id: "fog-lamp-prayer", name: "Fog Lamp Prayer", rarity: "odd", tags: ["weather", "precision"],
    blurb: "A laminated card of words for when the road goes missing.",
    rule: "In fog: brakes +10% and flow builds ×1.2. Drive the calls.",
    mods: (c) => ((c.world.fogNow || 0) > 0.4 ? { brake: 1.1, flowGain: 1.2 } : {}),
  }),
  S({
    id: "night-ferry-ticket", name: "Night Ferry Ticket", rarity: "rare", tags: ["weather", "pickup"],
    blurb: "One way, unpunched. The dark is a crossing, not a wall.",
    rule: "At night: +8% power and pickups lean closer.",
    mods: (c) => (NIGHT(c) ? { power: 1.08, pickupMagnet: 1.6 } : {}),
  }),
  S({
    id: "ice-fishers-line", name: "Ice Fisher's Line", rarity: "rare", tags: ["weather", "pickup"],
    appearIf: (st) => (st.coldDist || 0) > 400,
    blurb: "Spooled tight, patient, and very good through cold water.",
    rule: "On snow and ice, pickup reach is 2.5×.",
    mods: (c) => (ICY(c) ? { pickupMagnet: 2.5 } : {}),
  }),
  S({
    id: "hearthstone", name: "Hearthstone", rarity: "rare", tags: ["weather", "durability"],
    appearIf: (st) => (st.coldDist || 0) > 400,
    blurb: "A brick that spent forty years in a fireplace and remembers it.",
    rule: "In cold country flow drains ×0.9, and under 60 km/h the warmth works: +0.25 condition a second.",
    mods: (c) => (COLD(c) ? { flowDecay: 0.9 } : {}),
    tick(c, st, dt) { if (COLD(c) && Math.abs(c.car.vx) < 16.7) c.repair(0.25 * dt); },
  }),
  S({
    id: "ditch-map", name: "Ditch Map", rarity: "rare", tags: ["offroad"],
    blurb: "The fields have lines on them only it can see.",
    rule: "Off-road drag −30%, and off the road entirely: +20% grip.",
    mods: (c) => (c.car.zone === "off" ? { offDrag: 0.7, grip: 1.2 } : { offDrag: 0.7 }),
  }),
  S({
    id: "bottle-deposit", name: "Bottle Deposit", rarity: "common", tags: ["pickup", "boost"],
    blurb: "Nothing on the road is worthless if you know the counter that takes it.",
    rule: "Every canister you take leaves an empty: 250 m on, another canister. Empties don't return empties.",
    on: { pickup(c, st, d) { if (d.kind === "canister" && !d.echo && !d.spawned && c.spawnPickup("canister", 250)) c.note("Deposit returned"); } },
  }),
  S({
    id: "sinister-charm", name: "Sinister Charm", rarity: "odd", tags: ["pickup"],
    blurb: "Worn on the left wrist. It has opinions about which side of the road matters.",
    rule: "Pickups taken on the LEFT side of the road count double.",
    on: { pickup(c, st, d) { if (d.side < 0 && !d.echo && !d.repeat) { d.repeat = true; c.note("Sinister ×2"); } } },
  }),
  S({
    id: "pilgrims-token", name: "Pilgrim's Token", rarity: "odd", tags: ["journey", "power"],
    blurb: "Stamped once at every shrine. The car walks a little taller each time.",
    rule: "Every waystation visited adds +3% power for the rest of the run. No limit.",
    init: () => ({ n: 0 }),
    mods: (c, st) => ({ power: 1 + 0.03 * st.n }),
    on: { waystation(c, st) { st.n++; c.note("Token ×" + st.n); } },
  }),
  S({
    id: "odometers-pride", name: "Odometer's Pride", rarity: "common", tags: ["journey", "durability"],
    blurb: "It rolls its digits like a drummer. Round numbers are its solos.",
    rule: "Every 5 km of the journey the digits roll over: +15 condition and +20 flow. Round numbers heal.",
    init: () => ({ next: 5000 }),
    tick(c, st) { if (c.R.dist >= st.next) { st.next += 5000; c.repair(15); c.flow(20); c.note((Math.round(st.next / 1000) - 5) + " km"); } },
  }),
  S({
    id: "cold-start", name: "Cold Start", rarity: "common", tags: ["power", "journey"],
    blurb: "The engine likes the first miles best, before anything is routine.",
    rule: "For 30 s after every departure, the shakedown sprint: +20% power and damage −40%. Each departure's sprint lasts 15 s longer than the last. No limit.",
    init: () => ({ t: 0, n: 0 }),
    mods: (c, st) => (st.t > 0 ? { power: 1.2, damageScale: 0.6 } : {}),
    on: { legStart(c, st) { st.n++; st.t = 30 + 15 * (st.n - 1); c.note("Shakedown " + Math.round(st.t) + " s"); } },
    tick(c, st, dt) { if (st.t > 0) st.t -= dt; },
  }),
  S({
    id: "second-hand", name: "Second Hand", rarity: "odd", tags: ["flow", "boost"],
    blurb: "A watch hand with no watch. It only moves when you are really going.",
    rule: "While flow is 80 or higher, boost drains ×0.25. The overflow pays for the fire.",
    mods: (c) => (c.R.flow >= 80 ? { boostDrain: 0.25 } : {}),
  }),
  S({
    id: "siphon", name: "Siphon", rarity: "odd", tags: ["boost", "durability"],
    blurb: "A loop of clear hose. Pressure finds somewhere useful to go.",
    rule: "Boost above 80 bleeds off at 2 a second and mends the car at +0.4 condition a second.",
    tick(c, st, dt) {
      if (c.R.boost > 80) { c.R.boost = Math.max(80, c.R.boost - 2 * dt); c.repair(0.4 * dt); }
    },
  }),
  // -------------------------------------------- heirlooms (the lifetime shelf)
  /* Between-run progression, with restraint: these exist only once the
   * PLAYER's whole diary has done the thing — countries ever crossed,
   * lifetime kilometres, postcards ever collected. Additive content on the
   * shelf, never announced, and a fresh run is not weaker without them. */
  S({
    id: "grand-tour-sticker", name: "Grand Tour Sticker", rarity: "rare", tags: ["journey", "boost"],
    appearIf: (st) => (st.countriesEver || 0) >= 5,
    blurb: "Five flags on peeling vinyl. The car has been around, and knows it.",
    rule: "Crossing into a new country: +25 boost and +8 condition. Borders are old friends.",
    on: { border(c) { c.boost(25); c.repair(8); c.note("Grand Tour"); } },
  }),
  S({
    id: "retired-plate", name: "Retired Number Plate", rarity: "exotic", tags: ["journey", "power"],
    appearIf: (st) => (st.lifeKm || 0) >= 100,
    blurb: "It hung on a car that never stopped either.",
    rule: "Once this journey passes 10 km, the shakedown ends: +8% power and flow decays ×0.85 for the rest of it.",
    mods: (c) => (c.R.dist >= 10000 ? { power: 1.08, flowDecay: 0.85 } : {}),
  }),
  S({
    id: "collectors-album", name: "Collector's Album", rarity: "rare", tags: ["route", "journey"],
    appearIf: (st) => (st.postcardsEver || 0) >= 8,
    blurb: "Slots for everything, most still empty. The shelf respects a collector.",
    rule: "Every two postcards this journey writes add a card to every shelf from then on.",
    mods: (c) => ({ extraCards: Math.floor((c.R.postcardsN || 0) / 2) }),
  }),
  S({
    id: "the-open-road", name: "The Open Road", rarity: "fabled", tags: ["journey", "boost"],
    blurb: "Not a thing at all. Just the fact of it, riding along.",
    rule: "While flow is 60 or better, every 500 m of road pays +6 boost and +2 condition. The journey funds itself.",
    init: () => ({ last: null }),
    tick(c, st) {
      if (c.R.flow >= 60) {
        if (st.last == null) st.last = c.R.dist;
        if (c.R.dist - st.last >= 500) { st.last += 500; c.boost(6); c.repair(2); }
      } else st.last = null;
    },
  }),
  /* ------------------------------------------------- the hundredth wave
   * (Phase 21, 2026-08-25): these lean NON-BOOST by the Two Drives ruling —
   * world, weather, discovery and the codriver get residents. */
  S({
    id: "fog-bell", name: "Fog Bell", rarity: "odd", tags: ["weather", "flow"],
    blurb: "A harbour bell, green with salt. It knows its way through the murk.",
    rule: "In fog the car steadies and the zone holds: +12% stability, and flow decays half as fast while the fog is thick.",
    mods: (c) => ((c.world.fogNow || 0) > 0.4 ? { stability: 1.12, flowDecay: 0.5 } : {}),
  }),
  S({
    id: "pressed-flower", name: "Pressed Flower", rarity: "odd", tags: ["journey", "flow"],
    blurb: "Picked at the first landmark that was worth stopping for.",
    rule: "Every postcard this journey writes presses a flower between the pages: +4% grip each. No limit.",
    /* reads the run's postcard count (sim state, rides the save) — the
     * diary IS the state, so a resumed journey keeps its flowers */
    mods: (c) => ({ grip: 1 + 0.04 * (c.R.postcardsN || 0) }),
  }),
  S({
    id: "shared-thermos", name: "Shared Thermos", rarity: "common", tags: ["journey", "flow"],
    blurb: "Two cups, one flask. Somebody has to pour.",
    rule: "Every remark the codriver offers (\"nice\", \"good save\", \"there's the sun\") warms the cabin: +10 flow.",
    on: { remark(c) { c.flow(10); } },
  }),
  S({
    id: "miners-lamp", name: "Miner's Lamp", rarity: "odd", tags: ["journey", "power"],
    blurb: "Brass, dented, still lit. It burns warmer underground.",
    rule: "Inside a tunnel the car comes alive: +8% power, and flow builds ×1.6 while the walls are close.",
    mods: (c) => {
      const encl = c.world.spanEnclosure ? c.world.spanEnclosure(c.car.s) : 0;
      return encl > 0.3 ? { power: 1.08, flowGain: 1.6 } : {};
    },
  }),

  /* ==================================================================
   * THE ROGUELIKE WAVE (Phase 25, 2026-08-30) — fifty souvenirs written
   * in Balatro's grammar so that runs stop rhyming: scalers with no cap,
   * echoes, an amplifier, converters, the deck, counters, copiers, and a
   * few honest gambles. Every one reacts alone on the bench.
   * ================================================================== */

  // -------------------------------------------------------------- scalers
  S({
    id: "tally-stick", name: "Tally Stick", rarity: "common", tags: ["pickup", "power"],
    blurb: "A hazel rod, notched. Every notch is something the road gave up.",
    rule: "+1% power for every pickup taken this journey. No limit.",
    init: () => ({ n: 0 }),
    mods: (c, st) => ({ power: 1 + 0.01 * st.n }),
    on: { pickup(c, st) { st.n++; if (st.n % 10 === 0) c.note("Tally " + st.n); } },
  }),
  S({
    id: "rosary-of-corners", name: "Rosary of Corners", rarity: "odd", tags: ["precision"],
    blurb: "One bead per bend, told under the breath. The string is very long.",
    rule: "Each clean corner adds a bead: +1% grip per bead, no limit. A dirty corner drops ten beads.",
    init: () => ({ n: 0 }),
    mods: (c, st) => ({ grip: 1 + 0.01 * st.n }),
    on: { cornerDone(c, st, d) { if (d.clean) { st.n++; if (st.n % 10 === 0) c.note("Rosary ×" + st.n); } else if (st.n > 0) { st.n = Math.max(0, st.n - 10); c.note("Beads spilled"); } } },
  }),
  S({
    id: "snowball", name: "Snowball", rarity: "rare", tags: ["boost", "combo"],
    blurb: "Started as a fistful at the top of the pass. It only rolls one way.",
    rule: "Every trick the car lands (a slide ended, a landing, a clean corner, a pickup, a near miss) makes all boost gains +2% richer. No limit.",
    init: () => ({ k: 0 }),
    mods: (c, st) => ({ boostGain: 1 + st.k }),
    on: (() => {
      const roll = (c, st, d) => { if (d && d.clean === false) return; st.k += 0.02; if (Math.round(st.k * 50) % 25 === 0) c.note("Snowball ×" + (1 + st.k).toFixed(1)); };
      return { driftEnd: roll, landed: roll, cornerDone: roll, pickup: roll, nearMiss: roll };
    })(),
  }),
  S({
    id: "growth-ring", name: "Growth Ring", rarity: "rare", tags: ["durability", "journey"],
    blurb: "A slice of trunk on the dash. Another ring every stop; the wood gets harder.",
    rule: "No single hit can do more than 24 damage, and every waystation lowers that cap by 2, down to 4.",
    init: () => ({ n: 0 }),
    mods: (c, st) => ({ hitCap: Math.max(4, 24 - 2 * st.n) }),
    on: { waystation(c, st) { st.n++; c.note("Ring " + st.n + ": cap " + Math.max(4, 24 - 2 * st.n)); } },
  }),
  S({
    id: "long-memory", name: "Long Memory", rarity: "exotic", tags: ["flow"],
    blurb: "An elephant carved from a bottle stopper. It remembers being in the zone.",
    rule: "Every 30 s spent in the zone (flow 80+) makes flow build +5% faster, for good. No limit.",
    init: () => ({ t: 0, k: 0 }),
    mods: (c, st) => ({ flowGain: 1 + st.k }),
    tick(c, st, dt) { if (c.R.flow >= 80) { st.t += dt; if (st.t >= 30) { st.t -= 30; st.k += 0.05; c.note("Long Memory ×" + (1 + st.k).toFixed(2)); } } },
  }),
  S({
    id: "compound-interest", name: "Compound Interest", rarity: "fabled", tags: ["boost", "power"],
    blurb: "A passbook from a bank that closed. The figures keep going up regardless.",
    rule: "Every 30 s with boost above half adds +4% power, permanently. No limit. Wealth compounds; spending doesn't.",
    init: () => ({ t: 0, k: 0 }),
    mods: (c, st) => ({ power: 1 + st.k }),
    tick(c, st, dt) { if (c.R.boost > 50) { st.t += dt; if (st.t >= 30) { st.t -= 30; st.k += 0.04; c.note("Interest +" + Math.round(st.k * 100) + "%"); } } },
  }),
  S({
    id: "night-shift", name: "Night Shift", rarity: "rare", tags: ["weather", "power"],
    appearIf: (st) => (st.nightDist || 0) > 1500,
    blurb: "A punch card from a factory that only ran after dark.",
    rule: "+1% power for every kilometre this journey has driven in the dark. No limit.",
    mods: (c) => ({ power: 1 + 0.01 * ((c.R.nightDist || 0) / 1000) }),
  }),

  // --------------------------------------------------------------- echoes
  S({
    id: "stutter-box", name: "Stutter Box", rarity: "rare", tags: ["drift", "combo"],
    blurb: "A tape delay from a village hall PA. It repeats the last thing you said sideways.",
    rule: "Every slide you end is heard twice: each souvenir listening for a slide's end answers again.",
    echo: (c, st, name) => name === "driftEnd",
  }),
  S({
    id: "double-exposure", name: "Double Exposure", rarity: "rare", tags: ["jump", "combo"],
    blurb: "One frame, two landings. The lab couldn't explain it either.",
    rule: "Every landing is heard twice: each souvenir listening for landings answers again.",
    echo: (c, st, name) => name === "landed",
  }),
  S({
    id: "carbon-paper", name: "Carbon Paper", rarity: "exotic", tags: ["pickup", "combo"],
    blurb: "A sheet of it, still blue. Everything written on the road comes through twice.",
    rule: "Every pickup rings every souvenir twice. The road pays once; the car hears it twice.",
    echo: (c, st, name) => name === "pickup",
  }),
  S({
    id: "ventriloquist", name: "The Ventriloquist", rarity: "exotic", tags: ["combo"],
    blurb: "A wooden dummy in the back seat. It only repeats one voice.",
    rule: "Whatever happens, the souvenir taken just BEFORE this one hears it a second time. Alone, it practises: flow ×1.05.",
    mods: (c, st) => {
      const i = c.B.souvenirs.findIndex((s) => s.state === st);
      return i > 0 ? {} : { flowGain: 1.05 };
    },
    echo: (c, st, name) => {
      const i = c.B.souvenirs.findIndex((s) => s.state === st);
      const prev = i > 0 ? c.B.souvenirs[i - 1] : null;
      return prev && prev.def.on && prev.def.on[name] ? prev : false;
    },
  }),
  S({
    id: "deja-vu", name: "Déjà Vu", rarity: "fabled", tags: ["combo"],
    blurb: "You have definitely driven this corner before. You have definitely driven this corner before.",
    rule: "One event in three happens twice. Which one is never yours to choose.",
    init: () => ({ k: 0x9e3779b9 }),
    echo: (c, st) => { st.k = (Math.imul(st.k, 1103515245) + 12345) >>> 0; return ((st.k >>> 16) % 3) === 0; },
  }),

  // ----------------------------------------------------------- converters
  S({
    id: "pressure-gauge", name: "Pressure Gauge", rarity: "odd", tags: ["boost", "power"],
    blurb: "A brass dial plumbed into the wrong pipe. It reads what you haven't spent.",
    rule: "+1% power per 4 boost held. A full tank is a +25% engine, and firing it spends the engine.",
    mods: (c) => ({ power: 1 + c.R.boost / 400 }),
  }),
  S({
    id: "sweat-equity", name: "Sweat Equity", rarity: "odd", tags: ["damage", "flow"],
    blurb: "A contract written on a beer mat. The worse the car, the better the terms.",
    rule: "Flow builds faster the worse the car is: ×(1 + condition lost ÷ 100). A wreck drives with feeling.",
    mods: (c) => ({ flowGain: 1 + (100 - c.R.condition) / 100 }),
  }),
  S({
    id: "butter-knife", name: "Butter Knife", rarity: "odd", tags: ["drift"],
    blurb: "Blunt on the straight, sharp on the turn. Ask the toast.",
    rule: "Grip ×0.9 in a straight line, ×1.2 once sideways. The car has to be persuaded, then it sticks.",
    mods: (c) => ({ grip: Math.abs(c.car.beta) > 0.25 ? 1.2 : 0.9 }),
  }),
  S({
    id: "slipstream-plating", name: "Slipstream Plating", rarity: "rare", tags: ["speed", "durability"],
    blurb: "Louvred panels that only close at speed. Slow, they hang open like shutters.",
    rule: "Every km/h over 80 shaves 0.6% off damage taken (−40% by 150). Under 40 km/h the plates hang open: +40%.",
    mods: (c) => { const v = KMH(c); return { damageScale: v > 80 ? Math.max(0.4, 1 - 0.006 * (v - 80)) : v < 40 ? 1.4 : 1 }; },
  }),
  S({
    id: "tortoise-shell", name: "Tortoise Shell", rarity: "rare", tags: ["durability", "momentum"],
    blurb: "Polished, hollow, and heavier than it looks. It closes when you slow down.",
    rule: "Under 70 km/h the shell is shut: damage −70%. Over 110 it is wide open: +30%.",
    mods: (c) => { const v = KMH(c); return { damageScale: v < 70 ? 0.3 : v > 110 ? 1.3 : 1 }; },
  }),
  S({
    id: "blood-bank", name: "Blood Bank", rarity: "exotic", tags: ["boost", "damage"],
    blurb: "A donor card, laminated. The car has agreed to give.",
    rule: "Boost never drains. The car bleeds instead: −1.5 condition a second while the boost is held. Bring something that heals.",
    mods: () => ({ boostDrain: 0 }),
    tick(c, st, dt) { if (c.R.boostOn && !c.R.autoBoost) c.damage(2.27 * dt); },
  }),

  // ------------------------------------------------------------- the deck
  /* Ownership-only, by law (see the file header): these change what the
   * WORLD deals from the next section on. */
  S({
    id: "litter-pick", name: "Litter Pick", rarity: "common", tags: ["pickup"],
    blurb: "A grabber and a hi-vis vest. Suddenly the verges are full of things.",
    rule: "Twice as many pickups lie on every road from here on.",
    mods: () => ({ pickupDensity: 2 }),
  }),
  S({
    id: "jerrycan-country", name: "Jerrycan Country", rarity: "odd", tags: ["pickup", "boost"],
    blurb: "A dented can with somebody else's initials. Round here, everyone leaves one out.",
    rule: "From here on the road is mostly canisters, three times as many, and wrenches are scarce.",
    mods: () => ({ pickupCanister: 3, pickupWrench: 0.4 }),
  }),
  S({
    id: "field-hospital", name: "Field Hospital", rarity: "odd", tags: ["pickup", "durability"],
    blurb: "A red cross painted on a biscuit tin. The road starts leaving out tools.",
    rule: "From here on the road stocks wrenches, three times as many, and each heals +25 instead of +15. Canisters are scarce.",
    mods: () => ({ pickupWrench: 3, pickupCanister: 0.4 }),
    on: { pickup(c, st, d) { if (d.kind === "wrench" && !d.echo) c.repair(10); } },
  }),
  S({
    id: "grit-merchant", name: "Grit Merchant", rarity: "odd", tags: ["pickup", "offroad"],
    blurb: "A trade card for a man who sells grip by the sack.",
    rule: "Grit is everywhere from here on, four times as common, and a fresh dose lasts 24 s instead of 12.",
    mods: () => ({ pickupGrit: 4 }),
    on: { pickup(c, st, d) { if (d.kind === "grit" && !d.echo) c.R.gritT = 24; } },
  }),
  S({
    id: "bunting-season", name: "Bunting Season", rarity: "rare", tags: ["powerup", "pickup"],
    blurb: "It is always the week of the fête somewhere.",
    rule: "Pennants fly four times as often on every road from here on.",
    mods: () => ({ pickupPennant: 4 }),
  }),
  S({
    id: "long-way-home", name: "Long Way Home", rarity: "odd", tags: ["route", "journey"],
    blurb: "A map with the direct roads inked out. Whoever owned it was in no hurry.",
    rule: "Every route on offer is 40% longer. More road between shelves, and more of everything a leg pays.",
    mods: () => ({ routeLen: 1.4 }),
  }),
  S({
    id: "short-cuts", name: "Short Cuts", rarity: "odd", tags: ["route", "journey"],
    blurb: "A local's directions, scribbled. Half of them are through somebody's yard.",
    rule: "Every route on offer is 30% shorter. Shelves come sooner; legs pay less.",
    mods: () => ({ routeLen: 0.7 }),
  }),
  S({
    id: "brow-hunters-almanac", name: "Brow Hunter's Almanac", rarity: "rare", tags: ["route", "jump"],
    blurb: "Every blind crest in the county, with a star rating.",
    rule: "Every road from here on grows twice the brows and twice the jumps.",
    mods: () => ({ routeCrest: 2, routeJump: 2 }),
  }),
  S({
    id: "mechanics-favour", name: "Mechanic's Favour", rarity: "rare", tags: ["route", "durability"],
    blurb: "An IOU from the trade, signed in grease. It is honoured everywhere.",
    rule: "Every shelf stocks a Full Service, whatever the car's condition.",
    mods: () => ({ serviceAlways: true }),
  }),
  S({
    id: "fabled-rumour", name: "Fabled Rumour", rarity: "exotic", tags: ["route"],
    blurb: "Somebody at the last stop swore they'd seen one. The mechanics start looking harder.",
    rule: "The shelf is one card shorter, and what is on it is far rarer.",
    mods: () => ({ extraCards: -1, luckBonus: 1.2 }),
  }),
  S({
    id: "loaded-dice", name: "Loaded Dice", rarity: "rare", tags: ["route"],
    blurb: "Two bone dice that will not roll a one.",
    rule: "No common souvenir ever reaches the shelf again. What's left is stranger.",
    mods: () => ({ noCommons: true }),
  }),

  // ------------------------------------------------------------- counters
  S({
    id: "drift-society", name: "Drift Society", rarity: "rare", tags: ["drift", "boost"],
    blurb: "A membership pin. The more of you there are, the louder the clubhouse.",
    rule: "Every slide you end pays +5 boost per drift souvenir in the car. It counts itself.",
    on: { driftEnd(c) { const n = tagCount(c, "drift"); c.boost(5 * n); c.note("Society +" + 5 * n); } },
  }),
  S({
    id: "commoners-crown", name: "Commoner's Crown", rarity: "common", tags: ["combo", "power"],
    blurb: "Tin, painted gold, and worn with total conviction.",
    rule: "+5% power for every COMMON souvenir in the car. It counts itself. Cheap things, well kept.",
    mods: (c) => { let n = 0; for (const sv of c.B.souvenirs) if (sv.def.rarity === "common") n++; return { power: 1 + 0.05 * n }; },
  }),
  S({
    id: "empty-shelf", name: "Empty Shelf", rarity: "exotic", tags: ["combo", "power"],
    blurb: "A dashboard with nothing on it. You can hear the engine.",
    rule: "+60% power, divided by the number of souvenirs in the car. Alone, it is a different car.",
    mods: (c) => ({ power: 1 + 0.6 / Math.max(1, c.B.souvenirs.length) }),
  }),
  S({
    id: "charm-bracelet", name: "Charm Bracelet", rarity: "rare", tags: ["combo"],
    blurb: "A tiny tyre, a tiny cloud, a tiny wrench. It wants one of everything.",
    rule: "+2% power and +2% grip per DISTINCT tag across the build. At eight tags the bracelet closes: flow builds ×1.2 on top.",
    mods: (c) => {
      const tags = new Set();
      for (const sv of c.B.souvenirs) for (const t of sv.def.tags || []) tags.add(t);
      const n = tags.size;
      const o = { power: 1 + 0.02 * n, grip: 1 + 0.02 * n };
      if (n >= 8) o.flowGain = 1.2;
      return o;
    },
  }),
  S({
    id: "rosetta-stone", name: "Rosetta Stone", rarity: "fabled", tags: ["combo"],
    blurb: "The same rule in three languages, and every translation is a little stronger.",
    rule: "Every OTHER souvenir's passive numbers are 25% stronger: a +8% becomes a +10%, a ×0.5 a ×0.375.",
    amp: 1.25,
    /* the bench wants a solo reaction: alone it has nothing to amplify, so
     * it reads the car instead — the same +2% it would give a Cold Intake */
    mods: (c) => (c.B.souvenirs.length > 1 ? {} : { power: 1.02 }),
  }),

  // -------------------------------------------------------------- copiers
  S({
    id: "mirror-shard", name: "Mirror Shard", rarity: "exotic", tags: ["combo"],
    blurb: "A triangle of wing mirror, taped to the dash. It shows what came before.",
    rule: "Copies the passive effects of the souvenir taken just BEFORE it, at full strength. Alone it shows you the car: +4% grip.",
    mods: (c, st) => {
      const i = c.B.souvenirs.findIndex((s) => s.state === st);
      const prev = i > 0 ? c.B.souvenirs[i - 1] : null;
      return copyMods(c, prev, 1) || (_mirror ? {} : { grip: 1.04 });
    },
  }),
  S({
    id: "odometer-of-babel", name: "Odometer of Babel", rarity: "fabled", tags: ["combo", "journey"],
    blurb: "Its digits are in a different script every time you look.",
    rule: "Every 10 km it becomes a copy of a different souvenir you carry, chosen by the road, not by you. Alone it hums: +5% power.",
    init: () => ({ pick: null }),
    mods: (c, st) => {
      const others = c.B.souvenirs.filter((s) => s.state !== st && s.def.mods);
      if (!others.length) return _mirror ? {} : { power: 1.05 };
      const k = h32(Math.floor((c.R.dist || 0) / 10000) + 17) % others.length;
      const sv = others[k];
      if (!_mirror && st.pick !== sv.def.id) { st.pick = sv.def.id; c.note("Babel speaks as " + sv.def.name); }
      return copyMods(c, sv, 1) || {};
    },
  }),

  // ------------------------------------------------------ trades & gambles
  S({
    id: "hair-trigger", name: "Hair Trigger", rarity: "exotic", tags: ["boost", "speed"],
    blurb: "A switch under the dash with the safety filed off.",
    rule: "Above 120 km/h the boost fires itself, free. The zone can't keep up: flow drains ×2, always.",
    mods: (c) => ({ autoBoost: KMH(c) > 120, flowDecay: 2 }),
  }),
  S({
    id: "lead-sled", name: "Lead Sled", rarity: "odd", tags: ["momentum", "power"],
    blurb: "Sheets of roofing lead under the floor. The car has never seen the sky.",
    rule: "The car barely leaves the ground (lift ×0.5) and is very hard to roll. +15% power. Brakes −15%. Crests are for other people.",
    mods: () => ({ lift: 0.5, power: 1.15, brake: 0.85, rollResist: 1.3 }),
  }),
  S({
    id: "helium-bottle", name: "Helium Bottle", rarity: "rare", tags: ["jump"],
    blurb: "A party cylinder strapped where the spare should be. The valve leaks a little.",
    rule: "Every take-off kicks harder (lift ×1.6). Every brow is a jump now.",
    mods: () => ({ lift: 1.6 }),
  }),
  S({
    id: "tin-man", name: "Tin Man", rarity: "exotic", tags: ["durability"],
    blurb: "A funnel hat on the aerial. He doesn't feel much and he doesn't hurry.",
    rule: "Damage −60%. Power −15%, brakes −15%. It doesn't feel much, and it doesn't stop much either.",
    mods: () => ({ damageScale: 0.4, power: 0.85, brake: 0.85 }),
  }),
  S({
    id: "grace-note", name: "Grace Note", rarity: "rare", tags: ["flow", "durability"],
    blurb: "A single quaver, inked on the sun visor. Played after the mistake, not before.",
    rule: "When grace absorbs a hit, the zone holds: flow returns to 60 and the car takes +30 boost.",
    on: { grace(c) { c.flow(Math.max(0, 60 - c.R.flow)); c.boost(30); c.note("Grace note"); } },
  }),

  // ------------------------------------------------------ places & moments
  S({
    id: "sightseers-ticket", name: "Sightseer's Ticket", rarity: "odd", tags: ["journey", "flow"],
    blurb: "A day pass to everything. It gets punched at the viaducts.",
    rule: "Reaching any landmark (a viaduct, a village, a monastery, a stadium) pays +20 flow and +10 boost.",
    on: { eventEnter(c, st, d) { c.flow(20); c.boost(10); c.note("Punched: " + (d.name || d.key)); } },
  }),
  S({
    id: "handbrake-habit", name: "Handbrake Habit", rarity: "odd", tags: ["drift", "boost"],
    blurb: "The lever's grip is worn smooth. Somebody reaches for it in every village.",
    rule: "Every handbrake pull at speed: +8 boost, and the slide it starts builds flow ×1.6 for 3 s.",
    init: () => ({ t: 0 }),
    mods: (c, st) => (st.t > 0 ? { flowGain: 1.6 } : {}),
    on: { handbrake(c, st) { st.t = 3; c.boost(8); c.note("Yank"); } },
    tick(c, st, dt) { if (st.t > 0) st.t -= dt; },
  }),
  S({
    id: "blow-off-charm", name: "Blow-off Charm", rarity: "common", tags: ["boost", "speed"],
    blurb: "A tiny brass whistle on the wastegate. It sighs when you lift.",
    rule: "Every turbo blow-off, that sigh when you lift after a full spool, pays +3 boost.",
    on: { blowOff(c) { c.boost(3); } },
  }),
  S({
    id: "hairpin-devotee", name: "Hairpin Devotee", rarity: "odd", tags: ["precision", "drift"],
    blurb: "A pilgrim's badge from the pass with twenty-one of them.",
    rule: "A clean hairpin or tight corner (a one or a two) pays +15 boost and +15% power for 5 s.",
    init: () => ({ t: 0 }),
    mods: (c, st) => (st.t > 0 ? { power: 1.15 } : {}),
    on: { cornerDone(c, st, d) { if (d.clean && d.grade <= 2) { st.t = 5; c.boost(15); c.note("Hairpin!"); } } },
    tick(c, st, dt) { if (st.t > 0) st.t -= dt; },
  }),
  S({
    id: "slalom-poles", name: "Slalom Poles", rarity: "odd", tags: ["precision", "power"],
    blurb: "Two bamboo canes with rags on. Left, right, left. You can hear them slap.",
    rule: "Clean corners that alternate (left, right, left) link up: +3% power per link, no limit. Two the same way in a row snaps the line.",
    init: () => ({ n: 0, dir: 0 }),
    mods: (c, st) => ({ power: 1 + 0.03 * st.n }),
    on: {
      cornerDone(c, st, d) {
        if (!d.clean || !d.dir) { if (st.n > 0) c.note("Poles down"); st.n = 0; st.dir = 0; return; }
        if (st.dir && d.dir === -st.dir) { st.n++; if (st.n % 3 === 0) c.note("Slalom ×" + st.n); }
        else if (st.dir && d.dir === st.dir) { if (st.n > 0) c.note("Poles down"); st.n = 0; }
        st.dir = d.dir;
      },
    },
  }),
  S({
    id: "last-kilometre", name: "Last Kilometre", rarity: "common", tags: ["journey", "power"],
    blurb: "A marker board with a chequered edge. The car reads it from a long way off.",
    rule: "The last 800 m before every waystation: +20% power and flow builds ×2. A sprint finish.",
    mods: (c) => {
      const ws = c.world.nextWaystation ? c.world.nextWaystation(c.car.s) : null;
      const rem = ws ? ws.s - c.car.s : 9e9;
      return rem > 0 && rem < 800 ? { power: 1.2, flowGain: 2 } : {};
    },
    on: { legStart(c, st, d) { if (d.route && d.route.len) c.note("Finish in " + (d.route.len / 1000).toFixed(1) + " km"); } },
  }),

  // ----------------------------------------------------------- the Sweep
  /* ROADMAP 20.7: a small wing offered ONLY in Sweep runs (offerCards reads
   * `modeOnly`); rules about time, margin and the pursuer. The Drive never
   * sees them and lost nothing for them. The bench primes sweepOn. */
  S({
    id: "rear-view-charm", name: "Rear-View Charm", rarity: "odd", tags: ["sweep", "power", "flow"], modeOnly: "sweep",
    blurb: "A tiny saint, hung from the mirror, facing backwards.",
    rule: "In the Sweep: under 25 s in hand, the car finds +15% power and flow builds ×1.3. Fear is a fuel.",
    mods: (c) => (c.R.sweepOn && c.R.sweepMarginS < 25 ? { power: 1.15, flowGain: 1.3 } : {}),
  }),
  S({
    id: "blue-flag", name: "Blue Flag", rarity: "odd", tags: ["sweep", "precision"], modeOnly: "sweep",
    blurb: "The marshal's flag for a slower car behind. You are waving it at the sweep.",
    rule: "In the Sweep: every clean corner pushes the sweep car 15 m back down the road.",
    on: { cornerDone(c, st, d) { if (d.clean && c.R.sweepOn) { c.sweep(15); c.note("Blue flag"); } } },
  }),
  S({
    id: "bank-teller", name: "Bank Teller", rarity: "rare", tags: ["sweep", "boost"], modeOnly: "sweep",
    blurb: "A brass window grille from a bank that took time as deposits.",
    rule: "In the Sweep: arrive with boost above 40 and every point over it pushes the sweep 8 m back. The boost is spent.",
    on: {
      waystation(c, st) {
        if (!c.R.sweepOn || c.R.boost <= 40) return;
        const spent = c.R.boost - 40;
        c.sweep(8 * spent); c.R.boost = 40; c.note("Banked " + Math.round(spent) + " → " + Math.round(8 * spent) + " m");
      },
    },
  }),
  S({
    id: "split-time", name: "Split Time", rarity: "rare", tags: ["sweep", "damage"], modeOnly: "sweep",
    blurb: "A stopwatch with a cracked face. It stopped for you once.",
    rule: "In the Sweep: the first dent of every leg does no damage. The sweep gains 150 m instead.",
    init: () => ({ ready: true }),
    on: { legStart(c, st) { st.ready = true; }, waystation(c, st) { st.ready = true; } },
    onDamage(c, st, d) {
      if (st.ready && c.R.sweepOn && d.delta >= 6 && !d.landing) { st.ready = false; c.sweep(-150); c.note("Split time"); return 0; }
      return d.delta;
    },
  }),

  /* ==================================================================
   * THE THREE ENDS (Phase 25.2): recovery — the archetype the bible named
   * and the catalog never had. A journey starts with NO help: a SAVE is
   * earned at the 1st, 5th, 10th and 20th waystation (run.js SAVE_AT) and
   * never again unless a souvenir gives one. A rolled car on its roof, a
   * car stopped in the lake, a fall, a stranding each spend a save, or end
   * the journey when none is left. These cards add saves, reopen the
   * schedule, answer an incident themselves, make the car harder to roll,
   * or make the rescue a moment — and two of them sell height for risk.
   * ================================================================== */
  S({
    id: "marshals-whistle", name: "Marshals' Whistle", rarity: "odd", tags: ["recovery"],
    blurb: "Three blasts brings the orange jackets running.",
    rule: "One more save for the journey: the car is pushed or towed out one more time before the road gives up on you.",
    mods: () => ({ extraSaves: 1 }),
  }),
  S({
    id: "farmers-number", name: "Farmer's Number", rarity: "odd", tags: ["recovery", "journey"],
    blurb: "A phone number on a fence post. He has a tractor and he has seen worse.",
    rule: "The road stops owing you saves after the twentieth waystation. With his number, every fifth stop past it earns one again.",
    mods: () => ({ saveEvery: 5 }),
  }),
  S({
    id: "nine-lives", name: "Nine Lives", rarity: "rare", tags: ["recovery", "durability"],
    blurb: "A tin cat with a chipped ear, glued to the dash. It always lands on its feet.",
    rule: "The first roll of every leg lands on its wheels. After that, the cat is watching.",
    init: () => ({ ready: true }),
    mods: (c, st) => (st.ready ? { landWheels: 1 } : {}),
    on: {
      rollover(c, st) { if (st.ready) { st.ready = false; c.note("Nine Lives"); } },
      legStart(c, st) { st.ready = true; }, waystation(c, st) { st.ready = true; },
    },
  }),
  S({
    id: "low-slung", name: "Low Slung", rarity: "odd", tags: ["recovery", "durability"],
    blurb: "The springs cut a coil. The sump knows every kerb by name.",
    rule: "Much harder to roll (×1.35), and the car barely takes off (lift ×0.85). The ground is where the car lives.",
    mods: () => ({ rollResist: 1.35, lift: 0.85 }),
  }),
  S({
    id: "sandbags", name: "Sandbags", rarity: "common", tags: ["recovery"],
    blurb: "Two in the footwell. The car sits down and stops arguing.",
    rule: "Harder to roll (×1.2). −5% power for the weight.",
    mods: () => ({ rollResist: 1.2, power: 0.95 }),
  }),
  S({
    id: "snorkel", name: "Snorkel", rarity: "rare", tags: ["recovery", "weather"],
    blurb: "A raised intake, taped to the A-pillar. The engine keeps breathing while the doors fill.",
    rule: "Once per leg, a car stopped in deep water wades itself out: no save spent, half the wait.",
    init: () => ({ ready: true }),
    onIncident: (c, st, d) => { if (d.kind === "water" && st.ready) { st.ready = false; return { time: 0.5 }; } return false; },
    on: { legStart(c, st) { st.ready = true; }, waystation(c, st) { st.ready = true; } },
  }),
  S({
    id: "recovery-boards", name: "Recovery Boards", rarity: "odd", tags: ["recovery", "offroad"],
    blurb: "Two orange planks on the roof. Under the wheels, the field gives up.",
    rule: "Once per leg, a car bogged or wedged frees itself: no save spent, a short wait.",
    init: () => ({ ready: true }),
    onIncident: (c, st, d) => { if (d.kind === "stranded" && st.ready) { st.ready = false; return { time: 0.4 }; } return false; },
    on: { legStart(c, st) { st.ready = true; }, waystation(c, st) { st.ready = true; } },
  }),
  S({
    id: "spectators-flask", name: "Spectators' Flask", rarity: "odd", tags: ["recovery", "boost"],
    blurb: "Passed through the window while they push. Nobody asks what is in it.",
    rule: "Every rescue sends you off with +40 boost, +40 flow and 20 s of +15% power. The crowd wants a show.",
    init: () => ({ t: 0 }),
    mods: (c, st) => (st.t > 0 ? { power: 1.15 } : {}),
    on: { rescue(c, st) { st.t = 20; c.boost(40); c.flow(40); c.note("Flask"); } },
    tick(c, st, dt) { if (st.t > 0) st.t -= dt; },
  }),
  S({
    id: "hi-vis-jacket", name: "Hi-Vis Jacket", rarity: "common", tags: ["recovery"],
    blurb: "Everyone can see you. Everyone comes.",
    rule: "Rescues take half as long.",
    mods: () => ({ rescueTime: 0.5 }),
  }),
  S({
    id: "tow-rope", name: "Tow Rope", rarity: "common", tags: ["recovery", "durability"],
    blurb: "Your own. Coiled properly, for once.",
    rule: "Rescues cost the car nothing, and take half as long again.",
    mods: () => ({ rescueCost: 0, rescueTime: 1.5 }),
  }),
  S({
    id: "marshals-wave", name: "The Marshal's Wave", rarity: "fabled", tags: ["recovery", "precision"],
    blurb: "An old marshal at every stop, arm raised. He remembers a clean drive.",
    rule: "Arrive at a waystation with a clean leg (no hit, no incident) and the marshals owe you: +1 save banked, for as long as you keep it clean. No limit.",
    init: () => ({ hits0: 0, inc0: 0 }),
    on: {
      legStart(c, st) { st.hits0 = c.R.hits; st.inc0 = c.R.incidents; },
      waystation(c, st) {
        if (c.R.hits === st.hits0 && c.R.incidents === st.inc0) { c.R.savesBanked = (c.R.savesBanked || 0) + 1; c.note("Marshal's wave: a save banked"); }
        st.hits0 = c.R.hits; st.inc0 = c.R.incidents;
      },
    },
  }),
  S({
    id: "tall-springs", name: "Tall Springs", rarity: "rare", tags: ["jump", "flow"],
    blurb: "Long-travel dampers off a desert truck. The car stands tall, and tips.",
    rule: "Take-offs kick harder (lift ×1.3) and flow builds ×1.15, always. The car rolls much more easily (×0.7).",
    mods: () => ({ lift: 1.3, flowGain: 1.15, rollResist: 0.7 }),
  }),
  S({
    id: "roof-rack", name: "Roof Rack", rarity: "odd", tags: ["pickup", "boost"],
    blurb: "Everything you find goes up top. Up top is the wrong place for it.",
    rule: "Every pickup pays +6 boost. All that weight up high: the car rolls more easily (×0.8).",
    mods: () => ({ rollResist: 0.8 }),
    on: { pickup(c) { c.boost(6); } },
  }),
];

export const PARTS = [
  P({ id: "rally-tyres", name: "Rally Tyres", rule: "+8% grip on every surface.", blurb: "Soft compound, deep blocks.", mods: () => ({ grip: 1.08 }) }),
  P({ id: "big-brakes", name: "Big Brakes", rule: "+14% braking force.", blurb: "Discs the size of dinner plates.", mods: () => ({ brake: 1.14 }) }),
  P({ id: "intake", name: "Cold Intake", rule: "+8% engine power.", blurb: "It breathes.", mods: () => ({ power: 1.08 }) }),
  P({ id: "soft-springs", name: "Soft Springs", rule: "Landings 30% gentler.", blurb: "Long travel, forgiving.", mods: () => ({ landing: 0.7 }) }),
  P({ id: "ballast", name: "Ballast Plate", rule: "+20% stability assist, and a little harder to roll. The car straightens itself sooner.", blurb: "Lead under the passenger seat.", mods: () => ({ stability: 1.2, rollResist: 1.1 }) }),
  P({ id: "slick-body", name: "Slick Body", rule: "−8% aero drag.", blurb: "Every gap taped.", mods: () => ({ drag: 0.92 }) }),
  P({ id: "mud-flaps", name: "Mud Flaps", rule: "−15% off-road drag.", blurb: "The verge is part of the road if you say so.", mods: () => ({ offDrag: 0.85 }) }),
  P({ id: "harness-pads", name: "Harness Pads", rule: "−8% damage from every hit.", blurb: "Thick felt where it counts.", mods: () => ({ damageScale: 0.92 }) }),
];

export function findDef(id) {
  return SOUVENIRS.find((s) => s.id === id) || PARTS.find((p) => p.id === id) || null;
}
