/* Overcrest — celestial & weather rarities.
 *
 * "Even after many hours there should be things the player has not seen."
 * These are the sky's share of that: a meteor shower on a clear night, a
 * storm flickering on the horizon, a double rainbow when the rain lets
 * go, the fog dropping below a high road until the valley is a white sea,
 * and — very rarely, and it goes dark — an eclipse.
 *
 * Three rules, inherited from the special events and the bible:
 *
 *   They are CONDITIONS, not decorations. A rainbow happens because the
 *   rain cleared while the sun was low, never because a timer fired. If
 *   the sky does not deliver the conditions, the event never happened —
 *   no call, no postcard, no cooldown.
 *
 *   None of it is advertised. No banner, no UI. The codriver noticing is
 *   the entire announcement; the postcard is the record.
 *
 *   Distance earns strangeness. The rarity ladder's minimum run distance
 *   applies here too — an eclipse belongs deep in a long journey.
 *
 * Deterministic per (seed, opportunity): each event's chance is rolled on
 * a hashed EPOCH (a distance bucket, or the day index for the eclipse),
 * so the roll is stable while the car is inside the window and the same
 * journey sees the same sky. Ticked in SIM time — a sky event is a fact
 * about the journey, like a postcard, and must survive ?ff. DOM-free.
 */

import { rng, hashCombine } from "../core/rng.js";
import { RARITY } from "./events.js";

export const SKY_GAP = 5200;    // metres of ordinary sky between events

/* ctx for ready(): { snap, fogField, rise, aurora }
 *   snap      atmosphere snapshot (sky, sun, overcast, rain, fog, wetness)
 *   fogField  the fog TARGET at the car (what the front says, unsmoothed)
 *   rise      how far the car stands above the lowest road nearby (m)
 *   aurora    1 when the country under the car declares aurora skies       */
export const SKY_EVENTS = [
  {
    key: "meteors",
    name: "A Meteor Shower",
    rarity: "rare",
    line: "clear night. meteors. watch the sky on the straights",
    dur: [110, 160],
    epochM: 2600, chance: 0.42,
    ready: (c) => c.snap.sky.stars > 0.55 && c.snap.overcast < 0.35 && c.snap.fog < 0.3,
  },
  {
    /* Ahead of lightning on purpose: order is priority when two events
     * both roll true, and the aurora is gated on GEOGRAPHY — it cannot
     * leak into countries that do not declare it, so giving it the first
     * claim on a clear Kaldbrekka night costs the others nothing. */
    key: "aurora",
    name: "The Northern Lights",
    rarity: "rare",
    line: "the sky is dancing. no hurry tonight",
    dur: [150, 220],
    epochM: 2400, chance: 0.7,
    sustained: true,
    /* Kaldbrekka's nights (the biome declares `aurora`), under a sky that
     * can show it — it shines through thin cloud, dies under a shut one.
     * Rare globally because the country must be REACHED and it must be
     * night: the gate is geography, the bible's favourite kind. */
    ready: (c) => c.aurora > 0.5 && c.snap.sky.stars > 0.45 && c.snap.overcast < 0.55 && c.snap.fog < 0.45,
  },
  {
    key: "lightning",
    name: "Distant Lightning",
    rarity: "rare",
    /* line is built at start — it says which side the storm is on */
    dur: [110, 150],
    epochM: 2600, chance: 0.5,
    ready: (c) => c.snap.overcast > 0.55 && c.snap.fog < 0.5,
  },
  {
    key: "rainbow",
    name: "A Double Rainbow",
    rarity: "rare",
    line: "look at that. two of them",
    dur: [120, 170],
    epochM: 1800, chance: 0.55,
    sustained: true,     // lives only while the conditions do
    ready: (c) => c.snap.wetness > 0.28 && c.snap.rain < 0.12 && c.snap.overcast < 0.55
      && c.snap.fog < 0.4 && c.snap.sun.elev > 0.05 && c.snap.sun.elev < 0.52,
  },
  {
    key: "inversion",
    name: "Above the Clouds",
    rarity: "veryRare",
    line: "we are above the clouds",
    dur: [90, 150],
    epochM: 2200, chance: 0.55,
    sustained: true,
    /* The fog front is HERE, but the road is standing above it: render
     * fog is suppressed and the valley below becomes a white sea. Ending
     * is the descent — you drive down INTO the weather you were over. */
    ready: (c) => c.fogField > 0.5 && c.rise > 13 && c.snap.rain < 0.15,
  },
  {
    key: "eclipse",
    name: "The Eclipse",
    rarity: "veryRare",
    line: "the light is going. eclipse. it will pass",
    eclipse: true,       // scheduled on the day clock, not on distance
  },
];

export const SKY_BY_KEY = Object.fromEntries(SKY_EVENTS.map((e) => [e.key, e]));

/* the horizon flash of a distant strike: sharp up, a stutter, then the
 * long lingering wash sheet lightning really has */
