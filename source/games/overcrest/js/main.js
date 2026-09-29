/* Overcrest — boot and the main loop.
 *
 * Fixed 120 Hz simulation under a render-rate accumulator; the world
 * streams ahead of the car, the renderer streams behind the world, and
 * everything hangs off one run seed. The run layer (game/run.js) owns the
 * roguelike state; this file only wires systems together.
 *
 * Query params: ?seed=NAME  ?bot=1 (self-drive)  ?debug=1  ?ff=SECONDS
 */

import { makeWorld } from "./world/world.js";
import { makeCar, step, botInput, DT, DEFAULT_MODS, setSteerFeel } from "./sim/physics.js";
import { seedFromString, seedName, hash32, hashCombine, rng } from "./core/rng.js";
import { makeInput } from "./core/input.js";
import { makeBus } from "./core/bus.js";
import { BIOMES, START_BIOME } from "./world/biomes.js";
import { makePost } from "./render/post.js";
import { makeScene } from "./render/scene.js";
import { makeChunks } from "./render/chunks.js";
import { buildKestrel, updateKestrel, applyWear, applyBuild, buildTripod, buildSweepCar, updateSweepCar } from "./render/carmesh.js";
import { makeDevLines } from "./render/devlines.js";
import { makeChaseCam } from "./render/camera.js";
import { makeHud } from "./ui/hud.js";
import { makeWaystationUI, waystationName } from "./ui/waystation.js";
import { makeCodriver } from "./game/codriver.js";
import { makeRun, sweepFactor } from "./game/run.js";
import { routesFor, OPENER } from "./game/routes.js";
import { saveRun, loadRun, clearRun, recordBest } from "./game/save.js";
import { makeBuild, offerCards, DEFAULT_RUNMODS } from "./game/build.js";
import { findDef } from "./game/souvenirs.js";
import { collectPickups } from "./game/pickups.js";
import { makeAtmosphere, DAY_SECONDS } from "./world/atmosphere.js";
import { makeCelestial } from "./world/celestial.js";
import { makeEffects } from "./render/effects.js";
import { makeParticles } from "./render/particles.js";
import { assignBiomes, legPlan, markSuitedRoutes, buildAffinity } from "./game/director.js";
import { blendPalette } from "./world/biomes.js";
import { makePauseUI } from "./ui/settings.js";
import { makeTelemetry } from "./core/telemetry.js";
import { loadMeta, saveMeta } from "./game/save.js";
import { makePostcardBook, mergeGallery, describe as describeCard } from "./game/postcards.js";
import { makeAchievements, bookFor, ACHIEVEMENTS, ACH_BY_ID } from "./game/achievements.js";
import * as audio from "./audio/audio.js";

// the modules have arrived: second stage of the honest load
{ const ls = document.getElementById("loadStatus"); if (ls) ls.textContent = "laying the road…"; }

const params = new URLSearchParams(location.search);
const DEBUG = params.get("debug") === "1";
const BOT = params.get("bot") === "1";
const FF = Math.min(900, parseFloat(params.get("ff") || "0") || 0);   // pre-sim seconds (bot only)
const SHOWWS = params.get("showws") === "1" || params.get("showws") === "routes";   // bot mode: open the waystation UI instead of auto-departing ("routes" clicks through to the route stage)
const START_U = params.has("time") ? parseFloat(params.get("time")) : null;   // debug: day fraction
const NOSTORM = params.get("nostorm") === "1";  // debug: the storm layer off (strikes, wind, grade) — a bisect switch for the shots
const FORCE_W = params.get("weather");          // debug: rain | fog | overcast | clear
const GOTO = params.get("to");                  // debug: bridge | tunnel | overpass | a distance in m
const FORCE_EV = params.get("event");           // debug: force a special event every section
const FORCE_SKY = params.get("sky");            // debug: meteors | lightning | rainbow | inversion | eclipse
const END_AFTER = params.get("end") === "1";    // debug: park at the end of ?ff / ?to and read the summary
// `?steer=0.75` — keyboard steering attack trim (feel experiment, 2026-08-25)
if (params.has("steer")) setSteerFeel(parseFloat(params.get("steer")));

/* ------------------------------------------------------- the quality ladder
 *
 * One dial for the whole picture. Every knob here is RENDER-ONLY by the
 * same contract as the old settings (physics reads the analytic ground,
 * colliders never thin, the sim never knows) — so a tier change mid-run
 * is always safe, and a resumed run on a different machine replays the
 * same journey under a different sky resolution.
 *
 *   scale    the 3D frame's resolution as a fraction of the canvas — the
 *            post chain composites it back up at full size, so the HUD
 *            and grade stay crisp while raster cost falls with scale²
 *   prCap    devicePixelRatio ceiling (retina is beautiful and expensive)
 *   samples  MSAA on the scene target
 *   post     the bloom/grade chain itself (failsafe alone turns it off —
 *            the canvas's own antialias carries the direct fallback)
 *   terrRes  blanket quads per 48 m cell (16 = 3 m, 12 = 4 m, 8 = 6 m;
 *            all keep the far shell's 12 m pitch on shared lattice points)
 *   reach    draw-distance factor (blanket + section cut move together)
 *   farR     far-shell radius (cells fall with the square of it; 750 still
 *            clears full clear-day fog at 700)
 *   clouds   how many cloud puffs may fly (54 was the only number before;
 *            ultra stacks the big skies deeper)
 *   parts    dust/spray density
 *   sky      the dome's night detail (2 = milky way + star dust)
 */
const QUALITY = {
  failsafe: { scale: 0.62, prCap: 0.85, samples: 0, post: false, terrRes: 8, reach: 0.7, farR: 750, clouds: 16, parts: 0.3, sky: 1 },
  eco: { scale: 0.62, prCap: 1.0, samples: 0, post: true, terrRes: 8, reach: 0.7, farR: 750, clouds: 24, parts: 0.4, sky: 1 },
  balanced: { scale: 0.8, prCap: 1.25, samples: 2, post: true, terrRes: 12, reach: 0.85, farR: 950, clouds: 38, parts: 0.7, sky: 1 },
  high: { scale: 1.0, prCap: 1.6, samples: 4, post: true, terrRes: 16, reach: 1, farR: 1150, clouds: 54, parts: 1, sky: 2 },
  ultra: { scale: 1.0, prCap: 2.0, samples: 4, post: true, terrRes: 16, reach: 1, farR: 1150, clouds: 70, parts: 1, sky: 2 },
};
const Q_LADDER = ["failsafe", "eco", "balanced", "high", "ultra"];
// `?quality=high` — pin a tier (screenshots, A/B): overrides settings AND the governor
const QFORCE = QUALITY[params.get("quality")] ? params.get("quality") : null;

/* First guess for auto: capability signals only — the governor measures
 * real frames from here and walks the ladder both ways. Headless/bot runs
 * pin HIGH so every screenshot recipe keeps rendering the same picture
 * (software GL would otherwise read as a weak machine and change the look
 * of every probe). */
function guessTier(renderer) {
  if (BOT) return "high";
  const m = loadMeta();
  if (QUALITY[m.autoTier] && m.autoTier !== "failsafe") return m.autoTier;   // where auto settled last time
  if (!renderer.capabilities.isWebGL2) return "eco";
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
    if (/swiftshader|llvmpipe|software|microsoft basic/i.test(name)) return "eco";
  } catch (e) { /* the guess just stays conservative */ }
  if ((navigator.deviceMemory || 8) <= 4 || (navigator.hardwareConcurrency || 8) <= 4) return "balanced";
  return "high";
}

/* the tier actually in force: a pinned URL wins, then a fixed setting,
 * then wherever auto currently stands */
function currentTier() {
  if (QFORCE) return QFORCE;
  if (BOT) return "high";
  const s = G.settings;
  if (s && QUALITY[s.quality]) return s.quality;
  if (!G.autoTier) G.autoTier = guessTier(G.kit.renderer);
  return G.autoTier;
}

function applyQuality(tier) {
  const q = QUALITY[tier] || QUALITY.high;
  G.qualityTier = tier;
  const pr = Math.min(window.devicePixelRatio || 1, q.prCap);
  G.kit.renderer.setPixelRatio(pr);
  G.kit.setSkyDetail(q.sky);
  if (G.post) {
    G.post.configure({ scale: q.scale, samples: q.samples });
    G.post.setEnabled(q.post);
  }
  if (G.chunks) {
    G.chunks.setDetail(q.terrRes);
    G.chunks.setReach(q.reach);
    G.chunks.setFarRadius(q.farR);
  }
  if (G.parts) G.parts.setDensity(q.parts);
  if (G.effects) G.effects.setCloudCap(q.clouds);
}

const els = {
  achToast: document.getElementById("achToast"),
  loading: document.getElementById("loading"),
  loadStatus: document.getElementById("loadStatus"),
  title: document.getElementById("title"),
  clockHud: document.getElementById("clockHud"),
  btnDrive: document.getElementById("btnDrive"),
  btnResume: document.getElementById("btnResume"),
  seedInput: document.getElementById("seedInput"),
};

const G = {
  world: null, car: null, bus: null, run: null, build: null, cardIds: [], logSeen: 0,
  atmo: null, celestial: null, effects: null, weatherCalled: 0,
  legsInBiome: 1, transitionSpoken: -1, biomeAnnounced: "",
  pauseUI: null, settings: null, attract: false,
  tele: null,
  kit: null, post: null, parts: null, chunks: null, kestrel: null, cam: null, codriver: null,
  hud: null, wsui: null, input: null,
  running: false, paused: false,
  seedStr: "", seed: 0, choices: [],
  accum: 0, lastT: 0,
  wsTimer: 0, wsOpen: false,
};

/* ------------------------------------------------- surviving the browser
 * (Phase 22, Addendum II: "the browser is a hostile host"). Three r160
 * already preventDefaults webglcontextlost and rebuilds its whole GL
 * pipeline on restore (initGLContext — every geometry, texture, program
 * and render target re-uploads lazily), so the game's own duties are:
 * hold the SIM while the display is dead (the run must not continue
 * blind), say so quietly, and pick the clock back up on restore. */
function wireSurvival(canvas) {
  canvas.addEventListener("webglcontextlost", () => {
    G.glLost = true;
    document.getElementById("glNotice").classList.add("on");
  });
  canvas.addEventListener("webglcontextrestored", () => {
    G.glLost = false;
    G.lastT = performance.now();          // the dead time never happened
    G.accum = 0;
    document.getElementById("glNotice").classList.remove("on");
  });

  /* tab blur: leaving the tab pauses the game — audio ducked, sim held,
   * nothing lost to answering a message. Returning finds the pause sheet
   * up; driving on is the player's calm choice, never a jump-scare. */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (G.running && !G.attract && !BOT && !G.paused && !G.run.R.over && !G.wsOpen) {
        G.paused = true;
        G.pauseUI.show();
      }
      audio.setMuted(true);
    } else {
      if (G.settings) audio.setMuted(G.settings.sound === "off");
      G.lastT = performance.now();
      G.accum = 0;
    }
  });

  /* catastrophe: a real crash gets a human apology with the seed and the
   * journey intact — never a frozen canvas. Extension noise (cross-origin
   * files) is not ours and never triggers it. */
  const catastrophe = (detail) => {
    if (G.cataShown) return;
    G.cataShown = true;
    G.running = false;
    try { audio.setMuted(true); } catch (e) { /* the sheet still shows */ }
    const saved = loadRun();
    document.getElementById("catSave").textContent =
      (G.seedStr ? `Seed ${G.seedStr}. ` : "") +
      (saved ? `Your journey is saved to waystation ${saved.wsIndex + 1}. Reload and press Resume.`
        : "The run hadn't reached a waystation yet, so there was nothing saved to lose.");
    document.getElementById("catDetail").textContent = String(detail || "unknown error").slice(0, 4000);
    document.getElementById("catastrophe").classList.add("on");
  };
  window.addEventListener("error", (e) => {
    if (e.filename && !e.filename.startsWith(location.origin)) return;   // not our code
    catastrophe((e.error && e.error.stack) || e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    catastrophe((e.reason && e.reason.stack) || String(e.reason));
  });
  document.getElementById("btnCatReload").addEventListener("click", () => location.reload());
  document.getElementById("btnCatCopy").addEventListener("click", () => {
    const t = document.getElementById("catDetail").textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t);
  });

  /* probes — Phase 24 certifies with these, headlessly:
   *   ?glprobe=1    force a context loss at 6 s, restore at 8 s
   *   ?blurprobe=1  run the tab-hidden path at 5 s
   *   ?crashprobe=1 throw an uncaught error at 6 s */
  if (params.get("glprobe") === "1") {
    setTimeout(() => { try { G.kit.renderer.forceContextLoss(); } catch (e) { console.error("glprobe: no lose_context ext"); } }, 6000);
    setTimeout(() => { try { G.kit.renderer.forceContextRestore(); } catch (e) { /* covered above */ } }, 8000);
  }
  if (params.get("blurprobe") === "1") {
    setTimeout(() => {
      if (G.running && !G.attract && !G.paused) { G.paused = true; G.pauseUI.show(); audio.setMuted(true); }
    }, 5000);
  }
  if (params.get("crashprobe") === "1") {
    setTimeout(() => { throw new Error("crashprobe: a deliberate, uncaught error"); }, 6000);
  }
}

