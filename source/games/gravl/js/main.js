/* Gravl — game orchestration.
 *
 * Owns the state machine (menu → countdown → running → finished), the fixed
 * 120 Hz physics loop, the chase camera, HUD, checkpoint/split/finish timing
 * and persistence. Rendering runs at display rate; timing runs on physics
 * ticks and is therefore identical on every machine.
 */

import * as THREE from "three";
import { dayIndex, msUntilReset, fmtCountdown, fmtTime, fmtDelta, hash32 } from "./daily.js";
import { loadStage } from "./stage.js";
import { makeCar, resetCar, step, botInput, DT } from "./physics.js";
import { buildWorld } from "./world.js";
import * as audio from "./audio.js";
import { makeCoDriver, sevColor, chipLabel } from "./pacenotes.js";
import { makeRecorder, encodeGhost, decodeGhost, ghostPose, ghostTimeAt, SAMPLE_EVERY } from "./ghost.js";
import * as records from "./records.js";

/* ------------------------------------------------------------------ DOM */

const $ = (id) => document.getElementById(id);
const els = {
  gl: $("gl"),
  loading: $("loading"), loadStatus: $("loadStatus"),
  menu: $("menu"), menuKicker: $("menuKicker"), menuTitle: $("menuTitle"), menuSub: $("menuSub"),
  menuFacts: $("menuFacts"), menuBlind: $("menuBlind"), menuBest: $("menuBest"), menuAttempts: $("menuAttempts"),
  btnDrive: $("btnDrive"), btnPractice: $("btnPractice"), btnHelp: $("btnHelp"),
  togAudio: $("togAudio"), togVoice: $("togVoice"), togGhost: $("togGhost"), togQuality: $("togQuality"),
  menuStats: $("menuStats"), nextIn: $("nextIn"),
  results: $("results"), resKicker: $("resKicker"), resTime: $("resTime"), resBadges: $("resBadges"),
  resDelta: $("resDelta"), resGrid: $("resGrid"),
  btnRetry: $("btnRetry"), btnShare: $("btnShare"), btnMenu: $("btnMenu"), resHint: $("resHint"),
  help: $("help"), btnCloseHelp: $("btnCloseHelp"),
  stageTag: $("stageTag"), timer: $("timer"), delta: $("delta"), notesStrip: $("notesStrip"),
  speed: $("speed"), gear: $("gear"), damageBar: $("damageBar"), damageFill: $("damageFill"),
  splitPop: $("splitPop"), centerMsg: $("centerMsg"), pauseHint: $("pauseHint"),
};

/* ----------------------------------------------------------------- state */

const S = {
  state: "loading",          // loading | menu | countdown | running | finished
  mode: "daily",             // daily | practice
  day: dayIndex(),
  stage: null,
  world: null,
  renderer: null,
  camera: null,
  // visual: on, so the physics samples the ground under each wheel for the
  // renderer. The stage audition's throwaway cars leave it off.
  car: Object.assign(makeCar(), { visual: true }),
  codriver: null,
  recorder: makeRecorder(),
  settings: records.getSettings(),
  pbGhost: null,

  ticks: 0,
  countdownT: 0,
  countdownStep: -1,
  cpIdx: 0,
  maxS: 0,
  splitTimes: [],
  splitPopT: 0,
  offCourse: false,
  wrongWay: false,
  finishTime: null,
  runStarted: false,
  camMode: 0,
  camShake: 0,
  camPos: new THREE.Vector3(),
  camLook: new THREE.Vector3(),
  deltaShown: null,
  lastResult: null,
  helpSeen: !!window.localStorage.getItem("qs-rally-help-seen"),
};

const keys = {};
const qs = new URLSearchParams(window.location.search);
if (qs.get("day")) S.day = parseInt(qs.get("day"), 10);
const BOT_DRIVE = !!qs.get("bot");   // dev/demo: the stage bot drives

/* ----------------------------------------------------------------- input */

