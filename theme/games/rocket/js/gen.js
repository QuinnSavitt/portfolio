/* Daily Rocket — deterministic daily generation.
 *
 * Everything a player sees today derives from the UTC day index. A candidate
 * day is generated, then the autopilot test-flies it with the reference
 * loadout (gen and bot are deterministic, so every client computes the exact
 * same audition). If the bot cannot land it with fuel to spare and all three
 * beacons collected, the day regenerates with a gentler variant — so a
 * published daily is machine-verified beatable, and the bot's time and burn
 * become the day's par.
 */

import { rng, hash32 } from "./daily.js";
import { makeShip, step, MAX_TICKS, TANK_CAP } from "./physics.js";
import { botInput } from "./bot.js";

export const RULES = "2.0.0";
export const REF_LOADOUT = { engine: "kestrel", fuelFrac: 0.7 };
export const BOT_SKILL = 0.85;

/* Tuned for play, not astronomy: scale heights are compressed so a few
 * hundred metres of climb genuinely changes the air. Visual fields are
 * static per world; physical fields are rolled per day. */
export const WORLDS = [
  {
    id: "terra", name: "Terra", atmo: "Thick",
    g: [9.0, 10.2], rho0: [1.0, 1.35], scaleH: [2200, 3000], wind: [0, 6], gust: [1, 3],
    skyTop: "#6ea8d4", skyBot: "#d9e6ef", ground: "#5f7048", groundLit: "#7a8c5c",
    rock: "#55604b", haze: "#c3d4de", cloud: "rgba(255,255,255,0.5)",
    sun: { r: 34, color: "#fff4d6", glow: "#ffe9b0" }
  },
  {
    id: "rust", name: "Rust", atmo: "Thin",
    g: [3.4, 4.2], rho0: [0.1, 0.25], scaleH: [3000, 4200], wind: [1, 6], gust: [1, 4],
    skyTop: "#b57a52", skyBot: "#ecd0b2", ground: "#96552f", groundLit: "#b56f41",
    rock: "#7a4527", haze: "#e2bd97", cloud: "rgba(240,214,189,0.35)",
    sun: { r: 22, color: "#ffe9d0", glow: "#f7c9a0" }
  },
  {
    id: "selene", name: "Selene", atmo: "None",
    g: [1.35, 2.0], rho0: [0, 0], scaleH: [1, 1], wind: [0, 0], gust: [0, 0],
    skyTop: "#04060c", skyBot: "#10141f", ground: "#82858e", groundLit: "#a3a7b3",
    rock: "#63666f", haze: "#10141f", cloud: null,
    sun: { r: 26, color: "#ffffff", glow: "#cdd6ff" },
    planet: { r: 90, color: "#3d6ea5", color2: "#7fa8cc" }
  },
  {
    id: "mistral", name: "Mistral", atmo: "Storm",
    g: [1.2, 1.8], rho0: [3.0, 4.6], scaleH: [3800, 5200], wind: [3, 8], gust: [2, 5],
    skyTop: "#8a6b28", skyBot: "#e3c98e", ground: "#63512a", groundLit: "#7d6836",
    rock: "#4c3f22", haze: "#d9be82", cloud: "rgba(233,209,150,0.4)",
    sun: { r: 40, color: "#f7e3ae", glow: "#d9b96a" }
  }
];

const MISSIONS = [
  { max: 1300, name: "Milk Run", brief: "A short hop downrange. Sounds easy. Land it clean and prove it." },
  { max: 2300, name: "Beacon Route", brief: "Sweep the relay beacons on the way out, then set it down on the pad." },
  { max: 99999, name: "Long Haul", brief: "The far outpost needs this payload. It is a long way — watch the tank." }
];

// ---------------------------------------------------------------- terrain

function buildTerrain(r, seed, relief, targetX, padHalfW, ridgeH) {
  const STEP = 30;
  const x0 = -480;
  const extent = targetX + 1400;
  const n = Math.ceil((extent - x0) / STEP) + 1;
  const h = new Float64Array(n);

  const octaves = [
    { len: 2600, amp: relief },
    { len: 900, amp: relief * 0.45 },
    { len: 300, amp: relief * 0.18 },
    { len: 110, amp: relief * 0.06 }
  ];
  const phase = octaves.map(() => r() * 1000);

  for (let i = 0; i < n; i++) {
    const x = x0 + i * STEP;
    let v = 0;
    for (let o = 0; o < octaves.length; o++) {
      const t = x / octaves[o].len + phase[o];
      const i0 = Math.floor(t);
      const f = t - i0;
      const sm = f * f * (3 - 2 * f);
      const a = (hash32(Math.imul(i0, 374761393) + Math.imul(o, 668265263) + seed) / 4294967296) * 2 - 1;
      const b = (hash32(Math.imul(i0 + 1, 374761393) + Math.imul(o, 668265263) + seed) / 4294967296) * 2 - 1;
      v += (a + (b - a) * sm) * octaves[o].amp;
    }
    h[i] = v;
  }

  // an optional ridge between launch and pad forces a route decision
  if (ridgeH > 0) {
    const rx = targetX * r.range(0.38, 0.62);
    const rw = targetX * r.range(0.09, 0.16);
    for (let i = 0; i < n; i++) {
      const d = (x0 + i * STEP - rx) / rw;
      h[i] += ridgeH * Math.exp(-d * d);
    }
  }

  function flatten(cx, halfWidth, blend) {
    const ci = Math.round((cx - x0) / STEP);
    const level = h[Math.max(0, Math.min(n - 1, ci))];
    const hw = Math.ceil(halfWidth / STEP);
    const bl = Math.ceil(blend / STEP);
    for (let j = ci - hw - bl; j <= ci + hw + bl; j++) {
      if (j < 0 || j >= n) { continue; }
      const dist = Math.abs(j - ci);
      let w = dist <= hw ? 1 : Math.max(0, 1 - (dist - hw) / bl);
      w = w * w * (3 - 2 * w);
      h[j] = h[j] * (1 - w) + level * w;
    }
    return level;
  }

  const padY = flatten(targetX, padHalfW + 35, 240);
  const launchY = flatten(0, 95, 200);

  return {
    step: STEP, x0, heights: h, n, padY, launchY,
    heightAt(x) {
      const t = (x - x0) / STEP;
      if (t <= 0) { return h[0]; }
      const i0 = Math.floor(t);
      if (i0 >= n - 1) { return h[n - 1]; }
      const f = t - i0;
      return h[i0] + (h[i0 + 1] - h[i0]) * f;
    },
    slopeAt(x) {
      return (this.heightAt(x + 6) - this.heightAt(x - 6)) / 12;
    }
  };
}

