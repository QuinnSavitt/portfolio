/* Daily Rocket — application shell: screens, input, the fixed-step loop.
 * Physics is deterministic and lives in physics.js; this file owns the DOM,
 * the render/audio coupling, and the record keeping.
 */

import { dayIndex, msUntilReset } from "./daily.js";
import { generateDay, REF_LOADOUT } from "./gen.js";
import {
  makeShip, step, DT, ENGINES, HULL_MASS, TANK_CAP, hoverThrottle, windAt
} from "./physics.js";
import { botInput } from "./bot.js";
import * as SCORE from "./score.js";
import { createRenderer } from "./render.js";
import { createAudio } from "./audio.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const distFmt = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m");

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
let renderer = null;

let loadout = { engine: REF_LOADOUT.engine, fuelFrac: REF_LOADOUT.fuelFrac };
const rec0 = SCORE.loadDay(day);
if (rec0.best && rec0.best.loadout && ENGINES[rec0.best.loadout.engine]) {
  loadout = { engine: rec0.best.loadout.engine, fuelFrac: rec0.best.loadout.fuelFrac };
}

let ship = null;
let ghost = null;         // best-run replay samples
let ghostTrail = null;    // same, as a polyline
let trail = [];
let ghostRec = [];
let lastTrailT = 0, lastGhostT = 0;
let finishAt = 0;         // wall time to leave the fly screen
let lastResult = null;
let raf = 0, lastNow = 0, acc = 0;

const held = { left: false, right: false, burn: false, ease: false };
const keys = {};

// --------------------------------------------------------------- screens

function show(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("on"));
  $("screen-" + name).classList.add("on");
  if (name !== "fly") { stopLoop(); audio.setEngine(0, false); audio.setWind(0); }
}

let toastT = 0;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  window.clearTimeout(toastT);
  toastT = window.setTimeout(() => t.classList.remove("on"), 1900);
}

// ---------------------------------------------------------------- brief

function paintBrief() {
  $("briefNumber").textContent = "#" + day.number;
  $("briefWorld").textContent = day.world.name + " · " + day.world.atmo + " atmosphere";
  $("missionName").textContent = day.mission.name;
  $("missionBrief").textContent = day.mission.brief;
  $("practiceNote").style.display = practice ? "block" : "none";
  if (practice) {
    $("practiceNote").textContent = "Practice flight — rocket #" + day.number +
      " from the archive. Records for that day only; no streak.";
  }

  const w = day.world;
  const windTxt = w.rho0 <= 0
    ? "None"
    : w.wind.toFixed(0) + " m/s " + (w.windDir < 0 ? "←" : "→") +
      (w.gust > 1.5 ? " g" + Math.round(w.gust) : "");
  const facts = [
    ["Gravity", w.g.toFixed(1) + " m/s²"],
    ["Air", w.atmo],
    ["Wind", windTxt],
    ["Range", distFmt(day.pad.x)],
    ["Pad", Math.round(day.pad.halfW * 2) + " m wide"],
    ["Par", day.par.time.toFixed(0) + " s · " + day.par.fuel + " kg"]
  ];
  $("factGrid").innerHTML = facts.map((f) =>
    '<div class="fact"><div class="k">' + f[0] + '</div><div class="v">' + f[1] + "</div></div>"
  ).join("");

  paintLoadout();
  paintRecords("rec");
  tickClock();
}

function paintLoadout() {
  const cards = Object.values(ENGINES).map((e) => {
    const sel = loadout.engine === e.id ? " sel" : "";
    return '<button class="engine' + sel + '" data-engine="' + e.id + '">' +
      '<span class="nm">' + e.name + "</span>" +
      '<span class="st">' + Math.round(e.thrust / 1000) + " kN · " + e.mass + " kg · " +
      e.flow.toFixed(1) + " kg/s</span>" +
      '<span class="bl">' + e.blurb + "</span></button>";
  }).join("");
  $("engineCards").innerHTML = cards;
  $("engineCards").querySelectorAll(".engine").forEach((el) => {
    el.addEventListener("click", () => {
      loadout.engine = el.getAttribute("data-engine");
      audio.unlock();
      paintLoadout();
    });
  });
  $("fuelRange").value = Math.round(loadout.fuelFrac * 100);
  paintLoadoutStats();
}

