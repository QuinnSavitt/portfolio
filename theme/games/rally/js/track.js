/* Daily Rally — procedural stage generation.
 *
 * A stage is compiled from a plan of road "ops" (straights, corners, chicanes)
 * chosen by per-environment grammars, then integrated into a sampled centerline
 * with elevation, camber and width. Pace notes, checkpoints, scenery and
 * colliders are derived from the same plan, and a speed-profile bot estimates
 * completion time for validation. Everything is deterministic from one seed.
 *
 * This module must stay DOM-free and three-free so it can run under node
 * for automated stage validation.
 */

import { rng, hash32, hashCombine, daySeed } from "./daily.js";

export const DS = 2;            // metres between centreline samples
export const G = 9.81;

/* ------------------------------------------------------------ environments */

export const ENVS = [
  {
    id: "finland", name: "Finland", flag: "FI",
    surface: "Gravel", surfKey: "gravel",
    radiusScale: 1.0, straightScale: 1.0,
    avgSpeed: 26.5, baseHalfWidth: 3.8, hilliness: 14, terrAmp: 3.2,
    ditch: 0.32, snowbank: false, jumpLove: true, crestFreq: 0.5,
    dontcutP: 0.3, offCamberP: 0.1, villageP: 0,
    archWeights: { flow: 5, speed: 4, rhythm: 2, technical: 1 },
    stageNames: ["Kivijarvi", "Myrskyla", "Ouninsalo", "Paijala", "Ruuhimaki", "Vessari", "Lankamaa", "Hurskala"],
    weather: [
      { w: 5, id: "clear" }, { w: 3, id: "overcast" },
      { w: 2, id: "sunset" }, { w: 2, id: "rain" },
    ],
  },
  {
    id: "wales", name: "Wales", flag: "GB",
    surface: "Gravel", surfKey: "gravel",
    radiusScale: 0.82, straightScale: 0.78,
    avgSpeed: 22.5, baseHalfWidth: 2.9, hilliness: 16, terrAmp: 4.0,
    ditch: 0.3, snowbank: false, jumpLove: false, crestFreq: 0.35,
    dontcutP: 0.4, offCamberP: 0.16, villageP: 0,
    archWeights: { flow: 2, speed: 1, rhythm: 4, technical: 5 },
    stageNames: ["Bryn Arau", "Dyfnant", "Hafren", "Myherin", "Penmachno", "Gartheiniog", "Crychan"],
    weather: [
      { w: 2, id: "overcast" }, { w: 4, id: "rain" },
      { w: 3, id: "fog" }, { w: 1, id: "clear" },
    ],
  },
  {
    id: "sweden", name: "Sweden", flag: "SE",
    surface: "Snow", surfKey: "snow",
    radiusScale: 0.62, straightScale: 0.66,
    avgSpeed: 23.5, baseHalfWidth: 3.3, hilliness: 10, terrAmp: 2.6,
    ditch: 0, snowbank: true, jumpLove: true, crestFreq: 0.4,
    dontcutP: 0.15, offCamberP: 0.06, villageP: 0,
    archWeights: { flow: 5, speed: 2, rhythm: 4, technical: 2 },
    stageNames: ["Vargasen", "Fredriksberg", "Hagfors", "Lekomberg", "Sagen", "Torntorp", "Knon"],
    weather: [
      { w: 4, id: "clear" }, { w: 3, id: "overcast" },
      { w: 3, id: "snowfall" }, { w: 1, id: "fog" },
    ],
  },
  {
    id: "monte", name: "Monte Carlo", flag: "MC",
    surface: "Tarmac", surfKey: "tarmac",
    radiusScale: 0.88, straightScale: 0.85,
    avgSpeed: 20.5, baseHalfWidth: 3.0, hilliness: 22, terrAmp: 5.5,
    ditch: 0, snowbank: false, jumpLove: false, crestFreq: 0.2,
    dontcutP: 0.35, offCamberP: 0.14, villageP: 0.25, barriers: true,
    archWeights: { flow: 1, speed: 1, rhythm: 3, technical: 6 },
    stageNames: ["Col de Braus", "Sospel", "La Bollene", "Turini", "Peira Cava", "Loda", "Luceram"],
    weather: [
      { w: 4, id: "clear" }, { w: 3, id: "sunset" }, { w: 2, id: "overcast" }, { w: 1, id: "fog" },
    ],
  },
  {
    id: "medit", name: "Mediterranean", flag: "GR",
    surface: "Tarmac", surfKey: "tarmac",
    radiusScale: 0.85, straightScale: 0.85,
    avgSpeed: 21.5, baseHalfWidth: 2.9, hilliness: 15, terrAmp: 4.2,
    ditch: 0, snowbank: false, jumpLove: false, crestFreq: 0.25,
    dontcutP: 0.35, offCamberP: 0.1, villageP: 0.5, walls: true,
    archWeights: { flow: 2, speed: 1, rhythm: 4, technical: 4 },
    stageNames: ["Anogia", "Kalithea", "Vourliotes", "Aghios Nikitas", "Platres", "Sella", "Skiathos"],
    weather: [
      { w: 6, id: "clear" }, { w: 3, id: "sunset" }, { w: 1, id: "overcast" },
    ],
  },
  {
    id: "desert", name: "Desert", flag: "MA",
    surface: "Loose gravel", surfKey: "dirt",
    radiusScale: 1.12, straightScale: 1.12,
    avgSpeed: 28.5, baseHalfWidth: 4.6, hilliness: 9, terrAmp: 3.0,
    ditch: 0, snowbank: false, jumpLove: true, crestFreq: 0.4,
    dontcutP: 0.2, offCamberP: 0.06, villageP: 0,
    archWeights: { flow: 4, speed: 5, rhythm: 2, technical: 1 },
    stageNames: ["Erfoud", "Zagora", "Tan Tan", "Ouarzazate", "Merzouga", "Tafraoute", "Assa"],
    weather: [
      { w: 6, id: "clear" }, { w: 3, id: "sunset" }, { w: 1, id: "overcast" },
    ],
  },
];

/* Grip tables. lat/long are peak friction coefficients; B controls how
 * sharply the tyre builds force, C how gently it falls off past the peak
 * (higher C = more forgiving slides). */
const SURFACES = {
  gravel:    { lat: 0.86, long: 0.88, B: 8.5,  C: 1.65, name: "Gravel" },
  gravelWet: { lat: 0.74, long: 0.76, B: 7.5,  C: 1.7,  name: "Wet gravel" },
  tarmac:    { lat: 1.12, long: 1.15, B: 12.5, C: 1.35, name: "Tarmac" },
  tarmacWet: { lat: 0.9,  long: 0.92, B: 10.0, C: 1.45, name: "Wet tarmac" },
  snow:      { lat: 0.5,  long: 0.5,  B: 6.0,  C: 1.85, name: "Snow" },
  dirt:      { lat: 0.8,  long: 0.82, B: 8.0,  C: 1.65, name: "Loose gravel" },
};
const OFFROAD = {
  finland: { lat: 0.6, long: 0.55, drag: 3.2, name: "grass" },
  wales:   { lat: 0.55, long: 0.5, drag: 4.0, name: "grass" },
  sweden:  { lat: 0.32, long: 0.3, drag: 7.5, name: "snowfield" },
  monte:   { lat: 0.75, long: 0.7, drag: 2.6, name: "verge" },
  medit:   { lat: 0.65, long: 0.6, drag: 3.0, name: "scrub" },
  desert:  { lat: 0.55, long: 0.5, drag: 5.0, name: "sand" },
};

