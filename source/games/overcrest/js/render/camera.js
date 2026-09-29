/* Overcrest — the chase camera.
 *
 * A camera you can live behind for hours: spring-damped position with a
 * road-aware lookahead (it reads the world, not just the car), speed-fed
 * FOV, a sideways lean that frames drifts, a dip on landings and a shake
 * that respects the reduced-motion setting. All smoothing is exponential
 * with explicit time constants — frame-rate independent.
 *
 * THE CUTS (2026-08-31, Quinn: "more cool camera events"). Five shots a
 * rally broadcast would make, each a few seconds, each cut hard in and
 * hard out: a TRACKSIDE camera on a safe straight the car drives past; a
 * BROW camera low beside the landing zone of a crest or jump; a REVEAL
 * from high and ahead when a landmark opens up; a BORDER pass, low and
 * close, as the new country arrives; and the ROLL, watched from the
 * verge. The road-safety rule is absolute: a cut only starts when the
 * road ahead is clear of anything the driver would need to see for the
 * whole shot, never near a waystation, never in a bore, never off the
 * road — and the roll excepted, never at all if the player turns them
 * off. Render-only: the sim never knows a shot happened.
 *
 * THE RARE ANGLES (2026-08-31 later, Quinn: "crane shots, drone shots,
 * shots under jumps — only when the moment earns it"). Three more, on a
 * long clock of their own so they stay events: a CRANE planted on the
 * valley side where the ground falls away, booming up as the car passes
 * so the drop fills the frame; a CHOPPER that overtakes high and to the
 * side through the run's best minutes (top-tier flow at speed), hovering
 * the way a helicopter does; and a FLYOVER lens lying past a jump's
 * landing, the car taking off toward it and passing over the top of the
 * frame. Each earns its moment (a real vista, a real jump, real flow) —
 * the cooldown alone keeps them rarer than the broadcast five.
 */

import * as THREE from "three";