window.addEventListener("keydown", (e) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].indexOf(e.key) >= 0) e.preventDefault();
  if (e.repeat) return;
  keys[e.code] = true;
  handleKey(e.code);
});
window.addEventListener("keyup", (e) => { keys[e.code] = false; });
window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; });

function readInput() {
  const left = keys.KeyA || keys.ArrowLeft;
  const right = keys.KeyD || keys.ArrowRight;
  return {
    // positive dir = positive curvature, which is a SCREEN-RIGHT turn in the
    // Y-up render coordinate system, so the D/→ key maps to +1
    dir: (right ? 1 : 0) - (left ? 1 : 0),
    throttle: keys.KeyW || keys.ArrowUp ? 1 : 0,
    brake: keys.KeyS || keys.ArrowDown ? 1 : 0,
    handbrake: !!keys.Space,
  };
}

function handleKey(code) {
  if (S.state === "loading") return;
  if (code === "KeyR") {
    if (S.state === "running" || S.state === "finished" || S.state === "countdown") startRun(false);
    return;
  }
  if (code === "KeyC") {
    S.camMode = (S.camMode + 1) % 3;
    S.settings.camera = S.camMode;
    records.saveSettings(S.settings);
    if (S.world) S.world.carGroup.visible = S.camMode !== 2;
    return;
  }
  if (code === "KeyG") { S.settings.ghost = !S.settings.ghost; records.saveSettings(S.settings); syncToggles(); return; }
  if (code === "KeyN") { audio.setVoiceMuted(!audio.isVoiceMuted()); S.settings.voice = !audio.isVoiceMuted(); records.saveSettings(S.settings); syncToggles(); return; }
  if (code === "KeyM") { audio.setMuted(!audio.isMuted()); S.settings.audio = !audio.isMuted(); records.saveSettings(S.settings); syncToggles(); return; }
  if (code === "Escape") {
    if (S.state === "running" || S.state === "finished" || S.state === "countdown") showMenu();
    return;
  }
  if ((code === "Enter" || code === "KeyD" || code === "Space") && S.state === "menu") {
    // quick launch from menu with Enter
    if (code === "Enter") beginDrive();
  }
}

/* ------------------------------------------------------------- screens */

function showScreen(name) {
  for (const id of ["loading", "menu", "results", "help"]) {
    els[id].classList.toggle("on", id === name);
  }
  setHudVisible(name === null);
}

function setHudVisible(on) {
  const disp = on ? "" : "none";
  for (const el of [els.stageTag, els.timer.parentElement, els.notesStrip, els.speed.parentElement, els.splitPop, els.centerMsg, els.pauseHint]) {
    el.style.display = disp;
  }
  els.pauseHint.style.display = on ? "" : "none";
  if (!on) els.damageBar.style.display = "none";
}

/* -------------------------------------------------------------- booting */

async function boot() {
  els.loadStatus.textContent = "generating candidates…";
  await nextFrame(); await nextFrame();

  const t0 = performance.now();
  S.stage = loadStage(S.day);
  els.loadStatus.textContent = "stage “" + S.stage.stageName + "” validated in " +
    Math.round(performance.now() - t0) + " ms — building world…";
  await nextFrame(); await nextFrame();

  // renderer
  try {
    S.renderer = new THREE.WebGLRenderer({ canvas: els.gl, antialias: S.settings.quality !== "low" });
  } catch (err) {
    els.loadStatus.textContent = "WebGL is not available in this browser.";
    return;
  }
  S.renderer.outputColorSpace = THREE.SRGBColorSpace;
  applyQuality();

  S.world = buildWorld(S.stage, { quality: S.settings.quality });
  S.camera = new THREE.PerspectiveCamera(64, 1, 0.3, 2400);
  onResize();

  S.codriver = makeCoDriver(S.stage, (text, urgent) => audio.speak(text, urgent));
  S.camMode = S.settings.camera || 0;
  const rec = records.getDayRecord(S.day);
  S.pbGhost = S.mode === "daily" ? decodeGhost(rec.ghost) : null;

  audio.setMuted(!S.settings.audio);
  audio.setVoiceMuted(!S.settings.voice);

  resetCar(S.car, S.stage);
  placeCameraInstant();
  showMenu();
  requestAnimationFrame(frame);
}

