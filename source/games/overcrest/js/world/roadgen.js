/* Overcrest — the road generator.
 *
 * Roads are written as language before they are geometry: a mood machine
 * (calm / flow / tech / fast — the breathing of a journey) picks phrases,
 * phrases emit ops (straights and corners with intent), and the compiler
 * turns ops into centreline samples with clothoid-eased curvature, camber,
 * width, surface and an analytic elevation model.
 *
 * Corners use GEAR GRADES: a corner's number is the gear the Kestrel takes
 * it in — "3 right" is a third-gear right. Target speeds come from the
 * car's own gearbox; radii derive from target speed and surface grip, so
 * the same call is the same promise on any surface. Above 6th = "flat",
 * below 1st = "hairpin".
 *
 * Elevation = macro sine stack (biome character, run-seeded phases)
 *           + per-section trend (integrated, smoothly blended)
 *           + local features (crests, jump ramps, dips)
 * — continuous by construction across section boundaries, with a safety
 * clamp and a decaying bias so repairs can never leave a step.
 *
 * Deterministic: every section derives from (runSeed, sectionIndex,
 * attempt). DOM-free.
 */

import { rng, hashCombine } from "../core/rng.js";
import { KESTREL, VCAP, G } from "../sim/physics.js";
import { surfaceParams } from "../sim/surfaces.js";

export const DS = 2.5;                  // metres between centreline samples

/* flags bits per sample */
export const F_LAKE_L = 2;
export const F_LAKE_R = 4;
export const F_WAY = 8;                 // waystation apron (pull-off on the right)
/* crossings — set by the world, not the generator: they are a fact about
 * the landscape the road was laid across (see world/spans.js) */
export const F_BRIDGE = 16;
export const F_TUNNEL = 32;
export const F_SPAN = F_BRIDGE | F_TUNNEL;

/* Waystation section layout, metres */
export const WS_APPROACH = 60, WS_APRON = 110, WS_DEPART = 240;

/* ------------------------------------------------------------ gear grades */

const WHEEL_RPS = (KESTREL.redline / 60) * 2 * Math.PI * KESTREL.wheelR; // m/s of wheel at limiter, pre-gearing

/* Speed the car runs in gear g near the top of the band (the note promise). */
export function gradeTarget(grade) {
  if (grade === "hp") return 8.5;
  if (grade === "flat") return VCAP;
  const ratio = KESTREL.gears[grade - 1] * KESTREL.finalDrive;
  return (WHEEL_RPS / ratio) * 0.78;
}

const GRADE_ANGLE = {
  hp: [2.6, 3.2],
  1: [1.3, 1.8],
  2: [0.95, 1.55],
  3: [0.7, 1.2],
  4: [0.5, 0.95],
  5: [0.35, 0.7],
  6: [0.2, 0.45],
  flat: [0.14, 0.35],
};

/* Radius that makes `grade` an honest promise on this surface. Flat corners
 * are sized for a car ARRIVING at the cap and staying on the power, with a
 * margin for the grip the engine is spending. */
export function radiusFor(grade, surfKey, halfWidth) {
  const mu = surfaceParams(surfKey, 0).grip * 0.88 * G;
  const v = gradeTarget(grade);
  const margin = grade === "flat" ? 1.3 : grade === 6 ? 1.12 : 1.0;
  const R = (v * v * margin) / mu;
  return Math.max(halfWidth + 9, R);
}

/* --------------------------------------------------------------- phrases */

