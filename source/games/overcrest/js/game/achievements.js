/* Overcrest — achievements.
 *
 * The marshals' book. A hundred and thirty-odd things a journey can be
 * marked for, in three grammars (owner, 2026-08-31: "85% something that
 * takes skill of varying degrees, 10% that come from unique situations,
 * and 5% that are funny"):
 *
 *   SKILL    the road, the zone, the wheel, the weather, the build, the
 *            sweep, the crew: things you DID, from the first waystation to
 *            a hundred and fifty kilometres. Listed in the book from the
 *            start, so they read as things to try.
 *   MOMENT   things that happened to you: an eclipse, the Verge, the old
 *            road, a strange outpost. Unannounced until they happen (the
 *            bible: the codriver noticing is the whole advertisement).
 *   FUNNY    the codriver's thousandth "over crest", the turbo's five
 *            hundredth sigh, a ten-minute coffee. Also unannounced, because
 *            a joke you can see coming is not one.
 *
 * Two ledgers feed the tests: J, the JOURNEY (rides the run save, so a
 * resume never loses "near misses this journey"), and L, the LIFETIME
 * (qs-oc-meta.achLife). Both are written from typed events and a 4 Hz
 * snapshot of the sim, in SIM time, so a fast-forward or a headless run
 * agrees with a live one. Achievements read the run and never feed back
 * into it: the sim is exactly as deterministic as it was.
 *
 * Every entry carries its own PROOF: a mutation of the zero ledgers that
 * must make its test pass. The harness (`achievements` mode) runs every
 * proof against its own test and every test against the zero ledgers, so
 * no achievement is dead and none is free. DOM-free.
 */

export const KINDS = { skill: "skill", moment: "moment", funny: "funny" };

/* the book's chapters, in reading order */
export const GROUPS = [
  ["road", "The Road"], ["zone", "The Zone"], ["wheel", "The Wheel"],
  ["weather", "Weather and Night"], ["journey", "The Journey"], ["sky", "The Sky"],
  ["build", "The Build"], ["ends", "The Three Ends"], ["sweep", "The Sweep"],
  ["crew", "The Crew"], ["codriver", "The Codriver"],
];

/* the two countries the tests name by key, and the six ends */
export const REAL_COUNTRIES = ["norrland", "costa", "redgate", "thornmoor", "heartland", "aspenvale", "kaldbrekka", "sandreach", "highline", "cauldron", "kurotani", "ventisca"];
export const ALL_LANDMARKS = ["tunnels", "viaduct", "village", "suspension", "saltflat", "descent", "pass", "windfarm", "ford", "canyon", "circuit", "observatory", "levelcrossing", "radiomast", "monastery", "wreck", "damroad", "flooded", "detour", "stadium", "gallery", "frozenlake", "avalanche", "hamlet", "town"];
export const ALL_SKIES = ["meteors", "aurora", "lightning", "rainbow", "inversion", "eclipse"];
export const ALL_ENDS = ["wrecked", "swept", "rolled", "drowned", "fell", "stranded"];
export const CREW_SHOTS = ["trackside", "brow", "reveal", "crane", "chopper", "flyover"];
export const ALL_SURFACES = ["tarmac", "gravel", "dirt", "snow", "ice", "mud"];
export const ALL_PARTS = ["rally-tyres", "big-brakes", "intake", "soft-springs", "ballast", "slick-body", "mud-flaps", "harness-pads"];
export const FABLED_IDS = ["perpetual-motion", "the-long-now", "meridian-stone", "the-open-road", "compound-interest", "deja-vu", "rosetta-stone", "odometer-of-babel", "marshals-wave"];

/* ------------------------------------------------------------ ledgers */

export function zeroJourney() {
  return {
    dist: 0, ws: 0, score: 0, topKmh: 0, air: 0, drift: 0, clean: 0, hits: 0, driveTime: 0,
    leg: 0, legStartDist: 0, legMinTier: 9, zoneLeg: false,
    drifts2s: 0, swChain: 0, swBest: 0, cDrifted: 0, hpDrift: 0, hpClean: 0, cClean: 0, cStreak: 0, cStreakBest: 0,
    cleanLand: 0, nearMiss: 0, nearFast: 0, pickups: 0, pickSlide: 0, legKinds: {}, fullSet: false,
    boostBest: 0, emptied: false, pushZone: false, t5Best: 0, t5: 0, t4Sec: 0, grace: 0, noBrakeBest: 0, g6: 0, g6Best: 0,
    surfaces: [], fordFast: false, iceDrift: 0, offT: 0, offReturn: false, nightAir: false, jumpFast: false,
    nightKm: 0, rainKm: 0, stormKm: 0, fogKm: 0, snowKm: 0, coldKm: 0, tunnelKm: 0,
    dawns: 0, sunrises: 0, nightSinceDawn: 0, midnights: 0, fullDay: false,
    legStormKm: 0, legStormHits: 0, stormLegClean: false, wetStreak: 0, wetBest: 0, nightT5: false,
    countries: [], landmarks: [], regions: [], postcards: 0, kaldNight: false, verge: false, vergeBack: false,
    cleanLandmarks: {}, evKey: null, evHits0: 0, suspensionFast: false, flatsFast: false, stadiumDrift: false,
    icedOn: false, icedHits0: 0, icedClean: false, overpass: false,
    skies: [], obsMeteors: false, townNight: false, oldRoad: false, outposts: 0,
    souvenirs: [], parts: [], rar: {}, tags: {}, declined: 0, services: 0, freeAnswers: 0, firesMax: 0, stockKm: 0,
    rolls: 0, rollWheels: 0, rollAt: -1, rollThen10: false, pushes: 0, tows: 0, incidents: 0, savesUsed: 0,
    sweep: false, sweepWs: 0, sweepMax: 0, sweepClose: false, sweepCloseBack: false, sweepD3: 0,
    shots: [], album: 0, minimalKm: 0, lateKm: 0,
    crest: 0, blow: 0, reverseM: 0, wsRealMax: 0, wreckLeg: -1, marshalled: 0, rollFirstKm: false, sameThing: false, hitLog: {},
    feelsGood: false, end: null, endCond: 0,
  };
}