function nextFrame() { return new Promise((res) => requestAnimationFrame(res)); }

window.addEventListener("resize", onResize);
function onResize() {
  if (!S.renderer || !S.camera) return;
  const w = window.innerWidth, h = window.innerHeight;
  S.renderer.setSize(w, h, false);
  S.camera.aspect = w / h;
  S.camera.updateProjectionMatrix();
}

function applyQuality() {
  const q = S.settings.quality;
  const pr = window.devicePixelRatio || 1;
  S.renderer.setPixelRatio(q === "high" ? Math.min(2, pr) : q === "med" ? Math.min(1.25, pr) : 0.85);
}

/* ---------------------------------------------------------------- menu */

function showMenu() {
  S.state = "menu";
  // Backing out mid-stage should cut the engine promptly, not fade it over the
  // menu the way a finish does.
  audio.engineStop(0.25);
  audio.stopSpeech();
  showScreen("menu");
  fillMenu();
}

function fillMenu() {
  const st = S.stage;
  const rec = records.getDayRecord(S.day);
  els.menuKicker.textContent = S.mode === "daily" ? "Gravl" : "Practice stage";
  els.menuTitle.textContent = (S.mode === "daily" ? "#" + st.number + " — " : "") + st.env.name.toUpperCase();
  els.menuSub.innerHTML = "<b>" + st.stageName + "</b> · " + st.kmText + " · " +
    st.surfaceName + " · " + st.weather.label + " · " + st.tod.label + " · AWD";
  const expected = "≈ " + fmtTime(Math.round(st.estCasual)).replace(/\.\d+$/, "");
  els.menuFacts.innerHTML =
    fact("Length", st.kmText) +
    fact("Surface", st.surfaceName) +
    fact("Weather", st.weather.label) +
    fact("Light", st.tod.label) +
    fact("Expected", expected);
  els.menuBlind.textContent = rec.blind != null ? fmtTime(rec.blind) : "—";
  els.menuBest.textContent = rec.best != null ? fmtTime(rec.best) : "—";
  els.menuAttempts.textContent = rec.attempts;
  els.btnDrive.textContent = rec.blind == null ? "Drive — blind run" : "Drive";

  const stats = records.getStats();
  els.menuStats.innerHTML = stats.days > 0
    ? "Streak <b>" + stats.streak + "</b> · rallies <b>" + stats.days + "</b> · attempts <b>" + stats.attempts + "</b>"
    : "First time? Tap <b>Controls</b> — then trust the co-driver.";
  els.nextIn.textContent = fmtCountdown(msUntilReset());
  syncToggles();
}

function fact(k, v) {
  return "<div class='fact'><div class='k'>" + k + "</div><div class='v'>" + v + "</div></div>";
}

function syncToggles() {
  els.togAudio.classList.toggle("on", S.settings.audio);
  els.togVoice.classList.toggle("on", S.settings.voice);
  els.togGhost.classList.toggle("on", S.settings.ghost);
  els.togQuality.textContent = "Quality: " + (S.settings.quality === "high" ? "High" : S.settings.quality === "med" ? "Med" : "Low");
}