function paintLoadoutStats() {
  const eng = ENGINES[loadout.engine];
  const fuel = TANK_CAP * loadout.fuelFrac;
  const m0 = HULL_MASS + eng.mass + fuel;
  const twr = eng.thrust / (m0 * day.world.g);
  const ve = eng.thrust / eng.flow;
  const dv = ve * Math.log(m0 / (m0 - fuel));

  $("fuelPct").textContent = Math.round(loadout.fuelFrac * 100) + "%";
  $("loadFuel").textContent = Math.round(fuel) + " kg";
  $("loadMass").textContent = Math.round(m0) + " kg";
  $("loadTWR").textContent = twr.toFixed(2);
  $("loadTWR").className = "v" + (twr < 1.05 ? " bad" : twr < 1.25 ? " warn" : "");
  $("loadDv").textContent = Math.round(dv) + " m/s";

  const w = $("loadWarn");
  if (twr < 1.02) {
    w.textContent = "Too heavy to lift off — it will sit there burning fuel until it slims down. Take less fuel or a bigger engine.";
    w.style.display = "block";
  } else if (twr < 1.15) {
    w.textContent = "Barely climbs. Expect a slow, expensive ascent.";
    w.style.display = "block";
  } else {
    w.style.display = "none";
  }
}

function paintRecords(prefix) {
  const rec = SCORE.loadDay(day);
  const first = rec.first
    ? (rec.first.failed ? "\u{1F4A5}" : fmt(rec.first.total))
    : "—";
  $(prefix + "First").textContent = first;
  $(prefix + "Best").textContent = rec.best ? fmt(rec.best.total) : "—";
  $(prefix + "Attempts").textContent = rec.attempts || 0;
  if (prefix === "rec") {
    const s = SCORE.lifetimeStats();
    $("streakChip").textContent = s.streak > 1 ? s.streak + " day streak" : "";
  }
}

function tickClock() {
  const ms = msUntilReset();
  const p = (n) => (n < 10 ? "0" : "") + n;
  $("resetClock").textContent =
    p(Math.floor(ms / 3600000)) + ":" + p(Math.floor((ms % 3600000) / 60000)) + ":" +
    p(Math.floor((ms % 60000) / 1000));
}
window.setInterval(tickClock, 1000);

// ---------------------------------------------------------------- flight

function startFlight() {
  audio.unlock();
  ship = makeShip(day, loadout);
  ghost = SCORE.loadGhost(day);
  ghostTrail = ghost ? ghost.filter((_, i) => i % 2 === 0) : null;
  trail = [];
  ghostRec = [];
  lastTrailT = -1; lastGhostT = -1;
  finishAt = 0;
  held.left = held.right = held.burn = held.ease = false;

  if (!renderer) { renderer = createRenderer($("flyCanvas"), day); }
  renderer.reset();
  $("botChip").style.display = botMode ? "block" : "none";
  show("fly");
  renderer.resize();
  startLoop();
}

function sampleInput() {
  if (botMode) { return botInput(ship, 0.85); }
  let rot = 0;
  if (held.left || keys.a || keys.arrowleft) { rot -= 1; }
  if (held.right || keys.d || keys.arrowright) { rot += 1; }
  let thrust = 0;
  if (held.burn || keys.w || keys.arrowup || keys[" "]) { thrust = 1; }
  else if (held.ease || keys.s || keys.arrowdown) { thrust = hoverThrottle(ship) * 0.94; }
  return { rot, thrust };
}

function startLoop() {
  lastNow = performance.now();
  acc = 0;
  if (!raf) { raf = window.requestAnimationFrame(frame); }
}

function stopLoop() {
  if (raf) { window.cancelAnimationFrame(raf); raf = 0; }
}

