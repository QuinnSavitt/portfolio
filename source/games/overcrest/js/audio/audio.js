/* Overcrest — audio. Entirely synthesized in WebAudio; nothing downloaded.
 *
 * The engine is a pulse-pair at firing frequency driven through a peaking
 * "airbox" resonance and a throttle-controlled exhaust lowpass; the turbo
 * is its own voice (whistle + flutter on lift). Gravel is the signature
 * sound of the game: a crackle bed (bandpassed noise, amplitude-modulated
 * by wheel speed) over a low rumble, scaled by surface roughness. Wind
 * rises with the square of speed. Impacts, landings and shifts are
 * one-shot noise/tone bursts.
 */

import { makeMusic } from "./music.js";
export { ambiencePlan } from "./ambience.js";

const A = {
  ctx: null, master: null, muted: false,
  engine: null, beds: null, noiseBuf: null,
  speaking: 0, voiceMuted: false,
  music: null, musicMuted: false,
};

function makeNoise(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let brown = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    brown = (brown + 0.02 * w) / 1.02;
    d[i] = w * 0.6 + brown * 2.4;    // white + brown mix: crunchy and full
  }
  return buf;
}

export function initAudio() {
  if (A.ctx) { if (A.ctx.state === "suspended") A.ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ctx = (A.ctx = new AC());
  const master = (A.master = ctx.createGain());
  master.gain.value = A.muted ? 0 : 0.8;
  /* The output stage, in three parts. A bus compressor leans on the mix
   * gently when a lot happens at once (engine + gravel + music + thunder +
   * an impact); a fast limiter catches what is left; a soft clipper means
   * the DAC never sees a hard edge. The old single 12:1 limiter with a
   * 2 ms attack did all of that alone and, slammed, pumped and tore
   * (owner: "the sound overloads and causes a terrible ringing"). A
   * watchdog in updateAudio flushes the tunnel combs if the limiter is
   * ever pinned — they are the only feedback paths in the graph. */
  const busComp = (A.busComp = ctx.createDynamicsCompressor());
  busComp.threshold.value = -16; busComp.knee.value = 14;
  busComp.ratio.value = 3; busComp.attack.value = 0.012; busComp.release.value = 0.28;
  const limiter = (A.limiter = ctx.createDynamicsCompressor());
  limiter.threshold.value = -4; limiter.knee.value = 1.5;
  limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.12;
  const clip = ctx.createWaveShaper();
  {
    const N = 513, curve = new Float32Array(N);
    for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * 2 - 1; curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6); }
    clip.curve = curve; clip.oversample = "2x";
  }
  master.connect(busComp).connect(limiter).connect(clip).connect(ctx.destination);
  A.pinnedT = 0;
  A.noiseBuf = makeNoise(ctx, 2.2);

  /* ---------------- the space the car is in
   *
   * Outdoors there is nothing for the engine to bounce off, so the whole
   * game is dry. A tunnel is the one place with walls, and it is worth a
   * real send rather than a filter trick: two short feedback delays with
   * the top rolled off, fed from the engine and the road bed. Wet level
   * follows how deep in the bore the car is, so the reverb arrives at the
   * portal and leaves at the far end. */
  const spaceIn = (A.spaceIn = ctx.createGain());
  spaceIn.gain.value = 0;
  const spWet = ctx.createGain(); spWet.gain.value = 0.9;
  /* Two INDEPENDENT combs — each delay feeds only itself through its own
   * damp filter. The original shared one feedback across both delays, so
   * wherever the two paths phase-aligned (every ~29 Hz) the loop gain hit
   * 0.46 × 2 = 0.92: a 12× steady-state resonance on aligned engine
   * harmonics. Revving in the bore pumped those lines until the master
   * clipped — the "incredible, then a squeal" bug. Independent combs make
   * the worst-case loop gain the fb value itself, provably < 1, and 0.64
   * keeps a ~1 s bore tail (−3.9 dB per trip). */
  const comb = (dt) => {
    const d = ctx.createDelay(0.5); d.delayTime.value = dt;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 2100; lp.Q.value = 0.4;
    const fb = ctx.createGain(); fb.gain.value = 0.64;
    d.connect(lp); lp.connect(fb); fb.connect(d);
    spaceIn.connect(d);
    lp.connect(spWet);
    (A.combFb || (A.combFb = [])).push(fb);
  };
  comb(0.047); comb(0.081);
  /* soft-saturate the wet return: whatever still swells in there rounds
   * off instead of screaming (tanh, wet path only — the dry car is
   * untouched) */
  const spSat = ctx.createWaveShaper();
  {
    const N = 257, curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 1.4) / Math.tanh(1.4);
    }
    spSat.curve = curve; spSat.oversample = "2x";
  }
  spWet.connect(spSat).connect(master);

  // ---------------- engine voice
  const eng = {};
  eng.gain = ctx.createGain(); eng.gain.gain.value = 0;

  eng.oscA = ctx.createOscillator(); eng.oscA.type = "square";
  eng.oscB = ctx.createOscillator(); eng.oscB.type = "sawtooth";
  eng.gA = ctx.createGain(); eng.gA.gain.value = 0.5;
  eng.gB = ctx.createGain(); eng.gB.gain.value = 0.42;

  // airbox resonance: a peaking filter that gives the engine a chest
  eng.airbox = ctx.createBiquadFilter();
  eng.airbox.type = "peaking"; eng.airbox.frequency.value = 420;
  eng.airbox.Q.value = 1.6; eng.airbox.gain.value = 7;

  // exhaust: lowpass that opens with throttle
  eng.exhaust = ctx.createBiquadFilter();
  eng.exhaust.type = "lowpass"; eng.exhaust.frequency.value = 700; eng.exhaust.Q.value = 0.9;

  eng.oscA.connect(eng.gA).connect(eng.airbox);
  eng.oscB.connect(eng.gB).connect(eng.airbox);
  eng.airbox.connect(eng.exhaust).connect(eng.gain).connect(master);
  eng.gain.connect(A.spaceIn);
  eng.oscA.start(); eng.oscB.start();

  // turbo voice
  eng.turbo = ctx.createOscillator(); eng.turbo.type = "triangle";
  eng.turboG = ctx.createGain(); eng.turboG.gain.value = 0;
  eng.turbo.connect(eng.turboG).connect(master);
  eng.turbo.start();

  eng.rpmS = 1000;
  A.engine = eng;

  // ---------------- surface & wind beds
  function bed(type, freq, q) {
    const src = ctx.createBufferSource();
    src.buffer = A.noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f).connect(g).connect(master);
    g.connect(A.spaceIn);
    src.start(0, Math.random() * 2);
    return { src, f, g };
  }
  A.beds = {
    rumble: bed("lowpass", 240, 0.5),        // low ground roar
    crackle: bed("bandpass", 2400, 0.7),     // gravel spatter
    skid: bed("bandpass", 950, 1.8),         // slides
    wind: bed("highpass", 1500, 0.3),
    rattle: bed("bandpass", 1500, 3),        // loose panels: damage speaks
    brush: bed("bandpass", 640, 1.1),        // vegetation swishing the sills
    spray: bed("bandpass", 1600, 0.8),       // water off the wheels (fords, mud)
  };
  // crackle AM: an LFO chops the spatter so it reads as stones, not steam
  A.crackleLFO = ctx.createOscillator();
  A.crackleLFO.type = "square";
  A.crackleLFO.frequency.value = 28;
  A.crackleDepth = ctx.createGain(); A.crackleDepth.gain.value = 0;
  A.crackleLFO.connect(A.crackleDepth).connect(A.beds.crackle.g.gain);
  A.crackleLFO.start();

  // transmission: gear-mesh whine, mostly heard on the overrun
  eng.trans = ctx.createOscillator(); eng.trans.type = "triangle";
  eng.transG = ctx.createGain(); eng.transG.gain.value = 0;
  const transHP = ctx.createBiquadFilter();
  transHP.type = "highpass"; transHP.frequency.value = 900; transHP.Q.value = 0.5;
  eng.trans.connect(transHP).connect(eng.transG).connect(master);
  eng.trans.start();

  /* ---------------- the country, when the engine goes quiet
   *
   * Ambience is the place's voice: wind that gusts on the tops (and sings
   * a thin whistle over snow), the sea under a cliff road, leaves moving
   * in forest country, birdsong and gulls and the moor's curlew, crickets
   * on a warm dusk and cicadas on a hot noon, owls and lake ice in the
   * night, rain — and rain on the waystation's metal roof. Beds off the
   * shared noise buffer; one-shot calls are small synth recipes thrown to
   * one side of the stereo field or the other. The per-frame gains arrive
   * from ambiencePlan (pure, harness-tested); main feeds it the country,
   * the clock and the weather. Ambience belongs to slow moments: the plan
   * ducks it under speed and silences the outside world in a bore — where
   * the bore's own voice (drips into the reverb) takes over. */
  const ambBed = (type, freq, q) => bed(type, freq, q);
  A.amb = {
    wind: ambBed("lowpass", 420, 0.4),
    whistle: ambBed("bandpass", 2400, 9),    // cold wind through the poles
    sea: ambBed("lowpass", 300, 0.6),
    forest: ambBed("bandpass", 1050, 0.8),   // leaves, when the wind moves
    cricket: ambBed("bandpass", 4300, 8),
    cicada: ambBed("bandpass", 5600, 8),
    rain: ambBed("bandpass", 5200, 0.5),
  };
  // insect AM: the fast tick pattern that makes noise read as insects —
  // crickets slow and dusky, cicadas fast and metallic
  A.cricketLFO = ctx.createOscillator();
  A.cricketLFO.type = "square";
  A.cricketLFO.frequency.value = 19;
  A.cricketDepth = ctx.createGain(); A.cricketDepth.gain.value = 0;
  A.cricketLFO.connect(A.cricketDepth).connect(A.amb.cricket.g.gain);
  A.cricketLFO.start();
  A.cicadaLFO = ctx.createOscillator();
  A.cicadaLFO.type = "square";
  A.cicadaLFO.frequency.value = 26;
  A.cicadaDepth = ctx.createGain(); A.cicadaDepth.gain.value = 0;
  A.cicadaLFO.connect(A.cicadaDepth).connect(A.amb.cicada.g.gain);
  A.cicadaLFO.start();
  /* a small bank of fixed panners: every ambient one-shot lands somewhere
   * in the field, not in the middle of your head. Fixed nodes, no leak. */
  A.pan = [];
  if (ctx.createStereoPanner) {
    for (const p of [-0.7, -0.25, 0.25, 0.7]) {
      const n = ctx.createStereoPanner();
      n.pan.value = p;
      n.connect(master);
      A.pan.push(n);
    }
  }
  A.ambT = 0; A.oneT = {}; A.roofT = 0; A.bumpT = 0;

  // the workshop: a compressor idling two rooms away, only ever at a stop
  A.hum = ctx.createOscillator(); A.hum.type = "sawtooth"; A.hum.frequency.value = 62;
  const humLP = ctx.createBiquadFilter();
  humLP.type = "lowpass"; humLP.frequency.value = 150; humLP.Q.value = 0.7;
  A.humG = ctx.createGain(); A.humG.gain.value = 0;
  A.hum.connect(humLP).connect(A.humG).connect(master);
  A.humLFO = ctx.createOscillator(); A.humLFO.type = "sine"; A.humLFO.frequency.value = 6.3;
  A.humDepth = ctx.createGain(); A.humDepth.gain.value = 0;
  A.humLFO.connect(A.humDepth).connect(A.humG.gain);
  A.hum.start(); A.humLFO.start();
}

