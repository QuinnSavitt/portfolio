/* Daily Rocket — the app shell: screens, input, the fixed-step loop, the
 * records. Physics lives in physics.js (deterministic), the day in gen.js;
 * this file owns the DOM and couples the sim to the renderer and audio.
 *
 * URL hooks: ?day=N (archive / practice), ?bot=1 (autopilot demo, nothing
 * recorded), ?view=hangar (open the hangar), ?ff=SECONDS (bot: fast-forward
 * before drawing, for screenshots).
 */

import { dayIndex, msUntilReset } from "./daily.js";
import { generateDay, board as dayBoard, PAR_SKILL } from "./gen.js";
import {
  createSim, step, settleDebris, DT, comWorld, clearance, thrustNow, currentSeg,
  stagePropellant, simTarget, simLeg, targetDistance
} from "./physics.js";
import { PARTS, cloneBuild, partCounts, hardwareCost, massProps, LEG_V } from "./parts.js";
import { windAt } from "./world.js";
import { createBot, botInput } from "./bot.js";
import * as SCORE from "./score.js";
import { createRenderer } from "./render.js";
import { createAudio } from "./audio.js";
import { createHangar } from "./builder.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const money = SCORE.money;
const dist = (m) => (Math.abs(m) >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m");

// ---------------------------------------------------------------- setup

const params = new URLSearchParams(window.location.search);
const botMode = params.get("bot") === "1";
const todayIdx = dayIndex();
let dayIdx = todayIdx;
if (params.get("day")) {
  const n = parseInt(params.get("day"), 10);
  if (!Number.isNaN(n) && n >= 0 && n <= todayIdx) { dayIdx = n; }
}
const practice = dayIdx !== todayIdx;

const day = generateDay(dayIdx);
const audio = createAudio();
let renderer = null, hangar = null;

let build = pickInitialBuild();
let sim = null, bot = null;
let raf = 0, lastNow = 0, acc = 0;
let finishAt = 0, lastResult = null;
let trail = [], ghostRec = [], ghost = null, lastSample = -1;
let boardRows = null;

const input = { rot: 0, throttle: 1, stage: false, chute: false, retro: false };
const held = { l: false, r: false };
const keys = {};

function pickInitialBuild() {
  const rec = SCORE.loadDay(day);
  const b = rec.build;
  if (b && b.stack && b.stack.length && fitsShed(b)) { return cloneBuild(b); }
  return cloneBuild(day.starter);
}

function fitsShed(b) {
  if (!b.stack.every((e) => PARTS[e.p] && (!e.r || PARTS[e.r]))) { return false; }
  if (!b.stack.some((e) => e.p === day.payload.id)) { return false; }
  const n = partCounts(b);
  for (const k in n) { if ((day.inventory[k] || 0) < n[k]) { return false; } }
  return true;
}

// --------------------------------------------------------------- screens

function show(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("on"));
  $("screen-" + name).classList.add("on");
  if (name !== "fly") { stopLoop(); audio.silence(); }
  if (name === "hangar" && hangar) { hangar.resize(); }
}

let toastT = 0;
function toast(msg, ms) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  window.clearTimeout(toastT);
  toastT = window.setTimeout(() => t.classList.remove("on"), ms || 2200);
}

// ---------------------------------------------------------------- brief

const TWIST_ICON = {
  fuel: "⛽", rush: "⏱", precise: "🎯", reuse: "♻", expend: "🔥", budget: "💸", ceiling: "⬇",
  padmass: "⚖", nolegs: "🦿", nofins: "✂", gale: "💨", freight: "📦", supplier: "🏭", scarce: "🪣"
};

