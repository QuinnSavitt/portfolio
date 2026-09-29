/* Overcrest — biome definitions.
 *
 * A biome is a place, not a texture: it owns road grammar weights, width,
 * surface, elevation character, terrain shaping, vegetation, palette,
 * weather appetite and its neighbours. The world blends two biomes across a
 * transition zone (BT ring) so a change of country arrives as geography —
 * the forest thins, the ground pales, the sea appears — not as a cut.
 * Pure data; DOM-free.
 *
 * Prop vocabulary (render/chunks.js knows how to draw each):
 *   spruce pine birch cypress olive umbrella cactus shrub rock rockRed
 *   mesa wall villa cabin waystation waysign
 *   region marks: boathouse woodpile cairn snowpole shrine terrace
 *   milestone fence hoodoo windpump
 *   2026-08-31 countries: cottonwood cedar lodgepole snag larch (trees),
 *   canyonwall granitetower geyser hotpool boardwalk torii lantern
 *   guardrail guardwall estanciagate lamppost chapel, and `dwelling`
 *   (drawn as the country's own cabinType)
 *
 * Per-biome optional fields the rest of the game reads:
 *   rockType   the roadside boulder part ("rock" unless set)
 *   drift      what the air carries at speed: "leaf" | "sand" | "mote"
 */

