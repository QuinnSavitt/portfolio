/* Daily Rocket — deterministic autopilot.
 *
 * Three jobs: (1) the generator test-flies every candidate day with this bot,
 * so a published daily is machine-verified beatable and its par time/fuel are
 * measured, not guessed; (2) the Node harness sweeps it across many days;
 * (3) ?bot=1 lets a human watch it. It flies the same physics through the
 * same {rot, thrust} input contract as the player — no cheating.
 *
 * Guidance is a velocity field: pick the current waypoint (next beacon, then
 * the pad), derive a desired velocity, turn the velocity error into a thrust
 * vector, split that into a tilt command and a throttle. All proportional,
 * all deterministic.
 */

import { shipMass, altitude, normAngle, BODY, V_LAND } from "./physics.js";

const TILT_MAX = 1.05; // never command more than ~60 deg of lean

export function botInput(s, skill) {
  const d = s.day, w = d.world;
  const out = { rot: 0, thrust: 0 };
  if (s.done) { return out; }

  const cruise = 30 + skill * 34;
  const alt = altitude(s);

  // ---- pick the target
  let tx = d.pad.x, ty = d.terrain.heightAt(d.pad.x) + BODY.halfH;
  let passThrough = false;
  for (let i = 0; i < d.beacons.length; i++) {
    if (!s.beacons[i]) { tx = d.beacons[i].x; ty = d.beacons[i].y; passThrough = true; break; }
  }

  const dx = tx - s.x, dy = ty - s.y;
  const dist = Math.hypot(dx, dy);
  const landingRun = !passThrough && Math.abs(dx) < 90 && alt < 260;

  /* How hard can this engine actually brake a fall right now? A Mule can dive
   * at the pad; a Sparrow on a heavy world has to feather down early. */
  const maxUp = Math.max(0.4, s.engine.thrust / shipMass(s) - w.g);
  const vSafe = Math.sqrt(2 * maxUp * Math.max(0, alt) * 0.55) + 1.2;

  // ---- desired velocity
  let vdx, vdy;
  if (landingRun) {
    /* Vertical descent over the pad. Drift is squeezed out as altitude
     * shrinks (touching down while still chasing pad centre is a crash),
     * and the flare starts at the physics answer: when the height left
     * roughly equals the braking distance this engine needs. */
    const hCap = Math.max(1.0, Math.min(8, alt * 0.22));
    vdx = Math.max(-hCap, Math.min(hCap, dx * 0.35));
    const sink = 1.1 + (1 - skill) * 1.2 + alt * 0.085;
    vdy = -Math.min(Math.min(sink, vSafe * 0.8), V_LAND * 4);
    const brakeAlt = (s.vy < 0 ? (s.vy * s.vy - 2.6) / (2 * maxUp * 0.8) : 0) + 4;
    if (alt < Math.max(brakeAlt, 6 + 30 / maxUp)) {
      vdy = Math.max(vdy, -Math.min(1.6, V_LAND * 0.4));
    }
  } else if (passThrough && dist > 55) {
    vdx = (dx / dist) * cruise;
    vdy = (dy / dist) * cruise;
  } else {
    /* Final approach: never carry more speed than this engine can shed in
     * the distance left while still holding its own weight up. */
    const acc = s.engine.thrust / shipMass(s);
    const aH = Math.sqrt(Math.max(0.5, acc * acc - w.g * w.g));
    const vStop = Math.sqrt(2 * aH * 0.38 * Math.abs(dx)) + 3;
    const vCap = Math.min(cruise, vStop);
    vdx = Math.max(-vCap, Math.min(vCap, dx * 0.45));
    vdy = Math.max(-cruise * 0.8, Math.min(cruise * 0.8, dy * 0.45));
  }
  // never descend faster than this engine can recover from
  if (vdy < -vSafe) { vdy = -vSafe; }

  // ---- terrain lookahead: refuse to fly into a ridge
  if (!landingRun) {
    const dir = s.vx >= 0 ? 1 : -1;
    let need = -Infinity;
    for (let ahead = 60; ahead <= 420; ahead += 90) {
      const gx = s.x + dir * ahead;
      need = Math.max(need, d.terrain.heightAt(gx) + 95);
    }
    if (s.y < need) {
      vdy = Math.max(vdy, Math.min(28, (need - s.y) * 0.5));
    }
  }

  // ---- velocity error -> thrust vector (gravity feed-forward)
  const kv = 0.75 + skill * 0.35;
  const ax = (vdx - s.vx) * kv;
  const ay = (vdy - s.vy) * kv + w.g;
  const m = shipMass(s);
  let Tx = ax * m, Ty = ay * m;
  if (Ty < m * w.g * 0.06) { Ty = m * w.g * 0.06; } // never command thrust downward

  let tiltCmd = Math.atan2(Tx, Ty);
  tiltCmd = Math.max(-TILT_MAX, Math.min(TILT_MAX, tiltCmd));
  if (alt < 8 && landingRun) { tiltCmd = 0; }
  // climb clear of the ground before pitching over
  if (alt < 14 && !landingRun) { tiltCmd = Math.max(-0.15, Math.min(0.15, tiltCmd)); }

  const Tmag = Math.hypot(Tx, Ty);
  let throttle = Tmag / s.engine.thrust;

  /* Don't blast while pointing the wrong way — wait for the nose to come
   * round. Never during the final flare though: down there a tilted burn
   * still carries most of its thrust upward, and cutting it is a crash. */
  const err = normAngle(tiltCmd - s.ang);
  if (Math.abs(err) > 0.5 && !(landingRun && alt < 45)) { throttle *= 0.25; }

  out.rot = Math.max(-1, Math.min(1, err * 3));
  out.thrust = Math.max(0, Math.min(1, throttle));
  return out;
}
