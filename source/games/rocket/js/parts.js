/* Daily Rocket — the parts catalog and vessel assembly.
 *
 * A build is a single stack, listed top to bottom, where each stack part may
 * carry one mirrored radial pair (fins, legs, chutes, thrusters, boosters or
 * engine pods). Decouplers cut the stack into stages; the bottom stage lights
 * at launch and every STAGE press walks up the list: drop that stage's
 * radial boosters (if it has any), then separate it and light the next.
 *
 * Local vessel frame: `s` runs up the axis from the bottom of the original
 * stack (s = 0), `c` runs across it (+c is the vessel's right-hand side).
 * Parts never move in this frame; staging just splits the part list, so
 * every piece keeps a consistent geometry for the renderer and the sim.
 */

export const G0 = 9.81;

const disc = (w) => Math.PI * (w / 2) * (w / 2);

/* Stats are tuned for play at hop scale (a few km, a minute of flight), not
 * for fidelity. Costs are dollars. Isp values set exhaust velocity; thrust in
 * air falls as exhaust velocity does, so a vacuum engine is feeble on Terra. */
export const PARTS = {
  // ---------------------------------------------------------- payloads
  probe: {
    id: "probe", name: "Survey Probe", kind: "payload", mount: "stack",
    w: 1.2, h: 1.3, mass: 150, cost: 0, wheel: 2600, top: "capsule",
    blurb: "Instruments and a small reaction wheel."
  },
  cargo: {
    id: "cargo", name: "Cargo Pod", kind: "payload", mount: "stack",
    w: 1.8, h: 1.9, mass: 480, cost: 0, wheel: 5200, top: "capsule",
    blurb: "Crates for the outpost. Heavy, blunt, built-in reaction wheel."
  },
  crew: {
    id: "crew", name: "Crew Capsule", kind: "payload", mount: "stack",
    w: 2.0, h: 2.3, mass: 820, cost: 0, wheel: 7800, top: "capsule",
    blurb: "Two people who would like to arrive gently."
  },
  freight: {
    id: "freight", name: "Freight Pod", kind: "payload", mount: "stack",
    w: 2.0, h: 2.6, mass: 1100, cost: 0, wheel: 8600, top: "crate",
    blurb: "A tonne and a bit, crated. Blunt as a brick."
  },

  // ---------------------------------------------------------- stack
  nose: {
    id: "nose", name: "Nose Cone", kind: "nose", mount: "stack",
    w: 0, h: 1.1, mass: 22, cost: 1100,
    blurb: "Slices the air. Cuts drag on whatever sits at the top."
  },
  tankS: {
    id: "tankS", name: "FT-140", kind: "tank", mount: "stack",
    w: 1.2, h: 0.9, mass: 22, prop: 140, cost: 2000,
    blurb: "Small tank. 140 kg of propellant."
  },
  tankM: {
    id: "tankM", name: "FT-320", kind: "tank", mount: "stack",
    w: 1.2, h: 1.8, mass: 40, prop: 320, cost: 3800,
    blurb: "Medium tank. 320 kg of propellant."
  },
  tankL: {
    id: "tankL", name: "FT-950", kind: "tank", mount: "stack",
    w: 1.8, h: 2.4, mass: 95, prop: 950, cost: 9000,
    blurb: "Wide tank. 950 kg of propellant."
  },
  pip: {
    id: "pip", name: "Pip", kind: "engine", mount: "stack",
    w: 0.9, h: 0.9, mass: 45, cost: 7000,
    thrust: 9000, ispSL: 235, ispVac: 290, gimbal: 0.17, minThr: 0.08,
    blurb: "Tiny, frugal, deep-throttling. The lander's friend."
  },
  hornet: {
    id: "hornet", name: "Hornet", kind: "engine", mount: "stack",
    w: 1.2, h: 1.3, mass: 140, cost: 18000,
    thrust: 32000, ispSL: 268, ispVac: 300, gimbal: 0.13, minThr: 0.18,
    blurb: "Sea-level workhorse. Strong in thick air."
  },
  heron: {
    id: "heron", name: "Heron", kind: "engine", mount: "stack",
    w: 1.2, h: 1.6, mass: 85, cost: 16000,
    thrust: 15000, ispSL: 130, ispVac: 345, gimbal: 0.1, minThr: 0.12,
    blurb: "Vacuum engine. Superb in thin air, wheezes at sea level."
  },
  ox: {
    id: "ox", name: "Ox", kind: "engine", mount: "stack",
    w: 1.8, h: 1.9, mass: 470, cost: 38800,
    thrust: 105000, ispSL: 270, ispVac: 296, gimbal: 0.09, minThr: 0.4,
    blurb: "Heavy lifter. Will not throttle below 40 %."
  },
  flea: {
    id: "flea", name: "Flea", kind: "srb", mount: "stack",
    w: 0.9, h: 2.0, mass: 45, prop: 180, cost: 3200,
    thrust: 30000, ispSL: 195, ispVac: 214,
    blurb: "Solid booster. Cheap kick, no throttle, no off switch."
  },
  hammer: {
    id: "hammer", name: "Hammer", kind: "srb", mount: "stack",
    w: 1.2, h: 3.6, mass: 140, prop: 700, cost: 8500,
    thrust: 85000, ispSL: 200, ispVac: 220,
    blurb: "Big solid. Sixteen seconds of shove, then dead weight."
  },
  decoupler: {
    id: "decoupler", name: "Decoupler", kind: "decoupler", mount: "stack",
    w: 0, h: 0.35, mass: 25, cost: 1800,
    blurb: "Splits the stack into stages."
  },
  gyro: {
    id: "gyro", name: "Gyro", kind: "gyro", mount: "stack",
    w: 1.2, h: 0.5, mass: 55, cost: 6000, wheel: 9000,
    blurb: "Reaction wheel. Turns the rocket with or without air or thrust."
  },

  // ---------------------------------------------------------- radial pairs
  fins: {
    id: "fins", name: "Fins", kind: "fins", mount: "radial",
    w: 0.9, h: 1.1, mass: 12, cost: 1200, area: 0.75,
    blurb: "Pair. Pulls the centre of pressure aft. Useless in vacuum."
  },
  finsL: {
    id: "finsL", name: "Big Fins", kind: "fins", mount: "radial",
    w: 1.4, h: 1.7, mass: 28, cost: 2800, area: 1.7,
    blurb: "Pair. Serious stability, serious drag."
  },
  legs: {
    id: "legs", name: "Legs", kind: "legs", mount: "radial",
    w: 0.35, h: 1.6, mass: 32, cost: 3800, reach: 1.35, drop: 1.25,
    blurb: "Pair. Touch down at up to 6 m/s instead of 2. Must reach below the engine."
  },
  chute: {
    id: "chute", name: "Chutes", kind: "chute", mount: "radial",
    w: 0.42, h: 0.8, mass: 22, cost: 2500, cda: 48,
    blurb: "Pair. Huge drag in thick air, a whisper in thin. Rip above 9 kPa."
  },
  rcs: {
    id: "rcs", name: "RCS", kind: "rcs", mount: "radial",
    w: 0.36, h: 0.55, mass: 14, cost: 3000, force: 900, mono: 14,
    blurb: "Pair of thruster blocks. Torque grows with distance from the CoM."
  },
  pod: {
    id: "pod", name: "Pip Pods", kind: "pod", mount: "radial",
    w: 0.7, h: 1.0, mass: 45, cost: 7000,
    thrust: 9000, ispSL: 235, ispVac: 290, gimbal: 0.17, minThr: 0.08,
    blurb: "Pair of side-mounted Pip engines fed by this stage's tanks."
  },
  fleaR: {
    id: "fleaR", name: "Flea Pair", kind: "srb", mount: "radial", base: "flea",
    w: 0.9, h: 2.0, mass: 45, prop: 180, cost: 3200,
    thrust: 30000, ispSL: 195, ispVac: 214,
    blurb: "Pair of solid boosters strapped to the side. Jettisoned by STAGE."
  },
  hammerR: {
    id: "hammerR", name: "Hammer Pair", kind: "srb", mount: "radial", base: "hammer",
    w: 1.2, h: 3.6, mass: 140, prop: 700, cost: 8500,
    thrust: 85000, ispSL: 200, ispVac: 220,
    blurb: "Pair of big solids. Enormous launch kick."
  }
};

