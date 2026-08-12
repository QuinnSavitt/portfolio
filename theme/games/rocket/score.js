/* Daily Rocket - scoring, local records, sharing.
 *
 * Scoring is fully transparent: every run returns the individual terms so the
 * result screen can show the player exactly where the remaining points are.
 * Maxima are deliberately in tension (fast conflicts with efficient, light
 * conflicts with recovery) so no single build sweeps every category.
 */
(function (global) {
  "use strict";

  var STORE = "dr-rocket-";
  var MAX = {
    base: 50000, accuracy: 16000, time: 9000, efficiency: 8000,
    mass: 4000, cost: 3000, landing: 5000, recovery: 4000
  };

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // Ballistic arc time plus a fixed allowance for climb-out and the landing burn.
  function referenceTime(daily) {
    return Math.sqrt(2 * daily.mission.targetX / daily.world.g) + 22;
  }

  // Scales with the velocity the arc demands, which is what actually drives
  // how much propellant (and therefore mass) a sane vehicle needs.
  function referenceMass(daily) {
    var v = Math.sqrt(daily.world.g * daily.mission.targetX);
    return (daily.mission.payload + 150) * (1 + v / 420);
  }

  function score(sim, daily) {
    var lines = [];
    var total = 0;

    function add(key, label, value, detail) {
      value = Math.round(value);
      if (value === 0 && key !== "base") { return; }
      lines.push({ key: key, label: label, value: value, detail: detail || "" });
      total += value;
    }

    if (!sim.success) {
      return { total: 0, lines: [], failed: true, message: sim.message };
    }

    add("base", "Mission complete", MAX.base);

    // --- accuracy: distance from pad centre
    var dist = Math.abs(sim.landing.distance);
    var accFrac = clamp01(1 - dist / daily.mission.padHalfWidth);
    add("accuracy", "Accuracy", MAX.accuracy * Math.pow(accFrac, 1.4), dist.toFixed(2) + " m from centre");

    // --- time
    var tRef = referenceTime(daily);
    var timeFrac = clamp01(1 - (sim.t - tRef * 0.55) / (tRef * 1.15));
    add("time", "Flight time", MAX.time * timeFrac, sim.t.toFixed(2) + " s");

    // --- propellant economy
    var used = sim.fuelUsed;
    var cap = sim.fuelCapacityTotal || 1;
    var effFrac = clamp01(1 - used / Math.max(1, cap * 0.92));
    add("efficiency", "Propellant saved", MAX.efficiency * effFrac,
      Math.round(sim.fuelRemainingFraction() * 100) + "% remaining");

    // --- launch mass
    var mRef = referenceMass(daily);
    var massFrac = clamp01(1 - (sim.launchMass - mRef * 0.55) / (mRef * 0.9));
    add("mass", "Launch mass", MAX.mass * massFrac, (sim.launchMass / 1000).toFixed(2) + " t");

    // --- vehicle cost
    var cRef = 900 + daily.demand * 2200;
    var costFrac = clamp01(1 - (sim.geom.cost - cRef * 0.4) / (cRef * 0.9));
    add("cost", "Vehicle cost", MAX.cost * costFrac, "$" + sim.geom.cost);

    // --- touchdown quality
    var l = sim.landing;
    var vq = clamp01(1 - Math.abs(l.vertical) / l.tolerance);
    var hq = clamp01(1 - Math.abs(l.horizontal) / (l.tolerance * 0.8));
    var tq = clamp01(1 - l.tilt / 0.3);
    add("landing", "Touchdown quality", MAX.landing * (vq * 0.5 + hq * 0.25 + tq * 0.25),
      Math.abs(l.vertical).toFixed(2) + " m/s vertical");

    // --- stage recovery
    var rec = Math.min(2, sim.recoveredStages());
    if (rec > 0) {
      add("recovery", "Stage recovery", (MAX.recovery / 2) * rec, rec + " recovered");
    }

    // --- optional objectives
    var objectives = [];
    for (var i = 0; i < daily.optional.length; i++) {
      var o = daily.optional[i];
      var met = false;
      if (o.id === "bullseye") { met = dist <= 5; }
      if (o.id === "recover") { met = rec >= 1; }
      if (o.id === "reserve") { met = sim.fuelRemainingFraction() >= 0.10; }
      objectives.push({ id: o.id, label: o.label, met: met, bonus: o.bonus });
      if (met) { add("obj-" + o.id, o.label, o.bonus); }
    }

    return {
      total: Math.round(total),
      lines: lines,
      objectives: objectives,
      failed: false,
      stats: {
        distance: dist,
        time: sim.t,
        fuelRemaining: sim.fuelRemainingFraction(),
        launchMass: sim.launchMass,
        cost: sim.geom.cost,
        vertical: Math.abs(l.vertical),
        recovered: rec
      }
    };
  }

  // ------------------------------------------------------------- records

  function read(key, fallback) {
    try {
      var raw = global.localStorage.getItem(STORE + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function write(key, value) {
    try {
      global.localStorage.setItem(STORE + key, JSON.stringify(value));
      return true;
    } catch (e) { return false; }
  }

  function dayKey(daily) { return "d" + daily.index + "-" + daily.rules; }

  function loadDay(daily) {
    return read(dayKey(daily), { attempts: 0, first: null, best: null, ghost: null });
  }

  /* Returns what changed so the result screen can shout about it. */
  function submit(daily, result, sim, design) {
    var rec = loadDay(daily);
    rec.attempts = (rec.attempts || 0) + 1;

    var entry = result.failed ? null : {
      total: result.total,
      stats: result.stats,
      design: design,
      at: rec.attempts
    };

    var isFirst = false, isBest = false;
    if (!rec.first) {
      // The blind run is whatever the first *completed* attempt produced,
      // including a failure - it can never be replaced.
      rec.first = entry || { total: 0, failed: true, at: rec.attempts };
      isFirst = true;
    }
    if (entry && (!rec.best || entry.total > rec.best.total)) {
      rec.best = entry;
      isBest = true;
      rec.ghost = compressTrail(sim.trail);
    }

    write(dayKey(daily), rec);
    bumpStats(daily, result);
    return { record: rec, isFirst: isFirst, isBest: isBest };
  }

  function compressTrail(trail) {
    var out = [];
    for (var i = 0; i < trail.length; i += 2) {
      out.push(Math.round(trail[i].x * 10) / 10, Math.round(trail[i].y * 10) / 10);
    }
    return out;
  }

  function loadGhost(daily) {
    var rec = loadDay(daily);
    if (!rec.ghost) { return null; }
    var pts = [];
    for (var i = 0; i < rec.ghost.length; i += 2) {
      pts.push({ x: rec.ghost[i], y: rec.ghost[i + 1] });
    }
    return pts;
  }

  function bumpStats(daily, result) {
    var s = read("stats", { played: 0, landed: 0, crashed: 0, best: 0, streak: 0, lastDay: null });
    if (s.lastDay !== daily.index) {
      s.played++;
      s.streak = s.lastDay === daily.index - 1 ? (s.streak || 0) + 1 : 1;
      s.lastDay = daily.index;
    }
    if (result.failed) { s.crashed++; } else { s.landed++; }
    if (!result.failed && result.total > (s.best || 0)) { s.best = result.total; }
    write("stats", s);
  }

  function stats() {
    return read("stats", { played: 0, landed: 0, crashed: 0, best: 0, streak: 0, lastDay: null });
  }

  // -------------------------------------------------------------- share

  function shareText(daily, result, rec) {
    var lines = [];
    lines.push("DAILY ROCKET #" + daily.number + " 🚀");
    lines.push(daily.mission.name + " · " + daily.world.name);
    lines.push("");
    lines.push(result.failed ? "FAILED" : String(result.total).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
    if (!result.failed) {
      lines.push("🎯 " + result.stats.distance.toFixed(2) + " m   ⏱ " + result.stats.time.toFixed(2) + " s");
      lines.push("⛽ " + Math.round(result.stats.fuelRemaining * 100) + "% left   📦 " +
        (result.stats.launchMass / 1000).toFixed(2) + " t");
    }
    if (rec && rec.first && !rec.first.failed) {
      lines.push("Blind run: " + rec.first.total);
    }
    lines.push("");
    lines.push(global.location.origin + global.location.pathname);
    return lines.join("\n");
  }

  global.DRScore = {
    score: score,
    submit: submit,
    loadDay: loadDay,
    loadGhost: loadGhost,
    stats: stats,
    shareText: shareText,
    referenceTime: referenceTime
  };
})(window);