els.btnDrive.addEventListener("click", beginDrive);
els.btnPractice.addEventListener("click", () => {
  const rnd = 100000 + Math.floor(Math.random() * 800000);
  window.location.search = "?day=" + rnd + "&practice=1";
});
els.btnHelp.addEventListener("click", () => showScreen("help"));
els.btnCloseHelp.addEventListener("click", () => {
  window.localStorage.setItem("qs-rally-help-seen", "1");
  S.helpSeen = true;
  if (S.state === "menu") showScreen("menu"); else showScreen(null);
});
els.togAudio.addEventListener("click", () => { S.settings.audio = !S.settings.audio; audio.setMuted(!S.settings.audio); records.saveSettings(S.settings); syncToggles(); });
els.togVoice.addEventListener("click", () => { S.settings.voice = !S.settings.voice; audio.setVoiceMuted(!S.settings.voice); records.saveSettings(S.settings); syncToggles(); });
els.togGhost.addEventListener("click", () => { S.settings.ghost = !S.settings.ghost; records.saveSettings(S.settings); syncToggles(); });
els.togQuality.addEventListener("click", () => {
  S.settings.quality = S.settings.quality === "high" ? "med" : S.settings.quality === "med" ? "low" : "high";
  records.saveSettings(S.settings);
  applyQuality();
  syncToggles();
});
els.btnRetry.addEventListener("click", () => startRun(false));
els.btnMenu.addEventListener("click", showMenu);
els.btnShare.addEventListener("click", () => {
  const rec = records.getDayRecord(S.day);
  const text = records.shareText(S.stage, rec);
  const done = () => {
    els.btnShare.textContent = "Copied!";
    setTimeout(() => { els.btnShare.textContent = "Share"; }, 1400);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, done);
  }
});

if (qs.get("practice")) S.mode = "practice";

function beginDrive() {
  audio.init();               // user gesture: unlock audio + speech
  if (!S.helpSeen) {
    showScreen("help");
    S.helpSeen = true;
    window.localStorage.setItem("qs-rally-help-seen", "1");
    // after closing help, they can hit Drive again
    return;
  }
  startRun(true);
}

/* ------------------------------------------------------------ run flow */

function startRun(fromMenu) {
  audio.init();
  // an abandoned mid-run attempt still counts as an attempt
  if (S.state === "running" && S.runStarted && S.ticks > 240 && S.mode === "daily") {
    records.bumpAttempts(S.day);
  }
  audio.stopSpeech();
  // Telemetry is live again from here: the car idles on the line through the
  // countdown. Also cancels a fade still running from the previous attempt.
  audio.engineStart();
  resetCar(S.car, S.stage);
  S.recorder.reset();
  S.codriver.reset();
  S.ticks = 0;
  S.cpIdx = 0;
  S.maxS = 0;
  S.splitTimes = [];
  S.offCourse = false;
  S.wrongWay = false;
  S.finishTime = null;
  S.runStarted = false;
  S.deltaShown = null;
  S.countdownT = 0;
  S.countdownStep = -1;
  S.state = "countdown";
  showScreen(null);
  els.stageTag.textContent = (S.mode === "daily" ? "GRAVL #" + S.stage.number : "PRACTICE") +
    " · " + S.stage.env.name + " · " + S.stage.stageName;
  els.splitPop.textContent = "";
  els.delta.textContent = "";
  els.timer.textContent = "0.000";
  placeCameraInstant();
  const rec = records.getDayRecord(S.day);
  S.pbGhost = S.mode === "daily" && S.settings.ghost !== false ? decodeGhost(rec.ghost) : S.pbGhost;
}

function finishRun() {
  const st = S.stage;
  // precise crossing time within the tick
  S.state = "finished";
  const time = S.finishTime;
  // Physics stops here, so the engine has no telemetry left to track. Ride it
  // down under the fanfare rather than leaving it holding the note it crossed
  // the line on.
  audio.engineStop(1.2);
  audio.finishFanfare();
  audio.speak("stage complete", false);

  const sectors = [
    S.splitTimes[0] != null ? S.splitTimes[0] : time,
    S.splitTimes[1] != null ? S.splitTimes[1] - S.splitTimes[0] : 0,
    S.splitTimes[1] != null ? time - S.splitTimes[1] : 0,
  ];

  let flags = null;
  const prevRec = records.getDayRecord(S.day);
  const prevSectors = prevRec.sectors;
  if (S.mode === "daily") {
    const ghostB64 = encodeGhost(S.recorder.frames(), time);
    flags = records.recordRun(S.day, {
      time, splits: S.splitTimes.slice(), sectors, ghost: ghostB64,
    });
  }
  S.lastResult = { time, sectors, flags, prevSectors, prevBest: prevRec.best };
  showResults();
}