export function setMuted(m) {
  A.muted = m;
  if (A.master) A.master.gain.value = m ? 0 : 0.8 * (A.masterVol != null ? A.masterVol : 1);
  if (A.music) A.music.setMuted(m || A.musicMuted);
  if (m && window.speechSynthesis) window.speechSynthesis.cancel();
}
export function isMuted() { return A.muted; }

/* Volumes: three sliders, applied where each voice actually lives. */
export function setVolumes(v) {
  if (v.master != null) A.masterVol = v.master;
  if (v.voice != null) A.voiceVol = v.voice;
  if (v.music != null) A.musicVol = v.music;
  if (A.master && !A.muted) A.master.gain.value = 0.8 * (A.masterVol != null ? A.masterVol : 1);
  if (A.music && A.music.setLevel) A.music.setLevel(A.musicVol != null ? A.musicVol : 1);
}

/* music ----------------------------------------------------------------- */

/* Created once, reseeded per run — a journey keeps its melody. */
export function musicInit(seed) {
  if (!A.ctx) return;
  if (!A.music) A.music = makeMusic(A.ctx, A.master, seed);
  else A.music.reseed(seed);
  A.music.setMuted(A.muted || A.musicMuted);
  if (A.music.setLevel) A.music.setLevel(A.musicVol != null ? A.musicVol : 1);
}
export function setMusicMuted(m) {
  A.musicMuted = m;
  if (A.music) A.music.setMuted(m || A.muted);
}
export function musicUpdate(dt, st) {
  if (A.music) A.music.update(dt, st);
}
/* the run's events, handed to the arranger — it lands them on the grid */
export function musicCue(name, data) {
  if (A.music && A.music.cue) A.music.cue(name, data);
}
/* the live peek (window.oc.music()): is the context running, is the
 * arranger alive, what section, how loud each layer is right now */