/* Tray order in the hangar. */
export const PART_ORDER = [
  "nose", "tankS", "tankM", "tankL", "pip", "hornet", "heron", "ox",
  "flea", "hammer", "decoupler", "gyro",
  "fins", "finsL", "legs", "chute", "rcs", "pod", "fleaR", "hammerR"
];

export const LEG_V = 6.0;    // m/s vertical touchdown limit on legs
export const LEG_H = 2.5;    // m/s horizontal
export const BARE_V = 2.0;   // on an engine bell
export const BARE_H = 1.0;
export const TILT_MAX = 0.26; // never more than ~15 degrees, whatever the footprint
export const CHUTE_Q = 9000; // Pa — deploy above this and the canopy tears
export const REFUND = 0.5;   // share of hardware cost refunded for a recovered stage

export const isEngine = (d) => d.kind === "engine" || d.kind === "pod" || d.kind === "srb";

// ---------------------------------------------------------------- builds

/* Build JSON: { stack: [{ p, fill?, r? }] } top to bottom. The payload is
 * the mission's; the builder keeps it in the stack and never lets it go. */
export function cloneBuild(b) {
  return { stack: b.stack.map((e) => ({ p: e.p, fill: e.fill == null ? 1 : e.fill, r: e.r || null })) };
}

export function buildKey(b) {
  return b.stack.map((e) => e.p + (e.fill != null && e.fill < 1 ? "@" + Math.round(e.fill * 100) : "") +
    (e.r ? "+" + e.r : "")).join("/");
}

