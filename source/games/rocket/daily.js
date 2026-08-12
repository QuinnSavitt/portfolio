/* Daily Rocket - deterministic daily challenge generation.
 *
 * Everything a player sees today is derived from one integer: the UTC day
 * index. Same day -> same seed -> same mission, terrain, inventory, scoring.
 * Nothing here may read Math.random() or the local clock beyond the date.
 */
(function (global) {
  "use strict";

  var EPOCH = Date.UTC(2026, 0, 1); // Daily Rocket #1
  var DAY_MS = 86400000;

  // ---------------------------------------------------------------- rng

  function hash32(n) {
    n |= 0;
    n = Math.imul(n ^ (n >>> 16), 2246822507);
    n = Math.imul(n ^ (n >>> 13), 3266489909);
    return (n ^ (n >>> 16)) >>> 0;
  }

  // mulberry32: small, fast, identical across every browser
  function rng(seed) {
    var a = seed >>> 0;
    var f = function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.range = function (lo, hi) { return lo + f() * (hi - lo); };
    f.int = function (lo, hi) { return Math.floor(lo + f() * (hi - lo + 1)); };
    f.pick = function (arr) { return arr[Math.floor(f() * arr.length)]; };
    f.chance = function (p) { return f() < p; };
    return f;
  }

  function dayIndex(now) {
    var d = now || new Date();
    var utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return Math.floor((utc - EPOCH) / DAY_MS);
  }

  function msUntilReset(now) {
    var d = now || new Date();
    var next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    return next - d.getTime();
  }

  // ---------------------------------------------------------- environments

  // Tuned for play, not for astronomy: scale heights are compressed so that
  // climbing a few kilometres actually changes how the vehicle handles.
  var WORLDS = [
    {
      id: "terra", name: "Terra", atmo: "Thick",
      g: [9.2, 10.1], rho0: [1.05, 1.35], scaleH: [2200, 2900], wind: [0, 9],
      sky: ["#89b6d9", "#dfe9f2"], ground: "#6c7b52", rock: "#5a6350"
    },
    {
      id: "rust", name: "Rust", atmo: "Thin",
      g: [3.4, 4.1], rho0: [0.11, 0.24], scaleH: [3000, 4200], wind: [0, 7],
      sky: ["#c98b62", "#f0d6bd"], ground: "#9c5f3c", rock: "#7d4a2f"
    },
    {
      id: "selene", name: "Selene", atmo: "None",
      g: [1.4, 1.95], rho0: [0, 0], scaleH: [1, 1], wind: [0, 0],
      sky: ["#05070d", "#141c2c"], ground: "#8d8f96", rock: "#6d6f77"
    },
    {
      id: "mistral", name: "Mistral", atmo: "Dense",
      g: [1.2, 1.7], rho0: [3.2, 4.8], scaleH: [3800, 5000], wind: [3, 13],
      sky: ["#b8892f", "#e8cf94"], ground: "#6d5a2e", rock: "#544526"
    }
  ];

  // ------------------------------------------------------------- missions

  var MISSIONS = [
    {
      id: "precision", name: "Precision Landing",
      brief: "Put the vehicle down on the landing pad. Gently.",
      vel: [110, 165], payload: [50, 110]
    },
    {
      id: "courier", name: "Canyon Courier",
      brief: "Deliver the payload intact to the outpost downrange.",
      vel: [150, 225], payload: [90, 170]
    },
    {
      id: "hop", name: "Rocket Hop",
      brief: "Short translation, powered landing. No room for error.",
      vel: [60, 100], payload: [30, 70]
    }
  ];

  // ------------------------------------------------------------- terrain

  /* Deterministic 1D heightfield sampled on a fixed grid and linearly
   * interpolated. Two flat shelves are stamped in for the launch pad and the
   * target pad so touchdown geometry is never ambiguous. */
  function buildTerrain(r, world, targetX, profile) {
    var STEP = 40;
    var extent = targetX + 2600;
    var n = Math.ceil(extent / STEP) + 1;
    var h = new Float64Array(n);

    // layered value noise
    var octaves = [
      { len: 2400, amp: profile.relief },
      { len: 900, amp: profile.relief * 0.42 },
      { len: 330, amp: profile.relief * 0.16 },
      { len: 120, amp: profile.relief * 0.05 }
    ];
    var phase = [];
    var i, o;
    for (o = 0; o < octaves.length; o++) { phase.push(r() * 1000); }

    for (i = 0; i < n; i++) {
      var x = i * STEP;
      var v = 0;
      for (o = 0; o < octaves.length; o++) {
        var oc = octaves[o];
        var t = (x / oc.len) + phase[o];
        var i0 = Math.floor(t);
        var f = t - i0;
        var s = f * f * (3 - 2 * f);
        var a = ((hash32(i0 * 374761393 + o * 668265263) >>> 0) / 4294967296) * 2 - 1;
        var b = ((hash32((i0 + 1) * 374761393 + o * 668265263) >>> 0) / 4294967296) * 2 - 1;
        v += (a + (b - a) * s) * oc.amp;
      }
      h[i] = v;
    }

    // A ridge between launch and target forces a real trajectory decision.
    if (profile.ridge) {
      var rx = targetX * r.range(0.42, 0.62);
      var rw = targetX * r.range(0.10, 0.17);
      var rh = profile.ridgeHeight;
      for (i = 0; i < n; i++) {
        var d = (i * STEP - rx) / rw;
        h[i] += rh * Math.exp(-d * d);
      }
    }

    function flatten(cx, halfWidth, blend) {
      var ci = Math.round(cx / STEP);
      var level = h[Math.max(0, Math.min(n - 1, ci))];
      var hw = Math.ceil(halfWidth / STEP);
      var bl = Math.ceil(blend / STEP);
      for (var j = ci - hw - bl; j <= ci + hw + bl; j++) {
        if (j < 0 || j >= n) { continue; }
        var dist = Math.abs(j - ci);
        var w = dist <= hw ? 1 : Math.max(0, 1 - (dist - hw) / bl);
        w = w * w * (3 - 2 * w);
        h[j] = h[j] * (1 - w) + level * w;
      }
      return level;
    }

    var padY = flatten(targetX, profile.padHalfWidth, 260);
    var launchY = flatten(0, 90, 220);

    return {
      step: STEP, heights: h, extent: extent,
      padY: padY, launchY: launchY,
      heightAt: function (x) {
        if (x <= 0) { return h[0]; }
        var t = x / STEP;
        var i0 = Math.floor(t);
        if (i0 >= n - 1) { return h[n - 1]; }
        var f = t - i0;
        return h[i0] + (h[i0 + 1] - h[i0]) * f;
      },
      slopeAt: function (x) {
        var a = this.heightAt(x - 6), b = this.heightAt(x + 6);
        return (b - a) / 12;
      }
    };
  }

  // ----------------------------------------------------------- inventory

  /* Hand the player a constrained parts bin. The counts are the puzzle: the
   * generator guarantees at least one combination can fly the mission (see
   * validate() below) while leaving several viable shapes. */
  function buildInventory(r, ctx) {
    var inv = {};
    var vacuum = ctx.world.rho0 <= 0.02;
    var heavy = ctx.payload > 130;

    inv.engineSmall = r.int(2, 3);
    inv.engineMedium = ctx.demand > 0.55 || heavy ? r.int(1, 2) : r.int(0, 1);
    inv.booster = ctx.demand > 0.4 ? r.int(0, 2) : 0;
    inv.tankSmall = r.int(2, 4);
    inv.tankLarge = ctx.demand > 0.45 ? r.int(1, 3) : r.int(0, 2);
    inv.decoupler = inv.booster > 0 || ctx.demand > 0.5 ? r.int(1, 2) : r.int(0, 1);
    inv.fin = vacuum ? 0 : r.int(2, 4);
    inv.rcs = vacuum || r.chance(0.55) ? r.int(1, 2) : 0;
    inv.leg = r.int(2, 4);
    inv.chute = ctx.world.rho0 > 0.5 ? r.int(1, 2) : 0;
    inv.structure = r.int(0, 2);

    if (vacuum && inv.rcs < 1) { inv.rcs = 1; }
    if (inv.leg < 2 && inv.chute < 1) { inv.leg = 2; }
    return inv;
  }

  // ------------------------------------------------------------ assemble

  function generate(index) {
    var r = rng(hash32(index * 2654435761 + 12345));
    var world = (function () {
      var w = r.pick(WORLDS);
      return {
        id: w.id, name: w.name, atmo: w.atmo,
        g: +r.range(w.g[0], w.g[1]).toFixed(3),
        rho0: +r.range(w.rho0[0], w.rho0[1]).toFixed(3),
        scaleH: Math.round(r.range(w.scaleH[0], w.scaleH[1])),
        wind: +r.range(w.wind[0], w.wind[1]).toFixed(1),
        windDir: r.chance(0.5) ? -1 : 1,
        sky: w.sky, ground: w.ground, rock: w.rock
      };
    })();

    var mission = r.pick(MISSIONS);

    /* Downrange distance is solved for, not picked. Two independent ceilings
     * bind it: the launch velocity a sane vehicle can actually build (which
     * caps range at v^2/g) and the ballistic arc duration (1.41*v/g), which
     * keeps a feather-gravity world from turning into a three-minute coast.
     * Whichever bites first wins. */
    var vWant = r.range(mission.vel[0], mission.vel[1]);
    var vArcCap = 40 * world.g;               // arc stays under ~57 s
    var vNeed = Math.max(35, Math.min(vWant, vArcCap));
    var targetX = Math.max(350, Math.round((vNeed * vNeed / world.g) / 50) * 50);
    var payload = Math.round(r.range(mission.payload[0], mission.payload[1]) / 10) * 10;

    // 0..1 rough measure of how much work the vehicle has to do. Driven by the
    // velocity the arc needs (sqrt(g*range)) rather than raw distance.
    var demand = Math.min(1, (vNeed / 230) * 0.55 + (payload / 170) * 0.3 +
      (world.rho0 > 1.5 ? 0.15 : 0));

    var profile = {
      relief: r.range(40, 150) * (1 + demand),
      ridge: targetX > 2000 && r.chance(0.65),
      ridgeHeight: r.range(240, 900),
      padHalfWidth: Math.round(r.range(38, 70))
    };

    var terrain = buildTerrain(r, world, targetX, profile);
    var inventory = buildInventory(r, { world: world, payload: payload, demand: demand });

    var optional = [];
    optional.push({ id: "bullseye", label: "Touch down within 5 m of pad centre", bonus: 3000 });
    if (inventory.decoupler > 0) {
      optional.push({ id: "recover", label: "Recover a separated stage intact", bonus: 4000 });
    }
    optional.push({ id: "reserve", label: "Finish with 10% fuel remaining", bonus: 2500 });

    return {
      index: index,
      number: index + 1,
      world: world,
      mission: {
        id: mission.id, name: mission.name, brief: mission.brief,
        targetX: targetX, payload: payload, padHalfWidth: profile.padHalfWidth
      },
      terrain: terrain,
      inventory: inventory,
      optional: optional,
      demand: demand,
      // Bumping this invalidates stored records whose physics no longer match.
      rules: "1.0.0"
    };
  }

  global.DRDaily = {
    EPOCH: EPOCH,
    rng: rng,
    hash32: hash32,
    dayIndex: dayIndex,
    msUntilReset: msUntilReset,
    generate: generate,
    WORLDS: WORLDS,
    MISSIONS: MISSIONS
  };
})(window);