function wrapPi(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/* Direction choice: the journey has a wandering bearing it loosely follows,
 * which keeps the road going *somewhere* and starves self-intersections. */
function pickDir(gen, r) {
  const err = wrapPi(gen.bearing - gen.heading);
  if (Math.abs(err) > 1.25 && r.chance(0.85)) return err > 0 ? 1 : -1;
  const n = gen.lastDirs.length;
  if (n >= 2 && gen.lastDirs[n - 1] === gen.lastDirs[n - 2] && r.chance(0.75)) {
    return -gen.lastDirs[n - 1];
  }
  return r.chance(0.5 + Math.sign(err) * 0.1) ? 1 : -1;
}

export function corner(gen, r, biome, grade, opts) {
  opts = opts || {};
  const dir = opts.dir != null ? opts.dir : pickDir(gen, r);
  const band = GRADE_ANGLE[grade];
  /* floored at the drivable radius the ladder proves (11 m): a tarmac
   * hairpin's sized radius times the 0.92 roll can dip to 10.8, which the
   * escape path found first — the call is identical, the arc a hair kinder */
  const radius = Math.max(11.2, radiusFor(grade, biome.surf, biome.halfWidth) * r.range(0.92, 1.14));
  const op = {
    t: "crn", dir, grade, radius,
    angle: r.range(band[0], band[1]),
    camber: 0, mods: {}, feat: opts.feat || null, flags: opts.flags || 0,
  };
  if (typeof grade === "number") {
    const roll = r();
    if (roll < 0.13 && grade >= 2) {
      op.mods.tightens = grade - (grade >= 4 && r.chance(0.35) ? 2 : 1);
      op.mods.tightensR = radiusFor(op.mods.tightens, biome.surf, biome.halfWidth);
    } else if (roll < 0.22 && grade <= 5) {
      op.mods.opens = grade + 1;
      op.mods.opensR = radiusFor(op.mods.opens, biome.surf, biome.halfWidth);
    } else if (roll < 0.32) {
      op.mods.long = true;
      op.angle *= r.range(1.3, 1.55);
    }
    if (grade <= 3 && r.chance(0.3)) op.mods.dontcut = true;
    if (r.chance(biome.offCamberP)) { op.camber = -r.range(0.03, 0.055); op.mods.offcamber = true; }
    else if (r.chance(biome.camberP)) op.camber = r.range(0.02, 0.05);
  } else if (grade === "hp" && r.chance(0.3)) {
    op.mods.dontcut = true;
  }
  gen.lastDirs.push(dir);
  if (gen.lastDirs.length > 4) gen.lastDirs.shift();
  return op;
}

export function str(len, feat, flags) {
  return { t: "str", len, feat: feat || null, flags: flags || 0 };
}

/* Feature helpers: feat = {kind, at (fraction of the op)} */
const PHRASES = {
  cruiseRun(gen, r, b) {
    const ops = [str(r.range(120, 240), r.chance(b.crestLove * 0.4) ? { kind: "crest", at: r.range(0.35, 0.7) } : null)];
    if (r.chance(0.6)) ops.push(corner(gen, r, b, r.chance(0.5) ? "flat" : 6));
    return ops;
  },

  kink(gen, r, b) {
    return [str(r.range(50, 110)), corner(gen, r, b, r.chance(0.4) ? "flat" : 6)];
  },

  sweepChain(gen, r, b) {
    const ops = [];
    const n = r.int(2, 4);
    let d = pickDir(gen, r);
    for (let i = 0; i < n; i++) {
      const g = r.pick([5, 5, 6, 6, "flat"]);
      const feat = r.chance(b.crestLove * 0.25) ? { kind: "crest", at: 0 } : null;
      ops.push(corner(gen, r, b, g, { dir: d, feat }));
      if (i < n - 1) ops.push(str(r.range(30, 72)));
      d = -d;
    }
    return ops;
  },

  rhythmSet(gen, r, b) {
    const ops = [];
    const n = r.int(3, 5);
    let d = pickDir(gen, r);
    for (let i = 0; i < n; i++) {
      ops.push(corner(gen, r, b, r.pick([3, 4, 4, 5]), { dir: d }));
      if (i < n - 1) ops.push(str(r.range(26, 48)));
      d = -d;
    }
    return ops;
  },

  sBend(gen, r, b) {
    const d = pickDir(gen, r);
    const g = r.pick([3, 3, 4]);
    const c1 = corner(gen, r, b, g, { dir: d });
    c1.angle = Math.min(c1.angle, 1.1);
    const c2 = corner(gen, r, b, Math.max(2, g - r.int(0, 1)), { dir: -d });
    c2.angle = Math.min(c2.angle, 1.2);
    return [c1, str(r.range(10, 24)), c2];
  },

  techComplex(gen, r, b) {
    const ops = [];
    const n = r.int(3, 5);
    for (let i = 0; i < n; i++) {
      ops.push(corner(gen, r, b, r.pick([1, 2, 2, 3, 3, 4])));
      if (i < n - 1) ops.push(str(r.range(14, 36)));
    }
    return ops;
  },

  hairpinDrop(gen, r, b) {
    const ops = [str(r.range(50, 90)), corner(gen, r, b, "hp"), str(r.range(35, 70))];
    if (r.chance(0.5)) {
      const last = gen.lastDirs[gen.lastDirs.length - 1] || 1;
      ops.push(corner(gen, r, b, r.chance(0.5) ? "hp" : 1, { dir: -last }));
      ops.push(str(r.range(30, 60)));
    }
    return ops;
  },

  speedRun(gen, r, b) {
    const feat = r.chance(b.jumpLove) ? { kind: "jump", at: 0.55 }
      : r.chance(b.crestLove) ? { kind: "crest", at: r.range(0.4, 0.7) } : null;
    const ops = [str(r.range(190, 340), feat), corner(gen, r, b, "flat")];
    if (r.chance(0.4)) {
      ops.push(str(r.range(90, 170), r.chance(b.dipLove) ? { kind: "dip", at: 0.5 } : null));
      ops.push(corner(gen, r, b, 6));
    }
    return ops;
  },

  jumpLine(gen, r, b) {
    const ops = [str(r.range(130, 190), { kind: "jump", at: 0.6 })];
    if (r.chance(0.6)) ops.push(str(r.range(60, 95), { kind: "jump", at: 0.55 }));
    ops.push(corner(gen, r, b, r.chance(0.5) ? 6 : "flat"));
    return ops;
  },

  lakeside(gen, r, b) {
    const side = r.chance(0.5) ? F_LAKE_L : F_LAKE_R;
    // the road curves AWAY from the water more than toward it
    const away = side === F_LAKE_L ? 1 : -1;
    const ops = [
      str(r.range(60, 100), null, side),
      corner(gen, r, b, r.pick([5, 6]), { dir: r.chance(0.7) ? away : -away, flags: side }),
      str(r.range(80, 150), null, side),
    ];
    if (r.chance(0.6)) ops.push(corner(gen, r, b, r.chance(0.5) ? 6 : "flat", { flags: side }));
    return ops;
  },
};

/* ---------------------------------------------------------- mood machine */

const MOOD_NEXT = {
  calm: [["flow", 5], ["fast", 2], ["tech", 1.5], ["calm", 1.5]],
  flow: [["flow", 2.5], ["tech", 3], ["calm", 1.5], ["fast", 3]],
  tech: [["calm", 3], ["flow", 4], ["fast", 2], ["tech", 1]],
  fast: [["flow", 3.5], ["calm", 3], ["tech", 2.5], ["fast", 1]],
};
const MOOD_LEN = { calm: [380, 600], flow: [300, 520], tech: [240, 420], fast: [340, 560] };

/* ------------------------------------------------------------- generator */

export function makeGen(seed, biome, startX, startZ, startHeading) {
  const phaseR = rng(hashCombine(seed, 0x9137));
  return {
    seed, biome,
    sectionIndex: 0,
    // geometry cursor
    s: 0, x: startX || 0, z: startZ || 0, heading: startHeading || 0,
    hw: biome.halfWidth,
    // elevation state
    phases: [phaseR() * Math.PI * 2, phaseR() * Math.PI * 2, phaseR() * Math.PI * 2],
    trendGrade: 0, trendOffset: 0, elevBias: 0,
    prevY: null,        // last emitted y (continuity anchor)
    // journey state
    bearing: startHeading || 0,
    lastDirs: [],
    mood: "calm",
    moodRun: 0,
    // micro-region: which one, since when, and the one being left behind
    region: null, prevRegion: null, regionIdx: 0, regionStartS: 0, regionTransS: -1e9,
    // journey/route control (set by the world)
    route: null,          // {moodBias:{calm,flow,tech,fast}, crest, jump, lake}
  };
}

/* Route personality AND the micro-region the road is currently travelling
 * through, applied over the biome: a shallow copy with scaled appetites,
 * width and mood weights. The region is a delta on the country, never a
 * country of its own — the coast is still the coast on its cliff road. */
function withRoute(biome, route, region) {
  if (!route && !region) return biome;
  const b = Object.assign({}, biome);
  const rc = route || {}, g = region || {};
  b.crestLove = biome.crestLove * (rc.crest || 1) * (g.crest || 1);
  b.jumpLove = biome.jumpLove * (rc.jump || 1) * (g.jump || 1);
  b.lakeP = biome.lakeP * (rc.lake || 1) * (g.lake || 1);
  b.halfWidth = biome.halfWidth * (g.width || 1);
  /* A region that lays its own surface (Aspenvale's snow line) sizes its
   * corners for that surface's grip — the gear-grade promise must survive
   * the altitude, or "four" stops meaning fourth gear exactly where the
   * road gets serious. */
  if (g.surf) b.surf = g.surf;
  return b;
}

/* The director's intensity wave: FLOW → TECHNICAL → CRUISE → SPEED,
 * around and around inside a leg, each mood peaking a quarter-cycle
 * apart, offset per leg. The math lives here (the generator's side of
 * the contract); the PLAN — wavelength, phase, heat — comes from
 * game/director.js as plain data, so the layering stays one-way. */
const WAVE_ORDER = ["flow", "tech", "calm", "fast"];
export function waveFactor(plan, sInLeg, mood) {
  const idx = WAVE_ORDER.indexOf(mood);
  if (idx < 0 || !plan) return 1;
  const t = (sInLeg / plan.wave.len) * Math.PI * 2 + plan.wave.phase;
  return 1 + Math.cos(t - (idx * Math.PI) / 2) * 0.5;
}

/* Heat leans the road harder without rewriting it. All gentle — the
 * difficulty band is made of many small leans, not one big one. */
export function heatMoodFactor(heat, mood) {
  if (mood === "tech" || mood === "fast") return 1 + heat * 0.35;
  if (mood === "calm") return 1 - heat * 0.3;
  return 1;
}

/* Every voice applies, but not equally. The CARD is a promise the player
 * made a choice about, so it keeps the strong (squared) voice; the REGION
 * colours the mix without overruling it — a TECHNICAL card through the
 * High Moor is still a technical road, just a faster-breathing one. Give
 * the region equal weight and every card converges on the same average
 * road again, which is the bug this whole system exists to avoid. The
 * director's WAVE and HEAT are quieter still: a rhythm and a lean laid
 * under the promise, never over it. */
function moodWeights(route, region, plan, sInLeg) {
  const a = (route && route.moodBias) || {}, b = (region && region.mood) || {};
  return (m) => {
    const card = a[m] || 1;
    const region = 1 + ((b[m] || 1) - 1) * 0.6;    // colour, at 60% volume
    let f = card * card * region;
    if (plan) f *= waveFactor(plan, sInLeg, m) * heatMoodFactor(plan.heat, m);
    return f;
  };
}

function macroElev(gen, s) {
  const m = gen.biome.elevMacro;
  let e = 0;
  for (let i = 0; i < m.length; i++) {
    e += m[i][0] * Math.sin((s * 2 * Math.PI) / m[i][1] + gen.phases[i]);
  }
  return e;
}

/* Generate the next section. Deterministic per (seed, index, attempt).
 * Returns arrays ready for the world to append, plus notes & features. */
export function genSection(gen, attempt, opts) {
  opts = opts || {};
  const r = rng(hashCombine(gen.seed, gen.sectionIndex * 8 + (attempt || 0) + 1));
  const b = withRoute(gen.biome, gen.route, gen.region);
  const isWay = !!opts.waystation;

  // ---- plan: mood, trend, phrase list
  let mood, trend, ops = [];
  const ev = opts.event || null;
  if (opts.escape) {
    /* Rescue geometry. Used when every ordinary candidate collided with
     * road already laid: turn onto the bearing the world has picked as
     * empty, then drive out of the congestion in a straight line. Deeply
     * boring on purpose — its whole job is to get the road out of a knot
     * without anybody noticing it happened. */
    mood = "calm"; trend = 0;
    const err = wrapPi(gen.bearing - gen.heading);
    if (Math.abs(err) > 0.06) {
      const turn = corner(gen, r, b, Math.abs(err) > 1.7 ? "hp" : 3, { dir: err > 0 ? 1 : -1 });
      turn.angle = Math.min(Math.abs(err), 3.0);
      turn.mods = {};
      turn.camber = 0;
      ops.push(turn);
    }
    ops.push(str(opts.escapeShort ? r.range(60, 100) : r.range(150, 240)));
  } else if (ev) {
    /* An event takes the section over completely: it names the mood, it
     * may force the elevation trend and the road width, and it supplies
     * the phrase list itself. The mood machine is told what happened
     * afterwards (commitSection) so the road either side still flows. */
    if (ev.width) b.halfWidth = b.halfWidth * ev.width;
    /* An event that lays its own surface sizes its corners for it — the
     * same promise-keeping as region surfaces. (Found writing the frozen
     * lake: the Detour had been laying dirt under tarmac-sized corners in
     * the tarmac countries since it was built — the vmax profile kept the
     * bot honest, but the CALL was hot. Grip down = radius up, always.) */
    if (ev.surf) b.surf = ev.surf;
    mood = ev.mood || "flow";
    trend = ev.trend != null ? ev.trend * b.trendMax : 0;
    const targetLen = r.range(ev.len[0], ev.len[1]);
    let planned = 0;
    let guard = 0;
    while (planned < targetLen && guard++ < 12) {
      const chunk = ev.build(gen, r, b);
      for (const op of chunk) {
        ops.push(op);
        planned += op.t === "str" ? op.len : op.radius * op.angle + 50;
      }
    }
  } else if (isWay) {
    // approach → flat apron → departure; the road stays neutral here so
    // any route can follow it
    mood = "calm"; trend = 0;
    ops.push(str(WS_APPROACH), str(WS_APRON, null, F_WAY), str(WS_DEPART));
  } else {
    /* A route card is a promise about a whole leg, and the mood chain's
     * pull back towards "flow" was strong enough to break it: a 3.4×
     * nudge against transition weights of 3–4 left every card producing
     * roughly the same road with a garnish (TECHNICAL legs came out 45%
     * tech and 34% flow). The bias carries real authority now — squared,
     * so 3.4 becomes 11.6 — while a mood that has already run twice
     * stands aside, which keeps a technical leg relentless without
     * turning it into one 4 km corner. */
    const bias = moodWeights(gen.route, gen.region, gen.legPlan, gen.s - (gen.legStartS || 0));
    mood = gen.sectionIndex === 0 ? "calm"
      : r.weighted(MOOD_NEXT[gen.mood].map(([m, w]) => {
        const stale = gen.moodRun >= 2 && m === gen.mood ? 0.3 : 1;
        return { m, w: w * bias(m) * stale };
      })).m;
    const lenBand = MOOD_LEN[mood];
    let targetLen = r.range(lenBand[0], lenBand[1]);
    if (opts.maxLen != null) targetLen = Math.min(targetLen, Math.max(160, opts.maxLen));
    trend = Math.pow(r.range(-1, 1), 3) * b.trendMax * (mood === "tech" ? 1.5 : 1);
    if (gen.trendGrade !== 0 && r.chance(0.3)) trend = Math.abs(trend) * Math.sign(gen.trendGrade);
    /* The region's own drift. This is what makes travel legible: a climb
     * that keeps climbing for a kilometre, a descent you can feel in the
     * brakes, a moor that stays up. */
    const drift = (gen.region && gen.region.trend) || 0;
    if (drift) trend = Math.max(-b.trendMax * 1.5, Math.min(b.trendMax * 1.5, trend * 0.45 + drift * b.trendMax * 1.05));
    let planned = 0;
    while (planned < targetLen) {
      const table = b.moods[mood].filter(([name]) => name !== "lakeside" || r.chance(b.lakeP * 4));
      const pick = r.weighted(table.map(([p, w]) => ({ p, w }))).p;
      const phraseOps = PHRASES[pick](gen, r, b);
      for (const op of phraseOps) {
        ops.push(op);
        planned += op.t === "str" ? op.len : op.radius * op.angle + 50;
      }
    }
  }

  // ---- compile: ops -> samples
  const xs = [], zs = [], ys = [], hd = [], kv = [], cb = [], hws = [], fls = [];
  const feats = [], notes = [];
  const s0 = gen.s;
  let x = gen.x, z = gen.z, heading = gen.heading, hw = gen.hw;

  function emit(len, fk, flags) {
    const n = Math.max(1, Math.round(len / DS));
    for (let j = 0; j < n; j++) {
      const t = n === 1 ? 0.5 : j / (n - 1);
      const k = fk.k ? fk.k(t) : 0;
      const camber = fk.c ? fk.c(t) : 0;
      const hMid = heading + (k * DS) / 2;
      x += Math.cos(hMid) * DS;
      z += Math.sin(hMid) * DS;
      heading = wrapPi(heading + k * DS);
      hw += Math.max(-0.12, Math.min(0.12, (fk.w != null ? fk.w : b.halfWidth) - hw));
      xs.push(x); zs.push(z); hd.push(heading); kv.push(k); cb.push(camber);
      hws.push(hw); fls.push(flags || 0);
    }
    return n * DS;
  }

  let sCursor = 0;
  for (const op of ops) {
    if (op.t === "str") {
      const startS = sCursor;
      sCursor += emit(op.len, {}, op.flags);
      if (op.feat) {
        const at = s0 + startS + op.len * op.feat.at;
        // features keep clear of section edges so their tails stay local
        if (at - s0 > 40) {
          const note = { s: at - 12, kind: op.feat.kind, endS: at + 26 };
          feats.push({ s: at, kind: op.feat.kind, r, note });
          notes.push(note);
        }
      }
    } else {
      const k1 = op.dir / op.radius;
      const vT = gradeTarget(op.grade);
      let Ls = Math.max(12, Math.min(80, vT * 0.85));
      Ls = Math.min(Ls, (0.36 * op.angle) / Math.abs(k1));
      const rampAngle = Math.abs(k1) * Ls;           // both spirals combined
      const arcAngle = Math.max(0.05, op.angle - rampAngle);
      const camber = -op.dir * op.camber;            // outside edge high = helpful
      const noteS = s0 + sCursor;

      if (op.feat && op.feat.kind === "crest") {
        feats.push({ s: Math.max(s0 + 30, noteS - 14), kind: "crest", r });
      }

      sCursor += emit(Ls, { k: (t) => k1 * t, c: (t) => camber * t }, op.flags);
      if (op.mods.tightens) {
        const k2 = op.dir / op.mods.tightensR;
        sCursor += emit((arcAngle * 0.5) / Math.abs(k1), { k: () => k1, c: () => camber }, op.flags);
        sCursor += emit(13, { k: (t) => k1 + (k2 - k1) * t, c: () => camber }, op.flags);
        sCursor += emit((arcAngle * 0.5) / Math.abs(k2), { k: () => k2, c: () => camber }, op.flags);
        sCursor += emit(Ls, { k: (t) => k2 * (1 - t), c: (t) => camber * (1 - t) }, op.flags);
      } else if (op.mods.opens) {
        const k2 = op.dir / op.mods.opensR;
        sCursor += emit((arcAngle * 0.55) / Math.abs(k1), { k: () => k1, c: () => camber }, op.flags);
        sCursor += emit(13, { k: (t) => k1 + (k2 - k1) * t, c: () => camber }, op.flags);
        sCursor += emit((arcAngle * 0.45) / Math.abs(k2), { k: () => k2, c: () => camber }, op.flags);
        sCursor += emit(Ls, { k: (t) => k2 * (1 - t), c: (t) => camber * (1 - t) }, op.flags);
      } else {
        sCursor += emit(arcAngle / Math.abs(k1), { k: () => k1, c: () => camber }, op.flags);
        sCursor += emit(Ls, { k: (t) => k1 * (1 - t), c: (t) => camber * (1 - t) }, op.flags);
      }

      notes.push({
        s: noteS, endS: s0 + sCursor, kind: "corner",
        grade: op.grade, dir: op.dir, mods: op.mods,
        feat: op.feat ? op.feat.kind : null,
      });
    }
  }

  const n = xs.length;

  /* A jump is a promise of a straight landing: it needs ~90 m of near-
   * straight road after the ramp (flight + landing + gathering up) and must
   * not sit within 70 m of the section end (the next section may open on a
   * corner). Anything else is demoted to a crest, which the liftoff-aware
   * speed profile keeps honest. */
  for (const f of feats) {
    if (f.kind !== "jump") continue;
    const i0 = Math.round((f.s - s0) / DS) - 1;
    let ok = (n - i0) * DS > 70;
    for (let i = i0; ok && i < Math.min(n, i0 + Math.round(90 / DS)); i++) if (Math.abs(kv[i]) > 0.003) ok = false;
    if (!ok) { f.kind = "crest"; if (f.note) f.note.kind = "crest"; }
  }

  // ---- elevation
  const TRANS = 110;
  let trendOffset = gen.trendOffset;
  let g0 = gen.trendGrade;
  let bias = gen.elevBias;
  for (let i = 0; i < n; i++) {
    const sAbs = s0 + (i + 1) * DS;
    const u = (i + 1) * DS;
    const blend = Math.min(1, u / TRANS);
    const gNow = g0 + (trend - g0) * (blend * blend * (3 - 2 * blend));
    trendOffset += gNow * DS;
    bias *= 1 - Math.min(1, DS / 220);        // repairs decay away smoothly
    let y = macroElev(gen, sAbs) + trendOffset + bias;
    ys.push(y);
  }
  // features: crest = bump, dip = hollow, jump = ramp with a sharper far side
  for (const f of feats) {
    let h, wUp, wDn;
    const fr = rng(hashCombine(gen.seed, Math.round(f.s * 7)));
    if (f.kind === "jump") { h = fr.range(1.3, 2.1); wUp = fr.range(9, 12); wDn = wUp * 0.55; }
    else if (f.kind === "crest") { h = fr.range(1.0, 1.8); wUp = wDn = fr.range(19, 27); }
    else { h = -fr.range(1.1, 2.0); wUp = wDn = fr.range(11, 16); }
    f.h = h; f.w = wUp;
    const i0 = Math.round((f.s - s0) / DS) - 1;
    const span = Math.ceil((wUp * 3) / DS);
    for (let i = Math.max(0, i0 - span); i < Math.min(n, i0 + span); i++) {
      const d = (i - i0) * DS;
      const w = d < 0 ? wUp : wDn;
      ys[i] += h * Math.exp(-(d * d) / (w * w));
    }
  }
  // safety clamp (never a grade past 0.17) + one smoothing pass, anchored at
  // the carry-in so section boundaries can't step
  const maxStep = 0.14 * DS;
  let prevY = gen.prevY != null ? gen.prevY : ys[0];
  for (let i = 0; i < n; i++) {
    if (ys[i] - prevY > maxStep) ys[i] = prevY + maxStep;
    if (ys[i] - prevY < -maxStep) ys[i] = prevY - maxStep;
    prevY = ys[i];
  }
  for (let i = n - 2; i >= 1; i--) {
    if (ys[i] - ys[i + 1] > maxStep) ys[i] = ys[i + 1] + maxStep;
    if (ys[i] - ys[i + 1] < -maxStep) ys[i] = ys[i + 1] - maxStep;
  }
  for (let i = 1; i < n - 1; i++) ys[i] = (ys[i - 1] + 2 * ys[i] + ys[i + 1]) / 4;

  let waystationS = null;
  if (isWay) {
    // flatten the apron: blend elevation toward the approach-end height
    const iA = Math.round(WS_APPROACH / DS), iB = Math.round((WS_APPROACH + WS_APRON) / DS);
    const flatY = ys[Math.min(n - 1, iA)];
    for (let i = 0; i < n; i++) {
      let w = 0;
      if (i >= iA && i <= iB) w = 1;
      else if (i < iA) w = Math.max(0, 1 - (iA - i) * DS / 45);
      else w = Math.max(0, 1 - (i - iB) * DS / 60);
      w = w * w * (3 - 2 * w);
      ys[i] = ys[i] * (1 - w) + flatY * w;
    }
    // the flatten can steepen the approach: clamp again, both ways, then smooth
    let pv = gen.prevY != null ? gen.prevY : ys[0];
    for (let i = 0; i < n; i++) {
      if (ys[i] - pv > maxStep) ys[i] = pv + maxStep;
      if (ys[i] - pv < -maxStep) ys[i] = pv - maxStep;
      pv = ys[i];
    }
    for (let i = n - 2; i >= 1; i--) {
      if (ys[i] - ys[i + 1] > maxStep) ys[i] = ys[i + 1] + maxStep;
      if (ys[i] - ys[i + 1] < -maxStep) ys[i] = ys[i + 1] - maxStep;
    }
    for (let i = 1; i < n - 1; i++) ys[i] = (ys[i - 1] + 2 * ys[i] + ys[i + 1]) / 4;
    waystationS = s0 + WS_APPROACH + WS_APRON * 0.5;
  }
  const endBias = ys[n - 1] - (macroElev(gen, s0 + n * DS) + trendOffset);

  return {
    n, xs, zs, ys, hd, kv, cb, hws, fls, feats, notes,
    mood, trend, event: ev, sectionIndex: gen.sectionIndex, waystationS, biome: gen.biome,
    end: { x, z, heading, hw, trendGrade: trend, trendOffset, elevBias: endBias, prevY: ys[n - 1], s: s0 + n * DS },
  };
}

/* Commit a validated section: advance the generator's cursor. */
export function commitSection(gen, sec) {
  gen.sectionIndex++;
  gen.s = sec.end.s;
  gen.x = sec.end.x;
  gen.z = sec.end.z;
  gen.heading = sec.end.heading;
  gen.hw = sec.end.hw;
  gen.trendGrade = sec.end.trendGrade;
  gen.trendOffset = sec.end.trendOffset;
  gen.elevBias = sec.end.elevBias;
  gen.prevY = sec.end.prevY;
  gen.moodRun = sec.mood === gen.mood ? gen.moodRun + 1 : 1;
  gen.mood = sec.mood;
  // bearing wanders; the next sections chase it loosely
  const r = rng(hashCombine(gen.seed, 0xbea1 + gen.sectionIndex));
  gen.bearing = wrapPi(gen.bearing + r.range(-0.55, 0.55));
}
