/* Daily Rocket — deterministic terrain.
 *
 * A 1D heightmap at 5 m spacing: rolling value-noise ground, then the day's
 * features are carved in (ridges, a mesa, a canyon, a coastline) and the
 * launch and target shelves are flattened last so they are always level.
 * Everything here runs from the day's rng; no Math.random.
 */

import { hash32 } from "./daily.js";

export const STEP = 5;

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/* opts:
 *   relief        amplitude of the rolling ground (m)
 *   extentL/R     x range to cover
 *   ridges        [{ x, w, h }] gaussian mountains
 *   mesa          { x, half, h, edge } raised plateau under the target
 *   canyon        { x, half, depth, wall } slot with a flat floor
 *   coast         { x, depth } sea from x onward (sea level = launch - 4)
 *   shelves       [{ x, half, blend, level? }] flattened pads (launch first)
 */
export function buildTerrain(r, seed, opts) {
  const x0 = Math.floor(opts.extentL / STEP) * STEP;
  const n = Math.ceil((opts.extentR - x0) / STEP) + 1;
  const h = new Float64Array(n);
  const X = (i) => x0 + i * STEP;

  const relief = opts.relief;
  const oct = [
    { len: 2400, amp: relief },
    { len: 800, amp: relief * 0.42 },
    { len: 260, amp: relief * 0.16 },
    { len: 70, amp: relief * 0.045 }
  ];
  const phase = oct.map(() => r() * 1000);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let o = 0; o < oct.length; o++) {
      const t = X(i) / oct[o].len + phase[o];
      const i0 = Math.floor(t);
      const f = smooth(t - i0);
      const a = (hash32(Math.imul(i0, 374761393) + Math.imul(o + 1, 668265263) + seed) / 4294967296) * 2 - 1;
      const b = (hash32(Math.imul(i0 + 1, 374761393) + Math.imul(o + 1, 668265263) + seed) / 4294967296) * 2 - 1;
      v += (a + (b - a) * f) * oct[o].amp;
    }
    h[i] = v;
  }

  // mountains
  for (const rg of opts.ridges || []) {
    for (let i = 0; i < n; i++) {
      const d = (X(i) - rg.x) / rg.w;
      if (d > -3.2 && d < 3.2) {
        // a slightly peaky profile reads as a mountain rather than a hump
        const g = Math.exp(-d * d);
        h[i] += rg.h * (g * 0.8 + Math.pow(g, 3) * 0.2);
      }
    }
  }

  // launch level is fixed before carving so features are relative to it
  const idx = (x) => Math.max(0, Math.min(n - 1, Math.round((x - x0) / STEP)));
  const launchLevel = h[idx(0)];

  if (opts.mesa) {
    const m = opts.mesa;
    const base = h[idx(m.x)];
    const top = Math.max(base, launchLevel) + m.h;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(X(i) - m.x);
      if (d > m.half + m.edge) { continue; }
      const w = d <= m.half ? 1 : 1 - smooth((d - m.half) / m.edge);
      // rough the top edge a touch so it is a mesa, not a table
      h[i] = h[i] * (1 - w) + (top + (d > m.half * 0.85 ? -3 * (d - m.half * 0.85) / (m.half * 0.15 + 1) : 0)) * w;
    }
  }

  if (opts.canyon) {
    const c = opts.canyon;
    // level the rim on both sides first so the slot has clean lips
    let rim = -Infinity;
    for (let x = c.x - c.half - c.wall - 60; x <= c.x + c.half + c.wall + 60; x += STEP) {
      rim = Math.max(rim, h[idx(x)]);
    }
    const floor = rim - c.depth;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(X(i) - c.x);
      const lip = c.half + c.wall;
      if (d > lip + 140) { continue; }
      if (d > lip) {
        const w = 1 - smooth((d - lip) / 140);
        h[i] = h[i] * (1 - w) + rim * w;
      } else if (d > c.half) {
        const t = (d - c.half) / c.wall;
        // steep wall with a small overhang-free bulge so it reads as rock
        h[i] = floor + (rim - floor) * Math.pow(t, 0.8);
      } else {
        h[i] = floor;
      }
    }
  }

  let seaLevel = -Infinity;
  if (opts.coast) {
    seaLevel = launchLevel - 4;
    const bed = seaLevel - opts.coast.depth;
    for (let i = 0; i < n; i++) {
      const x = X(i);
      if (x < opts.coast.x - 220) { continue; }
      const t = smooth((x - (opts.coast.x - 220)) / 260);
      // drag the land down to a beach, then a sea bed with gentle swell
      const target = bed + Math.sin(x / 90) * 3;
      h[i] = h[i] * (1 - t) + Math.min(h[i], target) * t;
      if (x > opts.coast.x + 40) { h[i] = Math.min(h[i], bed + Math.sin(x / 90) * 3); }
    }
  }

  const shelves = [];
  for (const sh of opts.shelves || []) {
    const ci = idx(sh.x);
    const level = sh.level != null ? sh.level : h[ci];
    const hw = Math.ceil(sh.half / STEP);
    const bl = Math.ceil(sh.blend / STEP);
    for (let j = ci - hw - bl; j <= ci + hw + bl; j++) {
      if (j < 0 || j >= n) { continue; }
      const dist = Math.abs(j - ci);
      const w = dist <= hw ? 1 : smooth(1 - (dist - hw) / bl);
      h[j] = h[j] * (1 - w) + level * w;
    }
    shelves.push({ x: sh.x, half: sh.half, y: level });
  }

  return {
    x0, n, step: STEP, heights: h, seaLevel, shelves,
    x1: x0 + (n - 1) * STEP,
    heightAt(x) {
      const t = (x - x0) / STEP;
      if (t <= 0) { return h[0]; }
      const i0 = Math.floor(t);
      if (i0 >= n - 1) { return h[n - 1]; }
      return h[i0] + (h[i0 + 1] - h[i0]) * (t - i0);
    },
    /* the surface you would actually touch: ground or water */
    surfaceAt(x) {
      const g = this.heightAt(x);
      return g < seaLevel ? seaLevel : g;
    },
    isWater(x) { return this.heightAt(x) < seaLevel; },
    slopeAt(x) {
      return (this.heightAt(x + 2.5) - this.heightAt(x - 2.5)) / 5;
    },
    maxBetween(xa, xb) {
      let m = -Infinity;
      const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
      for (let x = lo; x <= hi; x += STEP) { m = Math.max(m, this.surfaceAt(x)); }
      return m;
    }
  };
}