/* Parts a build consumes from the day's inventory (radials count as pairs). */
export function partCounts(b) {
  const n = {};
  for (const e of b.stack) {
    const d = PARTS[e.p];
    if (d && d.kind !== "payload") { n[e.p] = (n[e.p] || 0) + 1; }
    if (e.r) { n[e.r] = (n[e.r] || 0) + 1; }
  }
  return n;
}

export function hardwareCost(b) {
  let c = 0;
  for (const e of b.stack) {
    c += PARTS[e.p].cost;
    if (e.r) { c += PARTS[e.r].cost * 2; }
  }
  return c;
}

// -------------------------------------------------------------- assembly

/* Turns a build into positioned part instances plus the staging list. */
export function assemble(build) {
  const st = build.stack;
  const n = st.length;

  // widths: nose and decoupler borrow their neighbour's
  const widths = st.map((e) => PARTS[e.p].w);
  for (let i = 0; i < n; i++) {
    const d = PARTS[st[i].p];
    if (d.kind === "nose") { widths[i] = i + 1 < n ? widths[i + 1] || 1.2 : 1.2; }
  }
  for (let i = 0; i < n; i++) {
    const d = PARTS[st[i].p];
    if (d.kind === "decoupler") {
      const below = i + 1 < n ? widths[i + 1] : 0;
      const above = i > 0 ? widths[i - 1] : 0;
      widths[i] = below || above || 1.2;
    }
  }

  // segments: a decoupler belongs to the stage beneath it
  const segOf = new Array(n);
  let segCount = 0;
  for (let i = n - 1; i >= 0; i--) {
    segOf[i] = segCount;
    if (PARTS[st[i].p].kind === "decoupler" && i > 0) { segCount++; }
  }
  // (loop above assigns bottom-up; decouplers bump the index for parts above)
  segCount = n ? segOf[0] + 1 : 0;

  const parts = [];
  let s = 0;
  const stackIdx = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const e = st[i];
    const d = PARTS[e.p];
    const w = widths[i];
    const fill = e.fill == null ? 1 : Math.max(0, Math.min(1, e.fill));
    const p = {
      id: d.id, def: d, kind: d.kind, radial: false, side: 0,
      s0: s, s1: s + d.h, c: 0, w, h: d.h,
      dry: d.mass, prop: (d.prop || 0) * (d.kind === "tank" ? fill : 1),
      propMax: d.prop || 0, fill,
      seg: segOf[i], host: -1, stackIndex: i, idx: parts.length,
      lit: false, burning: 0, mono: 0
    };
    stackIdx[i] = parts.length;
    parts.push(p);
    s += d.h;
  }

  // radial pairs
  for (let i = 0; i < n; i++) {
    const e = st[i];
    if (!e.r) { continue; }
    const d = PARTS[e.r];
    const host = parts[stackIdx[i]];
    for (const side of [-1, 1]) {
      const p = {
        id: d.id, def: d, kind: d.kind, radial: true, side,
        s0: 0, s1: 0, c: 0, w: d.w, h: d.h,
        dry: d.mass, prop: d.prop || 0, propMax: d.prop || 0, fill: 1,
        seg: host.seg, host: host.idx, stackIndex: i, idx: parts.length,
        lit: false, burning: 0, mono: d.mono || 0, group: "r" + i
      };
      const hw = host.w / 2;
      if (d.kind === "chute" || d.kind === "rcs") {
        p.s1 = host.s1 - 0.05; p.s0 = p.s1 - d.h;
        p.c = side * (hw + d.w / 2);
      } else if (d.kind === "legs") {
        // the strut root hangs on the host; the foot is computed on deploy
        p.s1 = host.s0 + Math.min(host.h, 1.2); p.s0 = p.s1 - d.h;
        p.c = side * (hw + d.w / 2);
        p.footS = host.s0 - d.drop;
        p.footC = side * (hw + d.reach);
      } else if (d.kind === "fins") {
        p.s0 = host.s0; p.s1 = host.s0 + d.h;
        p.c = side * (hw + d.w / 2);
      } else { // srb, pod: bottom aligned with the host
        p.s0 = host.s0; p.s1 = host.s0 + d.h;
        p.c = side * (hw + d.w / 2);
      }
      parts.push(p);
    }
  }

  // which engines can actually fire: a stack engine or solid must be the
  // lowest stack part of its stage, or its exhaust has nowhere to go
  for (const p of parts) {
    if (p.radial || !isEngine(p.def)) { continue; }
    const below = parts.find((q) => !q.radial && q.stackIndex === p.stackIndex + 1);
    p.blocked = !!below && below.seg === p.seg;
  }

  // staging list
  const events = [];
  for (let k = 0; k < segCount; k++) {
    if (k === 0) { events.push({ type: "ignite", seg: 0, label: "Ignition" }); }
    const hasBoosters = parts.some((p) => p.radial && p.kind === "srb" && p.seg === k);
    if (hasBoosters) { events.push({ type: "boosters", seg: k, label: "Drop boosters" }); }
    if (k + 1 < segCount) { events.push({ type: "separate", seg: k, label: "Separate stage " + (k + 1) }); }
  }

  return { parts, events, segCount, height: s };
}

