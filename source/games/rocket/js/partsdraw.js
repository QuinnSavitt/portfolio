/* Daily Rocket — vector art for parts, shared by the hangar and the flight
 * renderer. Everything is drawn in metres in the vessel's local frame with
 * y pointing DOWN the screen (y = -s), so callers set a transform of
 * translate(origin) · rotate(ang) · scale(pixelsPerMetre) and draw.
 */

export const INK = {
  body: "#eef1f5", bodyShade: "#b9c1cc", bodyDark: "#8a95a5",
  trim: "#2b3442", accent: "#fa6862", accentDark: "#c9463f",
  metal: "#7b8696", metalDark: "#3d4552", copper: "#c98a55", copperDark: "#7d4a2a",
  hazard: "#f0c24e", glass: "#7fc4e8", srb: "#f4efe6", srbBand: "#e2733f",
  line: "rgba(20,26,36,0.55)"
};

function shadeX(ctx, x, w, light, dark) {
  const g = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
  g.addColorStop(0, dark);
  g.addColorStop(0.28, light);
  g.addColorStop(0.55, light);
  g.addColorStop(1, dark);
  return g;
}

function rect(ctx, x, y, w, h) { ctx.beginPath(); ctx.rect(x, y, w, h); }

function outline(ctx, px) {
  ctx.lineWidth = px;
  ctx.strokeStyle = INK.line;
  ctx.stroke();
}

/* Draw one part. `px` = one screen pixel in metres (for line widths).
 * opts: { legsOut, fill (0..1 tank level), ghost, selected, lit (burning) } */
