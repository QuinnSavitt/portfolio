/* Overcrest — HUD. Minimal by design: the road is the interface. */

export function makeHud() {
  const el = {
    speedVal: document.getElementById("speedVal"),
    gearVal: document.getElementById("gearVal"),
    hudMsg: document.getElementById("hudMsg"),
    subtitle: document.getElementById("subtitle"),
    noteStrip: document.getElementById("noteStrip"),
    debug: document.getElementById("debugHud"),
    flowPips: document.querySelectorAll("#flowPips i"),
    boostBar: document.getElementById("boostBar"),
    boostFill: document.querySelector("#boostBar > i"),
    condBar: document.getElementById("condBar"),
    condFill: document.querySelector("#condBar > i"),
    meters: document.getElementById("meters"),
    sweepRow: document.getElementById("sweepRow"),
    sweepBar: document.getElementById("sweepBar"),
    sweepFill: document.querySelector("#sweepBar > i"),
    charms: document.getElementById("charmRail"),
  };
  let lastTier = -1, lastBoost = -1, lastCond = -1, lastGrace = null;
  let sweepShown = false, lastSweep = -1;
  let msgTimer = 0, toastTimer = 0;
  const toastEl = document.getElementById("toast");
  let lastSpeed = -1, lastGear = 0;
  let subTimer = 0;
  let chipCache = "";

  function update(car, dt) {
    const kmh = Math.round(Math.abs(car.vx) * 3.6);
    if (kmh !== lastSpeed) { el.speedVal.textContent = kmh; lastSpeed = kmh; }
    if (car.gear !== lastGear) { el.gearVal.textContent = "GEAR " + car.gear; lastGear = car.gear; }
    if (msgTimer > 0) {
      msgTimer -= dt;
      if (msgTimer <= 0) el.hudMsg.classList.remove("on");
    }
    if (subTimer > 0) {
      subTimer -= dt;
      if (subTimer <= 0) el.subtitle.classList.remove("on");
    }
    if (toastTimer > 0) {
      toastTimer -= dt;
      if (toastTimer <= 0) toastEl.classList.remove("on");
    }
  }

  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add("on");
    toastTimer = 2.2;
  }

  /* chip colour by grade: hairpin hot → flat cool. The "safe" ramp keeps
   * the same hot-to-cool story in Okabe–Ito orange→blue, because red→green
   * is exactly the axis colourblind eyes lose. */
  const RAMP = ["#e5573f", "#e5573f", "#e8823c", "#e6ad3f", "#d3c24a", "#a9c66a", "#86c47b", "#7cc4a5"];
  const RAMP_CB = ["#d55e00", "#d55e00", "#e69f00", "#e6c34a", "#c9c9a8", "#9db8d6", "#79a8dd", "#56b4e9"];
  let cbSafe = false;
  function setColour(mode) { cbSafe = mode === "safe"; chipCache = ""; }
  function chipColor(p) {
    if (!p || p.gnum == null) return "#b9ab8c";   // unnumbered calls wear plain stock
    const g = p.gnum;
    return (cbSafe ? RAMP_CB : RAMP)[Math.max(0, Math.min(7, g))];
  }

  /* upcoming notes → chip strip (skips DOM work when nothing changed).
   * A chip is a roadbook cell: paper stock, ink lettering, and the grade
   * colour worn as the cell's printed band (--g), not its whole body. */
  function notes(list) {
    const key = list.map((u) => u.phrase.label + "|" + Math.round(u.dist / 10)).join(",");
    if (key === chipCache) return;
    chipCache = key;
    let html = "";
    list.forEach((u, i) => {
      const band = chipColor(u.phrase);
      const far = i > 0 ? " far" : "";
      html += `<div class="call${far}" style="--g:${band}">${u.phrase.label}<small>${u.dist < 12 ? "NOW" : Math.round(u.dist) + " m"}</small></div>`;
    });
    el.noteStrip.innerHTML = html;
  }

  /* run meters: flow tier pips, boost bar, condition bar */
  function meters(R) {
    if (R.tier !== lastTier) {
      el.flowPips.forEach((p, i) => p.classList.toggle("on", i < R.tier));
      lastTier = R.tier;
    }
    /* grace, worn quietly: armed protection lifts the flow pips a shade.
     * No label, no icon — the zone's cover is felt, never explained. */
    if (!!R.graceArmed !== lastGrace) {
      el.meters.classList.toggle("grace", !!R.graceArmed);
      lastGrace = !!R.graceArmed;
    }
    const b = Math.round(R.boost);
    if (b !== lastBoost) { el.boostFill.style.width = b + "%"; lastBoost = b; }
    el.boostBar.classList.toggle("firing", !!R.boostOn);
    const c = Math.round(R.condition);
    if (c !== lastCond) {
      el.condFill.style.width = c + "%";
      el.condBar.classList.toggle("low", c < 35);
      lastCond = c;
    }
    /* the Sweep's thin margin bar — the addendum's whole HUD allowance.
     * Full at three minutes in hand; warms when the sweep is close. */
    if (R.sweepOn && el.sweepRow) {
      if (!sweepShown) { el.sweepRow.style.display = "flex"; sweepShown = true; }
      const w = Math.round(Math.max(0, Math.min(1, (R.sweepMarginS || 0) / 180)) * 100);
      if (w !== lastSweep) {
        el.sweepFill.style.width = w + "%";
        el.sweepBar.classList.toggle("low", (R.sweepMarginS || 0) < 30);
        lastSweep = w;
      }
    } else if (sweepShown) { el.sweepRow.style.display = "none"; sweepShown = false; }
  }
  function showMeters(on) { el.meters.style.display = on ? "flex" : "none"; }

  /* the charm rail (HUD tier "everything"): every souvenir worn on the
   * dash as a chip. Its name, its fire count, lit while it holds a charge
   * or stands ready, and a flash the moment it fires. Rebuilt only when
   * something changed; the flash is the new chip's own animation. */
  let charmKey = "", charmFires = {};
  function charms(list) {
    if (!el.charms) return;
    const key = list.map((c) => c.id + ":" + (c.fires || 0) + ":" + (c.lit ? 1 : 0)).join("|");
    if (key === charmKey) return;
    charmKey = key;
    const next = {};
    let html = "";
    for (const c of list) {
      const was = charmFires[c.id];
      const fired = was != null && (c.fires || 0) > was;
      next[c.id] = c.fires || 0;
      const title = (c.rule || "").replace(/"/g, "&quot;");
      html += `<span class="charm${c.lit ? " lit" : ""}${fired ? " fired" : ""}" title="${title}">${c.name}${c.fires ? `<i>${c.fires}</i>` : ""}</span>`;
    }
    charmFires = next;
    el.charms.innerHTML = html;
  }

  function message(text, seconds) {
    el.hudMsg.textContent = text;
    el.hudMsg.classList.add("on");
    msgTimer = seconds || 3;
  }

  function subtitle(text, seconds) {
    if (!text) { el.subtitle.classList.remove("on"); return; }
    el.subtitle.textContent = text;
    el.subtitle.classList.add("on");
    subTimer = seconds || 3.2;
  }

  function debug(text) {
    if (text == null) { el.debug.style.display = "none"; return; }
    el.debug.style.display = "block";
    el.debug.textContent = text;
  }

  return { update, message, subtitle, notes, meters, showMeters, charms, toast, debug, setColour };
}