function paintBrief() {
  $("briefNumber").textContent = "#" + day.number;
  $("briefWorld").textContent = day.world.name + " · " + day.world.atmo + " air";
  $("missionName").textContent = day.mission.name;
  $("missionBrief").textContent = day.mission.brief;
  $("practiceNote").style.display = practice ? "block" : "none";
  if (practice) {
    $("practiceNote").textContent = "Archive contract #" + day.number + ". Records are kept for that day only; no streak.";
  }
  $("btnToday").style.display = practice ? "inline" : "none";

  const tw = day.twists.length ? day.twists : [{ id: "none", name: "Standard contract", text: "No twist today. The usual prices, the usual rules." }];
  $("twistList").innerHTML = tw.map((t) =>
    '<div class="twist' + (t.id === "none" ? " plain" : "") + '"><span class="ti">' + (TWIST_ICON[t.id] || "📋") +
    '</span><div><div class="tn">' + (t.id === "none" ? "" : "Twist · ") + t.name + '</div><div class="tt">' + t.text + "</div></div></div>"
  ).join("");

  const w = day.world;
  const windTxt = w.rho0 <= 0.05 ? "None" : Math.abs(w.wind).toFixed(0) + " m/s " + (w.windDir < 0 ? "←" : "→") +
    (w.gust >= 3 ? " gusty" : "");
  const facts = [
    ["Gravity", w.g.toFixed(2) + " m/s²"],
    ["Air", w.atmo + (w.rho0 > 0.05 ? " · " + w.rho0.toFixed(2) : "")],
    ["Wind", windTxt],
    ["Payload", fmt(day.payload.mass) + " kg"],
    ["Contract fee", money(day.fee)],
    ["Deadline", day.deadline + " s"],
    ["Pad", day.barge ? Math.round(day.barge.half * 2) + " m deck" : Math.round(day.target.half * 2) + " m wide"],
    ["Par profit", money(day.par.total)]
  ];
  $("factGrid").innerHTML = facts.map((f) =>
    '<div class="fact"><div class="k">' + f[0] + '</div><div class="v">' + f[1] + "</div></div>").join("");

  $("quickSub").textContent = SCORE.loadDay(day).build ? "last build" : "starter";
  paintRecords("rec");
  paintBoard($("boardList"));
  drawMap();
  tickClock();
}

function paintRecords(prefix) {
  const rec = SCORE.loadDay(day);
  const f = rec.first;
  const fEl = $(prefix + "First"), bEl = $(prefix + "Best");
  fEl.textContent = f ? (f.ok ? money(f.total) : "\u{1F4A5} " + money(f.total)) : "—";
  fEl.className = "v" + (f && (!f.ok || f.total < 0) ? " neg" : "");
  bEl.textContent = rec.best ? money(rec.best.total) : "—";
  $(prefix + "Attempts").textContent = rec.attempts || 0;
  if (prefix === "rec") {
    const s = SCORE.lifetimeStats();
    $("streakChip").textContent = s.streak > 1 ? s.streak + " day streak" : "";
  }
}

function paintBoard(el) {
  const rec = SCORE.loadDay(day);
  if (!boardRows) {
    el.innerHTML = '<div class="brow pending"><span class="nm">The rival companies are flying today\'s contract…</span></div>';
    return;
  }
  const rows = boardRows.map((r) => ({ ...r }));
  if (rec.best) { rows.push({ id: "you", name: "You (best)", total: rec.best.total, ok: true }); }
  rows.sort((a, b) => (b.ok - a.ok) || (b.total - a.total));
  el.innerHTML = rows.map((r, i) =>
    '<div class="brow' + (r.id === "you" ? " you" : "") + '"><span class="rk">' + (r.ok ? i + 1 : "–") + '</span>' +
    '<span class="nm">' + r.name + (r.blurb ? "<small>" + r.blurb + (r.ok ? "" : " · crashed") + "</small>" : "") +
    '</span><span class="vl' + (!r.ok || r.total < 0 ? " neg" : "") + '">' + (r.ok ? money(r.total) : "\u{1F4A5} " + money(r.total)) + "</span></div>"
  ).join("");
}

function youRank() {
  if (!boardRows) { return null; }
  const rec = SCORE.loadDay(day);
  if (!rec.best) { return null; }
  const all = boardRows.filter((r) => r.ok).map((r) => r.total);
  const rank = all.filter((t) => t > rec.best.total).length + 1;
  return { rank, of: all.length + 1 };
}

/* the rival flights take a few hundred ms; do them one at a time off the
 * first paint so the page never feels stuck */
function computeBoard() {
  if (boardRows || botMode) { return; }
  window.setTimeout(() => {
    boardRows = dayBoard(day);
    paintBoard($("boardList"));
    if ($("screen-result").classList.contains("on")) { paintBoard($("resBoard")); }
  }, 250);
}

function tickClock() {
  const ms = msUntilReset();
  const p = (n) => (n < 10 ? "0" : "") + n;
  $("resetClock").textContent = p(Math.floor(ms / 3600000)) + ":" + p(Math.floor((ms % 3600000) / 60000)) + ":" + p(Math.floor((ms % 60000) / 1000));
}
window.setInterval(tickClock, 1000);

