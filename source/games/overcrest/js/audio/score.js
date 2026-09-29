/* Overcrest — the score. Composed material, as data.
 *
 * The earlier music was a phrase machine: random contours over oscillators.
 * Nobody could hum it, because nobody wrote it. This file is where the
 * writing lives: for every country a HOOK (four two-bar cells that follow
 * the chord), a progression with an A loop and a B turn, a bass riff, a
 * comping figure, a drum kit with four densities and fills, an arpeggio
 * shape and a swing. The arranger in music.js decides WHEN each of these
 * plays; nothing here decides anything. Pure data + pure helpers, so the
 * harness can read every note and assert the score is well-formed.
 *
 * Notation. Melody cells are strings of "deg:len" tokens; len is in
 * sixteenths and a cell is exactly two bars (32). deg is CHORD-RELATIVE:
 * 0 is the current chord's root in the melody register, 2 its third, 4 its
 * fifth, 6 its seventh, 7 the octave; 1/3/5 are passing tones; negatives
 * dip below. "r" is a rest. Because cells follow the chord, a hook keeps
 * its shape over every chord of the loop and over every scale — the
 * pentatonic and whole-tone countries included (degrees index THEIR scale,
 * so their octave is 5 and 6 respectively).
 *
 * Drum patterns are 32-character strings (two bars of sixteenths):
 * x accent, o normal, . ghost, - rest.
 */

/* ---------------------------------------------------------------- cells */

export function parseCell(str) {
  const out = [];
  let at = 0;
  for (const tok of str.trim().split(/\s+/)) {
    const [d, l] = tok.split(":");
    const len = parseInt(l, 10);
    if (d !== "r") out.push({ start: at, deg: parseInt(d, 10), len });
    at += len;
  }
  out.total = at;
  return out;
}

export function parsePattern(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "x") out.push({ step: i, vel: 1 });
    else if (c === "o") out.push({ step: i, vel: 0.72 });
    else if (c === ".") out.push({ step: i, vel: 0.4 });
  }
  return out;
}

/* ------------------------------------------------------------ bass riffs
 * [step, chord-relative degree, length] over two bars; the octave below
 * the chord root is the register. */
export const BASS_RIFFS = {
  eights: [[0, 0, 2], [2, 0, 2], [4, 0, 2], [6, 0, 2], [8, 0, 2], [10, 0, 2], [12, 0, 2], [14, 7, 2],
           [16, 0, 2], [18, 0, 2], [20, 0, 2], [22, 0, 2], [24, 0, 2], [26, 0, 2], [28, 4, 2], [30, 6, 2]],
  dotted: [[0, 0, 3], [3, 0, 3], [6, 0, 2], [8, 0, 3], [11, 0, 3], [14, 4, 2],
           [16, 0, 3], [19, 0, 3], [22, 0, 2], [24, 0, 3], [27, 7, 3], [30, 6, 2]],
  walk:   [[0, 0, 4], [4, 4, 4], [8, 7, 4], [12, 6, 4], [16, 0, 4], [20, 2, 4], [24, 4, 4], [28, -3, 4]],
  held:   [[0, 0, 16], [16, 0, 12], [28, 4, 4]],
  pulse:  [[0, 0, 2], [4, 0, 2], [6, 7, 1], [8, 0, 2], [12, 0, 2], [14, 4, 1],
           [16, 0, 2], [20, 0, 2], [22, 7, 1], [24, 0, 2], [28, 0, 2], [30, 6, 1]],
};

/* ---------------------------------------------------------------- comping
 * [step, voicing, length]; voicings are chord-relative degree sets. The
 * broken voicing "b" plays its tones one after another, two steps apart. */
export const VOICINGS = { t: [0, 2, 4], "7": [0, 2, 4, 6], s: [0, 4, 7], hi: [2, 4, 7], b: [0, 2, 4, 7] };
export const COMPS = {
  stab:    [[2, "t", 1], [6, "t", 1], [10, "7", 2], [14, "t", 1], [18, "t", 1], [22, "t", 1], [26, "7", 2], [30, "hi", 1]],
  roll8:   [[0, "b", 8], [8, "b", 8], [16, "b", 8], [24, "b", 8]],
  sustain: [[0, "7", 16], [16, "t", 16]],
  strum:   [[0, "t", 6], [6, "t", 2], [8, "t", 6], [14, "hi", 2], [16, "t", 6], [22, "t", 2], [24, "7", 8]],
  bell:    [[0, "s", 8], [12, "hi", 4], [16, "s", 8], [28, "hi", 4]],
  koto:    [[0, "b", 8], [10, "hi", 2], [16, "b", 8], [26, "s", 2]],
};

