/* Daily Rocket - application shell: screens, flight rendering, input. */
(function (global) {
  "use strict";

  var D = global.DRDaily, P = global.DRParts, F = global.DRFlight, S = global.DRScore;
  var $ = function (id) { return document.getElementById(id); };

  var daily = D.generate(D.dayIndex());
  var builder = null;
  var sim = null;
  var ghost = null;
  var raf = 0;
  var lastResult = null;

  var input = { rotate: 0, throttle: 0, stage: false, action: false };
  var keys = {};
  var held = { left: false, right: false };

  // ------------------------------------------------------------- screens

  function show(name) {
    var all = document.querySelectorAll(".screen");
    for (var i = 0; i < all.length; i++) { all[i].classList.remove("on"); }
    $("screen-" + name).classList.add("on");
    if (name !== "fly") { stopLoop(); }
  }

  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("on");
    global.clearTimeout(toast._t);
    toast._t = global.setTimeout(function () { t.classList.remove("on"); }, 1700);
  }

  function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  function dist(m) {
    return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m";
  }

  // --------------------------------------------------------- brief screen

  function paintBrief() {
    var m = daily.mission, w = daily.world;
    $("briefNumber").textContent = "#" + daily.number;
    $("briefWorld").textContent = w.name;
    $("briefKicker").textContent = m.name;
    $("briefName").textContent = m.name;
    $("briefBrief").textContent = m.brief;

    var facts = [
      ["Target", dist(m.targetX) + " downrange"],
      ["Payload", m.payload + " kg"],
      ["Gravity", (w.g / 9.81).toFixed(2) + " g"],
      ["Atmosphere", w.atmo],
      ["Wind", w.wind.toFixed(1) + " m/s " + (w.windDir < 0 ? "west" : "east")],
      ["Pad width", Math.round(m.padHalfWidth * 2) + " m"]
    ];
    $("briefFacts").innerHTML = facts.map(function (f) {
      return '<div class="fact"><div class="k">' + f[0] + '</div><div class="v">' + f[1] + "</div></div>";
    }).join("");

    $("briefObjectives").innerHTML = daily.optional.map(function (o) {
      return "<li>" + o.label + " <span style='color:var(--dim)'>+" + fmt(o.bonus) + "</span></li>";
    }).join("");

    paintRecords("rec");
    tickClock();
  }

  function paintRecords(prefix) {
    var rec = S.loadDay(daily);
    $(prefix + "First").textContent = rec.first ? (rec.first.failed ? "Failed" : fmt(rec.first.total)) : "—";
    $(prefix + "Best").textContent = rec.best ? fmt(rec.best.total) : "—";
    $(prefix + "Attempts").textContent = rec.attempts || 0;
  }

  function tickClock() {
    var ms = D.msUntilReset();
    var h = Math.floor(ms / 3600000);
    var mi = Math.floor((ms % 3600000) / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    $("resetClock").textContent = pad(h) + ":" + pad(mi) + ":" + pad(s);
  }
  global.setInterval(tickClock, 1000);

  // ------------------------------------------------------- build screen

  function paintPalette() {
    var left = builder.left();
    var html = "";
    for (var i = 0; i < P.ORDER.length; i++) {
      var id = P.ORDER[i];
      if (!(id in daily.inventory) || daily.inventory[id] <= 0) { continue; }
      var p = P.CATALOG[id];
      var n = left[id] || 0;
      var cls = "part" + (builder.selected === id ? " sel" : "") + (n <= 0 ? " out" : "");
      html += '<div class="' + cls + '" data-part="' + id + '">' +
        '<div class="nm">' + p.name + "</div>" +
        '<div class="ct">×' + n + "</div>" +
        '<div class="st">' + partStat(p) + "</div></div>";
    }
    $("palette").innerHTML = html;
  }

  function partStat(p) {
    if (p.thrust) { return Math.round(p.thrust / 1000) + " kN · " + p.dry + " kg"; }
    if (p.fuel) { return p.fuel + " kg fuel"; }
    if (p.finArea) { return "stability"; }
    if (p.legTolerance) { return "+" + p.legTolerance + " m/s"; }
    if (p.chuteArea) { return "drag chute"; }
    if (p.rcsTorque) { return "vacuum control"; }
    if (p.separator) { return "staging"; }
    return p.dry + " kg";
  }

  function paintReadout() {
    var v = P.validate(builder.design, daily);
    var s = v.summary;
    var chips = [];
    chips.push(["Mass", (s.mass / 1000).toFixed(2) + " t"]);
    chips.push(["TWR", s.twr.toFixed(2)]);
    chips.push(["Δv", Math.round(s.deltaV) + " m/s"]);
    chips.push(["Fuel", Math.round(s.fuel) + " kg"]);
    chips.push(["Stages", s.stages]);
    chips.push(["Cost", "$" + s.cost]);

    var html = chips.map(function (c) {
      return '<span class="chip">' + c[0] + " <b>" + c[1] + "</b></span>";
    }).join("");
    for (var i = 0; i < v.problems.length; i++) {
      html += '<span class="chip warn">' + v.problems[i] + "</span>";
    }
    $("buildReadout").innerHTML = html;
    $("btnLaunch").disabled = !v.ok;
  }

  function onDesignChange() {
    paintPalette();
    paintReadout();
  }

  // ------------------------------------------------------------- flight

  function startFlight() {
    sim = new F.Sim(daily, builder.design);
    ghost = S.loadGhost(daily);
    input.rotate = 0;
    input.throttle = 0;
    held.left = held.right = false;
    setThrottle(0);
    $("btnAction").disabled = sim.geom.chuteArea <= 0;
    show("fly");
    resizeFly();
    startLoop();
  }

  var acc = 0, lastTime = 0;

  function startLoop() {
    lastTime = global.performance.now();
    acc = 0;
    if (!raf) { raf = global.requestAnimationFrame(frame); }
  }

  function stopLoop() {
    if (raf) { global.cancelAnimationFrame(raf); raf = 0; }
  }

  function frame(now) {
    raf = global.requestAnimationFrame(frame);
    var dt = Math.min(0.25, (now - lastTime) / 1000);
    lastTime = now;

    if (sim && !sim.done) {
      acc += dt;
      var guard = 0;
      while (acc >= F.DT && guard < 600) {
        sim.step(sampleInput());
        input.stage = false;
        input.action = false;
        acc -= F.DT;
        guard++;
        if (sim.trail.length === 0 || sim.t - sim.lastTrail > 0.12) {
          sim.lastTrail = sim.t;
          sim.trail.push({ x: sim.x, y: sim.y });
        }
        if (sim.done) { break; }
      }
    }

    renderFlight(dt);

    if (sim && sim.done && !sim.settled) {
      sim.settled = true;
      global.setTimeout(finishRun, 900);
    }
  }

  function sampleInput() {
    var rot = 0;
    if (held.left || keys.a || keys.arrowleft) { rot -= 1; }
    if (held.right || keys.d || keys.arrowright) { rot += 1; }
    input.rotate = rot;
    if (keys.w || keys.arrowup) { input.throttle = Math.min(1, input.throttle + 0.02); setThrottle(input.throttle); }
    if (keys.s || keys.arrowdown) { input.throttle = Math.max(0, input.throttle - 0.02); setThrottle(input.throttle); }
    return input;
  }

  function setThrottle(v) {
    input.throttle = Math.max(0, Math.min(1, v));
    $("throttleFill").style.height = (input.throttle * 100) + "%";
    $("throttleLbl").textContent = Math.round(input.throttle * 100) + "%";
  }

  // ------------------------------------------------------------ renderer

  var flyCanvas, flyCtx, cam = { x: 0, y: 0, scale: 6 };

  function resizeFly() {
    var dpr = global.devicePixelRatio || 1;
    var r = flyCanvas.getBoundingClientRect();
    flyCanvas.width = Math.max(1, Math.round(r.width * dpr));
    flyCanvas.height = Math.max(1, Math.round(r.height * dpr));
    flyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function renderFlight(dt) {
    if (!sim) { return; }
    var c = flyCtx;
    var dpr = global.devicePixelRatio || 1;
    var W = flyCanvas.width / dpr, H = flyCanvas.height / dpr;

    // --- camera: follow, zoom out with speed and altitude, frame the pad
    var speed = Math.hypot(sim.vx, sim.vy);
    var alt = Math.max(0, sim.altitude());
    var want = Math.max(1.1, Math.min(9, 190 / (18 + speed * 1.4 + alt * 0.07)));
    var toPad = Math.abs(sim.x - daily.mission.targetX);
    if (alt < 130 && toPad < 260) { want = Math.max(want, 4.2); }
    cam.scale += (want - cam.scale) * Math.min(1, dt * 2.2);
    var lead = Math.max(-90, Math.min(90, sim.vx * 0.55));
    cam.x += ((sim.x + lead) - cam.x) * Math.min(1, dt * 4.5);
    cam.y += ((sim.y + Math.max(0, sim.vy) * 0.35) - cam.y) * Math.min(1, dt * 4.5);

    function sx(x) { return W / 2 + (x - cam.x) * cam.scale; }
    function sy(y) { return H * 0.62 - (y - cam.y) * cam.scale; }

    // --- sky
    var w = daily.world;
    var horizon = Math.max(0, Math.min(1, alt / 4200));
    var g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, mix(w.sky[0], "#05070d", horizon));
    g.addColorStop(1, mix(w.sky[1], "#0b1018", horizon * 0.9));
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);

    drawStars(c, W, H, horizon);
    drawParallax(c, W, H, sx, sy);
    drawTerrain(c, W, H, sx, sy);
    drawPad(c, sx, sy);
    if (ghost) { drawGhost(c, sx, sy); }
    drawTrail(c, sx, sy);
    drawDebris(c, sx, sy);
    drawVehicle(c, sx, sy);
    drawEffects(c, sx, sy, dt);
    drawTargetArrow(c, W, H, sx, sy);
    paintHud();
  }

  function mix(a, b, t) {
    function hex(h) {
      return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
    }
    var A = hex(a), B = hex(b);
    var r = Math.round(A[0] + (B[0] - A[0]) * t);
    var gg = Math.round(A[1] + (B[1] - A[1]) * t);
    var bb = Math.round(A[2] + (B[2] - A[2]) * t);
    return "rgb(" + r + "," + gg + "," + bb + ")";
  }

  function drawStars(c, W, H, k) {
    if (k <= 0.05) { return; }
    c.fillStyle = "rgba(255,255,255," + (k * 0.8).toFixed(3) + ")";
    for (var i = 0; i < 70; i++) {
      var h = D.hash32(i * 9176 + 13);
      var x = (h % 1000) / 1000 * W;
      var y = ((h >>> 10) % 1000) / 1000 * H * 0.7;
      var s = ((h >>> 20) % 3) * 0.5 + 0.5;
      c.fillRect(x, y, s, s);
    }
  }

  function drawParallax(c, W, H, sx, sy) {
    var w = daily.world;
    var t = daily.terrain;
    for (var layer = 2; layer >= 1; layer--) {
      var depth = layer === 2 ? 0.35 : 0.62;
      var shade = layer === 2 ? 0.55 : 0.3;
      c.fillStyle = mix(w.rock, "#0d1219", shade);
      c.beginPath();
      var started = false;
      for (var px = -20; px <= W + 20; px += 24) {
        var worldX = cam.x + (px - W / 2) / cam.scale / depth;
        var h = t.heightAt(Math.max(0, worldX)) * (layer === 2 ? 1.5 : 1.2) + layer * 30;
        var y = sy(h * depth + (1 - depth) * cam.y);
        if (!started) { c.moveTo(px, y); started = true; } else { c.lineTo(px, y); }
      }
      c.lineTo(W + 20, H + 20);
      c.lineTo(-20, H + 20);
      c.closePath();
      c.fill();
    }
  }

  function drawTerrain(c, W, H, sx, sy) {
    var t = daily.terrain;
    var x0 = cam.x - (W / 2) / cam.scale - 60;
    var x1 = cam.x + (W / 2) / cam.scale + 60;
    var stepPx = 3;
    c.fillStyle = daily.world.ground;
    c.beginPath();
    var first = true;
    for (var px = 0; px <= W; px += stepPx) {
      var wx = x0 + (x1 - x0) * (px / W);
      var y = sy(t.heightAt(Math.max(0, wx)));
      if (first) { c.moveTo(px, y); first = false; } else { c.lineTo(px, y); }
    }
    c.lineTo(W, H + 40);
    c.lineTo(0, H + 40);
    c.closePath();
    c.fill();

    c.strokeStyle = "rgba(255,255,255,.16)";
    c.lineWidth = 1.5;
    c.beginPath();
    first = true;
    for (px = 0; px <= W; px += stepPx) {
      wx = x0 + (x1 - x0) * (px / W);
      y = sy(t.heightAt(Math.max(0, wx)));
      if (first) { c.moveTo(px, y); first = false; } else { c.lineTo(px, y); }
    }
    c.stroke();
  }

  function drawPad(c, sx, sy) {
    var m = daily.mission, t = daily.terrain;
    var y = t.padY;
    var x0 = sx(m.targetX - m.padHalfWidth);
    var x1 = sx(m.targetX + m.padHalfWidth);
    var py = sy(y);
    c.fillStyle = "#2b3442";
    c.fillRect(x0, py - 3, x1 - x0, 6);
    c.fillStyle = "#fa6862";
    c.fillRect(sx(m.targetX) - 1.5, py - 16, 3, 16);
    c.strokeStyle = "rgba(250,104,98,.6)";
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(x0, py - 3); c.lineTo(x0, py - 12); c.stroke();
    c.beginPath(); c.moveTo(x1, py - 3); c.lineTo(x1, py - 12); c.stroke();

    // launch pad
    var ly = sy(t.launchY);
    c.fillStyle = "#2b3442";
    c.fillRect(sx(-70), ly - 3, sx(70) - sx(-70), 6);
  }

  function drawGhost(c, sx, sy) {
    c.strokeStyle = "rgba(255,255,255,.18)";
    c.lineWidth = 1.5;
    c.setLineDash([4, 5]);
    c.beginPath();
    for (var i = 0; i < ghost.length; i++) {
      var p = ghost[i];
      if (i === 0) { c.moveTo(sx(p.x), sy(p.y)); } else { c.lineTo(sx(p.x), sy(p.y)); }
    }
    c.stroke();
    c.setLineDash([]);
  }

  function drawTrail(c, sx, sy) {
    if (sim.trail.length < 2) { return; }
    c.strokeStyle = "rgba(250,104,98,.45)";
    c.lineWidth = 2;
    c.beginPath();
    for (var i = 0; i < sim.trail.length; i++) {
      var p = sim.trail[i];
      if (i === 0) { c.moveTo(sx(p.x), sy(p.y)); } else { c.lineTo(sx(p.x), sy(p.y)); }
    }
    c.stroke();
  }

  function drawDebris(c, sx, sy) {
    for (var i = 0; i < sim.debris.length; i++) {
      var d = sim.debris[i];
      c.save();
      c.translate(sx(d.x), sy(d.y));
      c.rotate(d.ang);
      var w = d.w * cam.scale, h = d.h * cam.scale;
      c.fillStyle = d.landed ? (d.intact ? "#4b5a71" : "#3a2f2f") : "#44526a";
      c.fillRect(-w / 2, -h / 2, w, h);
      c.restore();
    }
  }

  function drawVehicle(c, sx, sy) {
    var a = sim.geom;
    c.save();
    c.translate(sx(sim.x), sy(sim.y));
    c.rotate(sim.ang);
    var s = cam.scale;

    // exhaust
    var burning = (sim.throttle > 0 && sim.fuel > 0 && a.thrust > 0) || (sim.solidLit && sim.solid > 0);
    if (burning) {
      var power = sim.solidLit && sim.solid > 0 ? 1 : sim.throttle;
      var len = (2.5 + power * 9) * s;
      var wdt = a.width * 0.5 * s;
      var flame = c.createLinearGradient(0, (a.height / 2 - a.base) * s, 0, (a.height / 2 - a.base) * s + len);
      flame.addColorStop(0, "rgba(255,240,200,.95)");
      flame.addColorStop(0.4, "rgba(250,140,80,.75)");
      flame.addColorStop(1, "rgba(250,104,98,0)");
      c.fillStyle = flame;
      c.beginPath();
      c.moveTo(-wdt * 0.6, (a.height / 2 - a.base) * s);
      c.lineTo(wdt * 0.6, (a.height / 2 - a.base) * s);
      c.lineTo(0, (a.height / 2 - a.base) * s + len);
      c.closePath();
      c.fill();
    }

    // body
    for (var i = 0; i < a.items.length; i++) {
      var it = a.items[i];
      if (!it.attached) { continue; }
      var p = it.part;
      var yc = (it.y0 + it.y1) / 2 - a.height / 2;
      var w = p.w * s, h = (it.y1 - it.y0) * s;
      c.fillStyle = p.thrust ? "#4a3b46" : p.fuel ? "#33455c" : p.separator ? "#5c4a2c" : "#39465b";
      if (it.index < 0) { c.fillStyle = "#5a5f52"; }
      c.fillRect(-w / 2, -yc * s - h / 2, w, h);
      c.strokeStyle = "rgba(255,255,255,.25)";
      c.lineWidth = 1;
      c.strokeRect(-w / 2, -yc * s - h / 2, w, h);

      for (var j = 0; j < it.radial.length; j++) {
        var rp = P.CATALOG[it.radial[j]];
        var side = j % 2 === 0 ? -1 : 1;
        var rw = rp.w * s * 0.8, rh = Math.min(rp.h, it.y1 - it.y0 + 2.5) * s;
        c.fillStyle = rp.thrust ? "#4a3b46" : rp.finArea ? "#3b5348" : "#3f4a5e";
        c.fillRect(side < 0 ? -w / 2 - rw : w / 2, -yc * s - rh / 2, rw, rh);
      }
    }

    // chute
    if (sim.chuteOut) {
      var d = Math.min(1, (sim.t - sim.chuteDeployTime) / 1.4);
      var cw = 9 * s * d, ch = 4.5 * s * d;
      c.fillStyle = "rgba(250,104,98,.85)";
      c.beginPath();
      c.ellipse(0, -(a.height / 2) * s - ch, cw / 2, ch, 0, Math.PI, 0);
      c.fill();
    }
    c.restore();
  }

  function drawEffects(c, sx, sy, dt) {
    for (var i = sim.effects.length - 1; i >= 0; i--) {
      var e = sim.effects[i];
      e.life -= dt;
      if (e.life <= 0) { sim.effects.splice(i, 1); continue; }
      var k = e.life;
      if (e.type === "boom") {
        var r = (e.r || 10) * (1.6 - k) * cam.scale;
        c.fillStyle = "rgba(250,140,80," + (k * 0.6).toFixed(3) + ")";
        c.beginPath(); c.arc(sx(e.x), sy(e.y), Math.max(2, r), 0, Math.PI * 2); c.fill();
      } else {
        c.fillStyle = "rgba(255,255,255," + (k * 1.4).toFixed(3) + ")";
        c.beginPath(); c.arc(sx(e.x), sy(e.y), 8 * cam.scale * (1 - k), 0, Math.PI * 2); c.fill();
      }
    }
  }

  function drawTargetArrow(c, W, H, sx, sy) {
    var tx = sx(daily.mission.targetX);
    if (tx > 24 && tx < W - 24) { return; }
    var edge = tx <= 24 ? 20 : W - 20;
    var d = Math.abs(sim.x - daily.mission.targetX);
    c.fillStyle = "rgba(250,104,98,.9)";
    c.beginPath();
    var dir = tx <= 24 ? -1 : 1;
    c.moveTo(edge + dir * 9, H * 0.42);
    c.lineTo(edge - dir * 6, H * 0.42 - 8);
    c.lineTo(edge - dir * 6, H * 0.42 + 8);
    c.closePath();
    c.fill();
    c.font = "700 11px 'Open Sans', sans-serif";
    c.textAlign = tx <= 24 ? "left" : "right";
    c.fillText(dist(d), tx <= 24 ? 8 : W - 8, H * 0.42 + 24);
    c.textAlign = "left";
  }

  function paintHud() {
    var a = sim.geom;
    var alt = sim.altitude();
    var d = sim.x - daily.mission.targetX;
    var fuelPct = sim.fuelCapacityTotal > 0
      ? ((sim.fuel + sim.solid) / sim.fuelCapacityTotal) * 100 : 0;
    var tilt = sim.normAngle(sim.ang) * 57.2958;
    var vSpeedAlert = sim.vy < -12 && alt < 220;

    var cells = [
      ["Alt", Math.round(alt) + " m", alt < 40 && sim.liftedOff],
      ["V↕", sim.vy.toFixed(1), vSpeedAlert],
      ["V↔", sim.vx.toFixed(1), false],
      ["Fuel", Math.round(fuelPct) + "%", fuelPct < 12],
      ["Tilt", Math.round(tilt) + "°", Math.abs(tilt) > 45],
      ["To pad", dist(Math.abs(d)), false],
      ["Stage", (sim.stageIndex + 1) + "/" + sim.stageList.length, false],
      ["T+", sim.t.toFixed(1), false]
    ];
    $("hudRow").innerHTML = cells.map(function (c) {
      return '<div class="tel' + (c[2] ? " alert" : "") + '"><span class="k">' + c[0] +
        '</span><span class="v">' + c[1] + "</span></div>";
    }).join("");
  }

  // ------------------------------------------------------------- results

  function finishRun() {
    var result = S.score(sim, daily);
    lastResult = result;
    var out = S.submit(daily, result, sim, builder.design);

    $("resNumber").textContent = "#" + daily.number;
    $("resHeadline").textContent = result.failed ? "Mission Failed" : "Mission Complete";
    $("resVerdict").textContent = result.failed ? "Failed" :
      (out.isBest ? "New personal best" : "Complete");
    $("resVerdict").className = "verdict" + (result.failed ? "" : " ok");
    $("resScore").textContent = result.failed ? "—" : fmt(result.total);
    $("resNote").textContent = result.failed ? sim.message :
      (out.isFirst ? "That was your blind run — it is locked in for today." :
        (out.isBest ? "Best of the day so far." : "Your best today is " + fmt(out.record.best.total) + "."));

    var rows = result.lines.map(function (l) {
      return '<div class="ln"><span class="lb">' + l.label + '</span><span class="dt">' +
        l.detail + '</span><span class="vl">+' + fmt(l.value) + "</span></div>";
    }).join("");
    if (!result.failed) {
      rows += '<div class="ln tot"><span class="lb">Total</span><span class="vl">' +
        fmt(result.total) + "</span></div>";
    }
    $("resBreakdown").innerHTML = rows || '<div class="ln"><span class="lb">No score recorded.</span></div>';

    $("resObjectives").innerHTML = (result.objectives || daily.optional.map(function (o) {
      return { label: o.label, met: false, bonus: o.bonus };
    })).map(function (o) {
      return '<li class="' + (o.met ? "met" : "") + '">' + o.label +
        " <span style='color:var(--dim)'>+" + fmt(o.bonus) + "</span></li>";
    }).join("");

    paintRecords("res");
    show("result");
  }

  // --------------------------------------------------------------- input

  function bindFlightControls() {
    function pressHold(el, on, off) {
      var start = function (e) { e.preventDefault(); el.classList.add("down"); on(); };
      var end = function () { el.classList.remove("down"); off(); };
      el.addEventListener("touchstart", start, { passive: false });
      el.addEventListener("touchend", end);
      el.addEventListener("touchcancel", end);
      el.addEventListener("mousedown", start);
      el.addEventListener("mouseup", end);
      el.addEventListener("mouseleave", end);
    }

    pressHold($("btnLeft"), function () { held.left = true; }, function () { held.left = false; });
    pressHold($("btnRight"), function () { held.right = true; }, function () { held.right = false; });

    $("btnStage").addEventListener("click", function () { input.stage = true; });
    $("btnAction").addEventListener("click", function () { input.action = true; });

    var th = $("throttle");
    var dragging = false;
    function fromEvent(e) {
      var r = th.getBoundingClientRect();
      var t = e.touches && e.touches.length ? e.touches[0] : e;
      setThrottle(1 - (t.clientY - r.top) / r.height);
    }
    th.addEventListener("touchstart", function (e) { dragging = true; fromEvent(e); e.preventDefault(); }, { passive: false });
    th.addEventListener("touchmove", function (e) { if (dragging) { fromEvent(e); e.preventDefault(); } }, { passive: false });
    th.addEventListener("touchend", function () { dragging = false; });
    th.addEventListener("mousedown", function (e) { dragging = true; fromEvent(e); });
    global.addEventListener("mousemove", function (e) { if (dragging) { fromEvent(e); } });
    global.addEventListener("mouseup", function () { dragging = false; });

    global.addEventListener("keydown", function (e) {
      var k = e.key.toLowerCase();
      keys[k] = true;
      if (k === " " || k === "spacebar") { input.stage = true; e.preventDefault(); }
      if (k === "e") { input.action = true; }
      if (k === "r") { if ($("screen-fly").classList.contains("on") || $("screen-result").classList.contains("on")) { startFlight(); } }
      if (k === "arrowup" || k === "arrowdown") { e.preventDefault(); }
    });
    global.addEventListener("keyup", function (e) { keys[e.key.toLowerCase()] = false; });
  }

  // ----------------------------------------------------------------- go

  function init() {
    flyCanvas = $("flyCanvas");
    flyCtx = flyCanvas.getContext("2d");

    builder = new global.DRBuilder($("buildCanvas"), daily, onDesignChange);

    var rec = S.loadDay(daily);
    if (rec.best && rec.best.design) { builder.load(rec.best.design); }

    paintBrief();

    $("btnBuild").addEventListener("click", function () {
      show("build");
      $("buildTitle").textContent = daily.mission.name;
      builder.resize();
      onDesignChange();
    });
    $("btnBackBrief").addEventListener("click", function () { paintBrief(); show("brief"); });
    $("btnUndo").addEventListener("click", function () { builder.undo(); paintPalette(); paintReadout(); });
    $("btnRedo").addEventListener("click", function () { builder.redo(); paintPalette(); paintReadout(); });
    $("btnReset").addEventListener("click", function () { builder.reset(); paintPalette(); paintReadout(); });
    $("btnZoomIn").addEventListener("click", function () { builder.zoom = Math.min(3, builder.zoom * 1.2); builder.draw(); });
    $("btnZoomOut").addEventListener("click", function () { builder.zoom = Math.max(0.4, builder.zoom / 1.2); builder.draw(); });
    $("btnBuildHelp").addEventListener("click", function () {
      toast("Tap a part, then tap a red slot. Tap a placed part to remove it.");
    });

    $("palette").addEventListener("click", function (e) {
      var el = e.target.closest ? e.target.closest(".part") : null;
      if (!el) { return; }
      builder.select(el.getAttribute("data-part"));
      paintPalette();
    });

    $("btnLaunch").addEventListener("click", startFlight);
    $("btnAgain").addEventListener("click", startFlight);
    $("btnEdit").addEventListener("click", function () {
      show("build");
      builder.resize();
      onDesignChange();
    });
    $("btnHelp").addEventListener("click", function () {
      var h = $("helpPanel");
      h.style.display = h.style.display === "none" ? "block" : "none";
    });
    $("btnShare").addEventListener("click", function () {
      var rec2 = S.loadDay(daily);
      var text = S.shareText(daily, lastResult || { failed: true }, rec2);
      if (global.navigator.share) {
        global.navigator.share({ text: text }).catch(function () {});
      } else if (global.navigator.clipboard) {
        global.navigator.clipboard.writeText(text).then(function () { toast("Copied"); },
          function () { toast("Copy failed"); });
      } else {
        toast("Sharing unavailable");
      }
    });

    bindFlightControls();

    global.addEventListener("resize", function () {
      if ($("screen-build").classList.contains("on")) { builder.resize(); }
      if ($("screen-fly").classList.contains("on")) { resizeFly(); }
    });

    // expose for automated checks
    global.DRGame = {
      daily: daily,
      get sim() { return sim; },
      builder: function () { return builder; },
      startFlight: startFlight,
      setThrottle: setThrottle,
      input: input
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
