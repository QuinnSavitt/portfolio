/* Gravl — ghost recording, playback and the live PB delta.
 *
 * Runs are sampled at 30 Hz and delta-encoded into Int16s (centimetre
 * positions, milliradian yaw), so a full minute of driving stores in well
 * under 40 KB of base64 — cheap enough to keep the personal best ghost in
 * localStorage indefinitely.
 */

const RATE = 30;              // samples per second
export const SAMPLE_EVERY = 4; // physics ticks between samples (120/30)

export function makeRecorder() {
  let frames = [];
  return {
    reset() { frames = []; },
    sample(car) {
      frames.push([car.x, car.y, car.z, car.yaw, car.s]);
    },
    frames() { return frames; },
  };
}

/* ---- encoding: [n, x0,y0,z0,yaw0,s0 (float32)] + int16 cm deltas */

export function encodeGhost(frames, time) {
  if (!frames.length) return null;
  const n = frames.length;
  const head = new Float32Array(7);
  head[0] = n; head[1] = time;
  head[2] = frames[0][0]; head[3] = frames[0][1]; head[4] = frames[0][2];
  head[5] = frames[0][3]; head[6] = frames[0][4];
  const body = new Int16Array((n - 1) * 5);
  let px = frames[0][0], py = frames[0][1], pz = frames[0][2], pw = frames[0][3], ps = frames[0][4];
  for (let i = 1; i < n; i++) {
    const f = frames[i];
    const k = (i - 1) * 5;
    const clamp = (v) => Math.max(-32000, Math.min(32000, Math.round(v)));
    body[k] = clamp((f[0] - px) * 100);
    body[k + 1] = clamp((f[1] - py) * 100);
    body[k + 2] = clamp((f[2] - pz) * 100);
    body[k + 3] = clamp((f[3] - pw) * 1000);
    body[k + 4] = clamp((f[4] - ps) * 50);
    px += body[k] / 100; py += body[k + 1] / 100; pz += body[k + 2] / 100;
    pw += body[k + 3] / 1000; ps += body[k + 4] / 50;
  }
  const bytes = new Uint8Array(head.byteLength + body.byteLength);
  bytes.set(new Uint8Array(head.buffer), 0);
  bytes.set(new Uint8Array(body.buffer), head.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
  }
  return btoa(bin);
}

export function decodeGhost(b64) {
  if (!b64) return null;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const head = new Float32Array(bytes.buffer, 0, 7);
    const n = head[0];
    const body = new Int16Array(bytes.buffer, 7 * 4);
    const frames = new Float32Array(n * 5);
    frames[0] = head[2]; frames[1] = head[3]; frames[2] = head[4];
    frames[3] = head[5]; frames[4] = head[6];
    for (let i = 1; i < n; i++) {
      const k = (i - 1) * 5, o = i * 5, p = (i - 1) * 5;
      frames[o] = frames[p] + body[k] / 100;
      frames[o + 1] = frames[p + 1] + body[k + 1] / 100;
      frames[o + 2] = frames[p + 2] + body[k + 2] / 100;
      frames[o + 3] = frames[p + 3] + body[k + 3] / 1000;
      frames[o + 4] = frames[p + 4] + body[k + 4] / 50;
    }
    // monotonic (s -> time) table for the live delta
    const sTimes = [];
    let maxS = -1;
    for (let i = 0; i < n; i++) {
      const s = frames[i * 5 + 4];
      if (s > maxS + 0.01) {
        maxS = s;
        sTimes.push([s, i / RATE]);
      }
    }
    return { n, time: head[1], frames, sTimes };
  } catch (err) {
    return null;
  }
}

/* interpolated ghost pose at race-time t */
export function ghostPose(ghost, t) {
  if (!ghost || ghost.n < 2) return null;
  const f = Math.max(0, Math.min(ghost.n - 1.001, t * RATE));
  const i = Math.floor(f), a = f - i;
  const k0 = i * 5, k1 = (i + 1) * 5;
  const fr = ghost.frames;
  let dyaw = fr[k1 + 3] - fr[k0 + 3];
  if (dyaw > Math.PI) dyaw -= Math.PI * 2;
  if (dyaw < -Math.PI) dyaw += Math.PI * 2;
  return {
    x: fr[k0] + (fr[k1] - fr[k0]) * a,
    y: fr[k0 + 1] + (fr[k1 + 1] - fr[k0 + 1]) * a,
    z: fr[k0 + 2] + (fr[k1 + 2] - fr[k0 + 2]) * a,
    yaw: fr[k0 + 3] + dyaw * a,
  };
}

/* time the ghost run passed distance s (for the live delta) */
export function ghostTimeAt(ghost, s) {
  if (!ghost || !ghost.sTimes || ghost.sTimes.length < 2) return null;
  const arr = ghost.sTimes;
  if (s <= arr[0][0]) return arr[0][1];
  if (s >= arr[arr.length - 1][0]) return arr[arr.length - 1][1];
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][0] <= s) lo = mid; else hi = mid;
  }
  const [s0, t0] = arr[lo], [s1, t1] = arr[hi];
  return t0 + ((s - s0) / (s1 - s0)) * (t1 - t0);
}
