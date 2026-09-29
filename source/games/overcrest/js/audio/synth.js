/* Overcrest — the instrument rack. Every sound the music makes, and the
 * room it makes it in. Entirely synthesized, deterministic (seeded noise,
 * seeded strings), DOM-free: it runs in the game's AudioContext and in an
 * OfflineAudioContext under the render tool alike.
 *
 * The old realization was oscillators straight into a gain. This is a
 * production chain: a hall and a plate (convolution over generated
 * impulse responses), a tempo-synced ping-pong delay, chorus width on the
 * pad, sidechain pumping from the kick, saturation on the drums and the
 * bass, and a glue compressor on the music bus. The instruments: a
 * four-voice pad (supersaw / glass / organ), Karplus-Strong plucked
 * strings (a real string model — nylon, steel, koto — precomputed per
 * pitch), FM electric piano and bells, a glass mallet, a mono lead with
 * portamento and vibrato (saw / square / flute), a mono bass (sub / pick /
 * reese), kicks with a click, snares, brushes, taiko, hats, crash, riser,
 * a brass section for the fanfare, and a low hit for the stumble.
 *
 * makeRack(ctx, dest, seed, layerNames) → the rack. Layer gains g[name]
 * are the arranger's faders; instruments take a destination so the
 * arranger routes a keyboard onto the lead fader when the waystation
 * wants the hook played softly on keys. */

import { rng, hashCombine } from "../core/rng.js";

const DUCKED = new Set(["pad", "pulse", "arp", "shimmer", "bass"]);
const DRUMS = new Set(["kick", "ticks"]);
/* where each layer sits in the field: keys left, sparkle right, the lead
 * a touch off centre; the low end and the kick dead centre */
const PANS = { pulse: -0.5, arp: 0.55, lead: 0.12 };
const SENDS = {
  pad: { hall: 0.42, plate: 0, delay: 0 },
  pulse: { hall: 0.2, plate: 0.3, delay: 0.16 },
  lead: { hall: 0.32, plate: 0.05, delay: 0.34 },
  arp: { hall: 0.12, plate: 0.22, delay: 0.3 },
  shimmer: { hall: 0.75, plate: 0, delay: 0 },
  bass: { hall: 0, plate: 0, delay: 0 },
  drone: { hall: 0.05, plate: 0, delay: 0 },
  kick: { hall: 0, plate: 0.04, delay: 0 },
  ticks: { hall: 0.06, plate: 0.2, delay: 0 },
};