function boot() {
  const canvas = document.getElementById("gl");
  wireSurvival(canvas);
  const biome = BIOMES[START_BIOME];
  G.kit = makeScene(canvas, biome.palette);
  G.post = makePost(G.kit.renderer, G.kit.scene, G.kit.camera);
  window.addEventListener("resize", () => G.post.resize());
  // camera state lives in render space: it must move with the anchor
  G.kit.onRebase((dx, dz) => { if (G.cam) G.cam.rebase(dx, dz); });
  // dev telemetry (localhost only): a human drive as numbers
  G.tele = makeTelemetry(params.get("tele") !== "0");
  window.addEventListener("beforeunload", () => G.tele && G.tele.flush());
  G.hud = makeHud();
  G.wsui = makeWaystationUI();
  G.input = makeInput();
  G.hud.showMeters(false);

  // settings apply through one function; systems that do not exist yet
  // (codriver, camera) pick the values up when they are created
  G.pauseUI = makePauseUI((s) => {
    G.settings = s;
    // the player's keys, pad feel and haptics (Phase 21)
    G.input.setPad({ dead: s.padDead, curve: s.padCurve });
    G.input.setHaptics(s.haptics !== "off");
    if (G.codriver) G.codriver.setVerbosity(s.verbosity);
    if (G.cam) {
      G.cam.state.distK = s.camDist === "close" ? 0.86 : s.camDist === "far" ? 1.35 : 1;
      G.cam.state.upK = s.camDist === "close" ? 0.92 : s.camDist === "far" ? 1.45 : 1;
      G.cam.state.fovCap = s.fovCap === "on";
    }
    audio.setMuted(s.sound === "off");
    audio.setVoiceMuted(s.voice === "off");
    audio.setMusicMuted(s.music === "off");
    audio.setVolumes({ master: s.volMaster, voice: s.volVoice, music: s.volMusic });
    /* three HUD tiers (owner): EVERYTHING wears the build on the dash (the
     * charm rail), BASICS keeps the instruments, ZEN keeps only the calls
     * and the road. An old saved "full" reads as everything. */
    document.body.classList.toggle("zen", s.hud === "zen");
    document.body.classList.toggle("basics", s.hud === "basics");
    G.hudTier = s.hud === "zen" ? "zen" : s.hud === "basics" ? "basics" : "everything";
    document.body.classList.toggle("hud-small", s.hudSize === "small");
    document.body.classList.toggle("hud-large", s.hudSize === "large");
    // the dash clock: waystations always show the time; this keeps it up
    G.clockAlways = s.clock === "always";
    if (els.clockHud && !G.clockAlways) els.clockHud.style.display = "none";
    /* Assists fold into the physics as one quiet multiplier set — named
     * plainly in the sheet, no score penalty, no stigma. */
    G.assist = {
      on: s.stabiliser !== "standard" || s.brakehelp === "mild" || s.traction === "extra",
      stability: s.stabiliser === "light" ? 0.8 : s.stabiliser === "strong" ? 1.35 : 1,
      brake: s.brakehelp === "mild" ? 1.12 : 1,
      grip: s.traction === "extra" ? 1.06 : 1,
      offDrag: s.traction === "extra" ? 0.75 : 1,
    };
    if (G.codriver) G.codriver.setTiming(s.timing);
    if (G.cam) G.cam.state.reducedMotion = s.motion === "reduced";
    if (G.cam) G.cam.state.cutsOn = s.camCuts !== "off";
    // accessibility: bigger subtitles, colourblind-safe call colours
    document.body.classList.toggle("sub-large", s.subSize === "large");
    document.body.classList.toggle("cb", s.colour === "safe");
    if (G.hud && G.hud.setColour) G.hud.setColour(s.colour);
    // graphics: the one quality dial (render-only by contract — physics
    // reads the analytic ground, never these meshes; vegetation density is
    // deliberately not a knob on any tier: trees are colliders, and a
    // thinner forest would be an invisible wall). Choosing a fixed tier
    // stands the governor down; choosing auto hands the ladder back to it.
    if (QUALITY[s.quality]) { G.qGood = 0; G.qBad = 0; }
    applyQuality(currentTier());
  }, (binds) => G.input.setBinds(binds));
  G.pauseUI.onResume(() => { G.paused = false; G.hud.message("", 0.1); });
  G.pauseUI.onQuit(() => { G.paused = false; if (G.run && !G.run.R.over) G.run.endRun("parked"); });

  const urlSeed = params.get("seed");
  if (urlSeed) els.seedInput.value = urlSeed.toUpperCase();

  els.loading.classList.remove("on");
  const leaveAttract = () => { G.attract = false; document.body.classList.remove("attract"); };

  // V toggles the dev overlay (debug builds only)
  window.addEventListener("keydown", (e) => {
    if ((e.key === "v" || e.key === "V") && G.dev && document.activeElement !== els.seedInput) G.dev.toggle();
  });
  /* Mid-run country teleport, the last of the bible's debug-tool list:
   * `oc.jump("kaldbrekka")` in the console starts that country's blend at
   * the frontier — the same joint chooseRoute uses, so regions, palettes
   * and the codriver's transition line all follow honestly. */
  window.oc = {
    /* the terrain streamer's audit: holes (sky through the ground) and
     * patches (far shell where the blanket should be) this frame, hole
     * frames since the run began, build time — see chunks.js stats() */
    terrain() { return G.chunks ? G.chunks.stats() : null; },
    /* the quality ladder's audit (tools/_perfprobe.mjs polls this): the
     * tier in force, whether auto holds the dial, and the frame numbers
     * the governor is looking at */
    quality() {
      let mean = 0, worst = 0;
      if (G.perf && G.perf.n) {
        for (let i = 0; i < G.perf.n; i++) { const v = G.perf.hist[i]; mean += v; if (v > worst) worst = v; }
        mean /= G.perf.n;
      }
      const ps = G.post ? G.post.stats : { calls: 0, triangles: 0 };
      return {
        tier: G.qualityTier || "?", auto: !QFORCE && !BOT && !!(G.settings && G.settings.quality === "auto"),
        mean, worst, draws: ps.calls, triangles: ps.triangles,
        pixelRatio: G.kit ? G.kit.renderer.getPixelRatio() : 0,
      };
    },
    jump(key) {
      if (!G.world || !BIOMES[key]) return "unknown country: " + key;
      G.world.jumpBiome(key);
      return "next sections generate in " + key;
    },
    /* the marshals' book: this journey's ledger, the lifetime ledger, and
     * what has been marked (ids); the harness's `achievements` mode is the
     * real audit, this is the live peek */
    achievements() {
      if (!G.ach) return null;
      return { journey: G.ach.J, life: G.ach.L, marked: Object.keys(G.ach.unlocked), earned: G.ach.earned.slice(), total: ACHIEVEMENTS.length };
    },
    /* the soundtrack: context state, the arranger's section and step, the
     * live layer levels (tools/_musicprobe.mjs polls this) */
    music() { return audio.musicDebug(); },
  };

  // B peeks at the build; never while typing a seed, never over a sheet
  window.addEventListener("keydown", (e) => {
    if (e.key !== "b" && e.key !== "B") return;
    if (document.activeElement === els.seedInput) return;
    if (!G.running || G.attract || G.wsOpen || G.paused || (G.run && G.run.R.over)) return;
    G.bpOpen = !G.bpOpen;
    document.getElementById("buildPanel").classList.toggle("on", G.bpOpen);
    if (G.bpOpen) renderBuildPanel();
  });
  els.btnDrive.addEventListener("click", () => { G.sweepOut = false; leaveAttract(); startRun(null); });
  els.seedInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { G.sweepOut = false; leaveAttract(); startRun(null); } });

  const saved = loadRun();
  if (saved && !BOT) {
    els.btnResume.style.display = "block";
    els.btnResume.textContent = `Resume ${saved.mode === "sweep" ? "the Sweep" : "journey"}: ${saved.seedStr}, waystation ${saved.wsIndex + 1}`;
    els.btnResume.addEventListener("click", () => { leaveAttract(); startRun(saved); });
  }

  /* The travel diary, browsable from the title: lifetime postcards as
   * prose, grouped by country, with the records up top. Unlocks nothing,
   * gates nothing — it is the answer to "where have I been". */
  const galBtn = document.getElementById("btnPostcards");
  const gal = document.getElementById("gallery");
  const meta0 = loadMeta();
  if (!BOT && ((meta0.postcards && meta0.postcards.length) || meta0.runs)) galBtn.style.display = "block";
  galBtn.addEventListener("click", () => {
    const meta = loadMeta();
    document.getElementById("galBest").innerHTML =
      `<span>Journeys<b>${meta.runs || 0}</b></span>` +
      `<span>Best distance<b>${((meta.bestDist || 0) / 1000).toFixed(1)} km</b></span>` +
      `<span>Best score<b>${Math.round(meta.bestScore || 0).toLocaleString()}</b></span>` +
      `<span>Most waystations<b>${meta.bestWaystations || 0}</b></span>` +
      ((meta.sweepRuns || 0) > 0
        ? `<span>Sweep best<b>${((meta.bestSweepDist || 0) / 1000).toFixed(1)} km · ${meta.bestSweepWaystations || 0} stops</b></span>`
        : "") +
      `<span>Lifetime<b>${((meta.totalDist || 0) / 1000).toFixed(0)} km</b></span>`;
    const byCountry = {};
    for (const c of meta.postcards || []) (byCountry[c.country || "Elsewhere"] = byCountry[c.country || "Elsewhere"] || []).push(c);
    const list = document.getElementById("galList");
    const names = Object.keys(byCountry);
    list.innerHTML = names.length
      ? names.map((n) =>
        `<h4>${n}</h4><ul>${byCountry[n].map((c) => {
          const t = describeCard(c);
          const i = t.indexOf(" · ");
          return i < 0 ? `<li>${t}</li>` : `<li>${t.slice(0, i)}<span>${t.slice(i)}</span></li>`;
        }).join("")}</ul>`).join("")
      : `<div class="none">Nothing collected yet. Landmarks you drive become postcards.</div>`;
    gal.classList.add("on");
  });
  document.getElementById("btnGalClose").addEventListener("click", () => gal.classList.remove("on"));

  /* THE MARSHALS' BOOK, browsable from the title: every chapter, the
   * skill marks listed from the start (things to try), the moments and
   * the jokes named only once they have happened. Offered on the same
   * terms as the postcards: once there has been a journey. */
  const achBtn = document.getElementById("btnAchievements");
  const achSheet = document.getElementById("achievements");
  if (!BOT && (meta0.runs || (meta0.achievements && Object.keys(meta0.achievements).length))) achBtn.style.display = "block";
  const renderBook = (unlocked) => {
    const book = bookFor(unlocked);
    const done = Object.keys(unlocked).filter((k) => ACH_BY_ID[k]).length;
    document.getElementById("achCount").innerHTML = `<span>Marked<b>${done}</b></span><span>Of<b>${ACHIEVEMENTS.length}</b></span>`;
    const when = (rec) => {
      if (!rec) return "";
      const d = new Date(rec.at);
      const day = isNaN(d) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
      return [rec.seed, rec.km != null ? rec.km.toFixed(1) + " km in" : "", day].filter(Boolean).join(" · ");
    };
    document.getElementById("achList").innerHTML = book.map((ch) =>
      `<h4>${ch.title}<em>${ch.done} / ${ch.total}</em></h4><ul>` +
      ch.listed.map((a) => {
        const rec = unlocked[a.id];
        return `<li class="${rec ? "done" : "todo"}${a.kind !== "skill" ? " " + a.kind : ""}"><b>${a.name}</b><span>${a.desc}</span>` +
          (rec ? `<small>${when(rec)}</small>` : "") + `</li>`;
      }).join("") +
      (ch.hidden ? `<li class="hidden"><span>and ${ch.hidden} more, unannounced</span></li>` : "") +
      `</ul>`).join("");
  };
  achBtn.addEventListener("click", () => { renderBook(loadMeta().achievements || {}); achSheet.classList.add("on"); });
  document.getElementById("btnAchClose").addEventListener("click", () => achSheet.classList.remove("on"));
  /* `?achprobe=1` — the book with a spread of marks in it, for the shots */
  if (params.get("achprobe") === "1") {
    const fake = {};
    for (const id of ["pull-in", "ten-km", "five-stops", "the-zone", "sideways", "airborne", "one-sixty", "crossed-a-border",
      "something-bolted-on", "the-northern-lights", "odd-one-this", "that-tree-again", "spectators", "on-camera", "ten-in-the-dark"]) {
      fake[id] = { at: Date.now(), seed: "FROST-LOON-30", km: 14.2 };
    }
    achBtn.style.display = "block";
    renderBook(fake);
    achSheet.classList.add("on");
  }

  /* (The "set out at dusk" start is gone: night is earned by driving into
   * it, not picked from the title. Every journey starts mid-morning.) */

  /* THE SWEEP, a mode of its own beside the Drive (owner, 2026-08-31:
   * "elevated to the same level as a standard drive, not a side mode").
   * Its own plate, always offered, started directly. The bible's "never
   * the default" still holds: the Drive is the left plate and Enter on
   * the time card starts a Drive; "never advertised mid-run" is untouched. */
  const sweepBtn = document.getElementById("btnSweep");
  if (sweepBtn) sweepBtn.addEventListener("click", () => { G.sweepOut = true; leaveAttract(); startRun(null); });

  /* the wrong device gets a kind, immediate explanation — never a broken
   * title. `any-pointer: fine` cannot see a paired keyboard or pad, so
   * the door stays openable. `?deviceprobe=1` forces it for the shots. */
  const touchOnly = window.matchMedia
    && matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
  if (!BOT && (touchOnly || params.get("deviceprobe") === "1")) {
    document.getElementById("wrongDevice").classList.add("on");
    document.getElementById("btnDeviceGo").addEventListener("click", () =>
      document.getElementById("wrongDevice").classList.remove("on"));
  }

  /* `?titleprobe=1` — every optional plate up at once (resume, postcards,
   * the Sweep) on a fresh profile, so the title's full layout can be
   * screenshotted without first earning it */
  if (params.get("titleprobe") === "1") {
    els.btnResume.style.display = "block";
    els.btnResume.textContent = "Resume journey: FROST-LOON-30, waystation 3";
    galBtn.style.display = "block";
    if (sweepBtn) sweepBtn.style.display = "block";
  }

  if (BOT) {
    startRun(null);
  } else {
    // attract mode: the game drives itself behind the title sheet
    G.attract = true;
    document.body.classList.add("attract");
    startRun(null);
    els.title.classList.add("on");
  }

  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------ run setup */