export function musicDebug() {
  const M = A.music ? A.music.state() : null;
  return {
    ctx: A.ctx ? A.ctx.state : "none", time: A.ctx ? Math.round(A.ctx.currentTime * 10) / 10 : 0,
    muted: A.muted, musicMuted: A.musicMuted, vol: A.musicVol == null ? 1 : A.musicVol,
    arranger: !!M, section: M ? M.section : null, step: M ? M.i : 0, ahead: M ? Math.round((M.t - A.ctx.currentTime) * 100) / 100 : 0,
    tempo: M ? Math.round(M.tempo) : 0, tier: M && M.plan ? M.plan.section : null,
    cur: M ? Object.fromEntries(Object.entries(M.cur).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) : null,
  };
}

/* one-shots ------------------------------------------------------------- */

// no single one-shot may be louder than this: a stacked pair of impacts
// used to arrive at the output stage already past full scale
const ONESHOT_CAP = 0.55;
function burst(freq, q, gain, dur, type, delay, attack, dest) {
  if (!A.ctx || A.muted) return;
  gain = Math.min(ONESHOT_CAP, gain);
  const ctx = A.ctx;
  const src = ctx.createBufferSource();
  src.buffer = A.noiseBuf;
  src.loop = dur + (attack || 0) > 2;   // the noise buffer is 2.2 s; thunder outlives it
  // an inaudible burst is a no-op — and exponential ramps reject a 0 target
  if (!(gain > 0.0015)) return;
  const f = ctx.createBiquadFilter();
  f.type = type || "bandpass"; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  const t0 = ctx.currentTime + (delay || 0);
  if (attack) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  } else {
    g.gain.setValueAtTime(gain, t0);
  }
  g.gain.exponentialRampToValueAtTime(0.001, t0 + (attack || 0) + dur);
  src.connect(f).connect(g).connect(dest || A.master);
  src.start(t0, Math.random() * 1.5);
  src.stop(t0 + (attack || 0) + dur + 0.05);
}

