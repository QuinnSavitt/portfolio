/* Overcrest — settings and the pause sheet.
 *
 * A handful of choices that matter for long sessions: how early the
 * codriver speaks, whether they speak at all, sound, camera motion, and a
 * zen HUD. Persisted in qs-oc-meta.settings and applied through one
 * `apply(settings)` callback so game systems never read the DOM.
 *
 * Keys belong to the player (Phase 21): the primary bindings live in
 * qs-oc-meta.keybinds and are edited right here in the sheet — click a
 * key, press the new one. Conflicts are refused, the arrows and Escape
 * stay hardwired alternates, and one button puts everything back.
 */

import { loadMeta, saveMeta } from "../game/save.js";
import { DEFAULT_BINDS, BIND_LABELS } from "../core/input.js";

export const DEFAULT_SETTINGS = {
  timing: "normal", voice: "on", sound: "on", music: "on", motion: "full", hud: "everything",
  // assists: named plainly, offered in the same sheet as everything else,
  // no score penalty — the bible is firm that help carries no stigma
  stabiliser: "standard", brakehelp: "off", traction: "off",
  hudSize: "normal",
  subSize: "normal", colour: "standard",
  /* one quality dial rules the whole picture (main.js QUALITY): render
   * scale, MSAA, terrain detail, draw distance, the far shell, clouds,
   * dust and the sky's night detail all move together. "auto" measures
   * the machine and steps the ladder both ways; the fixed tiers are for
   * a player who knows better. (The old res/fx/terrain/draw/particles
   * keys fold into this — stale saved copies are simply ignored.) */
  quality: "auto",
  // the dash clock: waystations always show the time; "always" keeps it up
  clock: "ws",
  volMaster: 1, volVoice: 1, volMusic: 1,
  // Phase 21: verbosity, camera comfort, and the pad's feel
  verbosity: "full", camDist: "standard", fovCap: "off",
  camCuts: "on",      // the cinematic cuts (camera.js): trackside, brow, reveal, border, roll
  padDead: 0.12, padCurve: 1.6, haptics: "on",
};

export function loadSettings() {
  const m = loadMeta();
  return Object.assign({}, DEFAULT_SETTINGS, m.settings || {});
}
export function storeSettings(s) {
  const m = loadMeta();
  m.settings = s;
  saveMeta(m);
}

export function loadBinds() {
  const m = loadMeta();
  return Object.assign({}, DEFAULT_BINDS, m.keybinds || {});
}
export function storeBinds(b) {
  const m = loadMeta();
  m.keybinds = b;
  saveMeta(m);
}

/* a KeyboardEvent.code, shown the way a keycap reads */
function keyLabel(code) {
  if (!code) return "none";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const MAP = {
    Space: "Space", ShiftLeft: "L-Shift", ShiftRight: "R-Shift",
    ControlLeft: "L-Ctrl", ControlRight: "R-Ctrl", AltLeft: "L-Alt", AltRight: "R-Alt",
    Tab: "Tab", Backquote: "`", Minus: "-", Equal: "=", Semicolon: ";", Quote: "'",
    Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Enter: "Enter",
  };
  return MAP[code] || code;
}

