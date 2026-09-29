/* Daily Rocket — validation harness.
 *
 * Run from the repo root:
 *   node tools/rocket-test.mjs            everything below except `today`
 *   node tools/rocket-test.mjs gen        generation sweep: validity + determinism
 *   node tools/rocket-test.mjs fly        par flights re-flown: success + determinism
 *   node tools/rocket-test.mjs variety    worlds / missions / twists actually vary
 *   node tools/rocket-test.mjs rules      twist rules hold (limits, bans, shed stock)
 *   node tools/rocket-test.mjs board      rival companies fly; spread of results
 *   node tools/rocket-test.mjs physics    unit checks: stability, staging, chutes
 *   node tools/rocket-test.mjs today      print today's day, par ledger and board
 *   node tools/rocket-test.mjs day N      same for day index N
 *
 * The gen sweep covers 61 days around today. A published day must have a
 * par flight that landed (the generator's audition), so a red day here is a
 * day that would ship broken.
 */
import { pathToFileURL } from "url";
import path from "path";

const jsDir = path.resolve(import.meta.dirname, "../source/games/rocket/js") + path.sep;
const base = pathToFileURL(jsDir).href;
const G = await import(base + "gen.js");
const P = await import(base + "physics.js");
const PARTS = await import(base + "parts.js");
const D = await import(base + "designer.js");
const S = await import(base + "score.js");
const { dayIndex } = await import(base + "daily.js");

const mode = process.argv[2] || "all";
const today = dayIndex();
const FROM = today - 10, TO = today + 50;
let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };

function fingerprint(day) {
  let h = 0;
  const t = day.terrain;
  for (let i = 0; i < t.n; i += 7) { h = (h * 31 + Math.round(t.heights[i] * 100)) | 0; }
  for (const L of day.legs) { h = (h * 31 + Math.round(L.target.x * 10) + Math.round(L.target.y * 10) * 7) | 0; }
  h = (h * 31 + Math.round(day.world.g * 1000) + Math.round(day.world.wind * 10) * 13) | 0;
  h = (h * 31 + day.fee + day.par.total) | 0;
  return h + ":" + PARTS.buildKey(day.refBuild) + ":" + day.twistIds.join(",");
}

function flightPrint(sim) {
  return [sim.outcome, Math.round(sim.t * 1000), Math.round(sim.liquidBurned * 1000),
    Math.round(P.comWorld(sim.main).x * 100)].join("/");
}

// ------------------------------------------------------------------ gen

if (mode === "all" || mode === "gen") {
  console.log(`=== generation sweep (days ${FROM}..${TO}) ===`);
  const variants = [0, 0, 0, 0];
  let slow = 0, total = 0;
  for (let d = FROM; d <= TO; d++) {
    const t0 = Date.now();
    const day = G.generateDay(d);
    const ms = Date.now() - t0;
    total += ms; if (ms > 1500) { slow++; }
    variants[day.variant]++;
    const tag = `day ${d} #${day.number} ${day.world.id}/${day.mission.type}`;
    const t = day.terrain;
    for (let i = 0; i < t.n; i++) { if (!Number.isFinite(t.heights[i])) { fail(tag + " NaN terrain"); break; } }
    for (const L of day.legs) {
      if (day.barge) { continue; }
      for (let x = L.target.x - L.target.half; x <= L.target.x + L.target.half; x += 2.5) {
        if (Math.abs(t.slopeAt(x)) > 0.02) { fail(tag + " pad not flat @" + x.toFixed(0)); break; }
      }
    }
    for (let x = -50; x <= 50; x += 10) {
      if (Math.abs(t.slopeAt(x)) > 0.02) { fail(tag + " launch shelf not flat"); break; }
    }
    if (day.gates) {
      for (const g of day.gates) {
        if (g.y - g.half - t.surfaceAt(g.x) < 20) { fail(tag + " ring too low @" + g.x); }
      }
    }
    if (!day.par.ok) { fail(tag + " PAR FLIGHT FAILED even at the gentlest variant (" + day.par.outcome + ")"); }
    if (day.par.stats.time > 230) { fail(tag + " par flight " + day.par.stats.time.toFixed(0) + " s"); }
    if (!(day.fee > 0) || !(day.deadline > day.par.stats.time)) { fail(tag + " fee/deadline"); }
    if (D.violations(day, day.refBuild).length) { fail(tag + " reference breaks today's rules"); }
    // regenerate from scratch (bypassing the cache) and compare
    const again = regenerate(d);
    if (fingerprint(day) !== fingerprint(again)) { fail(tag + " NON-DETERMINISTIC"); }
  }
  console.log(`variants used: v0=${variants[0]} v1=${variants[1]} v2=${variants[2]} v3=${variants[3]}`);
  console.log(`generation time: ${(total / (TO - FROM + 1)).toFixed(0)} ms/day avg, ${slow} over 1.5 s`);
}

