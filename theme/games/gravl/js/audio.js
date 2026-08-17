/* Gravl — synthesized audio.
 *
 * Everything is generated in WebAudio: no samples, no downloads. The engine
 * is a pair of detuned oscillators tracking RPM through a soft waveshaper,
 * the turbo is a rising whine with a blow-off burst, surfaces are filtered
 * noise beds, and the co-driver speaks through the Web Speech API.
 */

const state = {
  ctx: null,
  master: null,
  muted: false,
  voiceMuted: false,
  engine: null,
  beds: null,
  voice: null,
  speaking: 0,
};

function makeNoiseBuffer(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

export function init() {
  if (state.ctx) { if (state.ctx.state === "suspended") state.ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ctx = new AC();
  state.ctx = ctx;

  const master = ctx.createGain();
  master.gain.value = state.muted ? 0 : 0.85;
  master.connect(ctx.destination);
  state.master = master;

  // ---------------- engine
  const engGain = ctx.createGain(); engGain.gain.value = 0;
  const shaper = ctx.createWaveShaper();
  {
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    shaper.curve = curve;
  }
  const engFilter = ctx.createBiquadFilter();
  engFilter.type = "lowpass"; engFilter.frequency.value = 900; engFilter.Q.value = 1.2;

  const osc1 = ctx.createOscillator(); osc1.type = "sawtooth";
  const osc2 = ctx.createOscillator(); osc2.type = "square";
  const osc1g = ctx.createGain(); osc1g.gain.value = 0.6;
  const osc2g = ctx.createGain(); osc2g.gain.value = 0.34;
  osc1.connect(osc1g).connect(shaper);
  osc2.connect(osc2g).connect(shaper);
  shaper.connect(engFilter).connect(engGain).connect(master);
  osc1.start(); osc2.start();

  // turbo whine
  const turbo = ctx.createOscillator(); turbo.type = "sine";
  const turboG = ctx.createGain(); turboG.gain.value = 0;
  turbo.connect(turboG).connect(master);
  turbo.start();

  state.engine = { osc1, osc2, engGain, engFilter, turbo, turboG, lastThrottle: 0, rpmS: 1100 };

  // ---------------- noise beds: roll, skid, wind
  const noiseBuf = makeNoiseBuffer(ctx, 2);
  function bed(filterType, freq, q) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType; f.frequency.value = freq; f.Q.value = q || 0.8;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f).connect(g).connect(master);
    src.start();
    return { src, f, g };
  }
  state.beds = {
    roll: bed("lowpass", 320, 0.6),      // gravel / snow rumble
    skid: bed("bandpass", 900, 1.6),     // slides
    wind: bed("bandpass", 1900, 0.4),    // speed air
  };
  state.noiseBuf = noiseBuf;
}

export function setMuted(m) {
  state.muted = m;
  if (state.master) state.master.gain.value = m ? 0 : 0.85;
  if (m) window.speechSynthesis && window.speechSynthesis.cancel();
}
export function isMuted() { return state.muted; }
export function setVoiceMuted(m) {
  state.voiceMuted = m;
  if (m && window.speechSynthesis) window.speechSynthesis.cancel();
}
export function isVoiceMuted() { return state.voiceMuted; }

/* per-frame engine + surface update */
export function update(car, stage, dt) {
  if (!state.ctx || state.muted) return;
  const e = state.engine;
  const now = state.ctx.currentTime;

  // rpm smoothing for audio only
  e.rpmS += (car.rpm - e.rpmS) * Math.min(1, dt * 14);
  const fire = (e.rpmS / 60) * 2;     // 4-cyl firing frequency
  e.osc1.frequency.setTargetAtTime(fire, now, 0.02);
  e.osc2.frequency.setTargetAtTime(fire * 0.5, now, 0.02);
  const load = 0.35 + car.throttle * 0.65;
  const vol = Math.min(0.5, 0.16 + (e.rpmS / 7400) * 0.26) * load;
  e.engGain.gain.setTargetAtTime(vol, now, 0.05);
  e.engFilter.frequency.setTargetAtTime(500 + (e.rpmS / 7400) * 2600 * load, now, 0.06);

  // turbo
  const spool = Math.max(0, (e.rpmS - 2800) / 4600) * (0.3 + car.throttle * 0.7);
  e.turbo.frequency.setTargetAtTime(900 + spool * 2600, now, 0.08);
  e.turboG.gain.setTargetAtTime(spool * 0.045, now, 0.09);
  // blow-off
  if (e.lastThrottle > 0.6 && car.throttle < 0.15 && e.rpmS > 4200) {
    blowOff();
  }
  e.lastThrottle = car.throttle;

  // surface beds
  const speed = Math.abs(car.vx);
  const loose = stage.surfKey === "gravel" || stage.surfKey === "gravelWet" || stage.surfKey === "dirt" || stage.surfKey === "snow";
  const onRoad = car.zone === "road" || car.zone === "shoulder";
  let rollAmt = 0;
  if (speed > 2) {
    if (!onRoad) rollAmt = Math.min(0.4, speed * 0.012);
    else if (loose) rollAmt = Math.min(0.3, speed * 0.008);
    else rollAmt = Math.min(0.1, speed * 0.002);
  }
  if (car.airborne) rollAmt = 0;
  state.beds.roll.g.gain.setTargetAtTime(rollAmt, now, 0.08);
  state.beds.roll.f.frequency.setTargetAtTime(onRoad ? 320 : 210, now, 0.1);

  const skidAmt = car.airborne ? 0 : Math.min(0.32, Math.max(0, car.skid - 0.25) * 0.5 * Math.min(1, speed / 8));
  state.beds.skid.g.gain.setTargetAtTime(skidAmt, now, 0.05);
  const tarmac = stage.surfKey.indexOf("tarmac") === 0;
  state.beds.skid.f.frequency.setTargetAtTime(tarmac ? 1600 : 700, now, 0.08);

  state.beds.wind.g.gain.setTargetAtTime(Math.min(0.16, (speed / 55) * (speed / 55) * 0.16), now, 0.12);
}