function flashShape(t) {
  if (t < 0) return 0;
  if (t < 0.06) return t / 0.06;
  if (t < 0.13) return 1 - ((t - 0.06) / 0.07) * 0.75;
  if (t < 0.19) return 0.25 + ((t - 0.13) / 0.06) * 0.55;
  if (t < 1.3) return 0.8 * Math.exp(-(t - 0.19) * 3.2);
  return 0;
}

/* Flashes are a pure function of the event's sim clock, like the meteor
 * windows: a fast-forwarded run lands mid-storm with the storm mid-flash,
 * exactly as it would have been live. */
const FL_CAD = 3.0;
const h01c = (n) => { let v = Math.imul(n ^ 0x9e37, 0x85ebca6b); v = Math.imul(v ^ (v >>> 13), 0xc2b2ae35); v ^= v >>> 16; return (v >>> 0) / 4294967296; };
const flashSkipped = (k) => h01c(k * 13 + 7) < 0.25;
function flashAt(t) {
  const k = Math.floor(t / FL_CAD);
  if (flashSkipped(k)) return 0;
  const jit = h01c(k * 3 + 1) * 1.4;
  const pow = 0.55 + h01c(k * 7 + 2) * 0.45;
  return flashShape(t - k * FL_CAD - jit) * pow;
}

const ECL_W = 0.017;    // eclipse half-width in day fraction (~1 min of sim)

