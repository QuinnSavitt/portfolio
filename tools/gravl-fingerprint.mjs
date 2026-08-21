/* Gravl — stage fingerprint.
 *
 * Prints a content hash of the generated stage for a run of days. Its whole
 * purpose is regression safety around the deterministic daily: generation
 * draws from several seeded RNG streams, and adding a draw to an existing
 * stream silently reshuffles every stage that has ever been published. Take a
 * baseline before touching track.js, compare after:
 *
 *   node tools/gravl-fingerprint.mjs > before.txt
 *   ...make changes...
 *   node tools/gravl-fingerprint.mjs > after.txt
 *   diff before.txt after.txt
 *
 * A new axis of variation should add its own stream (seeded from the base
 * seed with its own constant) so this diff stays empty.
 */
import { pathToFileURL } from "url";
import path from "path";

const here = process.cwd();
const url = (p) => pathToFileURL(path.join(here, p)).href;

const { generateStage } = await import(url("source/games/gravl/js/track.js"));

const DAYS = Number(process.argv[2] || 60);

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/* Everything that defines the road and the run. Deliberately includes the
 * geometry and checkpoints, not just the headline facts, so a reshuffle that
 * happens to keep the same name and weather is still caught. */
function fingerprint(st) {
  const geo = st.geo;
  const parts = [
    st.env.id, st.stageName, st.weatherId, st.surfKey,
    st.length.toFixed(3), st.profile.time.toFixed(4),
    String(st.pickedCandidate), String(st.candidatesTried),
    st.checkpoints.map((c) => (c.s != null ? c.s.toFixed(2) : String(c))).join(","),
    st.splitS.map((s) => s.toFixed(2)).join(","),
  ];
  let g = "";
  // Sample the geometry rather than hashing all of it: a change to generation
  // moves everything, and this keeps the script fast across 60 days.
  for (let i = 0; i < geo.n; i += Math.max(1, Math.floor(geo.n / 400))) {
    g += geo.x[i].toFixed(2) + "," + geo.y[i].toFixed(2) + "," + geo.z[i].toFixed(2) + ";";
  }
  parts.push(hashStr(g));
  return parts.join("|");
}

for (let day = 0; day < DAYS; day++) {
  const st = generateStage(day);
  console.log(String(day).padStart(3, " ") + "  " + hashStr(fingerprint(st)) + "  " + fingerprint(st));
}