export function zeroLife() {
  return {
    journeys: 0, km: 0, crest: 0, blow: 0, nice: 0, goodSave: 0,
    landmarks: [], skies: [], countries: [], souvenirs: [], fabled: [], shots: [], ends: {}, postcards: 0,
    rolls: 0, rescues: 0, sweepBestWs: 0,
  };
}

/* the sim snapshot the tracker is fed at 4 Hz (see main.js achSnapshot) */
export function zeroNow() {
  return {
    dt: 0, time: 0, kmh: 0, vx: 0, beta: 0, zone: "road", surface: "tarmac", gear: 1, deepOff: 0,
    flow: 0, tier: 0, boost: 0, boostOn: false, pushing: false, dist: 0, ws: 0, score: 0, cleanCur: 0, driveTime: 0,
    condition: 100, hits: 0, incidents: 0, rolls: 0, savesUsed: 0, savesLeft: 0, leg: 0,
    sweepOn: false, sweepMargin: 999, night: 0, golden: 0, rain: 0, fog: 0, storm: 0, u: 0.335, wet: 0, cold: 0, snow: 0,
    encl: 0, span: null, event: null, country: "heartland", region: null, skyNow: null,
    souvenirs: [], parts: [], firesMax: 0, noBrake: 0, verbosity: "full", timing: "normal",
    autoBoost: false, album: 0,
  };
}

/* ------------------------------------------------------------ helpers */

const get = (S, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), S);
const set = (S, path, v) => {
  const ks = path.split("."), last = ks.pop();
  let o = S;
  for (const k of ks) o = o[k] == null ? (o[k] = {}) : o[k];
  o[last] = v;
};
/* a threshold on one number, a flag, or the size of a set */
const T = (path, min) => ({ test: (S) => (get(S, path) || 0) >= min, proof: (S) => set(S, path, min) });
const F = (path) => ({ test: (S) => !!get(S, path), proof: (S) => set(S, path, true) });
const N = (path, n, fill) => ({
  test: (S) => ((get(S, path) || []).length) >= n,
  proof: (S) => set(S, path, (fill || []).slice(0, n).concat(Array.from({ length: Math.max(0, n - (fill || []).length) }, (_, i) => "x" + i))),
});
/* every member of a list is present in a set */
const ALL = (path, list) => ({
  test: (S) => { const a = get(S, path) || []; return list.every((k) => a.includes(k)); },
  proof: (S) => set(S, path, list.slice()),
});

const A = (group, id, name, desc, spec, extra) => Object.assign({ id, group, name, desc, kind: "skill" }, spec, extra || {});
const M = (group, id, name, desc, spec) => A(group, id, name, desc, spec, { kind: "moment" });
const FUN = (group, id, name, desc, spec) => A(group, id, name, desc, spec, { kind: "funny" });

/* ------------------------------------------------------------ the book */