export function makeChaseCam(camera, world) {
  const state = {
    pos: new THREE.Vector3(0, 4, -8),
    aim: new THREE.Vector3(0, 0, 0),
    fov: 62,
    dip: 0, dipV: 0,
    shake: 0,
    reducedMotion: false,
    initialized: false,
    mode: "chase",      // chase | orbit
    orbitT: 0,
    /* comfort (Phase 21, the bible's "Allow camera settings"): chase
     * distance/height preset multipliers and a cap on the speed-FOV
     * stretch for motion-sensitive players */
    distK: 1, upK: 1, fovCap: false,
    /* the cuts: a setting, a cooldown, and the shot in progress —
     * world-space points, because the render anchor rebases under us */
    cutsOn: true,
    cutCooldown: 6,
    shot: null,
    shots: 0,            // for telemetry / the debug line
    /* the crew's album: a still from each COMPLETED fixed shot this run
     * (main.js grabs the frame when wantStill goes up; an aborted or
     * crashed-out shot is film on the cutting room floor) */
    album: [],
    wantStill: false,
  };

  const wantPos = new THREE.Vector3();
  const wantAim = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  /* ------------------------------------------------------------- cuts */
  const CUT_KINDS = { trackside: 1, brow: 1, reveal: 1, border: 1, roll: 1, crane: 1, chopper: 1, flyover: 1, mirror: 1 };
  function hash01(a, b) {
    let h = (a | 0) ^ Math.imul(b | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  /* Is the road ahead free of anything the driver must see for `dist`
   * metres? Straight-ish, no notes (corners, brows, fords, bridges, the
   * waystation), and nothing already announced just behind. */
  function clearAhead(car, dist, allowBrowAt) {
    const s0 = car.s, s1 = car.s + dist;
    for (let d = 0; d <= dist; d += 8) {
      const smp = world.sampleNear(s0 + d);
      if (!smp || Math.abs(smp.curv) > 1 / 70) return false;
    }
    for (const n of world.notes) {
      const at = n.atS != null ? n.atS : n.s;
      if (at < s0 - 12 || at > s1) continue;
      if (allowBrowAt != null && Math.abs(at - allowBrowAt) < 1 && (n.kind === "crest" || n.kind === "jump" || n.feat)) continue;
      return false;
    }
    return true;
  }
  function browAhead(car) {
    // one crest/jump note 35–70 m ahead and nothing else for 170 m
    let brow = null;
    for (const n of world.notes) {
      const at = n.atS != null ? n.atS : n.s;
      const isBrow = n.kind === "crest" || n.kind === "jump" || n.feat === "crest" || n.feat === "jump";
      if (!isBrow || at < car.s + 35 || at > car.s + 70) continue;
      brow = at; break;
    }
    if (brow == null) return null;
    // padded since shots became required: the whole window plus change
    return clearAhead(car, 190, brow) ? brow : null;
  }
  /* a true JUMP (never a mere crest) 40–85 m out, with the whole flight
   * and the run-out clear — the flyover lens lies in the landing zone */
  function jumpAhead(car) {
    let jump = null;
    for (const n of world.notes) {
      const at = n.atS != null ? n.atS : n.s;
      const isJump = n.kind === "jump" || n.feat === "jump";
      if (!isJump || at < car.s + 40 || at > car.s + 85) continue;
      jump = at; break;
    }
    if (jump == null) return null;
    return clearAhead(car, 215, jump) ? jump : null;
  }
  /* does the ground fall away beside this stretch of road? (the crane's
   * licence: the boom is only worth it over a real drop) */
  function vistaSide(smpA, smpB) {
    for (const smp of [smpA, smpB]) {
      if (!smp) continue;
      const bx = -Math.sin(smp.heading), bz = Math.cos(smp.heading);
      for (const side of [-1, 1]) {
        const g = world.groundHeight(smp.x + bx * side * 52, smp.z + bz * side * 52, smp.s);
        if (g && !g.water && smp.y - g.y > 15) return side;
      }
    }
    return 0;
  }
  function seatAt(x, z, hintS, up) {
    const g = world.groundHeight(x, z, hintS);
    if (!g || g.water) return null;
    return g.y + up;
  }
  function startShot(kind, car, ctx, sh) {
    state.shot = Object.assign({ kind, t: 0, dur: 3.2, fov: 40, sEnd: 1e12 }, sh);
    /* the lead-in: the letterbox slides down HALF A SECOND before the cut
     * (mode flips now, so body.cut keys the bars; the chase keeps the
     * frame until t crosses zero). A cut that announces itself is a shot;
     * one that doesn't is an ambush (owner: "so sudden"). The roll and a
     * forced screenshot cut stay instant. */
    state.shot.t = -(kind === "roll" || state.cutForce ? 0 : 0.55);
    state.mode = "shot";
    state.shots++;
    // the Clapperboard (ctx.cutRate < 1) has the crew set up faster
    state.cutCooldown = (kind === "roll" ? 20 : 42 + hash01(ctx.seed, Math.floor(car.s)) * 30) * ((ctx && ctx.cutRate) || 1);
  }
  function endShot() {
    state.shot = null;
    state.mode = "chase";
    state.initialized = false;      // a hard cut back: no spring from the verge
    state.fovSnap = true;           // ...and no zoom-lerp after it: the lens cuts too
    state.aimY = null;
  }
  function maybeCut(car, dt, ctx) {
    state.cutCooldown = Math.max(0, state.cutCooldown - dt);
    // the rare angles' own long clock (they stay events, not wallpaper)
    if (state.rareCooldown == null) state.rareCooldown = 75;
    state.rareCooldown = Math.max(0, state.rareCooldown - dt);
    state.mirrorCooldown = Math.max(0, (state.mirrorCooldown || 0) - dt);
    if (!ctx || !ctx.allow) return;
    const v = Math.abs(car.vx);
    const fx = Math.cos(car.yaw), fz = Math.sin(car.yaw);
    const rx = -fz, rz = fx;                       // road-right of the car's heading
    /* the roll: the car is out of the driver's hands anyway, so the verge
     * gets to watch (a cooldown of its own; never twice in one tumble) */
    if (car.rollT > 0 && state.cutsOn && !state.rollSeen) {
      state.rollSeen = true;
      const side = car.d > 0 ? -1 : 1;
      const px = car.x - fx * 8 + rx * side * 6, pz = car.z - fz * 8 + rz * side * 6;
      const py = seatAt(px, pz, car.s, 2.4);
      if (py != null) { startShot("roll", car, ctx, { wx: px, wy: py, wz: pz, fov: 52, dur: 4.5 }); return; }
    }
    if (car.rollT <= 0) state.rollSeen = false;
    /* `?cut=now`: a trackside shot at once, safety rule and all be
     * damned — screenshots of a four-second thing need it held.
     * `?cut=crane|chopper|flyover` forces a rare angle the same way. */
    if (state.cutForce === "now" && v > 3) {
      const smp = world.sampleNear(car.s + 22 + v * 0.8);
      if (smp) {
        const bx = -Math.sin(smp.heading), bz = Math.cos(smp.heading);
        const px = smp.x + bx * (smp.hw + 5.5), pz = smp.z + bz * (smp.hw + 5.5);
        const py = seatAt(px, pz, smp.s, 1.6);
        if (py != null) { startShot("trackside", car, ctx, { wx: px, wy: py, wz: pz, gy: py - 1.6, fov: 38, dur: 6, sEnd: smp.s + 26, lift: 0.9 }); return; }
      }
    }
    if (state.cutForce === "chopper" && v > 3) {
      startShot("chopper", car, ctx, { follow: true, ox: -13, oxTo: 11, oy: 8.5, oz: 8.5, fov: 48, dur: 6.2, lead: 4, lift: 0.4, stillT: 3.6 });
      return;
    }
    if (state.cutForce === "crane" && v > 3) {
      const smp = world.sampleNear(car.s + 30 + v * 0.9);
      if (smp) {
        const bx = -Math.sin(smp.heading), bz = Math.cos(smp.heading);
        const px = smp.x + bx * (smp.hw + 7), pz = smp.z + bz * (smp.hw + 7);
        const py = seatAt(px, pz, smp.s, 1.8);
        if (py != null) { startShot("crane", car, ctx, { wx: px, wy: py, wz: pz, gy: py - 1.8, boom: 13, fov: 48, dur: 5.2, sEnd: smp.s + 36, lead: 6, lift: 0.9 }); return; }
      }
    }
    if (state.cutForce === "flyover" && v > 3) {
      const smp = world.sampleNear(car.s + 30 + v * 0.8);
      if (smp) {
        const bx = -Math.sin(smp.heading), bz = Math.cos(smp.heading);
        const px = smp.x + bx * 1.6, pz = smp.z + bz * 1.6;
        const py = seatAt(px, pz, smp.s, 0.55);
        // the lens lies near the line; the crew's marker stands on the verge
        const tx = smp.x + bx * (smp.hw + 2.6), tz = smp.z + bz * (smp.hw + 2.6);
        const tgy = seatAt(tx, tz, smp.s, 0);
        if (py != null) { startShot("flyover", car, ctx, { wx: px, wy: py, wz: pz, gy: py - 0.55, tx, tz, tgy: tgy != null ? tgy : py - 0.55, fov: 46, dur: 4.8, sEnd: smp.s + 5, lift: 1.1 }); return; }
      }
    }
    if (!state.cutsOn || (state.cutCooldown > 0 && !state.cutForce)) return;
    if (ctx.encl > 0.05 || Math.abs(car.d) > (ctx.hw || 3.5) + 0.5) return;
    if (ctx.legEndS != null && ctx.legEndS - car.s < 420) return;
    // a required shot still never STARTS in busy hands: no cut is called
    // while the driver is steering or braking (the roll above is exempt —
    // the car is out of their hands already; `?cut` screenshots bypass).
    // Once called, it runs: the abort went with the owner's pass six.
    if ((ctx.drive || 0) > 0.3 && !state.cutForce) return;
    /* the border pass: low, close, three-quarter rear — the car big in
     * frame and the new country opening ahead of it */
    if (ctx.border && v > 12 && clearAhead(car, v * 3.2 + 40)) {
      startShot("border", car, ctx, { ox: -6.6, oy: 1.15, oz: 3.9, fov: 58, dur: 3.0, follow: true });
      return;
    }
    /* the reveal: a landmark's banner just fired — high and ahead-left,
     * fixed, the car driving in under the camera toward the thing */
    if (ctx.landmark && v > 10 && clearAhead(car, v * 3.4 + 60)) {
      const px = car.x + fx * 26 - rx * ((ctx.hw || 3.5) + 9), pz = car.z + fz * 26 - rz * ((ctx.hw || 3.5) + 9);
      const py = seatAt(px, pz, car.s + 26, 8);
      if (py != null) { startShot("reveal", car, ctx, { wx: px, wy: py, wz: pz, gy: py - 8, fov: 62, dur: 3.2, lead: 12, sEnd: car.s + 26 + 34 }); return; }
    }
    /* THE MIRROR (the Sweep; owner: "I want to be able to see the sweep
     * car"): once the sweep car is close enough to SEE, a beat from ahead
     * looking back: your car, and behind it the beacons closing. Short,
     * follows the car, its own clock; never in the last few metres (that
     * shot is the orbit at the end). */
    if (ctx.sweepGap != null && ctx.sweepGap < 120 && ctx.sweepGap > 25 && v > 12
      && state.mirrorCooldown <= 0 && clearAhead(car, v * 3 + 40)) {
      state.mirrorCooldown = 45;
      startShot("mirror", car, ctx, { follow: true, ox: 9.5, oy: 2.3, oz: 2.6, fov: 54, dur: 2.6, lead: -14, lift: 0.9, stillT: 1.4 });
      return;
    }
    /* THE RARE ANGLES: their clock has run down AND the road is serving a
     * moment worth the crew. Each rolls its own seeded die on top, so a
     * long drive meets them out of rhythm; each pushes the clock well out
     * again. Most specific first. */
    if (state.rareCooldown <= 0 && v > 22) {
      /* under the jump: a true jump ahead at real speed — the lens lies
       * just off the line in the landing zone and the car flies over it */
      const jump = v > 27 ? jumpAhead(car) : null;
      if (jump != null && hash01(ctx.seed, Math.floor(jump) + 11) < 0.6) {
        const smp = world.sampleNear(jump + 15);
        if (smp) {
          const side = hash01(ctx.seed, Math.floor(jump) + 3) < 0.5 ? -1 : 1;
          const bx = -Math.sin(smp.heading), bz = Math.cos(smp.heading);
          const px = smp.x + bx * side * 1.6, pz = smp.z + bz * side * 1.6;
          const py = seatAt(px, pz, smp.s, 0.55);
          // the lens lies near the line; the crew's marker stands on the verge
          const tx = smp.x + bx * side * (smp.hw + 2.6), tz = smp.z + bz * side * (smp.hw + 2.6);
          const tgy = seatAt(tx, tz, smp.s, 0);
          if (py != null) {
            startShot("flyover", car, ctx, { wx: px, wy: py, wz: pz, gy: py - 0.55, tx, tz, tgy: tgy != null ? tgy : py - 0.55, fov: 46, dur: 4.8, sEnd: smp.s + 5, lift: 1.1 });
            state.rareCooldown = 140 + hash01(ctx.seed, Math.floor(car.s)) * 130;
            return;
          }
        }
      }
      /* the crane: the valley opens beside the road — the base plants on
       * the drop side and the boom rises with the car, so the fall fills
       * the bottom of the frame as it passes */
      if (hash01(ctx.seed, Math.floor(car.s / 120) + 31) < 0.4 && clearAhead(car, v * 4.2 + 60)) {
        const reachC = 30 + v * 0.9;
        const smpA = world.sampleNear(car.s + reachC), smpB = world.sampleNear(car.s + reachC + 26);
        const side = vistaSide(smpA, smpB);
        if (side !== 0 && smpA) {
          const bx = -Math.sin(smpA.heading), bz = Math.cos(smpA.heading);
          const px = smpA.x + bx * side * (smpA.hw + 7), pz = smpA.z + bz * side * (smpA.hw + 7);
          let py = seatAt(px, pz, smpA.s, 1.8);
          // on a true cliff side the ground at the base is a long way down:
          // hold the base within reach of the deck so the boom still clears it
          if (py != null && py < smpA.y - 6) py = smpA.y - 6;
          if (py != null) {
            startShot("crane", car, ctx, { wx: px, wy: py, wz: pz, gy: py - 1.8, boom: 13, fov: 48, dur: 5.2, sEnd: smpA.s + 36, lead: 6, lift: 0.9 });
            state.rareCooldown = 150 + hash01(ctx.seed, Math.floor(car.s) + 1) * 120;
            return;
          }
        }
      }
      /* the chopper: the run's best minutes from the air — top-tier flow
       * at speed, the camera overtaking high and to the side with a
       * helicopter's hover in it. Follows the car, so it constrains the
       * driver no more than the border pass does. */
      if ((ctx.tier || 0) >= 4 && v > 25
        && hash01(ctx.seed, Math.floor(car.s / 120) + 57) < 0.35 && clearAhead(car, v * 4.6 + 60)) {
        const side = hash01(ctx.seed, Math.floor(car.s / 120) + 63) < 0.5 ? -1 : 1;
        startShot("chopper", car, ctx, { follow: true, ox: -13, oxTo: 11, oy: 8.5, oz: side * 8.5, fov: 48, dur: 6.2, lead: 4, lift: 0.4, stillT: 3.6 });
        state.rareCooldown = 160 + hash01(ctx.seed, Math.floor(car.s) + 2) * 120;
        return;
      }
    }
    if (v < 19) return;
    // one honest roll per 90 m of road, deterministic per seed
    if (!state.cutForce && hash01(ctx.seed, Math.floor(car.s / 90)) > 0.34) return;
    /* the brow camera: low beside the landing zone, looking back up the
     * hill — the car leaves the ground in frame */
    const brow = browAhead(car);
    if (brow != null && v > 22) {
      const smp = world.sampleNear(brow + 32);
      if (smp) {
        const side = hash01(ctx.seed, Math.floor(brow)) < 0.5 ? -1 : 1;
        const bx = -Math.sin(smp.heading), bz = Math.cos(smp.heading);
        const px = smp.x + bx * side * (smp.hw + 4.2), pz = smp.z + bz * side * (smp.hw + 4.2);
        const py = seatAt(px, pz, smp.s, 1.3);
        if (py != null) { startShot("brow", car, ctx, { wx: px, wy: py, wz: pz, gy: py - 1.3, fov: 40, dur: 4.6, sEnd: brow + 44, lift: 0.5 }); return; }
      }
    }
    /* the trackside camera: the TV shot. A fixed point on the verge ahead,
     * a long lens; the car comes at it, fills the frame and is gone */
    const reach = 30 + v * 1.05;
    if (!clearAhead(car, reach + v * 1.7 + 40)) return;
    const smp = world.sampleNear(car.s + reach);
    if (!smp) return;
    const side = hash01(ctx.seed, Math.floor(car.s / 90) + 7) < 0.5 ? -1 : 1;
    const bx = -Math.sin(smp.heading), bz = Math.cos(smp.heading);
    const px = smp.x + bx * side * (smp.hw + 5.5), pz = smp.z + bz * side * (smp.hw + 5.5);
    const py = seatAt(px, pz, smp.s, 1.6);
    if (py == null) return;
    startShot("trackside", car, ctx, { wx: px, wy: py, wz: pz, gy: py - 1.6, fov: 38, dur: 4.4, sEnd: smp.s + 26, lift: 0.9 });
  }
  /* Run the shot: place the camera, aim it, count it down. Returns true
   * while the shot owns the frame. Positions are world-space and only
   * converted by the anchor at the end, so a rebase mid-shot costs nothing. */
  function runShot(car, anchor, dt, ctx) {
    const sh = state.shot;
    if (!sh) return false;
    sh.t += dt;
    // the lead-in (t < 0): bars sliding, chase still holding the frame.
    // The shot is REQUIRED once announced (owner: "even if braking or
    // turning") — the codriver call, the bars and the tripod are the
    // warning, and the seat's own safety rule keeps the window drivable.
    if (sh.t < 0) return false;
    /* the still: one frame per fixed shot, asked for at the peak — the car
     * close to the seat, or past the middle of the shot for the long ones.
     * main.js grabs the canvas the same frame and hangs it on sh.still. */
    if (!sh.stillAsked
      && ((sh.wx != null && sh.kind !== "roll" && (Math.hypot(sh.wx - car.x, sh.wz - car.z) < 20 || sh.t > sh.dur * 0.55))
        || (sh.stillT != null && sh.t > sh.stillT))) {
      sh.stillAsked = true;
      sh.stillS = car.s;
      state.wantStill = true;
    }
    const passed = car.s > sh.sEnd;
    const over = sh.t > sh.dur || passed
      || (sh.kind === "roll" && car.rollT <= 0 && sh.t > 1.2);
    if (over) {
      // the crew got it: the still goes in the album, and the game layer
      // hears about it (main polls shotDone; crew souvenirs hook it)
      if (sh.still && state.album.length < 12) state.album.push({ kind: sh.kind, s: sh.stillS, img: sh.still });
      state.shotDone = { kind: sh.kind };
      endShot();
      return false;
    }
    const fx = Math.cos(car.yaw), fz = Math.sin(car.yaw);
    let px, py, pz;
    if (sh.follow) {
      // car-relative (the border pass, the chopper): the offset rides the
      // car's frame; the chopper's offset moves (it overtakes) and hovers
      let ox = sh.ox, oy = sh.oy, oz = sh.oz;
      if (sh.oxTo != null) {
        const u = Math.min(1, Math.max(0, sh.t / sh.dur));
        ox = sh.ox + (sh.oxTo - sh.ox) * (u * u * (3 - 2 * u));
        oy += Math.sin(sh.t * 1.3) * 0.5;
        oz += Math.cos(sh.t * 0.8) * 0.7;
      }
      const rx = -fz, rz = fx;
      px = car.x + fx * ox + rx * oz; pz = car.z + fz * ox + rz * oz; py = car.y + oy;
      const gy = seatAt(px, pz, car.s, 0.8);
      if (gy != null && py < gy) py = gy;
    } else {
      px = sh.wx; py = sh.wy; pz = sh.wz;
      // the crane: the base is planted, the boom rises through the shot
      if (sh.boom) {
        const u = Math.min(1, Math.max(0, sh.t / sh.dur));
        py += sh.boom * u * u * (3 - 2 * u);
      }
    }
    wantPos.set(px - anchor.x, py, pz - anchor.z);
    const lead = sh.lead || 0;
    wantAim.set(car.x - anchor.x + fx * lead, car.y + (sh.lift != null ? sh.lift : 0.7), car.z - anchor.z + fz * lead);
    // the first frame is a true cut: position, aim AND the lens snap
    if (sh.t <= dt * 1.5) { state.pos.copy(wantPos); state.aim.copy(wantAim); state.fov = sh.fov; state.initialized = true; }
    // a fixed camera pans, it does not drift: the position is exact, the
    // aim follows the car with a camera operator's small lag
    state.pos.lerp(wantPos, sh.follow ? 1 - Math.exp(-dt * 10) : 1);
    state.aim.lerp(wantAim, 1 - Math.exp(-dt * 9));
    camera.position.copy(state.pos);
    camera.lookAt(state.aim);
    camera.rotation.z += sh.follow ? car.roll * 0.15 : 0;
    // a long lens breathes in as the car nears (trackside/brow/flyover —
    // the crane is a wide and holds its focal length while the boom rises)
    let fov = sh.fov;
    if (!sh.follow && sh.kind !== "roll" && sh.kind !== "reveal" && sh.kind !== "crane") {
      const d = Math.hypot(px - car.x, pz - car.z);
      fov = sh.fov + Math.max(0, 18 - d) * 0.9;
    }
    state.fov += (fov - state.fov) * (1 - Math.exp(-dt * 6));
    camera.fov = state.fov;
    camera.updateProjectionMatrix();
    return true;
  }

  function onLanded(impact) {
    state.dipV -= Math.min(3.5, impact * 0.35);
  }
  function onImpact(impact) {
    state.shake = Math.min(1, state.shake + impact * 0.045);
  }

  function update(car, anchor, dt, ctx) {
    const v = Math.abs(car.vx);

    // the cuts: decide from chase, run from shot (see the header)
    if (state.mode === "chase") maybeCut(car, dt, ctx);
    if (state.mode === "shot" && runShot(car, anchor, dt, ctx)) return;

    /* Debug: a high, pulled-back view of the car in its surroundings.
     * The chase cam sits half a metre above the deck by design, which is
     * exactly the wrong place from which to judge whether a structure
     * beside the road is the shape you think it is. */
    if (state.mode === "high") {
      const fx = Math.cos(car.yaw), fz = Math.sin(car.yaw);
      const lx = Math.sin(car.yaw), lz = -Math.cos(car.yaw);
      const back = state.highDist || 34, up = state.highUp || 20, side = state.highSide || 16;
      wantPos.set(car.x - anchor.x - fx * back + lx * side, car.y + up, car.z - anchor.z - fz * back + lz * side);
      wantAim.set(car.x - anchor.x + fx * 12, car.y + 1, car.z - anchor.z + fz * 12);
      if (!state.initialized) { state.pos.copy(wantPos); state.aim.copy(wantAim); state.initialized = true; }
      state.pos.lerp(wantPos, 1 - Math.exp(-dt * 3));
      state.aim.lerp(wantAim, 1 - Math.exp(-dt * 4));
      camera.position.copy(state.pos);
      camera.lookAt(state.aim);
      camera.fov = state.fov = 58;
      camera.updateProjectionMatrix();
      return;
    }

    if (state.mode === "orbit") {
      // waystation: a slow drift along the road side of the parked car (the
      // building is on its right), from behind-left round to front-left
      state.orbitT += dt;
      const phi = 2.35 - 1.5 * (0.5 - 0.5 * Math.cos(state.orbitT * 0.16));   // 2.35 → 0.85 → back
      const r = 8.2, h = 2.4;
      const fx = Math.cos(car.yaw), fz = Math.sin(car.yaw);
      const lx = Math.sin(car.yaw), lz = -Math.cos(car.yaw);          // left of travel
      const ox = fx * Math.cos(phi) * r + lx * Math.sin(phi) * r;
      const oz = fz * Math.cos(phi) * r + lz * Math.sin(phi) * r;
      wantPos.set(car.x - anchor.x + ox, car.y + h, car.z - anchor.z + oz);
      const g0 = world.groundHeight(car.x + ox, car.z + oz, car.s);
      if (g0 && wantPos.y < g0.y + 1.2) wantPos.y = g0.y + 1.2;
      wantAim.set(car.x - anchor.x, car.y + 0.9, car.z - anchor.z);
      if (!state.initialized) { state.pos.copy(wantPos); state.aim.copy(wantAim); state.initialized = true; }
      const k = 1 - Math.exp(-dt * 1.6);
      state.pos.lerp(wantPos, k);
      state.aim.lerp(wantAim, 1 - Math.exp(-dt * 3));
      camera.position.copy(state.pos);
      camera.lookAt(state.aim);
      state.fov += (54 - state.fov) * (1 - Math.exp(-dt * 2));
      camera.fov = state.fov;
      camera.updateProjectionMatrix();
      return;
    }

    /* CHASE. The camera lives on the ROAD, not behind the car's velocity:
     * its anchor is the road point `dist` metres back along the centreline,
     * offset sideways by (a portion of) the car's own lateral position, and
     * its height comes from the ROAD SURFACE there. That is what "adapts to
     * terrain" means — over a crest the camera rides the crest, in a cutting
     * it stays in the cutting, and it never sits on a hillside behind a
     * corner and gets thrown skyward by the clip rule. When the car jumps,
     * the camera stays with the road and the car rises in frame by itself.
     * A car-relative point is blended in so slides still read as angular. */
    const fwdX = Math.cos(car.yaw), fwdZ = Math.sin(car.yaw);
    const dist = (6.6 + v * 0.05) * state.distK;
    const height = (2.3 + v * 0.012) * state.upK;
    const here = world.sampleNear(car.s);
    const back = world.sampleNear(car.s - dist);
    const roadHere = here ? here.y : car.y;

    // aim: down the ROAD ahead — not the nose. In a slide the nose swings
    // 20–40° and an aim that follows it whips the whole view; the road is
    // where you are going, and the car yaws in frame, which is the point.
    // Aim height is smoothed so brows do not pitch the view.
    const lookS = car.s + 12 + v * 0.55;
    const smp = world.sampleNear(lookS);
    if (smp) wantAim.set(smp.x - anchor.x, smp.y + 1.0, smp.z - anchor.z);
    else wantAim.set(car.x - anchor.x + fwdX * 24, car.y + 1.0, car.z - anchor.z + fwdZ * 24);
    tmp.set(car.x - anchor.x + fwdX * 18, car.y + 1.0, car.z - anchor.z + fwdZ * 18);
    // ...unless the car has left the road: then the road ahead is not where
    // you are going, the car's nose is (state.offRoad is set below, one
    // frame stale — fine, it is a blend)
    wantAim.lerp(tmp, 0.12 + 0.75 * (state.offRoad || 0));
    state.aimY = state.aimY == null ? wantAim.y : state.aimY + (wantAim.y - state.aimY) * (1 - Math.exp(-dt * 3));
    wantAim.y = state.aimY;

    if (back && here) {
      // road-anchored position: behind along the road, carrying the car's
      // lateral offset (clamped to the corridor) so it stays behind the car
      const rx = -Math.sin(back.heading), rz = Math.cos(back.heading);
      const lat = Math.max(-(back.hw + 2.5), Math.min(back.hw + 2.5, car.d)) * 0.85;
      const px = back.x + rx * lat, pz = back.z + rz * lat;
      // car-relative point behind the velocity direction (drift framing)
      const velYaw = v > 4 ? car.yaw + Math.atan2(car.vy, car.vx) * 0.5 : car.yaw;
      const cx = car.x - Math.cos(velYaw) * dist, cz = car.z - Math.sin(velYaw) * dist;
      /* off the road entirely (verges, run-off): the road anchor stops
       * meaning anything, so the camera goes fully car-relative, and fast
       * — the old half-blend over eight metres left it dawdling on the
       * verge while the car crossed a field (owner: "the camera fails to
       * keep up with the car"). Blends over four metres, all the way. */
      const offRoad = Math.max(0, Math.min(1, (Math.abs(car.d) - here.hw - 1.5) / 4));
      state.offRoad = offRoad;
      const w = 0.35 + 0.65 * offRoad;   // share of car-relative point
      wantPos.set(
        (px * (1 - w) + cx * w) - anchor.x,
        (roadHere * (1 - offRoad) + car.y * offRoad) + height,
        (pz * (1 - w) + cz * w) - anchor.z
      );
    } else {
      wantPos.set(car.x - anchor.x - fwdX * dist, car.y + height, car.z - anchor.z - fwdZ * dist);
    }
    // never below the ground under it (rare now); resolve by lifting a little
    const gCam = world.groundHeight(wantPos.x + anchor.x, wantPos.z + anchor.z, car.s - dist);
    if (gCam && wantPos.y < gCam.y + 0.9) wantPos.y = gCam.y + 0.9;

    if (!state.initialized) {
      state.pos.copy(wantPos);
      state.aim.copy(wantAim);
      state.initialized = true;
    }

    // springs: position follows firmly (it should never feel left behind),
    // a little firmer still at speed; aim snappy
    const kPos = 1 - Math.exp(-dt * (6 + v * 0.06 + 5 * (state.offRoad || 0)));
    const kAim = 1 - Math.exp(-dt * 12);
    state.pos.lerp(wantPos, kPos);
    state.aim.lerp(wantAim, kAim);

    // landing dip: a damped spring on camera height
    state.dipV += (-state.dip * 60 - state.dipV * 9) * dt;
    state.dip += state.dipV * dt;

    // impact shake
    state.shake *= Math.exp(-dt * 3.2);
    let sx = 0, sy = 0;
    if (state.shake > 0.003 && !state.reducedMotion) {
      const t = performance.now() * 0.05;
      sx = Math.sin(t * 1.7) * state.shake * 0.4;
      sy = Math.cos(t * 2.3) * state.shake * 0.3;
    }

    camera.position.set(state.pos.x + sx, state.pos.y + (state.reducedMotion ? 0 : state.dip) + sy, state.pos.z);
    camera.lookAt(state.aim);
    // subtle roll with the car — sells the lean without nauseating
    camera.rotation.z += car.roll * 0.1;

    // FOV: speed + boost stretch — cappable for motion-sensitive players
    let wantFov = 60 + v * 0.28 + (car.boosting ? 5 : 0);
    if (state.fovCap) wantFov = Math.min(64, wantFov);
    if (state.fovSnap) { state.fov = wantFov; state.fovSnap = false; }
    state.fov += (wantFov - state.fov) * (1 - Math.exp(-dt * 4));
    camera.fov = state.fov;
    camera.updateProjectionMatrix();
  }

  function setMode(m) {
    if (m !== state.mode) {
      // a mode change from outside (waystation orbit, depart) drops any shot
      state.shot = null;
      state.mode = m; state.orbitT = 0;
      if (m === "chase") state.initialized = false;
    }
  }
  function inShot() { return state.mode === "shot" ? state.shot.kind : null; }
  /* the render anchor snapped by (dx, dz): every smoothed render-space
   * point must move with it, or the camera springs 256 m and back */
  function rebase(dx, dz) {
    state.pos.x -= dx; state.pos.z -= dz;
    state.aim.x -= dx; state.aim.z -= dz;
  }
  /* for telemetry: how far/high the camera sits and how far it looks off
   * the car's heading */
  function info(car, anchor) {
    const dx = camera.position.x - (car.x - anchor.x), dz = camera.position.z - (car.z - anchor.z);
    const camYaw = Math.atan2(state.aim.z - camera.position.z, state.aim.x - camera.position.x);
    let e = (camYaw - car.yaw) * 57.3; while (e > 180) e -= 360; while (e < -180) e += 360;
    return { dist: Math.hypot(dx, dz), up: camera.position.y - car.y, yawErr: e };
  }
  return { update, onLanded, onImpact, setMode, rebase, info, inShot, state };
}