// ------------------------------------------------------- mass properties

export function massProps(parts) {
  let m = 0, ms = 0, mc = 0;
  for (const p of parts) {
    const pm = p.dry + p.prop + p.mono;
    m += pm;
    ms += pm * (p.s0 + p.s1) * 0.5;
    mc += pm * p.c;
  }
  if (m <= 0) { return { m: 1, s: 0, c: 0, I: 1 }; }
  const sc = ms / m, cc = mc / m;
  let I = 0;
  for (const p of parts) {
    const pm = p.dry + p.prop + p.mono;
    const ds = (p.s0 + p.s1) * 0.5 - sc;
    const dc = p.c - cc;
    I += pm * (ds * ds + dc * dc + (p.h * p.h + p.w * p.w) / 12);
  }
  return { m, s: sc, c: cc, I: Math.max(I, 1) };
}

// ---------------------------------------------------------- aerodynamics

/* Barrowman-flavoured normal-force terms plus axial drag and crossflow.
 *   N  normal-force coefficient area (m^2 per unit q per radian-ish), linear
 *   X  crossflow area (m^2), acts on sin^2 of the angle of attack
 *   D  axial drag area CdA (m^2)
 * placed at (s, c) in the local frame. Recomputed only when the part list
 * changes (staging, legs, chutes), never per tick. */