const WEATHER_INFO = {
  clear:    { label: "Dry",      wet: false, fog: 0 },
  overcast: { label: "Dry",      wet: false, fog: 0.15 },
  sunset:   { label: "Dry",      wet: false, fog: 0.1 },
  rain:     { label: "Rain",     wet: true,  fog: 0.35 },
  fog:      { label: "Fog",      wet: true,  fog: 1.0 },
  snowfall: { label: "Snowfall", wet: false, fog: 0.45 },
};

/* Corner severity bands: radius range (m) and total angle range (deg). */
const SEV = {
  1:  { r: [20, 30],   a: [70, 110] },
  2:  { r: [32, 48],   a: [60, 100] },
  3:  { r: [52, 75],   a: [50, 90] },
  4:  { r: [78, 115],  a: [35, 70] },
  5:  { r: [120, 175], a: [25, 50] },
  6:  { r: [190, 320], a: [15, 38] },
  hp: { r: [11, 15],   a: [150, 185] },
  sq: { r: [16, 22],   a: [80, 100] },
};

/* --------------------------------------------------------- environment pick */

export function envForDay(day) {
  const raw = (d) => hash32(daySeed(d) ^ 0x454e56) % ENVS.length;
  let idx = raw(day);
  if (day > 0 && idx === raw(day - 1)) {
    idx = (idx + 1 + (hash32(daySeed(day) >>> 3) % (ENVS.length - 1))) % ENVS.length;
  }
  return ENVS[idx];
}

/* ------------------------------------------------------------- plan builder */

function pickArchetypes(r, env) {
  const keys = ["flow", "speed", "rhythm", "technical"];
  const first = r.weighted(keys.map((k) => ({ w: env.archWeights[k], k }))).k;
  let second = r.weighted(keys.map((k) => ({ w: env.archWeights[k] * (k === first ? 0.25 : 1), k }))).k;
  let third = r.weighted(keys.map((k) => ({ w: env.archWeights[k] * (k === second ? 0.2 : 1), k }))).k;
  return [first, second, third];
}

const ARCH = {
  flow:      { straight: [45, 115],  sevs: [{ w: 3, s: 6 }, { w: 4, s: 5 }, { w: 3, s: 4 }, { w: 1, s: 3 }], sP: 0.18, chiP: 0.05, hpP: 0.0 },
  speed:     { straight: [105, 220], sevs: [{ w: 4, s: 6 }, { w: 3, s: 5 }, { w: 2, s: 4 }], sP: 0.08, chiP: 0.1, hpP: 0.0 },
  rhythm:    { straight: [35, 85],   sevs: [{ w: 3, s: 3 }, { w: 3, s: 4 }, { w: 2, s: 2 }, { w: 1, s: 5 }], sP: 0.3, chiP: 0.12, hpP: 0.03 },
  technical: { straight: [22, 65],   sevs: [{ w: 2, s: 1 }, { w: 3, s: 2 }, { w: 3, s: 3 }, { w: 1, s: 4 }], sP: 0.12, chiP: 0.06, hpP: 0.22, sqP: 0.12 },
};

function buildPlan(r, env, targetLen) {
  const ops = [];
  const arches = pickArchetypes(r, env);
  let s = 0;
  let dirBias = 0;          // cumulative signed turn, radians
  let lastDirs = [];        // recent corner directions
  let jumps = 0, hairpins = 0;
  let lastWasCorner = false;

  const startLen = r.range(110, 170);
  ops.push({ t: "str", len: startLen, arch: "start" });
  s += startLen;

  const endReserve = 130;

  function pickDir() {
    let leftP = 0.5;
    if (dirBias > 1.6) leftP = 0.72;          // wandered right, bias back left
    if (dirBias < -1.6) leftP = 0.28;
    const n = lastDirs.length;
    if (n >= 2 && lastDirs[n - 1] === lastDirs[n - 2]) {
      leftP = lastDirs[n - 1] === 1 ? 0.2 : 0.8;   // avoid 3 in a row
    }
    return r.chance(leftP) ? 1 : -1;          // 1 = left
  }

  function corner(sev, opts) {
    const band = SEV[sev];
    const dir = (opts && opts.dir) || pickDir();
    const radius = r.range(band.r[0], band.r[1]) * (env.radiusScale || 1);
    const angle = (r.range(band.a[0], band.a[1]) * Math.PI) / 180;
    const op = {
      t: "corner", dir, sev, radius, angle, mods: {},
      camber: 0, vert: null, arch: (opts && opts.arch) || "?",
    };
    // modifiers
    if (typeof sev === "number") {
      const roll = r();
      if (roll < 0.14 && sev >= 2) { op.mods.tightens = Math.max(1, sev - r.int(1, 2)); }
      else if (roll < 0.24 && sev <= 5) { op.mods.opens = Math.min(6, sev + r.int(1, 2)); }
      else if (roll < 0.34) { op.mods.long = true; op.angle *= r.range(1.35, 1.6); }
      if (sev <= 3 && r.chance(env.dontcutP)) op.mods.dontcut = true;
      else if (sev >= 3 && sev <= 5 && r.chance(0.18)) op.mods.cut = true;
      if (r.chance(env.offCamberP)) { op.camber = -r.range(0.035, 0.06); op.mods.offcamber = true; }
      else if (r.chance(0.5)) { op.camber = r.range(0.02, 0.06); }
    } else {
      op.camber = r.chance(0.4) ? r.range(0.02, 0.05) : 0;
      if (sev === "hp" && r.chance(0.3)) op.mods.dontcut = true;
    }
    dirBias += dir * op.angle;
    lastDirs.push(dir);
    if (lastDirs.length > 4) lastDirs.shift();
    return op;
  }

  function opLen(op) {
    if (op.t === "str") return op.len;
    if (op.t === "corner") {
      let len = op.radius * op.angle;
      if (op.mods.tightens) len += SEV[op.mods.tightens].r[0] * 0.4;
      return len + 40; // clothoid allowance
    }
    return 0;
  }

  let archIdx = 0;
  while (s < targetLen - endReserve) {
    const frac = s / targetLen;
    archIdx = frac < 0.34 ? 0 : frac < 0.67 ? 1 : 2;
    const arch = ARCH[arches[archIdx]];
    const archName = arches[archIdx];

    // connector straight
    const stLen = r.range(arch.straight[0], arch.straight[1]) * (env.straightScale || 1);
    const st = { t: "str", len: stLen, arch: archName };
    // vertical features live on straights
    if (env.jumpLove && jumps < 2 && stLen > 130 && r.chance(0.45) && !lastWasCorner) {
      st.vert = "jump"; jumps++;
    } else if (r.chance(env.crestFreq * (archName === "technical" ? 0.4 : 1)) && stLen > 60) {
      st.vert = "crest";
    } else if (r.chance(0.18) && stLen > 50) {
      st.vert = "dip";
    }
    ops.push(st);
    s += stLen;

    // feature
    const roll = r();
    if (arch.hpP && roll < arch.hpP && hairpins < 3 && frac > 0.15) {
      ops.push(corner("hp", { arch: archName })); hairpins++;
    } else if (arch.sqP && roll < (arch.hpP || 0) + arch.sqP && frac > 0.1) {
      ops.push(corner("sq", { arch: archName }));
    } else if (roll < (arch.hpP || 0) + (arch.sqP || 0) + arch.sP) {
      // S-bend: two opposite medium corners, short link
      const sev = r.pick([3, 4, 4, 5]);
      const d = pickDir();
      const c1 = corner(sev, { dir: d, arch: archName });
      c1.angle = Math.min(c1.angle, (65 * Math.PI) / 180);
      ops.push(c1);
      ops.push({ t: "str", len: r.range(8, 26), arch: archName, link: true });
      const c2 = corner(Math.max(2, sev - r.int(0, 1)), { dir: -d, arch: archName });
      c2.angle = Math.min(c2.angle, (70 * Math.PI) / 180);
      ops.push(c2);
      s += opLen(c1) + 18 + opLen(c2);
      lastWasCorner = true;
      continue;
    } else if (roll < (arch.hpP || 0) + (arch.sqP || 0) + arch.sP + arch.chiP) {
      // chicane: two fast flicks
      const d = pickDir();
      const c1 = corner(5, { dir: d, arch: archName });
      c1.angle = r.range(0.3, 0.5); c1.mods = { chicane: true };
      ops.push(c1);
      ops.push({ t: "str", len: r.range(6, 14), arch: archName, link: true });
      const c2 = corner(5, { dir: -d, arch: archName });
      c2.angle = r.range(0.3, 0.5); c2.mods = { chicane: true };
      ops.push(c2);
      s += opLen(c1) + 10 + opLen(c2);
      lastWasCorner = true;
      continue;
    } else {
      const sev = r.weighted(arch.sevs).s;
      const c = corner(sev, { arch: archName });
      // crest hiding a corner: classic Finland
      if (env.crestFreq > 0.3 && r.chance(0.18) && sev >= 4) c.vert = "crest";
      ops.push(c);
      s += opLen(c);
    }
    lastWasCorner = true;
  }

  ops.push({ t: "str", len: 120, arch: "finish" });
  return { ops, arches };
}