export const ACHIEVEMENTS = [
  // ------------------------------------------------------------ the road
  A("road", "pull-in", "Pull In", "Reach the first waystation.", T("J.ws", 1)),
  A("road", "ten-km", "Ten Kilometres", "Ten kilometres in one journey.", T("J.dist", 10000)),
  A("road", "fifty-km", "The Fifty", "Fifty kilometres in one journey.", T("J.dist", 50000)),
  A("road", "hundred-km", "The Long Hundred", "A hundred kilometres in one journey.", T("J.dist", 100000)),
  A("road", "hundred-fifty-km", "Beyond the Map", "A hundred and fifty kilometres in one journey.", T("J.dist", 150000)),
  A("road", "five-stops", "Five Stops", "Five waystations in one journey.", T("J.ws", 5)),
  A("road", "ten-stops", "Ten Stops", "Ten waystations in one journey.", T("J.ws", 10)),
  A("road", "twenty-stops", "Twenty Stops", "Twenty waystations. The last save the road hands out.", T("J.ws", 20)),
  A("road", "thirty-stops", "Thirty Stops", "Thirty waystations in one journey.", T("J.ws", 30)),
  A("road", "forty-stops", "The Forty", "Forty waystations in one journey.", T("J.ws", 40)),
  A("road", "score-25k", "Twenty-Five Thousand", "Twenty-five thousand points in one journey.", T("J.score", 25000)),
  A("road", "score-150k", "A Hundred and Fifty Thousand", "A hundred and fifty thousand points in one journey.", T("J.score", 150000)),
  A("road", "called-it", "Called It a Day", "End a journey by choice at thirty kilometres or more, the car above half.",
    { test: (S) => S.J.end === "parked" && S.J.dist >= 30000 && S.J.endCond >= 50, proof: (S) => { S.J.end = "parked"; S.J.dist = 30000; S.J.endCond = 50; } }),
  A("road", "life-1000", "A Thousand Kilometres", "A thousand kilometres, all journeys told.", T("L.km", 1000)),
  A("road", "through-the-mountain", "Through the Mountain", "Two kilometres of tunnel in one journey.", T("J.tunnelKm", 2000)),

  // ------------------------------------------------------------ the zone
  A("zone", "the-zone", "The Zone", "Reach the top of the flow.", T("J.t5Best", 0.25)),
  A("zone", "held-it", "Held It", "Hold the top of the flow for a minute.", T("J.t5Best", 60)),
  A("zone", "three-minutes-up", "Three Minutes Up There", "Hold the top of the flow for three minutes.", T("J.t5Best", 180)),
  A("zone", "whole-leg", "Whole Leg in the Zone", "A whole leg without the flow dropping below the third tier.", F("J.zoneLeg")),
  A("zone", "shrugged", "Shrugged", "The zone absorbed a hit for you.", T("J.grace", 1)),
  A("zone", "five-clean", "Five Clean", "Five kilometres without touching a thing.", T("J.clean", 5000)),
  A("zone", "ten-clean", "Ten Clean", "Ten kilometres without touching a thing.", T("J.clean", 10000)),
  A("zone", "twenty-clean", "Twenty Clean", "Twenty kilometres without touching a thing.", T("J.clean", 20000)),
  A("zone", "untouched", "Untouched", "A journey of fifteen kilometres or more without a single hit.",
    { test: (S) => S.J.end != null && S.J.dist >= 15000 && S.J.hits === 0, proof: (S) => { S.J.end = "parked"; S.J.dist = 15000; S.J.hits = 0; } }),
  A("zone", "feet-off", "Feet Off", "Thirty seconds at pace without touching the brake.", T("J.noBrakeBest", 30)),
  A("zone", "the-manifesto", "One Pedal", "Ninety seconds at pace without touching the brake.", T("J.noBrakeBest", 90)),
  A("zone", "emptied", "Emptied", "A full bar of boost, spent in one press.", F("J.emptied")),
  A("zone", "long-push", "Long Push", "Eight seconds of boost in one press. It takes a build.", T("J.boostBest", 8)),
  A("zone", "pushed-into-it", "Pushed Into It", "Reach the top of the flow under the push.", F("J.pushZone")),
  A("zone", "litter-pick", "Litter Pick", "Seventy-five pickups in one journey.", T("J.pickups", 75)),
  A("zone", "sideways-shopping", "Sideways Shopping", "Ten pickups taken mid-slide in one journey.", T("J.pickSlide", 10)),

  // ----------------------------------------------------------- the wheel
  A("wheel", "sideways", "Sideways", "A slide held for two seconds.", T("J.drifts2s", 1)),
  A("wheel", "the-long-way-round", "The Long Way Round", "A slide held for eight seconds.", T("J.drift", 8)),
  A("wheel", "pendulum", "Pendulum", "Three clean slide switches in a row.", T("J.swBest", 3)),
  A("wheel", "scandinavian", "Scandinavian", "Six clean slide switches in a row.", T("J.swBest", 6)),
  A("wheel", "hairpin-sideways", "Hairpin, Sideways", "A hairpin drifted clean.", T("J.hpDrift", 1)),
  A("wheel", "handbrake-turn", "Handbrake Turn", "A hairpin taken clean on the handbrake.", F("J.hbHairpin")),
  A("wheel", "forty-in-a-row", "Forty in a Row", "Forty clean corners without a dirty one between.", T("J.cStreakBest", 40)),
  A("wheel", "hundred-in-a-row", "A Hundred in a Row", "A hundred clean corners without a dirty one between.", T("J.cStreakBest", 100)),
  A("wheel", "airborne", "Airborne", "A second and a half in the air.", T("J.air", 1.5)),
  A("wheel", "big-air", "Big Air", "Two and a half seconds in the air.", T("J.air", 2.5)),
  A("wheel", "flight", "Flight", "Three and a half seconds in the air.", T("J.air", 3.5)),
  A("wheel", "sent-it", "Sent It", "A real jump landed clean at over a hundred and twenty.", F("J.jumpFast")),
  A("wheel", "one-eighty-five", "One Eighty-Five", "A hundred and eighty-five on the clock.", T("J.topKmh", 185)),
  A("wheel", "two-hundred", "Two Hundred", "Two hundred on the clock.", T("J.topKmh", 200)),
  A("wheel", "bore-at-speed", "Bore at Speed", "A hundred and fifty inside a tunnel.", F("J.tunnelFast")),
  A("wheel", "ice-runner", "Ice Runner", "A hundred and twenty on ice.", F("J.iceFast")),
  A("wheel", "into-the-weather", "Into the Weather", "A hundred and sixty in a storm.", F("J.stormFast")),
  A("wheel", "close", "Close", "Forty near misses in one journey.", T("J.nearMiss", 40)),
  A("wheel", "brushed", "Brushed at Speed", "A near miss at over a hundred and fifty.", T("J.nearFast", 1)),
  A("wheel", "every-surface", "Every Surface", "Tarmac, gravel, dirt, snow, ice and mud in one journey.", ALL("J.surfaces", ALL_SURFACES)),
  A("wheel", "splash", "Splash", "A ford taken at over eighty.", F("J.fordFast")),
  A("wheel", "ice-dance", "Ice Dance", "A six-second slide on snow or ice.", T("J.iceDrift", 6)),
  A("wheel", "long-way-back", "Long Way Back", "Twenty seconds in the field, and back to the road with nothing to show for it.", F("J.offReturn")),
  FUN("wheel", "that-tree-again", "That Tree Again", "Hit the same thing twice in one journey. It was probably a tree.", F("J.sameThing")),

  // ---------------------------------------------------- weather and night
  A("weather", "ten-in-the-dark", "Ten in the Dark", "Ten kilometres after dark in one journey.", T("J.nightKm", 10000)),
  A("weather", "night-shift", "Night Shift", "Thirty kilometres after dark in one journey.", T("J.nightKm", 30000)),
  A("weather", "theres-the-sun", "There's the Sun", "Drive a night through to the dawn.", T("J.sunrises", 1)),
  A("weather", "second-dawn", "Second Dawn", "Two sunrises in one journey.", T("J.sunrises", 2)),
  A("weather", "around-the-clock", "Around the Clock", "A whole day and night on the road, back to the hour you set out.", F("J.fullDay")),
  A("weather", "ten-in-the-rain", "Ten in the Rain", "Ten kilometres in the rain in one journey.", T("J.rainKm", 10000)),
  A("weather", "through-the-storm", "Through the Storm", "Five kilometres of proper storm in one journey.", T("J.stormKm", 5000)),
  A("weather", "storm-untouched", "Storm, Untouched", "A leg with two kilometres of storm and not one hit in it.", F("J.stormLegClean")),
  A("weather", "fog-lamps", "Fog Lamps", "Five kilometres in fog in one journey.", T("J.fogKm", 5000)),
  A("weather", "snowbound", "Snowbound", "Ten kilometres in falling snow in one journey.", T("J.snowKm", 10000)),
  A("weather", "wet-tarmac", "Wet Tarmac", "Five clean corners in a row on wet tarmac.", T("J.wetBest", 5)),
  A("weather", "zone-after-dark", "Zone After Dark", "The top of the flow, after dark.", F("J.nightT5")),
  A("weather", "kaldbrekka-after-dark", "Kaldbrekka After Dark", "Drive Kaldbrekka at night.", F("J.kaldNight")),

  // ---------------------------------------------------------- the journey
  A("journey", "crossed-a-border", "Crossed a Border", "Into a second country.", N("J.countries", 2, REAL_COUNTRIES)),
  A("journey", "six-countries", "Six Countries", "Six countries in one journey.", N("J.countries", 6, REAL_COUNTRIES)),
  A("journey", "nine-countries", "Nine Countries", "Nine countries in one journey.", N("J.countries", 9, REAL_COUNTRIES)),
  A("journey", "grand-tour", "The Grand Tour", "All twelve countries in one journey.", ALL("J.countries", REAL_COUNTRIES)),
  A("journey", "every-country", "Every Country", "Every country there is, all journeys told. All thirteen.", ALL("L.countries", REAL_COUNTRIES.concat(["verge"]))),
  A("journey", "five-landmarks", "Five Landmarks", "Five landmarks in one journey.", N("J.landmarks", 5, ALL_LANDMARKS)),
  A("journey", "ten-landmarks", "Ten Landmarks", "Ten landmarks in one journey.", N("J.landmarks", 10, ALL_LANDMARKS)),
  A("journey", "every-landmark", "Every Landmark", "Every landmark on the map, all journeys told.", ALL("L.landmarks", ALL_LANDMARKS)),
  A("journey", "the-full-album", "The Full Album", "A hundred postcards in the diary.", T("L.postcards", 100)),
  A("journey", "across-the-ice", "Across the Ice", "The Frozen Lake, crossed without a hit.", F("J.cleanLandmarks.frozenlake")),
  A("journey", "bridge-at-pace", "Bridge at Pace", "The Suspension Bridge at over a hundred and forty.", F("J.suspensionFast")),
  A("journey", "flat-out", "Flat Out on the Flats", "A hundred and ninety on The Flats.", F("J.flatsFast")),
  A("journey", "stadium-show", "Stadium Show", "A four-second slide inside the Rally Stadium.", F("J.stadiumDrift")),
  A("journey", "ice-on-the-bridge", "Ice on the Bridge", "An iced bridge crossed without a hit.", F("J.icedClean")),
  A("journey", "and-back", "And Back", "Out of the Verge, and ten more kilometres after it.", F("J.vergeBack")),
  M("journey", "the-verge", "The Verge", "You crossed over.", F("J.verge")),
  M("journey", "the-old-road", "The Old Road", "You took the unmarked line, and it went somewhere.", F("J.oldRoad")),
  M("journey", "odd-one-this", "Odd One, This", "You pulled in at a strange outpost.", T("J.outposts", 1)),
  M("journey", "road-over-road", "Road Over Road", "The road crossed itself, and you were on top.", F("J.overpass")),
  M("journey", "lamps-in-the-town", "Lamps in the Town", "The Market Town, after dark, with the chapel lit.", F("J.townNight")),

  // -------------------------------------------------------------- the sky
  M("sky", "meteor-shower", "Meteor Shower", "A clear night, and the sky came down in pieces.", ALL("J.skies", ["meteors"])),
  M("sky", "the-northern-lights", "The Northern Lights", "The sky was dancing. No hurry that night.", ALL("J.skies", ["aurora"])),
  M("sky", "distant-lightning", "Distant Lightning", "A storm on the horizon, and the thunder late behind it.", ALL("J.skies", ["lightning"])),
  M("sky", "two-of-them", "Two of Them", "A double rainbow as the rain let go.", ALL("J.skies", ["rainbow"])),
  M("sky", "above-the-clouds", "Above the Clouds", "The valley was a white sea, and you were above it.", ALL("J.skies", ["inversion"])),
  M("sky", "the-eclipse", "The Eclipse", "The light went in the middle of the day. It passed.", ALL("J.skies", ["eclipse"])),
  M("sky", "the-dome-and-the-shower", "The Dome and the Shower", "A meteor shower over the Observatory.", F("J.obsMeteors")),

  // ------------------------------------------------------------ the build
  A("build", "something-bolted-on", "Something Bolted On", "Your first souvenir.", N("J.souvenirs", 1)),
  A("build", "eight-up", "Eight Up", "Eight souvenirs on the car in one journey.", N("J.souvenirs", 8)),
  A("build", "a-dozen", "A Dozen", "Twelve souvenirs on the car in one journey.", N("J.souvenirs", 12)),
  A("build", "fabled", "Fabled", "A fabled souvenir, taken.", T("J.rar.fabled", 1)),
  A("build", "three-exotics", "Three Exotics", "Three exotic souvenirs in one journey.", T("J.rar.exotic", 3)),
  A("build", "specialist", "Specialist", "Four souvenirs that share a tag.",
    { test: (S) => Object.values(S.J.tags || {}).some((n) => n >= 4), proof: (S) => { S.J.tags = { drift: 4 }; } }),
  A("build", "obsessive", "Obsessive", "Six souvenirs that share a tag.",
    { test: (S) => Object.values(S.J.tags || {}).some((n) => n >= 6), proof: (S) => { S.J.tags = { drift: 6 }; } }),
  A("build", "commoner", "Commoner", "Thirty kilometres with five or more souvenirs, every one of them common.",
    { test: (S) => S.J.dist >= 30000 && S.J.souvenirs.length >= 5 && (S.J.rar.common || 0) === S.J.souvenirs.length,
      proof: (S) => { S.J.dist = 30000; S.J.souvenirs = ["a", "b", "c", "d", "e"]; S.J.rar = { common: 5 }; } }),
  A("build", "stock-kestrel", "Stock Kestrel", "Thirty kilometres with nothing bolted on at all.", T("J.stockKm", 30000)),
  A("build", "travelling-light", "Travelling Light", "Took nothing at five waystations in one journey.", T("J.declined", 5)),
  A("build", "fully-kitted", "Fully Kitted", "Every part on the car in one journey.", ALL("J.parts", ALL_PARTS)),
  A("build", "never-serviced", "Never Serviced", "Fifty kilometres without a full service.",
    { test: (S) => S.J.dist >= 50000 && S.J.services === 0, proof: (S) => { S.J.dist = 50000; S.J.services = 0; } }),
  A("build", "the-car-answers", "The Car Answers", "A souvenir answered an incident, no charge.", T("J.freeAnswers", 1)),
  A("build", "every-fable", "Every Fable", "Every fabled souvenir there is, all journeys told.", ALL("L.fabled", FABLED_IDS)),

  // ------------------------------------------------------- the three ends
  A("ends", "stuck-the-landing", "Stuck the Landing", "Rolled it, landed on the wheels, drove on.", T("J.rollWheels", 1)),
  A("ends", "walked-it-off", "Walked It Off", "Rolled it, and ten more kilometres after.", F("J.rollThen10")),
  A("ends", "spectators", "Spectators", "Pushed off the roof by the crowd.", T("J.pushes", 1)),
  A("ends", "the-farmer", "The Farmer", "Towed out by the farmer.", T("J.tows", 1)),
  A("ends", "never-needed-them", "Never Needed Them", "Twenty waystations without spending a save.",
    { test: (S) => S.J.ws >= 20 && S.J.savesUsed === 0, proof: (S) => { S.J.ws = 20; S.J.savesUsed = 0; } }),
  A("ends", "fifty-without-incident", "Fifty Without Incident", "Fifty kilometres without a roll, a lake, an edge or a field.",
    { test: (S) => S.J.dist >= 50000 && S.J.incidents === 0 && S.J.rolls === 0, proof: (S) => { S.J.dist = 50000; S.J.incidents = 0; S.J.rolls = 0; } }),
  M("ends", "every-way-home", "Every Way Home", "Wrecked, collected, rolled, in the lake, over the edge, stranded. All six.",
    { test: (S) => ALL_ENDS.every((k) => (S.L.ends || {})[k] > 0), proof: (S) => { S.L.ends = Object.fromEntries(ALL_ENDS.map((k) => [k, 1])); } }),
  FUN("ends", "marshals-net", "Marshals' Net", "The marshals had to push you in. During the pull-in.", T("J.marshalled", 1)),
  FUN("ends", "off-to-a-start", "Off to a Start", "Rolled it inside the first kilometre.", F("J.rollFirstKm")),
  FUN("ends", "cautionary-tale", "Cautionary Tale", "Drove past The Wreck. Became one before the next waystation.",
    { test: (S) => S.J.end === "wrecked" && S.J.wreckLeg >= 0 && S.J.wreckLeg === S.J.leg, proof: (S) => { S.J.end = "wrecked"; S.J.wreckLeg = 3; S.J.leg = 3; } }),

  // ------------------------------------------------------------ the sweep
  A("sweep", "ahead-of-the-sweep", "Ahead of the Sweep", "The first waystation, in the Sweep.", T("J.sweepWs", 1)),
  A("sweep", "twenty-ahead", "Twenty Ahead", "Twenty waystations ahead of the sweep car.", T("J.sweepWs", 20)),
  A("sweep", "thirty-ahead", "Thirty Ahead", "Thirty waystations ahead of the sweep car. It takes a build.", T("J.sweepWs", 30)),
  A("sweep", "three-minutes-in-hand", "Three Minutes in Hand", "Three minutes of margin over the sweep car.", T("J.sweepMax", 180)),
  A("sweep", "beacons-in-the-mirror", "Beacons in the Mirror", "The sweep inside eight seconds, and a minute clear of it again.", F("J.sweepCloseBack")),
  A("sweep", "bought-time", "Bought Time", "Five of the spiciest roads on offer in one Sweep.", T("J.sweepD3", 5)),
  FUN("sweep", "collected-at-the-first", "Collected at the First", "Swept before the first waystation.",
    { test: (S) => S.J.end === "swept" && S.J.ws === 0, proof: (S) => { S.J.end = "swept"; S.J.ws = 0; } }),

  // ------------------------------------------------------------- the crew
  A("crew", "on-camera", "On Camera", "Rode out your first shot.", N("J.shots", 1, CREW_SHOTS)),
  A("crew", "the-chopper", "The Chopper", "Earned the helicopter.", ALL("J.shots", ["chopper"])),
  A("crew", "the-crane", "The Crane", "The crane, where the ground fell away.", ALL("J.shots", ["crane"])),
  A("crew", "over-the-crew", "Over the Crew", "Sent it over the crew lying past the jump.", ALL("J.shots", ["flyover"])),
  A("crew", "the-whole-crew", "The Whole Crew", "Every shot the crew knows how to set up, all journeys told.", ALL("L.shots", CREW_SHOTS)),
  A("crew", "a-full-roll", "A Full Roll", "Twelve stills in the album from one journey.", T("J.album", 12)),

  // --------------------------------------------------------- the codriver
  A("codriver", "quiet-car", "Quiet Car", "Twenty kilometres with the codriver on minimal.", T("J.minimalKm", 20000)),
  A("codriver", "late-calls", "Late Calls", "Twenty kilometres on late calls.", T("J.lateKm", 20000)),
  A("codriver", "car-feels-good", "Car Feels Good", "The codriver said so.", F("J.feelsGood")),
  A("codriver", "twenty-five-nices", "Twenty-Five Nices", "Twenty-five clean big landings the codriver liked, all journeys told.", T("L.nice", 25)),
  FUN("codriver", "over-crest", "Over Crest", "The codriver has said \"over crest\" a thousand times.", T("L.crest", 1000)),
  FUN("codriver", "the-turbo-sighs", "The Turbo Sighs", "Five hundred blow-offs, all journeys told.", T("L.blow", 500)),
  FUN("codriver", "long-coffee", "Long Coffee", "Ten real minutes parked at one waystation.", T("J.wsRealMax", 600)),
];

