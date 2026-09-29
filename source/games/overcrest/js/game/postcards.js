/* Overcrest — postcards.
 *
 * "A landmark seen is a postcard earned — name, country, distance, seed,
 * and the light and weather it was seen in. Not achievements; a travel
 * diary."
 *
 * Two rules from the bible shape this, and both are about restraint:
 *
 *   "None of it advertised in UI. The codriver noticing is the entire
 *   announcement."
 * so nothing pops up while you drive. The banner already named the place.
 * A postcard is written silently and read afterwards.
 *
 *   "No FOMO. No dailies, no energy, no timed currency. Ever."
 * so a postcard unlocks nothing, gates nothing, and is never a number to
 * be maximised. It is the answer to "where have I been", which is the
 * question an endless driving game should leave you holding.
 *
 * What makes one worth keeping is the CIRCUMSTANCE. The Kiln Viaduct is a
 * place; the Kiln Viaduct at dawn in the rain, forty kilometres into a run,
 * is a memory — and the same landmark seen again in different light is
 * worth recording again, which is why the light and the weather are part
 * of a card's identity and the name alone is not.
 *
 * DOM-free. The gallery lives in `qs-oc-meta` and survives runs.
 */

const LIGHT = [
  [0.06, "before dawn"], [0.13, "at dawn"], [0.22, "in early light"],
  [0.42, "in the morning"], [0.56, "at midday"], [0.70, "in the afternoon"],
  [0.80, "at golden hour"], [0.88, "at dusk"], [0.96, "after dark"], [1.01, "before dawn"],
];

/* The weather worth naming. Ordinary is not worth naming: "in the rain"
 * earns its place in a sentence, "in some cloud" does not. */
function weatherWord(snap) {
  if (!snap) return "";
  if (snap.fog > 0.45) return "in fog";
  if (snap.rain > 0.35) return "in the rain";
  if (snap.rain > 0.12) return "in drizzle";
  if (snap.overcast > 0.6) return "under cloud";
  return "";
}

export function lightWord(u) {
  const x = ((u % 1) + 1) % 1;
  for (const [lim, word] of LIGHT) if (x < lim) return word;
  return "at midday";
}

/* The identity of a postcard: the same place in the same light is one
 * card, the same place at dusk in the rain is another. */
export function cardKey(c) {
  return `${c.name}|${c.light}|${c.weather}`;
}

export function makePostcard(ev, ctx) {
  return {
    name: ev.name,
    kind: ev.kind || (ev.def && ev.def.name) || "",
    key: ev.key,
    rarity: (ev.def && ev.def.rarity) || "uncommon",
    country: ctx.country,
    km: Math.round(ctx.s / 100) / 10,
    light: lightWord(ctx.u),
    weather: weatherWord(ctx.snap),
    seed: ctx.seed,
  };
}

/* "The Kiln Viaduct · Redgate, at dusk in the rain, 41.2 km in" */
export function describe(c) {
  const when = [c.light, c.weather].filter(Boolean).join(" ");
  return `${c.name} · ${c.country}, ${when}, ${c.km.toFixed(1)} km in`;
}

/* Watches the run and writes a card when the car is properly INSIDE a
 * landmark rather than merely near one — you have to have driven it. */
export function makePostcardBook(world, opts) {
  opts = opts || {};
  const found = [];                 // this journey, in order
  const seen = new Set();
  let cur = null;

  function keep(card) {
    const k = cardKey(card);
    if (seen.has(k)) return null;
    seen.add(k);
    found.push(card);
    if (opts.onFound) opts.onFound(card);
    return card;
  }

  function update(car, snap, u, seedStr) {
    const ev = world.eventAt ? world.eventAt(car.s) : null;
    if (!ev) { cur = null; return null; }
    if (ev === cur) return null;
    // a third of the way in: far enough that you have seen the thing
    if (car.s - ev.s0 < Math.min(180, (ev.s1 - ev.s0) * 0.34)) return null;
    cur = ev;
    const country = world.hereBiome && world.hereBiome.biome ? world.hereBiome.biome.name : "";
    return keep(makePostcard(ev, { country, s: car.s, u, snap, seed: seedStr }));
  }

  /* A sky event is a postcard too — "A Double Rainbow — Norrland, at
   * golden hour, 12.4 km in". The celestial system says when one has been
   * properly seen; the same dedupe rules apply, so the same sky in the
   * same light is one card. */
  function note(def, car, snap, u, seedStr) {
    const country = world.hereBiome && world.hereBiome.biome ? world.hereBiome.biome.name : "";
    return keep(makePostcard(
      { name: def.name, key: "sky-" + def.key, kind: "sky", def },
      { country, s: car.s, u, snap, seed: seedStr }
    ));
  }

  /* Resume: re-seat the cards a saved journey had already written. They
   * were found before the save — no onFound, no announcement — but they
   * must dedupe and stand in the summary as if the run had never been
   * interrupted. A postcard is a fact about the journey; a resume must
   * not be able to lose one. */
  function restore(cards) {
    for (const c of cards || []) {
      const k = cardKey(c);
      if (seen.has(k)) continue;
      seen.add(k);
      found.push(c);
    }
  }

  return { update, note, restore, found, count: () => found.length };
}

/* ------------------------------------------------------- the gallery */

/* Merge a journey's cards into the lifetime gallery, newest last, deduped
 * on the same identity. Capped generously — a travel diary that forgets
 * is a bug, but a localStorage entry that grows forever is also a bug. */
export function mergeGallery(gallery, cards) {
  const out = Array.isArray(gallery) ? gallery.slice() : [];
  const have = new Set(out.map(cardKey));
  for (const c of cards) {
    const k = cardKey(c);
    if (have.has(k)) continue;
    have.add(k);
    out.push(c);
  }
  return out.length > 400 ? out.slice(out.length - 400) : out;
}