/* ------------------------------------------------------------ plan compiler */

function compile(plan, r, env) {
  // Emit per-DS curvature / camber / width, and remember feature positions.
  const curv = [], camb = [], hwid = [], vertMarks = [], noteMarks = [], flags = [];
  const baseHw = env.baseHalfWidth;
  let sCursor = 0;

  function emit(len, fn) {
    const n = Math.max(1, Math.round(len / DS));
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const v = fn(t);
      curv.push(v.k || 0);
      camb.push(v.c || 0);
      hwid.push(v.w != null ? v.w : baseHw);
      flags.push(v.f || 0);
    }
    sCursor += n * DS;
  }

  for (let oi = 0; oi < plan.ops.length; oi++) {
    const op = plan.ops[oi];
    if (op.t === "str") {
      const startS = sCursor;
      let narrowW = null;
      if (op.bridge) narrowW = baseHw * 0.62;
      emit(op.len, (t) => {
        let w = baseHw;
        if (narrowW) {
          const edge = Math.min(t, 1 - t) * op.len;   // metres from either end
          const blend = Math.min(1, edge / 25);
          w = baseHw + (narrowW - baseHw) * blend;
        }
        return { k: 0, c: 0, w, f: op.bridge ? 1 : (op.village ? 2 : 0) };
      });
      if (op.vert) {
        const at = startS + op.len * (op.vert === "jump" ? 0.62 : r.range(0.4, 0.7));
        vertMarks.push({ s: at, kind: op.vert });
      }
    } else if (op.t === "corner") {
      const k1 = op.dir / op.radius;      // left = positive curvature
      const Lc = Math.min(40, Math.max(8, op.radius * 0.45));
      // cross-slope tan, dy per metre leftward. Helpful banking = outside edge
      // high: for a left corner that means right side high -> negative slope.
      const camber = -op.dir * op.camber;
      const noteS = sCursor;              // note anchored at entry clothoid start

      // entry clothoid
      emit(Lc, (t) => ({ k: k1 * t, c: camber * t }));

      const rampAngle = Math.abs(k1) * Lc; // angle consumed by both clothoids combined (avg k = k/2 each)
      let arcAngle = Math.max(0.06, op.angle - rampAngle);

      if (op.mods.tightens) {
        const band2 = SEV[op.mods.tightens];
        const r2 = (band2.r[0] + band2.r[1]) / 2;
        const k2 = op.dir / r2;
        const a1 = arcAngle * 0.5, a2 = arcAngle * 0.5;
        emit((a1 / Math.abs(k1)), () => ({ k: k1, c: camber }));
        emit(14, (t) => ({ k: k1 + (k2 - k1) * t, c: camber }));
        emit((a2 / Math.abs(k2)), () => ({ k: k2, c: camber }));
        emit(Lc, (t) => ({ k: k2 * (1 - t), c: camber * (1 - t) }));
      } else if (op.mods.opens) {
        const band2 = SEV[op.mods.opens];
        const r2 = (band2.r[0] + band2.r[1]) / 2;
        const k2 = op.dir / r2;
        const a1 = arcAngle * 0.55, a2 = arcAngle * 0.45;
        emit((a1 / Math.abs(k1)), () => ({ k: k1, c: camber }));
        emit(14, (t) => ({ k: k1 + (k2 - k1) * t, c: camber }));
        emit((a2 / Math.abs(k2)), () => ({ k: k2, c: camber }));
        emit(Lc, (t) => ({ k: k2 * (1 - t), c: camber * (1 - t) }));
      } else {
        emit(arcAngle / Math.abs(k1), () => ({ k: k1, c: camber }));
        emit(Lc, (t) => ({ k: k1 * (1 - t), c: camber * (1 - t) }));
      }

      noteMarks.push({
        s: noteS, endS: sCursor, kind: "corner",
        dir: op.dir, sev: op.sev, mods: op.mods, vert: op.vert, radius: op.radius,
        camber: op.camber, arch: op.arch,
      });
      if (op.vert) vertMarks.push({ s: Math.max(0, noteS - 10), kind: op.vert, beforeCorner: true });
    }
  }

  return { curv, camb, hwid, flags, vertMarks, noteMarks, length: sCursor };
}