/* a side-on sketch of the whole job */
function drawMap() {
  const c = $("mapCanvas");
  const r = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height;
  const pal = day.world.pal;
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, pal.skyTop); sky.addColorStop(1, pal.skyBot);
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  const xs = [day.launch.x, ...day.legs.map((l) => l.target.x)];
  if (day.gates) { xs.push(...day.gates.map((q) => q.x)); }
  let xa = Math.min(...xs) - 250, xb = Math.max(...xs) + 250;
  if (day.barge) { xb += day.barge.amp; }
  const tr = day.terrain;
  xa = Math.max(tr.x0, xa); xb = Math.min(tr.x1, xb);
  let ya = Infinity, yb = -Infinity;
  for (let x = xa; x <= xb; x += 10) { const h = tr.surfaceAt(x); ya = Math.min(ya, h); yb = Math.max(yb, h); }
  if (day.gates) { for (const q of day.gates) { yb = Math.max(yb, q.y + q.half); } }
  yb = Math.max(yb, ya + 60);
  const k = Math.min(W / (xb - xa), (H * 0.62) / (yb - ya + 60));
  const X = (x) => (x - xa) * (W / (xb - xa));
  const Y = (y) => H - 14 - (y - ya) * k;
  if (tr.seaLevel > -Infinity) { g.fillStyle = pal.sea || "#2f6f95"; g.fillRect(0, Y(tr.seaLevel), W, H); }
  g.fillStyle = pal.ground;
  g.beginPath(); g.moveTo(0, H);
  for (let x = xa; x <= xb; x += (xb - xa) / 240) { g.lineTo(X(x), Y(tr.heightAt(x))); }
  g.lineTo(W, H); g.closePath(); g.fill();
  g.strokeStyle = pal.groundLit; g.lineWidth = 1.5;
  g.beginPath();
  for (let x = xa; x <= xb; x += (xb - xa) / 240) { if (x === xa) { g.moveTo(X(x), Y(tr.heightAt(x))); } else { g.lineTo(X(x), Y(tr.heightAt(x))); } }
  g.stroke();
  g.font = "700 10px 'Open Sans', sans-serif";
  const label = (x, y, txt, col) => {
    const lx = Math.max(30, Math.min(W - 30, X(x)));
    g.textAlign = "center";
    g.lineWidth = 3; g.strokeStyle = "rgba(10,14,20,0.7)"; g.lineJoin = "round";
    g.strokeText(txt, lx, y);
    g.fillStyle = col; g.fillText(txt, lx, y);
  };
  // launch
  g.fillStyle = "#fff"; g.fillRect(X(day.launch.x) - 1.5, Y(day.launch.y) - 12, 3, 12);
  label(day.launch.x, Y(day.launch.y) - 16, "LAUNCH", "#fff");
  // targets
  day.legs.forEach((L, i) => {
    const t = L.target;
    if (i > 0 && t.x === day.launch.x) { label(t.x, Y(t.y) - 28, "HOME", "#62b3ff"); return; }
    const x = X(t.x), y = Y(t.y);
    g.fillStyle = "#f0c24e"; g.fillRect(x - Math.max(4, t.half * (W / (xb - xa))), y - 2, Math.max(8, 2 * t.half * (W / (xb - xa))), 3);
    g.fillStyle = "#7fc6a1";
    g.beginPath(); g.moveTo(x, y - 18); g.lineTo(x + 8, y - 14); g.lineTo(x, y - 10); g.fill();
    g.fillRect(x - 0.75, y - 18, 1.5, 16);
    label(t.x, y - 22, day.barge ? "BARGE" : day.legs.length > 1 ? "PICKUP" : "PAD · " + dist(t.x - day.launch.x), "#7fc6a1");
  });
  if (day.gates) {
    day.gates.forEach((q, i) => {
      g.strokeStyle = "#fa6862"; g.lineWidth = 2;
      g.beginPath(); g.ellipse(X(q.x), Y(q.y), 4, Math.max(4, q.half * k), 0, 0, Math.PI * 2); g.stroke();
      label(q.x, Y(q.y + q.half) - 4, String(i + 1), "#fa6862");
    });
  }
  if (day.ribbon) {
    g.strokeStyle = "#fa6862"; g.setLineDash([6, 5]); g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(0, 12); g.lineTo(W, 12); g.stroke(); g.setLineDash([]);
    g.fillStyle = "#fa6862"; g.textAlign = "left"; g.fillText("↑ " + day.ribbon.label.toUpperCase() + " (off the top of this map)", 8, 26);
  }
  g.textAlign = "left";
}

// ---------------------------------------------------------------- hangar

function openHangar() {
  audio.unlock();
  if (!hangar) {
    hangar = createHangar({
      canvas: $("hangarCanvas"), tray: $("hTray"), stats: $("hStats"), pop: $("hPop"),
      launch: $("hLaunch"), launchCost: $("hLaunchCost"), undo: $("hUndo"), redo: $("hRedo"),
      starter: $("hStarter"), clear: $("hClear")
    }, day, {
      onChange(b) { build = b; if (!botMode) { SCORE.saveBuild(day, b); } },
      sound(n) { audio.play(n); },
      unlock() { audio.unlock(); }
    });
    hangar.setBuild(build);
  }
  $("hNumber").textContent = "#" + day.number;
  $("hTitle").textContent = day.mission.name;
  show("hangar");
  hangar.resize();
}

