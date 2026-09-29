/* Overcrest — adaptive music. Entirely synthesized, like everything else.
 *
 * The bible's ask: generative layers gated on the state of the run —
 * ambient cruising, flowing, high speed, technical, storm, night,
 * waystation — that fade in and out, and a system WILLING TO GO ALMOST
 * SILENT and let the engine, the road and the codriver be the soundtrack.
 * Low flow is a pad you barely notice; the music you get, you earned.
 *
 * Three halves, deliberately separable:
 *   musicPlan(state) — the DECISION: pure, DOM-free, harness-tested.
 *     What plays, how loud, in what key, at what tempo, with which
 *     instruments, in which mode, at what intensity, in which SECTION.
 *   score.js — the WRITING: every country's hook, progression, riff,
 *     comping figure, kit and swing, as data. Nobody could hum the old
 *     phrase machine because nobody wrote it. Now somebody did.
 *   makeMusic(ctx, master, seed) — the ARRANGER: a sixteenth-note
 *     scheduler over an eight-bar loop that plays the score through the
 *     rack in synth.js, in song FORM — hush → roll → groove → theme →
 *     lift, earned one step at a time, with builds into the upgrades,
 *     a break every few loops so it never blasts, modulation at chord
 *     boundaries when the country changes, and the run's events landing
 *     on the grid as stingers: a clean landing hits, a long slide echoes,
 *     grace makes the music fall away, a collision stumbles the drums,
 *     the waystation gets a cadence. Humanization and the odd choice come
 *     from a seeded rng, so a journey keeps its music.
 */

import { rng, hashCombine } from "../core/rng.js";
import { makeRack } from "./synth.js";
import { compiled, VOICINGS } from "./score.js";

export const LAYERS = ["drone", "pad", "bass", "kick", "pulse", "ticks", "arp", "lead", "shimmer"];

/* Each country hears in its own mode; storms and deep night darken it.
 * Offsets are semitones over the root; roots sit low on purpose — the
 * music lives under the engine, never on top of it. */
export const SCALES = {
  norrland: { root: 146.83, bright: [0, 2, 3, 5, 7, 9, 10], dark: [0, 2, 3, 5, 7, 8, 10] },   // D dorian / aeolian
  costa: { root: 164.81, bright: [0, 2, 4, 6, 7, 9, 11], dark: [0, 1, 4, 5, 7, 8, 10] },      // E lydian / phrygian dom.
  redgate: { root: 110.0, bright: [0, 2, 4, 5, 7, 9, 10], dark: [0, 2, 3, 5, 7, 8, 10] },     // A mixolydian / aeolian
  thornmoor: { root: 130.81, bright: [0, 2, 3, 5, 7, 8, 10], dark: [0, 1, 3, 5, 7, 8, 10] },  // C aeolian / phrygian — lonely
  heartland: { root: 174.61, bright: [0, 2, 4, 5, 7, 9, 11], dark: [0, 2, 3, 5, 7, 9, 10] },  // F major / dorian — warm
  aspenvale: { root: 98.0, bright: [0, 2, 4, 6, 7, 9, 11], dark: [0, 2, 3, 5, 7, 8, 10] },    // G lydian / aeolian — thin clear air
  kaldbrekka: { root: 123.47, bright: [0, 2, 3, 5, 7, 9, 10], dark: [0, 1, 3, 5, 7, 8, 10] }, // B dorian / phrygian — ice and patience
  // the park countries (2026-08-31): four free pitch classes, and Ventisca
  // an octave under Heartland's F — the same note, hollowed out by wind
  sandreach: { root: 185.0, bright: [0, 2, 4, 6, 7, 9, 11], dark: [0, 2, 4, 5, 7, 8, 10] },    // F# lydian / mixolydian b6 — canyon light
  highline: { root: 116.54, bright: [0, 2, 4, 5, 7, 9, 11], dark: [0, 2, 3, 5, 7, 8, 10] },    // Bb ionian / aeolian — big and clear
  cauldron: { root: 138.59, bright: [0, 2, 3, 6, 7, 9, 10], dark: [0, 1, 4, 5, 7, 8, 10] },    // C# dorian #4 / phrygian dominant — heat shimmer
  kurotani: { root: 103.83, bright: [0, 2, 3, 7, 8], dark: [0, 1, 5, 7, 8] },                 // G# hirajoshi / in — the shrine scales
  ventisca: { root: 87.31, bright: [0, 2, 3, 5, 7, 9, 10], dark: [0, 1, 3, 5, 6, 8, 10] },     // low F dorian / locrian — the wind, unresolved
  verge: { root: 155.56, bright: [0, 2, 4, 6, 8, 10], dark: [0, 1, 4, 5, 8, 9] },            // E♭ whole-tone / augmented — unmoored
};