/* -------------------------------------------------- centreline + elevation */

function integrate(comp, r, env, seed) {
  const n = comp.curv.length;
  const x = new Float64Array(n), z = new Float64Array(n), y = new Float64Array(n);
  const heading = new Float64Array(n), sArr = new Float64Array(n);

  let hx = 0, hz = 0, th = 0;
  for (let i = 0; i < n; i++) {
    x[i] = hx; z[i] = hz; heading[i] = th; sArr[i] = i * DS;
    th += comp.curv[i] * DS;
    hx += Math.cos(th) * DS;
    hz += Math.sin(th) * DS;
  }

  // ---- elevation: macro rolling + sector trends + local features
  const p1 = r.range(0, Math.PI * 2), p2 = r.range(0, Math.PI * 2), p3 = r.range(0, Math.PI * 2);
  const A1 = env.hilliness * r.range(0.7, 1.15);
  const A2 = A1 * 0.38, A3 = A1 * 0.16;
  const L = (n - 1) * DS;
  const trends = [r.range(-0.045, 0.045), r.range(-0.055, 0.055), r.range(-0.045, 0.045)];

  for (let i = 0; i < n; i++) {
    const s = i * DS;
    let e = A1 * Math.sin((s * 2 * Math.PI) / 950 + p1)
          + A2 * Math.sin((s * 2 * Math.PI) / 420 + p2)
          + A3 * Math.sin((s * 2 * Math.PI) / 190 + p3);
    const sector = Math.min(2, Math.floor((s / L) * 3));
    for (let sec = 0; sec < sector; sec++) e += trends[sec] * (L / 3);
    e += trends[sector] * (s - sector * (L / 3));
    y[i] = e;
  }

  // features
  for (const vm of comp.vertMarks) {
    const i0 = Math.round(vm.s / DS);
    let h, w;
    if (vm.kind === "jump") { h = r.range(1.3, 2.2); w = r.range(8, 11); }
    else if (vm.kind === "crest") { h = r.range(1.2, 2.4); w = r.range(15, 22); }
    else { h = -r.range(1.2, 2.2); w = r.range(12, 18); }
    vm.h = h; vm.w = w;
    const span = Math.ceil((w * 3) / DS);
    for (let i = Math.max(0, i0 - span); i < Math.min(n, i0 + span); i++) {
      const d = (i - i0) * DS;
      y[i] += h * Math.exp(-(d * d) / (w * w));
    }
  }

  // clamp grade (two passes) then smooth
  const maxG = 0.16 * DS;
  for (let i = 1; i < n; i++) {
    if (y[i] - y[i - 1] > maxG) y[i] = y[i - 1] + maxG;
    if (y[i] - y[i - 1] < -maxG) y[i] = y[i - 1] - maxG;
  }
  for (let i = n - 2; i >= 0; i--) {
    if (y[i] - y[i + 1] > maxG) y[i] = y[i + 1] + maxG;
    if (y[i] - y[i + 1] < -maxG) y[i] = y[i + 1] - maxG;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < n - 1; i++) y[i] = (y[i - 1] + 2 * y[i] + y[i + 1]) / 4;
  }
  // flatten the start pad so the launch is clean
  for (let i = 0; i < Math.min(n, 25); i++) y[i] = y[Math.min(n - 1, 25)] * (i / 25) * (i / 25) + y[Math.min(n - 1, 25)] * 0; // ease from 0-ish
  const y0 = y[0];
  for (let i = 0; i < n; i++) y[i] -= y0;

  const grade = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) grade[i] = (y[i + 1] - y[i - 1]) / (2 * DS);
  grade[0] = grade[1]; grade[n - 1] = grade[n - 2];

  return { n, x, z, y, sArr, heading, grade };
}

/* -------------------------------------------------------- terrain function */

function makeTerrain(seed, env) {
  function lattice(ix, iz) {
    return hash32(Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ seed) / 4294967296;
  }
  function value(px, pz) {
    const ix = Math.floor(px), iz = Math.floor(pz);
    const fx = px - ix, fz = pz - iz;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = lattice(ix, iz), b = lattice(ix + 1, iz);
    const c = lattice(ix, iz + 1), d = lattice(ix + 1, iz + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  }
  return function terrainH(wx, wz) {
    const o1 = value(wx / 90, wz / 90) - 0.5;
    const o2 = value(wx / 23 + 37.7, wz / 23 - 11.3) - 0.5;
    return o1 * env.terrAmp * 2 + o2 * env.terrAmp * 0.55;
  };
}

/* ------------------------------------------------------------- road query */

const CELL = 16;

function buildGrid(geo) {
  const grid = new Map();
  for (let i = 0; i < geo.n; i++) {
    const key = Math.floor(geo.x[i] / CELL) + "," + Math.floor(geo.z[i] / CELL);
    let arr = grid.get(key);
    if (!arr) { arr = []; grid.set(key, arr); }
    arr.push(i);
  }
  return grid;
}

function makeRoadQuery(stage) {
  const { geo, grid } = stage;
  const { x, z, n } = geo;
  /* hintS: previous known s for continuity. Where two parts of the stage pass
   * close to each other the raw nearest sample can belong to the wrong leg of
   * the road; the hint keeps the association coherent. */
  return function roadQuery(px, pz, hintS) {
    const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
    const hintI = hintS != null ? Math.round(hintS / DS) : null;
    let best = -1, bestD2 = Infinity;
    let bestH = -1, bestHD2 = Infinity;   // best among hint-coherent samples
    for (let radius = 1; radius <= 3 && best < 0; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const arr = grid.get((cx + dx) + "," + (cz + dz));
          if (!arr) continue;
          for (let k = 0; k < arr.length; k++) {
            const i = arr[k];
            const ddx = x[i] - px, ddz = z[i] - pz;
            const d2 = ddx * ddx + ddz * ddz;
            if (d2 < bestD2) { bestD2 = d2; best = i; }
            // window must stay under a hairpin's leg separation (~34 m of s)
            if (hintI != null && Math.abs(i - hintI) < 14 && d2 < bestHD2) { bestHD2 = d2; bestH = i; }
          }
        }
      }
    }
    if (bestH >= 0 && bestHD2 < 30 * 30) best = bestH;
    if (best < 0) return null;
    // refine: project onto the two segments around `best`
    let bi = best, bt = 0, bd2 = Infinity;
    for (let i = Math.max(0, best - 2); i < Math.min(n - 1, best + 2); i++) {
      const ax = x[i], az = z[i];
      const bx = x[i + 1] - ax, bz = z[i + 1] - az;
      const len2 = bx * bx + bz * bz;
      let t = len2 > 0 ? ((px - ax) * bx + (pz - az) * bz) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + bx * t, qz = az + bz * t;
      const d2 = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
      if (d2 < bd2) { bd2 = d2; bi = i; bt = t; }
    }
    const i0 = bi, i1 = Math.min(n - 1, bi + 1);
    const lerp = (arr) => arr[i0] + (arr[i1] - arr[i0]) * bt;
    const tx = Math.cos(geo.heading[i0]), tz = Math.sin(geo.heading[i0]);
    const ox = px - (x[i0] + (x[i1] - x[i0]) * bt);
    const oz = pz - (z[i0] + (z[i1] - z[i0]) * bt);
    // signed lateral offset: positive = left of direction of travel
    const d = tx * oz - tz * ox > 0 ? Math.sqrt(bd2) : -Math.sqrt(bd2);
    return {
      s: (i0 + bt) * DS,
      d,
      y: lerp(geo.y),
      hw: stage.hwArr[i0] + (stage.hwArr[i1] - stage.hwArr[i0]) * bt,
      camberT: stage.cambArr[i0] + (stage.cambArr[i1] - stage.cambArr[i0]) * bt,
      grade: lerp(geo.grade),
      curv: stage.curvArr[i0],
      flag: stage.flagArr[i0],
      heading: geo.heading[i0],
      idx: i0,
    };
  };
}