export const BIOMES = {
  /* Boreal forest: flowing gravel, crests, lakes, cabins. The heartbeat. */
  norrland: {
    key: "norrland", name: "Norrland", surf: "gravel", ground: "grass",
    halfWidth: 3.7,
    elevMacro: [[9, 940], [3.4, 390], [1.3, 175]],
    trendMax: 0.035, crestLove: 0.55, jumpLove: 0.45, dipLove: 0.22,
    terrDetail: [1.7, 23], terrHills: [8.5, 135], hillShape: 1.0, ditch: 0.32,
    camberP: 0.5, offCamberP: 0.08,
    lakeP: 0.16, waterDrop: 1.5, waterName: "lake", walls: false,
    moods: {
      calm: [["cruiseRun", 4], ["kink", 2], ["lakeside", 2.5], ["sweepChain", 1]],
      flow: [["sweepChain", 5], ["rhythmSet", 3], ["sBend", 1.5], ["kink", 1]],
      tech: [["techComplex", 4], ["sBend", 3], ["rhythmSet", 2], ["hairpinDrop", 1.2]],
      fast: [["speedRun", 5], ["jumpLine", 2.2], ["kink", 2], ["sweepChain", 1]],
    },
    trees: [["spruce", 6], ["pine", 3], ["birch", 2.2]],
    treeStep: 4.4, treeDensity: 0.62, rockP: 0.05, cabinP: 0.35, cabinType: "cabin", drift: "leaf",
    weather: { rain: 0.5, fog: 0.45, cloud: 0.5 },
    /* What the country sounds like when the engine goes quiet: forest birds,
     * a little wind off the lakes. Read by the audio ambience layer. */
    amb: { wind: 0.35, forest: 0.7, birds: 0.6, crickets: 0.15, owl: 0.5, loon: 0.4 },
    neighbours: { costa: 1.0, thornmoor: 0.8, heartland: 0.9, aspenvale: 0.7, redgate: 0.35, kaldbrekka: 0.3, highline: 0.5, cauldron: 0.45 },
    transitionLine: "the trees thin out. different country ahead",
    palette: {
      skyTop: 0x6fa5c9, skyHor: 0xe6ebe4, fog: 0xc9d8d6,
      sun: 0xfff2d9, sunInt: 1.0, hemiSky: 0xbfd6e4, hemiGround: 0x4e5f45, hemiInt: 0.72,
      road: 0x8f8672, roadEdge: 0x7a7260, shoulder: 0x62704f,
      terrain: [0x51683f, 0x5d7647, 0x475d38, 0x66804e],
      lake: 0x7d98a8, lakeShore: 0x8fa8b4,
      trunk: 0x6d5741, birchTrunk: 0xdcd8cf,
      spruce: [0x2f4d33, 0x3a5c3c, 0x28422e], pine: [0x3d5a37, 0x466545, 0x35512f], birch: [0x5f7a3e, 0x6d8a4a, 0x54703a],
      rock: 0x8d9294, ridgeNear: 0x5e7488, ridgeFar: 0x8299ab, farFloor: 0x49603e,
      cabin: 0x8a3f2e, cabinRoof: 0x3a3f42, wall: 0x9a948a,
    },
  },

  /* Mediterranean cliff coast: narrow tarmac, stone walls, villages, sea. */
  costa: {
    key: "costa", name: "Costa Vela", surf: "tarmac", ground: "scrub",
    halfWidth: 3.0,
    elevMacro: [[10, 760], [3.6, 310], [1.3, 140]],
    trendMax: 0.05, crestLove: 0.2, jumpLove: 0.04, dipLove: 0.14,
    terrDetail: [1.2, 18], terrHills: [15, 165], hillShape: 1.15, ditch: 0,
    camberP: 0.42, offCamberP: 0.12,
    lakeP: 0.34, waterDrop: 13, waterName: "sea", walls: true,
    moods: {
      calm: [["cruiseRun", 2.5], ["kink", 2], ["lakeside", 4], ["sweepChain", 1.5]],
      flow: [["sweepChain", 4], ["rhythmSet", 3.5], ["sBend", 2], ["lakeside", 2]],
      tech: [["techComplex", 4], ["hairpinDrop", 3.2], ["sBend", 3], ["rhythmSet", 2]],
      fast: [["speedRun", 2.5], ["kink", 2.5], ["sweepChain", 2], ["cruiseRun", 1]],
    },
    trees: [["cypress", 3.5], ["olive", 4], ["umbrella", 2.2]],
    treeStep: 5.6, treeDensity: 0.48, rockP: 0.09, cabinP: 0.6, cabinType: "villa",
    weather: { rain: 0.22, fog: 0.15, cloud: 0.32 },
    amb: { wind: 0.3, sea: 0.85, birds: 0.3, gull: 0.75, cicada: 0.7, crickets: 0.35 },
    neighbours: { norrland: 0.7, redgate: 1.0, thornmoor: 0.25, sandreach: 0.55, kurotani: 0.6 },
    transitionLine: "the ground is turning red. dry country ahead",
    palette: {
      skyTop: 0x5f9fd6, skyHor: 0xf2ead6, fog: 0xe3dcc9,
      /* Dry season on a limestone coast: the ground is bleached, not lush.
       * The old terrain ramp sat in olive-khaki and the whole country read
       * green from the road — wrong hemisphere. Warm buff and pale stone
       * now, with the foliage pushed towards the grey-green olives really
       * are, so the only saturated green left is the pines. */
      sun: 0xfff2ce, sunInt: 1.1, hemiSky: 0xcbdbea, hemiGround: 0xa89d81, hemiInt: 0.72,
      road: 0x77757a, roadEdge: 0x66646a, shoulder: 0xb2a88c,
      terrain: [0xbdb094, 0xae9f80, 0xc6bda6, 0x9d9070],
      lake: 0x3d7fa8, lakeShore: 0x5f95b6,
      trunk: 0x7a6448, birchTrunk: 0x9c9080,
      spruce: [0x46603f, 0x3c563f, 0x4d6a47], pine: [0x4a6a44, 0x557a4c, 0x3f5c3c], birch: [0x8f9a7e, 0x9aa489, 0x848f73],
      rock: 0xc0b8a4, ridgeNear: 0x9aa0a6, ridgeFar: 0xb5bcc2, farFloor: 0x9c9377,
      cabin: 0xe8dcc4, cabinRoof: 0xb8623f, wall: 0xc2b89f,
    },
  },

  /* Red-rock desert: wide dirt, washboard, mesas, cactus, dust. Speed. */
  redgate: {
    key: "redgate", name: "Redgate", surf: "dirt", ground: "sand",
    halfWidth: 4.4,
    elevMacro: [[6, 1200], [2.2, 420], [0.9, 190]],
    trendMax: 0.022, crestLove: 0.35, jumpLove: 0.6, dipLove: 0.3,
    terrDetail: [1.0, 30], terrHills: [24, 240], hillShape: 1.6, ditch: 0.12,
    camberP: 0.3, offCamberP: 0.05,
    lakeP: 0.0, waterDrop: 0, waterName: "flat", walls: false,
    moods: {
      calm: [["cruiseRun", 5], ["kink", 2.5], ["sweepChain", 1.5]],
      flow: [["sweepChain", 5], ["rhythmSet", 2], ["kink", 2], ["cruiseRun", 1.5]],
      tech: [["techComplex", 2.5], ["sBend", 3], ["rhythmSet", 3], ["hairpinDrop", 0.8]],
      fast: [["speedRun", 6], ["jumpLine", 3], ["kink", 2], ["cruiseRun", 1]],
    },
    trees: [["cactus", 3], ["shrub", 5], ["rockRed", 3]],
    treeStep: 7.5, treeDensity: 0.4, rockP: 0.12, cabinP: 0.25, cabinType: "cabin", mesaP: 0.5, rockType: "rockRed", drift: "sand",
    weather: { rain: 0.05, fog: 0.04, cloud: 0.15 },
    amb: { wind: 0.55, birds: 0.08, crickets: 0.7, cicada: 0.5, raptor: 0.4, corvid: 0.15 },
    neighbours: { costa: 1.0, norrland: 0.35, sandreach: 1.0, cauldron: 0.4, ventisca: 0.3 },
    transitionLine: "cooler air. forest coming back",
    palette: {
      skyTop: 0x6fb0e0, skyHor: 0xf5e6c9, fog: 0xecd9b8,
      sun: 0xfff0c8, sunInt: 1.15, hemiSky: 0xd8e2ec, hemiGround: 0xb09468, hemiInt: 0.7,
      road: 0xb08e66, roadEdge: 0x9c7c58, shoulder: 0xbd9a6c,
      terrain: [0xc9a072, 0xbd9468, 0xd3ab7c, 0xa97f56],
      lake: 0xd8cbb0, lakeShore: 0xd0c2a2,
      trunk: 0x6a4a36, birchTrunk: 0x8a7a66,
      spruce: [0x5f7f4a, 0x557548, 0x678a52], pine: [0x6f7f4f, 0x66774a, 0x7a8b58], birch: [0x8a8f5a, 0x7c8352, 0x969a64],
      rock: 0xc07a58, ridgeNear: 0xb28468, ridgeFar: 0xc5a08a, farFloor: 0xc39d70,
      cabin: 0xc9b28f, cabinRoof: 0x8b5a3c, wall: 0xb08a68,
    },
  },

  /* Foggy moorland: peat, drystone, blind crests, loneliness. The bible's
   * fifth country, and the wettest — drizzle is its resting state, fog is
   * its weather event, and a clear day feels like being let off something.
   * Temperate on purpose: wet gravel and mud are surfaces the tyre model
   * already speaks, so Thornmoor is depth of PLACE, not of physics. */
  thornmoor: {
    key: "thornmoor", name: "Thornmoor", surf: "gravel", ground: "grass",
    halfWidth: 3.4,
    elevMacro: [[11, 1050], [4, 420], [1.2, 160]],
    trendMax: 0.03, crestLove: 0.7, jumpLove: 0.22, dipLove: 0.35,
    terrDetail: [1.5, 26], terrHills: [12, 150], hillShape: 0.9, ditch: 0.4,
    camberP: 0.4, offCamberP: 0.14,
    lakeP: 0.1, waterDrop: 0.8, waterName: "tarn", walls: false,
    moods: {
      calm: [["cruiseRun", 4], ["kink", 2], ["lakeside", 1.6], ["sweepChain", 1.2]],
      flow: [["sweepChain", 4.5], ["rhythmSet", 3], ["sBend", 1.8], ["cruiseRun", 1]],
      tech: [["techComplex", 3.8], ["sBend", 2.4], ["hairpinDrop", 3.2], ["rhythmSet", 1.4]],
      fast: [["speedRun", 4.5], ["kink", 2.5], ["sweepChain", 1.6], ["jumpLine", 0.8]],
    },
    trees: [["pine", 1.5], ["birch", 1.2], ["shrub", 4]],
    treeStep: 6.5, treeDensity: 0.3, rockP: 0.14, cabinP: 0.15, cabinType: "cabin", drift: "leaf",
    weather: { rain: 0.65, fog: 0.7, cloud: 0.75 },
    amb: { wind: 0.9, birds: 0.2, curlew: 0.6, corvid: 0.35 },
    neighbours: { norrland: 1.0, heartland: 0.6, aspenvale: 0.4, costa: 0.4, kurotani: 0.4, ventisca: 0.6 },
    transitionLine: "the mist is thinning. kinder country ahead",
    palette: {
      skyTop: 0x7d93a8, skyHor: 0xd9dcd8, fog: 0xc3c9c6,
      /* Heather and peat: dun browns with one mauve terrain entry for the
       * bloom, gritstone greys, a sun that never quite commits. */
      sun: 0xf2ecd8, sunInt: 0.85, hemiSky: 0xb4c0c8, hemiGround: 0x4f4a3d, hemiInt: 0.66,
      road: 0x7d766a, roadEdge: 0x6a6459, shoulder: 0x5d5a44,
      terrain: [0x5c5a42, 0x6d5a5c, 0x51503a, 0x6b5f4a],
      lake: 0x63727c, lakeShore: 0x77837f,
      trunk: 0x574a3c, birchTrunk: 0xcfc9bd,
      spruce: [0x3d4a38, 0x46543e, 0x35422f], pine: [0x4a5540, 0x525f45, 0x404a37], birch: [0x6a6f4c, 0x777c55, 0x5d6243],
      rock: 0x7e8082, ridgeNear: 0x6d7a82, ridgeFar: 0x939ea4, farFloor: 0x565340,
      cabin: 0x6f6a5e, cabinRoof: 0x4a4a45, wall: 0x7c7668,
    },
  },

  /* Rolling farmland: hedges, barns, wheat, hay bales, windmills. The
   * bible's onboarding country — warmth is the design brief, so the sky
   * is kind, the corners are honest, and everything beside the road says
   * somebody lives well here. Wide smooth tarmac, the opposite end of the
   * scale from Costa's narrow cliff lanes. */
  heartland: {
    key: "heartland", name: "Heartland", surf: "tarmac", ground: "grass",
    halfWidth: 3.8,
    elevMacro: [[7, 900], [2.6, 380], [1.0, 170]],
    trendMax: 0.02, crestLove: 0.4, jumpLove: 0.15, dipLove: 0.2,
    terrDetail: [1.0, 20], terrHills: [7, 120], hillShape: 0.85, ditch: 0.25,
    camberP: 0.45, offCamberP: 0.04,
    lakeP: 0.08, waterDrop: 1.0, waterName: "pond", walls: false,
    moods: {
      calm: [["cruiseRun", 5], ["kink", 2], ["lakeside", 1.5], ["sweepChain", 1.5]],
      flow: [["sweepChain", 5], ["rhythmSet", 2.5], ["cruiseRun", 2], ["sBend", 1.5]],
      tech: [["techComplex", 3.5], ["sBend", 3], ["hairpinDrop", 1.4], ["rhythmSet", 2]],
      fast: [["speedRun", 5], ["kink", 2.5], ["sweepChain", 2], ["cruiseRun", 1.5]],
    },
    trees: [["birch", 2.5], ["pine", 1.2], ["shrub", 1.5]],
    treeStep: 6, treeDensity: 0.35, rockP: 0.03, cabinP: 0.55, cabinType: "cabin", drift: "leaf",
    weather: { rain: 0.35, fog: 0.3, cloud: 0.4 },
    amb: { wind: 0.25, forest: 0.25, birds: 0.85, crickets: 0.45, cowbell: 0.4, owl: 0.3 },
    neighbours: { norrland: 1.0, thornmoor: 0.6, costa: 0.3, kurotani: 0.5 },
    transitionLine: "the hedges are giving way. wilder country coming",
    palette: {
      skyTop: 0x74aad4, skyHor: 0xf0ecd8, fog: 0xdde0d2,
      /* Wheat gold against pasture green: the warmest ground in the game,
       * and a tarmac lane grey enough to let it sing. */
      sun: 0xfff3d4, sunInt: 1.05, hemiSky: 0xc8dcea, hemiGround: 0x7d8250, hemiInt: 0.74,
      road: 0x76737a, roadEdge: 0x646168, shoulder: 0x7f8a50,
      terrain: [0x8fa050, 0xc2b060, 0x7d9448, 0xd0be72],
      lake: 0x6f94a4, lakeShore: 0x84a4ae,
      trunk: 0x6d5741, birchTrunk: 0xdcd8cf,
      spruce: [0x3f5c3a, 0x4a6a44, 0x365233], pine: [0x4d6a42, 0x587a4c, 0x435c3a], birch: [0x6f8a44, 0x7d9a50, 0x627a3c],
      rock: 0x9a958c, ridgeNear: 0x7a8c94, ridgeFar: 0xa2b0ba, farFloor: 0x93974f,
      cabin: 0xb0492f, cabinRoof: 0x4a4038, wall: 0xa89e88,
    },
  },

  /* Alpine: the bible's own example journey — foothills → pines → high
   * valley → the ladder of hairpins → snow line → the pass → the glacier →
   * the long descent. The elevation is the biggest in the game and the
   * REGIONS do the work: the country starts green and ends white, and the
   * snow arrives as a place you climbed to, not as a texture swap. The
   * high regions lay a real snow SURFACE (the tyre law's, not a palette's),
   * and the generator sizes their corners for snow grip, so the calls stay
   * promises all the way up. */
  aspenvale: {
    key: "aspenvale", name: "Aspenvale", surf: "gravel", ground: "grass",
    halfWidth: 3.3,
    elevMacro: [[14, 1000], [5, 430], [1.6, 180]],
    trendMax: 0.055, crestLove: 0.45, jumpLove: 0.28, dipLove: 0.2,
    terrDetail: [1.6, 24], terrHills: [17, 175], hillShape: 1.05, ditch: 0.3,
    camberP: 0.5, offCamberP: 0.1,
    lakeP: 0.07, waterDrop: 1.2, waterName: "lake", walls: false,
    moods: {
      calm: [["cruiseRun", 4], ["kink", 2], ["lakeside", 1.6], ["sweepChain", 1.2]],
      flow: [["sweepChain", 4.5], ["rhythmSet", 3], ["sBend", 1.8], ["kink", 1.2]],
      tech: [["techComplex", 3.6], ["hairpinDrop", 3.4], ["sBend", 2.6], ["rhythmSet", 1.6]],
      fast: [["speedRun", 4.5], ["kink", 2.5], ["sweepChain", 1.8], ["jumpLine", 1]],
    },
    trees: [["spruce", 5], ["pine", 3], ["birch", 2.6]],
    treeStep: 4.8, treeDensity: 0.55, rockP: 0.1, cabinP: 0.3, cabinType: "cabin", drift: "leaf",
    weather: { rain: 0.42, fog: 0.5, cloud: 0.55 },
    amb: { wind: 0.6, forest: 0.8, birds: 0.25, owl: 0.45, corvid: 0.2 },
    neighbours: { norrland: 1.0, kaldbrekka: 0.9, thornmoor: 0.5, highline: 0.9, kurotani: 0.5 },
    transitionLine: "losing altitude. the mountains are letting go",
    palette: {
      skyTop: 0x5f9dd2, skyHor: 0xe9eeee, fog: 0xd4dde0,
      /* Granite and dark spruce below, with the birch entries turned gold —
       * in Aspenvale they are aspens, and autumn is permanent. */
      sun: 0xfff2d6, sunInt: 1.05, hemiSky: 0xc2d8ea, hemiGround: 0x51604a, hemiInt: 0.72,
      road: 0x8b8474, roadEdge: 0x767061, shoulder: 0x5e6c4e,
      terrain: [0x55744a, 0x627f52, 0x4a6742, 0x87917e],
      lake: 0x6f96ac, lakeShore: 0x88a8b6,
      trunk: 0x5c4c3c, birchTrunk: 0xe4e0d4,
      spruce: [0x2c4830, 0x365638, 0x25402a], pine: [0x3a5636, 0x436343, 0x324e2e],
      birch: [0xc9a03a, 0xd8b048, 0xb8902f],
      rock: 0x8f949a, ridgeNear: 0x6d8298, ridgeFar: 0x9cb0c2, farFloor: 0x4d6244,
      cabin: 0x6f4a34, cabinRoof: 0x3c4044, wall: 0x9a948a,
    },
  },

  /* Glacial tundra: the far cold end of the map, reached through Aspenvale
   * or the top of Norrland. The whole country drives on packed snow — the
   * bible's "long low-grip arcs" are what the corner sizing produces from
   * snow grip all by itself — the verges are drifts that catch a wheel
   * (snowfield ground), the lakes are ice, black rock breaks the white,
   * and on a clear night the sky does the thing the country is named for.
   * Red cabins because on white, nothing else survives. */
  kaldbrekka: {
    key: "kaldbrekka", name: "Kaldbrekka", surf: "snow", ground: "snowfield",
    halfWidth: 3.9,
    elevMacro: [[7, 1100], [2.8, 420], [1.0, 180]],
    trendMax: 0.025, crestLove: 0.35, jumpLove: 0.18, dipLove: 0.25,
    terrDetail: [1.2, 26], terrHills: [11, 170], hillShape: 0.95, ditch: 0.18,
    camberP: 0.35, offCamberP: 0.06,
    lakeP: 0.22, waterDrop: 0.6, waterName: "ice", walls: false,
    cold: true, aurora: true,
    moods: {
      calm: [["cruiseRun", 5], ["kink", 2], ["lakeside", 2.2], ["sweepChain", 1.6]],
      flow: [["sweepChain", 5.5], ["rhythmSet", 2.2], ["cruiseRun", 1.8], ["kink", 1.5]],
      tech: [["techComplex", 2.6], ["sBend", 3], ["rhythmSet", 2.4], ["hairpinDrop", 0.6]],
      fast: [["speedRun", 5], ["kink", 2.5], ["sweepChain", 2], ["cruiseRun", 1.2]],
    },
    trees: [["shrub", 4], ["birch", 1.2], ["spruce", 0.8]],
    treeStep: 7, treeDensity: 0.22, rockP: 0.16, cabinP: 0.2, cabinType: "cabin",
    /* Arctic high pressure: the sky here CLEARS — cold, starry nights are
     * the country's identity (and what the aurora needs). Snow still
     * arrives; it just does not hang around overhead all day. */
    weather: { rain: 0.4, fog: 0.35, cloud: 0.45 },
    amb: { wind: 1.0, ice: 0.6, corvid: 0.35 },
    neighbours: { aspenvale: 1.0, norrland: 0.5, ventisca: 0.7, highline: 0.3 },
    transitionLine: "the snow is thinning. softer country ahead",
    palette: {
      skyTop: 0x8fb6d4, skyHor: 0xecf1f4, fog: 0xdde5ea,
      sun: 0xfff0d0, sunInt: 0.9, hemiSky: 0xd0dde8, hemiGround: 0x9aa4ac, hemiInt: 0.7,
      road: 0xdde3e9, roadEdge: 0xc6cfd7, shoulder: 0xcfd7de,
      terrain: [0xdfe6ec, 0xd2dae2, 0xe9eef2, 0xc4ccd6],
      lake: 0xbfd4de, lakeShore: 0xd8e2e8,
      trunk: 0x4a4038, birchTrunk: 0xcac4b8,
      spruce: [0x2f4038, 0x38493e, 0x293a32], pine: [0x35473a, 0x3d5242, 0x2e4034],
      birch: [0x6a5f4a, 0x776a52, 0x5d5342],
      rock: 0x3a4148, ridgeNear: 0x8fa4b4, ridgeFar: 0xb4c4d0, farFloor: 0xd8dfe6,
      cabin: 0x9c3f2e, cabinRoof: 0x2f3438, wall: 0x8a8e92,
    },
  },
  /* ------------------------------------------------------------------
   * THE PARK COUNTRIES (2026-08-31). Quinn: "a bunch more countries
   * inspired by American national parks and other countries' landmarks
   * (think Zion, Glacier)". Each is a real place drawn from one strong
   * image, never a copy of an existing country: Sandreach is a canyon
   * floor between sandstone walls, not Redgate's open desert; Highline is
   * a cliff road over turquoise lakes, not Aspenvale's alpine ladder.
   * ------------------------------------------------------------------ */

  /* Sandstone canyon country (Zion, Bryce): narrow tarmac on the river
   * bottom under cottonwoods, the walls close in until the sky is a strip,
   * switchbacks up the wall, hoodoos on the rim. Red rock everywhere, but
   * it is a place you drive INTO, not across. */
  sandreach: {
    key: "sandreach", name: "Sandreach", surf: "tarmac", ground: "sand",
    halfWidth: 3.2,
    elevMacro: [[9, 900], [3.5, 380], [1.3, 160]],
    trendMax: 0.045, crestLove: 0.3, jumpLove: 0.12, dipLove: 0.25,
    terrDetail: [1.4, 22], terrHills: [20, 175], hillShape: 1.5, ditch: 0.1,
    camberP: 0.4, offCamberP: 0.1,
    lakeP: 0.12, waterDrop: 2.5, waterName: "river", walls: false,
    moods: {
      calm: [["cruiseRun", 3], ["kink", 2], ["lakeside", 2], ["sweepChain", 1.5]],
      flow: [["sweepChain", 4.5], ["rhythmSet", 3], ["sBend", 2], ["kink", 1.5]],
      tech: [["techComplex", 4], ["hairpinDrop", 3.6], ["sBend", 2.5], ["rhythmSet", 1.5]],
      fast: [["speedRun", 4], ["kink", 2.5], ["sweepChain", 2], ["cruiseRun", 1]],
    },
    trees: [["cottonwood", 2.5], ["shrub", 4], ["pine", 1.5]],
    treeStep: 6.8, treeDensity: 0.36, rockP: 0.14, cabinP: 0.1, cabinType: "cabin", mesaP: 0.25,
    rockType: "rockRed", drift: "sand",
    weather: { rain: 0.08, fog: 0.05, cloud: 0.2 },
    amb: { wind: 0.45, birds: 0.2, crickets: 0.5, cicada: 0.3, raptor: 0.5, corvid: 0.3 },
    neighbours: { redgate: 1.0, costa: 0.5, cauldron: 0.4 },
    transitionLine: "the walls are opening out. flatter country ahead",
    palette: {
      skyTop: 0x4f92d4, skyHor: 0xf6e2c4, fog: 0xe6cdb0,
      /* Navajo sandstone: vermilion at the base, cream bands up top, the
       * pale grey-green of cottonwood and juniper the only relief. */
      sun: 0xffefc8, sunInt: 1.15, hemiSky: 0xd6e3ee, hemiGround: 0xa66a48, hemiInt: 0.7,
      road: 0x7a6f68, roadEdge: 0x685e58, shoulder: 0xb27a58,
      terrain: [0xb8623e, 0xc9774f, 0xa4563a, 0xd39a6e],
      lake: 0x6f9a8e, lakeShore: 0x9fb59c,
      trunk: 0x7a6a58, birchTrunk: 0xd8d3c8,
      spruce: [0x4c6a3f, 0x56744a, 0x435d38], pine: [0x5b7248, 0x668052, 0x506640], birch: [0x8fa64c, 0xb8b64a, 0x7f9a45],
      rock: 0xb85a3a, ridgeNear: 0xa25a44, ridgeFar: 0xc48a6c, farFloor: 0xb87050,
      cabin: 0xd9c3a3, cabinRoof: 0x6e4a36, wall: 0xb0724f,
    },
  },

  /* The cliff road (Glacier, Going-to-the-Sun): old cedar bottoms, lakes
   * the colour of glacier flour, a narrow paved shelf with a stone wall on
   * the drop side, a pass that keeps its snow into summer, and the long
   * way down through the avalanche chutes. The Rockies' scale, not the
   * Alps': the mountains are further away and bigger for it. */
  highline: {
    key: "highline", name: "Highline", surf: "tarmac", ground: "grass",
    halfWidth: 3.3,
    elevMacro: [[15, 1000], [5, 420], [1.6, 180]],
    trendMax: 0.05, crestLove: 0.4, jumpLove: 0.2, dipLove: 0.2,
    terrDetail: [1.5, 24], terrHills: [19, 180], hillShape: 1.05, ditch: 0.25,
    camberP: 0.48, offCamberP: 0.1,
    lakeP: 0.18, waterDrop: 1.4, waterName: "lake", walls: false,
    moods: {
      calm: [["cruiseRun", 4], ["kink", 2], ["lakeside", 2.6], ["sweepChain", 1.4]],
      flow: [["sweepChain", 4.5], ["rhythmSet", 3], ["sBend", 2], ["lakeside", 1.5]],
      tech: [["techComplex", 3.8], ["hairpinDrop", 3.2], ["sBend", 2.6], ["rhythmSet", 1.4]],
      fast: [["speedRun", 4.5], ["kink", 2.5], ["sweepChain", 2], ["jumpLine", 0.6]],
    },
    trees: [["cedar", 4], ["spruce", 3], ["larch", 2.2]],
    treeStep: 4.6, treeDensity: 0.58, rockP: 0.1, cabinP: 0.3, cabinType: "cabin", drift: "leaf",
    weather: { rain: 0.42, fog: 0.45, cloud: 0.5 },
    amb: { wind: 0.55, forest: 0.75, birds: 0.35, loon: 0.5, raptor: 0.3, owl: 0.35 },
    neighbours: { aspenvale: 0.9, norrland: 0.6, cauldron: 0.7, kaldbrekka: 0.3, ventisca: 0.4 },
    transitionLine: "the big peaks are behind us now. gentler country ahead",
    palette: {
      skyTop: 0x5a9bd8, skyHor: 0xe9eff0, fog: 0xd0dde4,
      /* Dark cedar and larch gold below, grey argillite and scree above,
       * and lakes that are turquoise because the glaciers grind the rock
       * to flour. The turquoise is the country's whole signature. */
      sun: 0xfff4dc, sunInt: 1.05, hemiSky: 0xc4dcee, hemiGround: 0x4e6047, hemiInt: 0.72,
      road: 0x74736f, roadEdge: 0x63625e, shoulder: 0x5f7452,
      terrain: [0x4f7346, 0x5c8150, 0x7d8a7a, 0x9aa39c],
      lake: 0x3fa4a6, lakeShore: 0x86c4c2,
      trunk: 0x5b4636, birchTrunk: 0x8a7a5a,
      spruce: [0x24422d, 0x2e5136, 0x1e3a28], pine: [0x36573a, 0x40663f, 0x2f4d33], birch: [0xd8a338, 0xe3b64a, 0xc9922c],
      rock: 0x8e9196, ridgeNear: 0x5d7590, ridgeFar: 0x96acc2, farFloor: 0x4b6a45,
      cabin: 0x6b4a30, cabinRoof: 0x3b3e42, wall: 0x8f8a80,
    },
  },

  /* Thermal country (Yellowstone): wide meadows something big has grazed,
   * a burn of grey snags with the green coming back underneath, a geyser
   * basin where the ground steams and the pools are the wrong blue, a
   * yellow canyon, and lodgepole forest so thick there is no view. Wide
   * smooth tarmac, because the roads here were built for looking. */
  cauldron: {
    key: "cauldron", name: "Cauldron", surf: "tarmac", ground: "grass",
    halfWidth: 3.9,
    elevMacro: [[7, 950], [2.6, 400], [1.0, 170]],
    trendMax: 0.025, crestLove: 0.4, jumpLove: 0.25, dipLove: 0.25,
    terrDetail: [1.1, 22], terrHills: [9, 140], hillShape: 0.9, ditch: 0.2,
    camberP: 0.4, offCamberP: 0.06,
    lakeP: 0.14, waterDrop: 0.9, waterName: "pool", walls: false,
    moods: {
      calm: [["cruiseRun", 5], ["kink", 2], ["lakeside", 2], ["sweepChain", 1.5]],
      flow: [["sweepChain", 5], ["rhythmSet", 2.5], ["cruiseRun", 1.5], ["sBend", 1.5]],
      tech: [["techComplex", 3], ["sBend", 3], ["rhythmSet", 2.5], ["hairpinDrop", 1]],
      fast: [["speedRun", 5.5], ["kink", 2.5], ["jumpLine", 1.6], ["sweepChain", 1.5]],
    },
    trees: [["lodgepole", 6], ["snag", 2.5], ["pine", 1.2]],
    treeStep: 4.4, treeDensity: 0.55, rockP: 0.06, cabinP: 0.2, cabinType: "cabin", drift: "leaf",
    weather: { rain: 0.3, fog: 0.35, cloud: 0.4 },
    amb: { wind: 0.4, forest: 0.5, birds: 0.4, corvid: 0.35, raptor: 0.3, owl: 0.3 },
    neighbours: { highline: 0.7, norrland: 0.5, redgate: 0.4, sandreach: 0.4 },
    transitionLine: "the steam is behind us. ordinary ground again",
    palette: {
      skyTop: 0x6aa6da, skyHor: 0xece6d6, fog: 0xdedad0,
      /* Meadow green against sinter white and sulphur yellow; the pools
       * are a hot turquoise the lakes of no other country have. */
      sun: 0xfff0d2, sunInt: 1.0, hemiSky: 0xd0dde6, hemiGround: 0x8e8a66, hemiInt: 0.72,
      road: 0x736f6b, roadEdge: 0x62605c, shoulder: 0x9a9a70,
      terrain: [0x8e9a5c, 0xd9d3b4, 0xc8b56a, 0x7d8b58],
      lake: 0x2fa9b8, lakeShore: 0xd9c99a,
      trunk: 0x5e4c3c, birchTrunk: 0x8d8579,
      spruce: [0x3b5a36, 0x466843, 0x334d2f], pine: [0x4a6a3c, 0x557a45, 0x415d35], birch: [0x8aa050, 0x9db15a, 0x7a9048],
      rock: 0xc9c0a8, ridgeNear: 0x6a7f86, ridgeFar: 0x9fb0b6, farFloor: 0x88925c,
      cabin: 0x6e5237, cabinRoof: 0x3f3d38, wall: 0xa89a7e,
    },
  },

  /* The mountain pass road (a Japanese touge: Hakone, Irohazaka, Nikko):
   * tea terraces, an avenue of cedars planted four centuries ago, a
   * ladder of numbered hairpins behind a guard rail, torii and stone
   * lanterns in the mist at the top, and a gorge road down beside the
   * river. Narrow dark tarmac, the tightest country in the game. */
  kurotani: {
    key: "kurotani", name: "Kurotani", surf: "tarmac", ground: "grass",
    halfWidth: 2.9,
    elevMacro: [[12, 900], [4.5, 380], [1.5, 160]],
    trendMax: 0.055, crestLove: 0.3, jumpLove: 0.08, dipLove: 0.2,
    terrDetail: [1.6, 22], terrHills: [16, 160], hillShape: 1.0, ditch: 0.35,
    camberP: 0.5, offCamberP: 0.12,
    lakeP: 0.1, waterDrop: 1.8, waterName: "river", walls: false,
    moods: {
      calm: [["cruiseRun", 2.5], ["kink", 2.5], ["lakeside", 1.5], ["sweepChain", 2]],
      flow: [["sweepChain", 4], ["rhythmSet", 3.5], ["sBend", 2.5], ["kink", 1.5]],
      tech: [["techComplex", 4.5], ["hairpinDrop", 4], ["sBend", 3], ["rhythmSet", 2]],
      fast: [["speedRun", 2.5], ["kink", 3], ["sweepChain", 2.5], ["cruiseRun", 1]],
    },
    trees: [["cedar", 6], ["pine", 2], ["birch", 2.2]],
    treeStep: 4.2, treeDensity: 0.64, rockP: 0.06, cabinP: 0.35, cabinType: "cabin", drift: "leaf",
    weather: { rain: 0.5, fog: 0.55, cloud: 0.55 },
    amb: { wind: 0.3, forest: 0.8, birds: 0.5, crickets: 0.4, cicada: 0.6, owl: 0.4, corvid: 0.3 },
    neighbours: { costa: 0.6, aspenvale: 0.5, thornmoor: 0.4, heartland: 0.5 },
    transitionLine: "out of the cedars. the road is widening again",
    palette: {
      skyTop: 0x6f9fca, skyHor: 0xe3e8e6, fog: 0xc8d2cf,
      /* Deep wet green, dark tarmac, and the birch slot turned momiji
       * red: the maples are the only warm thing in the country. */
      sun: 0xfff1dc, sunInt: 0.95, hemiSky: 0xc3d6e2, hemiGround: 0x3e5440, hemiInt: 0.7,
      road: 0x6e6f72, roadEdge: 0x5b5c5f, shoulder: 0x4f6a48,
      terrain: [0x3f6b3f, 0x4c7a47, 0x365c38, 0x5d8a4c],
      lake: 0x5b8f9c, lakeShore: 0x86aeb2,
      trunk: 0x5c4536, birchTrunk: 0xb59c7a,
      spruce: [0x243f2c, 0x2d4c33, 0x1e3626], pine: [0x35573a, 0x3f6542, 0x2c4a31], birch: [0xb8473a, 0xcf5a3f, 0x9d3a33],
      rock: 0x777b7a, ridgeNear: 0x536a78, ridgeFar: 0x8fa2ae, farFloor: 0x3b5a3d,
      cabin: 0x7a5a42, cabinRoof: 0x3a3f46, wall: 0x8b877c,
    },
  },

  /* The windy south (Patagonia: the steppe, the towers, the lakes): wide
   * gravel ripio across straw-coloured steppe behind sheep fences, lenga
   * forest gone red, granite towers standing up out of nowhere, a lake
   * the colour of milk and sky, and the edge of the ice field where the
   * wind comes off like a wall. The wind is the country. */
  ventisca: {
    key: "ventisca", name: "Ventisca", surf: "gravel", ground: "scrub",
    halfWidth: 4.0,
    elevMacro: [[8, 1100], [3, 420], [1.1, 180]],
    trendMax: 0.03, crestLove: 0.45, jumpLove: 0.4, dipLove: 0.3,
    terrDetail: [1.2, 26], terrHills: [13, 200], hillShape: 1.2, ditch: 0.15,
    camberP: 0.35, offCamberP: 0.08,
    lakeP: 0.2, waterDrop: 1.2, waterName: "lake", walls: false,
    moods: {
      calm: [["cruiseRun", 5], ["kink", 2], ["lakeside", 2.2], ["sweepChain", 1.6]],
      flow: [["sweepChain", 5.5], ["rhythmSet", 2.2], ["cruiseRun", 1.6], ["kink", 1.4]],
      tech: [["techComplex", 2.6], ["sBend", 3], ["rhythmSet", 2.4], ["hairpinDrop", 1]],
      fast: [["speedRun", 6], ["kink", 2.5], ["jumpLine", 2], ["sweepChain", 1.6]],
    },
    trees: [["shrub", 5], ["birch", 2], ["spruce", 0.6]],
    treeStep: 6.5, treeDensity: 0.3, rockP: 0.12, cabinP: 0.2, cabinType: "cabin", drift: "leaf",
    weather: { rain: 0.35, fog: 0.2, cloud: 0.5 },
    amb: { wind: 1.0, birds: 0.15, raptor: 0.5, corvid: 0.2 },
    neighbours: { kaldbrekka: 0.7, thornmoor: 0.6, highline: 0.4, redgate: 0.3 },
    transitionLine: "the wind is dropping. somewhere with trees ahead",
    palette: {
      skyTop: 0x5d97cc, skyHor: 0xe6e9e6, fog: 0xd3d9d6,
      /* Straw steppe, grey granite, lenga red in the birch slot, and
       * glacial turquoise water: cold light with one hot colour. */
      sun: 0xfff2e0, sunInt: 0.95, hemiSky: 0xc9d9e6, hemiGround: 0x8a8a6a, hemiInt: 0.7,
      road: 0x9a9284, roadEdge: 0x847c70, shoulder: 0x9c9a78,
      terrain: [0xa9a676, 0x8e9668, 0xbcb383, 0x7f8c60],
      lake: 0x3d9fb7, lakeShore: 0x9dc5cc,
      trunk: 0x5a4a3c, birchTrunk: 0x7c6a58,
      spruce: [0x3d5a3c, 0x47673f, 0x344f34], pine: [0x4a663e, 0x557344, 0x405a36], birch: [0xc0542f, 0xd4703a, 0xa64428],
      rock: 0x6f7278, ridgeNear: 0x5b6c82, ridgeFar: 0x9aa9ba, farFloor: 0x9a9a70,
      cabin: 0xa83a2c, cabinRoof: 0x4a4a48, wall: 0x8a8478,
    },
  },
  /* THE VERGE — the bible's late-run surrealism: "very long runs can
   * gradually become geographically impossible. That is fine. But do it
   * beautifully." Not on any country's neighbour map — the director offers
   * it only deep into a journey (game/director.js owns the distance gate),
   * and from inside it every road leads back out: a place you visit, not a
   * place you stay. Glowing strata in the ground, monoliths nobody built,
   * bridges with nothing holding them up (world.js flags them; the deck,
   * kerbs and parapets stay honest colliders — only the piers are missing,
   * which is the point). The road itself never stops being honest: corners
   * sized from the same numbers, every collider visible, no jokes. */
  verge: {
    key: "verge", name: "The Verge", surf: "tarmac", ground: "rockflat",
    halfWidth: 4.1,
    elevMacro: [[13, 1150], [4, 420], [1.2, 180]],
    trendMax: 0.03, crestLove: 0.5, jumpLove: 0.3, dipLove: 0.3,
    terrDetail: [1.5, 24], terrHills: [13, 175], hillShape: 1.35, ditch: 0.1,
    camberP: 0.3, offCamberP: 0.04,
    lakeP: 0.12, waterDrop: 2.5, waterName: "stillwater", walls: false,
    verge: true, aurora: true,
    moods: {
      calm: [["cruiseRun", 4], ["lakeside", 3], ["kink", 2], ["sweepChain", 1.5]],
      flow: [["sweepChain", 6], ["rhythmSet", 2], ["sBend", 1.5], ["kink", 1]],
      tech: [["techComplex", 3], ["sBend", 3], ["hairpinDrop", 1.5], ["rhythmSet", 2]],
      fast: [["speedRun", 6], ["kink", 2], ["jumpLine", 1.5], ["sweepChain", 1.5]],
    },
    trees: [["shrub", 2]],
    treeStep: 9, treeDensity: 0.08, rockP: 0.14, cabinP: 0, cabinType: "cabin", drift: "mote",
    weather: { rain: 0.02, fog: 0.3, cloud: 0.15 },
    amb: { wind: 0.5, strange: 0.8 },
    neighbours: { norrland: 0.7, aspenvale: 0.7, costa: 0.7 },
    transitionLine: "the map makes sense again. nearly home",
    palette: {
      skyTop: 0x5a6db0, skyHor: 0xf0e6f5, fog: 0xd8cfe6,
      sun: 0xfff0e0, sunInt: 0.85, hemiSky: 0xc9c4e8, hemiGround: 0x5a5468, hemiInt: 0.68,
      road: 0x9a97a8, roadEdge: 0x86829a, shoulder: 0x76718c,
      terrain: [0x655d80, 0x8a6a92, 0x4f5a78, 0xa88ba0],
      lake: 0x8a94c9, lakeShore: 0xa8aed6,
      trunk: 0x4a4458, birchTrunk: 0xb8b2c8,
      // the shrub part draws from the `birch` array — dark violet scrub
      birch: [0x554d6c, 0x635a7c, 0x484056],
      rock: 0x9aa4c4, ridgeNear: 0x6a6f9c, ridgeFar: 0x9aa0c8, farFloor: 0x5c5878,
      cabin: 0x4a4460, cabinRoof: 0x2a2738, wall: 0x8a86a0,
    },
  },
};