function toneBurst(freq, dur, gain, type, delay, glideTo, dest) {
  if (!A.ctx || A.muted) return;
  gain = Math.min(ONESHOT_CAP, gain);
  if (!(gain > 0.0015)) return;   // silence asked for: skip, don't crash the ramp
  const ctx = A.ctx;
  const o = ctx.createOscillator();
  o.type = type || "sine";
  const t0 = ctx.currentTime + (delay || 0);
  o.frequency.setValueAtTime(freq, t0);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.014);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g).connect(dest || A.master);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

/* A cry: one gliding tone through a filter with its own attack — the
 * shape every distant living thing here is built from. */
function cry(dest, f0, f1, dur, gain, type, delay, filtHz, attack) {
  if (!A.ctx || A.muted || !(gain > 0.0015)) return;
  const ctx = A.ctx;
  const o = ctx.createOscillator();
  o.type = type || "sine";
  const t0 = ctx.currentTime + (delay || 0);
  o.frequency.setValueAtTime(f0, t0);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  const f = ctx.createBiquadFilter();
  f.type = "lowpass"; f.frequency.value = filtHz || 3200; f.Q.value = 0.7;
  const e = ctx.createGain();
  e.gain.setValueAtTime(0.0001, t0);
  e.gain.exponentialRampToValueAtTime(gain, t0 + (attack || 0.02));
  e.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(f).connect(e).connect(dest || A.master);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

/* somewhere to the left or the right of the road, never dead centre */
function ambDest() {
  const P = A.pan;
  return P && P.length ? P[(Math.random() * P.length) | 0] : A.master;
}

export function sfxImpact(strength) {
  const s = Math.min(1, strength / 15);
  burst(140, 0.7, 0.3 + s * 0.4, 0.2 + s * 0.22, "lowpass");
  burst(1100, 1.1, 0.08 + s * 0.22, 0.1);
  toneBurst(64 + s * 26, 0.26, 0.28 + s * 0.3, "sine");
}
export function sfxLanding(strength, damage) {
  const s = Math.min(1, strength / 9);
  burst(230, 0.9, 0.1 + s * 0.3, 0.16, "lowpass");
  // a hurt car lands with a clank the healthy one doesn't have
  if ((damage || 0) > 40) toneBurst(285, 0.09, 0.08 + s * 0.08, "square");
}
export function sfxBlowOff() {
  burst(2600, 3, 0.1, 0.28);
  toneBurst(2200, 0.22, 0.05, "triangle", 0, 900);
}
export function sfxShift() {
  burst(1600, 2, 0.06, 0.06);
}
export function sfxPickup(kind) {
  if (kind === "wrench") { toneBurst(660, 0.12, 0.12, "triangle"); toneBurst(880, 0.16, 0.12, "triangle", 0.09); }
  else if (kind === "canister") { toneBurst(330, 0.28, 0.14, "sawtooth", 0, 990); }
  else if (kind === "pennant") { toneBurst(523, 0.1, 0.1, "sine"); toneBurst(784, 0.1, 0.1, "sine", 0.08); toneBurst(1047, 0.22, 0.12, "sine", 0.16); }
  else { toneBurst(440, 0.1, 0.1, "square"); toneBurst(554, 0.14, 0.1, "square", 0.08); }
}
export function sfxBoostStart() {
  toneBurst(220, 0.5, 0.12, "sawtooth", 0, 660);
}
/* Distant thunder: the flash happened seconds ago and kilometres away, so
 * it arrives late, soft and all bottom end — a slow swell, a long roll,
 * and a sub note underneath. `delay` is seconds after the flash. */
export function sfxThunder(delay, power) {
  const p = Math.min(1, power || 0.6);
  burst(130, 0.5, 0.16 * p, 2.4, "lowpass", delay, 0.35);
  burst(85, 0.7, 0.1 * p, 1.8, "lowpass", delay + 0.7, 0.5);
  toneBurst(44, 1.9, 0.08 * p, "sine", delay + 0.15);
}
/* The suspension finding its bump stops: a dull thud with a hard edge —
 * a compression the springs could not absorb. */
export function sfxBottom(strength) {
  const s = Math.min(1, strength / 8);
  burst(110, 0.8, 0.14 + s * 0.2, 0.12, "lowpass");
  toneBurst(72, 0.1, 0.1 + s * 0.12, "sine");
  if (s > 0.5) burst(900, 1.4, 0.05, 0.05);
}
/* Hitting standing water at speed: the ford announces itself. */
export function sfxSplash(speed) {
  const s = Math.min(1, (speed || 10) / 25);
  burst(1500, 0.6, 0.1 + s * 0.2, 0.4, "bandpass", 0, 0.03);
  burst(4200, 0.5, 0.05 + s * 0.12, 0.3, "highpass", 0.03);
  burst(300, 0.8, 0.08 + s * 0.1, 0.24, "lowpass");
}
/* The country's small voices. Presentation only — ambience may use
 * Math.random, it is not a fact about the journey. Each one lands on a
 * random side of the stereo field, because the world is wide. */

/* One small bird, far off: two or three falling notes. */
function birdChirp(gain) {
  const d = ambDest();
  const f0 = 2300 + Math.random() * 1600;
  const n = 2 + (Math.random() * 2 | 0);
  for (let i = 0; i < n; i++) {
    toneBurst(f0 * (1 - i * 0.12), 0.05 + Math.random() * 0.05, gain * (0.03 + Math.random() * 0.02), "sine", i * (0.09 + Math.random() * 0.05), 0, d);
  }
}
/* An owl, twice, sometimes a third longer hoot. */
function owlHoot(gain) {
  const d = ambDest(), f = 300 + Math.random() * 60;
  cry(d, f * 1.1, f, 0.32, gain * 0.05, "sine", 0, 900, 0.07);
  cry(d, f * 1.06, f * 0.96, 0.3, gain * 0.045, "sine", 0.42, 900, 0.07);
  if (Math.random() < 0.5) cry(d, f, f * 0.9, 0.55, gain * 0.04, "sine", 0.95, 900, 0.09);
}
/* A gull working the cliff light: kee-OW, once or twice. */
function gullCry(gain) {
  const d = ambDest(), n = 1 + (Math.random() * 2 | 0);
  let t = 0;
  for (let i = 0; i < n; i++) {
    cry(d, 850 + Math.random() * 200, 1250, 0.12, gain * 0.02, "sawtooth", t, 2600, 0.02);
    cry(d, 1250, 720 + Math.random() * 120, 0.36, gain * 0.026, "sawtooth", t + 0.12, 2400, 0.01);
    t += 0.6 + Math.random() * 0.5;
  }
}
/* The curlew: a long rise, then the bubble. The sound OF a moor. */
function curlewCall(gain) {
  const d = ambDest();
  cry(d, 620 + Math.random() * 80, 1350, 0.7, gain * 0.03, "sine", 0, 2600, 0.14);
  for (let i = 0; i < 3; i++) cry(d, 1320, 1050, 0.09, gain * 0.024, "sine", 0.72 + i * 0.11, 2600, 0.015);
}
/* A raven somewhere on the rocks: one rough croak, often answered. */
function corvidCroak(gain) {
  const d = ambDest();
  burst(260, 2.6, gain * 0.05, 0.13, "bandpass", 0, 0.02, d);
  if (Math.random() < 0.7) burst(240, 2.6, gain * 0.045, 0.15, "bandpass", 0.24, 0.02, d);
}
/* Cowbells drifting over the pasture, grazing rhythm, never a tune. */
function cowbellClonk(gain) {
  const d = ambDest(), n = 2 + (Math.random() * 3 | 0);
  let t = 0;
  for (let i = 0; i < n; i++) {
    cry(d, 565, 565, 0.22, gain * 0.016, "square", t, 1900, 0.004);
    cry(d, 845, 845, 0.15, gain * 0.011, "square", t + 0.004, 2700, 0.004);
    t += 0.25 + Math.random() * 0.7;
  }
}
/* Lake ice settling in the night cold: a ping, a groan, and the boom
 * rolling away under the lake. */
function iceCrack(gain) {
  const d = ambDest();
  burst(1900, 3, gain * 0.028, 0.09, "bandpass", 0, 0, d);
  cry(d, 180, 70, 0.9, gain * 0.032, "triangle", 0.1, 500, 0.03);
  cry(d, 88, 36, 1.7, gain * 0.07, "sine", 0.05, 300, 0.02);
}
/* A loon across dark water: the two-note wail. */
function loonCall(gain) {
  const d = ambDest();
  cry(d, 620, 895, 0.55, gain * 0.032, "sine", 0, 1400, 0.16);
  cry(d, 880, 590, 0.5, gain * 0.028, "sine", 0.56, 1400, 0.05);
}
/* A hawk riding the thermals, very high, very far. */
function raptorCry(gain) {
  cry(ambDest(), 2900, 1500, 0.55, gain * 0.018, "sawtooth", 0, 3400, 0.04);
}
/* The Verge: a bell from nowhere, whole-tone, decaying too long. */
function strangeBell(gain) {
  const d = ambDest();
  const f = 311.13 * Math.pow(2, ((Math.random() * 6) | 0) * 2 / 12) * (Math.random() < 0.4 ? 2 : 1);
  cry(d, f, f, 2.8, gain * 0.03, "sine", 0, 4200, 0.012);
  cry(d, f * 2.756, f * 2.756, 1.3, gain * 0.011, "sine", 0.01, 5200, 0.012);
}
/* Water finding its way into the bore: each drop thrown into the tunnel
 * send, so the combs bloom it down the walls. */
function dripPing(gain) {
  if (!A.spaceIn) return;
  const f = 1300 + Math.random() * 1100;
  cry(A.spaceIn, f, f * 0.94, 0.045, gain * 0.09, "sine", 0, 5000, 0.003);
  cry(A.master, f, f * 0.94, 0.04, gain * 0.02, "sine", 0, 5000, 0.003);
}
/* One drop on the waystation's metal roof. */
function roofPing(gain) {
  toneBurst(560 + Math.random() * 900, 0.03 + Math.random() * 0.03, gain * (0.02 + Math.random() * 0.025), "triangle", 0, 0, ambDest());
}

/* The one-shot rota: each voice keeps its own clock; how OFTEN it fires
 * follows its activity from the plan, so a sound never becomes a loop. */
const ONESHOTS = {
  birds: { fn: birdChirp, min: 1.2, max: 5.2 },
  owl: { fn: owlHoot, min: 14, max: 40 },
  gull: { fn: gullCry, min: 5, max: 16 },
  curlew: { fn: curlewCall, min: 11, max: 32 },
  corvid: { fn: corvidCroak, min: 15, max: 42 },
  cowbell: { fn: cowbellClonk, min: 18, max: 50 },
  ice: { fn: iceCrack, min: 22, max: 70 },
  loon: { fn: loonCall, min: 24, max: 70 },
  raptor: { fn: raptorCry, min: 28, max: 75 },
  strange: { fn: strangeBell, min: 8, max: 24 },
  drip: { fn: dripPing, min: 0.7, max: 2.4, scaleGap: true },   // deeper bore, busier drips
};

/* per-frame update ------------------------------------------------------ */

export function updateAudio(car, world, dt, amb) {
  if (!A.ctx || A.muted || !A.engine) return;
  const e = A.engine;
  const now = A.ctx.currentTime;

  /* the watchdog: a limiter held more than 18 dB down for over a second is
   * not a loud moment, it is something swelling — flush the comb feedback
   * (the graph's only loops) for a third of a second and let it refill */
  if (A.limiter && A.limiter.reduction < -18) {
    A.pinnedT += dt;
    if (A.pinnedT > 1.2 && A.combFb) {
      for (const fb of A.combFb) { fb.gain.setValueAtTime(0, now); fb.gain.setValueAtTime(0.64, now + 0.35); }
      A.pinnedT = -2;   // a grace period before it may fire again
    }
  } else if (A.pinnedT > 0) A.pinnedT = 0;
  else if (A.pinnedT < 0) A.pinnedT = Math.min(0, A.pinnedT + dt);

  e.rpmS += (car.rpm - e.rpmS) * Math.min(1, dt * 12);
  const fire = (e.rpmS / 60) * 2;                    // four-stroke I4
  e.oscA.frequency.setTargetAtTime(fire, now, 0.02);
  e.oscB.frequency.setTargetAtTime(fire * 0.5 * 1.007, now, 0.02);   // detuned sub

  /* walls: how enclosed the car is right now (0 outdoors, 1 mid-tunnel) */
  const encl = world && world.spanEnclosure ? world.spanEnclosure(car.s) : 0;
  A.enclS = (A.enclS || 0) + (encl - (A.enclS || 0)) * Math.min(1, dt * 6);
  if (A.spaceIn) A.spaceIn.gain.setTargetAtTime(A.enclS * 0.55, now, 0.12);

  const load = 0.3 + car.throttle * 0.7;
  const vol = Math.min(0.44, 0.13 + (e.rpmS / 7600) * 0.27) * load * (car.grounded ? 1 : 1.12);
  e.gain.gain.setTargetAtTime(vol, now, 0.05);
  e.exhaust.frequency.setTargetAtTime(500 + (e.rpmS / 7600) * 2900 * load, now, 0.06);
  e.airbox.frequency.setTargetAtTime(340 + (e.rpmS / 7600) * 260, now, 0.1);

  // turbo: pitch from spool, flutter comes from the blow-off one-shot
  e.turbo.frequency.setTargetAtTime(700 + car.turbo * car.turbo * 3400, now, 0.07);
  e.turboG.gain.setTargetAtTime(car.turbo * car.turbo * 0.05 * (0.4 + car.throttle * 0.6), now, 0.08);

  // ---- surfaces
  const speed = Math.abs(car.vx);
  const rough = car.zone === "road"
    ? (car.surface === "tarmac" ? 0.06 : 0.45)
    : car.zone === "shoulder" ? 0.8 : 0.95;
  const rolling = car.grounded && speed > 2 ? Math.min(1, speed / 40) : 0;

  A.beds.rumble.g.gain.setTargetAtTime(rolling * rough * 0.34, now, 0.09);
  A.beds.rumble.f.frequency.setTargetAtTime(180 + speed * 2.2, now, 0.1);

  const crackleBase = rolling * (car.surface === "tarmac" && car.zone === "road" ? 0.02 : rough * 0.16);
  A.beds.crackle.g.gain.setTargetAtTime(crackleBase, now, 0.06);
  A.crackleDepth.gain.setTargetAtTime(crackleBase * 0.55, now, 0.06);
  A.crackleLFO.frequency.setTargetAtTime(14 + speed * 0.9, now, 0.1);

  const skidAmt = car.grounded ? Math.min(0.3, Math.max(0, car.skid - 0.3) * 0.5 * Math.min(1, speed / 9)) : 0;
  A.beds.skid.g.gain.setTargetAtTime(skidAmt, now, 0.05);
  A.beds.skid.f.frequency.setTargetAtTime(car.surface === "tarmac" ? 1500 : 800, now, 0.08);

  A.beds.wind.g.gain.setTargetAtTime(Math.min(0.14, (speed / 58) * (speed / 58) * 0.14), now, 0.12);

  /* A rattle that grows: past ~30 damage the loose panels start talking,
   * louder on rough ground and at speed — the car audibly wearing its
   * journey, which is the bible's ask for damage sound. */
  const dmgK = Math.min(1, Math.max(0, (car.damage - 30) / 70));
  A.beds.rattle.g.gain.setTargetAtTime(rolling * (0.3 + rough) * dmgK * 0.05, now, 0.1);
  A.beds.rattle.f.frequency.setTargetAtTime(1150 + speed * 9, now, 0.15);

  /* Transmission whine: gear mesh riding above the firing note, and it is
   * the OVERRUN's voice — lift off at speed and the box sings. */
  const overrun = Math.max(0, 1 - car.throttle * 1.6) * Math.min(1, speed / 18);
  e.trans.frequency.setTargetAtTime((e.rpmS / 60) * 3.1, now, 0.03);
  e.transG.gain.setTargetAtTime(Math.min(0.028, (e.rpmS / 7600) * 0.03) * (0.25 + overrun * 0.75) * (car.grounded ? 1 : 0.6), now, 0.07);

  /* Vegetation brushing the car: the verge is where the plants are. Grass
   * and scrub swish; snowfields and rock don't. */
  const veg = car.zone !== "road" && (world.offroadKey === "grass" || world.offroadKey === "scrub" || world.offroadKey === "peat" || !world.offroadKey) ? 1 : 0;
  A.beds.brush.g.gain.setTargetAtTime(veg * Math.min(0.16, speed / 25 * 0.16) * (car.zone === "off" ? 1 : 0.4), now, 0.06);
  A.beds.brush.f.frequency.setTargetAtTime(520 + speed * 14, now, 0.1);

  /* Water off the wheels: mud is the game's standing-water surface (fords,
   * the flooded road), and a wet road sprays a little on its own. */
  const wetRoad = (world.wetness || 0) * (car.zone === "road" ? 1 : 0.5);
  const inWater = car.surface === "mud" ? 1 : 0;
  A.beds.spray.g.gain.setTargetAtTime(Math.min(0.22, (inWater * 0.75 + wetRoad * 0.2) * Math.min(1, speed / 22) * 0.22), now, 0.07);

  /* Bottoming out: the sim leaves the transient on the car; a cooldown
   * keeps a washboard from machine-gunning it. */
  A.bumpT = Math.max(0, (A.bumpT || 0) - dt);
  if (car.suspHit > 2.6 && A.bumpT <= 0) {
    sfxBottom(car.suspHit);
    A.bumpT = 0.3;
  }

  /* ---- ambience: the place's voice, realized from ambiencePlan's gains
   * (the plan already folded in the clock, the weather and the duck —
   * this half only adds the musical shaping: gusts, swells, cadences) */
  if (amb && A.amb) {
    const t = (A.ambT += dt);
    // wind gusts on a slow cycle; more of it the more exposed the country
    const gust = 0.55 + 0.45 * Math.sin(t * 0.37 + Math.sin(t * 0.11) * 2.2);
    const gust2 = 0.5 + 0.5 * Math.sin(t * 0.29 + 1.7 + Math.sin(t * 0.07) * 1.9);
    A.amb.wind.g.gain.setTargetAtTime((amb.wind || 0) * gust * 0.11, now, 0.25);
    // cold wind sings: a thin whistle that wanders with the gusts
    A.amb.whistle.g.gain.setTargetAtTime((amb.whistle || 0) * (0.35 + 0.65 * gust) * 0.035, now, 0.4);
    A.amb.whistle.f.frequency.setTargetAtTime(2100 + 800 * Math.sin(t * 0.21), now, 0.5);
    // the sea arrives in swells, not a hiss
    const swell = Math.pow(0.5 + 0.5 * Math.sin(t * 0.55), 2.2);
    A.amb.sea.g.gain.setTargetAtTime((amb.sea || 0) * (0.25 + swell * 0.75) * 0.1, now, 0.3);
    // leaves move when the wind moves — a beat behind it
    A.amb.forest.g.gain.setTargetAtTime((amb.forest || 0) * (0.35 + 0.65 * gust2) * 0.085, now, 0.35);
    // insects: the AM pattern carries them; gain rides the depth
    const cr = (amb.crickets || 0) * 0.05;
    A.amb.cricket.g.gain.setTargetAtTime(cr * 0.4, now, 0.4);
    A.cricketDepth.gain.setTargetAtTime(cr, now, 0.4);
    const ci = (amb.cicada || 0) * 0.045;
    A.amb.cicada.g.gain.setTargetAtTime(ci * 0.4, now, 0.5);
    A.cicadaDepth.gain.setTargetAtTime(ci, now, 0.5);
    // rain patter, brighter and busier as it comes down harder
    A.amb.rain.g.gain.setTargetAtTime((amb.rain || 0) * 0.075 * (0.4 + 0.6 * (amb.duck != null ? amb.duck : 1)), now, 0.3);
    // the one-shot rota: sparse calls, never a loop
    for (const key in ONESHOTS) {
      const spec = ONESHOTS[key];
      const act = amb[key] || 0;
      if (act <= 0.02) continue;
      if (A.oneT[key] == null) A.oneT[key] = Math.random() * spec.max;
      A.oneT[key] -= dt;
      if (A.oneT[key] <= 0) {
        if (Math.random() < 0.12 + act * 0.55) spec.fn(Math.min(1, act));
        A.oneT[key] = (spec.min + Math.random() * (spec.max - spec.min)) / (spec.scaleGap ? Math.max(0.3, act) : 1);
      }
    }
    // rain on the waystation's metal roof: individual drops, lots of them
    if ((amb.roof || 0) > 0.02) {
      A.roofT -= dt;
      if (A.roofT <= 0) {
        roofPing(amb.roof);
        A.roofT = 0.04 + Math.random() * 0.2 / Math.max(0.2, amb.roof);
      }
    }
    // the compressor: barely there, and only when the car is stopped
    const shop = (amb.shop || 0) * 0.016;
    A.humG.gain.setTargetAtTime(shop, now, 0.8);
    A.humDepth.gain.setTargetAtTime(shop * 0.35, now, 0.8);
  }
}

/* codriver voice -------------------------------------------------------- */

let voicePick;
function pickVoice() {
  if (voicePick !== undefined) return voicePick;
  const synth = window.speechSynthesis;
  if (!synth) { voicePick = null; return null; }
  const voices = synth.getVoices();
  const prefer = ["Google UK English Female", "Libby", "Sonia", "Google UK English Male", "Daniel"];
  for (const name of prefer) {
    const v = voices.find((vv) => vv.name.indexOf(name) >= 0);
    if (v) { voicePick = v; return v; }
  }
  voicePick = voices.find((v) => v.lang && v.lang.indexOf("en") === 0) || null;
  return voicePick;
}
if (typeof window !== "undefined" && window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => { voicePick = undefined; };
}

export function setVoiceMuted(m) {
  A.voiceMuted = m;
  if (m && window.speechSynthesis) window.speechSynthesis.cancel();
}

export function speak(text, urgent) {
  const synth = window.speechSynthesis;
  if (!synth || A.voiceMuted || A.muted) return;
  if (A.speaking >= 2 || (urgent && A.speaking > 0)) synth.cancel();   // late call = useless call
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = 1.28;
  u.pitch = 1.0;
  u.volume = 0.95 * (A.voiceVol != null ? A.voiceVol : 1);
  A.speaking++;
  u.onend = () => { A.speaking = Math.max(0, A.speaking - 1); };
  u.onerror = () => { A.speaking = Math.max(0, A.speaking - 1); };
  synth.speak(u);
}