export const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

/* ----------------------------------------------------------- the tracker
 *
 * opts: { store: { load(), save(meta) }, seed, restore (a saved J), onUnlock(def, rec) }
 * The store is the meta seam (main hands it loadMeta/saveMeta; the harness
 * hands it a plain object). Unlocks persist the moment they happen. */
export function makeAchievements(opts) {
  opts = opts || {};
  const store = opts.store || { _m: {}, load() { return this._m; }, save(m) { this._m = m; } };
  const meta0 = store.load() || {};
  const J = Object.assign(zeroJourney(), opts.restore || {});
  const L = Object.assign(zeroLife(), meta0.achLife || {});
  const unlocked = Object.assign({}, meta0.achievements || {});
  const earned = [];            // this journey's unlocks, in order
  const pending = [];           // unlocks the UI has not shown yet
  let last = zeroNow();         // the latest snapshot (handlers read it)
  let prev = null;              // the snapshot before it (transitions)
  let ended = false;

  function S() {
    /* the lifetime view folds the live journey in, so a lifetime mark can
     * land mid-drive (the thousandth "over crest" is not a summary line) */
    const m = store.load() || {};
    const life = Object.assign({}, L, {
      km: ((m.totalDist || 0) + J.dist) / 1000,
      countries: union(m.countriesEver ? m.countriesEver.map(countryKey) : [], L.countries, J.countries),
      postcards: (m.postcards ? m.postcards.length : 0) + J.postcards,
    });
    return { J, L: life, now: last };
  }

  function unlock(def) {
    if (unlocked[def.id]) return;
    const rec = { at: Date.now(), seed: opts.seed || "", km: Math.round(J.dist / 100) / 10 };
    unlocked[def.id] = rec;
    earned.push(def.id);
    pending.push(def);
    const m = store.load() || {};
    m.achievements = Object.assign({}, m.achievements || {}, { [def.id]: rec });
    store.save(m);
    if (opts.onUnlock) opts.onUnlock(def, rec);
  }

  function evaluate() {
    const s = S();
    for (const def of ACHIEVEMENTS) {
      if (unlocked[def.id]) continue;
      let ok = false;
      try { ok = !!def.test(s); } catch (e) { ok = false; }
      if (ok) unlock(def);
    }
  }

  const add = (arr, k) => { if (k != null && !arr.includes(k)) arr.push(k); };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

  /* ---- typed events (the bus, plus a few main hands over directly) */
  function event(name, d) {
    d = d || {};
    const n = last;
    switch (name) {
      case "driftStart": J._swThis = false; break;
      case "driftSwitch":
        J.swChain = J._swPrevSwitch ? J.swChain + 1 : 1;
        J._swThis = true;
        if (J.swChain > J.swBest) J.swBest = J.swChain;
        break;
      case "driftEnd":
        J._swPrevSwitch = !!J._swThis;
        if (d.duration >= 2) J.drifts2s++;
        if (d.duration > J.drift) J.drift = d.duration;
        if ((n.surface === "ice" || n.surface === "snow") && d.duration > J.iceDrift) J.iceDrift = d.duration;
        if (n.event === "stadium" && d.duration >= 4) J.stadiumDrift = true;
        break;
      case "cornerDone":
        if (d.drifted) J.cDrifted++;
        if (d.clean) {
          J.cClean++; J.cStreak++;
          if (J.cStreak > J.cStreakBest) J.cStreakBest = J.cStreak;
          if (n.surface === "tarmac" && n.wet > 0.5) { J.wetStreak++; if (J.wetStreak > J.wetBest) J.wetBest = J.wetStreak; }
          else J.wetStreak = 0;
        } else { J.cStreak = 0; J.wetStreak = 0; }
        if (d.grade === "hp") {
          if (d.clean) J.hpClean++;
          if (d.clean && d.drifted) J.hpDrift++;
          if (d.clean && J._hbT != null && n.time - J._hbT < 6) J.hbHairpin = true;
        }
        break;
      case "handbrake": J._hbT = n.time; break;
      case "landed":
        if (d.clean) J.cleanLand++;
        if (d.air > J.air) J.air = d.air;
        if (d.air >= 1.5 && n.night > 0.5) J.nightAir = true;
        if (d.air >= 1.2 && d.clean && n.kmh >= 120) J.jumpFast = true;
        break;
      case "collision":
        if (d.impact > 2) {
          J.hits++;
          if (n.storm > 0.5) J.legStormHits++;
          /* the same thing twice: colliders are keyed by where they stand
           * (the world regenerates them there on a resume), and a second
           * meeting counts only after the first crash is well over */
          if (d.collider && typeof d.collider.x === "number") {
            const key = Math.round(d.collider.x) + "," + Math.round(d.collider.z);
            const log = J.hitLog || (J.hitLog = {});
            const was = log[key];
            if (was != null && n.time - was > 5) J.sameThing = true;
            log[key] = n.time;
            // keep the ledger small: a journey remembers its last forty things
            const ks = Object.keys(log);
            if (ks.length > 40) delete log[ks[0]];
          }
        }
        break;
      case "nearMiss": J.nearMiss++; if (n.kmh >= 150) J.nearFast++; break;
      case "pickup":
        if (d.echo) break;
        J.pickups++;
        if (d.sliding) J.pickSlide++;
        J.legKinds[d.kind] = 1;
        if (Object.keys(J.legKinds).length >= 4) J.fullSet = true;
        break;
      case "blowOff": J.blow++; L.blow++; break;
      case "flowTier": break;
      case "grace": J.grace++; break;
      case "legStart":
        J.leg = d.index || 0; J.legStartDist = J.dist; J.legMinTier = 9; J.legKinds = {};
        J.legStormKm = 0; J.legStormHits = 0;
        if (d.route && d.route.danger >= 3 && n.sweepOn) J.sweepD3++;
        break;
      case "waystation":
        J.ws++;
        if (n.sweepOn) J.sweepWs++;
        if (J.legMinTier >= 3 && J.dist - J.legStartDist >= 2000) J.zoneLeg = true;
        if (J.legStormKm >= 2000 && J.legStormHits === 0) J.stormLegClean = true;
        break;
      case "eventEnter":
        add(J.landmarks, d.key); add(L.landmarks, d.key);
        J.evKey = d.key; J.evHits0 = J.hits;
        if (d.key === "wreck") J.wreckLeg = J.leg;
        break;
      case "border":
        if (d.to === "verge") J.verge = true;
        else if (J.verge && d.from === "verge") J._vergeOutAt = J.dist;
        break;
      case "rollover":
        J.rolls++; L.rolls++; J.rollAt = J.dist;
        if (J.dist < 1000) J.rollFirstKm = true;
        break;
      case "settled": if (!d.roof) J.rollWheels++; break;
      case "incident":
        J.incidents++;
        if (d.helped && d.free) J.freeAnswers++;
        else if (d.helped) { if (d.kind === "roof") J.pushes++; else J.tows++; J.savesUsed++; }
        break;
      case "rescue": L.rescues++; break;
      case "marshalled": J.marshalled++; break;
      case "shot": add(J.shots, d.kind); add(L.shots, d.kind); break;
      /* ---- from main, not the bus */
      case "sky": add(J.skies, d.key); add(L.skies, d.key); break;
      case "postcard": J.postcards++; break;
      case "outpost": J.outposts++; break;
      case "oldroad": J.oldRoad = true; break;
      case "card":
        if (d.kind === "part") { add(J.parts, d.id); }
        else {
          add(J.souvenirs, d.id); add(L.souvenirs, d.id);
          bump(J.rar, d.rarity);
          for (const t of d.tags || []) bump(J.tags, t);
          if (d.rarity === "fabled") add(L.fabled, d.id);
        }
        break;
      case "declined": J.declined++; break;
      case "service": J.services++; break;
      case "surface":
        add(J.surfaces, d.to);
        if (d.to === "mud" && (d.kmh || 0) >= 80) J.fordFast = true;
        break;
      case "call": {
        const m = (d.text || "").match(/over crest/g);
        if (m) { J.crest += m.length; L.crest += m.length; }
        break;
      }
      case "remark":
        if (d.text === "nice") L.nice++;
        else if (d.text === "good save") L.goodSave++;
        else if (d.text === "car feels good") J.feelsGood = true;
        break;
      case "wsReal": if ((d.seconds || 0) > J.wsRealMax) J.wsRealMax = d.seconds; break;
      default: return;   // an event the book does not read: no evaluation
    }
    evaluate();
  }

  /* ---- the 4 Hz snapshot: distances, streaks, transitions */
  function tick(now) {
    prev = last; last = now;
    const dt = now.dt || 0.25;
    const ds = Math.max(0, Math.min(30 * dt * 4, now.dist - (prev ? prev.dist : now.dist)));
    J.dist = now.dist; J.score = now.score; J.driveTime = now.driveTime;
    if (now.kmh > J.topKmh) J.topKmh = now.kmh;
    if (now.cleanCur > J.clean) J.clean = now.cleanCur;
    J.savesUsed = now.savesUsed;
    add(J.surfaces, now.surface);
    add(J.countries, now.country); add(L.countries, now.country);
    if (now.region) add(J.regions, now.region);
    if (now.firesMax > J.firesMax) J.firesMax = now.firesMax;
    // the zone
    if (now.tier >= 5) { J.t5 += dt; if (J.t5 > J.t5Best) J.t5Best = J.t5; } else J.t5 = 0;
    if (now.tier >= 5 && now.night > 0.5) J.nightT5 = true;
    if (now.tier >= 5 && now.pushing) J.pushZone = true;
    if (now.dist - J.legStartDist > 400 && now.tier < J.legMinTier) J.legMinTier = now.tier;
    if (now.noBrake > J.noBrakeBest && now.kmh >= 60) J.noBrakeBest = now.noBrake;
    if (now.gear >= 6 && now.kmh > 60) { J.g6 += dt; if (J.g6 > J.g6Best) J.g6Best = J.g6; } else J.g6 = 0;
    // boost, read as transitions (start level, end level, seconds held)
    if (now.boostOn && !now.autoBoost) {
      if (!(prev && prev.boostOn)) { J._b0 = now.boost; J._bT = 0; }
      J._bT = (J._bT || 0) + dt;
      if (J._bT > J.boostBest) J.boostBest = J._bT;
    } else if (prev && prev.boostOn && !prev.autoBoost) {
      if ((J._b0 || 0) >= 92 && now.boost <= 8) J.emptied = true;
    }
    // where the kilometres happen
    if (now.night > 0.5) { J.nightKm += ds; J.nightSinceDawn += ds; }
    if (now.rain > 0.35) J.rainKm += ds;
    if (now.storm > 0.5) { J.stormKm += ds; J.legStormKm += ds; }
    if (now.fog > 0.45) J.fogKm += ds;
    if (now.snow > 0.3) J.snowKm += ds;
    if (now.cold > 0.5) J.coldKm += ds;
    if (now.encl > 0.5) J.tunnelKm += ds;
    if (now.verbosity === "minimal") J.minimalKm += ds;
    if (now.timing === "late") J.lateKm += ds;
    if (!now.souvenirs.length && !now.parts.length) J.stockKm += ds;
    if (now.vx < -0.5) J.reverseM += -now.vx * dt;
    // the clock: a dawn is the sun crossing 0.25 going forward; a sunrise
    // is a dawn after real night driving; midnight is the wrap
    if (prev) {
      const u0 = prev.u, u1 = now.u;
      if (u1 < u0 - 0.5) { J.midnights++; J._sinceMid = true; }
      if ((u0 < 0.25 && u1 >= 0.25 && u1 - u0 < 0.5) || (u1 < u0 - 0.5 && u1 >= 0.25)) {
        J.dawns++;
        if (J.nightSinceDawn >= 3000) J.sunrises++;
        J.nightSinceDawn = 0;
      }
      if (J._sinceMid && u0 < 0.335 && u1 >= 0.335) J.fullDay = true;
    }
    // speed in places
    if (now.encl > 0.5 && now.kmh >= 150) J.tunnelFast = true;
    if (now.surface === "ice" && now.kmh >= 120) J.iceFast = true;
    if (now.storm > 0.5 && now.kmh >= 160) J.stormFast = true;
    if (now.event === "suspension" && now.kmh >= 140) J.suspensionFast = true;
    if (now.event === "saltflat" && now.kmh >= 190) J.flatsFast = true;
    if (now.event === "town" && now.night > 0.5) J.townNight = true;
    if (now.event === "observatory" && now.skyNow === "meteors") J.obsMeteors = true;
    if (now.album > J.album) J.album = now.album;
    if (now.country === "kaldbrekka" && now.night > 0.5) J.kaldNight = true;
    if (now.span && now.span.over) J.overpass = true;
    // leaving a landmark with no hit inside it
    if (J.evKey && now.event !== J.evKey) {
      if (J.hits === J.evHits0) J.cleanLandmarks[J.evKey] = true;
      J.evKey = null;
    }
    // an iced deck, likewise
    const iced = !!(now.span && now.span.iced);
    if (iced && !J.icedOn) { J.icedOn = true; J.icedHits0 = J.hits; }
    else if (!iced && J.icedOn) { J.icedOn = false; if (J.hits === J.icedHits0) J.icedClean = true; }
    // the field, and the way back
    if (now.zone === "off") {
      if (J.offT === 0) { J._offInc = J.incidents; J._offHits = J.hits; }
      J.offT += dt;
    } else if (J.offT > 0) {
      if (J.offT >= 20 && J.incidents === J._offInc && J.hits === J._offHits) J.offReturn = true;
      J.offT = 0;
    }
    if (J.rollAt >= 0 && now.dist - J.rollAt >= 10000) J.rollThen10 = true;
    if (J._vergeOutAt != null && now.dist - J._vergeOutAt >= 10000) J.vergeBack = true;
    // the sweep
    if (now.sweepOn) {
      J.sweep = true;
      if (now.sweepMargin > J.sweepMax && now.sweepMargin < 900) J.sweepMax = now.sweepMargin;
      if (now.sweepMargin < 8) J.sweepClose = true;
      if (J.sweepClose && now.sweepMargin > 60) J.sweepCloseBack = true;
    }
    evaluate();
  }

  /* ---- the journey ends: the last facts, then the lifetime ledger */
  function journeyEnd(reason, now) {
    if (ended) return earned.slice();
    ended = true;
    if (now) { prev = last; last = now; }
    J.end = reason || "parked";
    J.endCond = last.condition;
    L.journeys++;
    bump(L.ends, J.end);
    if (J.sweep && J.sweepWs > L.sweepBestWs) L.sweepBestWs = J.sweepWs;
    evaluate();
    const m = store.load() || {};
    m.achLife = L;
    store.save(m);
    return earned.slice();
  }

  function drain() { return pending.splice(0); }
  function has(id) { return !!unlocked[id]; }
  function count() { return Object.keys(unlocked).filter((k) => ACH_BY_ID[k]).length; }

  return { J, L, event, tick, journeyEnd, drain, has, count, earned, unlocked, evaluate, get last() { return last; } };
}