export function makeRack(ctx, dest, seed, layerNames) {
  const r = rng(hashCombine(seed || 1, 0x5a17));
  const sr = ctx.sampleRate;

  const gain = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
  const filt = (type, hz, q) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = hz; n.Q.value = q == null ? 0.7 : q; return n; };
  const pan = (p) => { if (ctx.createStereoPanner) { const n = ctx.createStereoPanner(); n.pan.value = p; return n; } return gain(1); };
  const osc = (type, hz, det) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = hz; if (det) o.detune.value = det; o.start(); return o; };
  const osc0 = (type, hz) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = hz; return o; };
  const shaper = (k) => {
    const N = 257, c = new Float32Array(N);
    for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * 2 - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); }
    const ws = ctx.createWaveShaper(); ws.curve = c; ws.oversample = "2x"; return ws;
  };

  /* ------------------------------------------------------------ the bus
   * The faders in music.js put the theme near -22 dBFS RMS — where the
   * old music sat at tier 4, which the owner could hear over the engine.
   * The player's music slider scales from here. */
  const BUS = 1.0;
  const out = gain(BUS);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -22; comp.knee.value = 12; comp.ratio.value = 2.2; comp.attack.value = 0.012; comp.release.value = 0.18;
  const hp = filt("highpass", 28, 0.7);
  const sum = gain(1);
  sum.connect(hp).connect(comp).connect(out).connect(dest);
  const duck = gain(1); duck.connect(sum);
  const drumBus = gain(1); const drumSat = shaper(1.7); drumBus.connect(drumSat).connect(sum);

  /* ------------------------------------------------- the rooms (IRs) */
  function makeIR(secs, hfStart, hfEnd, pre) {
    const len = Math.floor(sr * secs), buf = ctx.createBuffer(2, len, sr), preN = Math.floor(sr * pre);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = preN; i < len; i++) {
        const u = (i - preN) / (len - preN);
        const a = hfStart + (hfEnd - hfStart) * u;
        lp += ((r() * 2 - 1) - lp) * a;
        d[i] = lp * Math.exp(-6.9 * u);
      }
      for (const [ms, gn] of [[7, 0.6], [13, 0.45], [19, 0.35], [29, 0.28], [37, 0.2]]) {
        const k = preN + Math.floor((sr * ms) / 1000 * (ch ? 1.07 : 1));
        if (k < len) d[k] += gn * (ch ? -0.5 : 0.5);
      }
    }
    return buf;
  }
  const hall = ctx.createConvolver(); hall.buffer = makeIR(2.6, 0.5, 0.08, 0.018);
  const hallIn = gain(1), hallRet = gain(0.6);
  hallIn.connect(hall).connect(hallRet).connect(sum);
  const plate = ctx.createConvolver(); plate.buffer = makeIR(1.1, 0.85, 0.3, 0.004);
  const plateIn = gain(1), plateRet = gain(0.4);
  plateIn.connect(plate).connect(plateRet).connect(sum);

  /* ping-pong delay, dotted-eighth, damped, fed back across the field */
  const dIn = gain(1), dHP = filt("highpass", 320, 0.7);
  const dL = ctx.createDelay(1.5), dR = ctx.createDelay(1.5);
  const dLP1 = filt("lowpass", 3200, 0.5), dLP2 = filt("lowpass", 3200, 0.5);
  const fbL = gain(0.42), fbR = gain(0.42);
  const dRet = gain(0.9);
  dIn.connect(dHP).connect(dL);
  dL.connect(pan(-0.6)).connect(dRet);
  dL.connect(dLP1).connect(fbL).connect(dR);
  dR.connect(pan(0.6)).connect(dRet);
  dR.connect(dLP2).connect(fbR).connect(dL);
  dRet.connect(sum);
  const dToHall = gain(0.15); dRet.connect(dToHall).connect(hallIn);
  dL.delayTime.value = 0.45; dR.delayTime.value = 0.45;
  function setTempo(bpm) {
    const T = Math.min(1.4, (60 / bpm) * 0.75);
    const t = ctx.currentTime;
    dL.delayTime.setTargetAtTime(T, t, 0.4); dR.delayTime.setTargetAtTime(T, t, 0.4);
  }
  function throwDelay(t, secs) {
    for (const f of [fbL, fbR]) { f.gain.cancelScheduledValues(t); f.gain.setValueAtTime(0.66, t); f.gain.setTargetAtTime(0.42, t + secs, 0.3); }
  }

  /* -------------------------------------------------- layers + sends */
  const g = {}, send = {};
  for (const k of layerNames) {
    g[k] = gain(0);
    const to = DRUMS.has(k) ? drumBus : DUCKED.has(k) ? duck : sum;
    if (PANS[k]) g[k].connect(pan(PANS[k])).connect(to); else g[k].connect(to);
    const s = SENDS[k] || { hall: 0, plate: 0, delay: 0 };
    send[k] = { hall: gain(s.hall), plate: gain(s.plate), delay: gain(s.delay) };
    g[k].connect(send[k].hall).connect(hallIn);
    g[k].connect(send[k].plate).connect(plateIn);
    g[k].connect(send[k].delay).connect(dIn);
  }

  /* the sidechain: every kick leans on the pads for a beat */
  function duckAt(t, depth) {
    const p = duck.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(1, t);
    p.linearRampToValueAtTime(1 - depth, t + 0.012);
    p.setTargetAtTime(1, t + 0.03, 0.09);
  }

  /* ------------------------------------------------------------ noise */
  const noiseBuf = ctx.createBuffer(1, Math.floor(sr * 2), sr);
  { const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1; }
  const noise = (t, dur, loop) => {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = !!loop;
    if (!loop) s.loopEnd = 0;
    s.start(t); if (!loop) s.stop(t + dur);
    return s;
  };

  /* -------------------------------------------------------------- pad */
  const pad = (() => {
    const filter = filt("lowpass", 900, 1.1);
    const outG = gain(1); filter.connect(outG);
    const dry = gain(0.55); outG.connect(dry).connect(g.pad);
    for (const [base, rate, depth, p] of [[0.014, 0.31, 0.0028, -0.7], [0.023, 0.23, 0.0032, 0.7]]) {
      const d = ctx.createDelay(0.1); d.delayTime.value = base;
      const lfo = osc("sine", rate); const dep = gain(depth); lfo.connect(dep).connect(d.delayTime);
      const wet = gain(0.65);
      outG.connect(d).connect(pan(p)).connect(wet).connect(g.pad);
    }
    const voices = [];
    const PAD_PAN = [0, -0.45, 0.45, -0.2];   // root centre, third left, fifth right: wide by construction
    for (let v = 0; v < 4; v++) {
      const o1 = osc("triangle", 110, -7), o2 = osc("triangle", 110, 7), o3 = osc("sine", 55);
      const g1 = gain(0.5), g2 = gain(0.5), g3 = gain(0.35);
      const vg = gain(v === 0 ? 0.5 : v === 3 ? 0 : 0.36);
      o1.connect(g1).connect(vg); o2.connect(g2).connect(vg); o3.connect(g3).connect(vg); vg.connect(pan(PAD_PAN[v])).connect(filter);
      voices.push({ o1, o2, o3, g1, g2, g3, vg, f: 0, mul2: 1 });
    }
    let type = "glass";
    function setType(t) {
      if (t === type) return;
      type = t;
      for (const v of voices) {
        if (t === "saw") { v.o1.type = "sawtooth"; v.o2.type = "sawtooth"; v.o1.detune.value = -9; v.o2.detune.value = 9; v.mul2 = 1; v.g1.gain.value = 0.4; v.g2.gain.value = 0.4; v.g3.gain.value = 0.26; }
        else if (t === "organ") { v.o1.type = "sine"; v.o2.type = "sine"; v.o1.detune.value = 0; v.o2.detune.value = 3; v.mul2 = 2; v.g1.gain.value = 0.62; v.g2.gain.value = 0.28; v.g3.gain.value = 0.22; }
        else { v.o1.type = "triangle"; v.o2.type = "triangle"; v.o1.detune.value = -7; v.o2.detune.value = 7; v.mul2 = 1; v.g1.gain.value = 0.5; v.g2.gain.value = 0.5; v.g3.gain.value = 0.22; }
        if (v.f) v.o2.frequency.value = v.f * v.mul2 * 1.003;
      }
    }
    function setNote(v, hz, t, tau) {
      const pv = voices[v]; pv.f = hz;
      pv.o1.frequency.setTargetAtTime(hz, t, tau);
      pv.o2.frequency.setTargetAtTime(hz * pv.mul2 * 1.003, t, tau);
      pv.o3.frequency.setTargetAtTime(hz / 2, t, tau);
    }
    return {
      voices, setType, setNote,
      setCutoff: (hz, t, tau) => filter.frequency.setTargetAtTime(hz, t, tau),
      setVoiceGain: (v, x, t, tau) => voices[v].vg.gain.setTargetAtTime(x, t, tau),
    };
  })();

  /* ------------------------------------------------------------ drone */
  const drone = (() => {
    const lp = filt("lowpass", 220, 0.5); lp.connect(g.drone);
    const a = osc("sine", 60), b = osc("triangle", 60.3); const bg = gain(0.3);
    a.connect(lp); b.connect(bg).connect(lp);
    const lfo = osc("sine", 0.07); const depth = gain(0); lfo.connect(depth).connect(g.drone.gain);
    return { depth, setFreq: (hz, t, tau) => { a.frequency.setTargetAtTime(hz, t, tau); b.frequency.setTargetAtTime(hz * 1.005, t, tau); } };
  })();

  /* ---------------------------------------------------------- shimmer */
  /* a halo, not a whistle: an octave and a twelfth over the chord root
   * (the old 4× and 6× sines read as a high-pitched ringing), rounded
   * off by a lowpass and mostly heard through the hall */
  const shimmer = (() => {
    const vs = [];
    const lp = filt("lowpass", 1800, 0.5); lp.connect(g.shimmer);
    for (const mul of [2, 3]) { const o = osc("sine", 110 * mul); const vg = gain(mul === 2 ? 0.55 : 0.35); o.connect(vg).connect(lp); vs.push({ o, mul }); }
    const lfo = osc("sine", 0.11); const depth = gain(0); lfo.connect(depth).connect(g.shimmer.gain);
    return { depth, setFreq: (hz, t, tau) => { for (const v of vs) v.o.frequency.setTargetAtTime(hz * v.mul, t, tau); } };
  })();

  /* ------------------------------------------------- mono synth (lead, bass)
   * Persistent oscillators, one voice, portamento when notes touch. */
  function makeMono(destNode, cfg) {
    const oA = osc("sawtooth", 220), oB = osc("sawtooth", 220, 7), oS = osc("square", 110);
    const gA = gain(0.5), gB = gain(0.5), gS = gain(0);
    const lf = filt("lowpass", 1400, 1.6);
    const vca = gain(0);
    oA.connect(gA).connect(lf); oB.connect(gB).connect(lf); oS.connect(gS).connect(lf);
    lf.connect(vca).connect(destNode);
    const nz = noise(0, 0, true); const nBP = filt("bandpass", 800, 2.5); const nG = gain(0);
    nz.connect(nBP).connect(nG).connect(vca);
    const vib = osc("sine", 5.3); const vibD = gain(0); vib.connect(vibD); vibD.connect(oA.detune); vibD.connect(oB.detune);
    let type = null, offAt = -1e9;
    function setType(name) {
      const c = cfg[name] || cfg[Object.keys(cfg)[0]];
      if (c === type) return;
      type = c;
      oA.type = c.a; oB.type = c.b; gA.gain.value = c.aGain == null ? 0.5 : c.aGain; gB.gain.value = c.bGain; gS.gain.value = c.subGain || 0;
      oA.detune.value = c.aDetune || 0; oB.detune.value = c.detune == null ? 7 : c.detune;
      lf.Q.value = c.q; nG.gain.value = c.noise || 0; vibD.gain.value = c.vib || 0;
    }
    function on(t, hz, vel, dur) {
      const c = type;
      const legato = t <= offAt + 0.05;
      const set = (p, v) => { p.cancelScheduledValues(t); if (legato) p.setTargetAtTime(v, t, c.glide); else p.setValueAtTime(v, t); };
      set(oA.frequency, hz); set(oB.frequency, hz); set(oS.frequency, hz / 2);
      nBP.frequency.setTargetAtTime(hz * 2, t, 0.02);
      lf.frequency.cancelScheduledValues(t);
      lf.frequency.setValueAtTime(c.base + c.env, t);
      lf.frequency.setTargetAtTime(c.base, t, 0.14);
      vca.gain.cancelScheduledValues(t);
      vca.gain.setTargetAtTime(vel, t, c.attack);
      const tOff = t + dur;
      vca.gain.setTargetAtTime(0, tOff, c.rel);
      offAt = tOff;
    }
    setType(Object.keys(cfg)[0]);
    return { setType, on, filter: lf };
  }
  const lead = makeMono(g.lead, {
    saw: { a: "sawtooth", b: "sawtooth", bGain: 0.5, subGain: 0.18, base: 1500, env: 2600, q: 1.6, attack: 0.012, rel: 0.09, glide: 0.035, vib: 5 },
    square: { a: "square", b: "square", bGain: 0.4, subGain: 0.12, base: 1300, env: 2200, q: 1.4, attack: 0.014, rel: 0.09, glide: 0.035, vib: 4, detune: 5 },
    flute: { a: "sine", b: "triangle", aGain: 0.7, bGain: 0.28, subGain: 0, base: 2600, env: 2200, q: 0.8, attack: 0.055, rel: 0.12, glide: 0.05, vib: 7, noise: 0.07 },
  });
  const bassSat = shaper(1.6); bassSat.connect(g.bass);
  const bass = makeMono(bassSat, {
    sub: { a: "sine", b: "sawtooth", aGain: 0.75, bGain: 0.22, subGain: 0, base: 260, env: 260, q: 0.9, attack: 0.008, rel: 0.08, glide: 0.02, detune: 0 },
    pick: { a: "sine", b: "sawtooth", aGain: 0.6, bGain: 0.55, subGain: 0, base: 520, env: 1100, q: 1.1, attack: 0.005, rel: 0.07, glide: 0.02, detune: 0 },
    reese: { a: "sawtooth", b: "sawtooth", aGain: 0.42, bGain: 0.42, subGain: 0.3, base: 380, env: 300, q: 1.0, attack: 0.01, rel: 0.1, glide: 0.03, aDetune: -10, detune: 10 },
  });

  /* ------------------------------------------------ plucked strings (KS)
   * A real string: a burst of noise into a delay line with an averaging
   * filter; the loop gain is set from the pitch so every string rings for
   * about the same time. Precomputed per semitone, cached, played through
   * a playbackRate correction so the pitch is exact. */
  const ksCache = new Map();
  const KS_SR = 44100;   // strings are modelled at a fixed rate and resampled on playback — a 192 kHz interface costs no more
  function ksBuffer(hz, bright) {
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    const key = midi + ":" + Math.round(bright * 10);
    let e = ksCache.get(key);
    if (e) return e;
    const f0 = 440 * Math.pow(2, (midi - 69) / 12);
    const N = Math.max(2, Math.round(KS_SR / f0));
    const fb = KS_SR / N;
    const secs = Math.min(2.0, Math.max(0.6, 2.2 - (midi - 48) / 36));
    const len = Math.floor(KS_SR * secs);
    const buf = ctx.createBuffer(1, len, KS_SR), d = buf.getChannelData(0);
    const ring = new Float32Array(N);
    let lp = 0; const a = 0.25 + 0.7 * bright;
    for (let i = 0; i < N; i++) { lp += ((r() * 2 - 1) - lp) * a; ring[i] = lp; }
    const rho = Math.pow(0.16 + 0.14 * bright, 1 / f0);
    let idx = 0, last = ring[N - 1];
    for (let n = 0; n < len; n++) {
      const cur = ring[idx];
      d[n] = cur;
      ring[idx] = rho * 0.5 * (cur + last);
      last = cur;
      idx = idx + 1 === N ? 0 : idx + 1;
    }
    const fade = Math.min(len, Math.floor(KS_SR * 0.08));
    for (let n = len - fade; n < len; n++) d[n] *= (len - n) / fade;
    if (ksCache.size > 64) ksCache.delete(ksCache.keys().next().value);
    e = { buf, fb }; ksCache.set(key, e);
    return e;
  }
  function ks(t, hz, dur, vel, bright, dst) {
    const { buf, fb } = ksBuffer(hz, bright == null ? 0.5 : bright);
    const s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = hz / fb;
    const e = gain(0); e.gain.setValueAtTime(vel * 0.9, t); e.gain.setTargetAtTime(0, t + Math.max(0.05, dur), 0.12);
    s.connect(e).connect(dst); s.start(t); s.stop(t + Math.max(0.05, dur) + 0.7);
  }

  /* --------------------------------------------------- FM + additive keys */
  function ep(t, hz, dur, vel, dst) {
    const car = osc0("sine", hz), mod = osc0("sine", hz);
    const mg = gain(0); mg.gain.setValueAtTime(hz * 2.2, t); mg.gain.setTargetAtTime(hz * 0.15, t, 0.12);
    mod.connect(mg).connect(car.frequency);
    const tine = osc0("sine", hz * 7); const tg = gain(0); tg.gain.setValueAtTime(0.05, t); tg.gain.setTargetAtTime(0, t, 0.02);
    const e = gain(0); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(vel, t + 0.004);
    e.gain.setTargetAtTime(vel * 0.35, t + 0.004, 0.5);
    e.gain.setTargetAtTime(0, t + dur, 0.09);
    car.connect(e); tine.connect(tg).connect(e); e.connect(dst);
    car.start(t); mod.start(t); tine.start(t);
    const end = t + dur + 0.6; car.stop(end); mod.stop(end); tine.stop(end);
  }
  function bell(t, hz, dur, vel, dst) {
    const car = osc0("sine", hz), mod = osc0("sine", hz * 3.53);
    const mg = gain(0); mg.gain.setValueAtTime(hz * 3.0, t); mg.gain.setTargetAtTime(hz * 0.1, t, 0.5);
    mod.connect(mg).connect(car.frequency);
    const o2 = osc0("sine", hz * 2.0); const g2 = gain(0); g2.gain.setValueAtTime(vel * 0.18, t); g2.gain.setTargetAtTime(0, t, 0.35);
    const e = gain(0); e.gain.setValueAtTime(vel, t + 0.002); e.gain.setTargetAtTime(0, t + 0.005, Math.max(0.5, Math.min(1.1, dur)));
    car.connect(e); o2.connect(g2).connect(dst); e.connect(dst);
    car.start(t); mod.start(t); o2.start(t);
    const end = t + Math.max(0.5, Math.min(1.1, dur)) * 4 + 0.2; car.stop(end); mod.stop(end); o2.stop(end);
  }
  function glass(t, hz, dur, vel, dst) {
    const e = gain(0); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(vel, t + 0.012);
    e.gain.setTargetAtTime(vel * 0.25, t + 0.012, 0.45); e.gain.setTargetAtTime(0, t + dur, 0.2);
    e.connect(dst);
    const end = t + dur + 1.2;
    for (const [mul, gv] of [[1, 0.8], [2, 0.3], [3.01, 0.12], [5.4, 0.04]]) {
      const o = osc0("sine", hz * mul); const og = gain(gv); o.connect(og).connect(e); o.start(t); o.stop(end);
    }
  }
  function keys(type, t, hz, dur, vel, dst, bright) {
    if (type === "ks") ks(t, hz, dur, vel, bright, dst);
    else if (type === "bell") bell(t, hz, dur, vel, dst);
    else if (type === "glass") glass(t, hz, dur, vel, dst);
    else ep(t, hz, dur, vel, dst);
  }

  /* --------------------------------------------------------------- arp */
  function arp(type, t, hz, dur, vel, dst) {
    if (type === "ks") { ks(t, hz, dur, vel * 0.8, 0.7, dst); return; }
    if (type === "sine") {
      // a soft ping, not a bell: rounded by a lowpass, short, no bare partial ringing on
      const e = gain(0); e.gain.setValueAtTime(vel * 0.6, t); e.gain.setTargetAtTime(0, t + 0.01, 0.08);
      const lp = filt("lowpass", Math.min(4000, hz * 2.5), 0.6); lp.connect(e); e.connect(dst);
      const o = osc0("sine", hz), o2 = osc0("triangle", hz * 2); const g2 = gain(0.12);
      o.connect(lp); o2.connect(g2).connect(lp); o.start(t); o2.start(t); o.stop(t + 0.5); o2.stop(t + 0.5);
      return;
    }
    const o = osc0(type === "square" ? "square" : "sawtooth", hz);
    const f = filt("lowpass", 4200, 1.2);
    f.frequency.setValueAtTime(type === "square" ? 3200 : 4200, t); f.frequency.setTargetAtTime(500, t, 0.06);
    const e = gain(0); e.gain.setValueAtTime(vel * 0.7, t); e.gain.setTargetAtTime(0, t + 0.003, Math.max(0.05, dur * 0.35));
    o.connect(f).connect(e).connect(dst); o.start(t); o.stop(t + dur + 0.4);
  }

  /* ------------------------------------------------------------- drums */
  const hatPan = pan(0.28); hatPan.connect(g.ticks);
  const rimPan = pan(-0.35); rimPan.connect(g.ticks);
  const snareSend = gain(0.25); snareSend.connect(plateIn);
  function kick(t, vel, kit) {
    const soft = kit === "soft", brushy = kit === "brush";
    const o = osc0("sine", 150);
    o.frequency.setValueAtTime(soft || brushy ? 120 : 160, t);
    o.frequency.exponentialRampToValueAtTime(soft ? 44 : 48, t + (soft ? 0.07 : 0.05));
    const e = gain(0); e.gain.setValueAtTime(vel, t); e.gain.exponentialRampToValueAtTime(0.001, t + (soft ? 0.22 : 0.3));
    if (brushy) { const lp = filt("lowpass", 900, 0.5); o.connect(lp).connect(e); } else o.connect(e);
    e.connect(g.kick); o.start(t); o.stop(t + 0.35);
    if (!soft && !brushy) {
      const n = noise(t, 0.03); const f = filt("highpass", 2500, 0.7);
      const ce = gain(0); ce.gain.setValueAtTime(vel * 0.35, t); ce.gain.exponentialRampToValueAtTime(0.001, t + 0.012);
      n.connect(f).connect(ce).connect(g.kick);
    }
  }
  function snare(t, vel, kit) {
    if (kit === "brush") {
      const n = noise(t, 0.4); const f = filt("bandpass", 1800, 0.7);
      const e = gain(0); e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(vel * 0.5, t + 0.06); e.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      n.connect(f).connect(e); e.connect(g.ticks); e.connect(snareSend);
      return;
    }
    const soft = kit === "soft";
    const n = noise(t, 0.25); const f = filt("bandpass", soft ? 1400 : 1700, 0.9);
    const e = gain(0); e.gain.setValueAtTime(vel * (soft ? 0.55 : 0.8), t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    n.connect(f).connect(e); e.connect(g.ticks); e.connect(snareSend);
    const o = osc0("sine", 190); o.frequency.setValueAtTime(190, t); o.frequency.exponentialRampToValueAtTime(150, t + 0.05);
    const te = gain(0); te.gain.setValueAtTime(vel * 0.5, t); te.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o.connect(te).connect(g.ticks); o.start(t); o.stop(t + 0.1);
  }
  function hat(t, vel, hz, open, kit) {
    const dur = open ? 0.22 : 0.06;
    const n = noise(t, dur + 0.05);
    if (kit === "brush") {
      const f = filt("lowpass", 6000, 0.5);
      const e = gain(0); e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(vel * 0.28, t + 0.04); e.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      n.connect(f).connect(e).connect(hatPan);
      return;
    }
    const f = filt("highpass", hz, 0.7);
    const e = gain(0); e.gain.setValueAtTime(vel * (open ? 0.8 : 0.7), t); e.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.18 : 0.035));
    n.connect(f).connect(e).connect(hatPan);
  }
  function tom(t, vel) {
    const o = osc0("sine", 95); o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(58, t + 0.12);
    const e = gain(0); e.gain.setValueAtTime(vel, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    o.connect(e).connect(g.kick); o.start(t); o.stop(t + 0.45);
    const n = noise(t, 0.04); const f = filt("highpass", 1200, 0.7);
    const ne = gain(0); ne.gain.setValueAtTime(vel * 0.25, t); ne.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    n.connect(f).connect(ne).connect(g.ticks);
  }
  function rim(t, vel) {
    const o = osc0("square", 1200); const f = filt("bandpass", 2200, 3);
    const e = gain(0); e.gain.setValueAtTime(vel * 0.35, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    o.connect(f).connect(e).connect(rimPan); o.start(t); o.stop(t + 0.05);
  }
  function tick(t, vel) {
    const o = osc0("sine", 2600); const e = gain(0); e.gain.setValueAtTime(vel * 0.3, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.connect(e).connect(rimPan); o.start(t); o.stop(t + 0.07);
    const n = noise(t, 0.03); const f = filt("highpass", 6000, 0.7);
    const ne = gain(0); ne.gain.setValueAtTime(vel * 0.12, t); ne.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
    n.connect(f).connect(ne).connect(rimPan);
  }
  function crash(t, vel) {
    const n = noise(t, 1.6); const f = filt("highpass", 4000, 0.7); const f2 = filt("bandpass", 7000, 0.5);
    const e = gain(0); e.gain.setValueAtTime(vel * 0.4, t); e.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    n.connect(f).connect(e); n.connect(f2).connect(e); e.connect(hatPan); e.connect(snareSend);
  }
  function riser(t, dur, vel) {
    const n = noise(t, dur + 0.1); const f = filt("bandpass", 400, 1.5);
    f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(5000, t + dur);
    const e = gain(0); e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(vel * 0.35, t + dur); e.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.05);
    n.connect(f).connect(e).connect(g.ticks);
  }

  /* ---------------------------------------------- brass (the fanfare) */
  function brass(t, hz, dur, vel, dst) {
    const f = filt("lowpass", 900, 1.0); f.frequency.setValueAtTime(900, t); f.frequency.linearRampToValueAtTime(2400, t + 0.06); f.frequency.setTargetAtTime(1400, t + 0.06, 0.3);
    const e = gain(0); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(vel, t + 0.045); e.gain.setTargetAtTime(0, t + dur, 0.15);
    f.connect(e).connect(dst);
    for (const det of [-8, 0, 8]) { const o = osc0("sawtooth", hz); o.detune.value = det; const og = gain(0.33); o.connect(og).connect(f); o.start(t); o.stop(t + dur + 0.8); }
  }
  /* the stumble: a low detuned hit under a collision */
  function hit(t, hz, vel) {
    const f = filt("lowpass", 600, 0.8); const e = gain(0); e.gain.setValueAtTime(vel, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    f.connect(e).connect(sum);
    for (const det of [-25, 25]) { const o = osc0("sawtooth", hz); o.detune.value = det; const og = gain(0.5); o.connect(og).connect(f); o.start(t); o.stop(t + 0.6); }
  }

  return {
    g, send, sum, out, pad, drone, shimmer, lead, bass,
    play: { ks, ep, bell, glass, keys, arp, kick, snare, hat, tom, rim, tick, crash, riser, brass, hit },
    duck: duckAt, throwDelay, setTempo,
    setLevel: (f) => out.gain.setTargetAtTime(BUS * Math.max(0, Math.min(1, f)), ctx.currentTime, 0.2),
    rng: r,
  };
}