/* ------------------------------------------------------------- arpeggios
 * chord-relative degrees across two octaves, one per sixteenth */
export const ARPS = {
  up:     [0, 2, 4, 7, 9, 11, 14, 11, 9, 7, 4, 2],
  updown: [0, 2, 4, 7, 4, 2, 0, 2, 4, 7, 9, 7],
  pulse:  [0, 7, 4, 7, 2, 7, 4, 7],
  wide:   [0, 4, 7, 11, 14, 11, 7, 4],
};

/* ------------------------------------------------------------------ drums
 * Four densities per kit. A kit names its voices: std is kick / snare /
 * hat / ohat; soft the same, gentler; brush swaps in a brush snare and
 * swishes; taiko is tom / rim; none is ticks alone (the verge). The fill
 * replaces the last bar of a phrase (16 steps) at density >= 2. */
const std = {
  1: { kick: "x---------------o---------------", hat: "--o---o---o---o---o---o---o---o-" },
  2: { kick: "x-----o---x-----x-----o-----o---", snare: "----x-------x-------x-------x---",
       hat: "o-o-o-o-o-o-o-o-o-o-o-o-o-o-o-o-", ohat: "--------------o---------------o-" },
  3: { kick: "x---x---x---x---x---x---x-o-x---", snare: "----x-------x--.----x-------x-.-",
       hat: "x.o.x.o.x.o.x.o.x.o.x.o.x.o.x.o.", ohat: "------o---------------o-------o-" },
  4: { kick: "x---x--ox---x---x---x--ox---x-o-", snare: "----x-------x--o----x-------x-oo",
       hat: "x.o.x.o.x.o.x.o.x.o.x.o.x.o.x.o.", ohat: "--o-------o-------o-------o-----" },
  fill: { 2: "--------o-o-o-x-", 3: "------o-o-oxoxox", 4: "o-o-o-oxoxoxxxxx" },
};
const soft = {
  1: { kick: "x---------------o---------------", hat: "----o-------o-------o-------o---" },
  2: { kick: "x-------o-------x-------o-------", snare: "----o-------o-------o-------o---",
       hat: "o-o-o-o-o-o-o-o-o-o-o-o-o-o-o-o-", ohat: "------------o---------------o---" },
  3: { kick: "x-----o-x-------x-----o-x-------", snare: "----o-------o--.----o-------o-.-",
       hat: "o.o.o.o.o.o.o.o.o.o.o.o.o.o.o.o.", ohat: "------o---------------o---------" },
  4: { kick: "x---o-o-x---o---x---o-o-x---o-o-", snare: "----x-------x--o----x-------x-oo",
       hat: "x.o.x.o.x.o.x.o.x.o.x.o.x.o.x.o.", ohat: "--o-------o-------o-------o-----" },
  fill: { 2: "--------o---o-o-", 3: "------o-o-o-oxox", 4: "o-o-o-oxoxoxxxxx" },
};
const brush = {
  1: { hat: "o-------o-------o-------o-------" },
  2: { kick: "x-------x-------x-------x-------", snare: "----o-------o-------o-------o---", hat: "o-------o-------o-------o-------" },
  3: { kick: "x-----o-x-------x-----o-x-------", snare: "----o-------o--.----o-------o-.-", hat: "o---o---o---o---o---o---o---o---" },
  4: { kick: "x-----o-x-----o-x-----o-x-----o-", snare: "----o-------o--.----o-------o-oo", hat: "o-o-o-o-o-o-o-o-o-o-o-o-o-o-o-o-" },
  fill: { 2: "------------o-o-", 3: "--------o-o-o-o-", 4: "----o-o-o-o-oooo" },
};
const taiko = {
  1: { tom: "x-------------------------------" },
  2: { tom: "x-------x---o---x-------x---o---", rim: "----o-------o-------o-------o---" },
  3: { tom: "x---o---x-o-o---x---o---x-o-o-o-", rim: "--o---o---o---o---o---o---o---o-" },
  4: { tom: "x-o-o-x-o-x-o-o-x-o-o-x-o-x-oxox", rim: "o-o-o-o-o-o-o-o-o-o-o-o-o-o-o-o-" },
  fill: { 2: "--------x---x-x-", 3: "----x---x-x-xxxx", 4: "x-x-x-xxxxxxxxxx" },
};
const none = {
  1: { tick: "o-------------------------------" },
  2: { tick: "o-------o-------o-------o-------" },
  3: { tick: "o-------o---o---o-------o---o---" },
  4: { tick: "o---o---o---o---o---o---o---o---" },
  fill: { 2: "------------o---", 3: "--------o---o---", 4: "----o---o---o-o-" },
};
export const KITS = { std, soft, brush, taiko, none };