function regenerate(d) { return G.generateDay(d, true); } // bypasses the cache

// ------------------------------------------------------------------ fly

if (mode === "all" || mode === "fly") {
  console.log(`=== par flights re-flown (days ${FROM}..${TO}) ===`);
  for (let d = FROM; d <= TO; d++) {
    const day = G.generateDay(d);
    const tag = `day ${d} #${day.number} ${day.world.id}/${day.mission.type}`;
    const a = G.flyBuild(day, day.refBuild, G.PAR_SKILL);
    const b = G.flyBuild(day, day.refBuild, G.PAR_SKILL);
    if (!a.success) { fail(tag + " par re-flight " + a.outcome + ": " + a.message); }
    if (flightPrint(a) !== flightPrint(b)) { fail(tag + " NON-DETERMINISTIC FLIGHT"); }
    const L = S.ledger(a, day);
    if (L.total !== day.par.total) { fail(tag + " par ledger drifted " + L.total + " vs " + day.par.total); }
    // the starter must be flyable too: it is what a newcomer launches
    const st = G.flyBuild(day, day.starter, 0.8);
    if (!st.success) { console.log(`  note ${tag}: starter@0.8 ${st.outcome} (${st.message})`); }
  }
}

// ------------------------------------------------------------------ variety

if (mode === "all" || mode === "variety") {
  console.log("=== variety over 120 days ===");
  const worlds = {}, types = {}, twists = {}, twistCount = [0, 0, 0], pairs = new Set(), refs = new Set();
  for (let d = today; d < today + 120; d++) {
    const day = G.generateDay(d);
    worlds[day.world.id] = (worlds[day.world.id] || 0) + 1;
    types[day.mission.type] = (types[day.mission.type] || 0) + 1;
    twistCount[day.twistIds.length]++;
    for (const t of day.twistIds) { twists[t] = (twists[t] || 0) + 1; }
    pairs.add(day.world.id + "/" + day.mission.type + "/" + day.twistIds.join("+"));
    refs.add(PARTS.buildKey(day.refBuild));
  }
  console.log("worlds  ", JSON.stringify(worlds));
  console.log("missions", JSON.stringify(types));
  console.log("twists  ", JSON.stringify(twists));
  console.log(`twist count: none=${twistCount[0]} one=${twistCount[1]} two=${twistCount[2]}`);
  console.log(`distinct world/mission/twist combos: ${pairs.size} of 120; distinct reference rockets: ${refs.size}`);
  if (Object.keys(types).length < 7) { fail("not every mission type appears"); }
  if (Object.keys(twists).length < 12) { fail("fewer than 12 twists in use"); }
  if (pairs.size < 80) { fail("days repeat their shape too often"); }
  // no identical back-to-back days
  for (let d = today; d < today + 120; d++) {
    const a = G.generateDay(d), b = G.generateDay(d + 1);
    if (a.world.id === b.world.id && a.mission.type === b.mission.type && a.twistIds.join() === b.twistIds.join()) {
      console.log(`  note: days ${d} and ${d + 1} share world, mission and twists`);
    }
  }
}

