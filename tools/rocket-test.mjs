/* Daily Rocket — validation harness.
 *
 * Run from the repo root:
 *   node tools/rocket-test.mjs            full sweep (gen + bot flights + loadouts)
 *   node tools/rocket-test.mjs gen        generation sweep only
 *   node tools/rocket-test.mjs fly        bot flight sweep only
 *   node tools/rocket-test.mjs loadouts   every engine flies on a spread of days
 *   node tools/rocket-test.mjs today      print today's mission + bot flight detail
 *
 * The gen sweep checks 61 consecutive days for validity and determinism. The
 * fly sweep re-runs the same deterministic autopilot that gates generation
 * (gen.js auditions candidates with it), so a red day here means a day that
 * would ship broken. The loadout sweep proves no engine choice is a trap.
 */
import { pathToFileURL } from "url";
import path from "path";

const jsDir = path.resolve(import.meta.dirname, "../source/games/rocket/js") + path.sep;
const base = pathToFileURL(jsDir).href;
const { generateDay, flyBot, REF_LOADOUT, BOT_SKILL } = await import(base + "gen.js");
const { dayIndex } = await import(base + "daily.js");
const { TANK_CAP, ENGINES } = await import(base + "physics.js");
const { score, medalFor } = await import(base + "score.js");

const mode = process.argv[2] || "all";
const startDay = dayIndex();
let failures = 0;

function fingerprint(day) {
  let h = 0;
  const t = day.terrain;
  for (let i = 0; i < t.n; i += 5) {
    h = (h * 31 + Math.round(t.heights[i] * 100)) | 0;
  }
  h = (h * 31 + day.pad.x + day.pad.halfW * 7) | 0;
  for (const b of day.beacons) { h = (h * 31 + b.x + b.y * 7) | 0; }
  h = (h * 31 + Math.round(day.world.g * 1000) + Math.round(day.world.wind * 10) * 13) | 0;
  return h;
}

function flightPrint(ship) {
  return [ship.outcome, ship.collected, Math.round(ship.t * 100),
    Math.round(ship.fuelBurned * 100), Math.round(ship.x * 10)].join("/");
}

function checkDay(idx) {
  const problems = [];
  const day = generateDay(idx);
  const t = day.terrain;

  for (let i = 0; i < t.n; i++) {
    if (!Number.isFinite(t.heights[i])) { problems.push("NaN terrain"); break; }
  }
  // pad shelf must be genuinely flat
  for (let x = day.pad.x - day.pad.halfW; x <= day.pad.x + day.pad.halfW; x += 10) {
    if (Math.abs(t.slopeAt(x)) > 0.02) { problems.push("pad not flat @" + x); break; }
  }
  for (let x = -80; x <= 80; x += 20) {
    if (Math.abs(t.slopeAt(x)) > 0.02) { problems.push("launch shelf not flat"); break; }
  }
  for (const b of day.beacons) {
    if (b.y - t.heightAt(b.x) < 55) { problems.push("beacon too low @" + b.x); }
  }
  if (!day.par.ok) { problems.push("AUDITION FAILED even at gentlest variant"); }
  if (day.par.time < 15 || day.par.time > 240) { problems.push("par time " + day.par.time); }
  if (fingerprint(day) !== fingerprint(generateDay(idx))) { problems.push("NON-DETERMINISTIC"); }
  return { day, problems };
}

if (mode === "all" || mode === "gen") {
  console.log(`=== generation sweep (days ${startDay - 10}..${startDay + 50}) ===`);
  let bad = 0;
  const variants = [0, 0, 0, 0];
  for (let d = startDay - 10; d <= startDay + 50; d++) {
    const { day, problems } = checkDay(d);
    variants[day.variant]++;
    if (problems.length) {
      bad++; failures++;
      console.log(`day ${d} #${day.number} ${day.world.id}: ${problems.join(", ")}`);
    }
  }
  console.log(`variants used: v0=${variants[0]} v1=${variants[1]} v2=${variants[2]} v3=${variants[3]}`);
  console.log(bad === 0 ? "GEN SWEEP OK" : `GEN SWEEP: ${bad} problem days`);
}

