/* Overcrest — pickups: small things on the road worth a twitch of the wheel.
 *
 *   wrench   — repair +15 condition
 *   canister — boost +35
 *   pennant  — shield: the next hit does no damage
 *   grit     — traction compound: +15% grip for 12 s
 *
 * Placement is deterministic per section (world side, culled with the
 * section) and reads THE DECK — `world.pickupMods`, written by the build
 * from ownership-only souvenir mods: how many things lie on the road and
 * which kinds. The world only generates past a waystation once a route is
 * chosen, and souvenirs are only taken at waystations, so every section is
 * placed from the same deck on a resume as it was live. Collection is a
 * proximity test around the car each tick; the build gets a "pickup" event
 * so souvenirs can duplicate or convert them. DOM-free.
 */

import { rng, hashCombine } from "../core/rng.js";
import { F_WAY } from "../world/roadgen.js";

export const PICKUP_KINDS = {
  wrench: { name: "Wrench", color: 0xffb454 },
  canister: { name: "Boost", color: 0xe0563f },
  pennant: { name: "Pennant", color: 0x7fd3c8 },
  grit: { name: "Grit", color: 0xb9c1c9 },
};

/* the stock deal — the deck multiplies these */
const BASE_W = { canister: 3, wrench: 2.2, grit: 1.4, pennant: 1 };

/* Called by the world when a section is appended. Returns pickups for it. */
export function placePickups(world, sec, i0, seed) {
  const r = rng(hashCombine(seed, 0x9a17 + sec.sectionIndex * 3));
  const { X, Z, Y, HD, KV, HW, FL, MASK } = world.ring;
  const out = [];
  const n = sec.n;
  // roughly one per 300 m, never in the first section, never on aprons or tight corners
  if (sec.sectionIndex === 0) return out;
  const pm = world.pickupMods || null;
  const dens = pm && pm.density > 0 ? pm.density : 1;
  const W = pm ? pm.w : BASE_W;
  const want = Math.max(0, Math.round(((n * world.DS) / 300) * dens + r.range(-0.6, 0.6)));
  const table = [
    { w: BASE_W.canister * (pm ? W.canister : 1), k: "canister" },
    { w: BASE_W.wrench * (pm ? W.wrench : 1), k: "wrench" },
    { w: BASE_W.grit * (pm ? W.grit : 1), k: "grit" },
    { w: BASE_W.pennant * (pm ? W.pennant : 1), k: "pennant" },
  ];
  for (let k = 0; k < want; k++) {
    const j = Math.floor(r.range(20, n - 20));
    const i = i0 + j, m = i & MASK;
    if (FL[m] & F_WAY) continue;
    if (Math.abs(KV[m]) > 0.009) continue;
    const kind = r.weighted(table).k;
    const lat = (r.chance(0.5) ? 1 : -1) * HW[m] * r.range(0.3, 0.6);
    const rx = -Math.sin(HD[m]), rz = Math.cos(HD[m]);
    // side: −1 left of centre, +1 right — souvenirs may care which
    out.push({ kind, x: X[m] + rx * lat, y: Y[m] + 0.85, z: Z[m] + rz * lat, s: (i + 1) * world.DS, side: Math.sign(lat), taken: false, sectionIndex: sec.sectionIndex });
  }
  return out;
}

/* Effects. `ctx` is the build context; R the run state. Returns a label. */
export function applyPickup(kind, ctx) {
  const R = ctx.R;
  if (kind === "wrench") { ctx.repair(15); return "Wrench +15"; }
  if (kind === "canister") { ctx.boost(35); return "Boost +35"; }
  if (kind === "pennant") { R.shield = true; return "Pennant: shielded"; }
  if (kind === "grit") { R.gritT = 12; return "Grit: grip up"; }
  return kind;
}

/* Per-tick collection. Iterates the few live sections around the car. */
export function collectPickups(world, car, build, onCollect) {
  const reach = 1.75 * (build.runMods.pickupMagnet || 1);
  const r2 = reach * reach;
  for (const sec of world.sections) {
    if (!sec.pickups || !sec.pickups.length) continue;
    if (sec.s1 < car.s - 30 || sec.s0 > car.s + 30) continue;
    for (const p of sec.pickups) {
      if (p.taken) continue;
      if (Math.abs(p.s - car.s) > 6) continue;
      const dx = p.x - car.x, dz = p.z - car.z;
      if (dx * dx + dz * dz > r2) continue;
      p.taken = true;
      const data = { kind: p.kind, side: p.side || 0, sliding: Math.abs(car.beta) > 0.25 && Math.abs(car.vx) > 8, repeat: false, echo: false, spawned: !!p.spawned };
      const label = applyPickup(p.kind, build.ctx);
      build.emit("pickup", data);
      if (data.repeat) { applyPickup(p.kind, build.ctx); build.emit("pickup", Object.assign({}, data, { echo: true, repeat: false })); }
      if (onCollect) onCollect(p, label + (data.repeat ? " ×2" : ""));
    }
  }
}
