/* Overcrest — the build: souvenirs, parts, and the modifier pipeline.
 *
 * Souvenirs change RULES. They subscribe to typed events (drift, corner,
 * landing, near miss, pickup, collision, leg start, gear change, handbrake,
 * a landmark reached, a border crossed…) and read/write run state through a
 * small context; they contribute modifiers that are folded each tick into
 * two snapshots:
 *
 *   mods    → physics (power, grip, brake, drag, stability, slideCeiling,
 *              boostPower, damageScale, airSteer, landing, offDrag, lift)
 *   runMods → run layer (flowGain, flowDecay, boostDrain, boostGain,
 *              autoBoost, repairMul, hitCap, impactFlowLoss, offers) and
 *              THE DECK (pickup density and kinds, route appetite, the shelf)
 *
 * The engine never learns a souvenir's name. Multiplicative stacking with
 * hard clamps; the bus has a re-entrancy cap; refunds (shields, second
 * winds, hit caps) are applied here by comparing damage before/after the
 * physics step. Souvenirs may also ECHO an event (ask for it to be heard
 * again) and AMPLIFY each other's passives — the two mechanisms that let
 * a build become more than the sum of its cards. Fun exploits stay,
 * crashes do not. DOM-free.
 */

import { DEFAULT_MODS, DT } from "../sim/physics.js";
import { SOUVENIRS, PARTS } from "./souvenirs.js";

export const DEFAULT_RUNMODS = Object.freeze({
  flowGain: 1, flowDecay: 1, boostDrain: 1, boostGain: 1,
  autoBoost: false, repairMul: 1, hitCap: Infinity,
  extraRoutes: 0, extraCards: 0, pickupMagnet: 1, luckBonus: 0,
  cutRate: 1,      // the crew's cooldown between cinematic shots (Clapperboard)
  /* how hard an impact knocks the flow down (1 = the run's own rule) */
  impactFlowLoss: 1,
  /* THE DECK: world-facing mods. The road ahead is GENERATED from these
   * (pickups as a section is laid, routes as they are dealt), so they must
   * be functions of ownership only — never of souvenir state — or a
   * resumed run would regenerate a different road. The bench asserts it.
   * Pickup density and per-kind weights; the route cards' length and
   * appetites (crests, jumps, lakes). */
  pickupDensity: 1, pickupCanister: 1, pickupWrench: 1, pickupGrit: 1, pickupPennant: 1,
  routeLen: 1, routeCrest: 1, routeJump: 1, routeLake: 1,
  /* the shelf: a Full Service always stocked; no common ever offered */
  serviceAlways: false, noCommons: false,
  /* THE THREE ENDS (run.js): saves beyond the earned ones, a reopened
   * earning schedule (every N stops past the last milestone), and how long
   * and how dear a rescue is */
  extraSaves: 0, saveEvery: 0, rescueTime: 1, rescueCost: 1,
});

/* the runMods the WORLD reads while generating ahead of the car */
export const WORLD_MODS = ["pickupDensity", "pickupCanister", "pickupWrench", "pickupGrit", "pickupPennant", "routeLen", "routeCrest", "routeJump", "routeLake"];

/* runMods that are not plain multipliers (flags, caps, counts) */
const NON_MULT = new Set(["autoBoost", "hitCap", "extraRoutes", "extraCards", "luckBonus", "serviceAlways", "noCommons", "extraSaves", "saveEvery"]);
/* mods that ADD rather than multiply */
const ADDITIVE = new Set(["slideCeiling", "airSteer", "landWheels"]);

export const CLAMP = {
  power: [0.5, 2.4], grip: [0.55, 1.7], brake: [0.6, 1.8], drag: [0.35, 1.6],
  stability: [0.3, 1.6], slideCeiling: [0, 0.6], boostPower: [0.5, 2.6],
  damageScale: [0.25, 2.5], airSteer: [0, 3.5], landing: [0.25, 1.5], offDrag: [0.2, 1.5],
  lift: [0.5, 2.0], rollResist: [0.5, 3], landWheels: [0, 1],
};