/* The air in this game is gentler than Barrowman's: normal-force moments
 * run at 40 % so stability is a tendency you feel and design around rather
 * than a wall. Where the centre of pressure sits is unchanged by it. */
export const K_AERO = 0.4;
export const FIN_N = 4.5;       // normal-force coefficient per m^2 of fin
export const FIN_CTRL = 0.35;   // fins steer too: share of their own moment

export function aeroTerms(parts, legsOut) {
  const terms = [];
  const stack = parts.filter((p) => !p.radial).sort((a, b) => b.s1 - a.s1);

  if (stack.length) {
    const top = stack[0];
    const A = disc(top.w);
    const isNose = top.kind === "nose";
    const cd = isNose ? 0.28 : top.def.top === "capsule" ? 0.55 : 0.85;
    terms.push({
      s: isNose ? top.s1 - top.h * 0.47 : top.s1 - Math.min(0.2, top.h * 0.2),
      c: top.c, N: 2 * A * K_AERO, X: 0, D: cd * A
    });
  }
  for (let i = 0; i < stack.length; i++) {
    const p = stack[i];
    const body = p.kind === "nose" ? 0.5 : 1;
    terms.push({ s: (p.s0 + p.s1) / 2, c: p.c, N: 0, X: 0.9 * p.w * p.h * body, D: 0.012 * p.w * p.h });
    const q = stack[i + 1];
    if (q && Math.abs(q.s1 - p.s0) < 0.01) {
      const dA = disc(q.w) - disc(p.w);
      terms.push({ s: p.s0, c: p.c, N: 2 * dA * K_AERO, X: 0, D: dA > 0 ? 0.45 * dA : 0 });
    } else if (!q) {
      // exposed base with nothing firing through it: a little base drag
      terms.push({ s: p.s0, c: p.c, N: 0, X: 0, D: 0.12 * disc(p.w) });
    }
  }
  for (const p of parts) {
    if (!p.radial) { continue; }
    const d = p.def;
    if (d.kind === "fins") {
      terms.push({ s: p.s0 + p.h * 0.38, c: p.c, N: FIN_N * d.area * K_AERO, X: 0.25 * d.area, D: 0.03 * d.area, fin: true });
    } else if (d.kind === "srb" || d.kind === "pod") {
      const A = disc(p.w);
      terms.push({ s: p.s1 - 0.3, c: p.c, N: 2 * A * K_AERO, X: 0, D: 0.45 * A });
      terms.push({ s: (p.s0 + p.s1) / 2, c: p.c, N: 0, X: 0.9 * p.w * p.h, D: 0.012 * p.w * p.h });
    } else if (d.kind === "legs") {
      terms.push({ s: (p.s0 + p.s1) / 2, c: p.c, N: 0, X: 0.3 * p.w * p.h, D: legsOut ? 0.32 : 0.04 });
    } else {
      terms.push({ s: (p.s0 + p.s1) / 2, c: p.c, N: 0, X: 0.3 * p.w * p.h, D: 0.05 });
    }
  }
  return terms;
}

/* Centre of pressure along the axis, from the linear normal-force terms. */
export function centreOfPressure(terms) {
  let n = 0, ns = 0;
  for (const t of terms) { n += t.N; ns += t.N * t.s; }
  return n > 0.01 ? ns / n : null;
}

