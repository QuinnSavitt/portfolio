/* Daily Rocket — flight simulation.
 *
 * Fixed 1/120 s timestep, integrated independently of rendering. Given the
 * same day and the same input timeline the result is bit-identical, which is
 * what makes scores comparable and lets the generator machine-verify days.
 *
 * Frame: +x downrange, +y up. `ang` is tilt from vertical in radians,
 * positive leaning right (downrange), so the body axis is (sin a, cos a).
 *
 * Input per tick: { rot: -1..1, thrust: 0..1 }. The player maps buttons onto
 * that (BURN = 1, EASE = just-below-hover); the bot passes analog values.
 * Rotation is rate-command — releasing the stick kills the spin. The old
 * game's torque-and-pray model was realistic and miserable; this is neither.
 */

import { noise1d, hash32 } from "./daily.js";

export const DT = 1 / 120;
export const MAX_TICKS = 120 * 300; // 5 minute hard stop

export const HULL_MASS = 320;   // kg, includes tank + legs
export const TANK_CAP = 420;    // kg of propellant at 100 % load
export const DRAG_AREA = 1.2;   // Cd*A, m^2
export const MAX_RATE = 1.8;    // rad/s commanded rotation rate
export const ROT_RESP = 9;      // 1/s, how fast the rate loop converges

export const V_LAND = 5.0;      // max vertical touchdown speed, m/s
export const H_LAND = 3.0;      // max horizontal touchdown speed, m/s
export const TILT_LAND = 0.26;  // max touchdown tilt, rad (~15 deg)
export const SLOPE_MAX = 0.18;  // steepest ground that counts as standable

export const BEACON_R = 30;     // collect radius, m

/* Three engines, three personalities. Sparrow cannot even lift a full tank
 * off a heavy world — that is the loadout puzzle, not a bug. */
export const ENGINES = {
  sparrow: {
    id: "sparrow", name: "Sparrow", mass: 90, thrust: 7500, flow: 2.6,
    blurb: "Light and frugal. Weak — mind your fuel load on heavy worlds."
  },
  kestrel: {
    id: "kestrel", name: "Kestrel", mass: 160, thrust: 12000, flow: 4.8,
    blurb: "The all-rounder. Honest thrust, honest burn rate."
  },
  mule: {
    id: "mule", name: "Mule", mass: 260, thrust: 20000, flow: 9.5,
    blurb: "Brute force. Heavy, thirsty, and never short of push."
  }
};

// body geometry (metres) — used by collision, renderer and camera
export const BODY = { halfH: 3.4, footX: 1.7, radius: 1.1 };

export function windAt(day, t) {
  const w = day.world;
  if (w.rho0 <= 0) { return 0; }
  const slow = noise1d(t * 0.16, day.gustSeed);
  const fast = noise1d(t * 0.9, day.gustSeed ^ 0x9e3779b9);
  return w.wind * w.windDir + w.gust * (slow * 0.8 + fast * 0.3);
}

export function makeShip(day, loadout) {
  const eng = ENGINES[loadout.engine] || ENGINES.kestrel;
  const fuel = TANK_CAP * Math.max(0.15, Math.min(1, loadout.fuelFrac));
  const s = {
    day, engine: eng, fuelLoaded: fuel,
    x: 0, y: 0, vx: 0, vy: 0, ang: 0, angVel: 0,
    throttle: 0, fuel, fuelBurned: 0,
    t: 0, tick: 0,
    resting: true, everFlew: false, flamedOut: false, unpinnedAt: -1,
    beacons: day.beacons.map(() => false), collected: 0,
    touchdowns: 0, maxAlt: 0, maxSpeed: 0,
    done: false, outcome: null, message: "", success: false,
    landing: null, events: []
  };
  s.y = day.terrain.heightAt(0) + BODY.halfH;
  return s;
}

export function shipMass(s) {
  return HULL_MASS + s.engine.mass + Math.max(0, s.fuel);
}

/* Throttle that exactly cancels gravity right now — the EASE assist and the
 * bot both lean on this. Clamped so a weak engine simply gives its all. */