function burst(freq, q, gain, dur, type) {
  if (!state.ctx || state.muted) return;
  const ctx = state.ctx;
  const src = ctx.createBufferSource();
  src.buffer = state.noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type || "bandpass"; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  const now = ctx.currentTime;
  g.gain.setValueAtTime(gain, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + dur);
  src.connect(f).connect(g).connect(state.master);
  src.start(now, Math.random());
  src.stop(now + dur + 0.05);
}

export function blowOff() { burst(2400, 2.5, 0.12, 0.3); }
export function impact(strength) {
  const s = Math.min(1, strength / 14);
  burst(160, 0.8, 0.25 + s * 0.4, 0.22 + s * 0.2, "lowpass");
  burst(900, 1.2, 0.1 + s * 0.25, 0.12);
  tone(70 + s * 30, 0.24, 0.25 + s * 0.3, "sine");
}
export function landing(strength) {
  const s = Math.min(1, strength / 10);
  burst(240, 1, 0.12 + s * 0.3, 0.18, "lowpass");
}

function tone(freq, dur, gain, type, when, endFreq) {
  if (!state.ctx || state.muted) return;
  const ctx = state.ctx;
  const o = ctx.createOscillator();
  o.type = type || "sine";
  const t0 = ctx.currentTime + (when || 0);
  o.frequency.setValueAtTime(freq, t0);
  if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g).connect(state.master);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

export function beep(final) {
  tone(final ? 880 : 440, final ? 0.5 : 0.14, 0.22, "square");
}
export function splitChime(ahead) {
  tone(ahead ? 740 : 500, 0.1, 0.16, "sine");
  tone(ahead ? 990 : 420, 0.14, 0.14, "sine", 0.09);
}
export function finishFanfare() {
  tone(523, 0.12, 0.2, "square");
  tone(659, 0.12, 0.2, "square", 0.11);
  tone(784, 0.12, 0.2, "square", 0.22);
  tone(1047, 0.4, 0.22, "square", 0.33);
}
export function crashThud() { impact(14); }

/* ------------------------------------------------------------ co-driver */

let voicePick;
function pickVoice() {
  if (voicePick !== undefined) return voicePick;
  const synth = window.speechSynthesis;
  if (!synth) { voicePick = null; return null; }
  const voices = synth.getVoices();
  const prefer = ["Google UK English Male", "Daniel", "Google UK English Female", "Microsoft George", "Microsoft Ryan"];
  for (const name of prefer) {
    const v = voices.find((vv) => vv.name.indexOf(name) >= 0);
    if (v) { voicePick = v; return v; }
  }
  voicePick = voices.find((v) => v.lang && v.lang.indexOf("en") === 0) || null;
  return voicePick;
}
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => { voicePick = undefined; };
}

export function speak(text, urgent) {
  const synth = window.speechSynthesis;
  if (!synth || state.voiceMuted || state.muted) return;
  // never build a backlog: a late call is a useless call
  if (state.speaking >= 2 || (urgent && state.speaking > 0)) synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = 1.32;
  u.pitch = 0.95;
  u.volume = 0.95;
  state.speaking++;
  u.onend = () => { state.speaking = Math.max(0, state.speaking - 1); };
  u.onerror = () => { state.speaking = Math.max(0, state.speaking - 1); };
  synth.speak(u);
}

export function stopSpeech() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  state.speaking = 0;
}