// ------------------------------------------------------------ engines

export function exhaustV(d, pAtm) {
  const vac = d.ispVac * G0, sl = d.ispSL * G0;
  return Math.max(vac * 0.25, vac - (vac - sl) * pAtm);
}

/* Mass flow at full throttle. Liquid engines are rated in vacuum; solids
 * are rated at sea level (it is where they are used). */
export function fullFlow(d) {
  return d.kind === "srb" ? d.thrust / (d.ispSL * G0) : d.thrust / (d.ispVac * G0);
}

// --------------------------------------------------------- stage numbers

/* Per-stage Δv / TWR / burn time for the hangar readout. Works from the
 * top stage down, carrying the mass of everything above. `pAtm` is the
 * pressure the stage is assumed to burn in (sea level for stage 1,
 * vacuum-ish above), `g` the day's gravity. */
export function stageStats(build, g, pAtmLaunch) {
  const A = assemble(build);
  const out = [];
  const segs = A.segCount;
  let massAbove = 0;
  for (let k = segs - 1; k >= 0; k--) {
    const mine = A.parts.filter((p) => p.seg === k);
    const dry = mine.reduce((a, p) => a + p.dry + p.mono, 0);
    const liquidProp = mine.filter((p) => p.kind === "tank").reduce((a, p) => a + p.prop, 0);
    const pAtm = k === 0 ? pAtmLaunch : pAtmLaunch * 0.25;
    const liquids = mine.filter((p) => (p.kind === "engine" || p.kind === "pod") && !p.blocked);
    const solids = mine.filter((p) => p.kind === "srb" && !p.blocked);
    const liqFlow = liquids.reduce((a, p) => a + fullFlow(p.def), 0);
    const liqThrust = liquids.reduce((a, p) => a + fullFlow(p.def) * exhaustV(p.def, pAtm), 0);
    const solThrust = solids.reduce((a, p) => a + fullFlow(p.def) * exhaustV(p.def, pAtm), 0);
    const solProp = solids.reduce((a, p) => a + p.prop, 0);
    const m0 = massAbove + dry + liquidProp + solProp;

    // Δv: solids burn first in parallel with the liquids (approximation:
    // sum of the two phases with their own mass ratios)
    let dv = 0, burn = 0, dvSolid = 0;
    let m = m0;
    if (solids.length && solProp > 0) {
      const sFlow = solids.reduce((a, p) => a + fullFlow(p.def), 0);
      const tS = solProp / sFlow;
      const lBurn = Math.min(liquidProp, liqFlow * tS);
      const flow = sFlow + (liquidProp > 0 ? liqFlow : 0);
      const T = solThrust + (liquidProp > 0 ? liqThrust : 0);
      const ve = T / flow;
      const m1 = m - solProp - lBurn;
      dv += ve * Math.log(m / m1);
      dvSolid = dv;
      burn += tS;
      m = m1;
      // radial boosters are dropped after burnout
      m -= solids.filter((p) => p.radial).reduce((a, p) => a + p.dry, 0);
      const left = liquidProp - lBurn;
      if (liqFlow > 0 && left > 0) {
        const veL = liqThrust / liqFlow;
        dv += veL * Math.log(m / (m - left));
        burn += left / liqFlow;
      }
    } else if (liqFlow > 0 && liquidProp > 0) {
      const ve = liqThrust / liqFlow;
      dv = ve * Math.log(m / (m - liquidProp));
      burn = liquidProp / liqFlow;
    }
    const thrust0 = solThrust + (liquidProp > 0 ? liqThrust : 0);
    out.unshift({
      seg: k, m0, dv, dvSolid, burn, thrust: thrust0, twr: g > 0 ? thrust0 / (m0 * g) : 0,
      liquidProp, solidProp: solProp, engines: liquids.length + solids.length
    });
    massAbove = m0;
  }
  return { stages: out, assembly: A };
}

export function totalMass(build) {
  const A = assemble(build);
  return massProps(A.parts).m;
}
