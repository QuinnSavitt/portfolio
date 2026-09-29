/* Daily Rocket — worlds, air and wind.
 *
 * Four bodies with honest personalities (gravity, air, weather). Physical
 * fields are rolled per day from these ranges; the palette is fixed per
 * world. Scale heights are compressed so a few kilometres of climb really
 * changes the air.
 */

import { noise1d } from "./daily.js";

export const WORLDS = {
  terra: {
    id: "terra", name: "Terra", atmo: "Thick",
    g: [9.4, 9.9], rho0: [1.15, 1.3], p0: 1.0, scaleH: [6200, 7400],
    wind: [0, 7], gust: [0.5, 3],
    pal: {
      skyTop: "#4f8fc7", skyBot: "#cfe3ef", haze: "#bcd4e2",
      far: "#8aa6b8", mid: "#6f8a74", ground: "#5b6d45", groundLit: "#7c9058",
      strata: "#4b5a3a", rock: "#6d6a5c", sea: "#2f6f95", seaLit: "#5fa0c4",
      sun: "#fff6de", sunGlow: "rgba(255,236,190,0.55)", cloud: "rgba(255,255,255,0.72)",
      dust: "#a89a7a", plumeSmoke: "rgba(236,236,236,0.55)"
    }
  },
  rust: {
    id: "rust", name: "Rust", atmo: "Thin",
    g: [3.5, 3.9], rho0: [0.13, 0.2], p0: 0.09, scaleH: [8500, 10500],
    wind: [2, 9], gust: [1, 4],
    pal: {
      skyTop: "#9c6446", skyBot: "#e8c6a2", haze: "#dcb08a",
      far: "#b98060", mid: "#a4623d", ground: "#8f4f2c", groundLit: "#b66d41",
      strata: "#733e22", rock: "#6d3a22", sea: null, seaLit: null,
      sun: "#fff0dc", sunGlow: "rgba(247,205,160,0.45)", cloud: "rgba(238,206,176,0.35)",
      dust: "#c98b5e", plumeSmoke: "rgba(220,180,150,0.45)"
    }
  },
  selene: {
    id: "selene", name: "Selene", atmo: "None",
    g: [1.5, 1.72], rho0: [0, 0], p0: 0, scaleH: [1, 1],
    wind: [0, 0], gust: [0, 0],
    pal: {
      skyTop: "#020308", skyBot: "#0b0f19", haze: "#0b0f19",
      far: "#3a3d46", mid: "#5d6069", ground: "#80838c", groundLit: "#a9acb6",
      strata: "#63666e", rock: "#55585f", sea: null, seaLit: null,
      sun: "#ffffff", sunGlow: "rgba(205,214,255,0.35)", cloud: null,
      dust: "#9a9da6", plumeSmoke: "rgba(200,200,210,0.25)",
      planet: { r: 0.14, color: "#3d6ea5", color2: "#8cb4d6" }
    }
  },
  mistral: {
    id: "mistral", name: "Mistral", atmo: "Dense",
    g: [1.3, 1.45], rho0: [4.2, 5.2], p0: 1.45, scaleH: [11000, 14000],
    wind: [1, 5], gust: [0.5, 2],
    pal: {
      skyTop: "#a0702c", skyBot: "#ecd39a", haze: "#e0c07e",
      far: "#b58d4c", mid: "#8f6b35", ground: "#6d5429", groundLit: "#8b6d38",
      strata: "#56411f", rock: "#4d3b1d", sea: "#3b2a19", seaLit: "#6e5130",
      sun: "#fbe9b8", sunGlow: "rgba(236,200,120,0.45)", cloud: "rgba(240,214,156,0.5)",
      dust: "#a88550", plumeSmoke: "rgba(230,205,150,0.5)"
    }
  }
};

export const WORLD_IDS = ["terra", "rust", "selene", "mistral"];

/* Air at an absolute height y (metres above the datum the terrain uses). */
export function airAt(world, y) {
  if (world.rho0 <= 0) { return { rho: 0, p: 0 }; }
  const k = Math.exp(-Math.max(0, y) / world.scaleH);
  return { rho: world.rho0 * k, p: world.p0 * k };
}

/* Horizontal wind (m/s, +x downrange) at height y above ground and mission
 * time t. Steady part strengthens with height (a gentle shear layer); gusts
 * are smooth deterministic noise in time. */
export function windAt(day, y, t) {
  const w = day.world;
  if (w.rho0 <= 0 || (w.wind === 0 && w.gust === 0)) { return 0; }
  const shear = 0.55 + 0.45 * Math.min(1, Math.max(0, y) / 1800);
  const slow = noise1d(t * 0.13, day.gustSeed);
  const fast = noise1d(t * 0.7, day.gustSeed ^ 0x9e3779b9);
  return w.wind * w.windDir * shear + w.gust * (slow * 0.8 + fast * 0.35);
}