// ---------------------------------------------------------------- flight

function launch() {
  audio.unlock();
  if (hangar) { build = hangar.build; }
  sim = createSim(day, build);
  bot = botMode ? createBot(PAR_SKILL) : null;
  input.rot = 0; input.throttle = 1; input.stage = false; input.chute = false; input.retro = false;
  held.l = held.r = false;
  trail = []; ghostRec = []; lastSample = -1;
  finishAt = 0;
  const g = SCORE.loadGhost(day);
  ghost = g ? { pts: g, trail: g.filter((_, i) => i % 3 === 0), pos: null } : null;
  if (!renderer) { renderer = createRenderer($("flyCanvas"), day); }
  show("fly");
  renderer.resize();
  renderer.reset();
  $("botChip").style.display = botMode ? "block" : "none";
  $("prelaunch").style.display = botMode ? "none" : "block";
  paintControls();
  const ff = parseFloat(params.get("ff") || "0");
  if (botMode && ff > 0) {
    // fast-forward (screenshots): run the sim ahead before the first frame
    while (!sim.done && sim.t < ff) { step(sim, botInput(sim, bot)); }
    sim.events.length = 0;
  }
  startLoop();
}

function startLoop() {
  lastNow = performance.now();
  acc = 0;
  if (!raf) { raf = window.requestAnimationFrame(frame); }
}
function stopLoop() { if (raf) { window.cancelAnimationFrame(raf); raf = 0; } }

function sampleInput() {
  if (botMode) { return botInput(sim, bot); }
  let rot = 0;
  if (held.l || keys.a || keys.arrowleft) { rot -= 1; }
  if (held.r || keys.d || keys.arrowright) { rot += 1; }
  input.rot = rot;
  return input;
}

function frame(now) {
  raf = window.requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;

  // keyboard throttle ramps
  if (!botMode) {
    if (keys.w || keys.arrowup) { setThrottle(input.throttle + dt * 0.9); }
    if (keys.s || keys.arrowdown) { setThrottle(input.throttle - dt * 0.9); }
  }

  if (sim && !sim.done) {
    acc += dt;
    let n = 0;
    while (acc >= DT && n < 24) {
      const inp = sampleInput();
      step(sim, inp);
      // edge-triggered buttons fire once
      if (!botMode) { input.stage = false; input.chute = false; }
      acc -= DT; n++;
      if (sim.t - lastSample >= 0.1) {
        lastSample = sim.t;
        const c = comWorld(sim.main);
        if (trail.length < 3000) { trail.push({ x: c.x, y: c.y }); }
        if (ghostRec.length < 3000) { ghostRec.push({ x: c.x, y: c.y, a: sim.main.ang }); }
      }
      if (sim.done) { break; }
    }
    if (n >= 24) { acc = 0; }
    drainEvents();
    if (sim.done && !finishAt) {
      finishAt = now + (sim.success ? 1300 : 1900);
      audio.silence();
    }
  }

  if (sim) {
    if (ghost && ghost.pts && sim.ignited) {
      const i = Math.min(ghost.pts.length - 1, Math.floor(sim.t / 0.1));
      ghost.pos = ghost.pts[i];
    }
    renderer.frame(sim, dt, { trail, ghost });
    paintHud();
    if (!sim.done) { feedAudio(); }
  }
  if (sim && sim.done && finishAt && now >= finishAt) {
    finishAt = 0;
    finishRun();
  }
}

function feedAudio() {
  const v = sim.main;
  let liquid = 0, solid = 0;
  for (const p of v.parts) {
    if (!p.burning) { continue; }
    if (p.kind === "srb") { solid = Math.max(solid, p.burning); } else if (p.kind === "engine" || p.kind === "pod") { liquid = Math.max(liquid, p.burning); }
  }
  const tn = thrustNow(sim, v);
  audio.setEngine(liquid, solid, tn.air.p);
  audio.setWind(Math.min(1, sim.lastQ / 9000));
}