export function makeBuild(bus, run, car, world) {
  const R = run.R;
  const B = {
    souvenirs: [],        // [{def, state}]
    parts: [],            // [{def}]
    mods: Object.assign({}, DEFAULT_MODS),
    runMods: Object.assign({}, DEFAULT_RUNMODS),
    // event detection state
    drift: { on: false, t: 0, dir: 0, peak: 0, lastEndT: -9, lastDir: 0 },
    noBrakeT: 0, brakeWas: false,
    lastDamage: 0,
    lastCollider: null, nearT: 0,
    lastGear: 1, blowWas: false, hbWas: false,
    eventKey: null, biomeKey: undefined,
    time: 0,
    log: [],              // recent trigger lines for the HUD/debug (bounded)
  };

  /* what a souvenir hook can touch */
  const ctx = {
    car, R, world, bus, B,
    time: () => B.time,
    boost(n) { R.boost = Math.max(0, Math.min(100, R.boost + n * (n > 0 ? B.runMods.boostGain : 1))); },
    flow(n) { R.flow = Math.max(0, Math.min(100, R.flow + n)); },
    repair(n) { run.repair(n * B.runMods.repairMul); },
    damage(n) { car.damage = Math.max(0, car.damage + n); },
    /* the Sweep: push the pursuer back down the road (metres). Nothing
     * happens in the Drive — there is nobody behind you. */
    sweep(m) { if (R.sweepOn) R.sweepS -= m; },
    note(text) { B.log.push({ t: B.time, text }); if (B.log.length > 12) B.log.shift(); },
    /* Conjure a real pickup onto the real road ahead — the combo-spawned
     * pickups of Phase 13. It lands on the centreline of whichever live
     * section owns that stretch; the renderer is told so an already-built
     * section grows the mesh. Deterministic: called from sim-tick hooks.
     * Marked `spawned` so a souvenir that answers pickups with pickups
     * (the Bottle Deposit) cannot chain forever. */
    spawnPickup(kind, ahead) {
      const s = car.s + (ahead || 150);
      for (const sec of world.sections || []) {
        if (s < sec.s0 || s > sec.s1 || !sec.pickups) continue;
        const q = world.sampleNear(s);
        if (!q) return false;
        const p = { kind, x: q.x, y: q.y + 0.85, z: q.z, s, side: 0, taken: false, spawned: true, sectionIndex: sec.index };
        sec.pickups.push(p);
        if (world.onPickupSpawned) world.onPickupSpawned(p, sec);
        return true;
      }
      return false;
    },
  };

  function fold() {
    const m = Object.assign({}, DEFAULT_MODS);
    const rm = Object.assign({}, DEFAULT_RUNMODS);
    /* AMPLIFIERS (the Rosetta Stone): every OTHER souvenir's passive
     * numbers are pushed further from stock — a multiplier's distance
     * from 1 grows, an additive grows outright. Never below zero. */
    let amp = 1;
    for (const sv of B.souvenirs) if (sv.def.amp) amp *= sv.def.amp;
    const apply = (def, state, a) => {
      if (!def.mods) return;
      const part = def.mods(ctx, state) || {};
      for (const k in part) {
        let v = part[k];
        if (a !== 1 && typeof v === "number") {
          if (ADDITIVE.has(k)) v *= a;
          else if (k in m || (k in rm && !NON_MULT.has(k))) v = v >= 1 ? 1 + (v - 1) * a : Math.max(0, 1 - (1 - v) * a);
        }
        if (k in m) {
          if (ADDITIVE.has(k)) m[k] += v;
          else m[k] *= v;
        } else if (k in rm) {
          if (typeof rm[k] === "boolean") rm[k] = rm[k] || !!v;
          else if (k === "hitCap") rm[k] = Math.min(rm[k], v);
          else if (k === "extraRoutes" || k === "extraCards" || k === "luckBonus" || k === "extraSaves") rm[k] += v;
          else if (k === "saveEvery") rm[k] = rm[k] > 0 ? Math.min(rm[k], v) : v;
          else rm[k] *= v;
        }
      }
    };
    for (const p of B.parts) apply(p.def, p, 1);
    for (const sv of B.souvenirs) apply(sv.def, sv.state, sv.def.amp ? 1 : amp);
    if (R.gritT > 0) m.grip *= 1.15;                 // traction compound (pickup)
    for (const k in CLAMP) m[k] = Math.max(CLAMP[k][0], Math.min(CLAMP[k][1], m[k]));
    B.mods = m;
    B.runMods = rm;
    /* the deck, handed to the world: every pickup placed from here on reads
     * it (one object, mutated in place — this runs at 120 Hz) */
    if (world) {
      const pm = world.pickupMods || (world.pickupMods = { density: 1, w: { canister: 1, wrench: 1, grit: 1, pennant: 1 } });
      pm.density = rm.pickupDensity;
      pm.w.canister = rm.pickupCanister; pm.w.wrench = rm.pickupWrench;
      pm.w.grit = rm.pickupGrit; pm.w.pennant = rm.pickupPennant;
    }
  }
  fold();

  function emit(name, data) {
    data = data || {};
    for (const sv of B.souvenirs) {
      const h = sv.def.on && sv.def.on[name];
      if (h) {
        h(ctx, sv.state, data);
        // the build panel's "what has actually been firing" (driftTick is
        // a 120 Hz stream, not an occasion)
        if (name !== "driftTick") sv.fires = (sv.fires || 0) + 1;
      }
    }
    /* ECHOES: a souvenir may ask for an event to be heard again — by
     * every souvenir (return true) or by one of them (return its entry).
     * One level only: an echo is never itself echoed, an echoing souvenir
     * never hears its own echo, and the 120 Hz stream is not an occasion.
     * Hooks see `echo: true` on the second hearing and may decline it. */
    if (name !== "driftTick" && !data.echo) {
      for (const sv of B.souvenirs) {
        if (!sv.def.echo) continue;
        const r = sv.def.echo(ctx, sv.state, name, data);
        if (!r) continue;
        sv.fires = (sv.fires || 0) + 1;
        ctx.note(sv.def.name + " echoes");
        const d2 = Object.assign({}, data, { echo: true });
        if (r === true) {
          for (const t of B.souvenirs) {
            if (t === sv) continue;
            const h = t.def.on && t.def.on[name];
            if (h) { h(ctx, t.state, d2); t.fires = (t.fires || 0) + 1; }
          }
        } else if (r !== sv) {
          const h = r.def.on && r.def.on[name];
          if (h) { h(ctx, r.state, d2); r.fires = (r.fires || 0) + 1; }
        }
      }
    }
    bus.emit(name, data);
  }

  function add(def) {
    if (def.kind === "part") {
      B.parts.push({ def });
    } else {
      const state = def.init ? def.init(ctx) : {};
      B.souvenirs.push({ def, state });
      if (def.onEquip) def.onEquip(ctx, state);
    }
    fold();
  }
  function has(id) { return B.souvenirs.some((s) => s.def.id === id) || B.parts.some((p) => p.def.id === id); }
  function ids() { return B.souvenirs.map((s) => s.def.id).concat(B.parts.map((p) => p.def.id)); }

  /* Called once per sim tick AFTER physics.step with its event flags. */
  function tick(ev, input) {
    B.time += DT;
    const v = Math.abs(car.vx);
    const onRoad = car.zone === "road" || car.zone === "shoulder";

    // ---- damage refunds: compare with the damage before this step
    const delta = car.damage - B.lastDamage;
    if (delta > 0.01) {
      let allowed = delta;
      // a pennant shield eats the whole hit
      if (R.shield && !ev.landImpact) { R.shield = false; allowed = 0; ctx.note("Shield!"); }
      // hooks may cancel or cap the hit
      for (const sv of B.souvenirs) {
        const h = sv.def.onDamage;
        if (h) allowed = h(ctx, sv.state, { delta: allowed, impact: ev.impact, landing: !!ev.landImpact });
      }
      allowed = Math.min(allowed, B.runMods.hitCap);
      car.damage = B.lastDamage + Math.max(0, allowed);
    }
    B.lastDamage = car.damage;

    // ---- drift detection
    const D = B.drift;
    const sliding = onRoad && v > 10 && Math.abs(car.beta) > 0.27;
    if (!D.on && sliding) {
      D.on = true; D.t = 0; D.dir = Math.sign(car.beta); D.peak = 0;
      const gap = B.time - D.lastEndT;
      emit("driftStart", { dir: D.dir });
      if (gap < 1.3 && D.lastDir !== 0 && D.lastDir !== D.dir) emit("driftSwitch", { gap });
    } else if (D.on) {
      D.t += DT;
      D.peak = Math.max(D.peak, Math.abs(car.beta));
      if (Math.abs(car.beta) < 0.11 || !onRoad || v < 6) {
        D.on = false; D.lastEndT = B.time; D.lastDir = D.dir;
        emit("driftEnd", { duration: D.t, peak: D.peak, dir: D.dir, clean: onRoad });
      }
    }
    if (D.on) emit("driftTick", { dt: DT, dir: D.dir });

    // ---- brake streak
    const braking = input && input.brake > 0.2;
    if (braking) {
      if (!B.brakeWas && B.noBrakeT > 0.5) emit("brakeAfter", { seconds: B.noBrakeT });
      B.noBrakeT = 0;
    } else if (v > 8) B.noBrakeT += DT;
    B.brakeWas = braking;

    // ---- drivetrain occasions: a shift, the turbo's sigh, a handbrake pull
    if (ev.gearChange) emit("gearChange", { gear: ev.gearChange, up: ev.gearChange > B.lastGear });
    B.lastGear = car.gear;
    if (ev.blowOff && !B.blowWas) emit("blowOff", {});
    B.blowWas = !!ev.blowOff;
    const hb = !!(input && input.handbrake);
    if (hb && !B.hbWas && v > 8) emit("handbrake", { speed: v });
    B.hbWas = hb;

    // ---- air
    if (ev.tookOff) emit("tookOff", {});
    if (ev.landed) emit("landed", { air: ev.air || 0, impact: ev.landed, clean: ev.landed < 5.5 && Math.abs(car.beta) < 0.2 });

    // ---- collision
    if (ev.impact > 2 && !ev.landImpact) emit("collision", { impact: ev.impact, collider: ev.collider || null });
    // ---- the three ends' occasions: the car goes over; the car settles
    if (ev.rolled) emit("rollover", {});
    if (ev.settled) emit("settled", { roof: ev.settled === "roof" });

    // ---- near miss: a collider passes within a wheel's width at speed
    if (v > 16 && onRoad) {
      const cx = Math.floor(car.x / 8), cz = Math.floor(car.z / 8);
      let best = null, bestD = 99;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const arr = world.colliderHash.get((cx + dx) + "," + (cz + dz));
        if (!arr) continue;
        for (const c of arr) {
          const d = Math.hypot(c.x - car.x, c.z - car.z) - c.r - 0.85;
          if (d < bestD) { bestD = d; best = c; }
        }
      }
      if (best && bestD < 0.9 && best !== B.lastCollider) {
        B.lastCollider = best;
        emit("nearMiss", { dist: bestD });
      }
    }

    // ---- corner completion (notes carry their own bookkeeping)
    for (let i = 0; i < world.notes.length; i++) {
      const n = world.notes[i];
      if (n.kind !== "corner") continue;
      if (n.s > car.s + 5) break;
      if (!n.entered && car.s >= n.s) { n.entered = true; n.dirty = false; n.driftT = 0; }
      if (n.entered && !n.done) {
        if (ev.impact > 2 || car.zone === "off") n.dirty = true;
        if (D.on) n.driftT += DT;
        if (car.s > n.endS + 6) {
          n.done = true;
          emit("cornerDone", { grade: n.grade, dir: n.dir, clean: !n.dirty, drifted: n.driftT > 0.4 });
        }
      }
    }

    // ---- places: reaching a landmark's stretch; crossing a border
    if (world.eventAt) {
      const e = world.eventAt(car.s);
      const key = e ? e.key : null;
      if (key && key !== B.eventKey) emit("eventEnter", { key, name: e.name || key });
      B.eventKey = key;
    }
    const hbm = world.hereBiome;
    const bk = hbm && hbm.biome ? hbm.biome.key : (world.biome ? world.biome.key : null);
    if (B.biomeKey === undefined) B.biomeKey = bk;
    else if (bk && bk !== B.biomeKey) { emit("border", { from: B.biomeKey, to: bk }); B.biomeKey = bk; }

    // ---- per-tick souvenir hooks + refold (cheap; state-driven mods)
    for (const sv of B.souvenirs) if (sv.def.tick) sv.def.tick(ctx, sv.state, DT);
    fold();
  }

  /* An INCIDENT (run.js: a roof, deep water, a fall, a stranding) asks the
   * build first: a souvenir with `onIncident(ctx, state, {kind})` may answer
   * it — return true (or {time}) to pay for the rescue itself: no push or
   * tow is spent, and `time` scales how long it takes. First answer wins. */
  function incident(kind) {
    for (const sv of B.souvenirs) {
      const h = sv.def.onIncident;
      if (!h) continue;
      const r = h(ctx, sv.state, { kind });
      if (r) { sv.fires = (sv.fires || 0) + 1; ctx.note(sv.def.name + " answers"); return r === true ? {} : r; }
    }
    return null;
  }

  return { B, ctx, add, has, ids, tick, emit, fold, incident, get mods() { return B.mods; }, get runMods() { return B.runMods; } };
}