/* -------------------------------------------------------- prop footprints
 *
 * How far a prop's geometry actually reaches from its origin, so that
 * placement and the clipping test can agree on one definition of "clear
 * of the road" instead of each guessing.
 *
 *   [radius, crossHalf]
 *
 * `radius` is the honest bound for anything stood at a random angle — a
 * tree, a rock, a shrine. `crossHalf` is for the props laid ALONG the road
 * (`rot: -heading`): a terrace wall is six metres long and half a metre
 * thick, and only the half-metre can ever reach the deck, so bounding it
 * by its length would push every wall four metres into the field and
 * quietly delete the coast walls, which are meant to be at the kerb.
 * Defaults to `radius` when absent.
 *
 * On a corner an along-road prop is a chord across an arc, so its ends
 * swing inward by about a²k/2 — small, but it is the difference between a
 * kerb on the apex and a kerb in the racing line. */
export const PROP_REACH = {
  spruce: [1.5], pine: [1.2], birch: [1.2], cypress: [0.7], olive: [1.6],
  umbrella: [2.5], cactus: [1.3], shrub: [0.9], rock: [1.2], rockRed: [1.6],
  mesa: [30], cabin: [3.1], villa: [4.6],
  wall: [2.61, 0.25],
  boathouse: [4.5], woodpile: [1.3], cairn: [0.7], snowpole: [0.12],
  shrine: [0.6], terrace: [3.66, 1.95], milestone: [0.3], fence: [3.5, 0.1],
  hoodoo: [1.8], windpump: [1.2], turbine: [2.4], saltpost: [0.3],
  snowfence: [2.3, 0.2], fishrack: [1.9, 0.7], monolith: [1.5], oldslab: [3.0, 2.0],
  gallerypost: [0.6, 0.45], galleryroof: [6.6], snowblock: [1.1],
  waterfall: [3.6, 2.7], kerb: [2.35, 0.48], observatory: [7.5],
  waystation: [6], waysign: [1.4],
  /* railline and cattlegrid sit ON the deck by design (onRoad marks) —
   * flat and drivable, so their reach is only used by pruneOverlaid */
  railline: [1.4], cattlegrid: [1.4],
  radiomast: [2.8], monastery: [9], shipwreck: [5.5],
  cone: [0.3], barrier: [1.7, 0.35], dampost: [0.3], intaketower: [3.2],
  grandstand: [15],
  standingstone: [0.7], peatstack: [1.2],
  hedge: [3.3, 0.7], haybale: [1.1],
  // the park countries + the towns (2026-08-31)
  cottonwood: [2.2], cedar: [1.3], lodgepole: [0.9], snag: [0.6], larch: [1.1],
  canyonwall: [7.5, 3.2], granitetower: [14], geyser: [2.6], hotpool: [4.2],
  boardwalk: [3.6, 0.7], torii: [2.4, 0.4], lantern: [0.4], guardrail: [3.6, 0.15],
  guardwall: [3.1, 0.3], estanciagate: [2.6, 0.5], lamppost: [0.25],
  dwelling: [4.6], chapel: [5.2],
};