function makeGroundHeight(stage) {
  const q = stage.roadQuery, terr = stage.terrain, env = stage.env;
  return function groundHeight(px, pz, hintS) {
    const rq = q(px, pz, hintS);
    if (!rq) return null;
    const ad = Math.abs(rq.d);
    const hw = rq.hw;
    const edgeY = rq.y + rq.camberT * (rq.d > 0 ? hw : -hw);
    const roadY = rq.y + rq.camberT * Math.max(-hw, Math.min(hw, rq.d));

    if (rq.flag & 1) {
      // bridge: beyond the deck there is nothing but air
      if (ad <= hw + 0.4) return { y: roadY, on: "road", rq };
      return { y: roadY - 7, on: "void", rq };
    }
    if (ad <= hw) return { y: roadY, on: "road", rq };

    const terrY = rq.y + terr(px, pz) * Math.min(1, (ad - hw) / 14) ;
    if (env.snowbank) {
      // snow berm rises just off the road edge
      const bd = ad - hw;
      if (bd < 2.6) {
        const t = bd / 2.6;
        return { y: edgeY + Math.sin(t * Math.PI) * 0.85 + t * 0.25, on: "bank", rq };
      }
      return { y: Math.max(edgeY + 0.4, terrY + 0.4), on: "off", rq };
    }
    // shoulder, optional ditch, then terrain
    const shoulderEnd = hw + 0.9;
    if (ad <= shoulderEnd) return { y: edgeY - (ad - hw) * 0.12, on: "shoulder", rq };
    if (env.ditch > 0) {
      const ditchMid = hw + 2.0, ditchEnd = hw + 3.2;
      if (ad <= ditchEnd) {
        const t = (ad - shoulderEnd) / (ditchEnd - shoulderEnd);
        const dip = Math.sin(t * Math.PI) * env.ditch;
        return { y: edgeY - 0.1 - dip, on: "ditch", rq };
      }
      const blend = Math.min(1, (ad - ditchEnd) / 5);
      return { y: (edgeY - 0.1) * (1 - blend) + terrY * blend, on: "off", rq };
    }
    const blend = Math.min(1, (ad - shoulderEnd) / 5);
    return { y: (edgeY - 0.1) * (1 - blend) + terrY * blend, on: "off", rq };
  };
}

/* ----------------------------------------------------------- speed profile */

/* Backward/forward pass over curvature -> attainable speed at every sample.
 * Mirrors the real car's grip and power closely enough to predict times and
 * to time pace-note calls. */
export function speedProfile(stage) {
  const n = stage.geo.n;
  const grip = stage.grip;
  const vmax = new Float64Array(n);
  const VCAP = 57;
  for (let i = 0; i < n; i++) {
    const k = Math.abs(stage.curvArr[i]);
    // positive when the banking helps the corner (outside edge high)
    const bankHelp = -stage.cambArr[i] * Math.sign(stage.curvArr[i] || 1);
    // 0.92: the real car's usable lateral grip vs the tyre table (skidpad-measured)
    const mu = grip.lat * 0.92 * (1 + Math.max(-0.35, Math.min(0.35, bankHelp * 5)));
    vmax[i] = k > 1e-5 ? Math.min(VCAP, Math.sqrt((mu * G) / k)) : VCAP;
  }
  // no braking while airborne: jumps and sharp crests carry the entry speed
  // through to the landing, so the backward pass must not "brake" across them
  const noBrake = new Uint8Array(n);
  for (const vm of stage.comp.vertMarks) {
    const from = vm.kind === "jump" ? vm.s - 6 : vm.kind === "crest" ? vm.s - 4 : null;
    if (from == null) continue;
    const to = vm.kind === "jump" ? vm.s + 62 : vm.s + 26;
    for (let i = Math.max(0, Math.round(from / DS)); i < Math.min(n, Math.round(to / DS)); i++) noBrake[i] = 1;
  }
  const v = Float64Array.from(vmax);
  v[n - 1] = vmax[n - 1];
  const decel = grip.long * G * 0.92;
  for (let i = n - 2; i >= 0; i--) {
    if (noBrake[i]) { v[i] = Math.min(vmax[i], v[i + 1]); continue; }
    // downhill (grade < 0) steals braking capability, uphill adds it
    const d = decel + stage.geo.grade[i] * G;
    v[i] = Math.min(vmax[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * Math.max(2, d) * DS));
  }
  v[0] = 0;
  const P = 195000, m = 1230;
  for (let i = 1; i < n; i++) {
    const vp = Math.max(3, v[i - 1]);
    const drag = 0.36 * vp * vp / m + 0.012 * G;
    const acc = Math.min(grip.long * G * 0.9, P / (m * vp)) - drag - stage.geo.grade[i] * G;
    const reach = Math.sqrt(Math.max(1, v[i - 1] * v[i - 1] + 2 * Math.max(0.4, acc) * DS));
    v[i] = Math.min(v[i], reach);
  }
  let time = 0;
  const timeAt = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    time += DS / Math.max(2.5, (v[i] + v[i - 1]) / 2);
    timeAt[i] = time;
  }
  return { v, time, timeAt, vmax };
}

/* -------------------------------------------------------------- pace notes */

const NUM_WORDS = { 30: "thirty", 50: "fifty", 80: "eighty", 100: "one hundred", 150: "one fifty", 200: "two hundred", 250: "two fifty", 300: "three hundred" };
const DIST_STEPS = [50, 80, 100, 150, 200, 250, 300];

function severityWord(sev) {
  if (sev === "hp") return "hairpin";
  if (sev === "sq") return "square";
  return String(sev);
}