/* ------------------------------------------------------------- offers */

/* Common → Odd → Rare → Exotic → Fabled: higher rarity means STRANGER
 * RULES (a mechanic, a trade, a risk), never "the same thing but +8%".
 *
 * These are the SHARE of a shelf slot each rarity gets, whatever the
 * catalog holds. The old table was a weight PER CARD, and the catalog has
 * 27 commons against 60 odds and 47 rares — so a "rare" card was on more
 * than one shelf in three and commons were the minority (owner: "I see so
 * many rare cards and really shouldn't"). Shares are divided by how many
 * cards of that rarity are still in the pool, so rare means rare no matter
 * how many rares get written. */
/* (Second tightening, owner: "the rarity issue persists, I get an exotic
 * like every other waystation". Measured before the change: an exotic or
 * fabled card on ~7.5% of shelves — one in 13. Two real causes: the top
 * tiers rode the full luck lean, and the exotic stamp wore almost the same
 * teal as the odd stamp, so most shelves LOOKED exotic. The shares below
 * halve the top tiers, offerCards halves luck's lean on them, and the
 * stamp inks are now four different colours.) */
const RARITY_SHARE = { common: 0.62, odd: 0.27, rare: 0.085, exotic: 0.011, fabled: 0.003 };

/* Deterministic card offer at a waystation: mostly souvenirs, some parts,
 * a service when the car needs one. `luck` nudges rarity (harder routes).
 * `stats` is what the journey has DONE so far ({dist, nightDist, rainDist,
 * coldDist, climb, countries…}): a souvenir may declare `appearIf(stats)`
 * and it will never be offered before the run has earned it. Nothing
 * advertises the gate — "even after many hours there should be things the
 * player has not seen", and a shelf that changes with the journey is that,
 * quietly. `mode` is "drive" or "sweep": a souvenir with `modeOnly` is
 * stocked in that contract alone. `opts` carries the build's shelf rules
 * ({serviceAlways, noCommons}). */
