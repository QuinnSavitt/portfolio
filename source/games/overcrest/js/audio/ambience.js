/* Overcrest — the ambience plan: the country's voice, decided purely.
 *
 * Same split as the music: this file DECIDES (pure, DOM-free, harness-
 * tested) and audio.js realizes. The inputs are the blended biome
 * profile, the clock, the weather and where the car is; the outputs are
 * bed gains and one-shot activities, every gate written once:
 *
 *   birds sing by day and shelter from rain · owls own the night ·
 *   crickets own warm dusks, cicadas own hot days, neither sings in
 *   snow · gulls work the sea light, the loon calls across dark water ·
 *   the curlew cries over the moor, rain or shine — it IS the moor ·
 *   cowbells drift over day pasture · lake ice booms in the night
 *   cold · a bore has no weather, only drips · the land's own wind
 *   carries a little even at speed; the small voices don't.
 *
 * st: { a: {wind, sea, forest, birds, crickets, cicada, gull, owl,
 *           curlew, corvid, cowbell, ice, loon, raptor, strange},
 *       night, rain, overcast, snow 0..1, parked, waystation bool,
 *       speed m/s, encl 0..1 }
 */

export const AMB_BEDS = ["wind", "whistle", "sea", "forest", "rain"];
export const AMB_CALLS = ["birds", "owl", "gull", "curlew", "corvid", "cowbell", "ice", "loon", "raptor", "strange"];

const c01 = (x) => Math.max(0, Math.min(1, x));

export function ambiencePlan(st) {
  const a = st.a || {};
  const night = c01(st.night || 0), rain = c01(st.rain || 0);
  const overcast = c01(st.overcast || 0), snow = c01(st.snow || 0), storm = c01(st.storm || 0);
  const encl = c01(st.encl || 0), speed = st.speed || 0;
  const day = c01(1 - night * 1.4);
  const dark = c01(night * 1.3);

  /* the duck: ambience belongs to slow moments — it fades under speed
   * and a bore silences the outside entirely. The land's larger voices
   * (wind, sea, forest, the verge's strangeness) keep a small floor at
   * speed; the delicate ones vanish. */
  const duck = (st.parked ? 1 : c01(1 - speed / 30)) * (1 - encl);
  const open = Math.max(duck, 0.18 * (1 - encl));

  return {
    duck,
    // ---- beds
    // a storm is wind first: it swells whatever the country has, and even
    // a sheltered valley gets some — and it is never ducked under speed
    wind: c01((a.wind || 0) * (0.55 + overcast * 0.45) + storm * 0.55) * Math.max(open, storm * 0.7),
    whistle: c01((a.wind || 0) * snow * 0.9 + storm * 0.22) * open,       // cold wind sings (and a gale does)
    sea: c01(a.sea || 0) * open,
    forest: c01((a.forest || 0) * (0.6 + overcast * 0.4)) * open,
    rain: Math.min(1.4, rain * (1 + storm * 0.4)) * (1 - encl),   // never ducked: it falls on you
    crickets: c01((a.crickets || 0) * dark * (1 - rain) * (1 - snow)) * duck,
    cicada: c01((a.cicada || 0) * day * (1 - overcast * 0.6) * (1 - rain) * (1 - snow)) * duck,
    // ---- the room, at a stop
    roof: st.parked && st.waystation ? rain : 0,
    shop: st.waystation ? 1 : 0,
    // ---- one-shot activities
    birds: c01((a.birds || 0) * day * (1 - rain * 0.85)) * duck,
    owl: c01((a.owl || 0) * (Math.max(0, night - 0.35) / 0.65) * (1 - rain)) * duck,
    gull: c01((a.gull || 0) * day * (1 - rain * 0.6)) * duck,
    curlew: c01((a.curlew || 0) * day * (1 - rain * 0.35)) * duck,
    corvid: c01((a.corvid || 0) * (0.35 + 0.65 * day) * (1 - rain * 0.5)) * duck,
    cowbell: c01((a.cowbell || 0) * day) * duck,
    ice: c01((a.ice || 0) * dark) * duck,
    loon: c01((a.loon || 0) * dark * (1 - rain)) * duck,
    raptor: c01((a.raptor || 0) * day * (1 - overcast * 0.7)) * duck,
    strange: c01((a.strange || 0) * (0.7 + 0.3 * dark)) * Math.max(duck, 0.3 * (1 - encl)),
    // ---- the bore's own voice: water finding its way in. NOT ducked —
    // it is the one ambience that lives inside.
    drip: c01((encl - 0.45) / 0.55),
  };
}