export function drawPart(ctx, p, px, opts) {
  opts = opts || {};
  const x = p.c, top = -p.s1, bot = -p.s0, w = p.w, h = p.h;
  const d = p.def;
  ctx.save();
  if (opts.ghost) { ctx.globalAlpha *= 0.35; }
  switch (p.kind) {
    case "payload": drawPayload(ctx, p, px); break;
    case "nose": {
      ctx.beginPath();
      ctx.moveTo(x - w / 2, bot);
      ctx.bezierCurveTo(x - w / 2, bot - h * 0.55, x - w * 0.18, top + h * 0.08, x, top);
      ctx.bezierCurveTo(x + w * 0.18, top + h * 0.08, x + w / 2, bot - h * 0.55, x + w / 2, bot);
      ctx.closePath();
      ctx.fillStyle = shadeX(ctx, x, w, INK.body, INK.bodyShade);
      ctx.fill(); outline(ctx, px);
      ctx.beginPath();
      ctx.moveTo(x - w * 0.14, top + h * 0.2);
      ctx.bezierCurveTo(x - w * 0.08, top + h * 0.05, x + w * 0.08, top + h * 0.05, x + w * 0.14, top + h * 0.2);
      ctx.lineTo(x, top); ctx.closePath();
      ctx.fillStyle = INK.accent; ctx.fill();
      break;
    }
    case "tank": {
      rect(ctx, x - w / 2, top, w, h);
      ctx.fillStyle = shadeX(ctx, x, w, INK.body, INK.bodyShade);
      ctx.fill();
      // propellant level shown as a faint inner tint (hangar and flight)
      if (opts.fill != null) {
        const f = Math.max(0, Math.min(1, opts.fill));
        ctx.fillStyle = "rgba(250,104,98,0.13)";
        ctx.fillRect(x - w / 2 + w * 0.12, bot - h * f, w * 0.76, h * f);
      }
      ctx.fillStyle = INK.trim;
      ctx.fillRect(x - w / 2, top, w, Math.min(0.12, h * 0.1));
      ctx.fillRect(x - w / 2, bot - Math.min(0.12, h * 0.1), w, Math.min(0.12, h * 0.1));
      if (h > 1.4) {
        ctx.fillStyle = INK.accent;
        ctx.fillRect(x - w / 2, top + h * 0.3, w, h * 0.06);
      }
      rect(ctx, x - w / 2, top, w, h); outline(ctx, px);
      break;
    }
    case "engine": drawEngine(ctx, x, top, w, h, d, px); break;
    case "srb": {
      const cone = Math.min(0.7, w * 0.8);
      ctx.beginPath();
      ctx.moveTo(x - w / 2, bot - 0.25);
      ctx.lineTo(x - w / 2, top + cone);
      ctx.quadraticCurveTo(x - w / 2, top, x, top);
      ctx.quadraticCurveTo(x + w / 2, top, x + w / 2, top + cone);
      ctx.lineTo(x + w / 2, bot - 0.25);
      ctx.closePath();
      ctx.fillStyle = shadeX(ctx, x, w, INK.srb, "#bdb6a8");
      ctx.fill(); outline(ctx, px);
      ctx.fillStyle = INK.srbBand;
      for (let k = 1; k < 4; k++) { ctx.fillRect(x - w / 2, top + cone + (h - cone - 0.25) * k / 4 - 0.06, w, 0.12); }
      // nozzle
      ctx.beginPath();
      ctx.moveTo(x - w * 0.25, bot - 0.25); ctx.lineTo(x - w * 0.36, bot);
      ctx.lineTo(x + w * 0.36, bot); ctx.lineTo(x + w * 0.25, bot - 0.25); ctx.closePath();
      ctx.fillStyle = INK.metalDark; ctx.fill();
      break;
    }
    case "decoupler": {
      rect(ctx, x - w / 2, top, w, h);
      ctx.fillStyle = INK.trim; ctx.fill();
      ctx.save();
      ctx.beginPath(); ctx.rect(x - w / 2, top + h * 0.25, w, h * 0.5); ctx.clip();
      ctx.fillStyle = INK.hazard;
      for (let k = -w; k < w; k += 0.36) {
        ctx.beginPath();
        ctx.moveTo(x - w / 2 + k, top + h); ctx.lineTo(x - w / 2 + k + 0.18, top + h);
        ctx.lineTo(x - w / 2 + k + 0.18 + h, top); ctx.lineTo(x - w / 2 + k + h, top); ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      break;
    }
    case "gyro": {
      rect(ctx, x - w / 2, top, w, h);
      ctx.fillStyle = shadeX(ctx, x, w, "#56606f", "#2c333e"); ctx.fill(); outline(ctx, px);
      ctx.beginPath(); ctx.ellipse(x, top + h / 2, w * 0.28, h * 0.28, 0, 0, Math.PI * 2);
      ctx.strokeStyle = INK.glass; ctx.lineWidth = Math.max(px, 0.05); ctx.stroke();
      break;
    }
    case "fins": {
      const s = p.side, root = x - s * w / 2;
      ctx.beginPath();
      ctx.moveTo(root, top);
      ctx.lineTo(root + s * w, top + h * 0.55);
      ctx.lineTo(root + s * w, bot);
      ctx.lineTo(root, bot);
      ctx.closePath();
      ctx.fillStyle = INK.accent; ctx.fill(); outline(ctx, px);
      ctx.beginPath(); ctx.moveTo(root, top + h * 0.35); ctx.lineTo(root + s * w * 0.8, top + h * 0.7);
      ctx.strokeStyle = INK.accentDark; ctx.lineWidth = Math.max(px, 0.04); ctx.stroke();
      break;
    }
    case "legs": drawLeg(ctx, p, px, opts.legsOut); break;
    case "chute": {
      const r = Math.min(w, h) * 0.3;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x - w / 2, top, w, h, r) : ctx.rect(x - w / 2, top, w, h);
      ctx.fillStyle = shadeX(ctx, x, w, "#f3d66b", "#b89a34"); ctx.fill(); outline(ctx, px);
      ctx.fillStyle = INK.trim; ctx.fillRect(x - w / 2, top + h * 0.7, w, h * 0.12);
      break;
    }
    case "rcs": {
      rect(ctx, x - w / 2, top, w, h);
      ctx.fillStyle = shadeX(ctx, x, w, "#d9dde3", "#8a93a0"); ctx.fill(); outline(ctx, px);
      ctx.fillStyle = INK.metalDark;
      const s = p.side;
      ctx.fillRect(x + s * w / 2 - (s > 0 ? 0 : 0.12), top + h * 0.2, 0.12, h * 0.18);
      ctx.fillRect(x + s * w / 2 - (s > 0 ? 0 : 0.12), top + h * 0.62, 0.12, h * 0.18);
      break;
    }
    case "pod": {
      const bodyH = h * 0.5;
      rect(ctx, x - w / 2, top, w, bodyH);
      ctx.fillStyle = shadeX(ctx, x, w, INK.body, INK.bodyShade); ctx.fill(); outline(ctx, px);
      drawBell(ctx, x, top + bodyH, w * 0.55, w * 0.95, h - bodyH, INK.metal, INK.metalDark, px);
      break;
    }
    default:
      rect(ctx, x - w / 2, top, w, h);
      ctx.fillStyle = INK.bodyShade; ctx.fill();
  }
  if (opts.selected) {
    ctx.beginPath();
    ctx.rect(x - w / 2 - 0.12, top - 0.12, w + 0.24, h + 0.24);
    ctx.setLineDash([0.18, 0.14]);
    ctx.lineWidth = Math.max(px * 2, 0.06);
    ctx.strokeStyle = INK.accent;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (opts.warn) {
    ctx.fillStyle = "rgba(250,104,98,0.28)";
    ctx.fillRect(x - w / 2, top, w, h);
  }
  ctx.restore();
}

function drawBell(ctx, x, y0, wTop, wBot, h, light, dark, px) {
  ctx.beginPath();
  ctx.moveTo(x - wTop / 2, y0);
  ctx.quadraticCurveTo(x - wTop / 2, y0 + h * 0.6, x - wBot / 2, y0 + h);
  ctx.lineTo(x + wBot / 2, y0 + h);
  ctx.quadraticCurveTo(x + wTop / 2, y0 + h * 0.6, x + wTop / 2, y0);
  ctx.closePath();
  ctx.fillStyle = shadeX(ctx, x, wBot, light, dark);
  ctx.fill(); outline(ctx, px);
}

function drawEngine(ctx, x, top, w, h, d, px) {
  const mountH = h * 0.32;
  // thrust structure
  ctx.beginPath();
  ctx.moveTo(x - w * 0.5, top); ctx.lineTo(x + w * 0.5, top);
  ctx.lineTo(x + w * 0.24, top + mountH); ctx.lineTo(x - w * 0.24, top + mountH); ctx.closePath();
  ctx.fillStyle = INK.metalDark; ctx.fill();
  const vac = d.id === "heron";
  const light = vac ? INK.copper : d.id === "ox" ? "#8f99a8" : INK.metal;
  const dark = vac ? INK.copperDark : INK.metalDark;
  drawBell(ctx, x, top + mountH, w * (vac ? 0.28 : 0.4), w * (vac ? 1.0 : 0.92), h - mountH, light, dark, px);
  if (d.id === "ox") {
    ctx.fillStyle = INK.accent;
    ctx.fillRect(x - w * 0.24, top + mountH - 0.08, w * 0.48, 0.1);
  }
}

function drawLeg(ctx, p, px, out) {
  const s = p.side;
  const rootX = p.c - s * p.w / 2;
  const rootY = -p.s1 + 0.2;
  ctx.lineCap = "round";
  if (out) {
    const fx = p.footC, fy = -p.footS;
    ctx.beginPath(); ctx.moveTo(rootX, rootY); ctx.lineTo(fx, fy);
    ctx.lineWidth = 0.18; ctx.strokeStyle = INK.trim; ctx.stroke();
    // a strut back to the body for the look of it
    ctx.beginPath(); ctx.moveTo(rootX, rootY + p.h * 0.7); ctx.lineTo((rootX + fx) / 2, (rootY + fy) / 2);
    ctx.lineWidth = 0.09; ctx.strokeStyle = INK.metal; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(fx, fy - 0.05, 0.32, 0.09, 0, 0, Math.PI * 2);
    ctx.fillStyle = INK.metalDark; ctx.fill();
  } else {
    ctx.beginPath(); ctx.moveTo(rootX + s * 0.12, rootY); ctx.lineTo(rootX + s * 0.14, -p.s0);
    ctx.lineWidth = 0.18; ctx.strokeStyle = INK.trim; ctx.stroke();
  }
  ctx.lineCap = "butt";
}

function drawPayload(ctx, p, px) {
  const x = p.c, top = -p.s1, bot = -p.s0, w = p.w, h = p.h, id = p.id;
  if (id === "cargo" || id === "freight") {
    const r = w * 0.18;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, bot); ctx.lineTo(x - w / 2, top + r);
    ctx.quadraticCurveTo(x - w / 2, top, x - w / 2 + r, top);
    ctx.lineTo(x + w / 2 - r, top); ctx.quadraticCurveTo(x + w / 2, top, x + w / 2, top + r);
    ctx.lineTo(x + w / 2, bot); ctx.closePath();
    ctx.fillStyle = shadeX(ctx, x, w, id === "freight" ? "#d8c9a6" : INK.body, id === "freight" ? "#9d8d68" : INK.bodyShade);
    ctx.fill(); outline(ctx, px);
    ctx.fillStyle = id === "freight" ? INK.trim : INK.accent;
    const bands = id === "freight" ? 3 : 2;
    for (let k = 1; k <= bands; k++) { ctx.fillRect(x - w / 2, top + h * k / (bands + 1) - 0.07, w, 0.14); }
    if (id === "freight") {
      ctx.strokeStyle = INK.trim; ctx.lineWidth = 0.06;
      ctx.beginPath(); ctx.moveTo(x - w / 2, top + h * 0.25); ctx.lineTo(x + w / 2, bot - h * 0.25);
      ctx.moveTo(x + w / 2, top + h * 0.25); ctx.lineTo(x - w / 2, bot - h * 0.25); ctx.stroke();
    }
    return;
  }
  // capsules: probe and crew
  const shoulder = id === "crew" ? 0.55 : 0.4;
  ctx.beginPath();
  ctx.moveTo(x - w / 2, bot);
  ctx.lineTo(x - w * shoulder / 2 - w * 0.1, top + h * 0.12);
  ctx.quadraticCurveTo(x, top - h * 0.06, x + w * shoulder / 2 + w * 0.1, top + h * 0.12);
  ctx.lineTo(x + w / 2, bot);
  ctx.closePath();
  ctx.fillStyle = shadeX(ctx, x, w, INK.body, INK.bodyShade);
  ctx.fill(); outline(ctx, px);
  ctx.fillStyle = INK.trim;
  ctx.fillRect(x - w / 2, bot - 0.14, w, 0.14);
  if (id === "crew") {
    ctx.fillStyle = INK.glass;
    ctx.beginPath(); ctx.ellipse(x - w * 0.16, top + h * 0.48, w * 0.08, h * 0.1, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + w * 0.16, top + h * 0.48, w * 0.08, h * 0.1, 0, 0, Math.PI * 2); ctx.fill();
  } else {
    // a little dish on top
    ctx.strokeStyle = INK.trim; ctx.lineWidth = 0.05;
    ctx.beginPath(); ctx.moveTo(x, top + h * 0.05); ctx.lineTo(x + w * 0.18, top - h * 0.14); ctx.stroke();
    ctx.beginPath(); ctx.arc(x + w * 0.2, top - h * 0.16, w * 0.1, 0, Math.PI * 2);
    ctx.fillStyle = INK.accent; ctx.fill();
  }
}

