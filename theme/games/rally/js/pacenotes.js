/* Daily Rally — the co-driver.
 *
 * Turns the stage's generated note list into well-timed spoken calls and a
 * compact visual strip. Call timing is dynamic: faster approach or a heavier
 * braking requirement pulls the call earlier, so at 160 km/h you hear about
 * the hairpin while there is still road left to do something about it.
 */

import { G, DS } from "./track.js";

export function makeCoDriver(stage, speakFn) {
  const notes = stage.notes;
  let idx = 0;               // next note to be spoken
  let lastSpokenAt = -10;

  function reset() {
    idx = 0;
    lastSpokenAt = -10;
    for (const n of notes) { n.done = false; n.chained = false; }
  }

  function entrySpeed(note) {
    const i = Math.min(stage.geo.n - 1, Math.round((note.s + 8) / DS));
    return stage.profile.v[i];
  }

  function spokenFor(note) {
    let txt = "";
    if (note.caution) txt += "caution, ";
    txt += note.spoken;
    if (note.dist) txt += ", " + note.distSpoken;
    if (note.toFinish) txt += ", to finish";
    return txt;
  }

  function update(car) {
    if (idx >= notes.length) return;
    const v = Math.max(6, car.vx);
    const note = notes[idx];
    if (note.done || note.chained) { idx++; return; }

    const dist = note.s - car.s;
    if (dist < -10) { idx++; return; }   // long past it (crash chaos): skip

    // braking distance from current speed to the corner's entry speed
    const vn = entrySpeed(note);
    const brakeDist = Math.max(0, (v * v - vn * vn) / (2 * stage.grip.long * G * 0.75));
    const callAt = brakeDist + v * 1.7 + 12;

    if (dist <= callAt) {
      let text = spokenFor(note);
      note.done = true;
      // chain "into" notes in the same breath
      let j = idx + 1, chained = 0;
      let cur = note;
      while (cur.into && j < notes.length && chained < 2) {
        const nxt = notes[j];
        text += ", into " + spokenFor(nxt);
        nxt.chained = true;
        cur = nxt; j++; chained++;
      }
      speakFn(text, note.caution);
      lastSpokenAt = car.s;
      idx = j;
    }
  }

  /* the next few notes for the HUD strip (including chained ones) */
  function upcoming(car, count) {
    const out = [];
    for (let i = 0; i < notes.length && out.length < (count || 3); i++) {
      const n = notes[i];
      if (n.s - car.s < -14) continue;
      out.push({ note: n, dist: Math.max(0, n.s - car.s) });
    }
    return out;
  }

  return { reset, update, upcoming };
}

/* Severity chip colour: 1 = red danger through 6 = green flat. */
export function sevColor(sev) {
  if (sev === "hp") return "#e03434";
  if (sev === "sq") return "#e05c2c";
  switch (sev) {
    case 1: return "#e03434";
    case 2: return "#e0782c";
    case 3: return "#e0a82c";
    case 4: return "#c8c832";
    case 5: return "#94c83c";
    case 6: return "#5cc84c";
    default: return "#8b97ab";
  }
}

export function chipLabel(note) {
  if (note.kind === "crest") return "CREST";
  if (note.kind === "jump") return "JUMP";
  if (note.kind === "dip") return "DIP";
  const d = note.dir === 1 ? "L" : "R";
  if (note.sev === "hp") return d + "-HAIR";
  if (note.sev === "sq") return d + "-SQ";
  if (note.sev === 6) return "FLAT-" + d;
  return d + note.sev;
}
