/* Overcrest — the codriver.
 *
 * Turns the world's live note stream (gear-grade corners, crests, jumps,
 * dips, later: surface changes and waystations) into well-timed calls.
 * A call is made when the car is one braking distance plus a reaction
 * margin from the note; linked notes are chained in one breath ("three
 * right, into two left"), long gaps get a distance ("... one hundred").
 *
 * Personality is rationed: a remark needs an occasion and a long cooldown,
 * so when the codriver does say "nice" it lands.
 *
 * DOM-free: emits through callbacks so the harness can count calls.
 */

import { G } from "../sim/physics.js";
import { surfaceParams } from "../sim/surfaces.js";
import { gradeTarget } from "../world/roadgen.js";

const NUM = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six" };
const DIST_STEPS = [40, 60, 80, 100, 130, 160, 200, 250, 300];
const DIST_WORDS = { 40: "forty", 60: "sixty", 80: "eighty", 100: "one hundred", 130: "one thirty", 160: "one sixty", 200: "two hundred", 250: "two fifty", 300: "three hundred" };

export const TIMING = { early: 2.4, normal: 1.7, late: 1.15 };   // reaction seconds

export function gradeWord(g) {
  if (g === "hp") return "hairpin";
  if (g === "flat") return "flat";
  return NUM[g] || String(g);
}

/* Spoken + label forms of one note. */
export function phrase(note) {
  if (note.kind !== "corner") {
    if (note.kind === "jump") return { spoken: "jump", label: "JUMP", caution: false };
    if (note.kind === "crest") return { spoken: "over crest", label: "CREST", caution: false };
    if (note.kind === "dip") return { spoken: "dip", label: "DIP", caution: false };
    if (note.kind === "surface") return { spoken: "onto " + note.name, label: note.name.toUpperCase(), caution: false };
    /* Crossings read as places, not hazards — the caution belongs to
     * whatever the exit hides, which chains on behind this note. */
    if (note.kind === "ford") return { spoken: "water across", chain: "water across", label: "WATER", caution: true };
    if (note.kind === "bridge") {
      /* An iced deck is the one crossing that IS a hazard — the caution
       * prefix earns its keep exactly here. */
      if (note.iced) return { spoken: "ice on the bridge", chain: "ice on the bridge", label: "ICE BRIDGE", caution: true };
      /* An overpass: the road below is the one you were just on, or are
       * about to be — worth one different word from the usual bridge. */
      if (note.over) return { spoken: "over the crossing, road below", chain: "over the crossing", label: "OVERPASS", caution: false };
      return { spoken: "over the bridge", chain: "over the bridge", label: "BRIDGE", caution: false };
    }
    if (note.kind === "tunnel") return { spoken: "into the tunnel", chain: "into the tunnel", label: "TUNNEL", caution: false };
    if (note.kind === "waystation") {
      /* the strange outpost's entire advertisement is four words here and
       * a teal lamp there — never a banner, never a UI */
      if (note.strange) return { spoken: "waystation, " + note.distSpoken + ". odd one, this", label: "WAYSTATION", caution: false };
      return { spoken: "waystation, " + note.distSpoken, label: "WAYSTATION", caution: false };
    }
    /* A special event announces itself in its own words — it is the one
     * note that is about a PLACE rather than about a piece of road, so it
     * never chains and it never gets a distance tacked on. */
    if (note.kind === "event") return { spoken: note.call, chain: note.call, label: note.banner || "EVENT", caution: false };
    return { spoken: String(note.kind), label: String(note.kind).toUpperCase(), caution: false };
  }
  const dirW = note.dir === 1 ? "right" : "left";
  const dirC = note.dir === 1 ? "R" : "L";
  let spoken, label;
  if (note.grade === "hp") { spoken = "hairpin " + dirW; label = "HP " + dirC; }
  else if (note.grade === "flat") { spoken = "flat " + dirW; label = "FLAT " + dirC; }
  else { spoken = gradeWord(note.grade) + " " + dirW; label = dirC + note.grade; }
  const m = note.mods || {};
  const extra = [], extraL = [];
  if (m.long) { extra.push("long"); extraL.push("long"); }
  if (m.tightens) { extra.push("tightens " + gradeWord(m.tightens)); extraL.push("→" + m.tightens); }
  if (m.opens) { extra.push("opens " + gradeWord(m.opens)); extraL.push("opens"); }
  if (m.offcamber) { extra.push("off camber"); extraL.push("off cam"); }
  if (m.dontcut) { extra.push("don't cut"); extraL.push("don't cut"); }
  let pre = "", preL = "";
  if (note.feat === "crest") { pre = "over crest, "; preL = "CREST "; }
  if (note.feat === "jump") { pre = "jump into "; preL = "JUMP "; }
  const gnum = note.grade === "hp" ? 0 : note.grade === "flat" ? 7 : note.grade;
  const core = spoken + (extra.length ? ", " + extra.join(", ") : "");
  return {
    spoken: pre + core,
    core, pre,
    label: preL + label + (extraL.length ? " " + extraL.join(" ") : ""),
    caution: (note.feat === "jump" && gnum <= 3) || (m.offcamber && gnum <= 2),
    gnum,
  };
}