function buildNotes(stage) {
  const marks = stage.comp.noteMarks;
  const verts = stage.comp.vertMarks.filter((v) => !v.beforeCorner);
  const notes = [];

  for (const m of marks) {
    const dirWord = m.dir === 1 ? "left" : "right";
    const dirCh = m.dir === 1 ? "L" : "R";
    let label, spoken;
    if (m.sev === "hp") { label = dirCh + " hairpin"; spoken = "hairpin " + dirWord; }
    else if (m.sev === "sq") { label = dirCh + " square"; spoken = "square " + dirWord; }
    else if (m.sev === 6) { label = "flat " + dirCh; spoken = "flat " + dirWord; }
    else { label = dirCh + m.sev; spoken = dirWord + " " + severityWord(m.sev); }

    const modBits = [], modSpoken = [];
    if (m.mods.long) { modBits.push("long"); modSpoken.push("long"); }
    if (m.mods.tightens) { modBits.push("tightens " + m.mods.tightens); modSpoken.push("tightens " + severityWord(m.mods.tightens)); }
    if (m.mods.opens) { modBits.push("opens " + m.mods.opens); modSpoken.push("opens " + severityWord(m.mods.opens)); }
    if (m.mods.offcamber) { modBits.push("off camber"); modSpoken.push("off camber"); }
    if (m.mods.dontcut) { modBits.push("don't cut"); modSpoken.push("don't cut"); }
    if (m.mods.cut) { modBits.push("cut"); modSpoken.push("cut"); }

    let pre = "", preSpoken = "";
    if (m.vert === "crest") { pre = "over crest "; preSpoken = "over crest, "; }
    if (m.vert === "jump") { pre = "jump into "; preSpoken = "jump, into "; }

    const sevNum = m.sev === "hp" ? 0.5 : m.sev === "sq" ? 1 : m.sev;
    notes.push({
      s: m.s, endS: m.endS, kind: "corner",
      sev: m.sev, sevNum, dir: m.dir,
      label: pre + label + (modBits.length ? " " + modBits.join(", ") : ""),
      spoken: preSpoken + spoken + (modSpoken.length ? ", " + modSpoken.join(", ") : ""),
      caution: (m.vert === "jump" && sevNum <= 3) || (m.mods.offcamber && sevNum <= 3),
    });
  }

  for (const vm of verts) {
    let label, spoken;
    if (vm.kind === "jump") { label = "jump"; spoken = "big jump"; }
    else if (vm.kind === "crest") { label = "crest"; spoken = "over crest"; }
    else { label = "dip"; spoken = "dip"; }
    notes.push({ s: vm.s - vm.w, endS: vm.s + vm.w, kind: vm.kind, sevNum: 6, label, spoken, caution: vm.kind === "jump" });
  }

  notes.sort((a, b) => a.s - b.s);

  // deduplicate marks that landed on top of each other
  for (let i = notes.length - 2; i >= 0; i--) {
    if (notes[i + 1].s - notes[i].s < 6 && notes[i].kind !== "corner") notes.splice(i, 1);
  }

  // chain "into" + distance suffixes
  for (let i = 0; i < notes.length - 1; i++) {
    const gap = notes[i + 1].s - notes[i].endS;
    if (gap < 30) {
      notes[i].into = true;
    } else if (gap > 120) {
      let best = DIST_STEPS[0];
      for (const d of DIST_STEPS) if (Math.abs(d - gap) < Math.abs(best - gap)) best = d;
      notes[i].dist = best;
      notes[i].distSpoken = NUM_WORDS[best] || String(best);
    }
  }
  if (notes.length) {
    const last = notes[notes.length - 1];
    last.toFinish = true;
  }
  return notes;
}

/* -------------------------------------------------------------- checkpoints */

function buildCheckpoints(stage) {
  const L = stage.length;
  const cps = [];
  let s = 150;
  const anchors = stage.notes
    .filter((nt) => nt.sevNum <= 1)
    .map((nt) => (nt.s + nt.endS) / 2);
  while (s < L - 90) {
    cps.push(s);
    s += 145;
  }
  for (const a of anchors) {
    let near = false;
    for (const c of cps) if (Math.abs(c - a) < 60) near = true;
    if (!near && a > 100 && a < L - 100) cps.push(a);
  }
  cps.sort((a, b) => a - b);
  const splits = [
    cps.reduce((best, c) => (Math.abs(c - L / 3) < Math.abs(best - L / 3) ? c : best), cps[0]),
    cps.reduce((best, c) => (Math.abs(c - (2 * L) / 3) < Math.abs(best - (2 * L) / 3) ? c : best), cps[0]),
  ];
  return { cps, splits };
}

/* ----------------------------------------------------------------- scenery */

function minDistToTrack(stage, px, pz) {
  const rq = stage.roadQuery(px, pz);
  return rq ? Math.abs(rq.d) - rq.hw : 999;
}