/* ----------------------------------------------------------------- themes
 * The writing. prog/progB are scale degrees (0 = tonic); cells follow the
 * chord. The comment on each is the brief it was written to. */
export const THEMES = {
  norrland: {   // boreal, glassy; a folk lilt — long-short-short, rising to the octave
    prog: [0, 3, 0, 6], progB: [2, 3, 0, 6],
    cells: ["4:6 2:2 0:4 r:4 2:6 4:2 7:4 r:4",
            "7:6 6:2 4:4 r:4 2:6 1:2 0:8",
            "4:6 2:2 0:4 r:4 4:6 6:2 7:4 r:4",
            "9:4 7:4 6:4 4:4 2:4 4:4 0:8"],
    bass: "dotted", comp: "roll8", kit: "soft", arp: "updown", swing: 0.06,
  },
  costa: {      // bright, quick; 3-3-2 syncopation, the lydian II under it
    prog: [0, 1, 5, 4], progB: [2, 1, 0, 4],
    cells: ["0:3 2:3 4:2 7:3 4:3 2:2 4:6 r:10",
            "7:3 9:3 7:2 4:3 2:3 4:2 2:6 0:10",
            "0:3 2:3 4:2 7:3 4:3 2:2 4:6 r:10",
            "9:3 7:3 4:2 7:3 6:3 4:2 2:4 0:12"],
    bass: "pulse", comp: "stab", kit: "std", arp: "up", swing: 0,
  },
  redgate: {    // desert; driving eighths with a blue dip under the root, shuffled
    prog: [0, 6, 3, 0], progB: [4, 6, 0, 3],
    cells: ["0:4 0:2 2:2 4:4 6:4 4:4 r:12",
            "7:4 6:2 4:2 2:4 0:4 -1:4 0:12",
            "0:4 0:2 2:2 4:4 6:4 7:4 r:12",
            "9:4 7:2 6:2 4:4 2:4 0:4 -3:4 0:8"],
    bass: "eights", comp: "strum", kit: "std", arp: "wide", swing: 0.12,
  },
  thornmoor: {  // the moor; long notes, a falling sigh, brushes
    prog: [0, 5, 2, 6], progB: [3, 0, 5, 6],
    cells: ["4:8 2:4 0:12 r:8",
            "2:8 4:4 6:8 4:12",
            "7:8 6:4 4:12 r:8",
            "4:6 2:2 0:8 -1:8 0:8"],
    bass: "held", comp: "sustain", kit: "brush", arp: "updown", swing: 0,
  },
  heartland: {  // warm farmland; a pastoral lilt, the leading tone pulling home
    prog: [0, 5, 3, 4], progB: [3, 0, 1, 4],
    cells: ["0:2 2:2 4:4 4:2 2:2 0:4 2:8 r:8",
            "4:2 6:2 7:4 6:2 4:2 2:4 4:8 r:8",
            "0:2 2:2 4:4 4:2 2:2 0:4 -1:8 r:8",
            "7:2 6:2 4:4 2:2 1:2 0:4 0:16"],
    bass: "walk", comp: "roll8", kit: "soft", arp: "up", swing: 0.08,
  },
  aspenvale: {  // thin clear air; high, sparse, ringing
    prog: [0, 1, 2, 1], progB: [5, 1, 0, 4],
    cells: ["7:4 r:4 9:4 r:4 7:2 4:2 r:12",
            "11:4 r:4 9:4 r:4 7:2 6:2 4:12",
            "7:4 r:4 9:4 r:4 7:2 4:2 r:12",
            "9:4 7:4 6:4 4:4 2:4 4:4 7:8"],
    bass: "held", comp: "bell", kit: "soft", arp: "wide", swing: 0,
  },
  kaldbrekka: { // ice and patience; a repeated note like ice ticking, then the leap
    prog: [0, 6, 2, 3], progB: [4, 3, 0, 0],
    cells: ["0:2 0:2 r:4 0:2 0:2 r:4 7:8 4:8",
            "6:2 6:2 r:4 6:2 6:2 r:4 4:8 2:8",
            "0:2 0:2 r:4 0:2 0:2 r:4 7:8 9:8",
            "7:4 6:4 4:4 2:4 0:16"],
    bass: "held", comp: "bell", kit: "soft", arp: "pulse", swing: 0,
  },
  sandreach: {  // canyon light; a rolling 3-3-2, nylon strings
    prog: [0, 4, 1, 0], progB: [5, 4, 1, 0],
    cells: ["0:3 4:3 7:2 r:8 4:3 2:3 0:2 r:8",
            "2:3 4:3 6:2 r:8 7:3 6:3 4:2 r:8",
            "0:3 4:3 7:2 r:8 9:3 7:3 4:2 r:8",
            "6:3 4:3 2:2 4:8 2:3 1:3 0:2 0:8"],
    bass: "dotted", comp: "strum", kit: "std", arp: "updown", swing: 0.1,
  },
  highline: {   // big and clear; quarter notes climbing, the anthem loop
    prog: [0, 4, 5, 3], progB: [1, 3, 0, 4],
    cells: ["0:4 2:4 4:4 7:4 r:4 6:4 4:8",
            "2:4 4:4 6:4 9:4 r:4 7:4 6:8",
            "0:4 2:4 4:4 7:4 r:4 9:4 7:8",
            "11:4 9:4 7:4 6:4 4:4 2:4 0:8"],
    bass: "eights", comp: "sustain", kit: "std", arp: "up", swing: 0,
  },
  cauldron: {   // heat shimmer; a hypnotic figure leaning on the raised fourth
    prog: [0, 3, 0, 6], progB: [2, 3, 0, 6],
    cells: ["0:2 r:2 0:2 3:2 4:4 3:2 0:2 r:16",
            "0:2 r:2 0:2 3:2 4:4 6:2 7:2 4:16",
            "0:2 r:2 0:2 3:2 4:4 3:2 0:2 r:16",
            "7:2 r:2 6:2 4:2 3:4 2:2 0:2 0:16"],
    bass: "pulse", comp: "stab", kit: "std", arp: "pulse", swing: 0.05,
  },
  kurotani: {   // the shrine; koto and taiko, silence between the notes (5-note scale: 5 is the octave)
    prog: [0, 3, 0, 2], progB: [2, 3, 0, 0],
    cells: ["0:4 r:4 2:2 3:2 r:4 5:8 r:8",
            "4:4 r:4 3:2 2:2 r:4 0:8 r:8",
            "5:4 r:4 7:2 6:2 r:4 5:8 r:8",
            "3:4 2:4 r:4 1:2 0:2 r:4 0:12"],
    bass: "held", comp: "koto", kit: "taiko", arp: "pulse", swing: 0,
  },
  ventisca: {   // the wind; long, restless, and it never lands
    prog: [0, 2, 3, 0], progB: [6, 3, 0, 2],
    cells: ["0:8 2:4 3:4 r:4 2:8 r:4",
            "4:8 3:4 2:4 r:4 0:4 -1:8",
            "0:8 2:4 3:4 r:4 4:8 r:4",
            "6:8 4:4 2:4 3:8 2:8"],
    bass: "held", comp: "sustain", kit: "brush", arp: "updown", swing: 0,
  },
  verge: {      // unmoored; fives and threes, bells, no drums (6-note scale: 6 is the octave)
    prog: [0, 2, 4, 1], progB: [3, 5, 0, 2],
    cells: ["0:5 2:3 4:5 r:3 6:5 4:3 r:8",
            "4:5 2:3 0:5 r:3 -2:5 0:3 r:8",
            "6:5 4:3 2:5 r:3 0:5 2:3 r:8",
            "8:5 6:3 4:5 r:3 2:5 0:3 r:8"],
    bass: "held", comp: "bell", kit: "none", arp: "wide", swing: 0,
  },
};

export function themeFor(country) {
  return THEMES[country] || THEMES.norrland;
}

/* Everything parsed once, so the scheduler indexes instead of parsing. */
const CACHE = new Map();
export function compiled(country) {
  const key = THEMES[country] ? country : "norrland";
  let c = CACHE.get(key);
  if (c) return c;
  const t = THEMES[key];
  const kit = KITS[t.kit] || KITS.std;
  const drums = {};
  for (const lvl of [1, 2, 3, 4]) {
    drums[lvl] = {};
    for (const v in kit[lvl]) drums[lvl][v] = parsePattern(kit[lvl][v]);
  }
  const fills = {};
  for (const lvl in kit.fill) fills[lvl] = parsePattern(kit.fill[lvl]);
  c = {
    key, prog: t.prog, progB: t.progB,
    cells: t.cells.map(parseCell),
    bass: BASS_RIFFS[t.bass] || BASS_RIFFS.held,
    comp: COMPS[t.comp] || COMPS.sustain,
    arp: ARPS[t.arp] || ARPS.up,
    kit: t.kit, drums, fills, swing: t.swing || 0,
  };
  CACHE.set(key, c);
  return c;
}
