/* Overcrest — input.
 *
 * Keyboard is digital (dir -1/0/1, the physics steering-rate model shapes it);
 * a gamepad stick is analog and takes a different path into the sim: the raw
 * stick value becomes a sigma *target* so the same physics serves both.
 * Poll once per animation frame; the fixed-step sim reads a stable snapshot.
 *
 * Keys belong to the player (Phase 21 / Addendum II): the primary bindings
 * are remappable and ride qs-oc-meta; the arrows and Escape stay hardwired
 * alternates so the defaults sheet never strands anyone mid-rebind. The pad
 * gets an adjustable deadzone and steering curve, and a rumble hook the game
 * fires on landings and impacts — subtle, optional, driving only.
 */

export const DEFAULT_BINDS = Object.freeze({
  throttle: "KeyW", brake: "KeyS", steerL: "KeyA", steerR: "KeyD",
  handbrake: "Space", boost: "ShiftLeft", pause: "KeyP",
});
export const BIND_LABELS = {
  throttle: "Throttle", brake: "Brake / reverse", steerL: "Steer left",
  steerR: "Steer right", handbrake: "Handbrake", boost: "Boost / push", pause: "Pause",
};
/* hardwired alternates — never rebound, never conflicting: the arrows,
 * Escape, and the other Shift */
const ALT = {
  throttle: "ArrowUp", brake: "ArrowDown", steerL: "ArrowLeft",
  steerR: "ArrowRight", pause: "Escape", boost: "ShiftRight",
};

export function makeInput() {
  const keys = new Set();
  const state = {
    dir: 0,            // -1 | 0 | 1 (keyboard)
    steerAnalog: null, // null (keyboard) or -1..1 (pad)
    throttle: 0,
    brake: 0,
    handbrake: false,
    boost: false,
    pausePressed: false,   // edge-triggered, consumed by main
    anyPressed: false,     // "press anything" screens
    padConnected: false,
    hapticsOn: true,
  };

  let binds = Object.assign({}, DEFAULT_BINDS);
  let known = new Set();
  function rebuildKnown() {
    known = new Set([...Object.values(binds), ...Object.values(ALT)]);
  }
  rebuildKnown();

  let padDead = 0.12;
  let padCurve = 1.6;

  function onKey(e, down) {
    if (e.repeat) return;
    const k = e.code;
    // don't eat browser shortcuts or typing in inputs
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (!known.has(k)) return;
    e.preventDefault();
    if (down) {
      if ((k === binds.pause || k === ALT.pause) && !keys.has(k)) state.pausePressed = true;
      keys.add(k);
      state.anyPressed = true;
    } else {
      keys.delete(k);
    }
  }

  window.addEventListener("keydown", (e) => onKey(e, true), { passive: false });
  window.addEventListener("keyup", (e) => onKey(e, false), { passive: false });
  window.addEventListener("blur", () => keys.clear());

  function axis(v) {
    const a = Math.abs(v) < padDead ? 0 : (v - Math.sign(v) * padDead) / (1 - padDead);
    // gentle curve: precision near centre, full authority at the stops
    return Math.sign(a) * Math.pow(Math.abs(a), padCurve);
  }

  const isDown = (action) => keys.has(binds[action]) || (ALT[action] && keys.has(ALT[action]));

  /* call once per rAF before stepping the sim */
  function poll() {
    // ---- keyboard
    const L = isDown("steerL");
    const R = isDown("steerR");
    state.dir = L === R ? 0 : R ? 1 : -1;   // D / → turns screen-right (dir=+1)
    state.throttle = isDown("throttle") ? 1 : 0;
    state.brake = isDown("brake") ? 1 : 0;
    state.handbrake = isDown("handbrake");
    state.boost = isDown("boost");
    state.steerAnalog = null;

    // ---- gamepad overrides when active
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    state.padConnected = !!pad;
    if (pad) {
      const sx = axis(pad.axes[0] || 0);
      const rt = pad.buttons[7] ? pad.buttons[7].value : 0;   // right trigger
      const lt = pad.buttons[6] ? pad.buttons[6].value : 0;   // left trigger
      const aBtn = pad.buttons[0] && pad.buttons[0].pressed;  // A: handbrake
      const xBtn = pad.buttons[2] && pad.buttons[2].pressed;  // X: handbrake too
      const rb = pad.buttons[5] && pad.buttons[5].pressed;    // RB: boost
      const start = pad.buttons[9] && pad.buttons[9].pressed;

      if (Math.abs(sx) > 0.001) { state.steerAnalog = sx; state.dir = sx > 0 ? 1 : -1; }
      else if (state.dir === 0) state.steerAnalog = 0;
      if (rt > 0.02) state.throttle = Math.max(state.throttle, rt);
      if (lt > 0.02) state.brake = Math.max(state.brake, lt);
      if (aBtn || xBtn) state.handbrake = true;
      if (rb) state.boost = true;
      if (start && !state._startHeld) state.pausePressed = true;
      state._startHeld = start;
      if (state.throttle > 0.1 || state.handbrake) state.anyPressed = true;
    }
    return state;
  }

  /* Replace the primary bindings (partial map is fine; unknown actions are
   * ignored, missing ones keep their defaults). Conflict policy lives in
   * the UI — this just installs what it was handed. */
  function setBinds(map) {
    binds = Object.assign({}, DEFAULT_BINDS);
    for (const k in map || {}) if (k in DEFAULT_BINDS && typeof map[k] === "string") binds[k] = map[k];
    rebuildKnown();
    keys.clear();          // no key may stay latched across a remap
    return Object.assign({}, binds);
  }
  function getBinds() { return Object.assign({}, binds); }

  /* pad feel: deadzone 0.05–0.3, steering curve exponent 1.0 (sharp) to
   * 2.4 (gentle centre); the physics path is unchanged either way */
  function setPad(opts) {
    if (opts && typeof opts.dead === "number") padDead = Math.max(0.02, Math.min(0.35, opts.dead));
    if (opts && typeof opts.curve === "number") padCurve = Math.max(1.0, Math.min(2.6, opts.curve));
  }
  function setHaptics(on) { state.hapticsOn = !!on; }

  /* one shot of rumble on whatever pad is driving — no-op without support,
   * without a pad, or with haptics off. Magnitudes 0..1, duration ms. */
  function rumble(strong, weak, ms) {
    if (!state.hapticsOn || !state.padConnected) return;
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const p of pads) {
        if (!p || !p.connected || !p.vibrationActuator || !p.vibrationActuator.playEffect) continue;
        p.vibrationActuator.playEffect("dual-rumble", {
          duration: Math.max(10, Math.min(400, ms || 80)),
          strongMagnitude: Math.max(0, Math.min(1, strong || 0)),
          weakMagnitude: Math.max(0, Math.min(1, weak || 0)),
        });
        break;
      }
    } catch (e) { /* haptics are a courtesy, never an error */ }
  }

  function consumePause() {
    const p = state.pausePressed;
    state.pausePressed = false;
    return p;
  }
  function consumeAny() {
    const p = state.anyPressed;
    state.anyPressed = false;
    return p;
  }

  return { poll, state, consumePause, consumeAny, setBinds, getBinds, setPad, setHaptics, rumble };
}
