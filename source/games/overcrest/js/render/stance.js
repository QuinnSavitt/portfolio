/* Overcrest — how the car stands on the ground.
 *
 * The sim gives us a body height, a chassis attitude, and the ground under
 * each of the four contact patches. Turning that into a car you can look at
 * is pure geometry, and it is geometry that is very easy to get backwards —
 * so it lives here, free of THREE and free of the DOM, where the headless
 * harness can check it against real matrices every run.
 *
 * The rule: the BODY rides its springs (it follows the plane through the
 * four patches, and dives and leans on top of that), and each WHEEL then
 * hangs wherever it must to keep its tyre on the deck. Bolt the wheels
 * rigidly to a leaning body and half of them are in the air on any road
 * with camber — which is exactly what a rally car must never look like.
 */

import { KESTREL } from "../sim/physics.js";

const KESTREL_DROOP = KESTREL.droop;

/* Suspension travel the eye is allowed to see: up into the arch, and down.
 * DROOP matches the sim's own `droop` — the extension at which the physics
 * says the wheels have left the ground — so what you see run out of travel
 * is the same event the car is feeling. */
export const BUMP = 0.13, DROOP = KESTREL_DROOP;

/* Body attitude as an XYZ Euler triple.
 *
 * Signs, because they cost an afternoon: a rotation about Z lifts +x by
 * +sin, so nose-up (+pitch, front of the car higher) is z = +pitch. A
 * rotation about X lowers +z by +sin, so right-side-high (+roll) is
 * x = -roll. Feed the raw values in and the body tilts AGAINST the
 * terrain — double the error, and two wheels permanently airborne.
 */
export function bodyEuler(car) {
  // rollSpin is the tumble (a rollover in progress) or the roof (π): the
  // wheels are children of the body, so the whole car goes over with it
  return { x: -(car.roll + (car.rollSpin || 0)), y: 0, z: car.pitch };
}

/* Height (in body space) at which a wheel pivot must sit so its tyre rests
 * on ground height `gy`, given the body's pose. `px`/`pz` are the wheel's
 * body-space offsets, `R` the tyre radius.
 *
 * The body maps a local point to world y as
 *   y = car.y + (px·sin p + h·cos p)·cos r + pz·sin r
 * so solving for h with y = gy + R is one line of algebra. Clamped to the
 * travel: past that the wheel really is off the ground, and it should look
 * like it. */
export function wheelLift(car, i, px, pz, R) {
  // ground under this corner: the sim probed all four this tick (car.wheelY,
  // in WHEELS order), so the renderer never re-samples the world
  const gy = car.wheelY && car.wheelY[i] != null ? car.wheelY[i] : car.y;
  const sp = Math.sin(car.pitch), cp = Math.cos(car.pitch);
  const sr = Math.sin(car.roll), cr = Math.cos(car.roll);
  const want = ((gy + R - car.y - pz * sr) / (cr || 1) - px * sp) / (cp || 1);
  return Math.max(R - BUMP, Math.min(R + DROOP, want));
}

/* True while a wheel is hanging at full droop — no load, nothing to kick up. */
export function airborneWheel(lift, R) {
  return lift >= R + DROOP - 1e-6;
}