export function makeCodriver(world, opts) {
  opts = opts || {};
  const state = {
    timing: opts.timing || "normal",
    /* verbosity (Phase 21, the bible's "potentially offer verbosity"):
     * full = everything; essential = corners, hazards, waystations and the
     * one line a landmark gets; minimal = hazards and waystations only —
     * for the player who drives by sight and wants the quiet. Remarks obey
     * it too (minimal is near-silence); grace's line does NOT — that voice
     * is the mechanic's display, not chatter. */
    verbosity: opts.verbosity || "full",
    lastCallS: -1e9,
    lastRemarkT: -1e9,
    calls: 0,
    time: 0,
    // occasion trackers
    bigSlide: false, slideStartT: 0,
    cleanSince: 0, remarkedClean: false,
    nightHeld: 0, saidSun: false,
    hitAt: -1e9, hitOpen: false, quietLeg: -1,
    // the zone (Addendum I): when flow was last high, when grace last spoke,
    // and whether a collapse is waiting for its steadying word
    zoneT: -1e9, collapseAt: -1e9, collapseOpen: false, graceAt: -1e9,
  };
  const speak = opts.speak || (() => {});
  const onCall = opts.onCall || (() => {});
  const remark = opts.remark || speak;

  function entrySpeed(note) {
    return world.profileAt(note.s + 8);
  }

  /* does this note get a voice at the current verbosity? Cautions always
   * speak — a hazard unspoken is a wall unseen, whatever the setting. */
  function audible(n) {
    if (state.verbosity === "full") return true;
    if (n.kind === "waystation") return true;
    if (phrase(n).caution) return true;
    if (state.verbosity === "essential") return n.kind === "corner" || n.kind === "event";
    return false;   // minimal: hazards and waystations only
  }

  function spokenWithDist(note, nextNote, chained) {
    const p = phrase(note);
    // chained: "over crest into five right" rather than "into over crest, five right"
    // — and a note that already carries its own preposition ("into the
    // tunnel") supplies its own chained form, or we get "into into"
    let body = p.spoken;
    if (chained && p.chain) body = p.chain;
    else if (chained && p.pre) body = p.pre.replace(/[,\s]+$/, "") + " into " + p.core;
    let txt = (p.caution ? "caution, " : "") + body;
    if (nextNote && !note.noChain) {
      const gap = nextNote.s - note.endS;
      if (gap > 110) {
        let best = DIST_STEPS[0];
        for (const d of DIST_STEPS) if (Math.abs(d - gap) < Math.abs(best - gap)) best = d;
        txt += ", " + DIST_WORDS[best];
      }
    }
    return { txt, p };
  }

  /* one sim-tick-rate update; car in world coords */
  function update(car, dt) {
    state.time += dt;
    const notes = world.notes;
    const v = Math.max(6, car.vx);
    const surf = surfaceParams(car.surface, world.wetness || 0);

    // find the first unspoken note ahead
    let idx = -1;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.spoken) continue;
      if (n.s - car.s < -14) { n.spoken = true; continue; }   // long past (chaos): drop
      if (!audible(n)) { n.spoken = true; continue; }         // verbosity: consumed silently
      idx = i; break;
    }
    if (idx < 0) return;
    const note = notes[idx];
    const dist = note.s - car.s;
    const vn = entrySpeed(note);
    const decel = surf.grip * G * 0.6;
    const brakeDist = Math.max(0, (v * v - vn * vn) / (2 * decel));
    const callAt = brakeDist + v * TIMING[state.timing] + 14;
    if (dist > callAt) return;

    // chain "into" notes spoken in the same breath (short gaps), max 2
    let j = idx;
    let text = "";
    let chained = 0;
    let firstP = null;
    while (j < notes.length && chained < 3) {
      const cur = notes[j];
      if (chained > 0 && !audible(cur)) break;   // a silent note breaks the breath
      const nxt = notes[j + 1];
      const gapNext = nxt ? nxt.s - cur.endS : 1e9;
      const { txt, p } = spokenWithDist(cur, nxt, chained > 0);
      if (!firstP) firstP = p;
      text += chained ? (p.pre || p.chain ? ", " + txt : ", into " + txt) : txt;
      cur.spoken = true;
      chained++;
      j++;
      if (gapNext > 34 || cur.noChain || (nxt && nxt.noChain)) break;
    }
    speak(text, firstP.caution);
    onCall({ text, s: note.s, note });
    state.lastCallS = car.s;
    state.calls++;
  }

  /* rare occasions — every one is gated by a long cooldown. Personality is
   * mostly restraint: at night the cooldown stretches (companionship in the
   * dark is NOT talking), and while the sky is doing something rare the
   * codriver watches it with you — the right silences. */
  function occasion(car, ev, dt, ctx) {
    // minimal verbosity is near-silence: the remarks go first
    if (state.verbosity === "minimal") return;
    const now = state.time;
    ctx = ctx || {};
    const tier = ctx.tier || 0;
    /* In sustained flow the codriver warms and SHORTENS (Addendum I): trust
     * is fewer words, so the remark cooldown stretches in the zone the way
     * it already does in the dark. The calls themselves stay untouched —
     * a pace note is a promise, not chatter. */
    const coolLen = 75 * ((ctx.night || 0) > 0.5 ? 1.6 : 1) * (tier >= 4 ? 1.35 : 1);
    const cool = now - state.lastRemarkT > coolLen && !ctx.skyBusy;
    /* The zone collapsing is a moment the codriver feels: note it here
     * (before any early return below can skip it), speak once the car is
     * gathered up again. Grace has its own voice (`moment`), so a collapse
     * within a breath of it stays silent — and "no harm done" would be a
     * lie after a dent that STUCK, so a collapse claims the hit line. */
    if (tier >= 3) state.zoneT = now;
    if (tier <= 1 && now - state.zoneT < 8 && state.zoneT > 0
        && !state.collapseOpen && now - state.graceAt > 6) {
      state.collapseOpen = true; state.collapseAt = now; state.zoneT = -1e9;
      state.hitOpen = false;
    }
    if (state.collapseOpen && now - state.collapseAt > 3 && car.zone === "road" && car.vx > 12) {
      state.collapseOpen = false;
      if (cool) { remark("steady. it builds back"); state.lastRemarkT = now; return; }
    }
    // save: a big slide gathered back without leaving the road
    if (Math.abs(car.beta) > 0.55 && !state.bigSlide) { state.bigSlide = true; state.slideStartT = now; }
    if (state.bigSlide && Math.abs(car.beta) < 0.08 && car.zone === "road" && car.vx > 12) {
      state.bigSlide = false;
      if (cool && now - state.slideStartT > 0.9) { remark("good save"); state.lastRemarkT = now; return; }
    }
    if (car.zone !== "road" && state.bigSlide) state.bigSlide = false;
    // big clean landing
    if (ev && ev.landed && ev.air > 0.9 && ev.landed < 5 && Math.abs(car.beta) < 0.15) {
      if (cool) { remark("nice"); state.lastRemarkT = now; return; }
    }
    /* dawn after a real night, once per journey — the sunrise the clock
     * aimed for gets its four words */
    if ((ctx.night || 0) > 0.8) state.nightHeld += dt;
    if (!state.saidSun && state.nightHeld > 150 && (ctx.golden || 0) > 0.45) {
      state.saidSun = true;
      if (!ctx.skyBusy) { remark("there's the sun"); state.lastRemarkT = now; return; }
    }
    // a hard hit, shaken off: warmth arrives once the car is driving again
    if (ev && ev.impact > 10) { state.hitAt = now; state.hitOpen = true; }
    if (state.hitOpen && now - state.hitAt > 4 && car.zone === "road" && car.vx > 15) {
      state.hitOpen = false;
      if (cool) { remark("no harm done. on you go"); state.lastRemarkT = now; return; }
    }
    /* a long easy stretch ahead — the bible's own example line, said at
     * most once per leg, and only when the road really is empty of calls */
    if (cool && car.vx > 22 && world.legEndS !== state.quietLeg) {
      let nextAt = 1e9;
      for (const n of world.notes) { if (!n.spoken && n.s - car.s > 0) { nextAt = n.s - car.s; break; } }
      if (nextAt > 430) {
        state.quietLeg = world.legEndS;
        remark("easy stretch ahead"); state.lastRemarkT = now; return;
      }
    }
    // a long clean stretch: no damage, no off-road, high pace
    if (car.zone === "road" && (!ev || !ev.impact) && car.vx > 20) state.cleanSince += dt;
    else state.cleanSince = 0;
    if (state.cleanSince > 95 && cool) {
      remark("car feels good"); state.lastRemarkT = now; state.cleanSince = 0;
    }
  }

  /* next few notes for the HUD strip */
  /* The chips ahead of the car. A note is timed by `s` (where the call is
   * made) but a chip counts down to `atS` — the thing itself — so the
   * distance on screen is the distance you actually drive. Two notes about
   * the same landmark share one chip; a waystation announced twice should
   * not take two slots and read as two waystations. */
  function upcoming(car, count) {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < world.notes.length && out.length < (count || 3); i++) {
      const n = world.notes[i];
      if (n.s - car.s < -10) continue;
      if (!audible(n)) continue;              // the chip strip follows the voice
      const at = n.atS != null ? n.atS : n.s;
      const key = n.kind + ":" + Math.round(at);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ note: n, dist: Math.max(0, at - car.s), phrase: phrase(n) });
    }
    return out;
  }

  function setTiming(t) { if (TIMING[t]) state.timing = t; }
  function setVerbosity(v) { if (v === "full" || v === "essential" || v === "minimal") state.verbosity = v; }

  /* Mechanic-driven lines — the run telling the codriver what just
   * happened. Grace is the one voice that outruns the cooldown: "no harm
   * done" IS the mechanic's display (Addendum I), not a remark that can
   * wait its turn. It claims the shaken-off-hit line (same words, now
   * literally true) and stands the collapse line down. */
  function moment(kind) {
    const say = (text) => {
      state.hitOpen = false;
      state.collapseOpen = false;
      state.lastRemarkT = state.time;
      remark(text);
    };
    if (kind === "grace") { state.graceAt = state.time; say("no harm done. on you go"); }
    /* the three ends: the car goes over, the wait, the way back, the end */
    else if (kind === "rolled") say("we're over. hold on");
    else if (kind === "roof") say("on the roof. spectators are coming");
    else if (kind === "tow") say("we're stuck. tractor's on its way");
    else if (kind === "noHelp") say("nobody's coming");
    else if (kind === "rescued") say("right. back at it");
    else if (kind === "saveEarned") say("the marshals owe us one now");
    /* the crew: shots are required, so they get called like corners */
    else if (kind === "camTrackside") say("cameras on the verge ahead. hold your line");
    else if (kind === "camBrow") say("camera crew at the landing. make it clean");
    else if (kind === "camReveal") say("cameras up high. eyes forward");
    else if (kind === "camCrane") say("crane on the drop side. give them the view");
    else if (kind === "camFlyover") say("crew lying past the jump. send it over them");
  }

  return { update, occasion, upcoming, setTiming, setVerbosity, audible, moment, state };
}
