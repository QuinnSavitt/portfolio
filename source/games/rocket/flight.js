/* Daily Rocket - flight simulation.
 *
 * Fixed 1/120 s timestep, integrated independently of rendering. Given the
 * same design and the same input timeline the result is bit-identical, which
 * is what makes the scoreboard meaningful.
 *
 * Frame: +x downrange, +y up. `ang` is the vehicle's tilt from vertical in
 * radians, positive clockwise, so the body axis is (sin a, cos a).
 */
(function (global) {
  "use strict";

  var DT = 1 / 120;
  var MAX_STEPS = 120 * 300; // 5 minute hard stop

  function Sim(daily, design) {
    this.daily = daily;
    this.design = design;
    this.reset();
  }

  Sim.prototype.reset = function () {
    var d = this.daily;
    var P = global.DRParts;

    this.stageList = P.stages(this.design);
    this.stageIndex = 0;
    this.alive = [];
    for (var i = 0; i < this.design.stack.length; i++) { this.alive.push(i); }

    this.refresh();

    var a = this.geom;
    this.x = 0;
    this.y = d.terrain.launchY + (a.height / 2) - a.base + 0.05;
    this.vx = 0;
    this.vy = 0;
    this.ang = 0;
    this.angVel = 0;

    this.fuel = a.fuelCapacity;
    this.solid = a.solidFuel;
    this.rcsFuel = a.rcsFuel;
    this.throttle = 0;
    this.solidLit = false;
    this.chuteOut = false;
    this.chuteDeployTime = 0;

    this.t = 0;
    this.steps = 0;
    this.done = false;
    this.outcome = null;
    this.fuelUsed = 0;
    this.launchMass = a.wetMass;
    this.fuelCapacityTotal = a.fuelCapacity + a.solidFuel;
    this.maxAlt = 0;
    this.maxQ = 0;
    this.debris = [];
    this.events = [];
    this.trail = [];
    this.effects = [];
    this.lastTrail = 0;
    this.liftedOff = false;
    this.controlAuthority = 0;
  };

  // Recompute mass properties for whatever is still attached.
  Sim.prototype.refresh = function () {
    this.geom = global.DRParts.analyse(this.design, this.daily.mission.payload, this.alive);
  };

  Sim.prototype.mass = function () {
    return this.geom.dryMass + Math.max(0, this.fuel) + Math.max(0, this.solid) + Math.max(0, this.rcsFuel);
  };

  Sim.prototype.inertia = function () {
    var m = this.mass();
    var h = this.geom.height;
    return (m * (h * h + this.geom.width * this.geom.width)) / 12;
  };

  Sim.prototype.density = function (y) {
    var w = this.daily.world;
    if (w.rho0 <= 0) { return 0; }
    return w.rho0 * Math.exp(-Math.max(0, y) / w.scaleH);
  };

  Sim.prototype.altitude = function () {
    return this.y - (this.geom.height / 2) + this.geom.base - this.daily.terrain.heightAt(this.x);
  };

  Sim.prototype.basePoint = function () {
    var half = this.geom.height / 2 - this.geom.base;
    return {
      x: this.x - Math.sin(this.ang) * half,
      y: this.y - Math.cos(this.ang) * half
    };
  };

  /* One physics tick. `input` is {rotate:-1..1, throttle:0..1, stage:bool,
   * action:bool} sampled once per tick so replays are exact. */
  Sim.prototype.step = function (input) {
    if (this.done) { return; }
    var d = this.daily, w = d.world, a = this.geom;

    if (input.stage) { this.doStage(); }
    if (input.action) { this.doAction(); }

    this.throttle = Math.max(0, Math.min(1, input.throttle));

    var m = this.mass();
    var I = this.inertia();
    var up = { x: Math.sin(this.ang), y: Math.cos(this.ang) };

    var fx = 0, fy = 0, torque = 0;

    // --- gravity
    fy -= m * w.g;

    // --- liquid engines
    var burning = 0;
    if (a.thrust > 0 && this.fuel > 0) {
      var th = this.throttle;
      if (th > 0 && th < a.minThrottle) { th = a.minThrottle; }
      if (th > 0) {
        var rho = this.density(this.y);
        var eff = 1 + (a.vacBonus || 0.05) * (1 - Math.min(1, rho / Math.max(0.001, w.rho0 || 1)));
        var T = a.thrust * th * (w.rho0 > 0 ? eff : 1.06);
        fx += up.x * T;
        fy += up.y * T;
        var used = a.flow * th * DT;
        used = Math.min(used, this.fuel);
        this.fuel -= used;
        this.fuelUsed += used;
        burning = th;
      }
    } else {
      this.throttle = a.thrust > 0 ? this.throttle : 0;
    }

    // --- solid boosters: light on first stage command, burn until empty
    if (this.solidLit && this.solid > 0 && a.solidThrust > 0) {
      fx += up.x * a.solidThrust;
      fy += up.y * a.solidThrust;
      var sused = Math.min(a.solidFlow * DT, this.solid);
      this.solid -= sused;
      this.fuelUsed += sused;
      burning = Math.max(burning, 1);
    }

    // --- atmosphere
    var rho2 = this.density(this.y);
    var wind = w.wind * w.windDir;
    var rvx = this.vx - wind;
    var rvy = this.vy;
    var speed = Math.sqrt(rvx * rvx + rvy * rvy);
    var q = 0.5 * rho2 * speed * speed;
    this.maxQ = Math.max(this.maxQ, q);

    if (rho2 > 0 && speed > 0.01) {
      var dirx = rvx / speed, diry = rvy / speed;

      // Angle of attack: angle between where we point and where we're going.
      // Sign tells us which way the airflow wants to rotate the vehicle.
      var dot = up.x * dirx + up.y * diry;
      var cross = up.x * diry - up.y * dirx;
      var aoa = Math.atan2(cross, dot);

      // Body drag grows with how side-on we are.
      var side = Math.abs(Math.sin(aoa));
      var area = a.dragArea * (1 + 2.6 * side);
      var Fd = q * area;
      fx -= dirx * Fd;
      fy -= diry * Fd;

      // Fins act behind the centre of mass -> restoring torque toward prograde.
      if (a.finArea > 0) {
        var arm = (a.com - a.finArm);
        var finForce = q * a.finArea * 2.2 * Math.sin(aoa);
        torque -= finForce * Math.max(0.6, Math.abs(arm)) * (arm >= 0 ? 1 : -1);
        torque -= this.angVel * q * a.finArea * 0.9; // aerodynamic damping
      }

      // Bare bodies are slightly unstable: pressure acts ahead of the CoM, so
      // any angle of attack is amplified. This is what flips finless designs.
      var bodyArm = (a.height * 0.5) - a.com;
      torque += q * a.dragArea * 0.55 * Math.sin(aoa) * bodyArm * 0.35;

      if (this.chuteOut) {
        var deploy = Math.min(1, (this.t - this.chuteDeployTime) / 1.4);
        var Fc = q * a.chuteArea * deploy;
        fx -= dirx * Fc;
        fy -= diry * Fc;
        torque -= this.angVel * 260 * deploy;
        // a chute always pulls the nose prograde
        torque -= Math.sin(aoa) * Fc * 0.9;
      }
    }

    // --- attitude control: gimbal while burning, RCS otherwise
    var rot = Math.max(-1, Math.min(1, input.rotate));
    var authority = 0;
    if (rot !== 0) {
      /* Avionics reaction wheel. Deliberately feeble - scaled to inertia so it
       * gives the same lazy 0.18 rad/s^2 on any vehicle. It exists so a coasting
       * rocket is never completely dead-stick; anyone who wants to actually
       * point the thing carries RCS or keeps an engine lit. */
      authority += 0.18 * I;
      if (burning > 0 && a.gimbal > 0) {
        authority += a.gimbal * Math.max(0.35, burning);
      }
      if (a.rcsTorque > 0 && this.rcsFuel > 0) {
        authority += a.rcsTorque;
        this.rcsFuel = Math.max(0, this.rcsFuel - a.rcsFlow * DT);
      }
      torque += rot * authority;
    }
    this.controlAuthority = authority;

    // gentle rotational drag so the vehicle isn't a spinning top forever
    torque -= this.angVel * m * 0.05;

    // --- integrate (semi-implicit Euler, fixed dt)
    var ax = fx / m, ay = fy / m;
    this.vx += ax * DT;
    this.vy += ay * DT;
    this.x += this.vx * DT;
    this.y += this.vy * DT;

    this.angVel += (torque / I) * DT;
    this.ang += this.angVel * DT;

    this.t += DT;
    this.steps++;

    if (!this.liftedOff && this.altitude() > 0.6) { this.liftedOff = true; }
    this.maxAlt = Math.max(this.maxAlt, this.altitude());

    this.updateDebris();
    this.checkGround();

    if (this.steps > MAX_STEPS && !this.done) {
      this.finish("timeout", "Mission clock expired.");
    }
    if (this.x < -400 || this.x > d.terrain.extent - 100) {
      this.finish("lost", "Vehicle left the mission area.");
    }
  };

  Sim.prototype.doStage = function () {
    var P = global.DRParts;
    var a = this.geom;

    // Solids light on the first stage press if they haven't already.
    if (!this.solidLit && a.solidThrust > 0 && this.solid > 0) {
      this.solidLit = true;
      this.events.push({ t: this.t, type: "ignite" });
      this.effects.push({ type: "flash", x: this.x, y: this.y, life: 0.4 });
      return;
    }

    if (this.stageIndex >= this.stageList.length - 1) { return; }

    var dropping = this.stageList[this.stageIndex].indices.slice();
    var sepIndex = this.stageList[this.stageIndex].to;
    if (sepIndex < this.design.stack.length) { dropping.push(sepIndex); }
    if (!dropping.length) { this.stageIndex++; return; }

    // Snapshot the jettisoned mass as debris so recovery can be scored.
    var geomBefore = this.geom;
    var dropMass = 0;
    var lowest = Infinity, highest = -Infinity;
    for (var i = 0; i < dropping.length; i++) {
      var it = geomBefore.items[dropping[i]];
      if (!it) { continue; }
      dropMass += it.part.dry + (it.part.fuel || 0);
      lowest = Math.min(lowest, it.y0);
      highest = Math.max(highest, it.y1);
      for (var j = 0; j < it.radial.length; j++) {
        var rp = P.CATALOG[it.radial[j]];
        dropMass += rp.dry + (rp.fuel || 0);
      }
    }
    // fuel actually still in the dropped tanks
    var dropFuelShare = 0;
    if (geomBefore.fuelCapacity > 0) {
      dropFuelShare = Math.min(this.fuel, this.fuel * 0.0);
    }

    var half = geomBefore.height / 2;
    var cy = ((lowest + highest) / 2) - half;
    var up = { x: Math.sin(this.ang), y: Math.cos(this.ang) };

    this.debris.push({
      x: this.x + up.x * cy,
      y: this.y + up.y * cy,
      vx: this.vx - up.x * 2.5,
      vy: this.vy - up.y * 2.5,
      ang: this.ang,
      angVel: this.angVel + 0.35,
      h: Math.max(1, highest - lowest),
      w: 1.5,
      mass: Math.max(1, dropMass),
      landed: false,
      intact: false,
      parts: dropping.slice()
    });

    this.alive = this.alive.filter(function (idx) { return dropping.indexOf(idx) < 0; });
    this.stageIndex++;

    // Keep the vehicle's world position continuous through the geometry change.
    var oldCentreToBase = geomBefore.height / 2 - geomBefore.base;
    var basePt = {
      x: this.x - up.x * oldCentreToBase,
      y: this.y - up.y * oldCentreToBase
    };
    this.refresh();
    var newCentreToBase = this.geom.height / 2 - this.geom.base;
    this.x = basePt.x + up.x * newCentreToBase;
    this.y = basePt.y + up.y * newCentreToBase;

    this.fuel = Math.max(0, this.fuel - dropFuelShare);
    this.fuel = Math.min(this.fuel, this.geom.fuelCapacity);
    this.solid = Math.min(this.solid, this.geom.solidFuel);

    this.events.push({ t: this.t, type: "stage" });
    this.effects.push({ type: "flash", x: this.x, y: this.y, life: 0.3 });
  };

  Sim.prototype.doAction = function () {
    if (this.geom.chuteArea > 0 && !this.chuteOut) {
      this.chuteOut = true;
      this.chuteDeployTime = this.t;
      this.events.push({ t: this.t, type: "chute" });
    }
  };

  Sim.prototype.updateDebris = function () {
    var w = this.daily.world;
    for (var i = 0; i < this.debris.length; i++) {
      var d = this.debris[i];
      if (d.landed) { continue; }
      var rho = this.density(d.y);
      var rvx = d.vx - w.wind * w.windDir;
      var sp = Math.sqrt(rvx * rvx + d.vy * d.vy);
      if (sp > 0.01 && rho > 0) {
        var Fd = 0.5 * rho * sp * sp * 1.4;
        d.vx -= (rvx / sp) * (Fd / d.mass) * DT;
        d.vy -= (d.vy / sp) * (Fd / d.mass) * DT;
      }
      d.vy -= w.g * DT;
      d.x += d.vx * DT;
      d.y += d.vy * DT;
      d.ang += d.angVel * DT;

      var ground = this.daily.terrain.heightAt(d.x);
      if (d.y - d.h / 2 <= ground) {
        d.landed = true;
        d.y = ground + d.h / 2;
        var impact = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
        d.intact = impact < 14 && Math.abs(Math.sin(d.ang)) < 0.6;
        d.vx = 0; d.vy = 0; d.angVel = 0;
        if (!d.intact) {
          this.effects.push({ type: "boom", x: d.x, y: d.y, life: 0.7, r: 6 });
        }
      }
    }
  };

  Sim.prototype.checkGround = function () {
    if (this.done) { return; }
    var d = this.daily;
    var base = this.basePoint();
    var ground = d.terrain.heightAt(base.x);
    if (base.y > ground) { return; }

    var speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    var tilt = Math.abs(this.normAngle(this.ang));
    var a = this.geom;

    /* Sitting on the pad is not a landing. Until the vehicle has actually
     * left the ground it just rests here - otherwise gravity nudges it a
     * fraction of a metre on the first tick and the run "ends" before the
     * player has touched the throttle. */
    if (!this.liftedOff) {
      this.y += ground - base.y;
      if (this.vy < 0) { this.vy = 0; }
      this.vx *= 0.55;
      this.angVel *= 0.5;
      return;
    }

    var tolerance = a.legs > 0 ? a.legTolerance : 2.4;
    if (this.chuteOut) { tolerance += 2.5; }
    var tiltLimit = a.legs > 0 ? 0.32 : 0.20;

    var dx = base.x - d.mission.targetX;
    var onPad = Math.abs(dx) <= d.mission.padHalfWidth;
    var slope = Math.abs(d.terrain.slopeAt(base.x));

    this.landing = {
      speed: speed,
      vertical: this.vy,
      horizontal: this.vx,
      tilt: tilt,
      distance: dx,
      onPad: onPad,
      tolerance: tolerance
    };

    this.y += ground - base.y;
    this.vx = 0; this.vy = 0; this.angVel = 0;

    if (speed > tolerance || tilt > tiltLimit || slope > 0.35) {
      this.effects.push({ type: "boom", x: base.x, y: base.y, life: 1.0, r: 14 });
      var why;
      if (tilt > tiltLimit) {
        why = "Touched down at " + Math.round(tilt * 57.3) + " degrees. It tipped over.";
      } else if (slope > 0.35) {
        why = "That ground was too steep to stand on.";
      } else if (speed > tolerance * 2.5) {
        why = "Impact at " + speed.toFixed(1) + " m/s. Nothing survived.";
      } else {
        why = "Touched down at " + speed.toFixed(1) + " m/s. Technically, that was a landing.";
      }
      this.finish("crash", why);
      return;
    }

    if (!onPad) {
      var miss = Math.abs(dx);
      this.finish("missed", "Intact, but " + (miss > 1000
        ? (miss / 1000).toFixed(2) + " km" : Math.round(miss) + " m") + " from the pad.");
      return;
    }

    this.finish("landed", "Payload delivered.");
  };

  Sim.prototype.normAngle = function (a) {
    while (a > Math.PI) { a -= Math.PI * 2; }
    while (a < -Math.PI) { a += Math.PI * 2; }
    return a;
  };

  Sim.prototype.finish = function (outcome, message) {
    this.done = true;
    this.outcome = outcome;
    this.message = message;
    this.success = outcome === "landed";
  };

  Sim.prototype.recoveredStages = function () {
    var n = 0;
    for (var i = 0; i < this.debris.length; i++) {
      if (this.debris[i].landed && this.debris[i].intact) { n++; }
    }
    return n;
  };

  Sim.prototype.fuelRemainingFraction = function () {
    var cap = this.fuelCapacityTotal || 0;
    return cap > 0 ? Math.max(0, this.fuel + this.solid) / cap : 0;
  };

  global.DRFlight = { Sim: Sim, DT: DT };
})(window);