/* A country is an instrumentation, not only a key: the pad's window and
 * type, what the keys are (plucked strings, electric piano, bells,
 * glass), what the lead and the arpeggio and the bass are strung with,
 * how bright the hats sit, and a small lean on the tempo. The verge and
 * the shrine ring BELLS. ksBright: nylon low, steel/koto high. */
export const VOICES = {
  norrland: { pad: 900, padType: "glass", keys: "ks", ksBright: 0.45, lead: "square", arp: "sine", bass: "sub", hat: 7000, bell: false, tempo: 0 },
  costa: { pad: 1300, padType: "saw", keys: "ep", lead: "saw", arp: "pluck", bass: "pick", hat: 6400, bell: false, tempo: 5 },
  redgate: { pad: 760, padType: "saw", keys: "ks", ksBright: 0.8, lead: "square", arp: "ks", bass: "pick", hat: 5600, bell: false, tempo: -4 },
  thornmoor: { pad: 640, padType: "glass", keys: "ep", lead: "flute", arp: "sine", bass: "sub", hat: 7600, bell: false, tempo: -7, trim: { lead: 1.2, drone: 0.75 } },
  heartland: { pad: 1050, padType: "organ", keys: "ep", lead: "saw", arp: "pluck", bass: "sub", hat: 6800, bell: false, tempo: 2 },
  aspenvale: { pad: 1250, padType: "glass", keys: "bell", lead: "flute", arp: "sine", bass: "sub", hat: 8200, bell: false, tempo: 0 },
  kaldbrekka: { pad: 800, padType: "glass", keys: "glass", lead: "flute", arp: "sine", bass: "sub", hat: 9000, bell: false, tempo: -6, trim: { drone: 0.75 } },
  sandreach: { pad: 1100, padType: "saw", keys: "ks", ksBright: 0.35, lead: "saw", arp: "ks", bass: "pick", hat: 6000, bell: false, tempo: 3, trim: { bass: 0.8, pulse: 1.2 } },
  highline: { pad: 1350, padType: "saw", keys: "ep", lead: "saw", arp: "pluck", bass: "pick", hat: 8600, bell: false, tempo: 1 },
  cauldron: { pad: 680, padType: "saw", keys: "ep", lead: "square", arp: "square", bass: "reese", hat: 5200, bell: false, tempo: -2 },
  kurotani: { pad: 950, padType: "glass", keys: "ks", ksBright: 0.9, lead: "bell", arp: "ks", bass: "sub", hat: 8800, bell: true, tempo: -3, trim: { pulse: 1.5, lead: 1.25, kick: 0.8, drone: 0.7 } },
  ventisca: { pad: 580, padType: "saw", keys: "glass", lead: "flute", arp: "square", bass: "reese", hat: 7400, bell: false, tempo: -5, trim: { drone: 0.7, bass: 0.85 } },
  verge: { pad: 1400, padType: "glass", keys: "bell", lead: "bell", arp: "sine", bass: "sub", hat: 9800, bell: true, tempo: -9 },
};

const TIER_SECTION = ["hush", "hush", "roll", "groove", "theme", "lift"];
const TIER_BASE = [0, 0.06, 0.25, 0.45, 0.68, 0.86];

/* st: { state: "driving"|"waystation"|"over"|"attract", tier, flow, vKmh,
 *       night 0..1, rain 0..1, storm bool, tunnel 0..1, event bool,
 *       eventNew bool (this frame ARRIVES at a landmark), country,
 *       tech 0..1 (how tight the road ahead is — the codriver's turn) }
 * → { layers, dark, tempo, root, scale, voice, mode, fanfare, intensity,
 *     section, tech } */