export function propClearance(type, scale, curv, aligned) {
  const e = PROP_REACH[type] || [1];
  const rad = e[0] * (scale || 1);
  if (!aligned) return rad;
  const cross = (e[1] != null ? e[1] : e[0]) * (scale || 1);
  return cross + rad * rad * Math.abs(curv || 0) * 0.5;
}

/* ------------------------------------------------------------ regions
 *
 * A country is not one uniform chunk. Each owns an ordered ring of regions
 * it travels through, and the road walks that ring — so a leg reads as a
 * journey (out of the trees, up onto the moor, over the top, down the far
 * side) rather than four kilometres of the same place.
 *
 * A region is a DELTA on its biome, never a new biome: multipliers on
 * terrain and vegetation, a mood bias, an elevation TREND (the ascent →
 * pass → descent shape is what makes travel legible from the driver's
 * seat), and a small palette tint. Missing fields mean "as the country is".
 *
 *   hills/detail  terrain amplitude multipliers
 *   shape         hillShape override (>1 flattens tops into tables)
 *   trees/step    density multiplier / spacing multiplier
 *   width         road half-width multiplier
 *   mood          mood-weight bias, same units as a route card
 *   crest/jump/lake  appetite multipliers
 *   trend         elevation drift: +1 climbs, −1 falls, 0 rolls
 *   tint/tintA    palette colour pulled towards, and how far (0–1)
 *   rock          rock/boulder probability multiplier
 *   line          what the codriver says on arriving
 *   marks         the things people BUILT or piled up here (see below)
 *   surf          road SURFACE override (Aspenvale's snow line): the
 *                 generator sizes this region's corners for its grip, so
 *                 the gear-grade promise survives the altitude
 *   ground        off-road ground override (snowfield verges at the pass)
 *   cold          precipitation falls as snow here; bridges may carry ice
 *   treeTypes     a tree list that REPLACES the country's in this region
 *                 (a burn is snags, a planted avenue is one species)
 *
 * A mark is what turns a region from a set of terrain multipliers into a
 * place: a boathouse means somebody keeps a boat here, a cairn means
 * somebody walked this moor in fog, a line of snow poles means the road is
 * driven in winter. Vegetation says what the climate is; marks say that
 * the road goes somewhere.
 *
 *   { type, perKm }                      how often, per kilometre
 *   lat: [min, max]                      distance out from the road edge
 *   side: "any" | "water" | "uphill"     which side it belongs on
 *   line: metres                         a REGULAR run of them, both sides
 *                                        (poles and fences are rhythm, not
 *                                        scatter — scattered they read as
 *                                        litter)
 *   side: "downhill"                     the drop side (a guard wall)
 *   facing: true | "road"                squared to the road; "road" turns
 *                                        the front (+Z) toward the deck
 *   colliderR: metres                    a built thing's real footprint
 *   gap: metres                          minimum spacing per side (houses)
 *   type "dwelling"                      the country's own cabinType
 */