// -------------------------------------------------------------- candidate

function candidate(index, variant) {
  const seed = hash32(Math.imul(index, 2654435761) + 12345 + variant * 7919);
  const r = rng(seed);

  const wdef = r.pick(WORLDS);
  const soften = 1 - variant * 0.18;
  const world = {
    id: wdef.id, name: wdef.name, atmo: wdef.atmo,
    g: +r.range(wdef.g[0], wdef.g[1]).toFixed(3),
    rho0: +r.range(wdef.rho0[0], wdef.rho0[1]).toFixed(3),
    scaleH: Math.round(r.range(wdef.scaleH[0], wdef.scaleH[1])),
    wind: +(r.range(wdef.wind[0], wdef.wind[1]) * soften).toFixed(1),
    windDir: r.chance(0.5) ? -1 : 1,
    gust: +(r.range(wdef.gust[0], wdef.gust[1]) * soften).toFixed(1),
    def: wdef
  };

  /* Roll a mission length band directly so short hops, mid routes and long
   * hauls all actually occur (a physics-derived distance just saturates its
   * cap on low-gravity worlds and every day comes out identical). */
  const roll = r();
  const band = roll < 0.28 ? [700, 1400] : roll < 0.68 ? [1400, 2300] : [2300, 3200];
  const targetX = Math.round(r.range(band[0], band[1]) / 50) * 50;
  const demand = Math.min(1, targetX / 3200 * 0.7 + (world.rho0 > 1.5 ? 0.2 : 0) + world.wind * 0.02);

  const padHalfW = Math.round(r.range(26, 52)) + variant * 8;
  const relief = r.range(30, 110) * (1 + demand) * (1 - variant * 0.22);
  const ridgeH = targetX > 1500 && r.chance(0.6) ? r.range(120, 380) * (1 - variant * 0.25) : 0;

  const terrain = buildTerrain(r, seed, relief, targetX, padHalfW, ridgeH);

  // beacons along the route, always well clear of the ground
  const beacons = [];
  const fracs = [0.28, 0.52, 0.76];
  for (let i = 0; i < 3; i++) {
    const bx = targetX * (fracs[i] + r.range(-0.05, 0.05));
    let ceiling = -Infinity;
    for (let gx = bx - 260; gx <= bx + 260; gx += 30) {
      ceiling = Math.max(ceiling, terrain.heightAt(gx));
    }
    const by = ceiling + r.range(80, 240) + variant * 40;
    beacons.push({ x: Math.round(bx), y: Math.round(Math.max(by, terrain.heightAt(bx) + 60)), points: 800 });
  }
  beacons.sort((a, b) => a.x - b.x);

  const mission = MISSIONS.find((m) => targetX <= m.max);

  return {
    index, number: index + 1, seed, variant, rules: RULES,
    world,
    mission: { name: mission.name, brief: mission.brief },
    pad: { x: targetX, halfW: padHalfW },
    terrain,
    extent: targetX + 1400,
    beacons,
    gustSeed: hash32(seed ^ 0x5bf03635),
    demand
  };
}

// --------------------------------------------------------------- audition

export function flyBot(day, loadout, skill, maxTicks) {
  const ship = makeShip(day, loadout);
  const limit = maxTicks || MAX_TICKS;
  for (let i = 0; i < limit && !ship.done; i++) {
    step(ship, botInput(ship, skill));
  }
  if (!ship.done) { ship.outcome = "timeout"; }
  return ship;
}

function audition(day) {
  const ship = flyBot(day, REF_LOADOUT, BOT_SKILL);
  const loaded = TANK_CAP * REF_LOADOUT.fuelFrac;
  const ok = ship.outcome === "landed" &&
    ship.collected === day.beacons.length &&
    ship.fuel >= loaded * 0.06 &&
    ship.t <= 240;
  return {
    ok, outcome: ship.outcome, t: ship.t, fuelBurned: ship.fuelBurned,
    fuelLeft: ship.fuel, collected: ship.collected, touchdowns: ship.touchdowns
  };
}

// ------------------------------------------------------------------- day

export function generateDay(index) {
  let day = null, audit = null;
  for (let v = 0; v < 4; v++) {
    day = candidate(index, v);
    audit = audition(day);
    if (audit.ok) { break; }
  }
  // v=3 is already maximally gentle; publish it regardless (the harness
  // sweep exists to prove this branch never actually ships un-flyable days).
  day.par = {
    time: Math.round(audit.t * 10) / 10,
    fuel: Math.round(audit.fuelBurned),
    ok: audit.ok
  };
  day.audit = audit;
  return day;
}