function buildScenery(stage, r) {
  const env = stage.env;
  const geo = stage.geo;
  const items = [];   // {t, x, y, z, sc, rot}
  const colliders = []; // {x, z, r, kind, y}

  const treeTypes = {
    finland: [{ t: "pine", w: 6 }, { t: "spruce", w: 3 }, { t: "birch", w: 3 }],
    wales: [{ t: "spruce", w: 5 }, { t: "blob", w: 4 }, { t: "bush", w: 2 }],
    sweden: [{ t: "spruceSnow", w: 7 }, { t: "birch", w: 2 }],
    monte: [{ t: "cypress", w: 3 }, { t: "blob", w: 3 }, { t: "rock", w: 3 }],
    medit: [{ t: "olive", w: 4 }, { t: "cypress", w: 3 }, { t: "bush", w: 2 }],
    desert: [{ t: "cactus", w: 2 }, { t: "rockRed", w: 5 }, { t: "shrub", w: 4 }],
  }[env.id];

  const gh = stage.groundHeight;

  function place(t, px, pz, sc, collideR, rot) {
    const g = gh(px, pz);
    if (!g) return null;
    const it = { t, x: px, y: g.y, z: pz, sc, rot: rot != null ? rot : r.range(0, Math.PI * 2) };
    items.push(it);
    if (collideR) colliders.push({ x: px, z: pz, r: collideR, kind: t, y: g.y });
    return it;
  }

  // --- roadside vegetation, clumped by a slow noise gate
  const step = env.id === "desert" ? 9 : 5;
  for (let s = 30; s < stage.length - 40; s += step) {
    const i = Math.min(geo.n - 1, Math.round(s / DS));
    const tx = Math.cos(geo.heading[i]), tz = Math.sin(geo.heading[i]);
    const nx = -tz, nz = tx;
    for (let side = -1; side <= 1; side += 2) {
      const gate = Math.sin(s * 0.011 + side * 2.1) + Math.sin(s * 0.0037 + side);
      if (gate < (env.id === "desert" ? 0.4 : -0.55)) continue;
      const count = r.int(1, 2);
      const nearMin = env.id === "desert" ? 5.5 : 2.5;
      for (let cIdx = 0; cIdx < count; cIdx++) {
        const off = stage.hwArr[i] + (r.chance(0.3) ? r.range(nearMin, nearMin + 4.5) : r.range(7, 42));
        const px = geo.x[i] + nx * off * side;
        const pz = geo.z[i] + nz * off * side;
        if (minDistToTrack(stage, px, pz) < 1.6) continue;
        const type = r.weighted(treeTypes).t;
        const near = off < stage.hwArr[i] + 8;
        const isTree = type !== "bush" && type !== "shrub" && type !== "rock" && type !== "rockRed";
        place(type, px, pz, r.range(0.8, 1.5), near && isTree ? 0.4 : (near && (type === "rock" || type === "rockRed") ? 0.9 : 0));
      }
    }
  }

  // --- Sweden snow poles
  if (env.snowbank) {
    for (let s = 20; s < stage.length - 20; s += 12) {
      const i = Math.round(s / DS);
      const tx = Math.cos(geo.heading[i]), tz = Math.sin(geo.heading[i]);
      for (let side = -1; side <= 1; side += 2) {
        const off = stage.hwArr[i] + 0.7;
        place("snowpole", geo.x[i] - tz * off * side, geo.z[i] + tx * off * side, 1, 0);
      }
    }
  }

  // --- don't-cut furniture on inside apexes, barriers on drops
  for (const nt of stage.notes) {
    if (nt.kind !== "corner") continue;
    const midS = (nt.s + nt.endS) / 2;
    const i = Math.min(geo.n - 1, Math.round(midS / DS));
    const tx = Math.cos(geo.heading[i]), tz = Math.sin(geo.heading[i]);
    const inSide = nt.dir === 1 ? 1 : -1;   // left corner: inside is left (+d)

    if (nt.label.indexOf("don't cut") >= 0) {
      const span = Math.min(nt.endS - nt.s, 60);
      const count = r.int(3, 5);
      for (let kIdx = 0; kIdx < count; kIdx++) {
        const ss = nt.s + 14 + (span - 14) * (kIdx / Math.max(1, count - 1));
        const ii = Math.min(geo.n - 1, Math.round(ss / DS));
        const ttx = Math.cos(geo.heading[ii]), ttz = Math.sin(geo.heading[ii]);
        const off = stage.hwArr[ii] + r.range(0.5, 1.3);
        const px = geo.x[ii] - ttz * off * inSide;
        const pz = geo.z[ii] + ttx * off * inSide;
        const kind = env.id === "sweden" ? "snowwall" : r.pick(["rock", "rock", "post"]);
        place(kind, px, pz, r.range(0.8, 1.2), kind === "post" ? 0.25 : 0.85,
          kind === "snowwall" ? -geo.heading[ii] : undefined);
      }
    }

    // spectators at the slow stuff
    if (nt.sevNum <= 2 && r.chance(0.5)) {
      const outSide = -inSide;
      const count = r.int(4, 9);
      for (let kIdx = 0; kIdx < count; kIdx++) {
        const ss = nt.s + r.range(-25, 10);
        const ii = Math.max(0, Math.min(geo.n - 1, Math.round(ss / DS)));
        const ttx = Math.cos(geo.heading[ii]), ttz = Math.sin(geo.heading[ii]);
        const off = stage.hwArr[ii] + r.range(3.5, 7.5);
        const px = geo.x[ii] - ttz * off * outSide;
        const pz = geo.z[ii] + ttx * off * outSide;
        if (minDistToTrack(stage, px, pz) < 2.2) continue;
        place("spectator", px, pz, r.range(0.92, 1.06), 0);
      }
    }
  }

  // --- barriers along outside of corners for tarmac mountain envs
  if (env.barriers || env.walls) {
    for (const nt of stage.notes) {
      if (nt.kind !== "corner" || nt.sevNum > 3) continue;
      if (!r.chance(0.75)) continue;
      const outSide = nt.dir === 1 ? -1 : 1;
      for (let ss = nt.s + 6; ss < nt.endS - 4; ss += 2.6) {
        const ii = Math.min(geo.n - 1, Math.round(ss / DS));
        const ttx = Math.cos(geo.heading[ii]), ttz = Math.sin(geo.heading[ii]);
        const off = stage.hwArr[ii] + 1.7;
        const px = geo.x[ii] - ttz * off * outSide;
        const pz = geo.z[ii] + ttx * off * outSide;
        // aligned with the road so the row reads as a continuous wall
        place(env.walls ? "wall" : "barrier", px, pz, 1, 0.45, -geo.heading[ii]);
      }
    }
  }

  // --- villages: line a straight with houses (tarmac envs)
  stage.village = null;
  if (env.villageP > 0 && r.chance(env.villageP)) {
    let best = null;
    for (const op of stage.planStraights) {
      if (op.len > 90 && op.s > stage.length * 0.25 && op.s < stage.length * 0.75) { best = op; break; }
    }
    if (best) {
      stage.village = { s0: best.s + 10, s1: best.s + best.len - 10 };
      for (let ss = stage.village.s0; ss < stage.village.s1; ss += r.range(14, 22)) {
        const ii = Math.min(geo.n - 1, Math.round(ss / DS));
        const ttx = Math.cos(geo.heading[ii]), ttz = Math.sin(geo.heading[ii]);
        for (let side = -1; side <= 1; side += 2) {
          if (!r.chance(0.85)) continue;
          const off = stage.hwArr[ii] + r.range(4.4, 6.0);
          const px = geo.x[ii] - ttz * off * side;
          const pz = geo.z[ii] + ttx * off * side;
          if (minDistToTrack(stage, px, pz) < 3.4) continue;
          place("house", px, pz, r.range(0.9, 1.25), 2.3, -geo.heading[ii]);
        }
      }
    }
  }

  // start / finish arches
  items.push({ t: "startArch", x: geo.x[5], y: geo.y[5], z: geo.z[5], sc: 1, rot: geo.heading[5], hw: stage.hwArr[5] });
  const fi = geo.n - 8;
  items.push({ t: "finishArch", x: geo.x[fi], y: geo.y[fi], z: geo.z[fi], sc: 1, rot: geo.heading[fi], hw: stage.hwArr[fi] });

  // collider spatial hash
  const chash = new Map();
  for (const c of colliders) {
    const key = Math.floor(c.x / 8) + "," + Math.floor(c.z / 8);
    let arr = chash.get(key);
    if (!arr) { arr = []; chash.set(key, arr); }
    arr.push(c);
  }

  stage.scenery = items;
  stage.colliders = colliders;
  stage.colliderHash = chash;
}

/* -------------------------------------------------------------- validation */

