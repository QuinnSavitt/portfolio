/* Daily Rocket — canvas renderer.
 *
 * Pure presentation: reads sim state, never writes it. Anything random in
 * here (particle scatter, twinkle) is allowed to use Math.random because it
 * cannot influence physics or scoring.
 *
 * World frame: +x downrange, +y up. Screen y is down, so sy() flips, and a
 * positive ship.ang (leaning downrange) becomes a clockwise canvas rotate.
 */

import { noise1d } from "./daily.js";
import { BODY, V_LAND, H_LAND, windAt } from "./physics.js";

const SPACE = "#04060c";
const SPACE_LO = "#0b101b";

function hexRgb(h) {
  return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
}
function mix(a, b, t) {
  const A = hexRgb(a), B = hexRgb(b);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return "rgb(" + Math.round(A[0] + (B[0] - A[0]) * t) + "," +
    Math.round(A[1] + (B[1] - A[1]) * t) + "," + Math.round(A[2] + (B[2] - A[2]) * t) + ")";
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createRenderer(canvas, day) {
  const ctx = canvas.getContext("2d");
  const w = day.world, wd = w.def;
  let W = 0, H = 0, dpr = 1;

  const cam = { x: 0, y: day.terrain.launchY + 40, scale: 5 };
  let shake = 0, shakeX = 0, shakeY = 0;
  let flash = 0;
  let time = 0;

  const particles = [];
  const texts = [];
  const rings = [];

  // ---- per-day static scenery ------------------------------------------
  const stars = [];
  for (let i = 0; i < 110; i++) {
    stars.push({
      x: Math.random() * 2200, y: Math.random(),
      s: Math.random() * 1.4 + 0.4, tw: Math.random() * 6.28, spd: 0.5 + Math.random() * 2
    });
  }
  const clouds = [];
  if (wd.cloud) {
    const span = day.extent + 900;
    for (let i = 0; i < 12; i++) {
      clouds.push({
        x: -450 + Math.random() * span,
        y: day.terrain.launchY + 250 + Math.random() * 900,
        r: 50 + Math.random() * 110,
        depth: 0.45 + Math.random() * 0.35,
        squash: 0.3 + Math.random() * 0.15
      });
    }
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    W = r.width; H = r.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const sx = (x) => W / 2 + (x - cam.x) * cam.scale + shakeX;
  const sy = (y) => H * 0.6 - (y - cam.y) * cam.scale + shakeY;

  // ---- particles --------------------------------------------------------
  function spawn(p) { if (particles.length < 900) { particles.push(p); } }

  function burst(x, y, opts) {
    const n = opts.n || 10;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (opts.speed || 10) * (0.3 + Math.random());
      spawn({
        x, y,
        vx: Math.cos(a) * sp + (opts.vx || 0),
        vy: Math.sin(a) * sp * (opts.upBias ? Math.abs(Math.sin(a)) : 1) + (opts.vy || 0),
        life: (opts.life || 1) * (0.5 + Math.random() * 0.8),
        age: 0, size: (opts.size || 1.2) * (0.6 + Math.random() * 0.8),
        grav: opts.grav != null ? opts.grav : 0.4,
        drag: opts.drag != null ? opts.drag : 0.2,
        grow: opts.grow || 0,
        color: opts.colors[(Math.random() * opts.colors.length) | 0],
        rect: !!opts.rect, rot: Math.random() * 6.28, rotV: (Math.random() - 0.5) * 8
      });
    }
  }

  function stepParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) { particles.splice(i, 1); continue; }
      p.vy -= w.g * p.grav * dt;
      const dr = 1 - Math.min(0.9, p.drag * dt * (w.rho0 > 0 ? 3 : 0.6));
      p.vx *= dr; p.vy *= dr;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.rotV * dt;
      const g = day.terrain.heightAt(p.x);
      if (p.y < g) { p.y = g; p.vy = Math.abs(p.vy) * 0.2; p.vx *= 0.6; }
      p.size += p.grow * dt;
    }
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i];
      t.age += dt; t.y += 14 * dt;
      if (t.age >= t.life) { texts.splice(i, 1); }
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      rings[i].age += dt;
      if (rings[i].age >= rings[i].life) { rings.splice(i, 1); }
    }
  }

  // ---- events from the sim ---------------------------------------------
  function onEvent(e, ship) {
    if (e.type === "explosion") {
      shake = Math.max(shake, 26);
      flash = 0.55;
      burst(e.x, e.y, { n: 34, speed: 26, life: 1.3, size: 2.4, grav: 0.5, colors: ["#ffd9a0", "#fa8a52", "#fa6862", "#7d3a35"] });
      burst(e.x, e.y, { n: 16, speed: 34, life: 2.6, size: 1.6, grav: 1, rect: true, colors: ["#8d97a8", "#5c6674", "#3d4552"] });
      burst(e.x, e.y, { n: 22, speed: 12, life: 2.2, size: 3.2, grow: 4, grav: 0.05, colors: ["rgba(60,60,64,0.5)", "rgba(90,88,84,0.45)"] });
    } else if (e.type === "beacon") {
      rings.push({ x: e.x, y: e.y, age: 0, life: 0.7 });
      burst(e.x, e.y, { n: 14, speed: 18, life: 0.8, size: 1.1, grav: 0, colors: ["#ffe9a0", "#fa6862", "#ffffff"] });
      texts.push({ x: e.x, y: e.y + 12, age: 0, life: 1.2, str: "+800" });
    } else if (e.type === "touchdown") {
      shake = Math.max(shake, e.speed > 2.5 ? 7 : 3);
      burst(e.x, e.y - BODY.halfH + 1, {
        n: 14, speed: 8, life: 0.9, size: 2, grav: 0.3, upBias: true, grow: 2,
        colors: [wd.groundLit, wd.ground]
      });
    } else if (e.type === "liftoff") {
      shake = Math.max(shake, 3);
    } else if (e.type === "flameout") {
      burst(e.x, e.y, { n: 6, speed: 4, life: 0.6, size: 1.4, grav: 0, colors: ["#9aa2ad", "#6f7680"] });
    }
  }

  // ---- background -------------------------------------------------------
  function drawSky(alt) {
    const spaceAlt = w.rho0 > 0 ? w.scaleH * 2.0 : 200;
    const hz = w.rho0 > 0 ? clamp(alt / spaceAlt, 0, 1) : 1;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, mix(wd.skyTop, SPACE, hz));
    g.addColorStop(1, mix(wd.skyBot, SPACE_LO, hz * 0.85));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // stars fade in as the air thins
    const sk = w.rho0 > 0 ? clamp((hz - 0.25) / 0.6, 0, 1) : 1;
    if (sk > 0.02) {
      for (const st of stars) {
        const px = ((st.x - cam.x * 0.05) % (W + 60) + W + 60) % (W + 60) - 30;
        const py = st.y * H * 0.85;
        const tw = 0.55 + 0.45 * Math.sin(time * st.spd + st.tw);
        ctx.fillStyle = "rgba(255,255,255," + (sk * tw * 0.9).toFixed(3) + ")";
        ctx.fillRect(px, py, st.s, st.s);
      }
    }

    // sun with a soft bloom, slow parallax
    const sunX = W * 0.78 - cam.x * 0.01;
    const sunY = H * 0.2 + cam.y * 0.008 * cam.scale;
    const sun = wd.sun;
    const bloom = ctx.createRadialGradient(sunX, sunY, 2, sunX, sunY, sun.r * 3.2);
    bloom.addColorStop(0, sun.glow + "");
    bloom.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = bloom;
    ctx.fillRect(sunX - sun.r * 3.2, sunY - sun.r * 3.2, sun.r * 6.4, sun.r * 6.4);
    ctx.globalAlpha = 1;
    ctx.fillStyle = sun.color;
    ctx.beginPath(); ctx.arc(sunX, sunY, sun.r, 0, 6.283); ctx.fill();

    // Selene gets a big neighbour planet on the horizon
    if (wd.planet) {
      const px = W * 0.16 - cam.x * 0.006;
      const py = H * 0.34 + cam.y * 0.004 * cam.scale;
      const pr = wd.planet.r;
      const pg = ctx.createRadialGradient(px - pr * 0.4, py - pr * 0.4, pr * 0.1, px, py, pr);
      pg.addColorStop(0, wd.planet.color2);
      pg.addColorStop(1, wd.planet.color);
      ctx.fillStyle = pg;
      ctx.beginPath(); ctx.arc(px, py, pr, 0, 6.283); ctx.fill();
      ctx.fillStyle = "rgba(4,6,12,0.55)";
      ctx.beginPath(); ctx.arc(px + pr * 0.45, py, pr, 0, 6.283); ctx.fill();
    }

    if (clouds.length) {
      const drift = w.wind * w.windDir * time * 0.4;
      for (const cl of clouds) {
        const cx = W / 2 + (cl.x + drift * cl.depth - cam.x) * cam.scale * cl.depth;
        const cy = H * 0.6 - (cl.y - cam.y) * cam.scale * cl.depth;
        if (cx < -300 || cx > W + 300 || cy < -200 || cy > H + 200) { continue; }
        const r = cl.r * cam.scale * cl.depth;
        ctx.fillStyle = wd.cloud;
        ctx.beginPath();
        ctx.ellipse(cx, cy, r, r * cl.squash, 0, 0, 6.283);
        ctx.ellipse(cx - r * 0.7, cy + r * 0.08, r * 0.6, r * cl.squash * 0.7, 0, 0, 6.283);
        ctx.ellipse(cx + r * 0.7, cy + r * 0.06, r * 0.65, r * cl.squash * 0.75, 0, 0, 6.283);
        ctx.fill();
      }
    }
  }

  function drawParallax() {
    const layers = [
      { depth: 0.3, salt: day.seed ^ 0x11, amp: 130, lift: 30, k: 0.74 },
      { depth: 0.55, salt: day.seed ^ 0x77, amp: 85, lift: 0, k: 0.48 }
    ];
    for (const L of layers) {
      ctx.fillStyle = mix(wd.rock, wd.skyBot, L.k);
      ctx.beginPath();
      let first = true;
      for (let px = -24; px <= W + 24; px += 18) {
        const wx = cam.x + (px - W / 2) / (cam.scale * L.depth);
        const h = day.terrain.launchY + L.lift +
          noise1d(wx / 1500, L.salt) * L.amp + noise1d(wx / 420, L.salt ^ 5) * L.amp * 0.3;
        const py = H * 0.6 - (h - cam.y) * cam.scale * L.depth;
        if (first) { ctx.moveTo(px, py); first = false; } else { ctx.lineTo(px, py); }
      }
      ctx.lineTo(W + 24, H + 40); ctx.lineTo(-24, H + 40);
      ctx.closePath(); ctx.fill();
    }
  }

  function drawTerrain() {
    const t = day.terrain;
    const yTopOf = (px) => sy(t.heightAt(cam.x + (px - W / 2) / cam.scale));
    // fill
    const grd = ctx.createLinearGradient(0, H * 0.3, 0, H);
    grd.addColorStop(0, wd.groundLit);
    grd.addColorStop(1, mix(wd.ground, "#000000", 0.45));
    ctx.fillStyle = grd;
    ctx.beginPath();
    let first = true;
    for (let px = 0; px <= W; px += 3) {
      const py = yTopOf(px);
      if (first) { ctx.moveTo(px, py); first = false; } else { ctx.lineTo(px, py); }
    }
    ctx.lineTo(W, H + 40); ctx.lineTo(0, H + 40);
    ctx.closePath(); ctx.fill();
    // rim light
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    first = true;
    for (let px = 0; px <= W; px += 3) {
      const py = yTopOf(px);
      if (first) { ctx.moveTo(px, py); first = false; } else { ctx.lineTo(px, py); }
    }
    ctx.stroke();
  }

  function drawPads(ship) {
    const t = day.terrain, p = day.pad;
    // launch gantry
    const lx = sx(0), ly = sy(t.launchY);
    const gs = cam.scale;
    ctx.strokeStyle = "#3a4453";
    ctx.lineWidth = Math.max(1, gs * 0.5);
    ctx.beginPath();
    ctx.moveTo(lx - 6 * gs, ly); ctx.lineTo(lx - 6 * gs, ly - 12 * gs);
    ctx.moveTo(lx - 6 * gs, ly - 4 * gs); ctx.lineTo(lx - 2.6 * gs, ly - 4 * gs);
    ctx.moveTo(lx - 6 * gs, ly - 9 * gs); ctx.lineTo(lx - 2.6 * gs, ly - 9 * gs);
    ctx.stroke();
    ctx.fillStyle = "#2c3542";
    ctx.fillRect(lx - 10 * gs, ly - 0.6 * gs, 20 * gs, 1.6 * gs);

    // target pad: platform, chevrons, edge lights, guidance shaft
    const py = sy(t.padY);
    const x0 = sx(p.x - p.halfW), x1 = sx(p.x + p.halfW);
    if (x1 > -80 && x0 < W + 80) {
      // light shaft so the pad is findable from far out
      const pulse = 0.35 + 0.2 * Math.sin(time * 2.2);
      const shaft = ctx.createLinearGradient(0, py - 150 * cam.scale, 0, py);
      shaft.addColorStop(0, "rgba(250,104,98,0)");
      shaft.addColorStop(1, "rgba(250,104,98," + (0.14 * pulse * 2).toFixed(3) + ")");
      ctx.fillStyle = shaft;
      ctx.fillRect(sx(p.x) - 2.5 * cam.scale, py - 150 * cam.scale, 5 * cam.scale, 150 * cam.scale);

      ctx.fillStyle = "#333d4c";
      ctx.fillRect(x0, py - 1.4 * cam.scale, x1 - x0, 2.8 * cam.scale);
      ctx.fillStyle = "#3d4857";
      ctx.fillRect(x0, py - 1.4 * cam.scale, x1 - x0, 0.9 * cam.scale);
      // chevrons toward centre
      ctx.strokeStyle = "rgba(250,104,98,0.85)";
      ctx.lineWidth = Math.max(1.5, cam.scale * 0.5);
      const cxp = sx(p.x);
      for (let k = 1; k <= 3; k++) {
        const off = k * 9 * cam.scale;
        ctx.beginPath();
        ctx.moveTo(cxp - off - 4 * cam.scale, py - 1.6 * cam.scale);
        ctx.lineTo(cxp - off, py - 4.2 * cam.scale);
        ctx.moveTo(cxp + off + 4 * cam.scale, py - 1.6 * cam.scale);
        ctx.lineTo(cxp + off, py - 4.2 * cam.scale);
        ctx.stroke();
      }
      // blinking edge lights
      const blink = Math.sin(time * 5) > 0;
      ctx.fillStyle = blink ? "#fa6862" : "#7f4340";
      ctx.beginPath(); ctx.arc(x0, py - 2 * cam.scale, Math.max(1.5, cam.scale * 0.45), 0, 6.283); ctx.fill();
      ctx.fillStyle = blink ? "#7f4340" : "#fa6862";
      ctx.beginPath(); ctx.arc(x1, py - 2 * cam.scale, Math.max(1.5, cam.scale * 0.45), 0, 6.283); ctx.fill();
      // centre marker
      ctx.fillStyle = "#fa6862";
      ctx.fillRect(cxp - Math.max(1, cam.scale * 0.3) / 2, py - 5.5 * cam.scale, Math.max(1, cam.scale * 0.3), 4 * cam.scale);
    }
  }

  function drawBeacons(ship) {
    for (let i = 0; i < day.beacons.length; i++) {
      const b = day.beacons[i];
      const bx = sx(b.x), by = sy(b.y);
      if (bx < -80 || bx > W + 80 || by < -80 || by > H + 80) { continue; }
      const got = ship.beacons[i];
      const r = Math.max(5, 3.2 * cam.scale);
      if (!got) {
        const pulse = 0.5 + 0.5 * Math.sin(time * 3 + i * 2.1);
        const halo = ctx.createRadialGradient(bx, by, 1, bx, by, r * (3.6 + pulse));
        halo.addColorStop(0, "rgba(250,104,98,0.6)");
        halo.addColorStop(1, "rgba(250,104,98,0)");
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(bx, by, r * (3.6 + pulse), 0, 6.283); ctx.fill();
      }
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(time * (got ? 0 : 0.8) + i);
      ctx.fillStyle = got ? "rgba(160,170,185,0.5)" : "#ffd9d7";
      ctx.strokeStyle = got ? "rgba(160,170,185,0.6)" : "#fa6862";
      ctx.lineWidth = Math.max(1, cam.scale * 0.35);
      ctx.beginPath();
      ctx.moveTo(0, -r); ctx.lineTo(r * 0.7, 0); ctx.lineTo(0, r); ctx.lineTo(-r * 0.7, 0);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    for (const ring of rings) {
      const k = ring.age / ring.life;
      ctx.strokeStyle = "rgba(250,104,98," + (0.8 * (1 - k)).toFixed(3) + ")";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(sx(ring.x), sy(ring.y), (4 + k * 46) * cam.scale * 0.35 + k * 30, 0, 6.283);
      ctx.stroke();
    }
  }

  function drawTrail(pts, color, dashed) {
    if (!pts || pts.length < 2) { return; }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    if (dashed) { ctx.setLineDash([5, 6]); }
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const px = sx(pts[i].x), py = sy(pts[i].y);
      if (i === 0) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ---- the ship ---------------------------------------------------------
  let legK = 0;      // leg deploy animation 0..1
  let flick = 0;

  function drawShip(ship, ghost, galpha) {
    const s = cam.scale;
    ctx.save();
    ctx.translate(ghost ? sx(ghost.x) : sx(ship.x), ghost ? sy(ghost.y) : sy(ship.y));
    ctx.rotate(ghost ? ghost.ang : ship.ang);
    if (ghost) { ctx.globalAlpha = galpha; }

    const eng = ship.engine;
    const bellW = eng.id === "mule" ? 1.5 : eng.id === "kestrel" ? 1.15 : 0.9;
    const bellH = eng.id === "mule" ? 1.5 : 1.2;

    // flame first, behind the bell
    if (!ghost && ship.burning > 0.02 && !ship.done) {
      flick = 0.8 + 0.4 * Math.random();
      const th = ship.burning;
      const base = BODY.halfH + bellH * 0.8;
      const len = (2.5 + 9.5 * th) * flick;
      const wdt = bellW * (0.55 + th * 0.35);
      const vac = w.rho0 <= 0.02;
      const fg = ctx.createLinearGradient(0, base * s, 0, (base + len) * s);
      if (vac) {
        fg.addColorStop(0, "rgba(220,235,255,0.9)");
        fg.addColorStop(0.5, "rgba(140,180,255,0.35)");
        fg.addColorStop(1, "rgba(120,160,255,0)");
      } else {
        fg.addColorStop(0, "rgba(255,244,214,0.95)");
        fg.addColorStop(0.45, "rgba(252,150,70,0.8)");
        fg.addColorStop(1, "rgba(250,104,98,0)");
      }
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(-wdt * s, base * s);
      ctx.quadraticCurveTo(-wdt * 1.15 * s, (base + len * 0.4) * s, 0, (base + len * (vac ? 1.5 : 1)) * s);
      ctx.quadraticCurveTo(wdt * 1.15 * s, (base + len * 0.4) * s, wdt * s, base * s);
      ctx.closePath();
      ctx.fill();
      // white core
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      ctx.moveTo(-wdt * 0.4 * s, base * s);
      ctx.quadraticCurveTo(0, (base + len * 0.5) * s, wdt * 0.4 * s, base * s);
      ctx.closePath();
      ctx.fill();
    }

    // landing legs (animated; purely visual)
    const lk = ghost ? 1 : legK;
    if (lk > 0.02) {
      ctx.strokeStyle = ghost ? "#9aa5b5" : "#7a8496";
      ctx.lineWidth = Math.max(1, 0.28 * s);
      for (const side of [-1, 1]) {
        const hipX = side * BODY.radius * 0.85, hipY = BODY.halfH - 1.6;
        const footX = side * (BODY.radius * 0.85 + (BODY.footX - BODY.radius * 0.85) * lk);
        const footY = BODY.halfH - 1.6 + (BODY.halfH - (BODY.halfH - 1.6)) * lk + 0.0;
        ctx.beginPath();
        ctx.moveTo(hipX * s, hipY * s);
        ctx.lineTo(footX * s, (footY + 1.6 * lk) * s);
        ctx.stroke();
        if (lk > 0.9) {
          ctx.beginPath();
          ctx.moveTo((footX - side * 0.35) * s, (footY + 1.6) * s);
          ctx.lineTo((footX + side * 0.45) * s, (footY + 1.6) * s);
          ctx.stroke();
        }
      }
    }

    // engine bell
    const bellGrad = ctx.createLinearGradient(-bellW * s, 0, bellW * s, 0);
    bellGrad.addColorStop(0, "#4a5364");
    bellGrad.addColorStop(0.5, ship.burning > 0.02 && !ghost ? "#8a5a4e" : "#2e3540");
    bellGrad.addColorStop(1, "#232a34");
    ctx.fillStyle = bellGrad;
    ctx.beginPath();
    ctx.moveTo(-bellW * 0.45 * s, BODY.halfH * s * 0.94);
    ctx.lineTo(-bellW * s, (BODY.halfH + bellH) * s * 0.94);
    ctx.lineTo(bellW * s, (BODY.halfH + bellH) * s * 0.94);
    ctx.lineTo(bellW * 0.45 * s, BODY.halfH * s * 0.94);
    ctx.closePath(); ctx.fill();

    // hull
    const R = BODY.radius, hh = BODY.halfH;
    const hull = ctx.createLinearGradient(-R * s, 0, R * s, 0);
    if (ghost) {
      hull.addColorStop(0, "rgba(220,228,240,0.9)");
      hull.addColorStop(1, "rgba(150,160,178,0.9)");
    } else {
      hull.addColorStop(0, "#f2f4f8");
      hull.addColorStop(0.55, "#d8dee8");
      hull.addColorStop(1, "#aab4c4");
    }
    ctx.fillStyle = hull;
    ctx.beginPath();
    ctx.moveTo(-R * s, (hh - 0.6) * s);
    ctx.lineTo(-R * s, (-hh + 2.4) * s);
    ctx.quadraticCurveTo(-R * s, (-hh + 0.6) * s, 0, -hh * s);
    ctx.quadraticCurveTo(R * s, (-hh + 0.6) * s, R * s, (-hh + 2.4) * s);
    ctx.lineTo(R * s, (hh - 0.6) * s);
    ctx.quadraticCurveTo(0, (hh - 0.2) * s, -R * s, (hh - 0.6) * s);
    ctx.closePath();
    ctx.fill();

    if (!ghost) {
      // nose band
      ctx.fillStyle = "#fa6862";
      ctx.beginPath();
      ctx.moveTo(-R * s, (-hh + 2.0) * s);
      ctx.lineTo(-R * s, (-hh + 2.4) * s);
      ctx.quadraticCurveTo(-R * s, (-hh + 0.6) * s, 0, -hh * s);
      ctx.quadraticCurveTo(R * s, (-hh + 0.6) * s, R * s, (-hh + 2.4) * s);
      ctx.lineTo(R * s, (-hh + 2.0) * s);
      ctx.quadraticCurveTo(R * 0.99 * s, (-hh + 0.9) * s, 0, (-hh + 0.55) * s);
      ctx.quadraticCurveTo(-R * 0.99 * s, (-hh + 0.9) * s, -R * s, (-hh + 2.0) * s);
      ctx.closePath();
      ctx.fill();

      // window
      ctx.fillStyle = "#273443";
      ctx.beginPath(); ctx.arc(0, (-hh + 2.1) * s, 0.42 * s, 0, 6.283); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.beginPath(); ctx.arc(-0.12 * s, (-hh + 1.98) * s, 0.13 * s, 0, 6.283); ctx.fill();

      // panel lines + accent stripe near the tail
      ctx.strokeStyle = "rgba(40,50,64,0.25)";
      ctx.lineWidth = Math.max(0.6, 0.08 * s);
      ctx.beginPath();
      ctx.moveTo(-R * s, 0.4 * s); ctx.lineTo(R * s, 0.4 * s);
      ctx.stroke();
      ctx.fillStyle = "#fa6862";
      ctx.fillRect(-R * s, (hh - 1.5) * s, R * 2 * s * 0.18, 0.55 * s);

      // fins
      ctx.fillStyle = "#c2cad8";
      ctx.strokeStyle = "rgba(40,50,64,0.4)";
      ctx.lineWidth = Math.max(0.6, 0.08 * s);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * R * s, (hh - 2.4) * s);
        ctx.lineTo(side * (R + 0.75) * s, (hh - 0.1) * s);
        ctx.lineTo(side * R * s, (hh - 0.5) * s);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawParticles() {
    for (const p of particles) {
      const k = 1 - p.age / p.life;
      ctx.globalAlpha = Math.min(1, k * 1.4);
      ctx.fillStyle = p.color;
      if (p.rect) {
        ctx.save();
        ctx.translate(sx(p.x), sy(p.y));
        ctx.rotate(p.rot);
        const sz = p.size * cam.scale * 0.6;
        ctx.fillRect(-sz / 2, -sz / 3, sz, sz * 0.66);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(sx(p.x), sy(p.y), Math.max(0.5, p.size * cam.scale * 0.45), 0, 6.283);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    if (texts.length) {
      ctx.font = "700 " + Math.max(13, cam.scale * 2.6) + "px 'Open Sans', sans-serif";
      ctx.textAlign = "center";
      for (const t of texts) {
        ctx.globalAlpha = 1 - t.age / t.life;
        ctx.fillStyle = "#ffe9a0";
        ctx.fillText(t.str, sx(t.x), sy(t.y));
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";
    }
  }

  function drawVelocityGuide(ship, alt) {
    if (ship.done || ship.resting || alt > 260) { return; }
    const spd = Math.hypot(ship.vx, ship.vy);
    if (spd < 0.3) { return; }
    const px = sx(ship.x), py = sy(ship.y);
    const nx = ship.vx / spd, ny = ship.vy / spd;
    const len = clamp(spd * 2.2, 10, 46);
    const ok = Math.abs(ship.vy) <= V_LAND && Math.abs(ship.vx) <= H_LAND;
    const warm = Math.abs(ship.vy) <= V_LAND * 1.6 && Math.abs(ship.vx) <= H_LAND * 1.8;
    ctx.strokeStyle = ok ? "rgba(127,198,161,0.9)" : warm ? "rgba(240,200,110,0.9)" : "rgba(250,104,98,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px + nx * 14, py - ny * 14);
    ctx.lineTo(px + nx * (14 + len), py - ny * (14 + len));
    ctx.stroke();
    const tipX = px + nx * (14 + len), tipY = py - ny * (14 + len);
    ctx.beginPath();
    ctx.arc(tipX, tipY, 2.6, 0, 6.283);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }

  function drawOffscreenMarkers(ship) {
    // pad arrow
    const px = sx(day.pad.x);
    const py = sy(day.terrain.padY);
    const off = px < 26 || px > W - 26 || py < 20 || py > H - 10;
    if (off && !ship.done) {
      const ex = clamp(px, 26, W - 26);
      const ey = clamp(py, H * 0.2, H - 150); // stay clear of the touch controls
      const d = Math.abs(ship.x - day.pad.x);
      const dir = px < 26 ? -1 : px > W - 26 ? 1 : 0;
      ctx.fillStyle = "rgba(250,104,98,0.95)";
      ctx.save();
      ctx.translate(ex, ey);
      if (dir !== 0) { ctx.rotate(dir > 0 ? 0 : Math.PI); }
      else { ctx.rotate(py < 20 ? -Math.PI / 2 : Math.PI / 2); }
      ctx.beginPath();
      ctx.moveTo(9, 0); ctx.lineTo(-5, -7); ctx.lineTo(-5, 7);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.font = "700 11px 'Open Sans', sans-serif";
      ctx.textAlign = dir > 0 ? "right" : "left";
      ctx.fillText(
        d >= 1000 ? (d / 1000).toFixed(1) + " km" : Math.round(d) + " m",
        dir > 0 ? W - 40 : dir < 0 ? 40 : ex + 12, ey + 4);
      ctx.textAlign = "left";
    }
  }

  // ---- ambient wind streaks --------------------------------------------
  let windAcc = 0;
  function ambientWind(dt, ship) {
    const wind = windAt(day, ship.t);
    if (Math.abs(wind) < 3.5) { return; }
    windAcc += dt * Math.abs(wind) * 0.5;
    while (windAcc > 1) {
      windAcc -= 1;
      const wx = cam.x + (Math.random() - 0.5) * W / cam.scale;
      const wy = cam.y + (Math.random() - 0.35) * H / cam.scale;
      if (wy < day.terrain.heightAt(wx) + 2) { continue; }
      spawn({
        x: wx, y: wy, vx: wind * (1.4 + Math.random()), vy: (Math.random() - 0.5) * 2,
        life: 0.8 + Math.random() * 0.8, age: 0, size: 0.8, grav: 0, drag: 0,
        grow: 0, color: "rgba(255,255,255,0.16)", rect: false, rot: 0, rotV: 0
      });
    }
  }

  // ---- exhaust / dust coupling -----------------------------------------
  let exAcc = 0;
  function engineParticles(ship, alt, dt) {
    if (ship.burning <= 0.02 || ship.done) { return; }
    exAcc += dt * (18 + ship.burning * 40);
    const vac = w.rho0 <= 0.02;
    const ux = Math.sin(ship.ang), uy = Math.cos(ship.ang);
    const bx = ship.x - ux * (BODY.halfH + 1.4);
    const by = ship.y - uy * (BODY.halfH + 1.4);
    while (exAcc > 1) {
      exAcc -= 1;
      const jit = (Math.random() - 0.5) * 2.4;
      if (vac) {
        spawn({
          x: bx, y: by,
          vx: ship.vx - ux * (30 + Math.random() * 26) + jit * 2, vy: ship.vy - uy * (30 + Math.random() * 26),
          life: 0.35 + Math.random() * 0.3, age: 0, size: 0.7, grav: 0, drag: 0, grow: 0,
          color: Math.random() < 0.5 ? "rgba(190,215,255,0.5)" : "rgba(255,255,255,0.4)",
          rect: false, rot: 0, rotV: 0
        });
      } else {
        spawn({
          x: bx, y: by,
          vx: ship.vx * 0.3 - ux * (12 + Math.random() * 10) + jit, vy: ship.vy * 0.3 - uy * (12 + Math.random() * 10),
          life: 0.9 + Math.random() * 1.1, age: 0, size: 1.1, grav: -0.06, drag: 0.5, grow: 2.6,
          color: Math.random() < 0.6 ? "rgba(235,235,235,0.28)" : "rgba(200,200,205,0.22)",
          rect: false, rot: 0, rotV: 0
        });
      }
    }
    // ground-effect dust
    if (alt < 22 && alt > -1) {
      const gx = ship.x - ux * alt;
      const gy = day.terrain.heightAt(gx);
      const power = ship.burning * (1 - alt / 22);
      if (Math.random() < power * 0.9) {
        for (const side of [-1, 1]) {
          spawn({
            x: gx + side * (1 + Math.random() * 2), y: gy + 0.5,
            vx: side * (8 + Math.random() * 14) * power + windAt(day, ship.t) * 0.4,
            vy: (2 + Math.random() * 5) * power,
            life: 0.8 + Math.random(), age: 0, size: 1.6, grav: 0.25, drag: 0.4, grow: 3,
            color: Math.random() < 0.5 ? wd.groundLit : wd.ground,
            rect: false, rot: 0, rotV: 0
          });
        }
      }
    }
  }

  // ---- camera -----------------------------------------------------------
  function updateCamera(ship, dt) {
    const alt = ship.y - day.terrain.heightAt(ship.x);
    const spd = Math.hypot(ship.vx, ship.vy);
    let want = clamp(195 / (16 + spd * 1.25 + Math.max(0, alt) * 0.05), 1.6, 7.2);
    const toPad = Math.abs(ship.x - day.pad.x);
    if (alt < 150 && toPad < 300) { want = Math.max(want, 4.4); }
    if (ship.resting && !ship.everFlew) { want = Math.max(want, 4.6); }
    cam.scale += (want - cam.scale) * Math.min(1, dt * 1.8);

    const lead = clamp(ship.vx * 0.6, -110, 110);
    const lift = clamp(ship.vy * 0.35, -60, 90);
    cam.x += ((ship.x + lead) - cam.x) * Math.min(1, dt * 4);
    cam.y += ((ship.y + lift + 8) - cam.y) * Math.min(1, dt * 4);

    if (shake > 0.2) {
      shake *= Math.pow(0.001, dt); // fast decay
      shakeX = (Math.random() - 0.5) * shake;
      shakeY = (Math.random() - 0.5) * shake;
    } else { shake = 0; shakeX = 0; shakeY = 0; }
  }

  // ---- main frame -------------------------------------------------------
  function frame(ship, dt, opts) {
    time += dt;
    opts = opts || {};
    updateCamera(ship, dt);

    const alt = ship.y - day.terrain.launchY;
    const altGround = ship.y - day.terrain.heightAt(ship.x) - BODY.halfH;

    // leg animation: out when low and slow-ish or resting
    const wantLegs = ship.resting || (altGround < 130 && ship.vy < 8);
    legK = clamp(legK + (wantLegs ? dt * 2.2 : -dt * 2.2), 0, 1);

    stepParticles(dt);
    engineParticles(ship, altGround, dt);
    ambientWind(dt, ship);

    drawSky(alt);
    drawParallax();
    drawTerrain();
    drawPads(ship);
    if (opts.ghostTrail) { drawTrail(opts.ghostTrail, "rgba(255,255,255,0.16)", true); }
    if (opts.trail) { drawTrail(opts.trail, "rgba(250,104,98,0.28)", false); }
    drawBeacons(ship);
    drawParticles();
    if (opts.ghostPos) { drawShip(ship, opts.ghostPos, 0.28); }
    if (ship.outcome !== "crash") { drawShip(ship, null, 1); }
    drawVelocityGuide(ship, altGround);
    drawOffscreenMarkers(ship);

    // crash flash + vignette
    if (flash > 0) {
      ctx.fillStyle = "rgba(255,235,220," + (flash * 0.8).toFixed(3) + ")";
      ctx.fillRect(0, 0, W, H);
      flash = Math.max(0, flash - dt * 2.2);
    }
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.75);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.28)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }

  function reset() {
    particles.length = 0; texts.length = 0; rings.length = 0;
    shake = 0; flash = 0; legK = 0;
    cam.x = 0; cam.y = day.terrain.launchY + 40; cam.scale = 5;
  }

  return { resize, frame, onEvent, reset, cam };
}