function frame(now) {
  raf = window.requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - lastNow) / 1000);
  lastNow = now;

  if (ship && !ship.done) {
    acc += dt;
    let guard = 0;
    while (acc >= DT && guard < 600) {
      step(ship, sampleInput());
      acc -= DT; guard++;
      if (ship.t - lastTrailT >= 0.12) {
        lastTrailT = ship.t;
        if (trail.length < 4000) { trail.push({ x: ship.x, y: ship.y }); }
      }
      if (ship.t - lastGhostT >= 0.15) {
        lastGhostT = ship.t;
        if (ghostRec.length < 2400) { ghostRec.push({ x: ship.x, y: ship.y, ang: ship.ang }); }
      }
      if (ship.done) { break; }
    }
    drainEvents();
    if (ship.done) {
      finishAt = now + (ship.outcome === "crash" ? 1700 : 1100);
      audio.setEngine(0, false);
    }
  }

  if (ship) {
    const gpos = ghost && !ship.done ? ghostAt(ship.t) : null;
    renderer.frame(ship, dt, { trail, ghostTrail, ghostPos: gpos });
    paintHud();
    if (!ship.done) {
      audio.setEngine(ship.burning || 0, day.world.rho0 <= 0.02);
      const wRel = Math.abs(windAt(day, ship.t) - ship.vx) + Math.hypot(ship.vx, ship.vy) * 0.3;
      audio.setWind(day.world.rho0 > 0 ? Math.min(1, wRel / 40) : 0);
    }
  }

  if (ship && ship.done && finishAt && now >= finishAt) {
    finishAt = 0;
    finishRun();
  }
}

function ghostAt(t) {
  if (!ghost || !ghost.length) { return null; }
  const i = Math.min(ghost.length - 1, Math.floor(t / 0.15));
  return ghost[i];
}

function drainEvents() {
  while (ship.events.length) {
    const e = ship.events.shift();
    renderer.onEvent(e, ship);
    if (e.type === "beacon") { audio.beacon(); }
    else if (e.type === "explosion") { audio.explosion(); }
    else if (e.type === "flameout") { audio.flameout(); toast("Flameout — tank dry"); }
    else if (e.type === "touchdown") {
      audio.thud(e.speed > 2.5);
      if (ship.outcome === "landed") { audio.fanfare(); }
      else if (!e.onPad && !ship.done) { toast("Down safe — but that isn't the pad"); }
    }
  }
}

// ------------------------------------------------------------------ HUD

function paintHud() {
  const altG = ship.y - day.terrain.heightAt(ship.x) - 3.4;
  const vy = ship.vy, vx = ship.vx;
  $("hudAlt").textContent = Math.max(0, Math.round(altG)) + " m";
  $("hudVy").textContent = (vy > 0 ? "+" : "") + vy.toFixed(1);
  $("hudVy").parentElement.className = "tel" +
    (vy < -4.2 && altG < 200 ? " alert" : vy < -3 && altG < 120 ? " warn" : "");
  $("hudVx").textContent = (vx > 0 ? "+" : "") + vx.toFixed(1);
  const fuelFrac = ship.fuelLoaded > 0 ? ship.fuel / ship.fuelLoaded : 0;
  $("hudFuelFill").style.width = (fuelFrac * 100).toFixed(1) + "%";
  $("hudFuelFill").className = "fill" + (fuelFrac < 0.18 ? " low" : "");
  const wind = windAt(day, ship.t);
  $("hudWind").textContent = day.world.rho0 <= 0 ? "—"
    : Math.abs(wind).toFixed(0) + (wind < 0 ? " ←" : " →");
  $("hudBeacons").textContent = ship.collected + "/" + day.beacons.length;
  $("hudTime").textContent = ship.t.toFixed(0) + "s";
  $("hudPad").textContent = distFmt(Math.abs(ship.x - day.pad.x));
}

// --------------------------------------------------------------- results