/* Whole vessel: radials behind, stack in front, legs last so the feet read. */
export function drawVessel(ctx, parts, px, opts) {
  opts = opts || {};
  const order = [];
  for (const p of parts) { if (p.radial && p.kind !== "legs") { order.push(p); } }
  for (const p of parts) { if (!p.radial) { order.push(p); } }
  for (const p of parts) { if (p.kind === "legs") { order.push(p); } }
  for (const p of order) {
    const fill = p.kind === "tank" && p.propMax > 0 ? p.prop / p.propMax : null;
    drawPart(ctx, p, px, {
      legsOut: opts.legsOut, fill: opts.showFill ? fill : null,
      selected: opts.selected === p, warn: opts.warn && opts.warn.has(p)
    });
  }
}

/* A small standalone icon of a part definition (tray cards). */
export function drawIcon(ctx, def, size) {
  const px = 1;
  ctx.clearRect(0, 0, size, size);
  const w0 = def.w || 1.2, h0 = def.h || 1;
  const isRadial = def.mount === "radial";
  const span = isRadial ? w0 * 2 + 0.8 : Math.max(w0, 1.2);
  const k = Math.min((size * 0.8) / span, (size * 0.8) / Math.max(h0, 0.6));
  ctx.save();
  ctx.translate(size / 2, size / 2 + (h0 * k) / 2);
  ctx.scale(k, k);
  const mk = (c, side, w) => ({ id: def.id, def, kind: def.kind, radial: isRadial, side, c, w, h: h0, s0: 0, s1: h0,
    footC: side * (0.4 + (def.reach || 0)), footS: -(def.drop || 0) * 0.6 });
  if (isRadial) {
    // a ghost of the host body between the pair
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(-0.4, -h0, 0.8, h0);
    for (const side of [-1, 1]) { drawPart(ctx, mk(side * (0.4 + w0 / 2), side, w0), px / k, { legsOut: true }); }
  } else {
    drawPart(ctx, mk(0, 0, def.w || 1.2), px / k, {});
  }
  ctx.restore();
}