let lastFuelWarn = -99;
function drainEvents() {
  while (sim.events.length) {
    const e = sim.events.shift();
    renderer.onEvent(e, sim);
    switch (e.type) {
      case "ignite":
        audio.play("ignite");
        $("prelaunch").style.display = "none";
        break;
      case "separate": case "boosters": audio.play("stage"); break;
      case "chuteOpen": audio.play("chute"); if (e.main) { toast("Chutes out"); } break;
      case "chuteTorn": audio.play("tear"); if (e.main) { toast("Chutes torn off: too fast. Slow down before you deploy (under ~9 kPa)."); } break;
      case "chuteCut": toast("Chutes cut away"); break;
      case "touchdown":
        audio.play("touchdown", e.speed > 3);
        if (!e.onTarget && !sim.done) { toast("Down safe, but that isn't the pad. Relight and hop over."); }
        break;
      case "explosion": audio.play("explosion", !!e.main); break;
      case "splash": audio.play("splash"); break;
      case "gate": audio.play("ring"); break;
      case "gateMiss": break;
      case "ribbon": audio.play("ribbon"); toast("Line reached. Now bring it home."); break;
      case "pickup": audio.play("pickup"); toast("Picked up " + e.text + " (+" + e.kg + " kg). Take them home."); break;
      case "recovered": toast("Stage recovered: half its price back"); break;
      case "flameout":
        if (e.main) {
          audio.play("flameout");
          const more = sim.nextEvent < sim.stageEvents.length;
          toast(more ? "Stage dry. Hit STAGE." : "Out of propellant.");
        }
        break;
      case "note": toast(e.text, 3200); break;
      case "finish":
        if (sim.success) { audio.play("win"); } else if (e.outcome !== "timeout") { audio.play("lose"); }
        break;
      default: break;
    }
  }
  // low-fuel warning on the landing stage
  if (sim.ignited && !sim.done && sim.nextEvent >= sim.stageEvents.length) {
    const seg = currentSeg(sim.main);
    const f = stagePropellant(sim.main, seg);
    if (f.max > 0 && f.prop / f.max < 0.12 && sim.t - lastFuelWarn > 8) {
      lastFuelWarn = sim.t;
      audio.play("warn");
    }
  }
}

// ------------------------------------------------------------------ HUD

let hudT = 0;
function paintHud() {
  const now = performance.now();
  if (now - hudT < 66) { return; }
  hudT = now;
  const v = sim.main;
  const alt = sim.main.alive ? Math.max(0, clearance(sim, v)) : 0;
  $("hudAlt").textContent = alt >= 1000 ? (alt / 1000).toFixed(2) + " km" : Math.round(alt) + " m";
  const tg = simTarget(sim);
  const rvx = v.vx - tg.vx;
  $("hudVy").textContent = (v.vy > 0 ? "+" : "") + v.vy.toFixed(1);
  $("hudVx").textContent = (rvx > 0 ? "+" : "") + rvx.toFixed(1);
  const danger = v.vy < -LEG_V && alt < 120;
  $("telVy").className = "tel" + (danger ? " alert" : v.vy < -LEG_V * 0.7 && alt < 200 ? " warn" : "");
  $("telVx").className = "tel" + (Math.abs(rvx) > 2.5 && alt < 60 ? " warn" : "");
  const seg = currentSeg(v);
  const f = stagePropellant(v, seg);
  const frac = f.max > 0 ? f.prop / f.max : 0;
  $("hudFuel").style.width = (frac * 100).toFixed(1) + "%";
  $("hudFuel").className = "fill" + (frac < 0.15 ? " low" : "");
  const stagesLeft = new Set(v.parts.filter((p) => !p.radial).map((p) => p.seg)).size;
  $("hudFuelK").textContent = stagesLeft > 1 ? "Stage " + (seg + 1) + " fuel" : "Fuel";
  const wind = day.world.rho0 > 0.05 ? windAt(day, sim.agl || 0, sim.t) : 0;
  $("hudWind").textContent = day.world.rho0 <= 0.05 ? "—" : Math.abs(wind).toFixed(0) + (wind < 0 ? " ←" : " →");
  $("hudTime").textContent = sim.t.toFixed(1);
  const price = 30 * (day.econ.fuel || 1);
  $("hudSpent").textContent = money(hardwareCost(sim.build) + sim.liquidBurned * price);
  $("objective").textContent = objectiveText();
  paintControls();
}

function objectiveText() {
  if (sim.done) { return sim.success ? "Delivered" : "Contract lost"; }
  const c = comWorld(sim.main);
  if (day.gates) {
    const left = sim.gates.findIndex((x) => !x);
    if (left >= 0) { return "Ring " + (left + 1) + " of " + day.gates.length + " · " + dist(Math.hypot(day.gates[left].x - c.x, day.gates[left].y - c.y)); }
  }
  if (day.ribbon && !sim.ribbon) {
    const up = day.ribbon.y - c.y;
    return "Climb to the " + day.ribbon.label + " · " + dist(Math.max(0, up)) + " to go";
  }
  const tg = simTarget(sim);
  const d = targetDistance(sim, c.x).d;
  const where = day.legs.length > 1 ? (sim.leg === 0 ? "Pickup at " + day.mission.outpost : "Home to the launch pad") : day.barge ? "Land on the barge" : "Land on the pad";
  return where + " · " + (Math.abs(d) < tg.half ? "overhead" : dist(Math.abs(d)) + (d > 0 ? " ←" : " →"));
}

