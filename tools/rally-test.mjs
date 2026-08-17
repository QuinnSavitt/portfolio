/* Daily Rally — validation harness.
 *
 * Run from the repo root:
 *   node tools/rally-test.mjs           full sweep (generation + bot drives)
 *   node tools/rally-test.mjs gen       generation sweep only
 *   node tools/rally-test.mjs drive     bot test drives only
 *   node tools/rally-test.mjs ladder    pace notes vs the input they need
 *   node tools/rally-test.mjs today     print today's stage + pace notes
 *
 * The gen sweep checks 61 consecutive days for validity and determinism.
 * The drive sweep runs the deterministic bot (the same one that gates
 * candidate selection in stage.js) through the real physics. The ladder check
 * drives a corner of every severity in every environment and confirms it
 * still needs the input its note promises - see tools/rally-ladder.mjs, and
 * run it directly for the full table.
 */
import { pathToFileURL } from "url";
import path from "path";

const jsDir = path.resolve(import.meta.dirname, "../source/games/gravl/js") + path.sep;
const base = pathToFileURL(jsDir).href;
const { generateStage } = await import(base + "track.js");
const { loadStage } = await import(base + "stage.js");
const { makeCar, resetCar, step, botInput, DT } = await import(base + "physics.js");
const { fmtTime, dayIndex } = await import(base + "daily.js");

const mode = process.argv[2] || "all";

function stageFingerprint(st) {
  let h = 0;
  const g = st.geo;
  for (let i = 0; i < g.n; i += 7) {
    h = (h * 31 + Math.round(g.x[i] * 100) + Math.round(g.z[i] * 100) * 7 + Math.round(g.y[i] * 100) * 13) | 0;
  }
  h = (h * 31 + st.notes.length + st.checkpoints.length * 7 + st.scenery.length * 13) | 0;
  return h;
}

function botDrive(st, skill, maxSeconds) {
  const car = makeCar();
  resetCar(car, st);
  let t = 0, offRoad = 0, maxDamage = 0, finished = false;
  const maxTicks = (maxSeconds || 180) * 120;
  for (let i = 0; i < maxTicks; i++) {
    step(car, st, botInput(car, st, st.profile, skill));
    t += DT;
    if (car.zone !== "road" && car.zone !== "shoulder") offRoad += DT;
    maxDamage = Math.max(maxDamage, car.damage);
    if (car.dead) return { finished: false, reason: "dead", t, offRoad, maxDamage, s: car.s };
    if (car.stuckT > 4) return { finished: false, reason: "stuck", t, offRoad, maxDamage, s: car.s };
    if (car.s >= st.finishS) { finished = true; break; }
  }
  return { finished, t, offRoad, maxDamage, s: car.s };
}

const startDay = dayIndex();

if (mode === "all" || mode === "gen") {
  console.log(`=== stage generation sweep (days ${startDay - 10}..${startDay + 50}) ===`);
  let bad = 0;
  for (let day = startDay - 10; day <= startDay + 50; day++) {
    const st = loadStage(day);
    const problems = [];
    if (st.issues) problems.push("FALLBACK:" + st.issues.join("/"));
    if (st.estSkilled < 44 || st.estSkilled > 80) problems.push("duration " + st.estSkilled.toFixed(1));
    if (!(st.length > 800 && st.length < 3500)) problems.push("length " + st.length);
    if (st.notes.length < 8) problems.push("notes " + st.notes.length);
    if (st.checkpoints.length < 5) problems.push("cps " + st.checkpoints.length);
    for (let i = 0; i < st.geo.n; i++) {
      if (!isFinite(st.geo.x[i]) || !isFinite(st.geo.y[i])) { problems.push("NaN"); break; }
    }
    if (stageFingerprint(st) !== stageFingerprint(loadStage(day))) problems.push("NON-DETERMINISTIC");
    if (problems.length) {
      bad++;
      console.log(`day ${day} #${st.number} ${st.env.id}: ${problems.join(", ")}`);
    }
  }
  console.log(bad === 0 ? "GEN SWEEP OK" : `GEN SWEEP: ${bad} problem days`);
}

if (mode === "all" || mode === "drive" || mode === "controls") {
  // steering handedness regression: dir=+1 (the D/right key) must move the
  // car toward +Z, which is SCREEN-RIGHT when driving +X in the Y-up frame
  const flat = {
    grip: { lat: 0.86, long: 0.88, B: 8.5, C: 1.65 },
    offroad: { lat: 0.6, long: 0.55, drag: 3.2 },
    surfKey: "gravel",
    groundHeight: () => ({ y: 0, on: "road", rq: { s: 0, d: 0, y: 0, hw: 100, camberT: 0, grade: 0, curv: 0, flag: 0, heading: 0, idx: 0 } }),
    colliderHash: new Map(),
  };
  const c = makeCar();
  c.vx = 20;
  for (let i = 0; i < 240; i++) step(c, flat, { dir: 1, throttle: 0.4, brake: 0, handbrake: false });
  console.log(c.z > 1 ? "CONTROLS OK (dir=+1 -> screen-right)" : "CONTROLS BROKEN: dir=+1 moved z=" + c.z.toFixed(2));
}

if (mode === "all" || mode === "drive") {
  console.log("\n=== bot test drives ===");
  let fails = 0;
  for (let i = 0; i < 9; i++) {
    const day = startDay + i * 3;
    const st = loadStage(day);
    const res = botDrive(st, 0.85);
    const ratio = res.t / st.botTime;
    const ok = res.finished && ratio < 1.6 && res.offRoad < 12;
    if (!ok) fails++;
    console.log(`day ${day} ${st.env.id.padEnd(8)} est=${fmtTime(st.botTime)} drove=${res.finished ? fmtTime(res.t) : "DNF@" + Math.round(res.s) + "m (" + res.reason + ")"} offroad=${res.offRoad.toFixed(1)}s dmg=${res.maxDamage.toFixed(0)} ${ok ? "OK" : "FAIL"}`);
  }
  console.log(fails === 0 ? "DRIVE SWEEP OK" : `DRIVE SWEEP: ${fails} fails`);
}

if (mode === "all" || mode === "ladder") {
  console.log("\n=== pace-note ladder ===");
  const { ladderCheck } = await import(pathToFileURL(path.resolve(import.meta.dirname, "rally-ladder.mjs")).href);
  const fails = ladderCheck(mode === "ladder");
  console.log(fails === 0 ? "LADDER OK" : `LADDER: ${fails} severities do not need what they promise`);
}

if (mode === "today") {
  const st = loadStage(startDay);
  console.log(`#${st.number} ${st.env.name} — ${st.stageName} — ${st.kmText} ${st.surfaceName} ${st.weather.label}`);
  console.log(`bot ${fmtTime(st.botTime)} · skilled ${fmtTime(st.estSkilled)} · casual ${fmtTime(st.estCasual)} · candidate ${st.pickedCandidate}`);
  for (const n of st.notes) {
    console.log(`  ${String(Math.round(n.s)).padStart(5)}m  ${n.label}${n.dist ? ", " + n.dist : ""}${n.into ? " -> into" : ""}${n.caution ? "  CAUTION" : ""}`);
  }
}