function finishRun() {
  const result = SCORE.score(ship, day);
  lastResult = result;
  let out = { isFirst: false, isBest: false, record: SCORE.loadDay(day) };
  if (!botMode) {
    out = SCORE.submit(day, result, ship, { ...loadout }, result.failed ? null : ghostRec);
  }

  $("resNumber").textContent = "#" + day.number;
  const medal = result.medal;
  $("resMedal").textContent = result.failed ? "\u{1F4A5}" : medal ? medal.emoji : "";
  $("resHeadline").textContent = result.failed
    ? (ship.outcome === "crash" ? "It Did Not Survive" :
       ship.outcome === "stranded" ? "Stranded" :
       ship.outcome === "lost" ? "Lost Downrange" : "Out of Time")
    : "Payload Delivered";
  $("resVerdict").textContent = result.failed
    ? ship.message
    : (medal ? medal.label + " landing" : "Landed") +
      (out.isBest && out.record.attempts > 1 ? " · new personal best" : "");
  $("resVerdict").className = "verdict" + (result.failed ? "" : " ok");
  $("resScore").textContent = result.failed ? "0" : fmt(result.total);

  let note = "";
  if (botMode) { note = "Autopilot demonstration — nothing was recorded."; }
  else if (out.isFirst) { note = "That was the blind run — it is locked in for today."; }
  else if (!result.failed && !out.isBest && out.record.best) {
    note = "Your best today is " + fmt(out.record.best.total) + ".";
  }
  $("resNote").textContent = note;

  const rows = result.lines.map((l) =>
    '<div class="ln"><span class="lb">' + l.label + '</span><span class="dt">' +
    l.detail + '</span><span class="vl">+' + fmt(l.value) + "</span></div>"
  ).join("");
  $("resBreakdown").innerHTML = result.failed
    ? '<div class="ln"><span class="lb">Beacons reached</span><span class="vl">' +
      ship.collected + "/" + day.beacons.length + "</span></div>" +
      '<div class="ln"><span class="lb">No points — the payload matters.</span></div>'
    : rows + '<div class="ln tot"><span class="lb">Total</span><span class="vl">' +
      fmt(result.total) + "</span></div>";

  paintRecords("res");
  show("result");
}

// ----------------------------------------------------------------- input

function bindControls() {
  const pressHold = (el, on, off) => {
    const start = (e) => { e.preventDefault(); el.classList.add("down"); audio.unlock(); on(); };
    const end = () => { el.classList.remove("down"); off(); };
    el.addEventListener("touchstart", start, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    el.addEventListener("mousedown", start);
    el.addEventListener("mouseup", end);
    el.addEventListener("mouseleave", end);
  };
  pressHold($("btnRotL"), () => { held.left = true; }, () => { held.left = false; });
  pressHold($("btnRotR"), () => { held.right = true; }, () => { held.right = false; });
  pressHold($("btnBurn"), () => { held.burn = true; }, () => { held.burn = false; });
  pressHold($("btnEase"), () => { held.ease = true; }, () => { held.ease = false; });

  $("btnRestart").addEventListener("click", () => { if (ship) { startFlight(); } });
  $("btnQuit").addEventListener("click", () => { paintBrief(); show("brief"); });
  $("btnMute").addEventListener("click", () => {
    audio.unlock();
    $("btnMute").textContent = audio.toggleMute() ? "\u{1F507}" : "\u{1F50A}";
  });
  $("btnMute").textContent = audio.isMuted() ? "\u{1F507}" : "\u{1F50A}";

  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    keys[k] = true;
    audio.unlock();
    if (k === " ") { e.preventDefault(); }
    if (k === "arrowup" || k === "arrowdown") { e.preventDefault(); }
    if (k === "r") {
      if ($("screen-fly").classList.contains("on") || $("screen-result").classList.contains("on")) {
        startFlight();
      }
    }
    if (k === "m") { $("btnMute").textContent = audio.toggleMute() ? "\u{1F507}" : "\u{1F50A}"; }
    if (k === "escape" && $("screen-fly").classList.contains("on")) { paintBrief(); show("brief"); }
  });
  window.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });
}

// ------------------------------------------------------------------- go

function init() {
  paintBrief();

  $("fuelRange").addEventListener("input", () => {
    loadout.fuelFrac = parseInt($("fuelRange").value, 10) / 100;
    paintLoadoutStats();
  });
  $("btnLaunch").addEventListener("click", startFlight);
  $("btnAgain").addEventListener("click", startFlight);
  $("btnLoadout").addEventListener("click", () => { paintBrief(); show("brief"); });
  $("btnHelp").addEventListener("click", () => {
    const h = $("helpPanel");
    h.style.display = h.style.display === "none" ? "block" : "none";
  });
  $("btnShare").addEventListener("click", () => {
    const text = SCORE.shareText(day, lastResult || { failed: true }, SCORE.loadDay(day));
    if (navigator.share) {
      navigator.share({ text }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => toast("Copied"), () => toast("Copy failed"));
    } else { toast("Sharing unavailable"); }
  });

  bindControls();
  window.addEventListener("resize", () => {
    if (renderer && $("screen-fly").classList.contains("on")) { renderer.resize(); }
  });

  if (botMode) { startFlight(); }

  // handy for consoles and automated checks
  window.DRGame = { day, get ship() { return ship; }, startFlight, loadout };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