if (mode === "all" || mode === "fly") {
  console.log(`=== bot flight sweep (days ${startDay - 10}..${startDay + 50}) ===`);
  let bad = 0;
  let minScore = Infinity, minDay = -1;
  for (let d = startDay - 10; d <= startDay + 50; d++) {
    const day = generateDay(d);
    const ship = flyBot(day, REF_LOADOUT, BOT_SKILL);
    const problems = [];
    if (ship.outcome !== "landed") { problems.push("outcome " + ship.outcome + " (" + ship.message + ")"); }
    if (ship.collected < day.beacons.length) { problems.push("beacons " + ship.collected); }
    const loaded = TANK_CAP * REF_LOADOUT.fuelFrac;
    if (ship.fuel < loaded * 0.05) { problems.push("fuel margin " + (ship.fuel / loaded * 100).toFixed(1) + "%"); }
    if (flightPrint(ship) !== flightPrint(flyBot(day, REF_LOADOUT, BOT_SKILL))) {
      problems.push("NON-DETERMINISTIC FLIGHT");
    }
    if (ship.outcome === "landed") {
      const sc = score(ship, day);
      if (sc.total < minScore) { minScore = sc.total; minDay = d; }
      if (sc.total < 6000) { problems.push("bot score only " + sc.total); }
    }
    if (problems.length) {
      bad++; failures++;
      console.log(`day ${d} #${day.number} ${day.world.id} v${day.variant}: ${problems.join(", ")}`);
    }
  }
  if (minDay >= 0) { console.log(`weakest bot score: ${minScore} on day ${minDay}`); }
  console.log(bad === 0 ? "FLY SWEEP OK" : `FLY SWEEP: ${bad} problem days`);
}

if (mode === "all" || mode === "loadouts") {
  console.log("=== loadout sweep (every engine must be able to fly) ===");
  const configs = [
    { engine: "sparrow", fuelFrac: 0.65 },
    { engine: "kestrel", fuelFrac: 0.7 },
    { engine: "mule", fuelFrac: 0.85 }
  ];
  let bad = 0;
  for (let d = startDay; d < startDay + 20; d += 2) {
    const day = generateDay(d);
    for (const cfg of configs) {
      const ship = flyBot(day, cfg, BOT_SKILL);
      if (ship.outcome !== "landed") {
        bad++; failures++;
        console.log(`day ${d} ${day.world.id} v${day.variant} ${cfg.engine}@${cfg.fuelFrac}: ` +
          `${ship.outcome} (${ship.message}) beacons=${ship.collected} t=${ship.t.toFixed(0)}`);
      }
    }
  }
  console.log(bad === 0 ? "LOADOUT SWEEP OK" : `LOADOUT SWEEP: ${bad} failures`);
}

if (mode === "today") {
  const day = generateDay(startDay);
  console.log(`Daily Rocket #${day.number} — ${day.world.name} (${day.world.atmo})`);
  console.log(`  mission: ${day.mission.name}, pad at ${day.pad.x} m (±${day.pad.halfW} m), variant ${day.variant}`);
  console.log(`  g=${day.world.g} rho0=${day.world.rho0} wind=${day.world.wind}±${day.world.gust} dir=${day.world.windDir}`);
  console.log(`  beacons: ${day.beacons.map((b) => b.x + "," + b.y).join("  ")}`);
  console.log(`  par: ${day.par.time} s, ${day.par.fuel} kg (audition ok=${day.par.ok})`);
  const ship = flyBot(day, REF_LOADOUT, BOT_SKILL);
  const sc = ship.outcome === "landed" ? score(ship, day) : null;
  console.log(`  bot: ${ship.outcome} in ${ship.t.toFixed(1)} s, burned ${ship.fuelBurned.toFixed(0)} kg, ` +
    `beacons ${ship.collected}/3, touchdown ${ship.landing ? ship.landing.speed.toFixed(2) + " m/s" : "—"}`);
  if (sc) {
    const medal = medalFor(sc.total, false);
    console.log(`  bot score: ${sc.total} (${medal ? medal.label : "none"})`);
    for (const l of sc.lines) { console.log(`    ${l.label.padEnd(14)} +${l.value}  ${l.detail}`); }
  }
}

if (mode === "all") {
  console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURES`);
  process.exitCode = failures === 0 ? 0 : 1;
}
