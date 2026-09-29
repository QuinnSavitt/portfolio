/* Overcrest — save & resume.
 *
 * A run is reconstructible from its seed and its route choices, so the
 * save is tiny: seed, choices, run stats, and the car's damage. Resume
 * puts you back at the last waystation with the world rebuilt around it.
 * Namespace qs-oc-* (shared domain; nothing else is shared).
 */

const KEY = "qs-oc-run";
const META = "qs-oc-meta";
const VERSION = 1;

/* THE STORAGE SEAM (Addendum II: two storefronts, one game). Everything the
 * game ever persists — run save, meta, and through meta the settings,
 * keybinds and postcard gallery — passes through store(), under the two keys
 * above. In the browser this resolves to localStorage. A desktop shell
 * substitutes real files by defining `window.OVERCREST_STORAGE` before the
 * modules load: an object with the Storage shape — getItem(k), setItem(k, v),
 * removeItem(k), synchronous, string-valued. The shell mirrors its files into
 * memory at boot and flushes writes behind the scenes; synchronous is the
 * contract because saves happen inside the arrival tick and reads at boot,
 * and an async seam would restructure main — i.e. fork the game.
 * Do not add another storage call site anywhere. */
function store() {
  return (typeof window !== "undefined" && window.OVERCREST_STORAGE) || localStorage;
}

export function saveRun(data) {
  try { store().setItem(KEY, JSON.stringify(Object.assign({ v: VERSION, at: Date.now() }, data))); } catch (e) { /* private mode etc. */ }
}
export function loadRun() {
  try {
    const raw = store().getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (d.v !== VERSION) return null;
    return d;
  } catch (e) { return null; }
}
export function clearRun() {
  try { store().removeItem(KEY); } catch (e) { /* ignore */ }
}

export function loadMeta() {
  try { return JSON.parse(store().getItem(META) || "{}") || {}; } catch (e) { return {}; }
}
export function saveMeta(meta) {
  try { store().setItem(META, JSON.stringify(meta)); } catch (e) { /* ignore */ }
}
export function recordBest(stats) {
  const m = loadMeta();
  m.runs = (m.runs || 0) + 1;
  /* the two modes keep their own books (owner: the Sweep is a mode of its
   * own, not a side mode): a Sweep distance is a different achievement
   * from a Drive distance, and the title and gallery say so */
  if (stats.mode === "sweep") {
    m.sweepRuns = (m.sweepRuns || 0) + 1;
    m.bestSweepDist = Math.max(m.bestSweepDist || 0, stats.dist);
    m.bestSweepScore = Math.max(m.bestSweepScore || 0, stats.score);
    m.bestSweepWaystations = Math.max(m.bestSweepWaystations || 0, stats.waystations);
  } else {
    m.bestDist = Math.max(m.bestDist || 0, stats.dist);
    m.bestScore = Math.max(m.bestScore || 0, stats.score);
    m.bestWaystations = Math.max(m.bestWaystations || 0, stats.waystations);
  }
  m.totalDist = (m.totalDist || 0) + stats.dist;
  /* the diary remembers every country ever crossed — the heirloom
   * souvenirs read this (between-run progression, with restraint) */
  if (stats.countries && stats.countries.length) {
    const set = new Set(m.countriesEver || []);
    for (const c of stats.countries) set.add(c);
    m.countriesEver = [...set];
  }
  saveMeta(m);
  return m;
}