function paintControls() {
  if (!sim) { return; }
  const ev = sim.stageEvents[sim.nextEvent];
  const st = $("btnStage");
  st.disabled = !ev;
  $("stageNext").textContent = ev ? ev.label : "—";
  st.classList.toggle("go", !sim.ignited);
  const v = sim.main;
  const ch = $("btnChute");
  const hasCh = v.chutes && v.chutes.length && v.chuteState !== "torn" && v.chuteState !== "cut";
  ch.style.display = hasCh ? "flex" : "none";
  ch.textContent = v.chuteState === "open" ? "Cut" : "Chute";
  $("btnRetro").classList.toggle("on", input.retro);
  // throttle widget (in a demo it shows what the autopilot is asking for)
  const t = botMode ? sim.thrCmd : input.throttle;
  $("thrFill").style.height = "calc(" + (t * 100).toFixed(1) + "% - 8px)";
  $("thrKnob").style.bottom = "calc(" + (t * 100).toFixed(1) + "% - 4px)";
  $("thrLbl").textContent = Math.round(t * 100) + "%";
  let minThr = 0;
  for (const p of v.parts) { if (p.lit && (p.kind === "engine" || p.kind === "pod")) { minThr = Math.max(minThr, p.def.minThr); } }
  $("thrMin").style.display = minThr > 0.05 ? "block" : "none";
  $("thrMin").style.bottom = (minThr * 100).toFixed(1) + "%";
}

function setThrottle(v) {
  input.throttle = Math.max(0, Math.min(1, v));
}

// --------------------------------------------------------------- results

const LINE_TIPS = {
  hardware: (d) => "Your rocket cost " + money(-d) + " more than the Flight Director's. A smaller tank, a cheaper engine or one less stage pays straight into profit.",
  fuel: (d) => "You burned " + money(-d) + " more propellant than par. Cut the engine and coast sooner; brake later and harder.",
  schedule: (d) => "Par was " + money(-d) + " quicker on the schedule. A flatter arc and a later landing burn save seconds.",
  precision: (d) => "Precision: " + money(-d) + " behind par. Settle over the centre pole before the last few metres.",
  touchdown: (d) => "Touchdown: " + money(-d) + " behind par. Arrive slow: under 1 m/s is where the money is.",
  refund: (d) => "Par got " + money(-d) + " more hardware back. Anything that lands intact refunds half its price: a chute on the decoupler brings a booster home."
};