const R = (key, name, d) => Object.assign({ key, name, hills: 1, detail: 1, trees: 1, step: 1, width: 1, crest: 1, jump: 1, lake: 1, trend: 0, tintA: 0, rock: 1, mood: {}, marks: null }, d);

export const REGIONS = {
  norrland: [
    R("lakeshore", "Lakeshore", {
      hills: 0.55, trees: 0.9, lake: 2.6, width: 1.04, trend: -0.35, crest: 0.7,
      mood: { calm: 2, flow: 1.6, tech: 0.5, fast: 1 }, tint: 0x7d98a8, tintA: 0.1,
      line: "water on the left for a while",
      marks: [{ type: "boathouse", perKm: 4.5, lat: [3, 7], side: "water" }],
    }),
    R("deepwood", "Deep Forest", {
      hills: 0.85, detail: 1.15, trees: 1.9, step: 0.64, width: 0.94, lake: 0.3,
      mood: { calm: 0.6, flow: 2, tech: 1.8, fast: 0.5 }, tint: 0x28422e, tintA: 0.16,
      line: "into the trees. it gets tight in here",
      marks: [{ type: "woodpile", perKm: 3.0, lat: [2.4, 5], cluster: [1, 2, 6] }],
    }),
    R("rollers", "The Rollers", {
      hills: 1.35, crest: 2.2, jump: 1.5, trend: 0.2, lake: 0.5,
      mood: { calm: 0.8, flow: 2.4, tech: 0.5, fast: 2 }, tint: 0x66804e, tintA: 0.08,
      line: "blind brows now. trust the calls",
    }),
    R("highmoor", "High Moor", {
      hills: 1.6, detail: 0.8, trees: 0.18, step: 1.5, width: 1.06, trend: 0.5, rock: 2.4,
      lake: 0.2, mood: { calm: 1.4, flow: 2, tech: 0.4, fast: 2.2 }, tint: 0x8d9294, tintA: 0.2,
      line: "above the treeline. open country",
      marks: [{ type: "cairn", perKm: 2.6, lat: [5, 16] }],
    }),
    R("descent", "The Descent", {
      hills: 1.2, trees: 0.9, trend: -0.85, crest: 1.2, width: 0.96,
      mood: { calm: 0.5, flow: 1.6, tech: 2.4, fast: 0.8 }, tint: 0x475d38, tintA: 0.1,
      line: "all downhill from here. mind the brakes",
      marks: [{ type: "snowpole", lat: [1.4, 1.4], line: 21 }],
    }),
    /* Quinn: "I never get to drive through deep forests, valleys". The
     * descent ends somewhere: a flat valley floor where the forest is at
     * its thickest and a few people live along the road. */
    R("vale", "The Vale", {
      hills: 0.5, detail: 1.1, trees: 2.4, step: 0.55, width: 0.98, lake: 1.2, trend: -0.1,
      mood: { calm: 1.4, flow: 2.2, tech: 1.4, fast: 0.7 }, tint: 0x3a5c3c, tintA: 0.14,
      line: "the valley floor. thick forest, and a house or two",
      marks: [
        { type: "dwelling", perKm: 1.6, lat: [5, 12], facing: "road", colliderR: 2.1, gap: 30 },
        { type: "woodpile", perKm: 2.6, lat: [2.4, 5], cluster: [1, 2, 6] },
      ],
    }),
  ],
  costa: [
    R("headland", "The Headland", {
      hills: 0.9, trees: 0.55, lake: 2.2, width: 1.05, trend: -0.2,
      mood: { calm: 2, flow: 2, tech: 0.6, fast: 1.2 }, tint: 0x3d7fa8, tintA: 0.09,
      line: "the sea opens up on the right",
      marks: [{ type: "shrine", perKm: 1.6, lat: [2.6, 5] }],
    }),
    R("terraces", "The Terraces", {
      hills: 0.75, detail: 1.3, trees: 1.6, step: 0.85, lake: 0.4, rock: 1.6,
      mood: { calm: 1, flow: 1.6, tech: 2.2, fast: 0.5 }, tint: 0xa89e74, tintA: 0.12,
      line: "olive terraces. walls close on both sides",
      marks: [
        { type: "terrace", lat: [3.2, 3.2], line: 6, side: "uphill" },
        { type: "dwelling", perKm: 1.2, lat: [6, 13], facing: "road", colliderR: 3.2, gap: 40 },
      ],
    }),
    R("cliffroad", "The Cliff Road", {
      hills: 1.5, trees: 0.35, lake: 3, width: 0.88, trend: 0.25, rock: 2,
      mood: { calm: 0.6, flow: 1.4, tech: 3, fast: 0.4 }, tint: 0xb3ab97, tintA: 0.16,
      line: "cliff road. nothing on the sea side",
    }),
    R("climb", "The Climb", {
      hills: 1.35, trees: 0.8, trend: 0.8, crest: 1.3, lake: 0.3,
      mood: { calm: 0.5, flow: 1.5, tech: 2.6, fast: 0.8 }, tint: 0x8a94a0, tintA: 0.12,
      line: "climbing away from the water",
      marks: [{ type: "milestone", perKm: 3.2, lat: [1.8, 3] }],
    }),
  ],
  redgate: [
    R("scrub", "Scrub Flats", {
      hills: 0.5, detail: 0.85, trees: 0.8, width: 1.08, crest: 0.7,
      mood: { calm: 1.6, flow: 1.4, tech: 0.3, fast: 3 }, tint: 0xc2a077, tintA: 0.1,
      line: "flat and open. this one is quick",
      /* fenced range needs a way for the road through it — a cattle grid
       * where the wire meets the tarmac, roughly one a kilometre */
      marks: [{ type: "fence", lat: [8, 8], line: 7 }, { type: "cattlegrid", perKm: 1.4, onRoad: true, lat: [0, 0] }],
    }),
    R("mesas", "Mesa Country", {
      hills: 1.7, shape: 1.9, trees: 0.7, rock: 2.6, trend: 0.3, crest: 1.4,
      mood: { calm: 0.8, flow: 2, tech: 1.2, fast: 1.8 }, tint: 0x9c4a2e, tintA: 0.14,
      marks: [{ type: "hoodoo", perKm: 4.5, lat: [14, 55] }],
      line: "mesas either side now",
    }),
    R("wash", "The Wash", {
      hills: 0.7, detail: 1.4, trees: 1.4, step: 0.85, width: 0.92, trend: -0.6, jump: 1.6,
      mood: { calm: 0.6, flow: 1.8, tech: 2.2, fast: 1 }, tint: 0x8a6a4a, tintA: 0.12,
      line: "down into the wash. watch the ruts",
    }),
    R("plateau", "High Plateau", {
      hills: 1.15, shape: 1.5, trees: 0.4, step: 1.4, trend: 0.55, jump: 1.8, crest: 1.6,
      mood: { calm: 1, flow: 1.6, tech: 0.4, fast: 3 }, tint: 0xd9b98f, tintA: 0.12,
      marks: [{ type: "windpump", perKm: 1.4, lat: [18, 48] }],
      line: "up on the plateau. flat out",
    }),
  ],
  thornmoor: [
    R("inbye", "The Inbye", {
      hills: 0.7, trees: 0.7, width: 1.05, crest: 0.7, trend: 0.15,
      mood: { calm: 2, flow: 1.8, tech: 0.8, fast: 1 }, tint: 0x5f6448, tintA: 0.1,
      line: "walled lanes. the last farms before the moor",
      /* drystone both sides: the one stretch of Thornmoor with company */
      marks: [{ type: "wall", lat: [2.8, 3.2], line: 6 }],
    }),
    R("heather", "The Heather", {
      hills: 1.1, trees: 0.25, step: 1.4, crest: 1.6, lake: 0.4, rock: 1.6,
      mood: { calm: 1.2, flow: 2.2, tech: 0.6, fast: 1.8 }, tint: 0x7a5a68, tintA: 0.18,
      line: "the heather is out. purple to the horizon",
      marks: [
        { type: "standingstone", perKm: 1.2, lat: [8, 30] },
        { type: "cairn", perKm: 1.6, lat: [5, 14] },
      ],
    }),
    R("peatcuts", "The Peat Cuttings", {
      hills: 0.8, detail: 1.3, trees: 0.15, step: 1.5, trend: -0.2, lake: 0.6,
      mood: { calm: 1.2, flow: 1.8, tech: 1.6, fast: 0.8 }, tint: 0x4a4034, tintA: 0.16,
      line: "peat country. the ground is half water here",
      marks: [{ type: "peatstack", perKm: 5, lat: [3, 9], cluster: [2, 4, 8] }],
    }),
    R("tops", "The Tops", {
      hills: 1.5, detail: 0.85, trees: 0.08, step: 1.7, trend: 0.45, crest: 2.6, rock: 2.2,
      mood: { calm: 0.9, flow: 2, tech: 0.5, fast: 2.2 }, tint: 0x82888c, tintA: 0.18,
      line: "the tops. nothing up here but the wind",
      marks: [
        { type: "cairn", perKm: 3, lat: [5, 18] },
        { type: "snowpole", lat: [1.4, 1.4], line: 18 },
      ],
    }),
    R("cloughs", "The Cloughs", {
      hills: 1.3, detail: 1.4, trees: 1.9, step: 0.7, trend: -0.7, width: 0.9,
      mood: { calm: 0.5, flow: 1.5, tech: 2.6, fast: 0.7 }, tint: 0x3d4a38, tintA: 0.12,
      line: "down the clough. trees again, and it tightens",
      marks: [{ type: "milestone", perKm: 2, lat: [1.8, 3] }],
    }),
  ],
  /* The bible's own example, region for region: "foothills → pine forest →
   * high valley → steep ascent → snow line → summit pass → glacier →
   * descent." The ring IS that sentence. */
  aspenvale: [
    R("foothills", "The Foothills", {
      hills: 0.75, trees: 1.1, width: 1.02, crest: 0.7, trend: 0.2,
      mood: { calm: 2, flow: 1.8, tech: 0.8, fast: 1 }, tint: 0x627f52, tintA: 0.1,
      line: "up through the foothills. the pass is a long way up",
      marks: [{ type: "milestone", perKm: 2.4, lat: [1.8, 3] }],
    }),
    R("darkpines", "The Dark Pines", {
      hills: 0.9, detail: 1.2, trees: 2.2, step: 0.6, width: 0.94, lake: 0.3,
      mood: { calm: 0.6, flow: 2, tech: 1.8, fast: 0.6 }, tint: 0x25402a, tintA: 0.16,
      line: "into the pines. dark in here, and it winds",
      marks: [{ type: "woodpile", perKm: 2.6, lat: [2.4, 5], cluster: [1, 2, 6] }],
    }),
    R("highvalley", "The High Valley", {
      hills: 0.6, trees: 0.5, step: 1.3, width: 1.04, lake: 2.4, trend: 0.1,
      mood: { calm: 2.2, flow: 2, tech: 0.5, fast: 1.2 }, tint: 0x9aa886, tintA: 0.14,
      line: "the high valley. flat water and thin air",
      marks: [{ type: "shrine", perKm: 1.4, lat: [2.6, 5] }],
    }),
    R("theladder", "The Ladder", {
      hills: 1.4, detail: 1.2, trees: 0.7, width: 0.92, trend: 0.95, rock: 2, crest: 1.2,
      mood: { calm: 0.4, flow: 1.2, tech: 3, fast: 0.5 }, tint: 0x8f949a, tintA: 0.14,
      line: "the ladder. hairpins stacked to the top",
      marks: [{ type: "milestone", perKm: 3, lat: [1.8, 3] }],
    }),
    R("snowline", "The Snow Line", {
      surf: "snow", ground: "snowfield", cold: true,
      hills: 1.2, detail: 0.85, trees: 0.3, step: 1.6, trend: 0.5, rock: 1.8, crest: 1.4,
      mood: { calm: 1.4, flow: 2, tech: 0.5, fast: 1.2 }, tint: 0xe6ebf0, tintA: 0.72,
      line: "the snow line. the grip goes with the altitude",
      marks: [{ type: "snowpole", lat: [1.4, 1.4], line: 16 }],
    }),
    R("thepass", "The Pass", {
      surf: "snow", ground: "snowfield", cold: true,
      hills: 1.7, detail: 0.7, trees: 0.05, step: 1.9, trend: 0.25, crest: 2, rock: 1.6,
      mood: { calm: 1, flow: 2, tech: 0.5, fast: 1.8 }, tint: 0xeef2f5, tintA: 0.88,
      line: "the pass. over the top of the world",
      marks: [
        { type: "cairn", perKm: 2.4, lat: [5, 16] },
        { type: "snowpole", lat: [1.4, 1.4], line: 18 },
      ],
    }),
    R("glacierside", "The Glacier", {
      surf: "snow", ground: "snowfield", cold: true,
      hills: 1.1, detail: 1.1, trees: 0.1, step: 1.8, lake: 2.6, trend: -0.25,
      mood: { calm: 1.6, flow: 2, tech: 0.6, fast: 1.2 }, tint: 0xd6e6ee, tintA: 0.8,
      line: "along the glacier. blue ice below us",
      marks: [{ type: "snowfence", lat: [3.2, 3.2], line: 9, side: "uphill" }],
    }),
    R("thedescent", "The Long Way Down", {
      hills: 1.3, detail: 1.2, trees: 0.9, width: 0.94, trend: -0.95, crest: 1.1,
      mood: { calm: 0.5, flow: 1.5, tech: 2.6, fast: 0.7 }, tint: 0x4a6742, tintA: 0.12,
      line: "down we go. all the way to the valley",
      marks: [{ type: "milestone", perKm: 2.2, lat: [1.8, 3] }],
    }),
  ],
  /* A journey inland and up: moss country in from the coast, the ice
   * lakes, black rock, drift country, and the fell gate back down. */
  kaldbrekka: [
    R("themoss", "The Moss", {
      hills: 0.55, trees: 0.7, width: 1.04, crest: 0.7,
      mood: { calm: 2, flow: 1.8, tech: 0.6, fast: 1.2 }, tint: 0x7a8a6a, tintA: 0.22,
      line: "moss country. green through the snow",
      marks: [{ type: "fishrack", perKm: 2.2, lat: [3.5, 9], cluster: [1, 2, 9] }],
    }),
    R("icelakes", "The Ice Lakes", {
      hills: 0.5, trees: 0.4, step: 1.4, lake: 3, width: 1.05,
      mood: { calm: 1.8, flow: 2.2, tech: 0.4, fast: 1.4 }, tint: 0xcfe0e8, tintA: 0.2,
      line: "ice lakes. flat as glass out there",
      marks: [
        { type: "fishrack", perKm: 2.6, lat: [3.5, 8], side: "water", cluster: [1, 2, 9] },
        { type: "snowpole", lat: [1.4, 1.4], line: 20 },
      ],
    }),
    R("blackridge", "The Black Ridge", {
      hills: 1.6, detail: 0.8, trees: 0.08, step: 1.8, trend: 0.55, rock: 3, crest: 1.8,
      mood: { calm: 0.8, flow: 2, tech: 0.6, fast: 2.2 }, tint: 0x3a4148, tintA: 0.2,
      line: "black rock through the white. the ridge",
      marks: [{ type: "cairn", perKm: 2.8, lat: [5, 16] }],
    }),
    R("thedrifts", "The Drifts", {
      hills: 0.85, detail: 1.35, trees: 0.05, step: 1.9, width: 0.94,
      mood: { calm: 1.3, flow: 2.2, tech: 0.8, fast: 1.4 }, tint: 0xeef2f5, tintA: 0.5,
      line: "drift country. keep it rolling",
      marks: [{ type: "snowpole", lat: [1.4, 1.4], line: 14 }],
    }),
    R("fellgate", "The Fell Gate", {
      hills: 1.25, detail: 1.2, trees: 0.6, trend: -0.55, width: 0.96, rock: 1.8,
      mood: { calm: 0.6, flow: 1.7, tech: 2.2, fast: 0.8 }, tint: 0x8fa4b4, tintA: 0.16,
      line: "down through the fell gate",
      marks: [{ type: "milestone", perKm: 2, lat: [1.8, 3] }],
    }),
  ],
  heartland: [
    R("pastures", "The Pastures", {
      hills: 0.75, trees: 0.9, width: 1.02, crest: 0.7,
      mood: { calm: 2.2, flow: 1.8, tech: 0.6, fast: 1 }, tint: 0x7d9448, tintA: 0.1,
      line: "hedge country. easy lanes between the farms",
      marks: [
        { type: "hedge", lat: [2.4, 2.8], line: 7 },
        { type: "dwelling", perKm: 1.4, lat: [6, 14], facing: "road", colliderR: 2.1, gap: 40 },
      ],
    }),
    R("wheat", "The Wheat", {
      hills: 0.55, detail: 0.8, trees: 0.3, step: 1.5, width: 1.06, crest: 0.8,
      mood: { calm: 1.4, flow: 1.6, tech: 0.3, fast: 2.6 }, tint: 0xd0be72, tintA: 0.2,
      line: "wheat to the horizon. put your foot down",
      marks: [
        { type: "haybale", perKm: 7, lat: [4, 14], cluster: [2, 4, 12] },
        { type: "windpump", perKm: 1.2, lat: [16, 42] },
      ],
    }),
    R("orchards", "The Orchards", {
      hills: 0.8, detail: 1.1, trees: 1.8, step: 0.75, width: 0.94,
      mood: { calm: 1.2, flow: 1.8, tech: 1.8, fast: 0.6 }, tint: 0x6f8a44, tintA: 0.12,
      line: "through the orchards. trees in rows, corners in pairs",
      marks: [{ type: "fence", lat: [3.4, 3.4], line: 7 }],
    }),
    R("millbrook", "The Millbrook", {
      hills: 0.9, detail: 1.25, trees: 1.2, trend: -0.3, lake: 2, width: 0.95,
      mood: { calm: 1.6, flow: 1.8, tech: 1.4, fast: 0.6 }, tint: 0x6f94a4, tintA: 0.1,
      line: "down along the brook. ponds and willows",
      marks: [{ type: "woodpile", perKm: 2.5, lat: [2.4, 5], cluster: [1, 2, 6] }],
    }),
    R("ridgeway", "The Ridgeway", {
      hills: 1.2, trees: 0.4, step: 1.3, trend: 0.4, crest: 1.8, rock: 1.4,
      mood: { calm: 1, flow: 2.2, tech: 0.5, fast: 2 }, tint: 0xa2a86a, tintA: 0.12,
      line: "up on the old ridgeway. you can see three counties",
      marks: [{ type: "milestone", lat: [1.6, 2.2], line: 140 }],
    }),
  ],
  /* The Verge walks its own ring like any honest country — that is what
   * keeps it coherent rather than a gimmick: thin air, then the glowing
   * strata, the monolith field, a mirror lake with monoliths standing IN
   * it, and the climb out along the edge of something. */
  verge: [
    R("thinair", "The Thin Air", {
      hills: 0.6, trees: 0.3, width: 1.05, crest: 0.6,
      mood: { calm: 2.4, flow: 1.8, tech: 0.5, fast: 1 }, tint: 0xb9b2cc, tintA: 0.28,
      line: "quiet up here. too quiet to mind",
    }),
    R("strata", "The Strata", {
      hills: 1.5, detail: 0.7, trees: 0.05, rock: 2.5, trend: 0.3, crest: 1.3,
      mood: { calm: 0.9, flow: 2.2, tech: 0.8, fast: 1.8 }, tint: 0x8a5a92, tintA: 0.42,
      line: "the ground is glowing. eyes on the road",
      marks: [{ type: "cairn", perKm: 1.6, lat: [6, 18] }],
    }),
    R("monoliths", "The Monolith Field", {
      hills: 0.8, detail: 1.1, trees: 0, step: 1.6, width: 1.02,
      mood: { calm: 1.6, flow: 2, tech: 0.6, fast: 1.4 }, tint: 0x6a6488, tintA: 0.3,
      line: "nobody built these",
      marks: [{ type: "monolith", perKm: 4.2, lat: [7, 30] }],
    }),
    R("stillwater", "The Stillwater", {
      hills: 0.45, trees: 0.06, lake: 3.2, width: 1.04,
      mood: { calm: 2.2, flow: 2.2, tech: 0.4, fast: 1 }, tint: 0x8a94c9, tintA: 0.25,
      line: "still water. and it isn't reflecting the right sky",
      marks: [{ type: "monolith", perKm: 2.4, lat: [4, 12], side: "water" }],
    }),
    R("theedge", "The Edge", {
      hills: 1.7, detail: 1.25, trees: 0.02, trend: 0.6, rock: 3, width: 0.94, crest: 1.7,
      mood: { calm: 0.5, flow: 1.4, tech: 2.4, fast: 0.9 }, tint: 0x4f5a78, tintA: 0.3,
      line: "the edge of something. drive it kindly",
      marks: [{ type: "milestone", perKm: 2.4, lat: [1.8, 2.6] }],
    }),
  ],
  /* Sandreach: down on the river, into the narrows, up the wall, along
   * the rim, and down the wash. A canyon is a place with a bottom and a
   * top, and the ring drives both. */
  sandreach: [
    R("riverbottom", "The River Bottom", {
      hills: 0.6, trees: 1.7, step: 0.75, lake: 2.6, width: 1.02, trend: -0.15, crest: 0.7,
      mood: { calm: 2, flow: 1.8, tech: 0.7, fast: 1 }, tint: 0x8fa64c, tintA: 0.1,
      line: "cottonwoods along the river. shade for once",
      marks: [
        { type: "fence", lat: [4, 4], line: 9 },
        { type: "dwelling", perKm: 1.2, lat: [6, 12], facing: "road", colliderR: 2.1, gap: 40 },
      ],
    }),
    R("narrows", "The Narrows", {
      hills: 1.5, detail: 1.3, shape: 1.9, trees: 0.5, step: 1.2, width: 0.86, rock: 2.2, lake: 0.3,
      mood: { calm: 0.6, flow: 1.6, tech: 2.6, fast: 0.5 }, tint: 0xb85a3a, tintA: 0.16,
      line: "the narrows. walls both sides, the sky is a strip",
      marks: [{ type: "canyonwall", lat: [8, 15], line: 12, colliderR: 4 }],
    }),
    R("switchbacks", "The Switchbacks", {
      hills: 1.4, trees: 0.6, trend: 0.9, rock: 1.8, crest: 1.2, width: 0.92, lake: 0.2,
      mood: { calm: 0.4, flow: 1.2, tech: 3, fast: 0.5 }, tint: 0xc9774f, tintA: 0.12,
      line: "switchbacks up the wall. the tunnel is at the top",
      marks: [{ type: "milestone", perKm: 3, lat: [1.8, 3] }],
    }),
    R("rim", "The Rim", {
      hills: 1.2, shape: 1.6, trees: 0.35, step: 1.5, trend: 0.2, crest: 1.6, jump: 1.4, rock: 2.5, width: 1.04, lake: 0.2,
      mood: { calm: 1, flow: 1.8, tech: 0.5, fast: 2.6 }, tint: 0xd39a6e, tintA: 0.14,
      line: "up on the rim. hoodoos in the amphitheatre",
      marks: [{ type: "hoodoo", perKm: 6, lat: [12, 50] }],
    }),
    R("washout", "The Wash Out", {
      hills: 0.9, detail: 1.35, trees: 1.2, step: 0.9, trend: -0.75, width: 0.94, jump: 1.3,
      mood: { calm: 0.6, flow: 1.8, tech: 2, fast: 1 }, tint: 0xa4563a, tintA: 0.1,
      line: "down the wash. sand in the corners, watch it",
      marks: [{ type: "cairn", perKm: 1.5, lat: [5, 14] }],
    }),
  ],
  /* Highline: the cedar bottoms, the lakes, the shelf road, the pass, the
   * chutes. The Going-to-the-Sun shape: low and green to high and white
   * and back down the other side. */
  highline: [
    R("cedarbottoms", "The Cedar Bottoms", {
      hills: 0.7, detail: 1.15, trees: 2.2, step: 0.6, width: 0.96, lake: 1.4,
      mood: { calm: 1.2, flow: 2, tech: 1.6, fast: 0.6 }, tint: 0x24422d, tintA: 0.16,
      line: "old cedars. the light goes green in here",
      marks: [{ type: "woodpile", perKm: 2, lat: [2.4, 5], cluster: [1, 2, 6] }],
    }),
    R("turquoise", "The Turquoise Lakes", {
      hills: 0.6, trees: 0.8, lake: 3, width: 1.04, trend: 0.1, crest: 0.7,
      mood: { calm: 2.4, flow: 2, tech: 0.5, fast: 1.2 }, tint: 0x3fa4a6, tintA: 0.14,
      line: "the lakes. that colour is glacier flour, not paint",
      marks: [{ type: "boathouse", perKm: 3.5, lat: [3, 7], side: "water" }],
    }),
    R("sunroad", "The Sun Road", {
      hills: 1.6, detail: 1.1, trees: 0.45, step: 1.4, width: 0.88, trend: 0.75, rock: 2.2, crest: 1.2, lake: 0.2,
      mood: { calm: 0.5, flow: 1.5, tech: 2.8, fast: 0.6 }, tint: 0x8e9196, tintA: 0.14,
      line: "the sun road. stone wall on the drop side, and a long way down",
      marks: [
        { type: "guardwall", lat: [1.6, 1.6], line: 6, side: "downhill" },
        { type: "cairn", perKm: 1.2, lat: [5, 12] },
      ],
    }),
    R("goatpass", "The Goat Pass", {
      surf: "snow", ground: "snowfield", cold: true,
      hills: 1.5, detail: 0.8, trees: 0.06, step: 1.9, trend: 0.25, crest: 1.8, rock: 1.8, lake: 0.3,
      mood: { calm: 1, flow: 2, tech: 0.5, fast: 1.6 }, tint: 0xeef2f5, tintA: 0.8,
      line: "the pass. snow in july, goats on the ledges",
      marks: [
        { type: "cairn", perKm: 2.4, lat: [5, 16] },
        { type: "snowpole", lat: [1.4, 1.4], line: 18 },
      ],
    }),
    R("chutes", "The Chutes", {
      hills: 1.3, detail: 1.3, trees: 0.8, step: 0.9, trend: -0.9, width: 0.92, rock: 1.6,
      mood: { calm: 0.5, flow: 1.6, tech: 2.4, fast: 0.8 }, tint: 0x4f7346, tintA: 0.1,
      line: "down through the chutes. the slides keep the trees short",
      marks: [
        { type: "snowfence", lat: [3.2, 3.2], line: 9, side: "uphill" },
        { type: "milestone", perKm: 2, lat: [1.8, 3] },
      ],
    }),
  ],
  /* Cauldron: meadows, the burn, the basin, the canyon, the lodgepoles.
   * Open and quick, then grey, then steaming, then deep, then blind. */
  cauldron: [
    R("meadows", "The Wallow Meadows", {
      hills: 0.55, trees: 0.35, step: 1.5, width: 1.06, crest: 0.7,
      mood: { calm: 2.2, flow: 1.8, tech: 0.4, fast: 2.4 }, tint: 0x8e9a5c, tintA: 0.12,
      line: "open meadows. wide and quick, and something big grazed here",
      marks: [{ type: "fence", lat: [6, 6], line: 7 }],
    }),
    R("theburn", "The Burn", {
      hills: 0.9, trees: 1.8, step: 0.7, rock: 0.6,
      treeTypes: [["snag", 6], ["lodgepole", 2]],
      mood: { calm: 1, flow: 2, tech: 1.2, fast: 1.4 }, tint: 0x8d8579, tintA: 0.22,
      line: "the burn. grey snags for miles, and green coming back underneath",
    }),
    R("thebasin", "The Geyser Basin", {
      hills: 0.5, detail: 0.7, trees: 0.15, step: 1.8, width: 1.04, lake: 2.8, crest: 0.6,
      mood: { calm: 2.4, flow: 1.8, tech: 0.4, fast: 1.2 }, tint: 0xd9d3b4, tintA: 0.3,
      line: "the basin. steam off the ground, and keep the wheels on the road",
      marks: [
        { type: "geyser", perKm: 5, lat: [10, 40] },
        { type: "hotpool", perKm: 4, lat: [8, 30] },
        { type: "boardwalk", lat: [5, 5], line: 10 },
      ],
    }),
    R("yellowcanyon", "The Yellow Canyon", {
      hills: 1.7, shape: 1.3, detail: 1.2, trees: 0.6, step: 1.2, width: 0.9, trend: -0.3, rock: 2.4, lake: 0.3,
      mood: { calm: 0.6, flow: 1.6, tech: 2.4, fast: 0.8 }, tint: 0xc8b56a, tintA: 0.2,
      line: "the canyon. yellow walls and a river a long way down",
      marks: [
        { type: "waterfall", perKm: 1.4, lat: [9, 16], side: "uphill" },
        { type: "milestone", perKm: 2, lat: [1.8, 3] },
      ],
    }),
    R("lodgepoles", "The Lodgepoles", {
      hills: 0.8, detail: 1.1, trees: 2.6, step: 0.5, width: 0.94, lake: 0.3,
      treeTypes: [["lodgepole", 8], ["pine", 1]],
      mood: { calm: 0.7, flow: 2.2, tech: 1.6, fast: 0.8 }, tint: 0x4a6a3c, tintA: 0.14,
      line: "into the lodgepoles. thin trees, thick forest, no view",
      marks: [{ type: "woodpile", perKm: 2.2, lat: [2.4, 5], cluster: [1, 2, 6] }],
    }),
  ],
  /* Kurotani: tea, cedars, the numbered hairpins, the shrine at the top,
   * the gorge down. Every touge in one ring. */
  kurotani: [
    R("teasteps", "The Tea Steps", {
      hills: 0.7, trees: 0.6, width: 1.02, crest: 0.7, trend: 0.15,
      mood: { calm: 2, flow: 1.8, tech: 0.9, fast: 0.9 }, tint: 0x5d8a4c, tintA: 0.12,
      line: "tea terraces. rows on every slope, somebody picks all this",
      marks: [
        { type: "hedge", lat: [2.6, 3.0], line: 7, side: "uphill" },
        { type: "lantern", perKm: 1.5, lat: [1.8, 3] },
        { type: "dwelling", perKm: 1.6, lat: [5, 11], facing: "road", colliderR: 2.1, gap: 30 },
      ],
    }),
    R("cedaravenue", "The Cedar Avenue", {
      hills: 0.8, detail: 1.1, trees: 2.4, step: 0.5, width: 0.94, lake: 0.2,
      treeTypes: [["cedar", 9], ["pine", 1]],
      mood: { calm: 1, flow: 2.2, tech: 1.4, fast: 0.8 }, tint: 0x243f2c, tintA: 0.18,
      line: "the cedar avenue. planted in rows four hundred years ago",
      marks: [{ type: "lantern", lat: [1.8, 1.8], line: 24 }],
    }),
    R("fortyeight", "The Forty-Eight Turns", {
      hills: 1.4, detail: 1.2, trees: 0.9, width: 0.9, trend: 0.95, rock: 1.4, lake: 0.2,
      mood: { calm: 0.4, flow: 1.2, tech: 3.2, fast: 0.4 }, tint: 0x777b7a, tintA: 0.1,
      line: "the forty-eight turns. one after another, all the way up",
      marks: [
        { type: "guardrail", lat: [1.2, 1.2], line: 7, noBerth: true },
        { type: "milestone", perKm: 2.5, lat: [1.8, 3] },
      ],
    }),
    R("shrinepass", "The Shrine Pass", {
      hills: 1.3, detail: 0.9, trees: 0.5, step: 1.3, trend: 0.2, crest: 1.5, lake: 0.3,
      mood: { calm: 1.4, flow: 2, tech: 0.7, fast: 1.4 }, tint: 0xc8d2cf, tintA: 0.2,
      line: "the shrine pass. gates in the mist. bow if you like",
      marks: [
        { type: "torii", perKm: 2.6, lat: [3.5, 7], facing: true, colliderR: 0.7 },
        { type: "lantern", perKm: 4, lat: [1.8, 3.5] },
        { type: "shrine", perKm: 1.2, lat: [2.6, 5] },
      ],
    }),
    R("gorgeroad", "The Gorge Road", {
      hills: 1.5, detail: 1.3, trees: 1.3, step: 0.8, width: 0.9, trend: -0.85, lake: 1.6, rock: 1.8,
      mood: { calm: 0.5, flow: 1.6, tech: 2.6, fast: 0.6 }, tint: 0x365c38, tintA: 0.12,
      line: "down the gorge. river on one side, rock on the other",
      marks: [
        { type: "guardrail", lat: [1.2, 1.2], line: 7, noBerth: true, side: "downhill" },
        { type: "waterfall", perKm: 1.2, lat: [9, 16], side: "uphill" },
      ],
    }),
  ],
  /* Ventisca: the steppe, the lenga, the towers, the lake, the ice. Flat
   * and fast, then red, then vertical, then still, then cold. */
  ventisca: [
    R("steppe", "The Steppe", {
      hills: 0.5, detail: 0.85, trees: 0.6, step: 1.4, width: 1.08, crest: 0.8,
      mood: { calm: 1.8, flow: 1.6, tech: 0.3, fast: 3 }, tint: 0xa9a676, tintA: 0.12,
      line: "the steppe. flat, fast, and the wind has opinions",
      marks: [
        { type: "fence", lat: [7, 7], line: 7 },
        { type: "estanciagate", perKm: 0.9, lat: [3.5, 6], facing: true, colliderR: 0.8 },
        { type: "dwelling", perKm: 0.7, lat: [8, 16], facing: "road", colliderR: 2.1, gap: 60 },
      ],
    }),
    R("lenga", "The Lenga", {
      hills: 0.9, detail: 1.15, trees: 2.2, step: 0.6, width: 0.94, lake: 0.4,
      treeTypes: [["birch", 7], ["spruce", 1.5]],
      mood: { calm: 0.8, flow: 2, tech: 1.8, fast: 0.7 }, tint: 0xc0542f, tintA: 0.16,
      line: "into the lenga. the whole forest has gone red",
      marks: [{ type: "woodpile", perKm: 2, lat: [2.4, 5], cluster: [1, 2, 6] }],
    }),
    R("towers", "The Towers", {
      hills: 1.5, detail: 0.8, trees: 0.2, step: 1.7, trend: 0.5, rock: 2.8, crest: 1.6, lake: 0.2,
      mood: { calm: 1, flow: 2, tech: 0.6, fast: 2 }, tint: 0x6f7278, tintA: 0.16,
      line: "the towers. granite, straight up, and nobody has put a road near them",
      marks: [
        { type: "granitetower", perKm: 2.2, lat: [80, 200] },
        { type: "cairn", perKm: 2, lat: [5, 14] },
      ],
    }),
    R("glaciallake", "The Glacial Lake", {
      hills: 0.55, trees: 0.5, lake: 3, width: 1.04, trend: -0.2, crest: 0.7,
      mood: { calm: 2.4, flow: 2, tech: 0.5, fast: 1.2 }, tint: 0x3d9fb7, tintA: 0.14,
      line: "the lake. milk blue, and the bergs come right to the shore",
      marks: [{ type: "boathouse", perKm: 2.5, lat: [3, 7], side: "water" }],
    }),
    R("icefield", "The Ice Field Edge", {
      ground: "snowfield", cold: true,
      hills: 1.2, trees: 0.05, step: 2, trend: 0.3, rock: 1.5, crest: 1.2, lake: 0.4,
      mood: { calm: 1.4, flow: 2, tech: 0.6, fast: 1.6 }, tint: 0xdde5ea, tintA: 0.55,
      line: "the ice field. the wind comes off it like a wall",
      marks: [
        { type: "snowpole", lat: [1.4, 1.4], line: 16 },
        { type: "cairn", perKm: 2, lat: [5, 14] },
      ],
    }),
  ],
};

