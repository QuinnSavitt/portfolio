/* Daily Rocket — synthesized audio. No assets: engine rumble is shaped
 * noise, everything else is oscillators and envelopes. The AudioContext is
 * created lazily on the first user gesture (autoplay policy) and the whole
 * thing degrades to silence if WebAudio is unavailable.
 */

const KEY = "qs-rocket-sound";

export function createAudio() {
  let ctx = null;
  let master = null;
  let engineGain = null, engineFilter = null;
  let windGain = null, windFilter = null;
  let muted;
  try { muted = window.localStorage.getItem(KEY) === "off"; } catch (e) { muted = false; }

  function noiseBuffer(seconds, brown) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      if (brown) {
        last = (last + white * 0.04) / 1.04;
        d[i] = last * 4.5;
      } else {
        d[i] = white;
      }
    }
    return buf;
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
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);

      const eng = ctx.createBufferSource();
      eng.buffer = noiseBuffer(2.2, true);
      eng.loop = true;
      engineFilter = ctx.createBiquadFilter();
      engineFilter.type = "lowpass";
      engineFilter.frequency.value = 320;
      engineGain = ctx.createGain();
      engineGain.gain.value = 0;
      eng.connect(engineFilter).connect(engineGain).connect(master);
      eng.start();

      const wind = ctx.createBufferSource();
      wind.buffer = noiseBuffer(2.7, false);
      wind.loop = true;
      windFilter = ctx.createBiquadFilter();
      windFilter.type = "bandpass";
      windFilter.frequency.value = 700;
      windFilter.Q.value = 0.6;
      windGain = ctx.createGain();
      windGain.gain.value = 0;
      wind.connect(windFilter).connect(windGain).connect(master);
      wind.start();
    } catch (e) { ctx = null; }
  }

  function setEngine(throttle, vacuum) {
    if (!engineGain) { return; }
    const t = ctx.currentTime;
    engineGain.gain.setTargetAtTime(throttle * (vacuum ? 0.22 : 0.34), t, 0.06);
    engineFilter.frequency.setTargetAtTime(240 + throttle * 640, t, 0.08);
  }

  function setWind(k) { // 0..1
    if (!windGain) { return; }
    windGain.gain.setTargetAtTime(Math.min(0.22, k * 0.22), ctx.currentTime, 0.25);
  }

  function blip(freq, at, dur, gain, type) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(master);
    o.start(at); o.stop(at + dur + 0.05);
  }

  function beacon() {
    if (!ctx) { return; }
    const t = ctx.currentTime;
    blip(880, t, 0.18, 0.16, "sine");
    blip(1318, t + 0.09, 0.26, 0.14, "sine");
  }

  function explosion() {
    if (!ctx) { return; }
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(1.4, false);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(2800, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 1.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.25);
    src.connect(f).connect(g).connect(master);
    src.start(t); src.stop(t + 1.4);
    blip(52, t, 0.5, 0.4, "sine");
  }

  function thud(hard) {
    if (!ctx) { return; }
    const t = ctx.currentTime;
    blip(hard ? 110 : 82, t, 0.16, hard ? 0.3 : 0.18, "sine");
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(0.16, false);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = 500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(hard ? 0.2 : 0.1, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    src.connect(f).connect(g).connect(master);
    src.start(t); src.stop(t + 0.18);
  }

  function flameout() {
    if (!ctx) { return; }
    const t = ctx.currentTime;
    blip(300, t, 0.12, 0.1, "square");
    blip(150, t + 0.07, 0.16, 0.08, "square");
  }

  function fanfare() {
    if (!ctx) { return; }
    const t = ctx.currentTime;
    blip(523, t, 0.22, 0.12, "triangle");
    blip(659, t + 0.11, 0.22, 0.12, "triangle");
    blip(784, t + 0.22, 0.34, 0.13, "triangle");
  }

  function toggleMute() {
    muted = !muted;
    if (master) { master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.03); }
    try { window.localStorage.setItem(KEY, muted ? "off" : "on"); } catch (e) { /* fine */ }
    return muted;
  }

  return {
    unlock, setEngine, setWind, beacon, explosion, thud, flameout, fanfare,
    toggleMute, isMuted: () => muted
  };
}