function startRun(saved) {
  const typed = G.attract ? "" : els.seedInput.value.trim();
  G.seedStr = saved ? saved.seedStr : (typed || seedName((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0));
  G.seed = seedFromString(G.seedStr);
  G.choices = saved ? saved.choices.slice() : [];
  G.cardIds = saved && saved.cardIds ? saved.cardIds.slice() : [];
  /* The departure ledger (Addendum I): the flow tier the player left each
   * waystation with, recorded beside the route choice — the director reads
   * it, and a resumed run replays the same lean. depFlow[k] belongs to
   * choice k (the departure that starts leg k+1); an old save simply has
   * none, which the plan treats as neutral — exactly what its legs were. */
  G.depFlow = saved && saved.depFlow ? saved.depFlow.slice() : [];
  /* THE ROUTE LEDGER (Phase 25): the build's appetite at the moment each
   * leg's routes were dealt — {len, crest, jump, lake} multipliers from the
   * deck souvenirs — recorded per leg exactly like depFlow, so a resumed run
   * replays the deal the player actually saw rather than one leaned by
   * souvenirs taken later. routeMods[k] belongs to the deal at legIndex k;
   * an old save has none, and its legs were dealt with no lean anyway. */
  G.routeMods = saved && saved.routeMods ? saved.routeMods.slice() : [];
  /* THE SWEEP (Addendum I): opt-in from the title (or `?sweep=1`), never
   * the default, never in attract — and a saved Sweep resumes as one. The
   * mode is fixed for the run and rides the save like every other choice. */
  G.sweep = !G.attract && (saved ? saved.mode === "sweep" : (!!G.sweepOut || params.get("sweep") === "1"));
  G.split = null;

  els.title.classList.remove("on");
  audio.initAudio();
  audio.musicInit(G.seed);   // reseeded per run: a journey keeps its melody

  // world, then the run/build (souvenirs can change what routes are offered,
  // so the build must exist before route choices are replayed for a resume)
  G.world = makeWorld(G.seed, {
    biome: params.get("biome") || undefined, startRegion: params.get("region") || undefined,
    forceEvent: FORCE_EV || undefined, forceStrange: params.get("strange") === "1" || undefined,
    // `?leg1=400` — a waystation almost immediately (the bible's "force a
    // waystation" debug tool: card/route UI without ten minutes of driving)
    firstLegLen: params.has("leg1") ? Math.max(300, parseFloat(params.get("leg1")) || 0) : undefined,
    plan: (legIndex, danger) => legPlan(G.seed, legIndex, danger, legIndex > 0 ? G.depFlow[legIndex - 1] : null),
  });
  G.world.setFirstRoute(OPENER);
  if (G.chunks) G.chunks.dispose();
  G.chunks = makeChunks(G.world, G.kit, G.world.biome);
  // a fresh chunk kit starts at the quality ladder's current tier
  applyQuality(currentTier());
  /* Dev overlay (?debug=1, key V): road spline, collider circles, pace-note
   * posts — the bible's own debug-tool list, drawn over the real world. */
  if (G.dev) { G.dev.dispose(); G.dev = null; }
  if (DEBUG) G.dev = makeDevLines(G.kit, G.world);
  G.world.ensure(0);

  G.car = makeCar();
  G.bus = makeBus();
  G.run = makeRun(G.world, G.car, G.bus);
  G.run.on("arrived", onArrived);
  G.run.on("over", onOver);
  G.postcards = makePostcardBook(G.world, { onFound: () => { if (G.ach) G.ach.event("postcard", {}); } });
  // a resumed journey keeps its diary — the cards ride the run save
  if (saved && saved.postcards) G.postcards.restore(saved.postcards);
  if (saved) G.run.R.postcardsN = G.postcards.found.length;   // the Flower keeps its press
  // the journey record: the line of the route and the countries crossed
  G.path = saved && saved.path ? saved.path.slice() : [];
  G.pathS = -1e9;
  G.kmBy = saved && saved.kmBy ? Object.assign({}, saved.kmBy) : {};
  G.lifeMeta = null;   // re-read the lifetime diary each run
  G._statS = null;
  G.countries = new Set(saved && saved.countries ? saved.countries : []);
  G.build = makeBuild(G.bus, G.run, G.car, G.world);
  G.run.setBuild(G.build);
  G.bus.on("boostStart", () => { if (!G.attract) audio.sfxBoostStart(); });
  /* the music hears the run: its stingers land on the grid (music.js cue) */
  for (const n of ["landed", "collision", "grace", "driftStart", "driftEnd", "border", "waystation", "legStart", "boostStart", "boostEnd", "flowTier", "rollover"]) {
    G.bus.on(n, (d) => { if (!G.attract) audio.musicCue(n, d); });
  }
  /* THE MARSHALS' BOOK (owner, 2026-08-31: achievements). A journey's
   * ledger rides the run save; unlocks persist the moment they land. The
   * attract loop earns nothing (the road driving itself is not you), and a
   * bot run keeps its book in memory so the screenshots never pollute the
   * profile. Read-only against the sim: the book never feeds back. */
  G.ach = null;
  G.achQueue = [];
  G.achT = 0; G.achShowT = 0; G.wsRealT = 0; G.wsRealAcc = 0;
  if (els.achToast) els.achToast.classList.remove("on");
  if (!G.attract) {
    const memStore = { m: loadMeta(), load() { return this.m; }, save(m) { this.m = m; } };
    G.ach = makeAchievements({
      store: BOT ? memStore : { load: loadMeta, save: saveMeta },
      seed: G.seedStr,
      restore: saved && saved.ach ? saved.ach : null,
      onUnlock: (def) => { G.achQueue.push(def); },
    });
    for (const n of ["driftStart", "driftSwitch", "driftEnd", "cornerDone", "handbrake", "landed", "collision", "nearMiss",
      "pickup", "blowOff", "grace", "legStart", "waystation", "eventEnter", "border", "rollover", "settled",
      "incident", "rescue", "marshalled", "shot"]) {
      G.bus.on(n, (d) => { if (G.ach) G.ach.event(n, d); });
    }
  }
  G.logSeen = 0;
  for (const id of G.cardIds) { const d = findDef(id); if (d) G.build.add(d); }
  // `?build=id,id,...` — equip souvenirs from the URL (debug: the bible's
  // "force a souvenir"; also how the bolt-on dressing gets screenshotted)
  if (params.get("build")) {
    for (const id of params.get("build").split(",")) {
      const d = findDef(id.trim());
      if (d && !G.build.ids().includes(d.id)) G.build.add(d);
    }
  }
  G.legsInBiome = 1; G.transitionSpoken = -1; G.biomeAnnounced = G.world.biome.key;
  for (const c of G.choices) {
    let guard = 0;
    while (!G.world.hold && guard++ < 200) G.world.ensure(G.world.frontierS());
    const offered = offeredRoutes();
    takeRoute(offered[c] || offered[0]);
  }

  // sky & weather (ticked in sim time so wetness stays deterministic)
  const force = FORCE_W === "rain" ? { overcast: 0.9, rain: 0.85, fog: 0.1 }
    : FORCE_W === "fog" ? { overcast: 0.3, rain: 0, fog: 0.9 }
    : FORCE_W === "overcast" ? { overcast: 0.9, rain: 0, fog: 0 }
    : FORCE_W === "clear" ? { overcast: 0, rain: 0, fog: 0 } : null;
  G.atmo = makeAtmosphere(G.seed, (s) => G.world.biomeAt(s).biome, {
    startU: saved && saved.dayU != null ? saved.dayU : (START_U != null ? START_U : G.attract ? 0.745 : 0.335),
    force,
    // the director's per-leg weather arc leans the fronts
    arc: () => (G.world.legPlan ? G.world.legPlan.arc : null),
    /* Aim a long night at the sunrise (Phase 12's leftover): in deep night
     * the clock leans so dawn lands near the END of the current leg — the
     * pull-in happens as the sky lifts, which is the bible's "surviving
     * the night should feel like completing part of a journey". A clamped
     * lean, never a time-lapse; a pure function of sim state, so a resumed
     * run recomputes exactly the same aim. */
    pace: (u) => {
      if (!(u > 0.88 || u < 0.16)) return 1;
      const rem = (G.world && G.world.legEndS || 0) - (G.car ? G.car.s : 0);
      if (!(rem > 400)) return 1;
      const du = (0.24 - u + 1) % 1;
      const T = rem / 30;                    // the leg ahead at touring pace
      const want = (du * DAY_SECONDS) / Math.max(60, T) / 1.35;
      return Math.max(0.85, Math.min(1.6, want));
    },
  });
  if (saved) { G.atmo.A.wetness = saved.wetness || 0; }
  G.celestial = makeCelestial(G.seed, { force: FORCE_SKY || undefined });
  if (!G.effects) G.effects = makeEffects(G.kit);
  if (!G.parts) G.parts = makeParticles(G.kit);
  G.parts.clear();
  applyQuality(currentTier());   // effects + particles are live now: clouds and dust take the tier
  G.wsGlideU = 0; G.wsClock = null;   // no half hour left over from a previous journey
  G.weatherCalled = 0;

  if (saved) {
    // regenerate up to the waystation we stopped at, park there
    let guard = 0;
    while (!G.world.hold && guard++ < 200) G.world.ensure(G.world.frontierS());
    const ws = G.world.waystations[G.world.waystations.length - 1];
    Object.assign(G.run.R, {
      dist: saved.dist, score: saved.score, time: saved.time, driveTime: saved.driveTime,
      topSpeed: saved.topSpeed, longestAir: saved.longestAir, hits: saved.hits,
      longestDrift: saved.longestDrift || 0,
      airAt: saved.airAt || 0, driftAt: saved.driftAt || 0, topAt: saved.topAt || 0,
      /* wsIndex, not +1: the re-captured arrival below runs the whole
       * arrival path again, waystations++ included — the visit being
       * re-entered was already counted when it was saved */
      waystations: saved.wsIndex, legIndex: G.world.legIndex, lastWs: ws.index - 1,
      /* tier is DERIVED state and only recomputed while driving — restore
       * it from the restored flow or a resumed waystation sits at tier 0:
       * wrong music at the stop, and the departure would record tier 0
       * into the ledger where the driven run recorded the real one (the
       * resume audit caught exactly this) */
      flow: saved.flow || 0, tier: G.run.tierOf(saved.flow || 0), boost: saved.boost || 25,
      // grace rides the save; an old save resumes unarmed but ready to climb
      graceArmed: !!saved.grace, graceLow: saved.graceLow != null ? !!saved.graceLow : true,
      nightDist: saved.nightDist || 0, rainDist: saved.rainDist || 0,
      climb: saved.climb || 0, descent: saved.descent || 0, cleanBest: saved.cleanBest || 0,
      pickups: saved.pickups || 0, coldDist: saved.coldDist || 0,
      savesUsed: saved.savesUsed || 0, savesBanked: saved.savesBanked || 0,
      incidents: saved.incidents || 0, rolls: saved.rolls || 0, rescues: saved.rescues || 0,
    });
    G.car.damage = saved.damage || 0;
    // the car resumes looking and driving the way it left
    G.car.mud = saved.mud || 0; G.car.mudWet = saved.mudWet || 0;
    G.car.mudW = saved.mudW || [0, 0, 0, 0];
    G.car.pullDir = saved.pullDir || 0; G.car.softW = saved.softW != null ? saved.softW : -1;
    G.run.R.state = "arriving"; G.run.R.ws = ws;
    G.run.R.arriveT = 99;                // capture immediately on first tick
    G.car.s = saved.parkS != null ? saved.parkS : ws.s + 4;
    const smp = G.world.sampleNear(G.car.s);
    G.car.x = smp.x; G.car.z = smp.z; G.car.y = smp.y; G.car.yaw = smp.heading;
    // the path already ends here — don't stamp a duplicate point on resume
    G.pathS = G.car.s;
    // the re-captured arrival is the same visit, not a second service
    G.resumedWs = ws.index;
  } else {
    G.resumedWs = -1;
    const start = G.world.sampleNear(10);
    G.car.x = start.x; G.car.z = start.z; G.car.y = start.y;
    G.car.yaw = start.heading; G.car.s = start.s;
  }
  /* the sweep car takes the road: a fresh Sweep starts it 1200 m back —
   * about forty seconds on the opening tarmac, so the first leg breathes
   * before the contract tightens — and a resumed one exactly where the
   * save left it */
  if (G.sweep) {
    G.run.R.sweepOn = true;
    // `?sweepgap=80` seats the sweep car that close for a look at it
    G.run.R.sweepS = saved && saved.sweepS != null ? saved.sweepS : G.car.s - (params.has("sweepgap") ? Math.max(10, parseFloat(params.get("sweepgap")) || 0) : 1200);
    G.run.R.sweepBankS = saved && saved.sweepBank != null ? saved.sweepBank : 0;
  }

  if (!G.kestrel) {
    G.kestrel = buildKestrel();
    G.kit.scene.add(G.kestrel.root, G.kestrel.shadow);
  }
  // the sweep car (render-only): built once, shown only in a Sweep
  if (!G.sweepCar) {
    G.sweepCar = buildSweepCar();
    G.kit.scene.add(G.sweepCar.root);
  }
  G.sweepCar.root.visible = false;
  if (!G.tripod) {
    // the crew's tripod: parked at a cut's seat while the shot lives
    G.tripod = buildTripod();
    G.tripod.visible = false;
    G.kit.scene.add(G.tripod);
  }
  // the build worn on the body — fresh run resets to stock, resume re-dresses
  applyBuild(G.kestrel, G.build.ids());
  /* `?dmg=N` / `?mud=M` — jump straight to a battle-worn car. The damage
   * states are exactly the kind of rare-by-progression content that never
   * gets looked at if reaching it takes half an hour of crashing. */
  if (params.has("dmg")) {
    G.car.damage = Math.min(145, parseFloat(params.get("dmg")) || 0);
    G.car.pullDir = 1; G.car.softW = 1;
  }
  if (params.has("mud")) {
    G.car.mud = Math.min(1, parseFloat(params.get("mud")) || 0);
    G.car.mudW = [G.car.mud, G.car.mud * 0.4, G.car.mud, G.car.mud * 0.55];
    if (FORCE_W === "rain") G.car.mudWet = 1;
  }
  G.cam = makeChaseCam(G.kit.camera, G.world);
  G.cam.setMode(saved ? "orbit" : "chase");
  G.codriver = makeCodriver(G.world, {
    speak: (text, urgent) => { audio.speak(text, urgent); G.hud.subtitle(text, 3.4); },
    // the book counts the calls (the thousandth "over crest" is a real number)
    onCall: ({ text }) => { if (G.ach) G.ach.event("call", { text }); },
    /* a remark is also a build event — the Shared Thermos listens for the
     * warmth. Sim-deterministic: occasion runs on the sim tick. */
    remark: (text) => { audio.speak(text, false); G.hud.subtitle(text, 2.2); if (G.build) G.build.emit("remark", {}); if (G.ach) G.ach.event("remark", { text }); },
    timing: G.settings.timing,
    verbosity: G.settings.verbosity,
  });
  /* GRACE fired (Addendum I): the music falls away on its own — flow just
   * collapsed — and the codriver says the words. That pair IS the display;
   * no toast, no flash, nothing explained. */
  G.bus.on("grace", () => { if (!G.attract && G.codriver) G.codriver.moment("grace"); });
  /* THE THREE ENDS: the car goes over; an incident is answered (or not); the
   * rescue lands. The messages say what happened; the codriver says how it
   * feels; the summary says what it cost. */
  G.bus.on("rollover", () => {
    if (G.attract) return;
    G.hud.message("ROLLED", 1.6);
    if (G.codriver) G.codriver.moment("rolled");
    if (G.input && G.input.rumble) G.input.rumble(0.8, 0.9, 500);
  });
  G.bus.on("incident", ({ kind, helped, free, savesLeft }) => {
    if (G.attract) return;
    const what = kind === "roof" ? "ON THE ROOF" : kind === "water" ? "IN THE WATER" : kind === "fall" ? "OVER THE EDGE" : "STUCK";
    const left = savesLeft != null ? savesLeft : G.run.R.savesLeft;
    const saves = `${left} save${left === 1 ? "" : "s"} left`;
    G.hud.message(helped ? `${what}: ${free ? "the car answers" : kind === "roof" ? `spectators push (${saves})` : `a tow (${saves})`}` : `${what}: NO SAVES`, 3);
    if (G.codriver) G.codriver.moment(!helped ? "noHelp" : kind === "roof" ? "roof" : "tow");
  });
  G.bus.on("saveEarned", () => {
    if (G.attract) return;
    G.hud.message("A SAVE EARNED", 2.6);
    if (G.codriver) G.codriver.moment("saveEarned");
  });
  G.bus.on("rescue", ({ free }) => {
    if (G.attract) return;
    G.hud.message(free ? "BACK ON THE ROAD, NO CHARGE" : "BACK ON THE ROAD", 2);
    if (G.codriver) G.codriver.moment("rescued");
  });
  G.cam.state.reducedMotion = G.settings.motion === "reduced";
  // camera comfort rides the settings; a fresh cam starts where they are
  G.cam.state.distK = G.settings.camDist === "close" ? 0.86 : G.settings.camDist === "far" ? 1.35 : 1;
  G.cam.state.upK = G.settings.camDist === "close" ? 0.92 : G.settings.camDist === "far" ? 1.45 : 1;
  G.cam.state.fovCap = G.settings.fovCap === "on";
  G.cam.state.cutsOn = G.settings.camCuts !== "off";
  G.cam.state.album.length = 0;   // a fresh run starts a fresh roll of film
  // `?cut=1` — skip the cooldown and the dice so the first safe straight
  // cuts to a trackside camera (screenshots of a rare thing)
  G.cam.state.cutForce = params.get("cut") || null;
  // fast-forward: synchronously simulate FF seconds of self-drive
  if (FF > 0 && !saved) {
    const ticks = Math.round(FF / DT);
    let wait = 0;
    for (let t = 0; t < ticks; t++) {
      if (t % 60 === 0) G.world.ensure(G.car.s);
      simTick(botInput(G.car, G.world, 0.9), true);
      if (G.run.R.state === "waystation") {
        if (SHOWWS) break;
        if (++wait > 120 * 6) { botDepart(); wait = 0; }   // linger a moment, as the player would
      }
    }
    G.chunks.fill(G.car.s, 2500);
    for (let i = 0; i < 80; i++) G.chunks.update(G.car.s);
    if (SHOWWS && G.run.R.state === "waystation") openWaystation();
  }

  /* `?to=bridge|tunnel|<metres>` — drive there and stop looking.
   *
   * Rare-by-design content is impossible to iterate on if reaching it
   * takes ten minutes of driving: the bible asks for debug teleports, and
   * this is the cheapest honest version — the bot really drives the road,
   * so what you arrive at is what a player would have arrived at. */
  if (GOTO && !saved) {
    const wantOver = GOTO === "overpass";
    const wantKind = GOTO === "bridge" || wantOver ? -1 : GOTO === "tunnel" ? 1 : 0;
    const wantS = wantKind ? Infinity : parseFloat(GOTO) || 0;
    let wait = 0;
    for (let t = 0; t < 120 * 60 * 25; t++) {
      if (t % 60 === 0) G.world.ensure(G.car.s);
      simTick(botInput(G.car, G.world, 0.9), true);
      if (G.run.R.state === "waystation") { if (++wait > 60) { botDepart(); wait = 0; } continue; }
      if (wantKind) {
        const sp = G.world.spanAt(G.car.s + 55);
        if (sp && sp.kind === wantKind && (!wantOver || sp.over)) break;
      } else if (G.car.s >= wantS) break;
    }
    G.chunks.fill(G.car.s, 2500);
    for (let i = 0; i < 320; i++) G.chunks.update(G.car.s);
  }
  // `?cam=high` — a lifted, pulled-back view for judging structures
  if (params.get("cam") === "high") G.cam.setMode("high");
  // `?camd=9&camu=3&cams=5` — the high view's distance/height/side, for
  // close-ups of the car (the bolt-ons) without a hand on the mouse
  if (params.has("camd")) G.cam.state.highDist = parseFloat(params.get("camd")) || 34;
  if (params.has("camu")) G.cam.state.highUp = parseFloat(params.get("camu")) || 20;
  if (params.has("cams")) G.cam.state.highSide = parseFloat(params.get("cams")) || 16;
  // `?bp=1` — open the build panel from the start (debug/screenshots)
  if (params.get("bp") === "1") { G.bpOpen = true; document.getElementById("buildPanel").classList.add("on"); }
  /* `?end=1` — park where the fast-forward left you and show the summary.
   * The journey record is the one screen you cannot reach in under ten
   * minutes of real driving, which is exactly the kind of thing that then
   * never gets looked at. */
  if (END_AFTER && G.run && !G.run.R.over) G.run.endRun("parked");

  /* the hole rule: the blanket and the shell are whole before the first
   * frame is drawn — the old 1-cell-per-frame trickle opened on a run's
   * first second (attract included, which is the title's backdrop) */
  G.chunks.fill(G.car.s, 2500);
  G.running = true;
  G.paused = false;
  G.accum = 0;
  G.lastT = performance.now();
  G.hud.showMeters(true);
  // `?quiet=1`: no boot banner — for screenshots that frame the game itself
  if (!saved && !G.attract && params.get("quiet") !== "1") G.hud.message(BOT ? "SELF-DRIVE, SEED " + G.seedStr : "SEED " + G.seedStr, 4);
  // `?pauseprobe=1` — the settings sheet up over the drive, for the shots
  if (params.get("pauseprobe") === "1" && !G.attract) setTimeout(() => { G.paused = true; G.pauseUI.show(); }, 600);
  if (!G.attract) history.replaceState(null, "", "?seed=" + encodeURIComponent(G.seedStr) + (BOT ? "&bot=1" : "") + (DEBUG ? "&debug=1" : ""));
  if (!saved && !BOT && !G.attract) setTimeout(() => G.codriver && audio.speak("okay. home road. easy to start", false), 900);
}

/* The title's live line: what the car behind the title is really doing —
 * the country, the region, the clock, the speed. Honest by construction:
 * it reads the same state the HUD would. */
function updateTitleLive() {
  const el = document.getElementById("titleLive");
  if (!el || !G.world || !G.atmo || !G.car || !G.run) return;
  const hb = G.world.hereBiome, hr = G.world.hereRegion;
  const country = hb ? (hb.t < 0.5 && hb.prev ? hb.prev : hb.biome).name : "";
  const rg = hr && hr.region ? (hr.t < 0.5 && hr.prev ? hr.prev : hr.region) : null;
  const region = rg && rg.name ? rg.name : "";
  const clock = clockOf(G.atmo.A.u);
  const R = G.run.R;
  const doing = R.over ? "" : R.state === "waystation" ? "at the waystation" : Math.round(Math.abs(G.car.vx) * 3.6) + " km/h";
  const parts = [`<b>${country}</b>`];
  if (region) parts.push(region);
  parts.push(clock);
  if (doing) parts.push(doing);
  parts.push("the road drives itself");
  const html = parts.join(" · ");
  if (el.innerHTML !== html) el.innerHTML = html;
}

/* ------------------------------------------------------- waystation flow */

/* The routes on offer at the current waystation — one code path for the
 * live game and for replaying a save, so both agree. */
function offeredRoutes() {
  const avoid = G.world.route ? G.world.route.key : null;
  /* the deck's route half, stamped into the ledger the first time this
   * leg's routes are dealt (live: the build as it stands when the sheet
   * opens; replay: whatever was recorded) — see G.routeMods */
  const k = G.world.legIndex;
  if (!G.routeMods[k]) {
    const rm = G.build.runMods;
    G.routeMods[k] = { len: rm.routeLen, crest: rm.routeCrest, jump: rm.routeJump, lake: rm.routeLake };
  }
  const routes = routesFor(G.seed, k, G.build.runMods.extraRoutes, avoid, G.routeMods[k]);
  assignBiomes(G.seed, G.world.legIndex, G.world.biome.key, G.legsInBiome, routes);
  // one quiet marker on a card the build would enjoy; never an explanation
  return markSuitedRoutes(routes, G.build.B.souvenirs.map((s) => s.def));
}

/* Commit a route: world switches country if needed; track how long we stay. */
function takeRoute(route) {
  const wasKey = G.world.biome.key;
  G.world.chooseRoute(route);
  G.legsInBiome = G.world.biome.key === wasKey ? G.legsInBiome + 1 : 1;
}

/* the world's clock, the way a dashboard reads it */
function clockOf(u) {
  u = ((u % 1) + 1) % 1;
  const hh = Math.floor(u * 24), mm = Math.floor((u * 24 - hh) * 60);
  return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

/* the stop takes half an hour of the world's clock (owner: waystations
 * teleport you thirty minutes into the future) */
const WS_HALF_HOUR = 0.5 / 24;

function onArrived(ws) {
  G.cam.setMode("orbit");
  G.wsTimer = SHOWWS ? 0 : (BOT || G.attract) ? 1.4 : 1.6;
  G.wsOpen = false;
  if (!G.attract) audio.speak("waystation", false);
  if (G.attract) return;
  /* quick service: every waystation tightens what rattled loose — unless
   * this arrival is a resume re-entering the SAME visit: that service
   * already happened before the save was written, and save→resume must
   * not be a free mechanic (a loop of it would heal the car to full) */
  if (G.resumedWs !== ws.index) {
    G.run.repair(15);
    /* the half hour GLIDES over a few parked seconds (simTick advances
     * it in sim time) so evening falls across the shed instead of
     * snapping — but the save below records the landed clock, so a
     * resume re-enters the visit with the service and its half hour
     * already done, exactly like the repair above */
    G.wsClock = { arr: G.atmo.A.u, dep: (G.atmo.A.u + WS_HALF_HOUR) % 1 };
    G.wsGlideU = (G.wsGlideU || 0) + WS_HALF_HOUR;
  } else {
    // a resumed visit: the clock already landed before the save was written
    G.wsClock = { arr: G.atmo.A.u, dep: G.atmo.A.u };
  }
  G.resumedWs = -1;
  // autosave: seed + choices + stats
  const R = G.run.R;
  saveRun({
    seedStr: G.seedStr, choices: G.choices, cardIds: G.cardIds, wsIndex: ws.index,
    // the landed clock: any half hour still gliding is already in the save
    dayU: (G.atmo.A.u + (G.wsGlideU || 0)) % 1, wetness: G.atmo.A.wetness,
    dist: R.dist, score: R.score, time: R.time, driveTime: R.driveTime,
    topSpeed: R.topSpeed, longestAir: R.longestAir, hits: R.hits,
    longestDrift: R.longestDrift, airAt: R.airAt, driftAt: R.driftAt, topAt: R.topAt,
    flow: R.flow, boost: R.boost, damage: G.car.damage,
    depFlow: G.depFlow, grace: R.graceArmed, graceLow: R.graceLow,
    // sweep-mode runs carry the contract and the pursuer's exact position
    ...(G.sweep ? { mode: "sweep", sweepS: R.sweepS, sweepBank: R.sweepBankS } : {}),
    mud: G.car.mud, mudWet: G.car.mudWet, mudW: G.car.mudW,
    pullDir: G.car.pullDir, softW: G.car.softW,
    /* where the car actually parked: a resume seats it THERE, so the next
     * leg replays from the same metre — the sweep audit caught the old
     * ws.s+4 seat giving a resumed run a few metres' different take-off */
    parkS: G.car.s,
    nightDist: R.nightDist, rainDist: R.rainDist, climb: R.climb, descent: R.descent,
    pickups: R.pickups || 0, kmBy: G.kmBy, coldDist: R.coldDist || 0,
    // the route ledger (Phase 25) rides beside the departure ledger
    routeMods: G.routeMods,
    // the three ends: saves spent and banked, and the incident ledger
    savesUsed: R.savesUsed || 0, savesBanked: R.savesBanked || 0,
    incidents: R.incidents || 0, rolls: R.rolls || 0, rescues: R.rescues || 0,
    cleanBest: Math.max(R.cleanBest, R.cleanCur), countries: [...G.countries],
    // the diary rides along: a postcard must survive a resume
    postcards: G.postcards ? G.postcards.found : [],
    // the route line, thinned so a very long journey stays a small save
    path: G.path.length > 1600 ? G.path.filter((_, i) => i % 2 === 0) : G.path,
    // the marshals' book: this journey's ledger (a resume must not forget a near miss)
    ach: G.ach ? G.ach.J : undefined,
  });
  G.wsRealT = 0;
}

/* What the journey has DONE so far — the key to the gated shelf. Souvenirs
 * may declare appearIf(stats); they never show up in offers before the run
 * has earned them, and nothing ever says so. */
function journeyStats() {
  const R = G.run.R;
  /* The lifetime half: the heirloom souvenirs read the whole diary, not
   * just this run — the bible's between-run progression, held to its
   * restraint rule (additive content, never numbers, never announced). */
  const m = G.lifeMeta || (G.lifeMeta = loadMeta());
  return {
    dist: R.dist || 0, nightDist: R.nightDist || 0, rainDist: R.rainDist || 0,
    coldDist: R.coldDist || 0, mode: G.sweep ? "sweep" : "drive",
    climb: R.climb || 0, countries: G.countries ? G.countries.size : 1,
    lifeKm: (m.totalDist || 0) / 1000,
    countriesEver: (m.countriesEver || []).length,
    postcardsEver: (m.postcards || []).length,
    journeys: m.runs || 0,
  };
}

function openWaystation() {
  G.wsOpen = true;
  const R = G.run.R;
  const ws = R.ws;
  const rm = G.build.runMods;
  const routes = offeredRoutes();
  /* a strange outpost keeps a better shelf: one more card, rarer stock —
   * the reward for pulling in at the odd one is never explained, only felt */
  const strange = G.world.waystations[ws.index] && G.world.waystations[ws.index].strange;
  /* the Sweep: time in hand is worth something — a fat margin at arrival
   * means the mechanics had time to dig out the good crate (the existing
   * luck machinery, given its second reason to live). Deterministic on
   * resume: the margin recomputes from the saved sweep position. */
  const margin = G.sweep ? Math.max(0, R.sweepBankS || 0) : 0;
  const luck = Math.min(1.5, (G.world.route && G.world.route.danger >= 3 ? 0.55 : 0.1) + Math.min(0.5, ws.index * 0.05)
    + rm.luckBonus + (strange ? 0.55 : 0) + Math.min(0.4, margin / 300));
  const cardR = rng(hashCombine(G.seed, 0xca4d + ws.index * 17));
  const cards = offerCards(cardR, G.build.ids(), Math.max(1, 3 + rm.extraCards + (strange ? 1 : 0)), luck, R.condition, journeyStats(),
    G.sweep ? "sweep" : "drive", { serviceAlways: rm.serviceAlways, noCommons: rm.noCommons });
  /* SYNERGY: a card that touches something owned gets a marker — a
   * marker, not an explanation. Protect the "ohhhh". */
  const ownedTags = new Set();
  for (const sv of G.build.B.souvenirs) for (const t of sv.def.tags || []) ownedTags.add(t);
  for (const c of cards) c.syn = c.kind === "souvenir" && (c.tags || []).some((t) => ownedTags.has(t));
  const buildDefs = G.build.B.souvenirs.map((s) => s.def).concat(G.build.B.parts.map((p) => p.def));
  /* `?showws=routes`: advance to the route stage the way a player does —
   * a real click on the first card after the sheet opens, so a screenshot
   * shows real state (the tulips are unreachable by URL otherwise) */
  if (SHOWWS && params.get("showws") === "routes") {
    setTimeout(() => {
      const c = document.querySelector("#wsCards .card");
      if (c) c.click();
    }, 0);
  }
  /* the spec sheet (owner: "read all your current stats — grip, roll%,
   * etc"): the build's folded physics numbers against stock, plus every
   * run rule a souvenir has bent. Read here so the UI stays dumb. */
  const pctOf = (v) => { const d = Math.round((v - 1) * 100); return d === 0 ? "stock" : (d > 0 ? "+" : "") + d + "%"; };
  const bm = G.build.B.mods;
  const numbers = [
    ["Power", pctOf(bm.power)], ["Grip", pctOf(bm.grip)], ["Brakes", pctOf(bm.brake)],
    ["Aero drag", pctOf(bm.drag)], ["Off-road drag", pctOf(bm.offDrag)], ["Stability", pctOf(bm.stability)],
    ["Boost power", pctOf(bm.boostPower)], ["Damage taken", pctOf(bm.damageScale)],
    ["Landing force", pctOf(bm.landing)], ["Take-off kick", pctOf(bm.lift)],
    ["Roll resistance", pctOf(bm.rollResist)],
    ["Lands on wheels", Math.round((1 - Math.max(0, Math.min(1, 0.45 - (bm.landWheels || 0)))) * 100) + "%"],
  ];
  if (bm.slideCeiling > 0) numbers.push(["Slide leash", "+" + Math.round(bm.slideCeiling * 57.3) + "°"]);
  if (bm.airSteer > 0) numbers.push(["Air steer", "+" + bm.airSteer.toFixed(1)]);
  for (const [label, v] of [
    ["Flow gain", rm.flowGain], ["Flow decay", rm.flowDecay], ["Boost gain", rm.boostGain],
    ["Boost drain", rm.boostDrain], ["Repair", rm.repairMul], ["Impact cost", rm.impactFlowLoss],
    ["Pickup magnet", rm.pickupMagnet], ["Pickups laid", rm.pickupDensity], ["Route length", rm.routeLen],
  ]) if (v != null && v !== 1) numbers.push([label, pctOf(v)]);
  if (rm.luckBonus) numbers.push(["Luck", "+" + rm.luckBonus.toFixed(2)]);
  if (rm.extraRoutes) numbers.push(["Extra routes", "+" + rm.extraRoutes]);
  if (rm.extraCards) numbers.push(["Extra cards", "+" + rm.extraCards]);
  if (rm.hitCap < Infinity) numbers.push(["Dent cap", String(rm.hitCap)]);
  if (rm.autoBoost) numbers.push(["Auto boost", "on"]);
  G.wsui.show({
    index: ws.index,
    name: waystationName(ws.index, hash32(G.seed) % 1000),
    dist: R.dist, score: R.score, cond: R.condition, saves: R.savesLeft,
    /* the logbook clock: arrival → departure when the half hour is real,
     * one time when a resume re-enters a visit already served */
    // the Sweep's pace for the leg ahead, as a share of the road's own
    // (the climb, made visible: the number the build has to beat)
    sweep: G.sweep ? Math.round(sweepFactor(G.world.legPlan, R.legIndex) * 100) + "%" : null,
    time: G.wsClock && Math.abs(G.wsClock.dep - G.wsClock.arr) > 1e-6
      ? clockOf(G.wsClock.arr) + " → " + clockOf(G.wsClock.dep)
      : clockOf(G.wsClock ? G.wsClock.dep : G.atmo.A.u),
    numbers,
    note: R.condition >= 99
      ? "Quick service. Nothing to fix. She’s running sweet."
      : "Quick service. The mechanic tightens what rattled loose. Car +15%.",
    cards, routes, build: buildDefs, seedStr: G.seedStr,
    onCard: (i, def) => {
      if (def.kind === "service") {
        // a full service is also a wash and an alignment: the mud goes,
        // the pull goes, the soft corner is trued up
        G.run.repair(100);
        G.car.mud *= 0.08; G.car.mudWet = 0; G.car.mudW = [0, 0, 0, 0];
        G.car.pullDir = 0; G.car.softW = -1;
        G.hud.toast("Full service");
        if (G.ach) G.ach.event("service", {});
        return;
      }
      G.build.add(def);
      G.cardIds.push(def.id);
      buildDefs.push(def);
      applyBuild(G.kestrel, G.build.ids());
      G.hud.toast(def.name);
      if (G.ach) G.ach.event("card", { id: def.id, kind: def.kind, rarity: def.rarity, tags: def.tags || [] });
    },
    onNoCard: () => { if (G.ach) G.ach.event("declined", {}); },
    onRoute: (i, route) => departWith(i, route),
    onEnd: () => G.run.endRun("parked"),
  });
}

function departWith(i, route) {
  /* the director reads the departure: sampled once at the boundary, before
   * depart() nudges the meter — the tier you ARRIVED with and now leave on */
  G.depFlow[G.choices.length] = G.run.R.tier;
  G.choices.push(i);
  G.wsOpen = false;
  const wasKey = G.world.biome.key;
  // run.depart calls world.chooseRoute; keep our stay counter in step
  G.run.depart(route);
  G.legsInBiome = G.world.biome.key === wasKey ? G.legsInBiome + 1 : 1;
  G.world.ensure(G.car.s);
  G.chunks.fill(G.car.s, 160);
  G.cam.setMode("chase");
  G.hud.message(route.name.toUpperCase() + " · " + route.tag, 3.5);
  const km = (route.len / 1000).toFixed(1).replace(".0", "");
  const into = route.changes ? ` into ${route.biomeName}.` : "";
  if (!G.attract) setTimeout(() => audio.speak(`${route.name}. ${route.tag.toLowerCase()}. ${km} kilometres${into}`, false), 500);
  /* the Sweep's leg-start split, after the route line has had its say —
   * rounded the way a codriver rounds, never to the second */
  if (G.sweep && !G.attract) {
    const m = Math.max(0, Math.round(G.run.R.sweepBankS));
    const said = m >= 100 ? Math.round(m / 30) * 30 : Math.max(10, Math.round(m / 10) * 10);
    setTimeout(() => audio.speak(`${said} in hand`, false), 4600);
    G.split = null;   // a fresh leg re-arms the split lines
  }
}

function botDepart() {
  // the bot takes the first card too, so self-drive exercises souvenirs;
  // it prefers a route that changes country when one is offered
  const R = G.run.R;
  const cardR = rng(hashCombine(G.seed, 0xca4d + (R.ws ? R.ws.index : 0) * 17));
  const rm = G.build.runMods;
  const cards = offerCards(cardR, G.build.ids(), 3, 0.4, R.condition, journeyStats(), G.sweep ? "sweep" : "drive",
    { serviceAlways: rm.serviceAlways, noCommons: rm.noCommons });
  const pick = cards.find((c) => c.kind !== "service") || cards[0];
  if (pick && pick.kind !== "service") { G.build.add(pick); G.cardIds.push(pick.id); applyBuild(G.kestrel, G.build.ids()); }
  const routes = offeredRoutes();
  const idx = Math.max(0, routes.findIndex((r) => r.changes));
  departWith(idx, routes[idx]);
}

function onOver({ reason }) {
  if (G.attract) { setTimeout(() => { if (G.attract) startRun(null); }, 50); return; }   // the demo just starts over
  const R = G.run.R;
  clearRun();
  /* the book closes first: it reads the lifetime kilometres as "the diary
   * so far plus this journey", so it must settle before recordBest adds
   * this journey to the diary */
  const earnedIds = G.ach ? G.ach.journeyEnd(reason, achSnapshot(G.celestial.apply(G.atmo.snapshot()))) : [];
  recordBest({ dist: R.dist, score: R.score, waystations: R.waystations, countries: [...G.countries], mode: G.sweep ? "sweep" : "drive" });
  /* The journey's landmarks go into the lifetime gallery, and the summary
   * lists what THIS journey saw — three at most, because a list of nine
   * is an inventory and three is a story. */
  const cards = G.postcards ? G.postcards.found : [];
  if (cards.length) {
    const meta = loadMeta();
    meta.postcards = mergeGallery(meta.postcards, cards);
    saveMeta(meta);
  }
  G.cam.setMode("orbit");
  // collected: the sweep car rolls up just behind, where the orbit sees it
  if (reason === "swept" && G.sweepCar) R.sweepS = G.car.s - 7;
  /* Three moments, composed as sentences. Three is a story, nine is an
   * inventory — and each has a threshold, so a quiet journey gets quiet
   * prose rather than a participation trophy. */
  const moments = [];
  const kmAt = (m) => (m / 1000).toFixed(1);
  if (R.longestAir > 1.2) moments.push(`Somewhere around the ${kmAt(R.airAt)} km mark, the car flew for ${R.longestAir.toFixed(1)} seconds.`);
  if (R.longestDrift > 3) moments.push(`One slide, ${kmAt(R.driftAt)} km in, lasted ${R.longestDrift.toFixed(1)} seconds, and you kept it.`);
  const cleanB = Math.max(R.cleanBest, R.cleanCur);
  if (cleanB > 2500) moments.push(`${kmAt(cleanB)} km without touching a thing.`);
  if (R.topSpeed * 3.6 > 185) moments.push(`The needle touched ${Math.round(R.topSpeed * 3.6)} km/h, ${kmAt(R.topAt)} km in.`);
  if (R.dist > 3000 && R.nightDist / R.dist > 0.33) moments.push(`${Math.round((R.nightDist / R.dist) * 100)}% of the journey happened in the dark.`);
  if (R.dist > 3000 && R.rainDist / R.dist > 0.25) moments.push(`${kmAt(R.rainDist)} km of it fell in the rain.`);
  if (R.climb > 900) moments.push(`${Math.round(R.climb)} m of climbing, all told.`);
  // round the total first or 3:59.6 renders as "3:60"
  const totalS = Math.round(R.time);
  const mins = Math.floor(totalS / 60), secs = totalS % 60;
  /* how it ended, and the codriver's sign-off where there is one — caught
   * by the sweep is collected, kindly; the three ends end the same way */
  const ENDS = {
    wrecked: ["The car has had enough", "Wrecked", null],
    swept: ["The sweep car rolls up alongside", "Collected", "that's us. good drive"],
    rolled: ["The car is on its roof, and nobody is coming", "Rolled it", "that's us. she's on her roof."],
    drowned: ["The lake has the car now", "In the lake", "that's us. we're in the water."],
    fell: ["The road was up there somewhere", "Over the edge", "that's us. that was the edge."],
    stranded: ["Too far from any road, and nobody is coming", "Stranded", "nobody's coming. that's us."],
  };
  const end = ENDS[reason] || ["You park it here", "Journey’s end", null];
  if (end[2]) audio.speak(end[2], false);
  G.wsui.showSummary({
    over: end[0],
    title: end[1],
    stats: [
      ["Distance", (R.dist / 1000).toFixed(1) + " km"],
      ["Score", Math.round(R.score).toLocaleString()],
      ["Waystations", String(R.waystations)],
      ["Time", `${mins}:${String(secs).padStart(2, "0")}`],
      ["Top speed", Math.round(R.topSpeed * 3.6) + " km/h"],
      // where the kilometres happened, country by country
      ["Countries", (() => {
        const tally = Object.entries(G.kmBy || {}).filter(([, m]) => m > 100).sort((a, b) => b[1] - a[1]);
        if (tally.length > 1) return tally.map(([k, m]) => `${k} ${(m / 1000).toFixed(1)}`).join(" · ");
        return [...G.countries].join(", ") || G.world.biome.name;
      })()],
      ["Night / rain", `${(R.nightDist / 1000).toFixed(1)} / ${(R.rainDist / 1000).toFixed(1)} km`],
      ["Climb / drop", `${Math.round(R.climb)} / ${Math.round(R.descent)} m`],
      ["Longest clean", (Math.max(R.cleanBest, R.cleanCur) / 1000).toFixed(1) + " km"],
      ["Longest air", R.longestAir.toFixed(1) + " s"],
      ["Longest drift", R.longestDrift.toFixed(1) + " s"],
      ["Pickups", String(R.pickups || 0)],
      ["Hits", String(R.hits) + (R.rolls ? ` · rolled ${R.rolls}×` : "") + (R.rescues ? ` · rescued ${R.rescues}×` : "")],
      ["Souvenirs", G.build.B.souvenirs.map((s) => s.def.name).join(", ") || "none"],
      ["Seed", G.seedStr],
    ],
    seen: cards.map(describeCard),
    moments: moments.slice(0, 3),
    // the marshals' book: what this journey was marked for
    earned: earnedIds.map((id) => ACH_BY_ID[id]).filter(Boolean),
    // the crew's album: every cinematic cut the driver rode out, as stills
    album: (G.cam.state.album || []).map((a) => ({ kind: a.kind, km: (a.s / 1000).toFixed(1), img: a.img })),
    path: G.path,
    shareUrl: `https://quinnsavitt.com/games/overcrest/?seed=${encodeURIComponent(G.seedStr)}`,
    // everything the share-card image needs, composed here so the UI stays dumb
    card: {
      dist: R.dist, score: R.score, waystations: R.waystations,
      countries: [...G.countries].join(" · ") || G.world.biome.name,
      seed: G.seedStr, moment: moments[0] || "",
      wrecked: reason === "wrecked",
    },
    onAgain: () => { els.seedInput.value = ""; startRun(null); },
    onSame: () => { els.seedInput.value = G.seedStr; startRun(null); },
  });
}

/* Onboarding used to be six spoken teaching lines over the home road.
 * Removed by owner order (2026-08-26, "get rid of the weird intro
 * shpiel") — the opener leg IS the tutorial now: calm Heartland tarmac,
 * gear-grade calls that explain themselves by coming true, the title
 * keysheet for the keys. The road teaches; nobody lectures. */

/* --------------------------------------------------------- build panel
 * A key to peek at the rules: which souvenirs, how often each has fired,
 * what the numbers currently are, and what the game thinks you are
 * playing. Never modal — the car keeps driving underneath. */
const ROAD_NAMES = { flow: "FLOWING", tech: "TECHNICAL", fast: "FAST", crests: "CRESTS" };
function renderBuildPanel() {
  const defs = G.build.B.souvenirs.map((s) => s.def);
  const aff = buildAffinity(defs);
  const best = Object.entries(aff).sort((a, b) => b[1] - a[1])[0];
  document.getElementById("bpSpec").textContent =
    best && best[1] >= 2 ? ": driving like " + (ROAD_NAMES[best[0]] || best[0].toUpperCase()) : "";
  const rows = G.build.B.souvenirs.map((sv) =>
    `<div title="${(sv.def.rule || "").replace(/"/g, "&quot;")}">${sv.def.name}<i>${sv.def.on ? (sv.fires || 0) + "×" : "·"}</i></div>`
  ).concat(G.build.B.parts.map((p) => `<div class="part">${p.def.name}<i>part</i></div>`));
  document.getElementById("bpList").innerHTML = rows.join("") || `<div class="none">Stock Kestrel. Nothing bolted on yet.</div>`;
  // only the numbers the build has actually moved
  const m = G.build.mods, rm = G.build.runMods, out = [];
  for (const k in DEFAULT_MODS) {
    if (Math.abs(m[k] - DEFAULT_MODS[k]) > 0.005) out.push(`${k} ${m[k] > DEFAULT_MODS[k] && DEFAULT_MODS[k] !== 0 ? "×" : ""}${m[k].toFixed(2)}`);
  }
  for (const k in DEFAULT_RUNMODS) {
    const d = DEFAULT_RUNMODS[k], v = rm[k];
    if (v !== d && typeof v === "number" && isFinite(v)) out.push(`${k} ${v.toFixed(2)}`);
    else if (v !== d && typeof v === "boolean") out.push(k);
  }
  document.getElementById("bpMods").textContent = out.join("  ·  ") || "stock numbers";
  document.getElementById("bpLog").textContent =
    G.build.B.log.slice(-3).map((l) => l.text).join("  ·  ") || "nothing has fired yet";
}

/* ------------------------------------------------------------- the loop */

/* How cold the place under the car is, 0–1: the country's own flag,
 * blended across a transition, or a cold REGION inside a temperate one
 * (Aspenvale above the snow line). One number, read by the precipitation
 * (rain becomes snow), the codriver's weather call, and the wet-road
 * darkening (snow does not glisten like rain). */
function coldNow() {
  const hb = G.world.hereBiome;
  if (!hb) return 0;
  const cb = (b) => (b && b.cold ? 1 : 0);
  let c = cb(hb.prev) + (cb(hb.biome) - cb(hb.prev)) * hb.t;
  const hr = G.world.hereRegion;
  if (hr && hr.region) {
    const cr = (r) => (r && r.cold ? 1 : 0);
    c = Math.max(c, cr(hr.prev) + (cr(hr.region) - cr(hr.prev)) * hr.t);
  }
  return Math.max(0, Math.min(1, c));
}

/* What the marshals' book sees, four times a second: the car, the run,
 * the sky, the place, the build. Built here so achievements.js never
 * learns the shape of G; the harness builds the same object by hand. */
function achSnapshot(snap) {
  const R = G.run.R, c = G.car, w = G.world;
  const hb = w.hereBiome, hr = w.hereRegion;
  const ev = w.eventAt ? w.eventAt(c.s) : null;
  const sp = w.spanAt ? w.spanAt(c.s) : null;
  let firesMax = 0;
  for (const sv of G.build.B.souvenirs) if ((sv.fires || 0) > firesMax) firesMax = sv.fires;
  return {
    dt: 30 * DT, time: R.time, kmh: Math.abs(c.vx) * 3.6, vx: c.vx, beta: c.beta, zone: c.zone, surface: c.surface,
    gear: c.gear, deepOff: c.deepOff || 0,
    flow: R.flow, tier: R.tier, boost: R.boost, boostOn: R.boostOn, autoBoost: R.autoBoost,
    pushing: R.boostOn && !R.autoBoost && !R.sweepOn,
    dist: R.dist, ws: R.waystations, score: R.score, cleanCur: R.cleanCur, driveTime: R.driveTime,
    condition: R.condition, hits: R.hits, incidents: R.incidents, rolls: R.rolls,
    savesUsed: R.savesUsed, savesLeft: R.savesLeft, leg: R.legIndex,
    sweepOn: R.sweepOn, sweepMargin: R.sweepMarginS,
    night: snap.night, golden: snap.golden, rain: snap.rain, fog: snap.fog, storm: snap.storm || 0, u: snap.u,
    wet: snap.wetness, cold: w.coldNow || 0, snow: w.snowNow || 0,
    encl: w.spanEnclosure ? w.spanEnclosure(c.s) : 0,
    span: sp ? { kind: sp.kind, iced: !!sp.iced, over: !!sp.over } : null,
    event: ev ? ev.key : null,
    country: hb ? (hb.t >= 0.5 ? hb.biome.key : hb.prev.key) : w.biome.key,
    region: hr && hr.region ? hr.region.key : null,
    skyNow: G.celestial && G.celestial.C.active ? G.celestial.C.active.key : null,
    souvenirs: G.build.B.souvenirs.map((s) => s.def.id), parts: G.build.B.parts.map((p) => p.def.id), firesMax,
    noBrake: G.build.B.noBrakeT, verbosity: G.settings.verbosity, timing: G.settings.timing,
    album: G.cam ? G.cam.state.album.length : 0,
  };
}

/* the unlock notice: one line, bottom left, queued so a burst of marks
 * reads one at a time. No sound, no fanfare; the summary lists them. */
function achNotices(dt) {
  const el = els.achToast;
  if (!el) return;
  if (G.achShowT > 0) {
    G.achShowT -= dt;
    if (G.achShowT <= 0) { el.classList.remove("on"); G.achShowT = -0.6; }
  } else if (G.achShowT < 0) {
    G.achShowT = Math.min(0, G.achShowT + dt);
  } else if (G.achQueue && G.achQueue.length && !G.wsOpen && !G.paused) {
    const def = G.achQueue.shift();
    // `?achprobe=notice` keeps a mark on screen for the shots (bot runs only)
    if (params.get("achprobe") === "notice" && BOT && !G.achQueue.length) G.achQueue.push(ACHIEVEMENTS[(G._probeN = (G._probeN || 0) + 1) % ACHIEVEMENTS.length]);
    el.innerHTML = `<i>Marked</i><b>${def.name}</b><span>${def.desc}</span>`;
    el.classList.add("on");
    G.achShowT = 4.4;
  }
}

function simTick(input, silent) {
  const R = G.run.R;
  // the run layer may override input (arrival, waiting, over)
  const ovr = G.run.tick(G._lastEv || { landed: 0, impact: 0, air: 0 }, input);
  const use = ovr || input;
  G.atmo.tick(DT, G.car.s);
  /* the waystation's half hour, gliding by in sim time: ~0.008 of a day
   * per second lands the thirty minutes in about two and a half seconds
   * of parked quiet — dusk arrives WHILE the sheet does. Deterministic:
   * pure sim time, and the save already recorded where it lands. */
  if (G.wsGlideU > 0) {
    const du = Math.min(G.wsGlideU, 0.008 * DT);
    G.atmo.A.u = (G.atmo.A.u + du) % 1;
    G.wsGlideU -= du;
  }
  G.world.wetness = G.atmo.A.wetness;
  /* The sky's rarities tick in SIM time, like the weather they grow out
   * of: a meteor shower is a fact about the journey and must survive a
   * fast-forward. One snapshot serves the celestial system and the diary
   * — and the diary reads the world AS EXPERIENCED (above an inversion
   * you are not "in fog", whatever the front says). */
  const skySnap = G.atmo.snapshot();
  const sky = G.celestial.tick(DT, G.car, G.world, skySnap, G.atmo.A);
  G.celestial.apply(skySnap);
  // the souvenirs read the sky through the world (rain souvenirs, night souvenirs)
  G.world.night = skySnap.night;
  G.world.rainNow = skySnap.rain;
  G.world.fogNow = skySnap.fog;
  G.world.coldNow = coldNow();
  G.world.snowNow = skySnap.rain * G.world.coldNow;
  G.world.auroraNow = skySnap.aurora || 0;
  G.world.countriesNow = G.countries ? G.countries.size : 1;
  for (const st of sky.started) {
    if (!silent && !G.attract && st.line) { audio.speak(st.line, false); G.hud.subtitle(st.line, 3.4); }
  }
  for (const sn of sky.seen) {
    if (!G.attract && G.postcards) G.postcards.note(sn.def, G.car, skySnap, G.atmo.A.u, G.seedStr);
    if (G.ach) G.ach.event("sky", { key: sn.def.key });
  }
  /* Pulling in at a strange outpost is a thing that happened to the
   * journey — the diary remembers it the way it remembers a viaduct.
   * Written on the ARRIVAL transition, in sim time, like every fact. */
  if (R.state === "waystation" && G._wasRunState !== "waystation" && !G.attract && G.postcards && R.ws) {
    const wrec = G.world.waystations[R.ws.index];
    if (wrec && wrec.strange) {
      G.postcards.note({ key: "outpost", name: "A Strange Outpost" }, G.car, skySnap, G.atmo.A.u, G.seedStr);
      if (G.ach) G.ach.event("outpost", {});
    }
  }
  G._wasRunState = R.state;
  if (!silent && !G.attract) for (const th of sky.thunder) audio.sfxThunder(th.delay, th.power);
  /* THE STORM (owner: "weather needs more aura when it turns into storms.
   * I should feel scared and affected"). Deep rain is a storm, and a storm
   * has lightning of its own — not the sky's rare "distant lightning"
   * event on the horizon but the front itself, overhead: a strike every
   * six to eleven seconds, the thunder a second or two behind it, close
   * enough to shake the car. Hashed from sim time and the seed, so a
   * resumed run replays the same storm at the same metres. */
  {
    const storm = NOSTORM ? 0 : (skySnap.storm || 0);
    const Rt = G.run.R.time;
    if (storm > 0.12) {
      /* fixed eight-second buckets: one roll per bucket decides whether it
       * strikes and when. (A cadence that shrank with the storm moved the
       * bucket edges while the front was still building, which re-rolled
       * the strike every tick — the schedule has to be a function of time
       * alone, and the storm's depth only of how LIKELY and how hard.) */
      const cad = 8;
      const k = Math.floor(Rt / cad);
      if (k !== G.stormK) {
        G.stormK = k;
        const r = rng(hashCombine(G.seed, 0x5701 + k * 131));
        G.stormHit = r() < 0.22 + storm * 0.5;
        G.stormAt = k * cad + r() * cad * 0.7;
        G.stormAz = G.car.yaw + (r() - 0.5) * 2.6;
        G.stormPow = 0.45 + r() * 0.55;
        G.stormThunderAt = G.stormAt + 0.7 + r() * 2.0;
        G.stormThundered = false;
      }
      G.stormFlash = 0;
      if (G.stormHit) {
        const tt = Rt - G.stormAt;
        if (tt >= 0 && tt < 0.7) {
          // a strike is a stutter, not a pulse: the main flash and two re-strikes
          const f = Math.max(Math.exp(-tt * 14), 0.7 * Math.exp(-((tt - 0.17) ** 2) / 0.003), 0.45 * Math.exp(-((tt - 0.33) ** 2) / 0.0025));
          G.stormFlash = Math.min(1, f * (0.55 + storm * 0.45) * G.stormPow);
        }
        if (!G.stormThundered && Rt >= G.stormThunderAt) {
          G.stormThundered = true;
          if (!silent && !G.attract) {
            const p = G.stormPow * (0.6 + storm * 0.4);
            audio.sfxThunder(0, p);
            G.cam.onImpact(p * 7);
            if (G.input && G.input.rumble) G.input.rumble(p * 0.5, p * 0.8, 420);
          }
        }
      }
    } else { G.stormFlash = 0; G.stormK = null; }
  }
  // the assists multiply on top of the build, quietly
  const am = G.assist;
  const bm = G.build.mods;
  const modsAssist = am && am.on
    ? { ...bm, stability: bm.stability * am.stability, brake: bm.brake * am.brake, grip: bm.grip * am.grip, offDrag: bm.offDrag * am.offDrag }
    : bm;
  /* the Sweep's harder kick: boost is time in your pocket, so spending it
   * has to FEEL like spending something (deeper reserve lives in run.js) */
  const modsUse = G.sweep
    ? { ...modsAssist, boostPower: Math.min(3, modsAssist.boostPower * 1.28) }
    : modsAssist;
  const ev = step(G.car, G.world, use, modsUse);
  G._lastEv = ev;
  G.build.tick(ev, use);
  /* the marshals' book reads the sim: a surface change as it happens (the
   * ford at speed), and a snapshot four times a second for everything
   * that is a distance, a streak or a transition. Sim time, so ?ff and a
   * resume agree with a live drive. */
  if (G.ach) {
    if (ev.surface) G.ach.event("surface", { from: ev.surface.from, to: ev.surface.to, kmh: Math.abs(G.car.vx) * 3.6 });
    if (++G.achT >= 30) { G.achT = 0; G.ach.tick(achSnapshot(skySnap)); }
  }
  // codriver reads the weather ahead (rationed: one call per front;
  // minimal verbosity keeps even this quiet)
  if (!silent && !G.attract && R.state === "driving" && G.settings.verbosity !== "minimal") {
    const ahead = G.atmo.ahead(G.car.s);
    if (ahead.rain > 0.5 && G.atmo.A.rain < 0.25 && G.weatherCalled !== 1) { G.weatherCalled = 1; const wline = G.world.coldNow > 0.5 ? "snow coming" : "rain ahead"; audio.speak(wline, false); G.hud.subtitle(wline, 2.4); }
    /* the storm line has its OWN latch: said once as the front deepens past
     * a storm, re-armed only once it has blown through. (As a slot in the
     * chain above it flip-flopped with "clearing ahead" every tick when the
     * field ahead read clear inside a storm — 120 calls a second.) */
    else if (G.atmo.A.rain > 0.72 && G.world.coldNow < 0.5 && !G.stormCalled) { G.stormCalled = true; audio.speak("proper storm now. easy on the brakes", true); G.hud.subtitle("proper storm now. easy on the brakes", 2.8); }
    if (G.stormCalled && G.atmo.A.rain < 0.4) G.stormCalled = false;
    else if (ahead.fog > 0.55 && G.atmo.A.fog < 0.25 && G.weatherCalled !== 2) { G.weatherCalled = 2; audio.speak("fog coming in", false); G.hud.subtitle("fog coming in", 2.4); }
    else if (ahead.rain < 0.15 && ahead.fog < 0.2 && (G.atmo.A.rain > 0.5 || G.atmo.A.fog > 0.5) && G.weatherCalled !== 3) { G.weatherCalled = 3; audio.speak("clearing ahead", false); G.hud.subtitle("clearing ahead", 2.4); }
  }
  /* soft-ground caution (the far-verge bog, physics.js): a HAZARD, so it
   * speaks at every verbosity — the field is eating the car's speed and
   * the fix is a direction, not a skill. Once per excursion. */
  if (!silent && !G.attract && R.state === "driving") {
    if (G.car.deepOff > 0.5) {
      G.softT = (G.softT || 0) + DT;
      if (G.softT > 2.5 && !G.softCalled) {
        G.softCalled = true;
        audio.speak("soft ground. back to the road", false);
        G.hud.subtitle("soft ground. back to the road", 2.4);
      }
    } else if (G.car.deepOff === 0 && G.softCalled && G.car.offRoadT === 0) {
      G.softT = 0; G.softCalled = false;
    }
  }
  /* The Sweep's splits: the clock is a PRESENCE, not a stopwatch — the
   * codriver carries it in a handful of rationed lines, and the thin
   * margin bar does the rest. No red digits anywhere. */
  if (!silent && !G.attract && G.sweep && R.state === "driving" && R.dist > 400) {
    const sp = G.split || (G.split = { zone: 0, cool: 0 });
    sp.cool -= DT;
    const m = R.sweepMarginS;
    const zone = m < 25 ? 2 : m < 60 ? 1 : 0;
    if (zone > sp.zone) {
      if (sp.cool <= 0) {
        const line = zone === 2 ? "they're close. push" : "sweep's a minute back";
        audio.speak(line, zone === 2); G.hud.subtitle(line, 2.6);
        sp.cool = 26;
      }
      sp.zone = zone;
    } else if (sp.zone > 0 && zone === 0 && m > 100 && sp.cool <= 0) {
      audio.speak("clear of them now", false); G.hud.subtitle("clear of them now", 2.4);
      sp.zone = 0; sp.cool = 40;
    }
  }
  if (R.state === "driving") {
    collectPickups(G.world, G.car, G.build, (p, label) => { R.pickups = (R.pickups || 0) + 1; if (!silent) { G.hud.toast(label); audio.sfxPickup(p.kind); } });
    /* The journey record, written in SIM time like everything that is a
     * fact about the journey: where the kilometres happened (night, rain),
     * the line of the route itself, and the countries crossed. */
    const dsr = Math.max(0, G.car.s - (G._statS == null ? G.car.s : G._statS));
    G._statS = G.car.s;
    if (dsr < 30) {
      if (skySnap.night > 0.5) R.nightDist += dsr;
      if (skySnap.rain > 0.35) R.rainDist += dsr;
      // the cold kilometres: the shelf stocks the winter cards once the
      // journey has actually met the winter
      if (G.world.coldNow > 0.5) R.coldDist = (R.coldDist || 0) + dsr;
      // where the kilometres happened, by country — the summary's tally
      const bn = G.world.hereBiome.biome.name;
      if (G.kmBy) G.kmBy[bn] = (G.kmBy[bn] || 0) + dsr;
    }
    if (G.path && G.car.s - G.pathS > 60) {
      G.pathS = G.car.s;
      if (G.path.length < 2400) G.path.push([Math.round(G.car.x), Math.round(G.car.z)]);
    }
    /* The hidden road, actually driven: taking the unmarked line writes
     * the diary's quietest card. Nothing announces the strip — finding it
     * IS the discovery, and this is only the remembering. */
    const orr = G.world.oldRoadAt ? G.world.oldRoadAt(G.car.s) : null;
    if (orr && dsr < 30) {
      if (G._oldSite !== orr.s0) { G._oldSite = orr.s0; G._oldAcc = 0; }
      if (Math.sign(G.car.d) === Math.sign(orr.lat) && Math.abs(Math.abs(G.car.d) - Math.abs(orr.lat)) < 4.2) {
        G._oldAcc += dsr;
        if (G._oldAcc > 120 && G._oldDone !== orr.s0 && !G.attract && G.postcards) {
          G._oldDone = orr.s0;
          G.postcards.note({ key: "oldroad", name: "The Old Road" }, G.car, skySnap, G.atmo.A.u, G.seedStr);
          if (G.ach) G.ach.event("oldroad", {});
        }
      }
    }
    if (G.countries && G.world.hereBiome && G.world.hereBiome.t >= 1) G.countries.add(G.world.hereBiome.biome.name);
    /* The travel diary is written in SIM time, not render time. A postcard
     * is a fact about the journey — where you were, in what light — so it
     * must not depend on frame rate, and it has to be recorded during a
     * fast-forward too, or a resumed or skipped-through run quietly forgets
     * everywhere it went. Nothing is announced: the banner already did
     * that, and the bible is firm that discovery is not advertised. */
    if (!G.attract && G.postcards) G.postcards.update(G.car, skySnap, G.atmo.A.u, G.seedStr);
    // the Pressed Flower reads the diary's count as run state (resume-safe:
    // the book is restored before the first tick)
    if (G.postcards) R.postcardsN = G.postcards.found.length;
  }
  if (!silent && G.build.B.log.length && G.build.B.log[G.build.B.log.length - 1].t > G.logSeen) {
    const last = G.build.B.log[G.build.B.log.length - 1];
    G.logSeen = last.t;
    G.hud.toast(last.text);
  }

  if (!silent) {
    if (ev.impact > 2) {
      audio.sfxImpact(ev.impact); G.cam.onImpact(ev.impact);
      if (G.parts) {
        G.parts.burst(G.car, ev.impact, G.world, G.world.hereBiome.biome.palette);
        if (ev.impact > 6) G.parts.sparks(G.car, ev.impact);   // hard contact sparks
      }
      // pad haptics: a hit in the hands — subtle, driving only, optional
      if (!G.attract) G.input.rumble(Math.min(1, ev.impact / 18), 0.25, 90);
    }
    if (ev.landed > 1.5) { audio.sfxLanding(ev.landed, G.car.damage); G.cam.onLanded(ev.landed); if (G.parts) G.parts.burst(G.car, ev.landed * 1.4, G.world, G.world.hereBiome.biome.palette); if (!G.attract) G.input.rumble(0.12, 0.45, 60); }
    if (ev.gearChange) audio.sfxShift();
    if (ev.blowOff) audio.sfxBlowOff();
    // the ford announces itself: standing water at speed is a splash
    if (ev.surface && ev.surface.to === "mud" && Math.abs(G.car.vx) > 8) audio.sfxSplash(Math.abs(G.car.vx));
  }
  if (R.state === "driving") {
    G.codriver.update(G.car, DT);
    G.codriver.occasion(G.car, ev, DT, {
      tier: R.tier,
      night: skySnap.night, golden: skySnap.golden,
      // while the sky performs, the codriver watches it with you
      skyBusy: !!(skySnap.meteors || skySnap.lightning || skySnap.rainbow || skySnap.cloudSea || skySnap.eclipse || (skySnap.aurora || 0) > 0.3),
    });
  }
  /* The forgiving reset used to live here (off the mapped world for 5 s,
   * stuck for 6, fallen through the floor → a free tow back to the road).
   * It is an INCIDENT now — run.js's three ends: the tow costs time, the
   * zone and condition, there are only so many, and a car on its roof or
   * in the lake needs one too. */
}

function frame(t) {
  requestAnimationFrame(frame);
  const dtMs = Math.max(0, Math.min(100, t - G.lastT));
  G.lastT = t;
  const dt = dtMs / 1000;

  const input = G.input.poll();
  // pad glyphs: the keysheet shows what the player is actually holding
  if (input.padConnected !== G._padWas) {
    G._padWas = input.padConnected;
    document.body.classList.toggle("pad", input.padConnected);
  }
  if (G.input.consumePause() && G.running && !G.attract && !G.wsOpen && !G.run.R.over) {
    G.paused = !G.paused;
    if (G.paused) G.pauseUI.show(); else G.pauseUI.hide();
  }

  if (G.running && !G.paused && !G.glLost) {
    const R = G.run.R;
    G.accum += dt;
    let steps = 0;
    G.world.ensure(G.car.s);
    while (G.accum >= DT && steps < 5) {
      const simInput = (BOT || G.attract) ? botInput(G.car, G.world, 0.9) : {
        dir: input.dir, steerAnalog: input.steerAnalog,
        throttle: input.throttle, brake: input.brake,
        handbrake: input.handbrake,
        /* one law for the turbo: physics reads this raw flag (car.boosting
         * drives the torque kick, the drag cut and the FOV), so it must
         * agree with the run's own economy gate (> 1, run.js wantBoost).
         * The old > 0.5 gate left a window: a run-dry meter parks just
         * under 1 where the run refuses to fire or drain, but the held key
         * still reached the engine — a free, silent, undrained kick with
         * an empty-looking bar (Quinn caught it wearing the Rosetta Stone,
         * which amplifies the kick until the leak is unmissable). And an
         * auto-boost souvenir now reaches the wheels without the key held,
         * which is what its rule always said. */
        boost: (R.autoBoost || (input.boost && R.boost > 1)) && R.state === "driving",
      };
      simTick(simInput, false);
      G.accum -= DT;
      steps++;
    }
    if (steps === 5) G.accum = 0;   // no spiral after a hitch

    // waystation: a beat of quiet, then the choices
    if (R.state === "waystation" && !G.wsOpen && !R.over) {
      G.wsTimer -= dt;
      if (G.wsTimer <= 0) {
        if ((BOT || G.attract) && !SHOWWS) botDepart(); else openWaystation();
      }
    }
    /* the long coffee: real minutes with the sheet open, told to the book
     * once a second (it is the one thing the book measures in wall time) */
    if (G.wsOpen && G.ach) {
      G.wsRealT = (G.wsRealT || 0) + dt;
      G.wsRealAcc = (G.wsRealAcc || 0) + dt;
      if (G.wsRealAcc >= 1) { G.wsRealAcc = 0; G.ach.event("wsReal", { seconds: G.wsRealT }); }
    }
    achNotices(dt);

    // render-side updates
    G.kit.updateAnchor(G.car.x, G.car.z);
    const anchor = G.kit.anchor;
    G.chunks.update(G.car.s, dt);
    updateKestrel(G.kestrel, G.car, G.world, anchor);
    applyWear(G.kestrel, R.condition, G.car);
    /* the cuts (camera.js): only while genuinely driving; the camera
     * needs the road width, the bore, the leg's end, and whether a border
     * or a landmark just arrived (one-frame flags, set below) */
    const qCam = G.world.roadQuery(G.car.x, G.car.z, G.car.s);
    G.cam.update(G.car, anchor, dt, {
      seed: G.seed, allow: G.running && !G.paused && R.state === "driving" && !G.car.onRoof && !G.car.inWater,
      hw: qCam ? qCam.hw : 3.5, encl: G.encl || 0, legEndS: G.world.legEndS,
      border: !!G.cutBorder, landmark: !!G.cutLandmark,
      // the mirror's licence: how close the sweep car is, in metres
      sweepGap: G.sweep && R.sweepOn ? G.car.s - R.sweepS : null,
      // the chopper's licence: it films the run's best minutes, so it
      // needs to know how good this minute is
      tier: R.tier,
      // how hard the PLAYER's hands are working (the bot's never are): a
      // cut never STARTS over a driver mid-correction (it runs once called)
      drive: Math.max(Math.abs(input.steerAnalog != null ? input.steerAnalog : input.dir || 0), input.brake || 0, input.handbrake ? 1 : 0),
      cutRate: (G.build && G.build.runMods.cutRate) || 1,
    });
    /* a completed shot reaches the game layer: the crew souvenirs hook it
     * (Press Pass, Front Page), and nothing else ever will */
    if (G.cam.state.shotDone) {
      const sd = G.cam.state.shotDone;
      G.cam.state.shotDone = null;
      if (!G.attract && G.build) G.build.emit("shot", sd);
    }
    G.cutBorder = false; G.cutLandmark = false;
    document.body.classList.toggle("cut", G.cam.state.mode === "shot");
    /* the tripod stands at a fixed shot's seat, lens tracking the car —
     * during the LEAD-IN (the shot itself is rendered FROM the seat, where
     * the model would hang its own lens in the frame), and it stays
     * planted a few seconds after the cut back for the drive-past. The
     * border pass and the roll have no crew spot. */
    if (G.tripod) {
      const sh = G.cam.state.shot;
      if (sh && sh.wx != null && sh.kind !== "roll") {
        // the flyover's lens lies near the line: its marker (tx/tz) stands
        // on the verge instead, so the tripod never blocks the jump
        G.lastSeat = sh.tx != null
          ? { wx: sh.tx, gy: sh.tgy, wz: sh.tz, t: 4 }
          : { wx: sh.wx, gy: sh.gy != null ? sh.gy : sh.wy - 1.6, wz: sh.wz, t: 4 };
        /* the shot is required now, so it gets CALLED like a corner: the
         * codriver announces the crew as the bars start sliding */
        if (!sh.announced) {
          sh.announced = true;
          if (!G.attract && G.codriver && !G.cam.state.cutForce) {
            G.codriver.moment(
              sh.kind === "brow" ? "camBrow"
                : sh.kind === "reveal" ? "camReveal"
                  : sh.kind === "crane" ? "camCrane"
                    : sh.kind === "flyover" ? "camFlyover"
                      : "camTrackside"
            );
          }
        }
      }
      const inShot = G.cam.state.mode === "shot" && sh && sh.t >= 0;
      const seat = !inShot && G.lastSeat && G.lastSeat.t > 0 ? G.lastSeat : null;
      if (G.lastSeat) G.lastSeat.t -= dt;
      G.tripod.visible = !!seat;
      if (seat) {
        G.tripod.position.set(seat.wx - anchor.x, seat.gy, seat.wz - anchor.z);
        G.tripod.rotation.y = -Math.atan2(G.car.z - seat.wz, G.car.x - seat.wx);
      }
    }
    if (G.tele.on && !G.attract) G.tele.sample(dt, G.car, input, G.cam.info(G.car, anchor), G.run, R.state);
    const g = G.world.groundHeight(G.car.x, G.car.z, G.car.s);
    const snap = G.atmo.snapshot();
    /* How far inside a bore the car is (0 at the portal, 1 in the middle).
     * Everything that makes a tunnel a tunnel hangs off this one number:
     * the light going away, the fog closing in, the headlights coming on,
     * the engine gaining walls to bounce off. Eased rather than read raw,
     * so the mouth arrives as a moment instead of a switch. */
    const enclosure = G.world.spanEnclosure ? G.world.spanEnclosure(G.car.s) : 0;
    G.encl = (G.encl || 0) + (enclosure - (G.encl || 0)) * Math.min(1, dt * 7);
    snap.tunnel = G.encl;
    snap.snow = coldNow();     // cold country: precipitation falls as snow
    G.celestial.apply(snap);   // sky rarities fold into the frame's snapshot
    /* `?boltprobe=1` — hold a lightning flash at its peak, ahead-left, so
     * the bolt and glow can be iterated on without racing the 3 s flash
     * cadence in screenshots (the same reasoning as the survival probes:
     * rare visuals you cannot summon do not get finished) */
    if (params.get("boltprobe") === "1") { snap.lightning = 0.85; snap.lightningAz = G.car.yaw + 0.4; }
    // the storm's own strikes (sim tick above), unless the sky's rarity already has the frame
    if (!snap.lightning && G.stormFlash > 0.01) { snap.lightning = G.stormFlash; snap.lightningAz = G.stormAz; }
    if (NOSTORM) snap.storm = 0;
    // `?stormprobe=1` — hold a full storm for the shots
    if (params.get("stormprobe") === "1") { snap.storm = 1; snap.rain = Math.max(snap.rain, 0.95); snap.overcast = Math.max(snap.overcast, 0.95); }
    const hb = G.world.hereBiome;
    // one blend for the frame: mid-transition this allocates a palette
    // object, and the same one serves the sky and the dust
    const palHere = blendPalette(hb.prev.palette, hb.biome.palette, hb.t);
    G.kit.applyAtmosphere(snap, palHere);
    G.post.applyAtmosphere(snap);
    G.parts.update(dt, G.car, G.world, palHere, snap);
    // a wet road glistens; a snowed one does not — the darkening stands down
    G.chunks.setWetness(snap.wetness * (1 - 0.7 * (snap.snow || 0)));
    G.chunks.setNight(snap.night);
    // the country changes: the codriver notices, then the name arrives
    if (R.state === "driving" && hb.t < 1 && hb.t > 0.15 && G.transitionSpoken !== G.world.transitionS) {
      G.transitionSpoken = G.world.transitionS;
      G.cutBorder = true;      // the camera may make something of it
      if (!G.attract) audio.speak(hb.prev.transitionLine, false);
      G.hud.subtitle(hb.prev.transitionLine, 3.5);
    }
    if (hb.t >= 1 && hb.biome.key !== G.biomeAnnounced) {
      G.biomeAnnounced = hb.biome.key;
      G.hud.message(hb.biome.name.toUpperCase(), 4);
    }
    /* A special event gets the banner too — it is the other thing in the
     * game big enough to be worth naming on screen. It fires on ARRIVAL,
     * not on the call: the codriver has already told you it is coming, and
     * the banner should land when you are looking at the thing. */
    const evHere = G.world.eventAt ? G.world.eventAt(G.car.s) : null;
    if (R.state === "driving" && evHere && evHere !== G.eventAnnounced) {
      G.eventAnnounced = evHere;
      if (evHere.banner) { G.hud.message(evHere.banner, 4); G.cutLandmark = true; }
    }
    /* Regions are a smaller event than a country: the codriver mentions
     * the place, and that is all. No banner — a banner every kilometre
     * stops meaning anything, and the country's arrival should still feel
     * like the bigger moment. */
    const hr = G.world.hereRegion;
    if (R.state === "driving" && hr && hr.region && hr.t > 0.25 && hr.t < 1
        && hr.region.key !== G.regionSpoken && hr.region.line) {
      G.regionSpoken = hr.region.key;
      if (!G.attract) audio.speak(hr.region.line, false);
      G.hud.subtitle(hr.region.line, 3.2);
    }
    /* THE GOVERNOR (auto quality): measure real frames, walk the ladder
     * both ways. Down fast — two slow one-second windows (under ~45 fps)
     * and the tier steps back; a stutter costs more than a rebuild. Up
     * slowly — six clean windows at full rate with no double-dropped
     * frame, and never back into a tier this run already stepped down
     * from (no thrash). A beat of warm-up is ignored after every change:
     * tier changes rebuild terrain, and the rebuild itself would read as
     * the new tier being too slow. Fixed tiers and pinned URLs stand the
     * governor down entirely; bot/headless runs never govern — virtual
     * time makes every frame look slow, and screenshots must keep
     * rendering the same picture. */
    if (!QFORCE && !BOT && G.settings && G.settings.quality === "auto" && !document.hidden) {
      G.qWin = (G.qWin || 0) + dt;
      G.qWorst = Math.max(G.qWorst || 0, dt);
      G.qFrames = (G.qFrames || 0) + 1;
      if (G.qFrames >= 60) {
        const mean = G.qWin / G.qFrames, worstW = G.qWorst;
        G.qWin = 0; G.qFrames = 0; G.qWorst = 0;
        if (!G.autoTier) G.autoTier = guessTier(G.kit.renderer);
        const at = Q_LADDER.indexOf(G.autoTier);
        if ((G.qWarm || 0) > 0) { G.qWarm--; G.qGood = 0; G.qBad = 0; }
        else if (mean > 0.022) {
          G.qGood = 0;
          if (++G.qBad >= 2 && at > 0) {
            G.qBad = 0; G.qWarm = 3;
            (G.qCeil = G.qCeil || {})[G.autoTier] = true;
            G.autoTier = Q_LADDER[at - 1];
            applyQuality(G.autoTier);
            const m = loadMeta(); m.autoTier = G.autoTier; saveMeta(m);
            if (at - 1 <= 1) G.hud.toast("Picture eased off: slow frames");
          }
        } else {
          G.qBad = 0;
          const up = Q_LADDER[at + 1];
          if (up && !(G.qCeil && G.qCeil[up]) && mean < 0.0176 && worstW < 0.034) {
            if (++G.qGood >= 6) {
              G.qGood = 0; G.qWarm = 3;
              G.autoTier = up;
              applyQuality(up);
              const m = loadMeta(); m.autoTier = up; saveMeta(m);
            }
          } else G.qGood = 0;
        }
      }
    }
    G.kit.updateBackdrop(G.kit.camera.position, (g ? g.y : G.car.y) - 8);
    const lightsOn = G.effects.update(snap, G.car, G.world, dt, G.kit.camera.position, G.kestrel);
    /* the sweep car, on the road behind you at the pursuer's exact metre
     * (owner: "I want to be able to see the sweep car") — its beacons
     * light the road as the dark comes down */
    if (G.sweepCar) {
      if (G.sweep && R.sweepOn && R.sweepS < G.car.s + 5) updateSweepCar(G.sweepCar, G.world, R.sweepS, anchor, dt, lightsOn || 0);
      else G.sweepCar.root.visible = false;
    }
    if (G.dev) G.dev.update(G.car, dt);
    /* The country's voice when the engine goes quiet: the biome's blended
     * ambience profile handed to ambiencePlan (pure, harness-tested),
     * which owns every gate — clock, weather, snow, speed, the bore. */
    {
      const ha = G.world.hereBiome;
      const a0 = ha.prev.amb || {}, a1 = ha.biome.amb || {};
      const prof = {};
      for (const k in a0) prof[k] = a0[k] + ((a1[k] || 0) - a0[k]) * ha.t;
      for (const k in a1) if (!(k in prof)) prof[k] = a1[k] * ha.t;
      G.amb = audio.ambiencePlan({
        a: prof,
        night: snap.night, rain: snap.rain, overcast: snap.overcast,
        snow: snap.snow || 0, storm: snap.storm || 0,
        parked: R.state === "waystation" || R.over,
        waystation: R.state === "waystation",
        speed: Math.abs(G.car.vx), encl: G.encl || 0,
      });
    }
    audio.updateAudio(G.car, G.world, dt, G.amb);
    /* The music reads the run, never the other way round: flow earns the
     * layers, a waystation is shelter, storms darken the mode, and inside
     * a tunnel the music steps back for the reverb. */
    const upNotes = R.state === "driving" ? G.codriver.upcoming(G.car, 4) : [];
    /* how tight the road ahead is — the codriver's turn: the lead steps
     * back and the hats tighten (the bible's "technical" music state) */
    let tech = 0;
    for (const u of upNotes) {
      if (u.dist > 200) continue;
      const gr = u.note.grade;
      const tight = gr === "hp" ? 1 : gr === "flat" ? 0 : typeof gr === "number" ? Math.max(0, 1 - (gr - 1) * 0.19) : 0;
      if (tight > tech) tech = tight;
    }
    audio.musicUpdate(dt, {
      state: R.over ? "over" : G.attract ? "attract" : R.state === "waystation" ? "waystation" : "driving",
      tier: R.tier, flow: R.flow,
      vKmh: Math.abs(G.car.vx) * 3.6,
      night: snap.night, rain: snap.rain,
      storm: snap.rain > 0.5 && snap.overcast > 0.6,
      tunnel: G.encl || 0,
      event: !!evHere,
      // the arrival FRAME at a landmark: the music's cue for its one fanfare
      eventNew: !!evHere && evHere !== G._evMusic,
      country: G.world.hereBiome.biome.key,
      tech,
    });
    if (evHere) G._evMusic = evHere;
    G.hud.update(G.car, dt);
    G.hud.meters(R);
    G.hud.notes(upNotes.slice(0, 3));
    /* the charm rail (HUD tier "everything"): the build worn on the dash.
     * A fifth of a second is plenty; the rail only redraws on change. */
    if (G.hudTier === "everything" && !G.attract && G.build) {
      G.charmT = (G.charmT || 0) + dt;
      if (G.charmT > 0.2) {
        G.charmT = 0;
        G.hud.charms(G.build.B.souvenirs.filter((sv) => sv.def.on || sv.def.onDamage || sv.def.echo || sv.def.onIncident).map((sv) => ({
          id: sv.def.id, name: sv.def.name, fires: sv.fires || 0, rule: sv.def.rule,
          lit: !!(sv.state && (sv.state.ready || sv.state.armed || sv.state.arm || sv.state.charge)),
        })));
      }
    }
    /* the dash clock (optional): a quarter-second cadence, so the parked
     * half hour visibly winds forward while the sheet is up */
    if (G.clockAlways && !G.attract && els.clockHud) {
      G.clkT = (G.clkT || 0) + dt;
      if (G.clkT > 0.25) {
        G.clkT = 0;
        const c = clockOf(G.atmo.A.u);
        if (c !== G.clkWas) { G.clkWas = c; els.clockHud.textContent = c; }
        if (els.clockHud.style.display !== "block") els.clockHud.style.display = "block";
      }
    }
    if (G.attract) {
      G.liveT = (G.liveT || 0) + dt;
      if (G.liveT > 0.4) { G.liveT = 0; updateTitleLive(); }
    }
    if (G.bpOpen) {
      G._bpT = (G._bpT || 0) + dt;
      if (G._bpT > 0.3) { G._bpT = 0; renderBuildPanel(); }
    }

    /* Performance meter. Frame time rather than FPS, because frame time
     * is the number you can reason about — 8.3 ms of headroom at 120 Hz
     * is a fact, "160 fps" is a vibe — and the WORST of the last two
     * seconds alongside the mean, because a run that averages 60 and
     * hitches to 90 ms whenever a section builds is not a 60 fps game.
     * The histogram fills outside DEBUG too: oc.quality() reads it. */
    {
      const ms = Math.min(200, dt * 1000);
      G.perf = G.perf || { hist: new Float32Array(120), at: 0, n: 0 };
      G.perf.hist[G.perf.at] = ms;
      G.perf.at = (G.perf.at + 1) % G.perf.hist.length;
      G.perf.n = Math.min(G.perf.n + 1, G.perf.hist.length);
    }
    if (DEBUG) {
      const c = G.car;
      let sum = 0, worst = 0;
      for (let i = 0; i < G.perf.n; i++) { const v = G.perf.hist[i]; sum += v; if (v > worst) worst = v; }
      const mean = sum / Math.max(1, G.perf.n);
      const info = G.kit.renderer.info, ps = G.post.stats;
      G.hud.debug(
        `s ${c.s.toFixed(0)}  v ${(c.vx * 3.6).toFixed(0)}  gear ${c.gear} rpm ${c.rpm.toFixed(0)}\n` +
        `beta ${c.beta.toFixed(2)}  slip ${c.slip.toFixed(2)}  load ${c.loadScale.toFixed(2)}\n` +
        `zone ${c.zone}  surf ${c.surface}  dmg ${c.damage.toFixed(0)}  cond ${R.condition.toFixed(0)}\n` +
        `state ${R.state}  leg ${R.legIndex}  ws ${R.waystations}  flow ${R.flow.toFixed(0)} t${R.tier}  boost ${R.boost.toFixed(0)}  ` +
        `saves ${R.savesLeft} (earned ${R.savesEarned})  rollE ${c.rollE.toFixed(2)}${c.onRoof ? " ROOF" : ""}${c.inWater ? " WATER" : ""}\n` +
        `score ${R.score.toFixed(0)}  frontier ${(G.world.frontierS() - c.s).toFixed(0)} m  hold ${G.world.hold}
` +
        `mods pow ${G.build.mods.power.toFixed(2)} grip ${G.build.mods.grip.toFixed(2)} stab ${G.build.mods.stability.toFixed(2)}  build [${G.build.ids().join(", ")}]\n` +
        `day ${G.atmo.A.u.toFixed(3)}  overcast ${G.atmo.A.overcast.toFixed(2)} rain ${G.atmo.A.rain.toFixed(2)} fog ${G.atmo.A.fog.toFixed(2)} wet ${G.atmo.A.wetness.toFixed(2)}  sky ${G.celestial.state()}\n` +
        `biome ${G.world.hereBiome.biome.key} (from ${G.world.hereBiome.prev.key} t=${G.world.hereBiome.t.toFixed(2)})  stay ${G.legsInBiome}` +
        (G.world.legPlan ? `  director t${G.world.legPlan.tier}${G.world.legPlan.daring === 1 ? " daring" : G.world.legPlan.daring === -1 ? " breathing" : ""} ${G.world.legPlan.arc.key} wave ${(G.world.legPlan.wave.len / 1000).toFixed(1)}km` : "") +
        `  grace ${R.graceArmed ? "armed" : R.graceLow ? "low" : "spent"}` + `\n` +
        `spans ${G.world.spans.map((sp) => `${sp.kind === 1 ? "TUN" : "BRG"}@${(sp.s0 - c.s).toFixed(0)}..${(sp.s1 - c.s).toFixed(0)}`).join(" ") || "none live"}  encl ${(G.encl || 0).toFixed(2)}
` +
        `events ${G.world.events.map((e) => `${e.key}@${(e.s0 - c.s).toFixed(0)}..${(e.s1 - c.s).toFixed(0)}`).join(" ") || "none live"}  seen [${G.world.eventKeys.join(", ")}]
` +
        `fords ${G.world.sections.filter((x) => x.ford).map((x) => `${(x.ford.s0 - c.s).toFixed(0)}..${(x.ford.s1 - c.s).toFixed(0)}`).join(" ") || "none live"}
` +
        `frame ${mean.toFixed(1)} ms (${(1000 / Math.max(0.1, mean)).toFixed(0)} fps), worst 2 s ${worst.toFixed(1)} ms  ` +
        `scene ${ps.calls} draws / ${(ps.triangles / 1000).toFixed(0)}k tris  geo ${info.memory.geometries} tex ${info.memory.textures}`
      );
    }
  }

  if (!G.glLost) G.post.render(dt);
  /* the crew's still: grabbed the same frame the shot peaks — the GL
   * buffer is not preserved across tasks, so it must happen right here.
   * The letterbox and HUD are DOM, so the frame comes out clean. */
  if (G.cam && G.cam.state.wantStill) {
    G.cam.state.wantStill = false;
    if (!G.attract && !G.glLost && G.cam.state.shot) {
      try { G.cam.state.shot.still = G.kit.renderer.domElement.toDataURL("image/jpeg", 0.72); }
      catch (e) { /* lost context or tainted canvas: the album skips one */ }
    }
  }
}

boot();
