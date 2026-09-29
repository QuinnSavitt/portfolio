/* Daily Rocket — flight renderer.
 *
 * Pure presentation: reads the sim, never writes it. Anything random in
 * here (particle scatter, flicker, twinkle) may use Math.random because it
 * cannot touch physics or scoring.
 *
 * World: +x downrange, +y up, metres. Screen y is down; sy() flips. A
 * vessel is drawn by translating to its local origin, rotating by its
 * (clockwise-positive) angle and scaling to metres, then partsdraw does
 * the rest in the vessel's own frame.
 */

import { noise1d, hash32 } from "./daily.js";
import { windAt, airAt } from "./world.js";
import {
  comWorld, toWorld, coast, bargeAt, simTarget, simLeg, clearance, groundAt
} from "./physics.js";
import { massProps } from "./parts.js";
import { drawVessel, INK } from "./partsdraw.js";

const SPACE = "#03050b";
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
function hexRgb(h) {
  return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
}
function mix(a, b, t) {
  const A = hexRgb(a), B = hexRgb(b);
  t = clamp(t, 0, 1);
  return "rgb(" + Math.round(A[0] + (B[0] - A[0]) * t) + "," + Math.round(A[1] + (B[1] - A[1]) * t) + "," +
    Math.round(A[2] + (B[2] - A[2]) * t) + ")";
}
function rgba(h, a) { const c = hexRgb(h); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }

export function createRenderer(canvas, day) {
  const ctx = canvas.getContext("2d");
  const w = day.world, pal = w.pal;
  const air = w.rho0 > 0.05;
  let W = 0, H = 0, dpr = 1;
  const cam = { x: day.launch.x, y: day.launch.y + 20, k: 9, shake: 0 };
  let time = 0, flash = 0;
  let parts = [];           // particles
  let shards = [];          // wreckage pieces
  let rings = [];           // expanding shockwaves / pulses
  let texts = [];           // floating labels
  let arc = null, arcAt = -1;
  let armOut = 0;           // launch tower arm swing (0 docked, 1 away)
  let seed = day.seed;

  // ---- static scenery, deterministic per day so it never shuffles
  const vr = (() => { let a = hash32(day.seed ^ 0x51ed27); return () => { a = hash32(a + 0x9e3779b9); return a / 4294967296; }; })();
  const stars = [];
  for (let i = 0; i < 150; i++) { stars.push({ x: vr(), y: vr(), s: vr() * 1.5 + 0.4, tw: vr() * 6.3, sp: 0.5 + vr() * 2 }); }
  const clouds = [];
  if (pal.cloud) {
    const n = w.id === "mistral" ? 40 : w.id === "rust" ? 16 : 36;
    for (let i = 0; i < n; i++) {
      clouds.push({
        x: day.terrain.x0 + vr() * (day.terrain.x1 - day.terrain.x0),
        y: day.launch.y + (w.id === "mistral" ? 150 + vr() * 1700 : 300 + vr() * 2600),
        r: 40 + vr() * 110, puffs: 3 + Math.floor(vr() * 4), sq: 0.28 + vr() * 0.14, seed: vr() * 100
      });
    }
  }
  const rocks = [];
  for (let x = day.terrain.x0; x < day.terrain.x1; x += 18 + vr() * 40) {
    rocks.push({ x, r: 0.6 + vr() * 2.4, k: vr() });
  }
  const buildings = [];
  for (const L of day.legs) {
    const t = L.target;
    if (day.barge || (t.x === day.launch.x)) { continue; }
    const side = vr() < 0.5 ? -1 : 1;
    const n = 2 + Math.floor(vr() * 3);
    let off = t.half + 6;
    for (let i = 0; i < n; i++) {
      const kind = vr() < 0.45 ? "dome" : vr() < 0.6 ? "hab" : "mast";
      const bw = kind === "mast" ? 2 : 6 + vr() * 6;
      buildings.push({ x: t.x + side * (off + bw / 2), w: bw, h: kind === "mast" ? 12 + vr() * 10 : 4 + vr() * 4, kind, lit: vr() });
      off += bw + 2 + vr() * 5;
    }
  }

  // ---- geometry helpers
  const sx = (x) => W / 2 + (x - cam.x) * cam.k + shakeX;
  const sy = (y) => H / 2 - (y - cam.y) * cam.k + shakeY;
  let shakeX = 0, shakeY = 0;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
  }

  function reset() {
    parts = []; shards = []; rings = []; texts = []; arc = null; arcAt = -1; armOut = 0; flash = 0;
    cam.x = day.launch.x; cam.y = day.launch.y + 14; cam.k = Math.min(W, H) / 60 || 9; cam.shake = 0;
  }

  // ---- particles
  // effects budget: drops on slow devices, never touches the physics
  let fxCap = 1100, slowT = 0;
  function spawn(p) { if (parts.length < fxCap) { parts.push(p); } }
  function burst(x, y, o) {
    const n = o.n || 10;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (o.speed || 10) * (0.25 + Math.random());
      spawn({
        x, y, vx: Math.cos(a) * sp + (o.vx || 0), vy: Math.sin(a) * sp * (o.up ? Math.abs(Math.sin(a)) : 1) + (o.vy || 0),
        life: (o.life || 1) * (0.5 + Math.random() * 0.8), age: 0,
        size: (o.size || 1) * (0.6 + Math.random() * 0.8), grow: o.grow || 0,
        grav: o.grav != null ? o.grav : 0.3, drag: o.drag != null ? o.drag : 0.6,
        color: o.colors[(Math.random() * o.colors.length) | 0], add: !!o.add, fade: o.fade || 1
      });
    }
  }

  function stepParticles(dt, sim) {
    const wnd = air ? windAt(day, 300, sim ? sim.t : 0) : 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.age += dt;
      if (p.age >= p.life) { parts.splice(i, 1); continue; }
      const dr = Math.min(1, p.drag * dt * (air ? 1 : 0.15));
      p.vx += (wnd - p.vx) * dr;
      p.vy += (0 - p.vy) * dr * 0.6 - w.g * p.grav * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.size += p.grow * dt;
      const g = day.terrain.surfaceAt(p.x);
      if (p.y < g) { p.y = g; p.vy = Math.abs(p.vy) * 0.15; p.vx *= 0.7; }
    }
    for (let i = shards.length - 1; i >= 0; i--) {
      const s = shards[i];
      s.age += dt;
      if (s.age > s.life) { shards.splice(i, 1); continue; }
      if (!s.rest) {
        s.vy -= w.g * dt;
        if (air) { s.vx += (wnd - s.vx) * dt * 0.15; }
        s.x += s.vx * dt; s.y += s.vy * dt; s.a += s.va * dt;
        const g = day.terrain.surfaceAt(s.x);
        if (s.y < g + s.h * 0.3) {
          s.y = g + s.h * 0.3;
          if (Math.abs(s.vy) < 4) { s.rest = true; } else { s.vy = -s.vy * 0.3; s.vx *= 0.5; s.va *= 0.5; }
        }
      }
    }
    for (let i = rings.length - 1; i >= 0; i--) { rings[i].age += dt; if (rings[i].age > rings[i].life) { rings.splice(i, 1); } }
    for (let i = texts.length - 1; i >= 0; i--) { texts[i].age += dt; if (texts[i].age > texts[i].life) { texts.splice(i, 1); } }
  }

  // ---- events from the sim
  function onEvent(e, sim) {
    const v = findVessel(sim, e.id);
    if (e.type === "explosion") {
      const big = e.main;
      cam.shake = Math.max(cam.shake, big ? 30 : 12);
      if (big) { flash = 0.6; }
      const s = big ? 1 : 0.6 + (e.size || 0.4) * 0.4;
      rings.push({ x: e.x, y: e.y, age: 0, life: 0.6, r: 40 * s, col: "#ffd9a0" });
      burst(e.x, e.y, { n: 42 * s, speed: 30 * s, life: 1.1, size: 3.2 * s, grow: 5, grav: -0.1, drag: 1.6, add: true, colors: ["#fff3c4", "#ffc070", "#ff8a45", "#fa6862"] });
      burst(e.x, e.y, { n: 34 * s, speed: 12 * s, life: 3.5, size: 3.5 * s, grow: 6, grav: -0.08, drag: 0.9, colors: ["rgba(60,58,62,0.55)", "rgba(96,90,86,0.5)", "rgba(40,40,44,0.6)"] });
      burst(e.x, e.y, { n: 24 * s, speed: 45 * s, life: 1.6, size: 0.5, grav: 0.8, drag: 0.2, add: true, colors: ["#ffe7a8", "#ffb35c"] });
      if (v) { shatter(v); }
    } else if (e.type === "splash") {
      burst(e.x, e.y, { n: e.big ? 50 : 22, speed: e.big ? 22 : 12, life: 1.6, size: 1.6, up: true, grav: 1, drag: 0.4, colors: ["#e6f4ff", "#bfe0f5", "#ffffff"] });
      rings.push({ x: e.x, y: e.y, age: 0, life: 1, r: 25, col: "#e6f4ff" });
      if (e.big) { cam.shake = Math.max(cam.shake, 10); }
    } else if (e.type === "touchdown") {
      cam.shake = Math.max(cam.shake, e.speed > 3 ? 8 : 3);
      burst(e.x, e.y, { n: 26, speed: 9, life: 1.4, size: 2.2, up: true, grow: 3, grav: 0.1, drag: 1.2, colors: [rgba(pal.dust, 0.55), rgba(pal.groundLit, 0.5)] });
      if (e.onTarget) { rings.push({ x: e.x, y: e.y, age: 0, life: 0.9, r: 30, col: "#7fc6a1" }); }
    } else if (e.type === "liftoff") {
      cam.shake = Math.max(cam.shake, 5);
    } else if (e.type === "ignite") {
      cam.shake = Math.max(cam.shake, 4);
    } else if (e.type === "separate" || e.type === "boosters") {
      cam.shake = Math.max(cam.shake, 5);
      burst(e.x, e.y, { n: 16, speed: 8, life: 0.8, size: 1.6, grow: 3, grav: 0, drag: 2, colors: ["rgba(255,255,255,0.7)", "rgba(220,225,235,0.6)"] });
    } else if (e.type === "gate") {
      rings.push({ x: e.x, y: e.y, age: 0, life: 0.8, r: 50, col: "#7fc6a1" });
      texts.push({ x: e.x, y: e.y + 20, age: 0, life: 1.4, str: "RING " + (e.index + 1) });
    } else if (e.type === "ribbon") {
      texts.push({ x: e.x, y: e.y + 30, age: 0, life: 1.6, str: "LINE REACHED" });
    } else if (e.type === "pickup") {
      texts.push({ x: e.x, y: e.y + 16, age: 0, life: 2.2, str: "+" + e.kg + " kg ABOARD" });
    } else if (e.type === "chuteOpen" && v) {
      const c = comWorld(v);
      burst(c.x, c.y + 3, { n: 8, speed: 4, life: 0.6, size: 1, grav: 0, colors: ["rgba(255,255,255,0.8)"] });
    } else if (e.type === "recovered") {
      texts.push({ x: e.x, y: e.y + 10, age: 0, life: 1.8, str: "STAGE RECOVERED" });
    }
  }

  function findVessel(sim, id) {
    if (!sim || !id) { return null; }
    if (sim.main.id === id) { return sim.main; }
    for (const list of [sim.debris, sim.landed, sim.wrecks]) {
      for (const d of list) { if (d.id === id) { return d; } }
    }
    return null;
  }

  /* blow a vessel into its parts: each part becomes a tumbling shard */
  function shatter(v) {
    v.shattered = true;
    const mp = massProps(v.parts);
    for (const p of v.parts) {
      const c = toWorld(v, p.c, (p.s0 + p.s1) / 2);
      const a = Math.atan2(c.y - (v.y + mp.s), c.x - v.x) + (Math.random() - 0.5);
      const sp = 6 + Math.random() * 16;
      shards.push({
        p, x: c.x, y: c.y, vx: v.vx * 0.4 + Math.cos(a) * sp, vy: v.vy * 0.3 + Math.abs(Math.sin(a)) * sp + 4,
        a: v.ang, va: (Math.random() - 0.5) * 8, age: 0, life: 40, h: p.h, rest: false, burnt: 0.6 + Math.random() * 0.4
      });
    }
  }

  // ---- camera
  function updateCamera(sim, dt) {
    const v = sim.main;
    const c = comWorld(v);
    const speed = Math.hypot(v.vx, v.vy);
    const agl = Math.max(0, c.y - day.terrain.surfaceAt(c.x));
    const tg = simTarget(sim);
    const dT = Math.hypot(tg.x - c.x, tg.y - c.y);
    // how much world to show: more when fast or high, tight near the ground
    // how much world to show: more when fast, and enough to keep the ground
    // in frame while it matters; tight for the last metres over the pad
    let span = 55 + speed * 1.2;
    // keep the ground in frame up to ~500 m, easing out above that
    const groundK = clamp((620 - agl) / 240, 0, 1);
    span = Math.max(span, ((Math.min(agl, 500) + 25) / 0.62) * groundK + (240 + agl * 0.15) * (1 - groundK));
    if (dT < 260 && agl < 220) { span = Math.min(span, Math.max(45 + agl * 1.4 + dT * 0.35, (agl + 20) / 0.62)); }
    if (!sim.ignited) { span = 55; }
    span = clamp(span, 45, 900);
    const kWant = Math.min(W, H * 1.15) / span;
    cam.k += (kWant - cam.k) * Math.min(1, dt * 1.8);
    const visH = H / cam.k;
    // lead the motion a little; sit low in the frame so the ground shows
    let tx = c.x + clamp(v.vx * 0.5, -visH * 0.25, visH * 0.25);
    let ty = c.y + clamp(v.vy * 0.25, -visH * 0.15, visH * 0.15);
    if (groundK > 0) {
      const tyG = Math.min(Math.max(ty, day.terrain.surfaceAt(c.x) + visH * 0.42), c.y + visH * 0.3);
      ty = ty + (tyG - ty) * groundK;
    }
    if (sim.done && !v.alive) { tx = cam.x; ty = cam.y; }
    const f = Math.min(1, dt * 3.2);
    cam.x += (tx - cam.x) * f;
    cam.y += (ty - cam.y) * f;
    cam.shake *= Math.pow(0.02, dt);
    shakeX = (Math.random() - 0.5) * cam.shake;
    shakeY = (Math.random() - 0.5) * cam.shake;
  }

  // ---- background
  function drawSky(sim) {
    const alt = cam.y - day.launch.y;
    const spaceK = air ? clamp(alt / (w.scaleH * 1.3), 0, 1) : 1;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, mix(pal.skyTop, SPACE, spaceK));
    g.addColorStop(1, mix(pal.skyBot, "#0a0f1a", spaceK * 0.9));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const sk = air ? clamp((spaceK - 0.25) / 0.5, 0, 1) : 1;
    if (sk > 0.02) {
      for (const st of stars) {
        const px = ((st.x * (W + 80) - cam.x * 0.02) % (W + 80) + W + 80) % (W + 80) - 40;
        const py = ((st.y * H * 1.2 + cam.y * 0.02) % (H * 1.2) + H * 1.2) % (H * 1.2) - H * 0.1;
        const tw = 0.55 + 0.45 * Math.sin(time * st.sp + st.tw);
        ctx.fillStyle = "rgba(255,255,255," + (sk * tw * 0.9).toFixed(3) + ")";
        ctx.fillRect(px, py, st.s, st.s);
      }
    }
    // sun
    const sunX = W * 0.8 - cam.x * 0.004, sunY = H * 0.16 + (cam.y - day.launch.y) * 0.004;
    const r0 = Math.min(W, H) * 0.035;
    const bloom = ctx.createRadialGradient(sunX, sunY, r0 * 0.5, sunX, sunY, r0 * 5);
    bloom.addColorStop(0, pal.sunGlow); bloom.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = bloom; ctx.fillRect(sunX - r0 * 5, sunY - r0 * 5, r0 * 10, r0 * 10);
    ctx.fillStyle = pal.sun; ctx.beginPath(); ctx.arc(sunX, sunY, r0, 0, Math.PI * 2); ctx.fill();
    if (pal.planet) {
      const pr = Math.min(W, H) * pal.planet.r;
      const px = W * 0.18 - cam.x * 0.003, py = H * 0.3 + (cam.y - day.launch.y) * 0.003;
      const pg = ctx.createRadialGradient(px - pr * 0.4, py - pr * 0.4, pr * 0.1, px, py, pr);
      pg.addColorStop(0, pal.planet.color2); pg.addColorStop(1, pal.planet.color);
      ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(3,5,11,0.6)"; ctx.beginPath(); ctx.arc(px + pr * 0.42, py + pr * 0.1, pr * 1.02, 0, Math.PI * 2); ctx.fill();
    }
    // two far ridgelines, parallax in both axes
    for (const L of [{ f: 0.08, fv: 0.18, amp: 0.2, col: mix(pal.far, pal.haze, 0.45), salt: 11, base: 0.02 },
      { f: 0.2, fv: 0.34, amp: 0.16, col: mix(pal.mid, pal.haze, 0.25), salt: 29, base: 0.07 }]) {
      const ls = Math.pow(cam.k, 0.3) * 1.8;
      // distant ridges sink as we climb (and never outrun the near ground)
      const hy = H / 2 - (day.launch.y + 20 - cam.y) * cam.k * L.fv + H * L.base;
      ctx.fillStyle = L.col;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let px = 0; px <= W + 8; px += 8) {
        const u = cam.x * L.f / 40 + (px - W / 2) / (ls * 40);
        const n = noise1d(u * 1.3, day.seed ^ L.salt) * 0.6 + noise1d(u * 3.1, day.seed ^ (L.salt * 7)) * 0.3 + noise1d(u * 9, day.seed ^ (L.salt * 13)) * 0.1;
        ctx.lineTo(px, hy - (0.5 + n * 0.5) * H * L.amp);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    }
    // haze near the horizon
    if (air) {
      const hz = ctx.createLinearGradient(0, H * 0.35, 0, H);
      hz.addColorStop(0, "rgba(0,0,0,0)");
      hz.addColorStop(1, rgba(pal.haze, 0.35 * (1 - spaceK)));
      ctx.fillStyle = hz; ctx.fillRect(0, 0, W, H);
    }
  }

  function drawClouds(sim, front) {
    if (!clouds.length) { return; }
    const drift = (w.wind * w.windDir) * (sim ? sim.t : 0) * 0.6;
    ctx.fillStyle = pal.cloud;
    for (let i = 0; i < clouds.length; i++) {
      if ((i % 3 === 0) !== front) { continue; }
      const c = clouds[i];
      const x = sx(c.x + drift), y = sy(c.y);
      const r = c.r * cam.k;
      if (x < -r * 3 || x > W + r * 3 || y < -r || y > H + r) { continue; }
      ctx.globalAlpha = front ? 0.55 : 0.85;
      for (let k = 0; k < c.puffs; k++) {
        const ox = (k - c.puffs / 2) * r * 0.55, oy = Math.sin(k * 2.3 + c.seed) * r * 0.12;
        ctx.beginPath();
        ctx.ellipse(x + ox, y + oy, r * (0.55 + 0.25 * Math.sin(k + c.seed)), r * c.sq, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- terrain
  function drawTerrain() {
    const tr = day.terrain;
    const x0 = cam.x - W / 2 / cam.k - 20, x1 = cam.x + W / 2 / cam.k + 20;
    const step = Math.max(tr.step, 2 / cam.k);
    const xs = [];
    for (let x = Math.max(tr.x0, Math.floor(x0 / step) * step); x <= Math.min(tr.x1, x1 + step); x += step) { xs.push(x); }
    if (!xs.length) { return; }
    // sea first so the shore sits on top of it
    if (tr.seaLevel > -Infinity) {
      const syS = sy(tr.seaLevel);
      if (syS < H) {
        const g = ctx.createLinearGradient(0, syS, 0, H);
        g.addColorStop(0, pal.seaLit || "#5fa0c4"); g.addColorStop(0.08, pal.sea || "#2f6f95"); g.addColorStop(1, mix(pal.sea || "#2f6f95", "#051018", 0.6));
        ctx.fillStyle = g;
        ctx.fillRect(0, syS, W, H - syS);
      }
    }
    const top = Math.min(...xs.map((x) => sy(tr.heightAt(x))));
    const g = ctx.createLinearGradient(0, Math.max(0, top), 0, H);
    g.addColorStop(0, pal.groundLit);
    g.addColorStop(0.18, pal.ground);
    g.addColorStop(1, mix(pal.ground, "#05070a", 0.55));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(sx(xs[0]), H + 10);
    for (const x of xs) { ctx.lineTo(sx(x), sy(tr.heightAt(x))); }
    ctx.lineTo(sx(xs[xs.length - 1]), H + 10);
    ctx.closePath();
    ctx.fill();
    // strata: the surface line repeated below itself
    if (cam.k > 0.6) {
      for (const [depth, a] of [[3, 0.55], [10, 0.28], [26, 0.18]]) {
        ctx.strokeStyle = rgba(pal.strata, a);
        ctx.lineWidth = Math.max(1, cam.k * 0.6);
        ctx.beginPath();
        let first = true;
        for (const x of xs) {
          const y = sy(tr.heightAt(x) - depth * (1 + 0.3 * noise1d(x / 60, 5)));
          if (first) { ctx.moveTo(sx(x), y); first = false; } else { ctx.lineTo(sx(x), y); }
        }
        ctx.stroke();
      }
    }
    // lit rim
    ctx.strokeStyle = rgba(pal.groundLit, 0.9);
    ctx.lineWidth = Math.max(1.2, cam.k * 0.35);
    ctx.beginPath();
    let first = true;
    for (const x of xs) {
      const y = sy(tr.heightAt(x));
      if (first) { ctx.moveTo(sx(x), y); first = false; } else { ctx.lineTo(sx(x), y); }
    }
    ctx.stroke();
    // rocks
    if (cam.k > 1.5) {
      ctx.fillStyle = pal.rock;
      for (const r of rocks) {
        if (r.x < x0 || r.x > x1) { continue; }
        const gy = tr.heightAt(r.x);
        if (gy < tr.seaLevel) { continue; }
        const px = sx(r.x), py = sy(gy);
        const rr = r.r * cam.k;
        ctx.beginPath(); ctx.ellipse(px, py, rr * 1.3, rr * (0.5 + r.k * 0.4), 0, Math.PI, 0); ctx.fill();
      }
    }
    // sea surface on top of the shore
    if (tr.seaLevel > -Infinity) {
      const y = sy(tr.seaLevel);
      ctx.strokeStyle = "rgba(230,245,255,0.55)";
      ctx.lineWidth = Math.max(1, cam.k * 0.25);
      ctx.beginPath();
      let on = false;
      for (let px = 0; px <= W; px += 6) {
        const x = cam.x + (px - W / 2) / cam.k;
        if (tr.heightAt(x) > tr.seaLevel) { on = false; continue; }
        const yy = y + Math.sin(x * 0.12 + time * 2) * Math.min(3, cam.k * 0.6);
        if (!on) { ctx.moveTo(px, yy); on = true; } else { ctx.lineTo(px, yy); }
      }
      ctx.stroke();
    }
  }

  // ---- structures
  function light(x, y, col, on, r) {
    const R = Math.max(2, (r || 0.6) * cam.k);
    if (on) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, R * 5);
      g.addColorStop(0, rgba(col, 0.6)); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.fillRect(x - R * 5, y - R * 5, R * 10, R * 10);
    }
    ctx.fillStyle = on ? col : rgba(col, 0.35);
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
  }

  function drawLaunchPad(sim) {
    const lx = day.launch.x, ly = day.launch.y;
    const k = cam.k;
    // slab and flame trench
    ctx.fillStyle = "#8c929b";
    ctx.fillRect(sx(lx - 22), sy(ly) - 0.2 * k, 44 * k, 1.4 * k);
    ctx.fillStyle = "#3a3f46";
    ctx.fillRect(sx(lx - 4), sy(ly) + 0.9 * k, 8 * k, 1.2 * k);
    // tower: a lattice beside the rocket
    const tx = lx - 9, th = 16;
    ctx.strokeStyle = "#b8412f"; ctx.lineWidth = Math.max(1, 0.25 * k);
    ctx.beginPath();
    ctx.moveTo(sx(tx - 1), sy(ly)); ctx.lineTo(sx(tx - 1), sy(ly + th));
    ctx.moveTo(sx(tx + 1), sy(ly)); ctx.lineTo(sx(tx + 1), sy(ly + th));
    for (let h = 0; h < th; h += 2) {
      ctx.moveTo(sx(tx - 1), sy(ly + h)); ctx.lineTo(sx(tx + 1), sy(ly + h + 2));
      ctx.moveTo(sx(tx + 1), sy(ly + h)); ctx.lineTo(sx(tx - 1), sy(ly + h + 2));
    }
    ctx.stroke();
    // swing arm, folds away on liftoff
    if (sim && sim.ignited) { armOut = Math.min(1, armOut + 0.02); }
    const ang = -armOut * 1.2;
    const ax = sx(tx + 1), ay = sy(ly + th * 0.72);
    ctx.save(); ctx.translate(ax, ay); ctx.rotate(ang);
    ctx.fillStyle = "#c8ccd2"; ctx.fillRect(0, -0.25 * k, 6.5 * k, 0.5 * k);
    ctx.restore();
    light(sx(tx), sy(ly + th + 0.6), "#ff4d4d", Math.sin(time * 3) > 0, 0.4);
  }

  function drawPad(t, isHome) {
    const k = cam.k;
    const y = sy(t.y);
    ctx.fillStyle = "#9aa1ab";
    ctx.fillRect(sx(t.x - t.half), y - 0.25 * k, 2 * t.half * k, 1.1 * k);
    ctx.fillStyle = "#f0c24e";
    ctx.fillRect(sx(t.x - t.half), y - 0.3 * k, 2 * t.half * k, Math.max(1, 0.18 * k));
    // edge beacons and a centre pole
    const on = Math.sin(time * 4) > 0;
    for (const s of [-1, 1]) {
      const bx = t.x + s * t.half;
      ctx.fillStyle = "#4a5160"; ctx.fillRect(sx(bx) - 0.15 * k, sy(t.y + 2.2), 0.3 * k, 2.2 * k);
      light(sx(bx), sy(t.y + 2.4), "#7fc6a1", on, 0.35);
    }
    ctx.fillStyle = "#e8ecf1"; ctx.fillRect(sx(t.x) - 0.08 * k, sy(t.y + 4), Math.max(1, 0.16 * k), 4 * k);
    ctx.fillStyle = "#fa6862";
    ctx.beginPath(); ctx.moveTo(sx(t.x), sy(t.y + 4)); ctx.lineTo(sx(t.x + 1.6), sy(t.y + 3.5)); ctx.lineTo(sx(t.x), sy(t.y + 3)); ctx.fill();
    // a soft landing column so the pad reads from high up
    const colH = Math.min(H, 120 * k + 40);
    const lg = ctx.createLinearGradient(0, y - colH, 0, y);
    lg.addColorStop(0, "rgba(127,198,161,0)"); lg.addColorStop(1, isHome ? "rgba(98,179,255,0.14)" : "rgba(127,198,161,0.16)");
    ctx.fillStyle = lg;
    ctx.fillRect(sx(t.x - t.half), y - colH, 2 * t.half * k, colH);
  }

  function drawBuildings() {
    const k = cam.k;
    for (const b of buildings) {
      const gy = day.terrain.heightAt(b.x);
      const x = sx(b.x), y = sy(gy);
      if (x < -200 || x > W + 200) { continue; }
      if (b.kind === "dome") {
        ctx.fillStyle = "#d9dee6";
        ctx.beginPath(); ctx.ellipse(x, y, b.w / 2 * k, b.h * k, 0, Math.PI, 0); ctx.fill();
        ctx.fillStyle = "#ffd98a"; ctx.fillRect(x - 0.5 * k, y - b.h * 0.45 * k, 1 * k, 0.6 * k);
      } else if (b.kind === "hab") {
        ctx.fillStyle = "#c8ced8"; ctx.fillRect(x - b.w / 2 * k, y - b.h * k, b.w * k, b.h * k);
        ctx.fillStyle = "#2b3442"; ctx.fillRect(x - b.w / 2 * k, y - b.h * k, b.w * k, 0.4 * k);
        ctx.fillStyle = "#ffd98a";
        for (let i = 1; i < b.w / 2; i++) { ctx.fillRect(x - b.w / 2 * k + i * 2 * k, y - b.h * 0.6 * k, 0.7 * k, 0.6 * k); }
      } else {
        ctx.strokeStyle = "#aab2be"; ctx.lineWidth = Math.max(1, 0.2 * k);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - b.h * k); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - 1.2 * k, y - b.h * 0.8 * k); ctx.lineTo(x + 1.2 * k, y - b.h * 0.8 * k); ctx.stroke();
        light(x, y - b.h * k, "#ff4d4d", Math.sin(time * 2 + b.lit * 6) > 0.2, 0.3);
      }
    }
  }

  function drawBarge(sim) {
    const b = bargeAt(day, sim ? sim.t : 0);
    const k = cam.k;
    const y = sy(b.y);
    ctx.fillStyle = "#2c3440";
    ctx.beginPath();
    ctx.moveTo(sx(b.x - b.half - 3), y);
    ctx.lineTo(sx(b.x + b.half + 3), y);
    ctx.lineTo(sx(b.x + b.half + 1), y + 4 * k);
    ctx.lineTo(sx(b.x - b.half - 1), y + 4 * k);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#e05a3a"; ctx.fillRect(sx(b.x - b.half - 2), y + 1.4 * k, (2 * b.half + 4) * k, 0.6 * k);
    drawPad({ x: b.x, y: b.y, half: b.half }, false);
    for (const s of [-1, 1]) {
      ctx.fillStyle = "#4a5160";
      ctx.fillRect(sx(b.x + s * (b.half + 2)) - 0.6 * k, y - 5 * k, 1.2 * k, 5 * k);
    }
  }

  function drawRings(sim) {
    if (!day.gates) { return; }
    const k = cam.k;
    day.gates.forEach((g, i) => {
      const done = sim && sim.gates[i];
      const next = sim && !done && sim.gates.findIndex((x) => !x) === i;
      const x = sx(g.x), y = sy(g.y), r = g.half * k;
      if (x < -r * 2 || x > W + r * 2) { return; }
      const col = done ? "#7fc6a1" : next ? "#fa6862" : "#f0c24e";
      ctx.lineWidth = Math.max(2, 0.9 * k);
      ctx.strokeStyle = rgba(col, done ? 0.4 : 0.95);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
      if (!done) {
        ctx.globalCompositeOperation = "lighter";
        const g2 = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 1.25);
        g2.addColorStop(0, "rgba(0,0,0,0)"); g2.addColorStop(0.5, rgba(col, 0.25 + 0.1 * Math.sin(time * 4))); g2.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(x, y, r * 1.25, 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.fillStyle = rgba(col, 0.9);
      ctx.font = "800 " + Math.max(10, Math.min(16, 3 * k)) + "px 'Open Sans', sans-serif";
      ctx.textAlign = "center"; ctx.fillText(String(i + 1), x, y - r - 6); ctx.textAlign = "left";
    });
  }

  function drawRibbon(sim) {
    if (!day.ribbon) { return; }
    const y = sy(day.ribbon.y);
    if (y < -20 || y > H + 20) { return; }
    const done = sim && sim.ribbon;
    ctx.strokeStyle = done ? "rgba(127,198,161,0.9)" : "rgba(250,104,98,0.9)";
    ctx.lineWidth = 2;
    ctx.setLineDash(done ? [] : [14, 10]);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = "800 12px 'Open Sans', sans-serif";
    ctx.fillText((done ? "✓ " : "") + day.ribbon.label.toUpperCase(), 12, y - 7);
  }

  // ---- vessels, plumes and canopies
  function drawPlumes(v, sim, mag) {
    mag = mag || 1;
    const mp = v.mp || massProps(v.parts);
    const c = toWorld(v, mp.c, mp.s);
    const big = (pt) => ({ x: c.x + (pt.x - c.x) * mag, y: c.y + (pt.y - c.y) * mag });
    const pAtm = airAt(w, c.y).p;
    const spread = 1 + 2.4 * (1 - clamp(pAtm / 1, 0, 1));
    const sa = Math.sin(v.ang), ca = Math.cos(v.ang);
    ctx.globalCompositeOperation = "lighter";
    for (const p of v.parts) {
      const b = p.burning || 0;
      if (b <= 0.01) { continue; }
      const solid = p.kind === "srb";
      const nz = big(toWorld(v, p.c, p.s0));
      const nw = (p.kind === "engine" || p.kind === "pod" ? p.w * 0.9 : p.w * 0.6) * mag;
      const len = (solid ? 9 : 4 + 9 * b) * nw * (0.9 + Math.random() * 0.2) * (0.8 + 0.4 * spread);
      const ex = nz.x - sa * len, ey = nz.y - ca * len;
      const x0 = sx(nz.x), y0 = sy(nz.y), x1 = sx(ex), y1 = sy(ey);
      const wide = nw * cam.k * 0.5 * spread;
      const nx = ca, ny = -sa; // screen-space normal of the body axis
      const grad = ctx.createLinearGradient(x0, y0, x1, y1);
      if (solid) {
        grad.addColorStop(0, "rgba(255,250,220,0.95)"); grad.addColorStop(0.25, "rgba(255,190,90,0.85)"); grad.addColorStop(1, "rgba(255,120,40,0)");
      } else {
        grad.addColorStop(0, "rgba(235,248,255,0.95)"); grad.addColorStop(0.2, "rgba(150,200,255,0.75)");
        grad.addColorStop(0.55, pAtm > 0.3 ? "rgba(255,170,90,0.45)" : "rgba(120,160,255,0.25)"); grad.addColorStop(1, "rgba(255,120,60,0)");
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x0 + nx * nw * cam.k * 0.45, y0 - ny * nw * cam.k * 0.45);
      ctx.quadraticCurveTo((x0 + x1) / 2 + nx * wide, (y0 + y1) / 2 - ny * wide, x1, y1);
      ctx.quadraticCurveTo((x0 + x1) / 2 - nx * wide, (y0 + y1) / 2 + ny * wide, x0 - nx * nw * cam.k * 0.45, y0 + ny * nw * cam.k * 0.45);
      ctx.closePath(); ctx.fill();
      // shock diamonds in thick air
      if (pAtm > 0.5 && b > 0.45 && !solid) {
        for (let i = 1; i <= 3; i++) {
          const t = i / 4.5;
          ctx.fillStyle = "rgba(255,255,255," + (0.5 - i * 0.1) + ")";
          ctx.beginPath();
          ctx.ellipse(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, nw * cam.k * 0.18, nw * cam.k * 0.1, -v.ang + Math.PI / 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // exhaust smoke and ground wash
      // exhaust lingers as smoke in air: thick for solids, a faint vapour for
      // liquids; near the ground the dust wash takes over
      const gy0 = day.terrain.surfaceAt(ex);
      const high = ey - gy0 > 6;
      if (high && Math.random() < (solid ? (air ? 1 : 0.25) : air ? 0.35 * b : 0)) {
        const spd = solid ? 26 : 18;
        spawn({
          x: ex + (Math.random() - 0.5) * nw, y: ey, vx: v.vx * 0.6 - sa * spd + (Math.random() - 0.5) * 6,
          vy: v.vy * 0.6 - ca * spd + (Math.random() - 0.5) * 6, life: solid ? 5 + Math.random() * 3 : 1.2 + Math.random(),
          age: 0, size: nw * (solid ? 1.2 : 0.6), grow: solid ? 3.2 : 1.6, grav: -0.02, drag: 0.9,
          color: solid ? "rgba(236,232,226,0.5)" : pal.plumeSmoke, add: false, fade: solid ? 1 : 0.55
        });
      }
      // ground wash: dust thrown sideways where the plume hits the ground
      const gy = day.terrain.surfaceAt(ex);
      const near = 1 - clamp((ey - gy) / 22, 0, 1);
      if (near > 0 && Math.random() < b * near * (solid ? 0.8 : 0.45)) {
        const s = Math.random() < 0.5 ? -1 : 1;
        spawn({
          x: ex, y: gy + 0.5, vx: s * (8 + Math.random() * 16), vy: 0.5 + Math.random() * 2.5, life: 0.9 + Math.random() * 0.8,
          age: 0, size: 1.1, grow: 2.2, grav: 0, drag: 0.9, color: rgba(pal.dust, 0.38), add: false, fade: 1
        });
      }
    }
    ctx.globalCompositeOperation = "source-over";
    // rcs puffs
    for (const p of v.parts) {
      if (p.kind !== "rcs" || !p.puff) { continue; }
      const pt = toWorld(v, p.c + p.side * p.w / 2, p.s1 - 0.2);
      if (Math.random() < 0.7) {
        spawn({ x: pt.x, y: pt.y, vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 8, life: 0.35, age: 0, size: 0.4, grow: 2.5, grav: 0, drag: 2, color: "rgba(255,255,255,0.6)", add: false, fade: 1 });
      }
    }
  }

  function drawCanopy(v, sim) {
    if (!v.chutes || !v.chutes.length) { return; }
    if (v.chuteState !== "open" && v.chuteState !== "cut") { return; }
    const f = v.chuteState === "open" ? Math.max(0.15, v.chute) : 0;
    if (f <= 0) { return; }
    let cda = 0;
    for (const p of v.chutes) { cda += p.def.cda; }
    const wind = air ? windAt(day, 300, sim.t) : 0;
    const rvx = v.vx - wind, rvy = v.vy;
    const sp = Math.max(0.1, Math.hypot(rvx, rvy));
    const ux = -rvx / sp, uy = -rvy / sp; // canopy trails the motion
    const att = v.chutes.map((p) => toWorld(v, p.c, p.s1));
    const ax = att.reduce((a, q) => a + q.x, 0) / att.length, ay = att.reduce((a, q) => a + q.y, 0) / att.length;
    const R = Math.sqrt(cda / Math.PI) * (0.4 + 0.6 * f);
    const Lr = R * 2.2 + 4;
    const cx = ax + ux * Lr, cy = ay + uy * Lr;
    ctx.strokeStyle = "rgba(240,240,240,0.7)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const a of att) {
      ctx.moveTo(sx(a.x), sy(a.y));
      ctx.lineTo(sx(cx - uy * R), sy(cy + ux * R));
      ctx.moveTo(sx(a.x), sy(a.y));
      ctx.lineTo(sx(cx + uy * R), sy(cy - ux * R));
    }
    ctx.stroke();
    const ang = Math.atan2(-uy, ux);
    ctx.save();
    ctx.translate(sx(cx), sy(cy));
    ctx.rotate(ang + Math.PI / 2);
    const rr = R * cam.k;
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 ? "#f4f1ea" : "#f07a3a";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, rr, Math.PI + (i / 6) * Math.PI, Math.PI + ((i + 1) / 6) * Math.PI);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  function drawVesselAt(v, sim, alpha) {
    const x = sx(v.x), y = sy(v.y);
    if (x < -600 || x > W + 600 || y < -600 || y > H + 600) { return; }
    // far out, draw the vessel bigger than life around its centre of mass
    // (like a map icon) so it never shrinks to a speck
    let hMax = 1;
    for (const p of v.parts) { hMax = Math.max(hMax, p.s1); }
    const mag = Math.max(1, (v.role === "main" ? 34 : 18) / (hMax * cam.k));
    const mp = v.mp || massProps(v.parts);
    const c = toWorld(v, mp.c, mp.s);
    const kk = cam.k * mag;
    drawCanopy(v, sim);
    drawPlumes(v, sim, mag);
    ctx.save();
    if (alpha != null) { ctx.globalAlpha = alpha; }
    ctx.translate(sx(c.x), sy(c.y));
    ctx.rotate(v.ang);
    ctx.scale(kk, kk);
    ctx.translate(-mp.c, mp.s);
    drawVessel(ctx, v.parts, 1 / kk, { legsOut: v.legsOut, showFill: false });
    ctx.restore();
  }

  function drawShards() {
    for (const s of shards) {
      const fade = s.age > s.life - 3 ? (s.life - s.age) / 3 : 1;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(sx(s.x), sy(s.y));
      ctx.rotate(s.a);
      ctx.scale(cam.k, cam.k);
      ctx.translate(-s.p.c, (s.p.s0 + s.p.s1) / 2);
      drawVessel(ctx, [s.p], 1 / cam.k, { legsOut: true });
      ctx.fillStyle = "rgba(20,16,14," + (0.55 * s.burnt) + ")";
      ctx.fillRect(s.p.c - s.p.w / 2, -s.p.s1, s.p.w, s.p.h);
      ctx.restore();
    }
  }

  function drawParticles() {
    for (const p of parts) {
      const t = p.age / p.life;
      const a = (1 - t) * p.fade;
      const r = Math.max(0.6, p.size * cam.k);
      const x = sx(p.x), y = sy(p.y);
      if (x < -r || x > W + r || y < -r || y > H + r) { continue; }
      if (p.add) { ctx.globalCompositeOperation = "lighter"; }
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.fillStyle = p.color;
      if (r < 1.6) { ctx.fillRect(x - r, y - r, r * 2, r * 2); }
      else { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
      if (p.add) { ctx.globalCompositeOperation = "source-over"; }
    }
    ctx.globalAlpha = 1;
    for (const r of rings) {
      const t = r.age / r.life;
      ctx.strokeStyle = rgba(r.col, (1 - t) * 0.8);
      ctx.lineWidth = 3 * (1 - t) + 1;
      ctx.beginPath(); ctx.arc(sx(r.x), sy(r.y), (r.r * t + 4) * Math.max(1, cam.k * 0.4), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.font = "800 13px 'Open Sans', sans-serif";
    ctx.textAlign = "center";
    for (const t of texts) {
      const a = 1 - t.age / t.life;
      ctx.fillStyle = "rgba(255,255,255," + a + ")";
      ctx.fillText(t.str, sx(t.x), sy(t.y + t.age * 8) - 18);
    }
    ctx.textAlign = "left";
  }

  // ---- guidance overlays
  function drawArc(sim) {
    const v = sim.main;
    if (!sim.ignited || v.resting || sim.done) { arc = null; return; }
    if (!arc || time - arcAt > 0.12) {
      arc = coast(sim, v, { points: true, dt: 0.15, tMax: 70 });
      arcAt = time;
    }
    if (!arc.pts || arc.pts.length < 2) { return; }
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    arc.pts.forEach((p, i) => { if (i === 0) { ctx.moveTo(sx(p.x), sy(p.y)); } else { ctx.lineTo(sx(p.x), sy(p.y)); } });
    ctx.stroke();
    ctx.setLineDash([]);
    if (arc.hit) {
      const x = sx(arc.x), y = sy(day.terrain.surfaceAt(arc.x));
      ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6); ctx.moveTo(x + 6, y - 6); ctx.lineTo(x - 6, y + 6); ctx.stroke();
    }
  }

  function drawGhost(g, sim) {
    if (!g || !g.trail || g.trail.length < 2) { return; }
    ctx.strokeStyle = "rgba(127,198,161,0.35)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    g.trail.forEach((p, i) => { if (i === 0) { ctx.moveTo(sx(p.x), sy(p.y)); } else { ctx.lineTo(sx(p.x), sy(p.y)); } });
    ctx.stroke();
    if (g.pos) {
      const x = sx(g.pos.x), y = sy(g.pos.y);
      ctx.save(); ctx.translate(x, y); ctx.rotate(g.pos.a);
      ctx.fillStyle = "rgba(127,198,161,0.55)";
      const s = Math.max(5, cam.k * 3);
      ctx.beginPath(); ctx.moveTo(0, -s * 1.6); ctx.lineTo(s * 0.6, s); ctx.lineTo(-s * 0.6, s); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  function drawTrail(trail) {
    if (!trail || trail.length < 2) { return; }
    ctx.strokeStyle = "rgba(250,104,98,0.5)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    trail.forEach((p, i) => { if (i === 0) { ctx.moveTo(sx(p.x), sy(p.y)); } else { ctx.lineTo(sx(p.x), sy(p.y)); } });
    ctx.stroke();
  }

  function drawPointer(sim) {
    const tg = simTarget(sim);
    const x = sx(tg.x), y = sy(tg.y);
    const m = 34;
    if (x > m && x < W - m && y > m && y < H - m) { return; }
    const cx = W / 2, cy = H / 2;
    const ang = Math.atan2(y - cy, x - cx);
    // stay clear of the throttle bar on the right and the buttons below
    const ex = clamp(cx + Math.cos(ang) * W, m, W - 104), ey = clamp(cy + Math.sin(ang) * H, m + 70, H - 110);
    const c = comWorld(sim.main);
    const d = Math.hypot(tg.x - c.x, tg.y - c.y);
    ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
    ctx.fillStyle = sim.leg > 0 ? "#62b3ff" : "#7fc6a1";
    ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-6, -8); ctx.lineTo(-6, 8); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "700 11px 'Open Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(d >= 1000 ? (d / 1000).toFixed(1) + " km" : Math.round(d) + " m", ex - Math.cos(ang) * 26, ey - Math.sin(ang) * 26 + 4);
    ctx.textAlign = "left";
  }

  // ---- frame
  function frame(sim, dt, extra) {
    extra = extra || {};
    time += dt;
    // a device struggling for frames sheds particles until it keeps up
    if (dt > 0.026) { slowT += dt; } else { slowT = Math.max(0, slowT - dt * 0.5); }
    if (slowT > 1.5 && fxCap > 300) { fxCap = Math.round(fxCap * 0.7); slowT = 0; if (parts.length > fxCap) { parts.length = fxCap; } }
    if (!W) { resize(); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    updateCamera(sim, dt);
    stepParticles(dt, sim);

    drawSky(sim);
    drawClouds(sim, false);
    drawRibbon(sim);
    drawTerrain();
    drawLaunchPad(sim);
    for (let i = 0; i < day.legs.length; i++) {
      if (day.barge) { continue; }
      const t = day.legs[i].target;
      if (t.x === day.launch.x && i > 0) { drawPad(t, true); continue; }
      drawPad(t, false);
    }
    if (day.barge) { drawBarge(sim); }
    drawBuildings();
    drawRings(sim);
    drawGhost(extra.ghost, sim);
    drawTrail(extra.trail);
    drawArc(sim);
    for (const d of sim.landed) { drawVesselAt(d, sim); }
    for (const d of sim.debris) { if (d.alive) { drawVesselAt(d, sim); } }
    if (sim.main.alive && !sim.main.shattered) { drawVesselAt(sim.main, sim); }
    drawShards();
    drawParticles();
    drawClouds(sim, true);
    if (sim.ignited && !sim.done) { drawPointer(sim); }

    if (flash > 0) {
      ctx.fillStyle = "rgba(255,240,210," + flash + ")";
      ctx.fillRect(0, 0, W, H);
      flash = Math.max(0, flash - dt * 1.6);
    }
    // vignette
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.75);
    vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,0.28)");
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  }

  resize();
  return { resize, reset, frame, onEvent, get cam() { return cam; } };
}