function showResults() {
  const { time, sectors, flags, prevSectors } = S.lastResult;
  const rec = records.getDayRecord(S.day);
  showScreen("results");
  els.resKicker.textContent = (S.mode === "daily" ? "Gravl #" + S.stage.number : "Practice") +
    " — " + S.stage.env.name + " · " + S.stage.stageName;
  els.resTime.textContent = fmtTime(time);

  let badges = "";
  if (S.mode === "practice") {
    badges = "<span class='res-badge blind'>PRACTICE — not recorded</span>";
  } else if (flags) {
    if (flags.firstEver) badges += "<span class='res-badge blind'>BLIND RUN — locked in</span>";
    if (flags.newBest && !flags.firstEver) badges += "<span class='res-badge pb'>NEW PERSONAL BEST</span>";
    if (flags.newBest && flags.firstEver) badges += "<span class='res-badge pb'>PERSONAL BEST</span>";
  }
  els.resBadges.innerHTML = badges;

  if (flags && flags.newBest && flags.prevBest != null) {
    els.resDelta.innerHTML = "<span style='color:var(--good)'>" + fmtDelta(time - flags.prevBest) + "</span> vs previous best " + fmtTime(flags.prevBest);
  } else if (flags && !flags.newBest && rec.best != null) {
    els.resDelta.innerHTML = "<span style='color:var(--bad)'>" + fmtDelta(time - rec.best) + "</span> vs your best " + fmtTime(rec.best);
  } else {
    els.resDelta.textContent = "";
  }

  // sectors, graded against the stage's ideal pace and compared to your best
  const ideals = records.sectorIdeals(S.stage);
  let grid = "";
  for (let i = 0; i < 3; i++) {
    let cls = "", val = fmtTime(sectors[i]);
    if (prevSectors && prevSectors[i] > 0) {
      const d = sectors[i] - prevSectors[i];
      cls = d <= 0 ? "up" : "down";
      val += " <span style='font-size:11px'>" + fmtDelta(d) + "</span>";
    }
    grid += resCell("Sector " + (i + 1) + " " + records.sectorEmoji(sectors[i], ideals[i]), val, cls);
  }
  els.resGrid.innerHTML = grid;

  // most time lost
  let hint = "";
  if (prevSectors && prevSectors[0] > 0) {
    let worst = 0, worstD = -1;
    for (let i = 0; i < 3; i++) {
      const d = sectors[i] - prevSectors[i];
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worstD > 0.05) hint = "Most time lost: <b>Sector " + (worst + 1) + "</b> — ";
  }
  els.resHint.innerHTML = hint + "Press <b>R</b> to go again.";
}

function resCell(k, v, cls) {
  return "<div class='res-cell'><div class='k'>" + k + "</div><div class='v " + (cls || "") + "'>" + v + "</div></div>";
}

/* --------------------------------------------------------- physics tick */