export function musicPlan(st) {
  const L = { drone: 0, pad: 0, bass: 0, kick: 0, pulse: 0, ticks: 0, arp: 0, lead: 0, shimmer: 0 };
  const night = st.night || 0;
  const tunnel = st.tunnel || 0;
  const tech = Math.max(0, Math.min(1, st.tech || 0));
  const voice = VOICES[st.country] || VOICES.norrland;
  let tempo = 84;
  let mode = "drive";
  let section = "hush";
  let intensity = 0;

  if (st.state === "waystation") {
    // shelter: warmth and the hook played slowly on the keys, no motion —
    // rain on the roof does the percussion
    L.pad = 0.5; L.drone = 0.22; L.bass = 0.14; L.lead = 0.3;
    tempo = 64; mode = "shelter"; section = "shelter"; intensity = 0.2;
  } else if (st.state === "over") {
    L.pad = 0.45; L.drone = 0.26; L.lead = 0.24;
    tempo = 60; mode = "summary"; section = "summary"; intensity = 0.15;
  } else if (st.state === "attract") {
    // the title: the theme song at low intensity — the hook on keys over
    // the pad, a heartbeat kick, a little sparkle
    // (no arpeggio on the title: a sine ping every sixteenth over an idling
    // car read as "a high-pitched ringing", not as music)
    L.pad = 0.5; L.drone = 0.16; L.bass = 0.2; L.pulse = 0.3; L.lead = 0.5; L.shimmer = 0.12; L.ticks = 0.14; L.kick = 0.16;
    tempo = 78; mode = "title"; section = "title"; intensity = 0.3;
  } else {
    // driving: the layers are earned by flow, tier by tier
    const t = Math.max(0, Math.min(5, st.tier || 0));
    const speed = Math.min(1, (st.vKmh || 0) / 150);
    if (t <= 1) {
      L.pad = 0.12;                       // almost nothing. That is the point.
    } else if (t === 2) {
      L.pad = 0.32; L.drone = 0.3; L.bass = 0.36; L.pulse = 0.3; L.ticks = 0.18;
    } else if (t === 3) {
      L.pad = 0.36; L.drone = 0.36; L.bass = 0.44; L.kick = 0.3; L.pulse = 0.4; L.ticks = 0.3;
    } else {
      L.pad = 0.4; L.drone = 0.42; L.bass = 0.52; L.kick = 0.42;
      L.pulse = 0.5; L.ticks = 0.4; L.lead = 0.46;
      // the arpeggio is the zone's sparkle: opened by deep flow, and it
      // brightens further with real speed — fast road glitters
      L.arp = (t >= 5 ? 0.34 : 0.14) * (0.55 + 0.45 * speed);
      if (t >= 5) { L.bass = 0.56; L.kick = 0.48; L.ticks = 0.46; L.lead = 0.5; L.pad = 0.44; }
    }
    section = TIER_SECTION[t];
    intensity = TIER_BASE[t] + 0.08 * Math.min(1, (st.flow || 0) / 100) + 0.06 * speed;
    tempo = 84 + Math.min(24, (st.flow || 0) * 0.24);
    // a landmark deserves a phrase, if the run has any music going at all
    if (st.event && t >= 2) L.lead = Math.max(L.lead, 0.3);
    // technical road: the codriver's turn — the lead steps back, the hats tighten
    L.lead *= 1 - 0.75 * tech;
    L.ticks = Math.min(1, L.ticks * (1 + 0.35 * tech));
  }
  tempo += voice.tempo;

  if (night > 0.5 && L.pad > 0) L.shimmer = Math.max(L.shimmer, 0.24);
  if (night > 0.5) tempo -= 3;
  const storm = !!st.storm;
  if (storm) {
    L.shimmer = 0;                        // no sparkle in a storm
    L.drone = Math.min(1, L.drone * 1.3); // the weight settles low
    tempo -= 5;
    intensity = Math.min(1, intensity + 0.04);
  }

  tempo = Math.max(52, Math.min(118, tempo));
  intensity = Math.max(0, Math.min(1, intensity));

  // inside a bore the reverb takes the stage; the music steps back
  const duck = 1 - 0.6 * Math.max(0, Math.min(1, tunnel));
  for (const k in L) L[k] = Math.max(0, Math.min(1, L[k] * duck));

  const sc = SCALES[st.country] || SCALES.norrland;
  const dark = storm || night > 0.72;
  /* Arriving at a named landmark is worth a phrase even on a silent
   * cruise — a short quiet motif, once, on the arrival frame. The banner
   * for the ears. Never at a waystation, never mid-event. */
  const fanfare = !!st.eventNew && st.state === "driving";
  return { layers: L, dark, tempo, root: sc.root, scale: dark ? sc.dark : sc.bright, voice, mode, fanfare, intensity, section, tech };
}

