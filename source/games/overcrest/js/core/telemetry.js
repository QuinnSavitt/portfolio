/* Overcrest — dev telemetry.
 *
 * On localhost only: samples the car, the player's inputs and the camera
 * at 10 Hz and POSTs batches to the dev server every 4 s. It exists so a
 * human drive can be replayed as numbers ("the car felt like ice" → here
 * is the slip angle, steer and speed at every moment). Never runs on the
 * deployed site.
 */

export function makeTelemetry(enabled) {
  const on = !!enabled && typeof location !== "undefined" && location.hostname === "localhost";
  const buf = [];
  let acc = 0, sendT = 0, first = true;

  function sample(dt, car, input, cam, run, extra) {
    if (!on) return;
    acc += dt; sendT += dt;
    if (acc < 0.1) return;
    acc = 0;
    buf.push([
      +run.R.time.toFixed(2),
      +car.s.toFixed(1), +(car.vx * 3.6).toFixed(0), +(car.beta * 57.3).toFixed(1),
      +(car.steer * 57.3).toFixed(1), +car.sigma.toFixed(2),
      input.dir | 0, +(input.steerAnalog == null ? 0 : input.steerAnalog).toFixed(2),
      +input.throttle.toFixed(1), +input.brake.toFixed(1), input.handbrake ? 1 : 0,
      car.zone, +car.d.toFixed(1), car.grounded ? 1 : 0,
      +(car.omega * 57.3).toFixed(0), +car.damage.toFixed(0),
      // camera: distance from car, height above car, and its yaw vs the car's
      cam ? +cam.dist.toFixed(1) : 0, cam ? +cam.up.toFixed(1) : 0, cam ? +cam.yawErr.toFixed(0) : 0,
      extra || "",
    ]);
    if (sendT >= 4) flush();
  }

  function flush() {
    if (!on || !buf.length) return;
    const body = JSON.stringify({ t: Date.now(), cols: ["t", "s", "kmh", "beta", "steer", "sigma", "dir", "stick", "thr", "brk", "hb", "zone", "d", "gnd", "yawrate", "dmg", "camDist", "camUp", "camYawErr", "x"], rows: buf.splice(0) });
    fetch("/telemetry" + (first ? "?reset=1" : ""), { method: "POST", body, keepalive: true }).catch(() => {});
    first = false;
    sendT = 0;
  }

  return { sample, flush, on };
}