function finishRun() {
  settleDebris(sim);
  const result = SCORE.ledger(sim, day);
  result.build = cloneBuild(build);
  lastResult = result;
  let out = { isFirst: false, isBest: false, record: SCORE.loadDay(day) };
  if (!botMode) { out = SCORE.submit(day, result, build, result.ok ? ghostRec : null); }

  const r = SCORE.rating(day, result.total, result.ok);
  $("resNumber").textContent = "#" + day.number;
  $("resHeadline").textContent = result.ok ? "Delivered" : ({
    crash: "It Did Not Survive", splash: "Lost at Sea", stranded: "Stranded", lost: "Lost", timeout: "Out of Time"
  }[sim.outcome] || "Contract Lost");
  $("resStars").textContent = result.ok ? r.emoji : "\u{1F4A5}";
  const sc = $("resScore");
  sc.innerHTML = money(result.total) + '<span class="unit">' + (result.total >= 0 ? "profit" : "loss") + "</span>";
  sc.className = "bigscore" + (result.total < 0 ? " neg" : "");
  $("resVerdict").textContent = result.ok ? r.label + (out.isBest && out.record.attempts > 1 ? " · new best" : "") : sim.message;
  $("resVerdict").className = "verdict" + (result.ok ? " ok" : "");

  let note = "";
  if (botMode) { note = "Autopilot demonstration: nothing was recorded."; }
  else if (out.isFirst) { note = "That was your blind run: it's locked in for today."; }
  if (result.ok) {
    const dPar = result.total - day.par.total;
    note += (note ? " " : "") + (dPar >= 0 ? "You beat the Flight Director's par by " + money(dPar) + "." : "The Flight Director's par is " + money(-dPar) + " ahead.");
  } else {
    note += (note ? " " : "") + "No fee without a delivery. The hardware still has to be paid for.";
  }
  $("resNote").textContent = note;

  // the ledger, line by line against the par
  const par = {};
  for (const l of day.par.lines) { par[l.key] = l.value; }
  const rows = result.lines.map((l) => {
    const d = par[l.key] != null ? l.value - par[l.key] : null;
    const dp = result.ok && d != null && Math.abs(d) >= 1 ? '<span class="dp ' + (d > 0 ? "up" : "down") + '">' + (d > 0 ? "+" : "−") + money(Math.abs(d)).replace("$", "$") + "</span>" : '<span class="dp"></span>';
    return '<div class="ln"><span class="lb">' + l.label + "<small>" + l.detail + '</small></span>' + dp +
      '<span class="vl' + (l.value < 0 ? " neg" : "") + '">' + (l.value < 0 ? "−" + money(-l.value) : money(l.value)) + "</span></div>";
  }).join("");
  $("resLedger").innerHTML = rows + '<div class="ln tot"><span class="lb">' + (result.total >= 0 ? "Profit" : "Loss") +
    "<small>par " + money(day.par.total) + '</small></span><span class="dp"></span><span class="vl' + (result.total < 0 ? " neg" : "") + '">' + money(result.total) + "</span></div>";

  // where the money went
  const tips = [];
  if (result.ok) {
    const diffs = [];
    for (const l of result.lines) {
      if (par[l.key] == null || !LINE_TIPS[l.key]) { continue; }
      diffs.push({ key: l.key, d: l.value - par[l.key] });
    }
    for (const k of Object.keys(par)) {
      if (!result.lines.some((l) => l.key === k) && LINE_TIPS[k] && par[k] > 0) { diffs.push({ key: k, d: -par[k] }); }
    }
    diffs.sort((a, b) => a.d - b.d);
    for (const x of diffs.slice(0, 3)) { if (x.d < -300) { tips.push(LINE_TIPS[x.key](x.d)); } }
    const best = diffs[diffs.length - 1];
    if (best && best.d > 500) { tips.push("Your best line against par: " + ({ hardware: "a cheaper rocket", fuel: "less propellant", schedule: "a faster flight", precision: "precision", touchdown: "a softer touchdown", refund: "more hardware home" }[best.key] || best.key) + " (+" + money(best.d) + ")."); }
  } else {
    tips.push(failTip());
  }
  $("resInsights").innerHTML = tips.map((t) => "<li>" + t + "</li>").join("");

  paintRecords("res");
  paintBoard($("resBoard"));
  show("result");
}

function failTip() {
  const L = sim.landing;
  if (sim.outcome === "crash" && L && L.speed > 0) {
    if (Math.abs(L.vertical) > L.vLim) { return "Came in at " + Math.abs(L.vertical).toFixed(1) + " m/s. Start the landing burn earlier, and try RETRO hold so the engine points the right way."; }
    if (Math.abs(L.horizontal) > L.hLim) { return "Sliding sideways at " + Math.abs(L.horizontal).toFixed(1) + " m/s. Kill the drift before the last 30 m."; }
    return "Too much lean at touchdown. Hold it upright for the last few metres.";
  }
  if (sim.outcome === "stranded") { return "Check Δv and thrust-to-weight in the hangar: the stage ran out before the job did."; }
  if (sim.outcome === "splash") { return "The sea is not a landing pad. Watch the dotted arc: it shows where you'll come down."; }
  if (sim.outcome === "lost") { return "Way off course. The dotted arc shows where you'll come down if you cut the engine now."; }
  return "Try again: every flight teaches the next.";
}

function share() {
  const text = SCORE.shareText(day, lastResult || { ok: false, total: 0, stats: {}, lines: [] }, SCORE.loadDay(day), youRank());
  if (navigator.share) { navigator.share({ text }).catch(() => {}); }
  else if (navigator.clipboard) { navigator.clipboard.writeText(text).then(() => toast("Copied"), () => toast("Copy failed")); }
  else { toast("Sharing unavailable"); }
}

// ----------------------------------------------------------------- input

