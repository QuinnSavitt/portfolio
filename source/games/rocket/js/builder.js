/* Daily Rocket — the hangar.
 *
 * A single stack, drawn big on a blueprint, with magnetic drop targets:
 * pick a part from the shed tray (tap it, or drag it) and every place it
 * can legally go lights up as a fat target. Tap a part on the rocket to
 * select it: tanks get a fill slider, anything but the payload can go back
 * in the shed. Everything the physics will care about is shown live — Δv
 * per stage against what the mission needs, thrust-to-weight, centre of
 * mass against centre of pressure, and plain-English warnings.
 */

import {
  PARTS, PART_ORDER, assemble, stageStats, massProps, aeroTerms, centreOfPressure,
  partCounts, hardwareCost, cloneBuild, isEngine
} from "./parts.js";
import { airAt } from "./world.js";
import { drawVessel, drawIcon, INK } from "./partsdraw.js";
import { requiredDv, violations } from "./designer.js";

const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const money = (n) => "$" + fmt(n);

export function createHangar(els, day, hooks) {
  const canvas = els.canvas;
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1;
  let build = cloneBuild(day.starter);
  const past = [], future = [];
  let picked = null;      // part id from the tray
  let sel = null;         // { i, radial }
  let hover = null;       // highlighted target while dragging/aiming
  let layout = null;
  let drag = null;        // { id, x, y, moved }
  const needDv = requiredDv(day);
  const pLaunch = airAt(day.world, day.launch.y).p;
  let pulse = 0, raf = 0;

  // ------------------------------------------------------------ edits
  function commit(next) {
    past.push(JSON.stringify(build));
    if (past.length > 80) { past.shift(); }
    future.length = 0;
    build = next;
    changed();
  }
  function changed() {
    layout = null;
    paintTray();
    paintStats();
    paintPopover();
    draw();
    if (hooks.onChange) { hooks.onChange(cloneBuild(build)); }
  }
  function undo() {
    if (!past.length) { return; }
    future.push(JSON.stringify(build));
    build = JSON.parse(past.pop());
    sel = null; changed();
  }
  function redo() {
    if (!future.length) { return; }
    past.push(JSON.stringify(build));
    build = JSON.parse(future.pop());
    sel = null; changed();
  }

  const used = () => partCounts(build);
  const left = (id) => (day.inventory[id] || 0) - (used()[id] || 0);

  // ------------------------------------------------------------ rules
  /* Where can `id` go? Stack slots are insertion indices 0..n; radial slots
   * are stack indices that have no pair yet. */
  function targetsFor(id) {
    const d = PARTS[id];
    const st = build.stack;
    const n = st.length;
    const out = [];
    const payIdx = st.findIndex((e) => PARTS[e.p].kind === "payload");
    if (d.mount === "radial") {
      for (let j = 0; j < n; j++) {
        const k = PARTS[st[j].p].kind;
        if (k === "nose" || st[j].r) { continue; }
        out.push({ type: "radial", i: j });
      }
      return out;
    }
    if (d.kind === "nose") {
      if (st[0] && PARTS[st[0].p].kind === "nose") { return out; }
      out.push({ type: "stack", i: 0 });
      return out;
    }
    for (let i = payIdx + 1; i <= n; i++) {
      if (isEngine(d)) {
        // an engine has to sit at the bottom of its stage
        const below = st[i];
        if (below && PARTS[below.p].kind !== "decoupler") { continue; }
      } else {
        // nothing but a decoupler may go directly under an engine
        const above = st[i - 1];
        if (above && isEngine(PARTS[above.p]) && d.kind !== "decoupler") { continue; }
        if (d.kind === "decoupler") {
          if ((st[i] && PARTS[st[i].p].kind === "decoupler") || (above && PARTS[above.p].kind === "decoupler")) { continue; }
        }
      }
      out.push({ type: "stack", i });
    }
    return out;
  }

  function place(id, t) {
    if (left(id) <= 0) { return; }
    const next = cloneBuild(build);
    if (t.type === "radial") { next.stack[t.i].r = id; sel = { i: t.i, radial: true }; }
    else { next.stack.splice(t.i, 0, { p: id, fill: 1, r: null }); sel = { i: t.i, radial: false }; }
    if (left(id) <= 1) { picked = null; }
    commit(next);
    if (hooks.sound) { hooks.sound("clunk"); }
  }

  function removeSel() {
    if (!sel) { return; }
    const next = cloneBuild(build);
    const e = next.stack[sel.i];
    if (!e) { return; }
    if (sel.radial) { e.r = null; }
    else {
      if (PARTS[e.p].kind === "payload") { return; }
      next.stack.splice(sel.i, 1);
    }
    sel = null;
    commit(next);
    if (hooks.sound) { hooks.sound("unclunk"); }
  }

  // ------------------------------------------------------------ analysis
  function analyse() {
    const S = stageStats(build, day.world.g, pLaunch);
    const A = S.assembly;
    const mp = massProps(A.parts);
    const air = day.world.rho0 > 0.05;
    const cp = air ? centreOfPressure(aeroTerms(A.parts, false)) : null;
    const dv = S.stages.reduce((a, s) => a + s.dv, 0);
    const hw = hardwareCost(build);
    const warns = [], blocks = [];
    const bad = new Set();
    const bottom = S.stages[0];
    if (!bottom || bottom.engines === 0) { blocks.push("Stage 1 has no engine that can fire."); }
    for (const p of A.parts) {
      if (p.blocked) { warns.push(p.def.name + " is buried mid-stage: it can't fire. Engines go at the bottom of a stage."); bad.add(p); }
    }
    const lowest = Math.min(...A.parts.filter((p) => !p.radial).map((p) => p.s0));
    const topSeg = A.segCount - 1;
    const legs = A.parts.filter((p) => p.kind === "legs");
    const landerLegs = legs.filter((p) => p.seg === topSeg);
    for (const p of legs) {
      const segBottom = Math.min(...A.parts.filter((q) => !q.radial && q.seg === p.seg).map((q) => q.s0));
      if (p.footS > segBottom - 0.05) { warns.push("Those legs don't reach below the engine. Mount them on the engine."); bad.add(p); }
    }
    if (!landerLegs.length) {
      warns.push(day.banned.legs ? "No legs today: touch down under 2 m/s, dead level." : "No legs on the landing stage: touchdown must be under 2 m/s.");
    }
    if (bottom && bottom.engines) {
      if (bottom.twr < 1) { warns.push("Thrust-to-weight " + bottom.twr.toFixed(2) + ": it will not leave the pad."); }
      else if (bottom.twr < 1.2) { warns.push("Thrust-to-weight " + bottom.twr.toFixed(2) + ": a slow, expensive climb."); }
    }
    const top = S.stages[S.stages.length - 1];
    if (S.stages.length > 1 && top.engines === 0) { blocks.push("The top stage has no engine: nothing to land with."); }
    for (let k = 0; k < S.stages.length - 1; k++) {
      if (S.stages[k].engines === 0) { warns.push("Stage " + (k + 1) + " has no engine: it's dead weight until you drop it."); }
    }
    if (day.world.rho0 >= 0.5 && cp != null && cp > mp.s - 0.1) {
      warns.push("Centre of pressure is above the centre of mass: it will want to flip in the air. Fins low fix that.");
    }
    if (dv < needDv * 0.9) { warns.push("Δv looks short for this job (about " + fmt(needDv) + " m/s is a sensible flight)."); }
    for (const v of violations(day, build)) { blocks.push(v + "."); }
    // any part the shed can't cover (a stale build from yesterday's rules)
    const n = used();
    for (const k in n) { if ((day.inventory[k] || 0) < n[k]) { blocks.push("The shed only has " + (day.inventory[k] || 0) + " × " + PARTS[k].name + "."); } }
    return { S, A, mp, cp, dv, hw, warns, blocks, bad, height: A.height };
  }

  // ------------------------------------------------------------ DOM
  function paintTray() {
    const inv = day.inventory;
    const ids = PART_ORDER.filter((id) => inv[id]);
    els.tray.innerHTML = "";
    for (const id of ids) {
      const d = PARTS[id];
      const n = left(id);
      const b = document.createElement("button");
      b.className = "part" + (picked === id ? " on" : "") + (n <= 0 ? " out" : "");
      b.setAttribute("data-id", id);
      b.innerHTML = '<canvas width="96" height="96"></canvas>' +
        '<span class="pn">' + d.name + "</span>" +
        '<span class="pc">' + (d.mount === "radial" ? "pair · " : "") + money(d.cost * (d.mount === "radial" ? 2 : 1)) + "</span>" +
        '<span class="pq">×' + n + "</span>";
      const c = b.querySelector("canvas");
      const cx = c.getContext("2d");
      drawIcon(cx, d, 96);
      b.addEventListener("pointerdown", (e) => startDrag(e, id));
      els.tray.appendChild(b);
    }
  }

  function paintStats() {
    const a = analyse();
    const S = a.S;
    let html = '<div class="hs-row">' +
      cell("Δv", fmt(a.dv) + " m/s", a.dv < needDv * 0.9 ? "warn" : "", "~" + fmt(needDv) + " needed") +
      cell("TWR", S.stages[0] ? S.stages[0].twr.toFixed(2) : "—", S.stages[0] && S.stages[0].twr < 1.2 ? "bad" : "") +
      cell("Mass", fmt(a.mp.m) + " kg", day.limits.mass && a.mp.m > day.limits.mass ? "bad" : "",
        day.limits.mass ? "limit " + fmt(day.limits.mass) : "") +
      cell("Hardware", money(a.hw), day.limits.budget && a.hw > day.limits.budget ? "bad" : "",
        day.limits.budget ? "budget " + money(day.limits.budget) : "") +
      (day.limits.height ? cell("Height", a.height.toFixed(1) + " m", a.height > day.limits.height ? "bad" : "", "hangar " + day.limits.height.toFixed(1)) : "") +
      "</div>";
    if (S.stages.length > 1) {
      html += '<div class="hs-stages">' + S.stages.map((s, k) =>
        '<span><b>S' + (k + 1) + "</b> " + fmt(s.dv) + " m/s · TWR " + s.twr.toFixed(1) + "</span>").join("") + "</div>";
    }
    const list = a.blocks.map((t) => '<li class="block">' + t + "</li>").concat(a.warns.map((t) => "<li>" + t + "</li>"));
    html += list.length ? '<ul class="hs-warn">' + list.join("") + "</ul>" : '<div class="hs-ok">Looks flyable.</div>';
    els.stats.innerHTML = html;
    els.launch.disabled = a.blocks.length > 0;
    els.launchCost.textContent = money(a.hw);
    els.undo.disabled = !past.length;
    els.redo.disabled = !future.length;
    return a;
  }

  function cell(k, v, cls, sub) {
    return '<div class="hs"><span class="k">' + k + '</span><b class="v ' + (cls || "") + '">' + v + "</b>" +
      (sub ? '<span class="s">' + sub + "</span>" : "") + "</div>";
  }

  function paintPopover() {
    const pop = els.pop;
    if (picked) {
      // a slim pill: the slots it can go in must stay visible
      const d = PARTS[picked];
      pop.innerHTML = '<div class="pp-t">' + d.name + ' <span class="pp-hint">tap a glowing slot</span></div>' +
        '<div class="pp-s">' + partFacts(d) + "</div>";
      pop.classList.add("on", "slim");
      return;
    }
    pop.classList.remove("slim");
    if (!sel || !build.stack[sel.i]) { pop.classList.remove("on"); pop.innerHTML = ""; return; }
    const e = build.stack[sel.i];
    const id = sel.radial ? e.r : e.p;
    if (!id) { pop.classList.remove("on"); return; }
    const d = PARTS[id];
    let html = '<div class="pp-t">' + d.name + (d.mount === "radial" ? " (pair)" : "") + "</div>" +
      '<div class="pp-b">' + d.blurb + "</div><div class=\"pp-s\">" + partFacts(d) + "</div>";
    if (!sel.radial && d.kind === "tank") {
      const f = Math.round((e.fill == null ? 1 : e.fill) * 100);
      html += '<div class="pp-fill"><span>Fill</span><input type="range" min="10" max="100" step="5" value="' + f + '"><b>' + f + "%</b></div>";
    }
    if (d.kind !== "payload") { html += '<button class="btn small" data-act="remove">Back to the shed</button>'; }
    else { html += '<div class="pp-note">The customer\'s payload. It stays on top.</div>'; }
    pop.innerHTML = html;
    pop.classList.add("on");
    const rm = pop.querySelector('[data-act="remove"]');
    if (rm) { rm.addEventListener("click", removeSel); }
    const rg = pop.querySelector("input[type=range]");
    if (rg) {
      rg.addEventListener("input", () => {
        pop.querySelector(".pp-fill b").textContent = rg.value + "%";
        const next = cloneBuild(build);
        next.stack[sel.i].fill = parseInt(rg.value, 10) / 100;
        build = next; layout = null; paintStats(); draw();
      });
      rg.addEventListener("change", () => {
        past.push(JSON.stringify(build)); future.length = 0;
        if (hooks.onChange) { hooks.onChange(cloneBuild(build)); }
      });
    }
  }

  function partFacts(d) {
    const f = [];
    const pair = d.mount === "radial" ? 2 : 1;
    f.push(fmt(d.mass * pair) + " kg");
    if (d.cost) { f.push(money(d.cost * pair)); }
    if (d.prop) { f.push(fmt(d.prop * pair) + " kg " + (d.kind === "srb" ? "solid" : "propellant")); }
    if (d.thrust) { f.push(Math.round(d.thrust * pair / 1000) + " kN · Isp " + d.ispSL + "/" + d.ispVac); }
    if (d.minThr) { f.push("throttles to " + Math.round(d.minThr * 100) + "%"); }
    if (d.wheel && d.kind !== "payload") { f.push(Math.round(d.wheel / 1000) + " kN·m wheel"); }
    if (d.cda) { f.push(fmt(d.cda * pair) + " m² canopy"); }
    return f.join(" · ");
  }

  // ------------------------------------------------------------ canvas
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    layout = null;
    draw();
  }

  function computeLayout() {
    const A = assemble(build);
    let span = 1.5;
    for (const p of A.parts) {
      span = Math.max(span, Math.abs(p.c) + p.w / 2);
      if (p.kind === "legs") { span = Math.max(span, Math.abs(p.footC) + 0.4); }
    }
    let lowS = 0;
    for (const p of A.parts) { if (p.kind === "legs") { lowS = Math.min(lowS, p.footS); } }
    const tallest = A.height - lowS + 1.4;
    const padTop = W < 560 ? 120 : 34, padBot = 64;
    const k = Math.max(6, Math.min(70, (H - padTop - padBot) / tallest, (W * 0.62) / (span * 2 + 5)));
    const ox = W * (W > 700 ? 0.42 : 0.4);
    const oy = H - padBot + lowS * k;
    return { A, k, ox, oy, span };
  }

  const toScreen = (L, c, s) => ({ x: L.ox + c * L.k, y: L.oy - s * L.k });

  function targetPoints(L) {
    if (!picked) { return []; }
    const pts = [];
    const stackParts = L.A.parts.filter((p) => !p.radial).sort((a, b) => b.s1 - a.s1);
    for (const t of targetsFor(picked)) {
      if (t.type === "stack") {
        const s = t.i < stackParts.length ? stackParts[t.i].s1 : 0;
        const sp = toScreen(L, 0, s);
        pts.push({ t, x: sp.x, y: sp.y, r: 17 });
      } else {
        const p = stackParts[t.i];
        const sm = (p.s0 + p.s1) / 2;
        for (const side of [-1, 1]) {
          const sp = toScreen(L, side * (p.w / 2 + 0.55), sm);
          pts.push({ t, x: sp.x, y: sp.y, r: 15 });
        }
      }
    }
    return pts;
  }

  function draw() {
    if (!W) { return; }
    if (!layout) { layout = computeLayout(); }
    const L = layout;
    const a = lastAnalysis();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // blueprint
    ctx.fillStyle = "#0e1a2b";
    ctx.fillRect(0, 0, W, H);
    const grid = L.k >= 14 ? 1 : L.k >= 7 ? 2 : 5;
    ctx.lineWidth = 1;
    for (let m = -60; m <= 120; m += grid) {
      const y = L.oy - m * L.k;
      if (y < 0 || y > H) { continue; }
      ctx.strokeStyle = m % (grid * 5) === 0 ? "rgba(140,180,230,0.16)" : "rgba(140,180,230,0.07)";
      ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(W, Math.round(y) + 0.5); ctx.stroke();
    }
    for (let m = -80; m <= 80; m += grid) {
      const x = L.ox + m * L.k;
      if (x < 0 || x > W) { continue; }
      ctx.strokeStyle = m % (grid * 5) === 0 ? "rgba(140,180,230,0.16)" : "rgba(140,180,230,0.07)";
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, H); ctx.stroke();
    }
    // pad line
    ctx.strokeStyle = "rgba(200,220,255,0.35)";
    ctx.beginPath(); ctx.moveTo(0, L.oy + 0.5 - Math.min(0, 0)); ctx.lineTo(W, L.oy + 0.5); ctx.stroke();
    // hangar ceiling on a low-hangar day
    if (day.limits.height) {
      const lowS = Math.min(0, ...L.A.parts.filter((p) => p.kind === "legs").map((p) => p.footS));
      const y = L.oy - (day.limits.height + lowS * 0) * L.k;
      ctx.strokeStyle = a.height > day.limits.height ? "#fa6862" : "rgba(240,194,78,0.8)";
      ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle; ctx.font = "600 11px 'Open Sans', sans-serif";
      ctx.fillText("HANGAR CEILING " + day.limits.height.toFixed(1) + " m", 10, y - 6);
    }

    // rocket
    ctx.save();
    ctx.translate(L.ox, L.oy);
    ctx.scale(L.k, L.k);
    const selPart = selectedPart(L);
    drawVessel(ctx, L.A.parts, 1 / L.k, { legsOut: true, showFill: true, selected: selPart, warn: a.bad });
    ctx.restore();

    // stage brackets
    const segs = L.A.segCount;
    if (segs > 1 || a.S.stages.length) {
      const xr = L.ox + (L.span + 0.9) * L.k + 8;
      ctx.font = "700 11px 'Open Sans', sans-serif";
      for (let k = 0; k < segs; k++) {
        const ps = L.A.parts.filter((p) => p.seg === k && !p.radial);
        if (!ps.length) { continue; }
        const s0 = Math.min(...ps.map((p) => p.s0)), s1 = Math.max(...ps.map((p) => p.s1));
        const y0 = L.oy - s0 * L.k - 2, y1 = L.oy - s1 * L.k + 2;
        ctx.strokeStyle = "rgba(200,220,255,0.5)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(xr, y1); ctx.lineTo(xr + 6, y1); ctx.lineTo(xr + 6, y0); ctx.lineTo(xr, y0); ctx.stroke();
        const st = a.S.stages[k];
        const cy = (y0 + y1) / 2;
        ctx.fillStyle = "#dfe8f5";
        ctx.fillText("STAGE " + (k + 1), xr + 12, cy - 4);
        ctx.fillStyle = "rgba(200,220,255,0.7)";
        ctx.font = "600 10px 'Open Sans', sans-serif";
        if (st) { ctx.fillText(fmt(st.dv) + " m/s · TWR " + st.twr.toFixed(1), xr + 12, cy + 10); }
        ctx.font = "700 11px 'Open Sans', sans-serif";
      }
    }

    // CoM and CoP markers
    const com = toScreen(L, 0, a.mp.s);
    const mx = L.ox - (L.span + 0.9) * L.k - 14;
    marker(mx, com.y, "#f0c24e", "CoM");
    if (a.cp != null) {
      const cp = toScreen(L, 0, Math.max(0, Math.min(L.A.height + 0.5, a.cp)));
      marker(mx - 34, cp.y, "#62b3ff", "CoP");
    }

    // targets
    const pts = targetPoints(L);
    pulse += 0.06;
    for (const t of pts) {
      const on = hover && hover.t === t.t;
      const r = t.r + (on ? 5 : Math.sin(pulse) * 2);
      ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
      ctx.fillStyle = on ? "rgba(250,104,98,0.55)" : "rgba(250,104,98,0.22)";
      ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "#fa6862"; ctx.stroke();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(t.x - 6, t.y); ctx.lineTo(t.x + 6, t.y); ctx.moveTo(t.x, t.y - 6); ctx.lineTo(t.x, t.y + 6); ctx.stroke();
    }
    if (drag && drag.moved) {
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "rgba(250,104,98,0.9)";
      ctx.beginPath(); ctx.arc(drag.x, drag.y, 7, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (pts.length && !raf) { raf = window.requestAnimationFrame(() => { raf = 0; draw(); }); }
  }

  function marker(x, y, col, label) {
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI / 2); ctx.lineTo(x, y); ctx.closePath();
    ctx.fillStyle = "#0e1a2b"; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 7, Math.PI, Math.PI * 1.5); ctx.lineTo(x, y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = col; ctx.font = "700 10px 'Open Sans', sans-serif";
    ctx.textAlign = "right"; ctx.fillText(label, x - 11, y + 4); ctx.textAlign = "left";
  }

  let cachedA = null, cachedKey = "";
  function lastAnalysis() {
    const key = JSON.stringify(build);
    if (key !== cachedKey) { cachedA = analyse(); cachedKey = key; }
    return cachedA;
  }

  function selectedPart(L) {
    if (!sel) { return null; }
    const e = build.stack[sel.i];
    if (!e) { return null; }
    return L.A.parts.find((p) => p.stackIndex === sel.i && p.radial === !!sel.radial) || null;
  }

  // ------------------------------------------------------------ input
  function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, inside: e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom };
  }

  function nearestTarget(pt, reach) {
    if (!layout) { layout = computeLayout(); }
    let best = null, bd = reach;
    for (const t of targetPoints(layout)) {
      const d = Math.hypot(t.x - pt.x, t.y - pt.y);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  function hitPart(pt) {
    if (!layout) { layout = computeLayout(); }
    const L = layout;
    const c = (pt.x - L.ox) / L.k, s = (L.oy - pt.y) / L.k;
    // radials first (they sit outside the stack), then the stack
    let found = null;
    for (const p of L.A.parts) {
      const pad = 0.25;
      let c0 = p.c - p.w / 2 - pad, c1 = p.c + p.w / 2 + pad, s0 = p.s0 - pad, s1 = p.s1 + pad;
      if (p.kind === "legs") { c0 = Math.min(c0, p.footC - 0.4); c1 = Math.max(c1, p.footC + 0.4); s0 = Math.min(s0, p.footS - 0.2); }
      if (c >= c0 && c <= c1 && s >= s0 && s <= s1) {
        if (!found || (p.radial && !found.radial)) { found = p; }
      }
    }
    return found;
  }

  /* A card press becomes a pick on release (a tap), or a drag once it
   * moves up toward the rocket. Sideways swipes belong to the browser: the
   * tray scrolls and we get a pointercancel, which does nothing. */
  function startDrag(e, id) {
    if (hooks.unlock) { hooks.unlock(); }
    if (left(id) <= 0) { return; }
    drag = { id, sx: e.clientX, sy: e.clientY, moved: false, x: 0, y: 0 };
    const move = (ev) => {
      if (!drag) { return; }
      const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
      if (!drag.moved && (Math.abs(dy) > 12 || (ev.pointerType === "mouse" && Math.hypot(dx, dy) > 10))) {
        drag.moved = true;
        picked = id; sel = null;
        paintTray(); paintPopover();
      }
      if (!drag.moved) { return; }
      const pt = localPoint(ev);
      drag.x = pt.x; drag.y = pt.y;
      hover = pt.inside ? nearestTarget(pt, 90) : null;
      draw();
    };
    const done = (ev, cancelled) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      const d = drag; drag = null;
      hover = null;
      if (!d || cancelled) { draw(); return; }
      if (d.moved) {
        const pt = localPoint(ev);
        const t = pt.inside ? nearestTarget(pt, 90) : null;
        if (t) { place(id, t.t); return; }
      } else {
        // a tap toggles the pick
        picked = picked === id ? null : id;
        sel = null;
      }
      paintTray(); paintPopover(); draw();
    };
    const up = (ev) => done(ev, false);
    const cancel = (ev) => done(ev, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (hooks.unlock) { hooks.unlock(); }
    const pt = localPoint(e);
    if (picked) {
      const t = nearestTarget(pt, 70);
      if (t) { place(picked, t.t); return; }
    }
    const p = hitPart(pt);
    picked = null;
    sel = p ? { i: p.stackIndex, radial: p.radial } : null;
    paintTray(); paintPopover(); draw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!picked || drag) { return; }
    const t = nearestTarget(localPoint(e), 70);
    if ((t && t.t) !== (hover && hover.t)) { hover = t; draw(); }
  });

  els.undo.addEventListener("click", undo);
  els.redo.addEventListener("click", redo);
  els.starter.addEventListener("click", () => { sel = null; picked = null; commit(cloneBuild(day.starter)); });
  els.clear.addEventListener("click", () => {
    sel = null; picked = null;
    commit({ stack: [{ p: day.payload.id, fill: 1, r: null }] });
  });

  function onKey(e) {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); if (e.shiftKey) { redo(); } else { undo(); } }
    else if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); }
    else if (k === "delete" || k === "backspace") { removeSel(); }
    else if (k === "escape") { picked = null; sel = null; paintTray(); paintPopover(); draw(); }
  }

  return {
    get build() { return cloneBuild(build); },
    setBuild(b) { build = cloneBuild(b); past.length = 0; future.length = 0; sel = null; picked = null; changed(); },
    resize, draw, onKey,
    analysis: () => lastAnalysis(),
    refresh() { changed(); }
  };
}