function tick() {
  const st = S.stage;
  const car = S.car;
  const prevS = car.s;
  const input = BOT_DRIVE ? botInput(car, st, st.profile, 0.87) : readInput();
  const ev = step(car, st, input);
  S.ticks++;
  if (!S.runStarted && (input.throttle > 0 || Math.abs(car.vx) > 0.5)) S.runStarted = true;

  // audio events
  if (ev.impact > 3) audio.impact(ev.impact);
  if (ev.landed > 2.5) audio.landing(ev.landed);

  // dust
  const speed = Math.abs(car.vx);
  if (!car.airborne && speed > 6) {
    const loose = st.surfKey !== "tarmac" && st.surfKey !== "tarmacWet";
    const offr = car.zone !== "road";
    const amt = (car.skid > 0.3 ? 2 : 0) + (loose && speed > 16 ? 1 : 0) + (offr ? 2 : 0);
    if (amt > 0 && S.ticks % 4 === 0) S.world.spawnDust(car, amt);
  }

  if (S.ticks % SAMPLE_EVERY === 0) S.recorder.sample(car);
  S.codriver.update(car);

  // progress
  if (car.s > S.maxS) S.maxS = car.s;
  S.wrongWay = S.maxS - car.s > 30 && speed > 3;

  // checkpoints
  const cps = st.checkpoints;
  while (S.cpIdx < cps.length && car.s >= cps[S.cpIdx] && prevS < car.s) {
    const q = st.roadQuery(car.x, car.z, car.s);
    const gate = (q ? q.hw : 5) + 11;
    if (!q || Math.abs(q.d) > gate) {
      S.offCourse = true;
    }
    S.cpIdx++;
  }
  if (car.dead) S.offCourse = true;

  // splits
  for (let i = 0; i < 2; i++) {
    if (S.splitTimes[i] == null && prevS < st.splitS[i] && car.s >= st.splitS[i]) {
      const frac = (st.splitS[i] - prevS) / Math.max(0.001, car.s - prevS);
      const t = (S.ticks - 1 + frac) / 120;
      S.splitTimes[i] = t;
      onSplit(i, t);
    }
  }

  // finish
  if (car.s >= st.finishS && prevS < st.finishS && !S.offCourse) {
    const frac = (st.finishS - prevS) / Math.max(0.001, car.s - prevS);
    S.finishTime = (S.ticks - 1 + frac) / 120;
    finishRun();
  }
}

function onSplit(i, t) {
  const rec = records.getDayRecord(S.day);
  let text = "SPLIT " + (i + 1) + "  " + fmtTime(t);
  let color = "#fff";
  if (rec.splits && rec.splits[i] != null) {
    const d = t - rec.splits[i];
    text += "  " + fmtDelta(d);
    color = d <= 0 ? "#8ce8a8" : "#ff9c94";
    audio.splitChime(d <= 0);
  } else {
    audio.splitChime(true);
  }
  els.splitPop.textContent = text;
  els.splitPop.style.color = color;
  S.splitPopT = 3;
}

/* ------------------------------------------------------------ rendering */

let lastNow = performance.now();
let accumulator = 0;
let hudFrame = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;

  if (S.state === "countdown") {
    updateCountdown(dt);
  } else if (S.state === "running") {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= DT && steps < 10 && S.state === "running") {
      tick();
      accumulator -= DT;
      steps++;
    }
    if (steps >= 10) accumulator = 0;   // tab was hidden; drop time
  }

  updateHud(dt);
  updateCamera(dt);

  const car = S.car;
  S.world.updateCar(car, car.steer, dt);
  if (S.state === "running" && S.settings.ghost && S.pbGhost) {
    S.world.updateGhost(ghostPose(S.pbGhost, S.ticks / 120), dt);
  } else {
    S.world.updateGhost(null, dt);
  }
  S.world.updateParticles(dt, S.camPos);
  audio.update(car, S.stage, dt);
  S.renderer.render(S.world.scene, S.camera);
}

function updateCountdown(dt) {
  S.countdownT += dt;
  const stepIdx = Math.floor(S.countdownT / 0.68);
  if (stepIdx !== S.countdownStep) {
    S.countdownStep = stepIdx;
    if (stepIdx < 3) {
      els.centerMsg.innerHTML = "<div class='big'>" + (3 - stepIdx) + "</div>";
      audio.beep(false);
    } else {
      els.centerMsg.innerHTML = "<div class='big' style='color:#8ce8a8'>GO</div>";
      audio.beep(true);
      S.state = "running";
      accumulator = 0;
      setTimeout(() => { if (S.state === "running") els.centerMsg.innerHTML = ""; }, 900);
    }
  }
}