function bindControls() {
  const hold = (el, on, off) => {
    const start = (e) => { e.preventDefault(); el.classList.add("down"); audio.unlock(); on(); };
    const end = () => { el.classList.remove("down"); off(); };
    el.addEventListener("pointerdown", start);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("pointerleave", end);
  };
  hold($("btnRotL"), () => { held.l = true; }, () => { held.l = false; });
  hold($("btnRotR"), () => { held.r = true; }, () => { held.r = false; });
  $("btnStage").addEventListener("pointerdown", (e) => { e.preventDefault(); audio.unlock(); input.stage = true; });
  $("btnChute").addEventListener("pointerdown", (e) => { e.preventDefault(); input.chute = true; });
  $("btnRetro").addEventListener("pointerdown", (e) => { e.preventDefault(); input.retro = !input.retro; paintControls(); });

  // throttle: drag anywhere on the bar
  const thr = $("throttle");
  const setFrom = (e) => {
    const r = thr.getBoundingClientRect();
    setThrottle(1 - (e.clientY - r.top - 4) / (r.height - 8));
    paintControls();
  };
  thr.addEventListener("pointerdown", (e) => { e.preventDefault(); thr.setPointerCapture(e.pointerId); setFrom(e); });
  thr.addEventListener("pointermove", (e) => { if (e.buttons || e.pressure > 0) { setFrom(e); } });

  $("btnRestart").addEventListener("click", () => { if (sim) { launch(); } });
  $("btnQuit").addEventListener("click", () => { openHangar(); });
  $("btnMute").addEventListener("click", () => {
    audio.unlock();
    $("btnMute").textContent = audio.toggleMute() ? "\u{1F507}" : "\u{1F50A}";
  });
  $("btnMute").textContent = audio.isMuted() ? "\u{1F507}" : "\u{1F50A}";

  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    const flying = $("screen-fly").classList.contains("on");
    if ($("screen-hangar").classList.contains("on") && hangar) { hangar.onKey(e); }
    if (e.repeat && (k === " " || k === "e" || k === "f")) { return; }
    keys[k] = true;
    audio.unlock();
    if (flying) {
      if (k === " ") { e.preventDefault(); input.stage = true; }
      if (k === "e") { input.chute = true; }
      if (k === "f") { input.retro = !input.retro; }
      if (k === "z") { setThrottle(1); }
      if (k === "x") { setThrottle(0); }
      if (k === "arrowup" || k === "arrowdown") { e.preventDefault(); }
      if (k === "escape") { openHangar(); }
    }
    if (k === "r" && (flying || $("screen-result").classList.contains("on"))) { launch(); }
    if (k === "m") { $("btnMute").textContent = audio.toggleMute() ? "\u{1F507}" : "\u{1F50A}"; }
  });
  window.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });
  window.addEventListener("blur", () => { for (const k in keys) { keys[k] = false; } held.l = held.r = false; });
}

// ------------------------------------------------------------------- go

function init() {
  paintBrief();
  bindControls();
  $("btnBuild").addEventListener("click", openHangar);
  $("btnQuick").addEventListener("click", launch);
  $("hBack").addEventListener("click", () => { paintBrief(); show("brief"); });
  $("hLaunch").addEventListener("click", launch);
  $("btnAgain").addEventListener("click", launch);
  $("btnEdit").addEventListener("click", openHangar);
  $("btnShare").addEventListener("click", share);
  $("btnHelp").addEventListener("click", () => $("help").classList.add("on"));
  $("helpClose").addEventListener("click", () => $("help").classList.remove("on"));
  $("help").addEventListener("click", (e) => { if (e.target.id === "help") { $("help").classList.remove("on"); } });
  $("btnRandom").addEventListener("click", () => {
    const n = Math.floor(Math.random() * Math.max(1, todayIdx));
    window.location.search = "?day=" + n;
  });
  $("btnToday").addEventListener("click", () => { window.location.search = ""; });
  window.addEventListener("resize", () => {
    if (renderer && $("screen-fly").classList.contains("on")) { renderer.resize(); }
    if (hangar && $("screen-hangar").classList.contains("on")) { hangar.resize(); }
    if ($("screen-brief").classList.contains("on")) { drawMap(); }
  });

  // first visit of the day: show how it works once
  try {
    if (!window.localStorage.getItem("qs-rocket-seen3")) {
      window.localStorage.setItem("qs-rocket-seen3", "1");
      if (!botMode && !params.get("view")) { $("help").classList.add("on"); }
    }
  } catch (e) { /* private mode */ }

  if (botMode) { build = cloneBuild(day.refBuild); launch(); }
  else if (params.get("view") === "hangar") { openHangar(); }
  computeBoard();
  // the map's labels are drawn in the web font once it arrives
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { if ($("screen-brief").classList.contains("on")) { drawMap(); } });
  }

  // handy for consoles and automated checks
  window.DRGame = {
    day, get sim() { return sim; }, launch, openHangar, get build() { return build; },
    get hangar() { return hangar; }, audio,
    useBuild(b) { build = cloneBuild(b); if (hangar) { hangar.setBuild(build); } }
  };
}

if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", init); }
else { init(); }