export function hoverThrottle(s) {
  const need = shipMass(s) * s.day.world.g;
  return Math.max(0, Math.min(1, need / s.engine.thrust));
}

export function altitude(s) {
  const t = s.day.terrain;
  const sa = Math.sin(s.ang), ca = Math.cos(s.ang);
  const fy1 = s.y - ca * BODY.halfH - sa * BODY.footX;
  const fy2 = s.y - ca * BODY.halfH + sa * BODY.footX;
  const fx1 = s.x - sa * BODY.halfH + ca * BODY.footX;
  const fx2 = s.x - sa * BODY.halfH - ca * BODY.footX;
  return Math.min(fy1 - t.heightAt(fx1), fy2 - t.heightAt(fx2));
}

function finish(s, outcome, message) {
  s.done = true;
  s.outcome = outcome;
  s.message = message;
  s.success = outcome === "landed";
  s.events.push({ type: outcome === "crash" ? "explosion" : "finish", x: s.x, y: s.y });
}

function tryTouchdown(s) {
  const d = s.day, t = d.terrain;
  const speedV = Math.abs(s.vy);
  const speedH = Math.abs(s.vx - 0); // ground is not moving, wind is air only
  const tilt = Math.abs(normAngle(s.ang));
  const slope = t.slopeAt(s.x);
  const impact = Math.hypot(s.vx, s.vy);

  const dx = s.x - d.pad.x;
  const onPad = Math.abs(dx) <= d.pad.halfW;
  const onLaunch = Math.abs(s.x) <= 90;

  s.landing = {
    vertical: s.vy, horizontal: s.vx, speed: impact,
    tilt, distance: dx, onPad
  };

  if (tilt > TILT_LAND) {
    finish(s, "crash", "Came down at " + Math.round(tilt * 57.3) + "° of tilt and went over.");
    return;
  }
  if (speedV > V_LAND || speedH > H_LAND) {
    finish(s, "crash", speedV > V_LAND * 2.2
      ? "Hit the ground at " + impact.toFixed(1) + " m/s. Nothing survived."
      : "Touched down at " + impact.toFixed(1) + " m/s — too hot. It broke apart.");
    return;
  }
  if (!onPad && !onLaunch && Math.abs(slope) > SLOPE_MAX) {
    finish(s, "crash", "Set down on a " + Math.round(Math.atan(Math.abs(slope)) * 57.3) +
      "° slope. It slid and tipped.");
    return;
  }

  // A survivable touchdown. Pin to the ground.
  s.touchdowns++;
  s.resting = true;
  s.vx = 0; s.vy = 0; s.angVel = 0;
  s.y = t.heightAt(s.x) + BODY.halfH;
  s.events.push({ type: "touchdown", x: s.x, y: s.y, speed: impact, onPad });

  if (onPad) {
    finish(s, "landed", "Payload delivered.");
  }
  // Off-pad and intact: the run continues — relight and fly on.
}

