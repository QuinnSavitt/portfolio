/* Daily Rocket — synthesized audio. No assets: the roar is shaped noise,
 * everything else is oscillators and envelopes. The AudioContext is made
 * on the first user gesture (autoplay policy) and the whole thing degrades
 * to silence if WebAudio is unavailable. Presentation only: Math.random
 * is fine here.
 */

const KEY = "qs-rocket-sound";

export function createAudio() {
  let ctx = null, master = null, bus = null;
  let roar = null, crackle = null, wind = null, hiss = null;
  let muted;
  try { muted = window.localStorage.getItem(KEY) === "off"; } catch (e) { muted = false; }

  function noise(seconds, color) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      if (color === "brown") { last = (last + white * 0.04) / 1.04; d[i] = last * 4; }
      else if (color === "pink") {
        b0 = 0.99765 * b0 + white * 0.099; b1 = 0.963 * b1 + white * 0.2965; b2 = 0.57 * b2 + white * 1.0526;
        d[i] = (b0 + b1 + b2 + white * 0.1848) * 0.22;
      } else { d[i] = white; }
    }
    return buf;
  }

  function loop(buf, type, freq, q) {
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; if (q) { f.Q.value = q; }
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f).connect(g).connect(bus);
    src.start();
    return { src, f, g };
  }

  function unlock() {
    if (ctx) {
      if (ctx.state === "suspended") { ctx.resume().catch(() => {}); }
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { return; }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.2;
      bus = ctx.createGain();
      bus.connect(comp).connect(master).connect(ctx.destination);
      const brown = noise(3.1, "brown"), pink = noise(2.7, "pink"), white = noise(1.9, "white");
      roar = loop(brown, "lowpass", 300, 0.7);
      hiss = loop(pink, "bandpass", 1800, 0.6);
      crackle = loop(white, "bandpass", 900, 1.2);
      wind = loop(pink, "bandpass", 500, 0.8);
      // a low sub rumble riding under the roar
      const sub = ctx.createOscillator();
      sub.type = "sine"; sub.frequency.value = 38;
      roar.sub = ctx.createGain(); roar.sub.gain.value = 0;
      sub.connect(roar.sub).connect(bus); sub.start();
    } catch (e) { ctx = null; }
  }

  /* liquid 0..1, solid 0..1 (share of thrust), pressure 0..1+ */
  function setEngine(liquid, solid, pAtm) {
    if (!roar) { return; }
    const t = ctx.currentTime;
    const thick = Math.min(1, pAtm);
    const total = Math.min(1, liquid + solid);
    // in vacuum the roar is felt through the structure: muffled and quiet
    roar.g.gain.setTargetAtTime(total * (0.18 + 0.32 * thick), t, 0.05);
    roar.f.frequency.setTargetAtTime(160 + total * (220 + 520 * thick), t, 0.08);
    roar.sub.gain.setTargetAtTime(total * 0.22, t, 0.06);
    hiss.g.gain.setTargetAtTime(liquid * (0.03 + 0.07 * thick), t, 0.05);
    const crack = solid * (0.12 + 0.2 * thick) * (0.55 + Math.random() * 0.9);
    crackle.g.gain.setTargetAtTime(crack, t, 0.02);
    crackle.f.frequency.setTargetAtTime(500 + Math.random() * 900, t, 0.02);
  }

  function setWind(k) {
    if (!wind) { return; }
    const t = ctx.currentTime;
    wind.g.gain.setTargetAtTime(Math.min(0.2, k * 0.2), t, 0.25);
    wind.f.frequency.setTargetAtTime(350 + k * 900, t, 0.3);
  }

  function blip(freq, at, dur, gain, type, bend) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, at);
    if (bend) { o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * bend), at + dur); }
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(bus);
    o.start(at); o.stop(at + dur + 0.05);
  }

  function burstNoise(at, dur, gain, type, f0, f1, color) {
    const src = ctx.createBufferSource();
    src.buffer = noise(dur + 0.1, color || "white");
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(f0, at);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(bus);
    src.start(at); src.stop(at + dur + 0.1);
  }

  const cue = {
    ignite() { const t = ctx.currentTime; burstNoise(t, 0.5, 0.35, "lowpass", 2400, 200); blip(70, t, 0.5, 0.25, "sine", 0.6); },
    clunk() { const t = ctx.currentTime; blip(180, t, 0.09, 0.18, "square", 0.5); burstNoise(t, 0.06, 0.12, "bandpass", 1800, 900); },
    unclunk() { const t = ctx.currentTime; blip(140, t, 0.08, 0.12, "triangle", 0.7); },
    stage() {
      const t = ctx.currentTime;
      burstNoise(t, 0.18, 0.45, "highpass", 3200, 800);
      blip(95, t, 0.25, 0.3, "sine", 0.5);
      blip(210, t + 0.03, 0.12, 0.14, "square", 0.6);
    },
    chute() { const t = ctx.currentTime; burstNoise(t, 0.35, 0.3, "lowpass", 900, 120, "pink"); blip(60, t + 0.05, 0.3, 0.2, "sine", 0.7); },
    tear() { const t = ctx.currentTime; burstNoise(t, 0.4, 0.3, "bandpass", 2600, 700); },
    touchdown(hard) {
      const t = ctx.currentTime;
      blip(hard ? 95 : 70, t, 0.22, hard ? 0.4 : 0.25, "sine", 0.6);
      burstNoise(t, 0.2, hard ? 0.25 : 0.12, "lowpass", 600, 120);
      if (hard) { blip(310, t + 0.02, 0.1, 0.1, "square", 0.5); }
    },
    explosion(big) {
      const t = ctx.currentTime;
      burstNoise(t, big ? 1.8 : 0.9, big ? 0.9 : 0.5, "lowpass", 3200, 90, "brown");
      burstNoise(t, 0.25, big ? 0.5 : 0.25, "highpass", 2000, 600);
      blip(48, t, big ? 1 : 0.5, big ? 0.6 : 0.35, "sine", 0.5);
    },
    splash() { const t = ctx.currentTime; burstNoise(t, 1.1, 0.5, "bandpass", 1400, 300, "pink"); },
    ring() { const t = ctx.currentTime; blip(880, t, 0.2, 0.14); blip(1318, t + 0.08, 0.3, 0.12); },
    ribbon() { const t = ctx.currentTime; blip(660, t, 0.2, 0.12); blip(990, t + 0.1, 0.25, 0.12); blip(1320, t + 0.2, 0.35, 0.1); },
    warn() { const t = ctx.currentTime; blip(740, t, 0.1, 0.1, "square"); blip(740, t + 0.18, 0.1, 0.1, "square"); },
    flameout() { const t = ctx.currentTime; blip(300, t, 0.14, 0.12, "sawtooth", 0.4); },
    pickup() { const t = ctx.currentTime; blip(523, t, 0.18, 0.12, "triangle"); blip(784, t + 0.1, 0.25, 0.12, "triangle"); },
    win() {
      const t = ctx.currentTime;
      [523, 659, 784, 1046].forEach((f, i) => blip(f, t + i * 0.1, 0.4, 0.11, "triangle"));
    },
    lose() { const t = ctx.currentTime; [392, 330, 262].forEach((f, i) => blip(f, t + i * 0.16, 0.35, 0.1, "triangle")); }
  };

  function play(name, arg) {
    if (!ctx || muted || !cue[name]) { return; }
    try { cue[name](arg); } catch (e) { /* never let sound break a flight */ }
  }

  function silence() { if (roar) { setEngine(0, 0, 1); setWind(0); } }

  function toggleMute() {
    muted = !muted;
    if (master) { master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.03); }
    try { window.localStorage.setItem(KEY, muted ? "off" : "on"); } catch (e) { /* fine */ }
    return muted;
  }

  return { unlock, setEngine, setWind, play, silence, toggleMute, isMuted: () => muted };
}