export function makeCelestial(seed, opts) {
  opts = opts || {};
  const C = {
    active: null,        // def, until the fade-out completes
    ph: 0, t: 0, dur: 0, ending: false, noted: false, forced: false,
    lastEndS: -1e9, seenKeys: [],
    day: 0, prevU: null, eclU: -1,
    az: 0, flash: 0, lastFlashK: -1, rnd: null,
    cloudY: 0, e: 0,
    checkT: 0, recheckT: 0,
    started: [], seen: [], thunder: [],
  };

  /* Does the country under the car declare aurora skies? Read at the same
   * blend threshold the rest of the game uses — half-way in, you are there. */
  function auroraHere(world) {
    const hb = world.hereBiome;
    if (!hb) return 0;
    return (hb.t >= 0.5 ? hb.biome : hb.prev).aurora ? 1 : 0;
  }

  function riseAbove(world, car) {
    let minY = Infinity;
    for (let ds = -240; ds <= 720; ds += 80) {
      const p = world.sampleNear(car.s + ds);
      if (p && p.y < minY) minY = p.y;
    }
    return Number.isFinite(minY) ? { rise: car.y - minY, minY } : { rise: 0, minY: car.y };
  }

  function start(def, car, world, snap) {
    C.active = def;
    C.t = 0; C.ph = 0; C.ending = false; C.noted = false;
    C.rnd = rng(hashCombine(seed, 0x51f1 + Math.floor(car.s)));
    C.dur = def.dur ? def.dur[0] + C.rnd() * (def.dur[1] - def.dur[0]) : 1e9;
    let line = def.line;
    if (def.key === "lightning") {
      const left = C.rnd() < 0.5;
      C.az = car.yaw + (left ? -1 : 1) * (0.5 + C.rnd() * 0.4);
      line = `storm off to the ${left ? "left" : "right"}. watch the light`;
      C.lastFlashK = -1;
    }
    if (def.key === "inversion") {
      const p = riseAbove(world, car);
      C.cloudY = C.forced && p.rise < 13 ? car.y - 16 : p.minY + 8;
    }
    /* Seated roughly ahead of the car — the meteor lesson: a sky event
     * that performs only behind the driver is one nobody sees. The road
     * turns; the lights will wander the sky on their own. */
    if (def.key === "aurora") C.az = car.yaw + (C.rnd() - 0.5) * 1.6;
    if (def.eclipse) C.e = 0;
    C.seenKeys.push(def.key);
    C.started.push({ def, line });
  }

  function close(car) {
    C.active = null;
    C.ph = 0; C.e = 0; C.flash = 0;
    C.lastEndS = car.s;
  }

  function maybeStart(car, world, snap, atmoA) {
    if (C.forcedDone) return;
    if (opts.force) {
      const def = SKY_BY_KEY[opts.force];
      if (def) { C.forced = true; C.forcedDone = true; start(def, car, world, snap); }
      return;
    }
    if (car.s - C.lastEndS < SKY_GAP) return;
    for (const def of SKY_EVENTS) {
      const tier = RARITY[def.rarity];
      if (car.s < tier.minRunS) continue;
      if (def.eclipse) {
        /* Some days carry an eclipse; the roll and its hour are facts
         * about (seed, day). It happens whether or not you are watching —
         * the run has to be deep enough and the sun has to be up. */
        const er = rng(hashCombine(seed, 0xec11 + C.day));
        if (er() >= 0.35) continue;
        const uE = 0.4 + er() * 0.24;
        if (snap.u < uE - ECL_W || snap.u > uE + ECL_W * 0.5) continue;
        if (snap.sun.elev < 0.22) continue;
        C.eclU = uE;
        start(def, car, world, snap);
        return;
      }
      const epoch = Math.floor(car.s / def.epochM);
      const roll = rng(hashCombine(seed, hashCombine(def.key.length * 0x9e37 + def.key.charCodeAt(0), 0x5c1 + epoch)))();
      const chance = def.chance * (C.seenKeys.includes(def.key) ? 0.25 : 1);
      if (roll >= chance) continue;
      const ctx = { snap, fogField: atmoA ? atmoA.tFog : snap.fog, rise: 0, aurora: auroraHere(world) };
      if (def.key === "inversion") {
        if (ctx.fogField <= 0.5) continue;                 // cheap gate before probing
        ctx.rise = riseAbove(world, car).rise;
      }
      if (!def.ready(ctx)) continue;
      start(def, car, world, snap);
      return;
    }
  }

  function stepActive(dt, car, world, snap, atmoA) {
    const def = C.active;
    C.t += dt;

    if (def.eclipse) {
      if (C.forced) { C.e = 1; C.ph = 1; }
      else {
        const d = Math.abs(snap.u - C.eclU);
        const x = Math.max(0, 1 - d / ECL_W);
        C.e = x * x * (3 - 2 * x);
        C.ph = C.e;
        if (snap.u > C.eclU + ECL_W) return close(car);
      }
      if (!C.noted && C.e > 0.7) { C.noted = true; C.seen.push({ def }); }
      return;
    }

    // sustained events die with their conditions; all of them time out
    if (!C.ending && !C.forced) {
      if (C.t > C.dur) C.ending = true;
      else if (def.sustained) {
        C.recheckT -= dt;
        if (C.recheckT <= 0) {
          C.recheckT = 0.5;
          const ctx = { snap, fogField: atmoA ? atmoA.tFog : snap.fog, rise: 0, aurora: auroraHere(world) };
          if (def.key === "inversion") {
            const p = riseAbove(world, car);
            ctx.rise = p.rise;
            // the sea drifts with the valley floor, never in a hurry
            C.cloudY += (p.minY + 8 - C.cloudY) * 0.12;
          }
          if (!def.ready(ctx)) C.ending = true;
        }
      }
    }
    // a forced sea follows the car so it is visible wherever you park it
    if (C.forced && def.key === "inversion") C.cloudY += (car.y - 14 - C.cloudY) * (1 - Math.exp(-dt / 6));
    const target = C.ending ? 0 : 1;
    C.ph += (target - C.ph) * (1 - Math.exp(-dt / (C.ending ? 6 : 4)));
    if (C.ending && C.ph < 0.02) return close(car);

    if (def.key === "lightning") {
      C.flash = flashAt(C.t) * C.ph;
      const k = Math.floor(C.t / FL_CAD);
      if (k !== C.lastFlashK) {
        C.lastFlashK = k;
        if (!flashSkipped(k) && !C.ending)
          C.thunder.push({ delay: 2.5 + h01c(k * 11 + 4) * 5, power: 0.35 + h01c(k * 5 + 2) * 0.6 });
      }
    }
    if (!C.noted && C.t > (C.forced ? 6 : Math.min(30, C.dur / 3))) {
      C.noted = true;
      C.seen.push({ def });
    }
  }

  /* ---- per sim tick. Returns what happened so the caller can announce
   * (once) and record (once); consuming the arrays is the contract. */
  function tick(dt, car, world, snap, atmoA) {
    if (C.prevU != null && snap.u < C.prevU - 0.5) C.day++;
    C.prevU = snap.u;
    if (C.active) {
      stepActive(dt, car, world, snap, atmoA);
    } else {
      C.checkT -= dt;
      if (C.checkT <= 0) { C.checkT = 0.5; maybeStart(car, world, snap, atmoA); }
    }
    return { started: C.started.splice(0), seen: C.seen.splice(0), thunder: C.thunder.splice(0) };
  }

  /* ---- fold the active event into an atmosphere snapshot. The renderer
   * and the postcard book both read the WORLD AS EXPERIENCED — above an
   * inversion you are not "in fog", whatever the front says. */
  function apply(snap) {
    if (!C.active || C.ph <= 0.001) return snap;
    const k = C.active.key;
    if (k === "meteors") { snap.meteors = C.ph; snap.meteorT = C.t; }
    else if (k === "aurora") { snap.aurora = C.ph; snap.auroraT = C.t; snap.auroraAz = C.az; }
    else if (k === "lightning") { snap.lightning = C.flash; snap.lightningAz = C.az; }
    else if (k === "rainbow") snap.rainbow = C.ph;
    else if (k === "inversion") {
      snap.cloudSea = C.ph;
      snap.cloudSeaY = C.cloudY;
      snap.fog *= 1 - 0.88 * C.ph;
    } else if (k === "eclipse") {
      snap.eclipse = C.e;
      snap.night = Math.max(snap.night, C.e * 0.72);
    }
    return snap;
  }

  function state() {
    if (!C.active) return "quiet";
    return `${C.active.key} ph ${C.ph.toFixed(2)} t ${C.t.toFixed(0)}/${C.dur > 1e8 ? "∞" : C.dur.toFixed(0)}`;
  }

  return { C, tick, apply, state };
}