export function offerCards(rng, owned, count, luck, condition, stats, mode, opts) {
  const cards = [];
  const o = opts || {};
  const pool = SOUVENIRS.filter((s) => !owned.includes(s.id)
    && (!s.appearIf || (stats && s.appearIf(stats)))
    && (!s.modeOnly || s.modeOnly === mode)
    && !(o.noCommons && s.rarity === "common"));
  const parts = PARTS.filter((p) => !owned.includes(p.id));
  const wants = Math.max(1, count);
  let serviceAdded = false;
  const wantService = condition < 55 || !!o.serviceAlways;
  for (let i = 0; i < wants && (pool.length || parts.length); i++) {
    const roll = rng();
    if (!serviceAdded && wantService && (roll < 0.35 || i === wants - 1)) {
      cards.push({ kind: "service", id: "service", name: "Full service", rarity: "common",
        rule: "Condition restored to full.", blurb: "An hour on the ramps and a strong coffee." });
      serviceAdded = true;
      continue;
    }
    if (parts.length && roll > 0.72) {
      const at = Math.floor(rng() * parts.length);
      cards.push(parts.splice(at, 1)[0]);
      continue;
    }
    if (!pool.length) { if (parts.length) { cards.push(parts.splice(0, 1)[0]); } continue; }
    // rarity-weighted pick from the remaining souvenirs. One catalog, two
    // metas (Addendum I): boost-economy cards shine in the Sweep, so its
    // shelf leans toward them — the Drive's shelf is untouched (boost is
    // the Push there, not dead weight). Nothing is ever exclusive.
    let total = 0;
    const nBy = {};
    for (const s of pool) nBy[s.rarity] = (nBy[s.rarity] || 0) + 1;
    const ws = pool.map((s) => {
      // luck leans the shelf toward the strange (harder routes, the odd
      // outpost, a long journey) — but only half as hard at the top: an
      // exotic is an event, not a lucky Tuesday
      const lean = s.rarity === "common" ? 1 : (s.rarity === "exotic" || s.rarity === "fabled") ? 1 + luck * 0.5 : 1 + luck;
      let w = ((RARITY_SHARE[s.rarity] || 0.05) / nBy[s.rarity]) * lean;
      if (mode === "sweep" && (s.tags || []).includes("boost")) w *= 1.5;
      total += w; return w;
    });
    let x = rng() * total, at = pool.length - 1;
    for (let k = 0; k < pool.length; k++) { x -= ws[k]; if (x <= 0) { at = k; break; } }
    cards.push(pool.splice(at, 1)[0]);
  }
  return cards;
}
