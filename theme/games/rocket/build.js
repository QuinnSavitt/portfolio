/* Daily Rocket - the assembly screen.
 *
 * Deliberately not CAD. The vehicle is a vertical stack with radial clamps,
 * so there are only ever a handful of legal places a part can go. Tap a part
 * in the bin, tap a highlighted slot. Tap a placed part to pull it off.
 */
(function (global) {
  "use strict";

  var P = global.DRParts;

  function Builder(canvas, daily, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.daily = daily;
    this.onChange = onChange || function () {};
    this.design = P.emptyDesign();
    this.history = [];
    this.future = [];
    this.selected = null;
    this.zoom = 1;
    this.panY = 0;
    this.slots = [];
    this.hit = [];
    this.bindInput();
  }

  Builder.prototype.snapshot = function () {
    return JSON.parse(JSON.stringify(this.design));
  };

  Builder.prototype.commit = function () {
    this.history.push(this.snapshot());
    if (this.history.length > 80) { this.history.shift(); }
    this.future.length = 0;
  };

  Builder.prototype.undo = function () {
    if (!this.history.length) { return; }
    this.future.push(this.snapshot());
    this.design = this.history.pop();
    this.changed();
  };

  Builder.prototype.redo = function () {
    if (!this.future.length) { return; }
    this.history.push(this.snapshot());
    this.design = this.future.pop();
    this.changed();
  };

  Builder.prototype.reset = function () {
    this.commit();
    this.design = P.emptyDesign();
    this.changed();
  };

  Builder.prototype.load = function (design) {
    this.design = JSON.parse(JSON.stringify(design));
    this.history.length = 0;
    this.future.length = 0;
    this.changed();
  };

  Builder.prototype.changed = function () {
    this.draw();
    this.onChange(this.design);
  };

  Builder.prototype.left = function () {
    return P.remaining(this.design, this.daily.inventory);
  };

  Builder.prototype.select = function (partId) {
    var left = this.left();
    if (partId && (left[partId] || 0) <= 0) { return; }
    this.selected = this.selected === partId ? null : partId;
    this.draw();
    this.onChange(this.design);
  };

  // ------------------------------------------------------------- placing

  Builder.prototype.canPlaceAxial = function (partId, index) {
    var part = P.CATALOG[partId];
    if (part.kind !== "axial") { return false; }
    // engines only make sense at the bottom of a stack section
    if (part.thrust && index !== 0) {
      var below = this.design.stack[index - 1];
      if (below && !P.CATALOG[below].separator) { return false; }
    }
    return true;
  };

  Builder.prototype.placeAxial = function (partId, index) {
    this.commit();
    this.design.stack.splice(index, 0, partId);
    // radial attachments are keyed by stack index, so shift them up
    var moved = {};
    for (var k in this.design.radial) {
      if (!Object.prototype.hasOwnProperty.call(this.design.radial, k)) { continue; }
      var ki = parseInt(k, 10);
      moved[ki >= index ? ki + 1 : ki] = this.design.radial[k];
    }
    this.design.radial = moved;
    if ((this.left()[partId] || 0) <= 0) { this.selected = null; }
    this.changed();
  };

  Builder.prototype.placeRadial = function (partId, index) {
    this.commit();
    if (!this.design.radial[index]) { this.design.radial[index] = []; }
    this.design.radial[index].push(partId);
    if ((this.left()[partId] || 0) <= 0) { this.selected = null; }
    this.changed();
  };

  Builder.prototype.removeAxial = function (index) {
    this.commit();
    this.design.stack.splice(index, 1);
    var moved = {};
    for (var k in this.design.radial) {
      if (!Object.prototype.hasOwnProperty.call(this.design.radial, k)) { continue; }
      var ki = parseInt(k, 10);
      if (ki === index) { continue; }
      moved[ki > index ? ki - 1 : ki] = this.design.radial[k];
    }
    this.design.radial = moved;
    this.changed();
  };

  Builder.prototype.removeRadial = function (index, slot) {
    this.commit();
    var list = this.design.radial[index];
    if (!list) { return; }
    list.splice(slot, 1);
    if (!list.length) { delete this.design.radial[index]; }
    this.changed();
  };

  // ------------------------------------------------------------ geometry

  Builder.prototype.layout = function () {
    var items = [];
    var y = 0;
    for (var i = 0; i < this.design.stack.length; i++) {
      var p = P.CATALOG[this.design.stack[i]];
      items.push({ index: i, part: p, y0: y, y1: y + p.h });
      y += p.h;
    }
    var pay = P.CATALOG.payload;
    items.push({ index: -1, part: pay, y0: y, y1: y + pay.h });
    return { items: items, height: y + pay.h };
  };

  Builder.prototype.view = function () {
    var L = this.layout();
    var w = this.canvas.width / (global.devicePixelRatio || 1);
    var h = this.canvas.height / (global.devicePixelRatio || 1);
    var span = Math.max(L.height + 6, 12);
    var scale = Math.min(h / span, w / 14) * this.zoom;
    return {
      L: L, w: w, h: h, scale: scale,
      cx: w / 2,
      baseY: h / 2 + (L.height * scale) / 2 + this.panY
    };
  };

  // -------------------------------------------------------------- render

  Builder.prototype.resize = function () {
    var dpr = global.devicePixelRatio || 1;
    var r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  };

  Builder.prototype.draw = function () {
    var c = this.ctx, v = this.view();
    var i, j;
    c.clearRect(0, 0, v.w, v.h);

    // ground line + sky wash
    var g = c.createLinearGradient(0, 0, 0, v.h);
    g.addColorStop(0, "#141a23");
    g.addColorStop(1, "#1b222d");
    c.fillStyle = g;
    c.fillRect(0, 0, v.w, v.h);

    c.strokeStyle = "#2a3342";
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, v.baseY + 0.5);
    c.lineTo(v.w, v.baseY + 0.5);
    c.stroke();

    this.hit = [];
    this.slots = [];

    var sel = this.selected ? P.CATALOG[this.selected] : null;

    // radial attachment points and the parts already on them
    for (i = 0; i < v.L.items.length; i++) {
      var it = v.L.items[i];
      if (it.index < 0) { continue; }
      var list = this.design.radial[it.index] || [];
      for (j = 0; j < list.length; j++) {
        this.drawRadial(c, v, it, list[j], j, list.length);
      }
    }

    // the axial stack
    for (i = 0; i < v.L.items.length; i++) {
      this.drawAxial(c, v, v.L.items[i]);
    }

    // legal slots for whatever is selected
    if (sel) {
      if (sel.kind === "axial") {
        for (i = 0; i <= this.design.stack.length; i++) {
          if (!this.canPlaceAxial(this.selected, i)) { continue; }
          this.drawAxialSlot(c, v, i);
        }
      } else {
        for (i = 0; i < v.L.items.length; i++) {
          if (v.L.items[i].index < 0) { continue; }
          this.drawRadialSlot(c, v, v.L.items[i]);
        }
      }
    }

    if (!this.design.stack.length && !sel) {
      c.fillStyle = "#67748a";
      c.font = "600 12px 'Open Sans', sans-serif";
      c.textAlign = "center";
      c.fillText("Pick a part below, then tap a highlighted slot", v.cx, v.baseY + 34);
      c.textAlign = "left";
    }
  };

  Builder.prototype.px = function (v, worldY) { return v.baseY - worldY * v.scale; };

  Builder.prototype.drawAxial = function (c, v, it) {
    var p = it.part;
    var w = p.w * v.scale;
    var x = v.cx - w / 2;
    var yTop = this.px(v, it.y1);
    var hgt = (it.y1 - it.y0) * v.scale;

    var fill = "#39465b", stroke = "#55637b";
    if (p.thrust) { fill = "#4a3b46"; stroke = "#7b5a63"; }
    if (p.separator) { fill = "#5c4a2c"; stroke = "#8a7040"; }
    if (p.fuel) { fill = "#33455c"; stroke = "#4f6a8c"; }
    if (it.index < 0) { fill = "#5a5f52"; stroke = "#8d9578"; }

    c.fillStyle = fill;
    c.strokeStyle = stroke;
    c.lineWidth = 1.5;
    c.fillRect(x, yTop, w, hgt);
    c.strokeRect(x + 0.5, yTop + 0.5, w - 1, hgt - 1);

    if (p.thrust) {
      c.fillStyle = "#26303f";
      c.beginPath();
      c.moveTo(x + w * 0.2, yTop + hgt);
      c.lineTo(x + w * 0.8, yTop + hgt);
      c.lineTo(x + w * 0.62, yTop + hgt * 0.62);
      c.lineTo(x + w * 0.38, yTop + hgt * 0.62);
      c.closePath();
      c.fill();
    }
    if (it.index < 0) {
      c.fillStyle = "#c9d2b6";
      c.beginPath();
      c.moveTo(x, yTop + hgt);
      c.lineTo(x + w / 2, yTop - hgt * 0.5);
      c.lineTo(x + w, yTop + hgt);
      c.closePath();
      c.fill();
    }

    if (hgt > 16 && it.index >= 0) {
      c.fillStyle = "rgba(255,255,255,.5)";
      c.font = "600 9px 'Open Sans', sans-serif";
      c.textAlign = "center";
      c.fillText(p.name.toUpperCase(), v.cx, yTop + hgt / 2 + 3);
      c.textAlign = "left";
    }

    if (it.index >= 0) {
      this.hit.push({ kind: "axial", index: it.index, x: x, y: yTop, w: w, h: hgt });
    }
  };

  Builder.prototype.drawRadial = function (c, v, it, partId, slot, count) {
    var p = P.CATALOG[partId];
    var side = slot % 2 === 0 ? -1 : 1;
    var tier = Math.floor(slot / 2);
    var stackW = it.part.w * v.scale;
    var w = p.w * v.scale * 0.8;
    var hgt = Math.min(p.h, it.y1 - it.y0 + 2.5) * v.scale;
    var x = v.cx + side * (stackW / 2) - (side < 0 ? w : 0) + side * tier * (w * 0.55);
    var y = this.px(v, it.y1) + 2;

    var fill = "#3f4a5e", stroke = "#5e6c85";
    if (p.thrust) { fill = "#4a3b46"; stroke = "#7b5a63"; }
    if (p.finArea) { fill = "#3b5348"; stroke = "#5d8471"; }
    if (p.legTolerance) { fill = "#4b4636"; stroke = "#77704f"; }

    c.fillStyle = fill;
    c.strokeStyle = stroke;
    c.lineWidth = 1.2;

    if (p.finArea) {
      c.beginPath();
      c.moveTo(x + (side < 0 ? w : 0), y);
      c.lineTo(x + (side < 0 ? w : 0), y + hgt);
      c.lineTo(x + (side < 0 ? 0 : w), y + hgt);
      c.closePath();
      c.fill(); c.stroke();
    } else if (p.legTolerance) {
      c.beginPath();
      c.moveTo(x + (side < 0 ? w : 0), y);
      c.lineTo(x + (side < 0 ? 0 : w), y + hgt);
      c.lineWidth = 3;
      c.strokeStyle = stroke;
      c.stroke();
      c.lineWidth = 1.2;
    } else {
      c.fillRect(x, y, w, hgt);
      c.strokeRect(x + 0.5, y + 0.5, w - 1, hgt - 1);
    }

    this.hit.push({ kind: "radial", index: it.index, slot: slot, x: x, y: y, w: w, h: hgt });
  };

  Builder.prototype.drawAxialSlot = function (c, v, index) {
    var L = v.L;
    var y = index < L.items.length ? L.items[index].y0 : L.height;
    var py = this.px(v, y);
    var w = 2.0 * v.scale;
    c.save();
    c.setLineDash([5, 4]);
    c.strokeStyle = "#fa6862";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(v.cx - w / 2, py);
    c.lineTo(v.cx + w / 2, py);
    c.stroke();
    c.restore();
    c.fillStyle = "rgba(250,104,98,.85)";
    c.beginPath();
    c.arc(v.cx, py, 7, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#fff";
    c.font = "700 11px 'Open Sans', sans-serif";
    c.textAlign = "center";
    c.fillText("+", v.cx, py + 4);
    c.textAlign = "left";

    this.slots.push({ kind: "axial", index: index, x: v.cx - 26, y: py - 18, w: 52, h: 36 });
  };

  Builder.prototype.drawRadialSlot = function (c, v, it) {
    var stackW = it.part.w * v.scale;
    var yMid = (this.px(v, it.y0) + this.px(v, it.y1)) / 2;
    for (var s = -1; s <= 1; s += 2) {
      var x = v.cx + s * (stackW / 2 + 12);
      c.fillStyle = "rgba(250,104,98,.85)";
      c.beginPath();
      c.arc(x, yMid, 7, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#fff";
      c.font = "700 11px 'Open Sans', sans-serif";
      c.textAlign = "center";
      c.fillText("+", x, yMid + 4);
      c.textAlign = "left";
      this.slots.push({ kind: "radial", index: it.index, x: x - 18, y: yMid - 18, w: 36, h: 36 });
    }
  };

  // --------------------------------------------------------------- input

  Builder.prototype.bindInput = function () {
    var self = this;
    var startY = 0, startPan = 0, moved = false, pinch = 0, startZoom = 1;

    function pos(e) {
      var r = self.canvas.getBoundingClientRect();
      var t = e.touches && e.touches.length ? e.touches[0] : e;
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    }

    function down(e) {
      moved = false;
      var p = pos(e);
      startY = p.y; startPan = self.panY;
      if (e.touches && e.touches.length === 2) {
        pinch = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
        startZoom = self.zoom;
      }
    }

    function move(e) {
      if (e.touches && e.touches.length === 2 && pinch > 0) {
        var d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
        self.zoom = Math.max(0.4, Math.min(3, startZoom * (d / pinch)));
        moved = true;
        self.draw();
        e.preventDefault();
        return;
      }
      var p = pos(e);
      if (Math.abs(p.y - startY) > 8) {
        moved = true;
        self.panY = startPan + (p.y - startY);
        self.draw();
        e.preventDefault();
      }
    }

    function up(e) {
      pinch = 0;
      if (moved) { return; }
      var p = pos(e.changedTouches ? { touches: e.changedTouches } : e);
      self.tap(p.x, p.y);
    }

    this.canvas.addEventListener("mousedown", down);
    this.canvas.addEventListener("mousemove", move);
    this.canvas.addEventListener("mouseup", up);
    this.canvas.addEventListener("touchstart", down, { passive: true });
    this.canvas.addEventListener("touchmove", move, { passive: false });
    this.canvas.addEventListener("touchend", up);
    this.canvas.addEventListener("wheel", function (e) {
      self.zoom = Math.max(0.4, Math.min(3, self.zoom * (e.deltaY < 0 ? 1.12 : 0.89)));
      self.draw();
      e.preventDefault();
    }, { passive: false });
  };

  Builder.prototype.tap = function (x, y) {
    var i, s;
    // slots win over parts so you can always add next to something
    for (i = 0; i < this.slots.length; i++) {
      s = this.slots[i];
      if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
        if (!this.selected) { return; }
        if (s.kind === "axial") { this.placeAxial(this.selected, s.index); }
        else { this.placeRadial(this.selected, s.index); }
        return;
      }
    }
    for (i = this.hit.length - 1; i >= 0; i--) {
      s = this.hit[i];
      if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
        if (s.kind === "axial") { this.removeAxial(s.index); }
        else { this.removeRadial(s.index, s.slot); }
        return;
      }
    }
  };

  global.DRBuilder = Builder;
})(window);