// ------------------------------------------------------------------ rules

if (mode === "all" || mode === "rules") {
  console.log("=== twist rules ===");
  let checked = 0;
  for (let d = today; d < today + 120; d++) {
    const day = G.generateDay(d);
    const tag = `day ${d} #${day.number} [${day.twistIds.join(",")}]`;
    const all = [day.refBuild, day.starter, ...Object.values(day.rivalBuilds)];
    for (const b of all) {
      const n = PARTS.partCounts(b);
      for (const k in n) {
        if (day.banned[k]) { fail(tag + " a build uses banned " + k); }
        if ((day.inventory[k] || 0) < n[k]) { fail(tag + " shed short of " + k + " for " + PARTS.buildKey(b)); }
      }
      if (D.violations(day, b).length) { fail(tag + " build breaks rules: " + D.violations(day, b).join(", ")); }
    }
    if (day.twistIds.includes("nolegs") && day.inventory.legs) { fail(tag + " legs in stock on a no-legs day"); }
    if (day.twistIds.includes("supplier")) {
      const engines = Object.keys(day.inventory).filter((k) => PARTS.PARTS[k].kind === "engine" || k === "pod");
      if (engines.length !== 1) { fail(tag + " single supplier stocks " + engines.join(",")); }
    }
    checked++;
  }
  console.log(`checked ${checked} days`);
}

// ------------------------------------------------------------------ board

if (mode === "all" || mode === "board") {
  console.log("=== rival board (20 days) ===");
  const wins = {}; let crashes = 0, spread = 0;
  for (let d = today; d < today + 20; d++) {
    const day = G.generateDay(d);
    const rows = G.board(day);
    const ok = rows.filter((r) => r.ok);
    crashes += rows.length - ok.length;
    const best = ok.reduce((a, r) => (!a || r.total > a.total ? r : a), null);
    if (best) { wins[best.id] = (wins[best.id] || 0) + 1; }
    const tot = ok.map((r) => r.total);
    spread += Math.max(...tot) - Math.min(...tot);
    for (const r of rows) {
      const a = G.flyBuild(day, r.build, r.id === "par" ? G.PAR_SKILL : G.RIVALS.find((x) => x.id === r.id).skill);
      if (S.ledger(a, day).total !== r.total) { fail(`day ${d} ${r.id} board result not reproducible`); }
    }
  }
  console.log("board winners:", JSON.stringify(wins), `rival crashes: ${crashes}`, `mean spread: $${Math.round(spread / 20)}`);
}

// ------------------------------------------------------------------ physics