/* ------------------------------------------------------------ realization */

/* the faders: what a layer at 1.0 puts on the music bus */
const LVL = { drone: 0.06, pad: 0.1, bass: 0.1, kick: 0.28, pulse: 0.2, ticks: 0.4, arp: 0.13, lead: 0.22, shimmer: 0.02 };
const TAU = { drone: 3.6, pad: 2.8, bass: 1.2, kick: 0.8, pulse: 0.9, ticks: 0.7, arp: 1.1, lead: 1.8, shimmer: 3.5 };
const RANK = { hush: 0, shelter: 0, summary: 0, roll: 1, title: 1, groove: 2, break: 2.5, theme: 3, lift: 4 };
const DRUM_LEVEL = { hush: 0, shelter: 0, summary: 0, roll: 1, title: 1, groove: 2, break: 0, theme: 3, lift: 4 };
const DRIVE_UP = ["hush", "roll", "groove", "theme", "lift"];
const LOOK = 0.25;

export function makeMusic(ctx, master, seed) {
  const rack = makeRack(ctx, master, seed, LAYERS);
  const g = rack.g;

  const M = {
    muted: false, r: rng(hashCombine(seed || 1, 0x30c5)),
    t: 0, i: 0, six: 60 / 84 / 4, tempo: 84, tempoSet: 0,
    key: null, theme: null, voice: null, pending: null,
    section: "hush", next: "hush", buildBar: false, crashAt: -1, highRun: 0, force: null,
    chordIdx: 0, chordDeg: 0, loopN: 0, arpI: 0,
    leadOct: 2, keysOct: 1, bassOct: -1, arpOct: 2,
    plan: null, lastMode: "drive", fanT: 0, holdUntil: -1,
    cues: [], stumbleUntil: -1, hitPending: false, liftHit: false, cadenceAt: -1, switchAtBar: false,
    driftOpen: false, boostOpen: false, duckDepth: 0.2,
    cur: { drone: 0, pad: 0, bass: 0, kick: 0, pulse: 0, ticks: 0, arp: 0, lead: 0, shimmer: 0 },
  };

  const hz = (deg, oct) => {
    const sc = M.key.scale, L = sc.length;
    const o = Math.floor(deg / L) + (oct || 0);
    return M.key.root * Math.pow(2, sc[((deg % L) + L) % L] / 12) * Math.pow(2, o);
  };
  const hv = (v) => v * (0.92 + 0.16 * M.r());
  const ht = (t) => t + (M.r() - 0.5) * 0.006;

  function setRegisters() {
    const low = M.key.root < 120;
    M.leadOct = low ? 3 : 2; M.keysOct = low ? 2 : 1; M.bassOct = low ? 0 : -1; M.arpOct = M.leadOct;
  }
  function adopt(p) {
    M.key = p.key; M.theme = p.theme; M.voice = p.voice;
    setRegisters();
    rack.pad.setType(p.voice.padType);
    rack.lead.setType(p.voice.lead === "bell" ? "flute" : p.voice.lead);
    rack.bass.setType(p.voice.bass);
  }

  /* Voice-led pad: each voice takes its chord tone in whichever octave is
   * NEAREST to where it already sits, so chords melt into each other
   * instead of jumping — kept inside a sane band so nothing crawls away. */
  function nearestOct(base, cur, root) {
    if (!cur) return base;
    let best = base, bd = Infinity;
    for (const o of [-1, 0, 1]) {
      const f = base * Math.pow(2, o);
      if (f < root * 0.5 || f > root * 4.2) continue;
      const d = Math.abs(Math.log(f / cur));
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }
  function retunePad(t) {
    const degs = [M.chordDeg, M.chordDeg + 2, M.chordDeg + 4, M.chordDeg + 6];
    const octs = [0, 0, -1, 0];
    for (let v = 0; v < 4; v++) {
      const pv = rack.pad.voices[v];
      const f = nearestOct(hz(degs[v], octs[v]), pv.f, M.key.root);
      rack.pad.setNote(v, f, t, 0.5);
    }
    rack.shimmer.setFreq(hz(M.chordDeg, 0), t, 1.2);
  }

  /* ------------------------------------------------------- the players */
  function keysNote(t, f, dur, vel, dst) {
    rack.play.keys(M.voice.keys, t, f, dur, vel, dst || g.pulse, M.voice.ksBright);
  }
  function playVoicing(vc, t, dur, vel, dst) {
    const tones = VOICINGS[vc] || VOICINGS.t;
    const broken = vc === "b";
    for (let k = 0; k < tones.length; k++) {
      const at = broken ? t + k * 2 * M.six : t + k * 0.012;
      keysNote(at, hz(M.chordDeg + tones[k], M.keysOct), broken ? dur * 0.6 : dur, hv(vel) * (k === 0 ? 1 : 0.85), dst);
    }
  }
  function leadNote(t, f, dur, vel) {
    if (M.voice.lead === "bell") rack.play.bell(t, f, dur, vel * 0.8, g.lead);
    else rack.lead.on(t, f, vel, dur);
  }
  function hitDrum(v, t, vel) {
    const kit = M.theme.kit;
    if (M.section === "lift") vel = Math.min(1, vel * 1.15);   // the lift leans in
    if (v === "kick") { rack.play.kick(t, vel, kit); rack.duck(t, M.duckDepth); }
    else if (v === "snare") rack.play.snare(ht(t), hv(vel), kit);
    else if (v === "hat") rack.play.hat(ht(t), hv(vel) * 0.8, M.voice.hat, false, kit);
    else if (v === "ohat") rack.play.hat(ht(t), hv(vel), M.voice.hat, true, kit);
    else if (v === "tom") { rack.play.tom(t, vel); rack.duck(t, M.duckDepth * 0.7); }
    else if (v === "rim") rack.play.rim(ht(t), hv(vel));
    else if (v === "tick") rack.play.tick(ht(t), hv(vel));
  }

  /* --------------------------------------------------------- the form */
  function decideNext() {
    const plan = M.plan;
    let want = plan.section;
    if (plan.mode !== "drive") {
      // a stop, the summary, the title: the mode outranks any forced
      // section (a rollover's hush must not hold the summary back)
      M.force = null;
    } else if (M.force) {
      want = M.force.section;
      if (--M.force.phrases <= 0) M.force = null;
    } else {
      const cur = RANK[M.section] || 0;
      // earn it one step at a time: no leaping from a hush to the lift
      if (RANK[want] - cur > 1.01) want = DRIVE_UP[Math.min(4, Math.floor(cur) + 1)];
      // breathe: after six phrases up high, a break — it must never blast
      if (RANK[want] >= 3 && M.highRun >= 6) { want = "break"; M.highRun = 0; }
    }
    M.next = want;
    M.buildBar = plan.mode === "drive" && RANK[want] > RANK[M.section] && RANK[want] >= 2;
  }
  function enterSection(i) {
    const rose = RANK[M.next] > RANK[M.section];
    M.section = M.next;
    M.buildBar = false;
    if (RANK[M.section] >= 3) M.highRun++;
    else if (M.section !== "break") M.highRun = 0;
    if (rose && RANK[M.section] >= 3) M.crashAt = i;
  }
  function chordChange(i, t) {
    if (M.pending) { adopt(M.pending); M.pending = null; }
    M.chordIdx = (i % 128) >> 5;
    if (M.chordIdx === 0) M.loopN++;
    const sec = M.section;
    const useB = sec === "lift" || ((sec === "theme" || sec === "title") && (M.loopN & 1) === 1);
    M.chordDeg = (useB ? M.theme.progB : M.theme.prog)[M.chordIdx];
    if (t >= M.holdUntil) retunePad(t);
  }

  /* --------------------------------------------------------- one step */
  function step(i, t) {
    const inPhrase = i % 64, inChord = i % 32, s16 = i & 15;
    if (inPhrase === 48) decideNext();
    /* a mode change (the waystation, the summary, leaving again) or a
     * forced section (grace, a border, a rollover) takes the next BAR,
     * not the next phrase — a stop should not wait, and a decision made
     * a bar ago is stale the moment the run changes */
    if (s16 === 0 && M.switchAtBar) { M.switchAtBar = false; decideNext(); M.buildBar = false; enterSection(i); }
    else if (inPhrase === 0) enterSection(i);
    if (inChord === 0) chordChange(i, t);
    const sec = M.section, th = M.theme, plan = M.plan, cur = M.cur, six = M.six;
    const tt = (i & 1) ? t + th.swing * six : t;
    const lastBar = inPhrase >= 48;
    const D = DRUM_LEVEL[sec] || 0;
    const stumbling = t < M.stumbleUntil;
    const intensity = plan.intensity;

    // the build into an upgrade: a riser across the last bar of the phrase
    if (M.buildBar && inPhrase === 48) rack.play.riser(t, six * 16, 0.6);

    // ----- drums
    if (D > 0 && !stumbling && (cur.kick > 1e-3 || cur.ticks > 1e-3)) {
      const pats = th.drums[D];
      const fill = lastBar && D >= 2 ? th.fills[M.buildBar ? 4 : D] : null;
      for (const v in pats) {
        if (fill && (v === "snare" || v === "tom" || v === "tick")) {
          for (const n of fill) if (n.step === s16) hitDrum(v, tt, n.vel * (0.6 + 0.4 * (s16 / 15)));
          continue;
        }
        for (const n of pats[v]) if (n.step === inChord) hitDrum(v, tt, n.vel);
      }
      if (M.crashAt === i) { rack.play.crash(t, 0.8); M.crashAt = -1; }
    }

    // ----- bass: the riff on the road, the root held everywhere else
    if (cur.bass > 1e-3) {
      if (sec === "roll" || sec === "groove" || sec === "theme" || sec === "lift") {
        for (const [s, d, l] of th.bass) if (s === inChord) rack.bass.on(tt, hz(M.chordDeg + d, M.bassOct), 0.9, l * six * 0.9);
      } else if (inChord === 0 && sec !== "hush" && t >= M.holdUntil) {
        rack.bass.on(t, hz(M.chordDeg, M.bassOct), 0.7, 32 * six * 0.95);
      }
    }

    // ----- keys: the comping figure; in the break only its downbeats; in
    // the groove, on odd loops, the keys sketch the hook — a tease
    if (cur.pulse > 1e-3) {
      if (sec === "roll" || sec === "groove" || sec === "theme" || sec === "lift" || sec === "title" || sec === "break") {
        for (const [s, vc, l] of th.comp) {
          if (s !== inChord) continue;
          if (sec === "break" && s % 16 !== 0) continue;
          playVoicing(vc, tt, l * six, 0.5 + 0.3 * intensity);
        }
      }
      if (sec === "groove" && (M.loopN & 1) === 1) {
        for (const n of th.cells[M.chordIdx]) if (n.start === inChord) keysNote(tt, hz(M.chordDeg + n.deg, M.keysOct + 1), n.len * six, 0.5, g.pulse);
      }
    }

    // ----- the hook
    if (cur.lead > 1e-3) {
      const cell = th.cells[M.chordIdx];
      if (sec === "theme" || sec === "lift") {
        for (const n of cell) {
          if (n.start !== inChord) continue;
          leadNote(tt, hz(M.chordDeg + n.deg, M.leadOct), n.len * six * 0.92, 0.72 + 0.2 * intensity);
          // the lift: the keys double the hook an octave up — the tune, twice as big
          if (sec === "lift" && cur.pulse > 1e-3) keysNote(tt, hz(M.chordDeg + n.deg, M.leadOct + 1), n.len * six * 0.9, 0.55, g.pulse);
        }
      } else if (sec === "shelter" || sec === "summary" || sec === "title") {
        for (const n of cell) if (n.start === inChord && t >= M.holdUntil) keysNote(tt, hz(M.chordDeg + n.deg, M.leadOct), n.len * six * 1.5, 0.45, g.lead);
      }
    }

    // ----- the arpeggio: the zone's sparkle; halved in the break
    if (cur.arp > 1.5e-3 && (sec === "theme" || sec === "lift" || sec === "break")) {
      if (sec !== "break" || (i & 1) === 0) {
        const pat = th.arp;
        const d = pat[M.arpI % pat.length]; M.arpI++;
        rack.play.arp(M.voice.arp, tt, hz(M.chordDeg + d, M.arpOct), six * 1.6, s16 % 4 === 0 ? 0.6 : 0.42, g.arp);
      }
    }

    // ----- stingers land on the eighth
    if ((i & 1) === 0) {
      if (M.hitPending) { M.hitPending = false; rack.play.crash(t, 0.7); playVoicing("7", t, six * 6, 0.8); rack.duck(t, 0.5); }
      if (M.liftHit) { M.liftHit = false; rack.play.hat(t, 0.9, M.voice.hat, true, th.kit); playVoicing("hi", t, six * 3, 0.6); }
    }
  }

  /* ---------------------------------------------------- the one-offs */
  function fanfare(t0, duck) {
    const oct = M.leadOct - 1;
    let t = t0;
    for (let k = 0; k < 4; k++) {
      const last = k === 3;
      rack.play.brass(t, hz(M.chordDeg + [0, 3, 4, 7][k], oct), last ? 0.9 : 0.3, (last ? 1 : 0.75) * 0.11 * duck, rack.sum);
      t += 0.22;
    }
    rack.play.brass(t0 + 0.44, hz(M.chordDeg, oct - 1), 1.3, 0.05 * duck, rack.sum);
  }
  /* The cadence: the dominant leaning home, then home — the resolution
   * the old music never had. On arrival at a waystation, and once when
   * the summary comes up. */
  function cadence(t) {
    const t2 = t + 1.9;
    M.chordDeg = 4; retunePad(t);
    playVoicing("7", t, 1.7, 0.7);
    rack.bass.on(t, hz(4, M.bassOct), 0.8, 1.7);
    M.chordDeg = 0; retunePad(t2);
    playVoicing("t", t2, 3.0, 0.75);
    rack.bass.on(t2, hz(0, M.bassOct), 0.85, 3.0);
    keysNote(t + 0.3, hz(4, M.leadOct), 1.2, 0.5, g.lead);
    keysNote(t + 1.2, hz(2, M.leadOct), 0.8, 0.45, g.lead);
    keysNote(t2 + 0.1, hz(0, M.leadOct), 2.6, 0.55, g.lead);
    M.holdUntil = t2 + 2.8;
  }

  /* ------------------------------------------------------------ cues
   * The run's events, quantized onto the grid by step(). */
  function cue(name, d) { M.cues.push([name, d || {}]); }
  function nextBarTime() { return M.t + (16 - (M.i & 15)) * M.six; }
  /* a forced section takes the next bar (the rest of this phrase counts
   * as its first), so phrases: 2 is "now, and the whole next phrase" */
  function force(section, phrases) { M.force = { section, phrases }; M.switchAtBar = true; }
  function handleCue(name, d, now) {
    const high = RANK[M.section] >= 2;
    switch (name) {
      case "landed": if (d.clean && (d.air || 0) >= 0.45 && high) M.hitPending = true; break;
      case "collision":
        if ((d.impact || 0) > 7 && high) { M.stumbleUntil = nextBarTime(); rack.play.hit(now + 0.02, M.key ? M.key.root / 2 : 60, 0.35 * Math.max(M.cur.kick, M.cur.bass) / LVL.bass); }
        break;
      case "grace": force("hush", 2); M.stumbleUntil = nextBarTime(); break;
      case "driftStart": M.driftOpen = true; break;
      case "driftEnd": M.driftOpen = false; if ((d.duration || 0) >= 1.2 && high) rack.throwDelay(now, 1.6); break;
      case "border": if (high) force("break", 2); break;
      case "waystation": M.cadenceAt = now; break;
      case "legStart": force("roll", 2); M.loopN = 0; M.highRun = 0; break;
      case "boostStart": M.boostOpen = true; break;
      case "boostEnd": M.boostOpen = false; break;
      case "flowTier": if (d.up && (d.tier || 0) >= 3 && high) M.liftHit = true; break;
      case "rollover": force("hush", 3); M.stumbleUntil = nextBarTime(); break;
      default: break;
    }
  }

  /* ---------------------------------------------------------- update */
  function update(dt, st) {
    if (M.muted) return;
    const plan = musicPlan(st || {});
    M.plan = plan;
    const now = ctx.currentTime;
    const country = (st && st.country) || "norrland";

    // the key, the theme and the voice: adopted at the next chord change,
    // never mid-phrase — a border is a modulation, not a lurch
    const theme = compiled(country);
    if (!M.key) adopt({ key: { root: plan.root, scale: plan.scale }, theme, voice: plan.voice });
    else if (plan.root !== M.key.root || plan.scale !== M.key.scale || theme !== M.theme) M.pending = { key: { root: plan.root, scale: plan.scale }, theme, voice: plan.voice };
    else M.pending = null;

    for (const [name, d] of M.cues) handleCue(name, d, now);
    M.cues.length = 0;

    M.fanT = Math.max(0, (M.fanT || 0) - dt);
    if (plan.fanfare && M.fanT <= 0) {
      fanfare(now + 0.03, 1 - 0.6 * (st.tunnel || 0));
      M.fanT = 30;   // a fanfare is rare by definition; never twice in half a minute
    }
    if (plan.mode === "summary" && M.lastMode !== "summary") M.cadenceAt = now;
    if (plan.mode !== M.lastMode) M.switchAtBar = true;
    M.lastMode = plan.mode;
    if (M.cadenceAt >= 0) { cadence(M.cadenceAt + 0.05); M.cadenceAt = -1; }

    // the pad's window follows the country, the dark, the drive, the slide
    const open = (M.driftOpen || M.boostOpen) ? 1.6 : 1;
    rack.pad.setCutoff(plan.voice.pad * (plan.dark ? 0.72 : 1) * (0.8 + 0.4 * plan.intensity) * open, now, 0.6);
    rack.drone.setFreq(plan.root / 2, now, 1.4);
    // the colour voice (a seventh over the chord) only in deep flow or at night
    const colour = ((st && st.tier) || 0) >= 4 || ((st && st.night) || 0) > 0.5 ? 0.3 : 0;
    rack.pad.setVoiceGain(3, colour, now, 2.0);
    M.duckDepth = 0.15 + 0.35 * plan.intensity;

    // layer gains chase their targets, each at its own pace
    const stumbling = now < M.stumbleUntil;
    let audible = false;
    const trim = plan.voice.trim || null;
    for (const k of LAYERS) {
      let target = plan.layers[k] * LVL[k] * (trim && trim[k] ? trim[k] : 1);   // a country's own mix
      if (stumbling && (k === "kick" || k === "ticks")) target = 0;
      M.cur[k] += (target - M.cur[k]) * Math.min(1, dt / TAU[k]);
      if (k === "shimmer") {
        rack.shimmer.depth.gain.value = M.cur[k] * 0.45;
        g[k].gain.setTargetAtTime(M.cur[k], now, 0.3);
      } else if (k === "drone") {
        rack.drone.depth.gain.value = M.cur[k] * 0.3;
        g[k].gain.setTargetAtTime(M.cur[k], now, 0.5);
      } else {
        g[k].gain.setTargetAtTime(M.cur[k], now, 0.1);
      }
      if (M.cur[k] > 0.0008 || target > 0.0008) audible = true;
    }

    /* silent means SILENT: no scheduling at all, and the clock pins to
     * now so the grid resumes on a phrase instead of flushing a backlog */
    if (!audible) { M.t = now + 0.05; M.i = Math.ceil(M.i / 64) * 64; return; }

    M.tempo += (plan.tempo - M.tempo) * Math.min(1, dt / 3);
    if (Math.abs(M.tempo - M.tempoSet) > 0.3) { rack.setTempo(M.tempo); M.tempoSet = M.tempo; }
    M.six = 60 / M.tempo / 4;
    if (M.t < now - 0.5) { M.t = now + 0.02; M.i = Math.ceil(M.i / 16) * 16; }   // hitch: re-pin on a bar, don't spray

    while (M.t < now + LOOK) {
      step(M.i, M.t);
      M.t += M.six;
      M.i++;
    }
  }

  function setMuted(m) {
    M.muted = m;
    const now = ctx.currentTime;
    if (m) for (const k of LAYERS) { M.cur[k] = 0; g[k].gain.setTargetAtTime(0, now, 0.15); }
  }

  function reseed(seed) {
    M.r = rng(hashCombine(seed || 1, 0x30c5));
    M.i = 0; M.t = ctx.currentTime;
    M.section = "hush"; M.next = "hush"; M.force = null; M.highRun = 0; M.buildBar = false;
    M.loopN = 0; M.chordIdx = 0; M.chordDeg = 0; M.arpI = 0;
    M.cues.length = 0; M.stumbleUntil = -1; M.hitPending = false; M.liftHit = false; M.holdUntil = -1;
    M.driftOpen = false; M.boostOpen = false;
    M.key = null; M.pending = null;
  }

  function setLevel(f) { rack.setLevel(f); }

  return { update, cue, setMuted, reseed, setLevel, state: () => M };
}