function union() {
  const out = [];
  for (const a of arguments) for (const k of a || []) if (!out.includes(k)) out.push(k);
  return out;
}

/* the diary stores country NAMES; the book keys them */
const NAME_TO_KEY = {
  "Norrland": "norrland", "Costa Vela": "costa", "Redgate": "redgate", "Thornmoor": "thornmoor", "Heartland": "heartland",
  "Aspenvale": "aspenvale", "Kaldbrekka": "kaldbrekka", "Sandreach": "sandreach", "Highline": "highline",
  "Cauldron": "cauldron", "Kurotani": "kurotani", "Ventisca": "ventisca", "The Verge": "verge",
};
export function countryKey(name) { return NAME_TO_KEY[name] || name; }

/* ------------------------------------------------------------- the book
 * What the title's sheet and the summary read: chapters, each with its
 * announced entries (skill, always listed) and its unannounced ones
 * (moments and jokes, named only once earned). */
export function bookFor(unlocked) {
  unlocked = unlocked || {};
  return GROUPS.map(([key, title]) => {
    const all = ACHIEVEMENTS.filter((a) => a.group === key);
    const listed = all.filter((a) => a.kind === "skill" || unlocked[a.id]);
    const hidden = all.length - listed.length;
    return { key, title, listed, hidden, done: all.filter((a) => unlocked[a.id]).length, total: all.length };
  });
}
