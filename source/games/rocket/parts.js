/* Daily Rocket - component catalogue and vehicle assembly.
 *
 * Every number here is load-bearing: mass, thrust, flow and drag all feed the
 * flight model, and cost feeds scoring. Changing any of them changes recorded
 * runs, so bump DRDaily rules version alongside.
 *
 * Units: kg, newtons, metres, seconds.
 */
(function (global) {
  "use strict";

  // axial parts stack vertically; radial parts clamp to the side of a stack part
  var CATALOG = {
    payload: {
      id: "payload", name: "Payload", kind: "axial", w: 1.5, h: 2.0,
      dry: 0, cost: 0, drag: 0.55, fixed: true
    },
    tankSmall: {
      id: "tankSmall", name: "Small Tank", kind: "axial", w: 1.5, h: 2.6,
      dry: 20, fuel: 110, cost: 230, drag: 0.30
    },
    tankLarge: {
      id: "tankLarge", name: "Large Tank", kind: "axial", w: 1.5, h: 5.0,
      dry: 55, fuel: 300, cost: 500, drag: 0.30
    },
    engineSmall: {
      id: "engineSmall", name: "Small Engine", kind: "axial", w: 1.5, h: 1.6,
      dry: 44, cost: 600, drag: 0.42,
      thrust: 5200, flow: 6.50, minThrottle: 0.12, gimbal: 1400, vacBonus: 1.06
    },
    engineMedium: {
      id: "engineMedium", name: "Medium Engine", kind: "axial", w: 1.8, h: 2.2,
      dry: 110, cost: 1240, drag: 0.46,
      thrust: 13000, flow: 14.70, minThrottle: 0.22, gimbal: 3200, vacBonus: 1.03
    },
    decoupler: {
      id: "decoupler", name: "Decoupler", kind: "axial", w: 1.6, h: 0.6,
      dry: 8, cost: 100, drag: 0.20, separator: true
    },
    structure: {
      id: "structure", name: "Spacer", kind: "axial", w: 1.4, h: 1.4,
      dry: 12, cost: 70, drag: 0.22
    },
    booster: {
      id: "booster", name: "Solid Booster", kind: "radial", w: 1.1, h: 6.0,
      dry: 30, fuel: 150, cost: 320, drag: 0.34,
      thrust: 14000, flow: 23.3, solid: true
    },
    fin: {
      id: "fin", name: "Fin", kind: "radial", w: 1.3, h: 1.8,
      dry: 6, cost: 95, drag: 0.20, finArea: 1.35
    },
    leg: {
      id: "leg", name: "Landing Leg", kind: "radial", w: 1.2, h: 1.6,
      dry: 8, cost: 110, drag: 0.10, legTolerance: 4.2
    },
    rcs: {
      id: "rcs", name: "RCS Block", kind: "radial", w: 0.7, h: 0.9,
      dry: 10, fuel: 6, cost: 230, drag: 0.05, rcsTorque: 900, rcsFlow: 0.12
    },
    chute: {
      id: "chute", name: "Parachute", kind: "axial", w: 1.5, h: 1.2,
      dry: 14, cost: 270, drag: 0.25, chuteArea: 46
    }
  };

  var ORDER = ["engineSmall", "engineMedium", "booster", "tankSmall", "tankLarge",
    "decoupler", "structure", "fin", "leg", "rcs", "chute"];

  /* A design is { stack: [partId...] bottom-first, radial: { stackIndex: [partId...] } }.
   * The payload is implicit and always sits on top. */

  function emptyDesign() {
    return { stack: [], radial: {} };
  }

  function partAt(design, i) { return CATALOG[design.stack[i]]; }

  function radialAt(design, i) {
    var list = design.radial[i];
    return list ? list.slice() : [];
  }

  /* Split the vehicle into stages. Staging is bottom-up: firing the stage
   * button jettisons everything below the lowest remaining decoupler. */
  function stages(design) {
    var out = [];
    var current = [];
    for (var i = 0; i < design.stack.length; i++) {
      if (CATALOG[design.stack[i]].separator) {
        out.push({ from: current.length ? current[0] : i, to: i, indices: current.slice() });
        current = [];
      } else {
        current.push(i);
      }
    }
    out.push({ from: current.length ? current[0] : design.stack.length, to: design.stack.length, indices: current.slice() });
    return out;
  }

  /* Geometry + mass properties for the live vehicle. `alive` is the set of
   * stack indices still attached. Returns everything the integrator needs. */
  function analyse(design, payloadMass, alive) {
    var i, j, p;
    var items = [];
    var y = 0;

    for (i = 0; i < design.stack.length; i++) {
      p = CATALOG[design.stack[i]];
      var attached = !alive || alive.indexOf(i) >= 0;
      items.push({ index: i, part: p, y0: y, y1: y + p.h, attached: attached, radial: radialAt(design, i) });
      y += p.h;
    }
    var payloadPart = CATALOG.payload;
    items.push({ index: -1, part: payloadPart, y0: y, y1: y + payloadPart.h, attached: true, radial: [] });
    var totalHeight = y + payloadPart.h;

    var dry = 0, fuel = 0, cost = 0, thrust = 0, flow = 0, gimbal = 0;
    var rcsTorque = 0, rcsFuel = 0, rcsFlow = 0, finArea = 0, finArm = 0;
    var legTolerance = 0, legs = 0, chuteArea = 0;
    var dragArea = 0, minThrottleNum = 0, minThrottleDen = 0;
    var solidThrust = 0, solidFuel = 0, solidFlow = 0;
    var mo = 0; // first moment for centre of mass, about the vehicle base
    var lowestAttached = totalHeight, highestAttached = 0;
    var width = 0;

    function addMass(m, cy) { dry += m; mo += m * cy; }

    for (i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it.attached) { continue; }
      p = it.part;
      var cy = (it.y0 + it.y1) / 2;
      var m = p === payloadPart ? payloadMass : p.dry;

      addMass(m, cy);
      cost += p.cost || 0;
      dragArea += (p.drag || 0) * p.w;
      width = Math.max(width, p.w);
      lowestAttached = Math.min(lowestAttached, it.y0);
      highestAttached = Math.max(highestAttached, it.y1);

      if (p.fuel) { fuel += p.fuel; mo += p.fuel * cy; }
      if (p.thrust && !p.solid) {
        thrust += p.thrust; flow += p.flow; gimbal += p.gimbal;
        minThrottleNum += p.thrust * p.minThrottle; minThrottleDen += p.thrust;
      }
      if (p.chuteArea) { chuteArea += p.chuteArea; }

      for (j = 0; j < it.radial.length; j++) {
        var rp = CATALOG[it.radial[j]];
        addMass(rp.dry, cy);
        cost += rp.cost || 0;
        dragArea += (rp.drag || 0) * rp.w;
        if (rp.fuel) { fuel += rp.fuel; mo += rp.fuel * cy; }
        if (rp.solid) {
          solidThrust += rp.thrust; solidFlow += rp.flow; solidFuel += rp.fuel;
        }
        if (rp.finArea) { finArea += rp.finArea; finArm += rp.finArea * cy; }
        if (rp.rcsTorque) { rcsTorque += rp.rcsTorque; rcsFuel += rp.fuel; rcsFlow += rp.rcsFlow; }
        if (rp.legTolerance) { legTolerance += rp.legTolerance; legs++; }
      }
    }

    var wetMass = dry + fuel;
    var com = wetMass > 0 ? mo / wetMass : totalHeight / 2;

    return {
      items: items,
      height: totalHeight,
      width: Math.max(width, 1),
      base: lowestAttached,
      top: highestAttached,
      dryMass: dry,
      fuelCapacity: fuel - solidFuel,
      solidFuel: solidFuel,
      cost: cost,
      thrust: thrust,
      flow: flow,
      gimbal: gimbal,
      minThrottle: minThrottleDen > 0 ? minThrottleNum / minThrottleDen : 0,
      solidThrust: solidThrust,
      solidFlow: solidFlow,
      rcsTorque: rcsTorque,
      rcsFuel: rcsFuel,
      rcsFlow: rcsFlow,
      finArea: finArea,
      finArm: finArea > 0 ? finArm / finArea : 0,
      legTolerance: legs > 0 ? 2.0 + legTolerance / legs : 2.0,
      legs: legs,
      chuteArea: chuteArea,
      dragArea: Math.max(dragArea, 0.4),
      com: com,
      wetMass: wetMass
    };
  }

  /* Static readouts for the build screen. TWR uses launch mass so the player
   * can see immediately whether the thing will leave the pad. */
  function summary(design, daily) {
    var a = analyse(design, daily.mission.payload, null);
    var totalThrust = a.thrust + a.solidThrust;
    var weight = a.wetMass * daily.world.g;
    var twr = weight > 0 ? totalThrust / weight : 0;

    // Tsiolkovsky on liquid propellant only; solids are a separate impulse
    var ve = a.flow > 0 ? a.thrust / a.flow : 0;
    var m0 = a.wetMass;
    var m1 = a.wetMass - a.fuelCapacity;
    var dv = ve > 0 && m1 > 0 ? ve * Math.log(m0 / m1) : 0;
    if (a.solidThrust > 0 && a.solidFlow > 0) {
      dv += (a.solidThrust / a.solidFlow) * Math.log(m0 / Math.max(1, m0 - a.solidFuel)) * 0.6;
    }

    return {
      mass: a.wetMass, dryMass: a.dryMass, fuel: a.fuelCapacity + a.solidFuel,
      thrust: totalThrust, twr: twr, deltaV: dv, cost: a.cost,
      height: a.height, engines: a.thrust > 0, fins: a.finArea,
      legs: a.legs, chute: a.chuteArea, rcs: a.rcsTorque, stages: stages(design).length,
      analysis: a
    };
  }

  /* Design legality. Kept deliberately permissive - silly rockets are allowed,
   * they just fly badly. Only genuinely unflyable states are blocked. */
  function validate(design, daily) {
    var problems = [];
    var s = summary(design, daily);
    if (design.stack.length === 0) {
      problems.push("Nothing built yet.");
      return { ok: false, problems: problems, summary: s };
    }
    if (s.thrust <= 0) { problems.push("No engine. This will not leave the pad."); }
    if (s.twr < 1.02) { problems.push("Thrust-to-weight is " + s.twr.toFixed(2) + " - too heavy to lift."); }
    if (s.analysis.fuelCapacity <= 0 && s.analysis.solidFuel <= 0) { problems.push("No propellant aboard."); }
    return { ok: problems.length === 0, problems: problems, summary: s };
  }

  function used(design) {
    var counts = {};
    var i, j;
    for (i = 0; i < design.stack.length; i++) {
      counts[design.stack[i]] = (counts[design.stack[i]] || 0) + 1;
    }
    for (i in design.radial) {
      if (!Object.prototype.hasOwnProperty.call(design.radial, i)) { continue; }
      var list = design.radial[i];
      for (j = 0; j < list.length; j++) {
        counts[list[j]] = (counts[list[j]] || 0) + 1;
      }
    }
    return counts;
  }

  function remaining(design, inventory) {
    var u = used(design);
    var left = {};
    for (var k in inventory) {
      if (Object.prototype.hasOwnProperty.call(inventory, k)) {
        left[k] = inventory[k] - (u[k] || 0);
      }
    }
    return left;
  }

  global.DRParts = {
    CATALOG: CATALOG,
    ORDER: ORDER,
    emptyDesign: emptyDesign,
    partAt: partAt,
    radialAt: radialAt,
    stages: stages,
    analyse: analyse,
    summary: summary,
    validate: validate,
    used: used,
    remaining: remaining
  };
})(window);