if (mode === "all" || mode === "physics") {
  console.log("=== physics unit checks ===");
  const day = G.generateDay(today);
  const flat = { ...day, world: { ...day.world, rho0: 1.2, p0: 1, g: 9.8, wind: 0, gust: 0, scaleH: 7000 } };
  // a finned rocket is stable (CoP below CoM); a finless one is not
  const finned = { stack: [{ p: "nose" }, { p: "probe" }, { p: "tankM" }, { p: "tankM", r: "finsL" }, { p: "hornet", r: "legs" }] };
  const bare = { stack: [{ p: "nose" }, { p: "probe" }, { p: "tankM" }, { p: "tankM" }, { p: "hornet", r: "legs" }] };
  for (const [b, want] of [[finned, true], [bare, false]]) {
    const A = PARTS.assemble(b);
    const cp = PARTS.centreOfPressure(PARTS.aeroTerms(A.parts, false));
    const cg = PARTS.massProps(A.parts).s;
    if ((cp < cg) !== want) { fail(`stability of ${PARTS.buildKey(b)}: cp ${cp.toFixed(2)} cg ${cg.toFixed(2)}`); }
  }
  // staging splits mass and keeps momentum
  const two = { stack: [{ p: "probe" }, { p: "tankS" }, { p: "pip", r: "legs" }, { p: "decoupler", r: "chute" }, { p: "tankM" }, { p: "hornet" }] };
  const sim = P.createSim(flat, two);
  P.step(sim, { stage: true, throttle: 1 });
  for (let i = 0; i < 600; i++) { P.step(sim, { throttle: 1 }); }
  const m0 = sim.main.mp.m;
  P.step(sim, { stage: true, throttle: 1 });
  if (sim.debris.length !== 1) { fail("separation should leave one stage falling"); }
  if (!(sim.main.mp.m < m0)) { fail("separation should shed mass"); }
  if (!sim.main.parts.some((p) => p.lit && p.kind === "engine")) { fail("upper engine should light on separation"); }
  for (let i = 0; i < 120 * 60 && sim.debris.length && !sim.done; i++) { P.step(sim, { throttle: 0.3 }); }
  P.settleDebris(sim);
  const deb = sim.landed[0] || sim.wrecks[0];
  if (!deb) { fail("dropped stage never came down"); }
  else if (deb.chuteState !== "open" && deb.chuteState !== "torn") { fail("stage chute never opened"); }
  // rate-command rotation: let go of the stick and the spin stops
  const s2 = P.createSim(flat, finned);
  P.step(s2, { stage: true, throttle: 1 });
  for (let i = 0; i < 240; i++) { P.step(s2, { throttle: 1 }); }
  for (let i = 0; i < 60; i++) { P.step(s2, { throttle: 1, rot: 1 }); }
  for (let i = 0; i < 240; i++) { P.step(s2, { throttle: 1 }); }
  if (Math.abs(s2.main.angVel) > 0.05) { fail("spin should settle after release: " + s2.main.angVel.toFixed(3)); }
  // chutes tear above their limit
  const s3 = P.createSim(flat, { stack: [{ p: "probe", r: "chute" }, { p: "tankM" }, { p: "hornet", r: "legs" }] });
  P.step(s3, { stage: true, throttle: 1 });
  for (let i = 0; i < 120 * 14; i++) { P.step(s3, { throttle: 1 }); }
  P.step(s3, { throttle: 1, chute: true });
  if (s3.lastQ > PARTS.CHUTE_Q && s3.main.chuteState !== "torn") { fail("chute opened at q=" + s3.lastQ.toFixed(0)); }
  console.log("physics checks done");
}

// ------------------------------------------------------------------ today

if (mode === "today" || mode === "day") {
  const idx = mode === "day" ? parseInt(process.argv[3], 10) : today;
  const day = G.generateDay(idx);
  console.log(`Daily Rocket #${day.number} — ${day.world.name} (${day.world.atmo}) · ${day.mission.name} [${day.mission.type}] v${day.variant}`);
  console.log("  " + day.mission.brief);
  for (const t of day.twists) { console.log(`  TWIST ${t.name}: ${t.text}`); }
  console.log(`  g=${day.world.g} rho0=${day.world.rho0} wind=${day.world.wind * day.world.windDir}±${day.world.gust}`);
  console.log(`  fee $${day.fee}  deadline ${day.deadline}s  payload ${day.payload.name} ${day.payload.mass} kg`);
  console.log(`  shed: ${Object.entries(day.inventory).map(([k, n]) => k + "×" + n).join(" ")}`);
  console.log(`  reference: ${PARTS.buildKey(day.refBuild)}`);
  console.log(`  starter:   ${PARTS.buildKey(day.starter)}`);
  for (const l of day.par.lines) { console.log(`    ${l.label.padEnd(20)} ${String(l.value).padStart(8)}  ${l.detail}`); }
  console.log(`    ${"PAR".padEnd(20)} ${String(day.par.total).padStart(8)}`);
  for (const r of G.board(day)) {
    console.log(`  ${r.name.padEnd(26)} ${r.ok ? String(r.total).padStart(8) : ("lost " + r.outcome).padStart(8)}  ${PARTS.buildKey(r.build)}`);
  }
}

if (mode === "all") {
  console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURES`);
}
process.exitCode = failures === 0 ? 0 : 1;