function updateHud(dt) {
  if (S.state !== "running" && S.state !== "countdown" && S.state !== "finished") return;
  hudFrame++;
  const car = S.car;
  const t = S.state === "finished" && S.finishTime != null ? S.finishTime : S.ticks / 120;
  els.timer.textContent = fmtTime(t);
  els.speed.textContent = Math.round(Math.abs(car.vx) * 3.6);
  els.gear.textContent = car.vx < -0.5 ? "R" : car.gear;

  // live delta vs PB
  if (S.state === "running" && S.pbGhost && car.s > 30) {
    const gt = ghostTimeAt(S.pbGhost, car.s);
    if (gt != null) {
      const target = t - gt;
      S.deltaShown = S.deltaShown == null ? target : S.deltaShown + (target - S.deltaShown) * Math.min(1, dt * 6);
      els.delta.textContent = fmtDelta(S.deltaShown);
      els.delta.className = S.deltaShown <= 0 ? "ahead" : "behind";
    }
  } else if (S.state !== "running") {
    els.delta.textContent = "";
  }

  // pace note chips (10 Hz is plenty)
  if (hudFrame % 6 === 0 && S.state === "running") {
    const ups = S.codriver.upcoming(car, 3);
    let html = "";
    for (let i = 0; i < ups.length; i++) {
      const { note, dist } = ups[i];
      const col = sevColor(note.sev != null && note.kind === "corner" ? note.sev : note.kind === "jump" ? 2 : 5);
      let mods = "";
      if (note.kind === "corner") {
        const bits = [];
        if (note.label.indexOf("long") >= 0) bits.push("long");
        if (note.label.indexOf("tightens") >= 0) bits.push("tightens");
        if (note.label.indexOf("opens") >= 0) bits.push("opens");
        if (note.label.indexOf("don't cut") >= 0) bits.push("don't cut");
        if (note.label.indexOf("cut") >= 0 && note.label.indexOf("don't") < 0) bits.push("cut ok");
        if (note.label.indexOf("off camber") >= 0) bits.push("off-camber");
        if (note.label.indexOf("crest") >= 0) bits.push("over crest");
        if (note.label.indexOf("jump") >= 0) bits.push("jump in");
        mods = bits.join(" · ");
      }
      html += "<div class='chip" + (i === 0 ? " first" : "") + (note.caution ? " caution" : "") + "'>" +
        "<div class='sev' style='color:" + col + "'>" + chipLabel(note) + "</div>" +
        (mods ? "<div class='mods'>" + mods + "</div>" : "") +
        "<div class='m'>" + Math.round(dist) + "m</div></div>";
    }
    els.notesStrip.innerHTML = html;
  }

  // split popup decay
  if (S.splitPopT > 0) {
    S.splitPopT -= dt;
    if (S.splitPopT <= 0) els.splitPop.textContent = "";
  }

  // damage bar - needs the else, or a restart leaves the old fill on screen
  if (car.damage > 12) {
    els.damageBar.style.display = "block";
    els.damageFill.style.width = Math.min(100, car.damage / 2.2) + "%";
  } else {
    els.damageBar.style.display = "none";
  }

  // centre warnings
  if (S.state === "running") {
    if (S.offCourse) {
      els.centerMsg.innerHTML = "<div class='bad'>OFF COURSE</div><div class='sub'>press R to restart</div>";
    } else if (S.wrongWay) {
      els.centerMsg.innerHTML = "<div class='warn'>WRONG WAY</div>";
    } else if (car.crashTimer > 0.4 && Math.abs(car.vx) < 4) {
      els.centerMsg.innerHTML = "<div class='warn'>R — RESTART</div>";
    } else if (car.stuckT > 2.5) {
      els.centerMsg.innerHTML = "<div class='warn'>STUCK? R — RESTART</div>";
    } else if (S.countdownStep >= 3 && S.ticks > 110) {
      // GO message cleared by timeout
    }
    if (!S.offCourse && !S.wrongWay && !(car.crashTimer > 0.4 && Math.abs(car.vx) < 4) && !(car.stuckT > 2.5) && S.ticks > 130) {
      if (els.centerMsg.firstChild && els.centerMsg.firstChild.className !== "big") els.centerMsg.innerHTML = "";
    }
  }
}