/* Region for a biome by index, wrapping. Every biome has at least one. */
export function regionAt(biomeKey, idx) {
  const list = REGIONS[biomeKey] || REGIONS.norrland;
  return list[((idx % list.length) + list.length) % list.length];
}
export function regionCount(biomeKey) {
  return (REGIONS[biomeKey] || REGIONS.norrland).length;
}
export const REGION_KEYS = Object.values(REGIONS).flat().map((r) => r.key);
export const REGION_INDEX = Object.fromEntries(REGION_KEYS.map((k, i) => [k, i]));
export const REGION_BY_INDEX = Object.values(REGIONS).flat();

/* The bible: "Leg 1 is a short Heartland onboarding leg" — the journey
 * begins in the kind country and earns its way to the rally heartbeat.
 * (Quinn signed this off 2026-08-21: any start is fine if it onboards.) */
export const START_BIOME = "heartland";
export const BIOME_KEYS = Object.keys(BIOMES);

/* Numeric index per biome (stored in the world's per-sample rings). */
export const BIOME_INDEX = Object.fromEntries(BIOME_KEYS.map((k, i) => [k, i]));
export const BIOME_LIST = BIOME_KEYS.map((k) => BIOMES[k]);

/* Blend two palettes (hex fields + arrays) for transitions/backdrop. */
function lerpHex(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}
export function blendPalette(pa, pb, t) {
  if (t <= 0 || pa === pb) return pa;
  if (t >= 1) return pb;
  const out = {};
  for (const k in pa) {
    const a = pa[k], b = pb[k];
    if (typeof a === "number" && typeof b === "number") out[k] = k.endsWith("Int") ? a + (b - a) * t : lerpHex(a, b, t);
    else if (Array.isArray(a)) out[k] = a.map((v, i) => lerpHex(v, b[i % b.length], t));
    else out[k] = t < 0.5 ? a : b;
  }
  return out;
}