function validate(stage) {
  const geo = stage.geo;
  const issues = [];
  // self intersection / near miss
  const grid = new Map();
  let nearMiss = 0;
  for (let i = 0; i < geo.n; i++) {
    const key = Math.floor(geo.x[i] / 10) + "," + Math.floor(geo.z[i] / 10);
    let arr = grid.get(key);
    if (!arr) { arr = []; grid.set(key, arr); }
    arr.push(i);
  }
  outer:
  for (let i = 0; i < geo.n; i += 2) {
    const cx = Math.floor(geo.x[i] / 10), cz = Math.floor(geo.z[i] / 10);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const arr = grid.get((cx + dx) + "," + (cz + dz));
      if (!arr) continue;
      for (const j of arr) {
        if (Math.abs(i - j) * DS < 45) continue;
        const d2 = (geo.x[i] - geo.x[j]) ** 2 + (geo.z[i] - geo.z[j]) ** 2;
        const lim = stage.hwArr[i] + stage.hwArr[j];
        if (d2 < (lim + 4) * (lim + 4)) { issues.push("self-intersection"); break outer; }
        if (d2 < (lim + 14) * (lim + 14)) nearMiss++;
      }
    }
  }
  stage.nearMiss = nearMiss;
  if (nearMiss > 40) issues.push("crowded layout");

  for (let i = 0; i < geo.n; i++) {
    if (!isFinite(geo.y[i]) || !isFinite(geo.x[i])) { issues.push("NaN geometry"); break; }
  }
  const corners = stage.notes.filter((nt) => nt.kind === "corner").length;
  if (corners < 8) issues.push("too few corners");
  const est = stage.profile.time * 1.045;
  if (est < 44 || est > 80) issues.push("bad duration " + est.toFixed(1));
  return issues;
}

function qualityScore(stage) {
  let score = 0;
  const sevSet = new Set();
  let hairpins = 0;
  const cornerNotes = stage.notes.filter((nt) => nt.kind === "corner");
  for (const nt of cornerNotes) {
    sevSet.add(nt.sev);
    if (nt.sev === "hp") hairpins++;
  }
  score += sevSet.size * 1.2;
  score += Math.min(4.5, cornerNotes.length * 0.3);
  const elevRange = Math.max(...stage.geo.y) - Math.min(...stage.geo.y);
  score += Math.min(3, elevRange / 12);
  score += stage.comp.vertMarks.length * 0.5;
  score -= Math.abs(stage.profile.time * 1.045 - 60) * 0.08;
  score -= stage.nearMiss * 0.05;
  if (stage.env.id === "monte" && hairpins === 0) score -= 2;
  if (hairpins > 2) score -= (hairpins - 2) * 1.5;
  // rhythm: penalize monotone severity runs
  let runs = 0;
  for (let i = 2; i < cornerNotes.length; i++) {
    if (cornerNotes[i].sev === cornerNotes[i - 1].sev && cornerNotes[i].sev === cornerNotes[i - 2].sev) runs++;
  }
  score -= runs * 0.8;
  return score;
}

/* ------------------------------------------------------------ stage builder */

function generateCandidate(seed, env, targetLen) {
  const r = rng(seed);
  const plan = buildPlan(r, env, targetLen);
  const comp = compile(plan, r, env);
  const geo = integrate(comp, r, env, seed);

  const stage = {
    seed, env, plan, comp, geo,
    length: (geo.n - 1) * DS,
    curvArr: comp.curv, cambArr: comp.camb, hwArr: comp.hwid, flagArr: comp.flags,
  };
  // straight positions for village placement
  stage.planStraights = [];
  let sAcc = 0;
  for (const op of plan.ops) {
    if (op.t === "str") stage.planStraights.push({ s: sAcc, len: op.len });
    sAcc += op.t === "str" ? op.len : op.radius * op.angle + 60;
  }

  stage.grid = buildGrid(geo);
  stage.roadQuery = makeRoadQuery(stage);
  stage.terrain = makeTerrain(hash32(seed ^ 0x7455), env);
  stage.groundHeight = makeGroundHeight(stage);
  stage.notes = buildNotes(stage);
  return stage;
}

export function generateStage(day, opts) {
  const baseSeed = daySeed(day);
  const env = (opts && opts.env) || envForDay(day);
  const wr = rng(hash32(baseSeed ^ 0x57454154));
  const weatherId = wr.weighted(env.weather).id;
  const weather = WEATHER_INFO[weatherId];

  let surfKey = env.surfKey;
  if (weather.wet && surfKey === "gravel") surfKey = "gravelWet";
  if (weather.wet && surfKey === "tarmac") surfKey = "tarmacWet";
  const grip = SURFACES[surfKey];

  const candidates = [];
  let tried = 0;
  for (let c = 0; c < 40 && candidates.length < 8; c++) {
    tried++;
    const seed = hash32(baseSeed + c * 7919);
    // two-pass length calibration
    let stage = null;
    let targetLen = 58 * env.avgSpeed * (grip.lat / SURFACES[env.surfKey].lat);
    for (let pass = 0; pass < 2; pass++) {
      stage = generateCandidate(seed, env, targetLen);
      stage.grip = grip;
      stage.profile = speedProfile(stage);
      const est = stage.profile.time * 1.045;
      if (pass === 0) {
        const scale = Math.max(0.6, Math.min(1.6, 58 / est));
        if (Math.abs(scale - 1) < 0.06) break;
        targetLen *= scale;
      }
    }
    const issues = validate(stage);
    if (issues.length === 0) {
      stage.quality = qualityScore(stage);
      candidates.push(stage);
    } else if (c === 39 && candidates.length === 0) {
      stage.quality = -99;
      stage.issues = issues;
      candidates.push(stage); // last-resort fallback, should never happen
    }
  }

  candidates.sort((a, b) => b.quality - a.quality);

  function finalize(stage) {
    if (stage.finalized) return stage;
    stage.finalized = true;
    const fr = rng(hash32(stage.seed ^ 0x53434e));
    buildScenery(stage, fr);
    const { cps, splits } = buildCheckpoints(stage);
    stage.checkpoints = cps;
    stage.splitS = splits;
    stage.day = day;
    stage.number = day + 1;
    stage.weatherId = weatherId;
    stage.weather = weather;
    stage.surfKey = surfKey;
    stage.surfaceName = grip.name;
    stage.offroad = OFFROAD[env.id];
    stage.stageName = rng(hash32(baseSeed ^ 0x4e414d45)).pick(env.stageNames);
    stage.botTime = stage.profile.time;
    stage.estSkilled = stage.profile.time * 1.045;
    stage.estCasual = stage.profile.time * 1.16;
    stage.kmText = (stage.length / 1000).toFixed(1) + " km";
    stage.startS = 10;
    stage.finishS = stage.length - 16;
    stage.sectorS = [stage.splitS[0], stage.splitS[1]];
    stage.candidatesTried = tried;
    return stage;
  }

  /* opts.validate: deterministic test-drive gate (spec: bot-test candidates
   * before publication). Falls back to the best candidate if all fail. */
  const gate = opts && opts.validate;
  if (gate) {
    const tryLimit = Math.min(4, candidates.length);
    for (let ci = 0; ci < tryLimit; ci++) {
      const st = finalize(candidates[ci]);
      if (gate(st)) { st.pickedCandidate = ci; return st; }
    }
  }
  const st = finalize(candidates[0]);
  st.pickedCandidate = 0;
  return st;
}