/* camera */
const tmpV = new THREE.Vector3();
function placeCameraInstant() {
  const car = S.car;
  const back = 7;
  S.camPos.set(car.x - Math.cos(car.yaw) * back, car.y + 2.8, car.z - Math.sin(car.yaw) * back);
  S.camLook.set(car.x, car.y + 1, car.z);
}

function updateCamera(dt) {
  const car = S.car;
  const v = Math.abs(car.vx);
  const cosY = Math.cos(car.yaw), sinY = Math.sin(car.yaw);
  let desired, look, fov;

  if (S.camMode === 2) {
    // hood
    desired = tmpV.set(car.x + cosY * 0.35, car.y + 1.14, car.z + sinY * 0.35).clone();
    // aim partway up the slope the car is actually sitting on (nose-up +)
    look = new THREE.Vector3(car.x + cosY * 40, car.y + 1.14 + car.pitch * 22, car.z + sinY * 40);
    fov = 70 + Math.min(18, v * 0.22);
    S.camPos.copy(desired);
    S.camLook.lerp(look, Math.min(1, dt * 20));
  } else {
    const far = S.camMode === 1;
    const dist = (far ? 9.8 : 6.4) + v * 0.052;
    const height = (far ? 3.8 : 2.55) + v * 0.012;
    const lead = (far ? 9 : 7) + v * 0.16;
    desired = tmpV.set(car.x - cosY * dist, car.y + height, car.z - sinY * dist);
    // slide visibility: offset opposite to lateral velocity
    const latX = -sinY, latZ = cosY;
    desired.x -= latX * car.vyLat * 0.14;
    desired.z -= latZ * car.vyLat * 0.14;
    const k = 1 - Math.exp(-dt * 5.2);
    S.camPos.lerp(desired, k);
    // never let the camera sink below the ground
    const g = S.stage.groundHeight(S.camPos.x, S.camPos.z, car.s);
    if (g && S.camPos.y < g.y + 1.0) S.camPos.y = g.y + 1.0;
    look = new THREE.Vector3(car.x + cosY * lead * 0.4, car.y + 1.15, car.z + sinY * lead * 0.4);
    S.camLook.lerp(look, 1 - Math.exp(-dt * 7));
    fov = 62 + Math.min(17, (v / 55) * 17);
  }

  // shake: rough zones and landings
  let shakeAmt = 0;
  if (S.state === "running" && !car.airborne) {
    if (car.zone !== "road" && v > 5) shakeAmt = Math.min(0.14, v * 0.004);
    else if (S.stage.surfKey !== "tarmac" && v > 22) shakeAmt = 0.03;
  }
  S.camShake = Math.max(S.camShake * (1 - dt * 5), shakeAmt);
  const sh = S.camShake;
  S.camera.position.set(
    S.camPos.x + (Math.random() - 0.5) * sh,
    S.camPos.y + (Math.random() - 0.5) * sh,
    S.camPos.z + (Math.random() - 0.5) * sh
  );
  S.camera.lookAt(S.camLook);
  S.camera.fov += ((fov || 64) - S.camera.fov) * Math.min(1, dt * 5);
  S.camera.updateProjectionMatrix();
}

/* countdown-to-next-rally ticker */
setInterval(() => {
  if (els.nextIn) els.nextIn.textContent = fmtCountdown(msUntilReset());
}, 1000);

/* expose for automated checks (same idea as DRGame in Daily Rocket) */
window.__RALLY = {
  get car() { return S.car; },
  get stage() { return S.stage; },
  get state() { return S.state; },
  get day() { return S.day; },
  get camera() { return S.camera; },
  get world() { return S.world; },
  THREE,
};

/* off we go */
console.log("Gravl modules v" + (window.__DR_VERSION || "?") + " — main.js loaded");
boot();