export function makePauseUI(apply, onBinds) {
  const el = document.getElementById("pause");
  const settings = loadSettings();
  const segs = el.querySelectorAll(".seg");

  function paint() {
    segs.forEach((seg) => {
      const key = seg.dataset.set;
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === settings[key]));
    });
    el.querySelectorAll("input.rng").forEach((r) => { r.value = settings[r.dataset.set]; });
  }
  segs.forEach((seg) => {
    const key = seg.dataset.set;
    seg.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        settings[key] = b.dataset.v;
        storeSettings(settings);
        paint();
        apply(settings);
      });
    });
  });
  // sliders: volumes and anything else continuous
  el.querySelectorAll("input.rng").forEach((r) => {
    r.addEventListener("input", () => {
      settings[r.dataset.set] = parseFloat(r.value);
      storeSettings(settings);
      apply(settings);
    });
  });
  paint();
  apply(settings);

  /* ------------------------------------------------------- key rebinding */
  const kbEl = document.getElementById("keybinds");
  let binds = loadBinds();
  let listening = null;   // action currently capturing, or null

  function paintBinds() {
    if (!kbEl) return;
    kbEl.innerHTML = Object.keys(DEFAULT_BINDS).map((a) =>
      `<span class="kbrow">${BIND_LABELS[a]}<button class="kb${listening === a ? " listening" : ""}" data-a="${a}">` +
      `${listening === a ? "press a key…" : keyLabel(binds[a])}</button></span>`
    ).join("") + `<span class="kbrow"><button class="kb kb-reset" data-a="__reset">Reset keys</button></span>`;
  }
  function commitBinds() {
    storeBinds(binds);
    if (onBinds) onBinds(Object.assign({}, binds));
    paintBinds();
  }
  if (kbEl) {
    kbEl.addEventListener("click", (e) => {
      const b = e.target.closest("button.kb");
      if (!b) return;
      if (b.dataset.a === "__reset") { binds = Object.assign({}, DEFAULT_BINDS); listening = null; commitBinds(); return; }
      listening = listening === b.dataset.a ? null : b.dataset.a;
      paintBinds();
    });
    window.addEventListener("keydown", (e) => {
      if (!listening || !el.classList.contains("on")) return;
      e.preventDefault();
      e.stopPropagation();
      const code = e.code;
      if (code === "Escape") { listening = null; paintBinds(); return; }
      // the hardwired alternates are reserved — they must keep working
      if (code.startsWith("Arrow")) { flash("arrows are reserved"); return; }
      // conflicts refused: a key can serve one action only
      const takenBy = Object.keys(binds).find((a) => a !== listening && binds[a] === code);
      if (takenBy) { flash("already " + BIND_LABELS[takenBy].toLowerCase()); return; }
      binds[listening] = code;
      listening = null;
      commitBinds();
    }, true);   // capture: the game's own key handler must not see this press
  }
  function flash(text) {
    const b = kbEl && kbEl.querySelector("button.listening");
    if (!b) return;
    b.textContent = text;
    setTimeout(() => { if (listening) paintBinds(); }, 900);
  }
  paintBinds();
  if (onBinds) onBinds(Object.assign({}, binds));   // boot: install the stored keys

  /* ------------------------------------------------------------- tabs */
  const tabs = el.querySelectorAll("#setTabs button");
  const groups = el.querySelectorAll(".set-group");
  function showTab(name) {
    tabs.forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    groups.forEach((g) => g.classList.toggle("on", g.dataset.tab === name));
    if (name !== "controls" && listening) { listening = null; paintBinds(); }
  }
  tabs.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  // Q / E step through the tabs while the sheet is up (the pad's bumpers map to them)
  window.addEventListener("keydown", (e) => {
    if (!el.classList.contains("on") || listening) return;
    if (e.code !== "KeyQ" && e.code !== "KeyE") return;
    const names = [...tabs].map((b) => b.dataset.tab);
    const at = names.findIndex((n) => el.querySelector(`#setTabs button[data-tab="${n}"]`).classList.contains("on"));
    showTab(names[(at + (e.code === "KeyE" ? 1 : names.length - 1)) % names.length]);
    e.preventDefault();
  });

  const onResume = [], onQuit = [];
  document.getElementById("btnResumeGame").addEventListener("click", () => { hide(); onResume.forEach((f) => f()); });
  document.getElementById("btnQuit").addEventListener("click", () => { hide(); onQuit.forEach((f) => f()); });

  function show() { el.classList.add("on"); }
  function hide() { el.classList.remove("on"); listening = null; paintBinds(); }
  return { show, hide, settings, onResume: (f) => onResume.push(f), onQuit: (f) => onQuit.push(f), isOpen: () => el.classList.contains("on") };
}