export function step(s, input) {
  if (s.done) { return; }
  const d = s.day, w = d.world;

  // ---- throttle spool: fast up, faster down
  const want = Math.max(0, Math.min(1, input.thrust || 0));
  const dth = want - s.throttle;
  s.throttle += Math.max(-DT * 10, Math.min(DT * 5, dth));
  if (s.throttle < 0.02 && want <= 0) { s.throttle = 0; }

  const m = shipMass(s);
  let burning = 0;

  if (s.throttle > 0.02 && s.fuel > 0) {
    burning = s.throttle;
    const used = Math.min(s.fuel, s.engine.flow * s.throttle * DT);
    s.fuel -= used;
    s.fuelBurned += used;
    if (s.fuel <= 0 && !s.flamedOut) {
      s.flamedOut = true;
      s.events.push({ type: "flameout", x: s.x, y: s.y });
    }
  } else if (s.fuel <= 0) {
    burning = 0;
  }
  s.burning = s.fuel > 0 ? burning : 0;

  // ---- resting on the ground: pinned until thrust actually beats weight
  if (s.resting) {
    s.ang += (0 - s.ang) * Math.min(1, DT * 4);
    s.angVel = 0;
    s.vx = 0; s.vy = 0;
    s.y = d.terrain.heightAt(s.x) + BODY.halfH;
    const T = s.burning * s.engine.thrust;
    if (T > m * w.g * 1.02) {
      s.resting = false;
      s.everFlew = true;
      s.unpinnedAt = s.tick;
      s.events.push({ type: "liftoff", x: s.x, y: s.y });
    } else {
      s.t += DT; s.tick++;
      if (s.fuel <= 0) {
        finish(s, "stranded", s.everFlew
          ? "Out of fuel on the ground, short of the pad."
          : "Burned the whole tank without beating gravity. Lighter load or bigger engine.");
      } else if (s.tick > MAX_TICKS) {
        finish(s, "timeout", "Mission clock expired.");
      }
      return;
    }
  }

  // ---- rotation: rate command with convergence lag
  const rot = Math.max(-1, Math.min(1, input.rot || 0));
  const targetRate = rot * MAX_RATE;
  s.angVel += (targetRate - s.angVel) * Math.min(1, DT * ROT_RESP);
  s.ang += s.angVel * DT;

  // ---- forces
  const ux = Math.sin(s.ang), uy = Math.cos(s.ang);
  let fx = 0, fy = -m * w.g;

  const T = s.burning * s.engine.thrust;
  fx += ux * T;
  fy += uy * T;

  if (w.rho0 > 0) {
    const rho = w.rho0 * Math.exp(-Math.max(0, s.y) / w.scaleH);
    const wind = windAt(d, s.t);
    const rvx = s.vx - wind, rvy = s.vy;
    const sp = Math.hypot(rvx, rvy);
    if (sp > 0.01) {
      const Fd = 0.5 * rho * DRAG_AREA * sp * sp;
      fx -= (rvx / sp) * Fd;
      fy -= (rvy / sp) * Fd;
    }
  }

  // ---- integrate (semi-implicit Euler)
  s.vx += (fx / m) * DT;
  s.vy += (fy / m) * DT;
  s.x += s.vx * DT;
  s.y += s.vy * DT;

  s.t += DT; s.tick++;

  const alt = altitude(s);
  s.maxAlt = Math.max(s.maxAlt, alt);
  s.maxSpeed = Math.max(s.maxSpeed, Math.hypot(s.vx, s.vy));

  // ---- beacons
  for (let i = 0; i < d.beacons.length; i++) {
    if (s.beacons[i]) { continue; }
    const b = d.beacons[i];
    const bx = s.x - b.x, by = s.y - b.y;
    if (bx * bx + by * by < BEACON_R * BEACON_R) {
      s.beacons[i] = true;
      s.collected++;
      s.events.push({ type: "beacon", x: b.x, y: b.y, index: i });
    }
  }

  // ---- ground contact
  if (alt <= 0) {
    /* Right after liftoff the feet are still kissing the ground; without a
     * grace window the first tick of climb "lands" again and the vehicle
     * sits there re-pinning itself forever. */
    const grace = s.unpinnedAt >= 0 && s.tick - s.unpinnedAt < 90;
    if (grace) {
      if (alt < -0.2) { s.y += -alt - 0.2; }
      if (s.vy < 0) { s.vy = 0; }
    } else if (s.vy <= 0.5) {
      tryTouchdown(s);
    } else { // scraping the ground while moving up — clip the worst of it
      s.y += -alt + 0.01;
    }
    if (s.done) { return; }
  }

  // ---- bounds
  if (s.x < -350 || s.x > d.extent - 60) {
    finish(s, "lost", "Vehicle left the mission area.");
  } else if (s.y - d.terrain.heightAt(s.x) > 6000) {
    finish(s, "lost", "Vehicle left the mission area — that way is space.");
  } else if (s.tick > MAX_TICKS) {
    finish(s, "timeout", "Mission clock expired.");
  }
}

export function normAngle(a) {
  while (a > Math.PI) { a -= Math.PI * 2; }
  while (a < -Math.PI) { a += Math.PI * 2; }
  return a;
}
