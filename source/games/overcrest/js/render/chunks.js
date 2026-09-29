/* Overcrest — streamed geometry: road ribbons, terrain heightfields, props.
 *
 * Terrain is a regular grid of 48 m heightfield chunks sampled from the
 * world's single analytic ground function, so what you drive on and what
 * you see are the same surface — including off-road, shoulders, ditches
 * and lakes. Road sections render as vertex-banded ribbons (wheel tracks,
 * not textures). Vegetation is instanced per section from the sim's own
 * prop lists (the colliders you feel are the trunks you see).
 *
 * Everything is budgeted (≤ 1 heavy build per frame), everything disposes,
 * and everything re-sits when the render anchor snaps.
 */

import * as THREE from "three";
import { PICKUP_KINDS } from "../game/pickups.js";
import { BIOMES } from "../world/biomes.js";
import { SPAN, TUNNEL, spanStrength } from "../world/spans.js";
import { vertGround, makeSeater } from "./seat.js";
import { pondPlan } from "./pond.js";

const CELL = 48;            // terrain chunk size, m
let RES = 16;               // quads per side (3 m vertex spacing; the
                            // terrain-detail setting halves it — render
                            // only, physics reads the analytic ground fn)
const TERR_AHEAD = 560;     // m of road to blanket with terrain
const TERR_BEHIND = 130;
const TRUNK_DIST = 230;     // m past which trunks are too thin to draw honestly

/* THE FAR SHELL — coarse ground ringing the camera out past full fog, so
 * the drawn world never visibly ENDS (hands-on: "the edges of the terrain
 * where it becomes nothing are visible from the road"). Same ground
 * function through vertGround inside the corridor, world.farGround beyond
 * it; hidden wherever the near blanket fully covers it, and sunk a little
 * so a coarse chord never pokes up through the fine surface at the seam.
 * Render-only by contract — physics, props and the harness never see it. */
const FCELL = CELL * 2;     // far cell size (aligned 2×2 over near cells)
const FRES = 8;             // quads per far cell side: 12 m pitch, so every
                            // shell vertex IS a blanket vertex (4 × 3 m) and
                            // the two surfaces agree exactly where they meet
let FAR_R = 1150;           // shell radius, m — past fog.far on a clear day;
                            // the quality ladder pulls it in on weak machines
                            // (cell count falls with the square of the radius)
/* THE SEAM (2026-08-30). The shell is tucked under the blanket where the
 * blanket covers it, so a coarse chord never pokes up through the fine
 * surface — but a uniform tuck was a 0.9 m LEDGE along the blanket's
 * outer cells, a step drawn 100–150 m out on every flank, read from the
 * road as terraces and pits. The tuck is now PER VERTEX: full where every
 * near cell touching the vertex is drawn, zero where one is not — so at
 * the blanket's edge the shell comes up flush and the seam is a join.
 * Shell cells touching a near cell that comes or goes are rebuilt in
 * place (cheap; ~0.2 ms each). Measured with tools/_seamprobe.mjs. */
const FAR_SINK = 0.9;       // the tuck, where the blanket fully covers

/* cosmetic hash noise (render-only, never part of the sim) */
function cnoise(ix, iz) {
  let h = Math.imul(ix, 0x3779b9) ^ Math.imul(iz, 0x85ebca7);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae3);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/* smooth value noise built on the same hash — the ground colour wants
 * coherent meadow-scale patches, not per-vertex confetti */
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = cnoise(ix, iz), b = cnoise(ix + 1, iz), c = cnoise(ix, iz + 1), d = cnoise(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

export function makeChunks(world, kit, biome) {
  const pal = biome.palette;                 // the starting biome (backdrop defaults)
  const palFor = (key) => (BIOMES[key] || biome).palette;
  /* height fog + gentler far-field (scene.js owns the patch): terrain,
   * road, props and spans all breathe the same air */
  const hfog = kit.enableHeightFog || ((m) => m);
  const lambert = hfog(new THREE.MeshLambertMaterial({ vertexColors: true }));
  const roadMat = hfog(new THREE.MeshLambertMaterial({ vertexColors: true }));   // darkens when wet

  /* Puddles that are PLACED, not painted: every ribbon vertex carries a
   * potential (aPud) built from where water would actually stand — sags in
   * the deck, the camber's low edge, the wheel ruts — shaped by smooth
   * noise into pools. The shader mirrors the sky (the fog colour IS the
   * horizon) into those pools as wetness rises, stronger at grazing angles
   * the way a wet road really reads from a chase camera, plus a thin
   * overall sheen. Dry weather zeroes it; night dims it (dark fog colour);
   * golden hour warms it for free. */
  const WET = { uWet: { value: 0 } };
  function wetRoad(mat) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader) => {
      if (prev) prev(shader);
      Object.assign(shader.uniforms, WET);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aPud;\nvarying float vPud;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPud = aPud;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform float uWet;\nvarying float vPud;")
        .replace("float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );",
          "{\n  vec3 wDir = normalize( vViewPosition );\n  float wFres = pow( 1.0 - max( dot( wDir, normalize( normal ) ), 0.0 ), 2.0 );\n  float wMirror = vPud * uWet * ( 0.45 + 0.55 * wFres ) + uWet * wFres * 0.17;\n  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor * 1.22, min( wMirror, 0.85 ) );\n}\nfloat fogFactor = smoothstep( fogNear, fogFar, vFogDepth );");
    };
    mat.customProgramCacheKey = () => "hfog1|wet1";
    return mat;
  }
  wetRoad(roadMat);

  // ---------- shared prop geometries & materials (built once)
  const geoCache = {};
  function geo(name, build) {
    if (!geoCache[name]) geoCache[name] = build();
    return geoCache[name];
  }
  const matCache = {};
  function mat(color) {
    if (!matCache[color]) matCache[color] = hfog(new THREE.MeshLambertMaterial({ color }));
    return matCache[color];
  }

  /* Instanced part vocabulary. `colors`/`color` are palette KEYS resolved
   * per biome at build time, so the same cone is a spruce in Norrland and a
   * dusty cypress on the coast.
   *
   * FRAME RULE for aligned parts (anything placed with `rot: -heading` —
   * line marks, onRoad marks, walls): **+X runs ALONG the road, +Z points
   * across it.** Proven by pixels: the drystone `wall` (long-X) runs along
   * the lane. Half the 2026 parts were built against an imagined opposite
   * frame and drew perpendicular — fences as teeth reaching onto the deck,
   * rails as a 44 m tramline down the carriageway. Build long-X for a run
   * along the verge; build long-Z (or rotateY(-π/2) the merge) for a thing
   * that spans the road. */
  const PARTS = {
    spruceLower: { geo: () => geo("spruceLower", () => { const g = new THREE.ConeGeometry(1.35, 2.7, 7); g.translate(0, 2.15, 0); return g; }), colors: "spruce" },
    spruceUpper: { geo: () => geo("spruceUpper", () => { const g = new THREE.ConeGeometry(0.92, 2.3, 7); g.translate(0, 3.9, 0); return g; }), colors: "spruce" },
    pineCrown: { geo: () => geo("pineCrown", () => { const g = new THREE.ConeGeometry(1.08, 2.0, 6); g.translate(0, 3.4, 0); return g; }), colors: "pine" },
    birchCanopy: { geo: () => geo("birchCanopy", () => { const g = new THREE.IcosahedronGeometry(1.08, 0); g.scale(1, 0.82, 1); g.translate(0, 2.6, 0); return g; }), colors: "birch" },
    trunk: { geo: () => geo("trunk", () => { const g = new THREE.CylinderGeometry(0.09, 0.13, 1.3, 5); g.translate(0, 0.62, 0); return g; }), color: "trunk", thin: true },
    pineTrunk: { geo: () => geo("pineTrunk", () => { const g = new THREE.CylinderGeometry(0.1, 0.14, 2.6, 5); g.translate(0, 1.3, 0); return g; }), color: "trunk", thin: true },
    birchTrunk: { geo: () => geo("birchTrunk", () => { const g = new THREE.CylinderGeometry(0.07, 0.09, 2.1, 5); g.translate(0, 1.02, 0); return g; }), color: "birchTrunk", thin: true },
    rock: { geo: () => geo("rock", () => { const g = new THREE.IcosahedronGeometry(0.82, 0); g.scale(1.3, 0.72, 1); g.translate(0, 0.28, 0); return g; }), color: "rock" },
    // coast
    cypressCrown: { geo: () => geo("cypressCrown", () => { const g = new THREE.ConeGeometry(0.62, 5.6, 6); g.translate(0, 3.6, 0); return g; }), colors: "spruce" },
    oliveCanopy: { geo: () => geo("oliveCanopy", () => { const g = new THREE.IcosahedronGeometry(1.5, 0); g.scale(1.25, 0.7, 1.25); g.translate(0, 2.2, 0); return g; }), colors: "birch" },
    oliveTrunk: { geo: () => geo("oliveTrunk", () => { const g = new THREE.CylinderGeometry(0.16, 0.24, 1.6, 5); g.translate(0, 0.8, 0); return g; }), color: "trunk", thin: true },
    umbrellaCrown: { geo: () => geo("umbrellaCrown", () => { const g = new THREE.ConeGeometry(2.4, 1.6, 7); g.translate(0, 5.0, 0); return g; }), colors: "pine" },
    umbrellaTrunk: { geo: () => geo("umbrellaTrunk", () => { const g = new THREE.CylinderGeometry(0.13, 0.2, 4.6, 5); g.translate(0, 2.3, 0); return g; }), color: "trunk", thin: true },
    wall: { geo: () => geo("wall", () => { const g = new THREE.BoxGeometry(5.2, 0.7, 0.5); g.translate(0, 0.32, 0); return g; }), color: "wall" },
    // desert
    cactusBody: { geo: () => geo("cactusBody", () => { const g = new THREE.CylinderGeometry(0.28, 0.32, 3.0, 7); g.translate(0, 1.5, 0); return g; }), colors: "spruce" },
    cactusArm: { geo: () => geo("cactusArm", () => { const g = new THREE.CylinderGeometry(0.16, 0.18, 1.3, 6); g.rotateZ(Math.PI / 2); g.translate(0.55, 1.9, 0); const a = new THREE.CylinderGeometry(0.16, 0.18, 1.1, 6); a.translate(1.15, 2.4, 0); return mergeGeos([g, a]); }), colors: "spruce" },
    shrub: { geo: () => geo("shrub", () => { const g = new THREE.IcosahedronGeometry(0.75, 0); g.scale(1.2, 0.6, 1.2); g.translate(0, 0.32, 0); return g; }), colors: "birch" },
    rockRed: { geo: () => geo("rockRed", () => { const g = new THREE.IcosahedronGeometry(1.3, 0); g.scale(1.4, 0.9, 1.1); g.translate(0, 0.5, 0); return g; }), color: "rock" },
    /* ---- the park countries (2026-08-31): five trees, then the built and
     * the geological. Colours resolve through the same palette keys, so a
     * cedar is dark in Highline and darker still in Kurotani, and the
     * `birch` slot is a cottonwood, a larch, a maple or a lenga depending
     * on the country that planted it. */
    // a cottonwood: broad round crown on a tall pale trunk (river bottoms)
    cottonwoodCanopy: { geo: () => geo("cwC", () => { const g = new THREE.IcosahedronGeometry(2.0, 0); g.scale(1.3, 0.9, 1.3); g.translate(0, 4.3, 0); return g; }), colors: "birch" },
    cottonwoodTrunk: { geo: () => geo("cwT", () => { const g = new THREE.CylinderGeometry(0.18, 0.28, 3.6, 6); g.translate(0, 1.8, 0); return g; }), color: "birchTrunk", thin: true },
    // a cedar: tall, narrow, two long tiers — seven metres of tree
    cedarLower: { geo: () => geo("cedL", () => { const g = new THREE.ConeGeometry(1.15, 3.6, 7); g.translate(0, 3.0, 0); return g; }), colors: "spruce" },
    cedarUpper: { geo: () => geo("cedU", () => { const g = new THREE.ConeGeometry(0.72, 3.4, 7); g.translate(0, 5.9, 0); return g; }), colors: "spruce" },
    cedarTrunk: { geo: () => geo("cedT", () => { const g = new THREE.CylinderGeometry(0.15, 0.22, 2.4, 5); g.translate(0, 1.2, 0); return g; }), color: "trunk", thin: true },
    // a lodgepole: a very thin very tall pole with a small crown on top
    lodgepoleCrown: { geo: () => geo("lpC", () => { const g = new THREE.ConeGeometry(0.78, 2.6, 6); g.translate(0, 6.2, 0); return g; }), colors: "pine" },
    lodgepoleTrunk: { geo: () => geo("lpT", () => { const g = new THREE.CylinderGeometry(0.09, 0.14, 5.4, 5); g.translate(0, 2.7, 0); return g; }), color: "trunk", thin: true },
    // a snag: a burned tree, bare and silver, two stubs where the branches were
    snag: {
      geo: () => geo("snag", () => {
        const parts = [];
        const t = new THREE.CylinderGeometry(0.11, 0.24, 5.6, 5); t.translate(0, 2.8, 0); parts.push(t);
        const a = new THREE.CylinderGeometry(0.05, 0.08, 1.1, 4); a.rotateZ(1.1); a.translate(0.4, 3.6, 0); parts.push(a);
        const b = new THREE.CylinderGeometry(0.04, 0.07, 0.9, 4); b.rotateZ(-1.3); b.translate(-0.32, 4.4, 0.1); parts.push(b);
        return mergeGeos(parts);
      }),
      fixed: 0x7d7770, thin: true,
    },
    // a larch: a conifer's shape in the birch slot's colour — gold in autumn
    larchCrown: { geo: () => geo("larchC", () => { const g = new THREE.ConeGeometry(0.95, 3.4, 6); g.translate(0, 3.3, 0); return g; }), colors: "birch" },
    /* A canyon wall: a slab of sandstone, stood in a run every twelve metres
     * so the Narrows close in. Long-X (along the road); beds stepped. */
    canyonwall: {
      geo: () => geo("canyonwall", () => {
        const parts = [];
        const a = new THREE.BoxGeometry(14, 22, 5); a.translate(0, 11, 0); parts.push(a);
        const b = new THREE.BoxGeometry(11, 8, 4.2); b.translate(1.5, 26, -0.4); parts.push(b);
        const c = new THREE.BoxGeometry(15, 3, 6.2); c.translate(-0.5, 1.5, 0.3); parts.push(c);
        return mergeGeos(parts);
      }),
      color: "rock",
    },
    /* Granite towers: three spires and a plinth, a hundred metres off the
     * road and seventy tall — the one thing in Ventisca you steer by. */
    granitetower: {
      geo: () => geo("granitetower", () => {
        const parts = [];
        const p = new THREE.BoxGeometry(30, 6, 22); p.translate(0, 3, 0); parts.push(p);
        const a = new THREE.ConeGeometry(9, 60, 6); a.translate(0, 30, 0); parts.push(a);
        const b = new THREE.ConeGeometry(7, 76, 5); b.translate(9, 38, 4); parts.push(b);
        const c = new THREE.ConeGeometry(6, 50, 5); c.translate(-8, 25, -5); parts.push(c);
        return mergeGeos(parts);
      }),
      color: "rock",
    },
    /* A geyser: a sinter mound with a vent, and a plume of steam that is
     * unlit, translucent and taller than the trees — the basin reads from
     * a kilometre away as white columns standing in a field. */
    geyserMound: {
      geo: () => geo("geyserM", () => {
        const parts = [];
        const m = new THREE.ConeGeometry(2.6, 0.7, 9); m.translate(0, 0.35, 0); parts.push(m);
        const v = new THREE.CylinderGeometry(0.35, 0.5, 0.5, 7); v.translate(0, 0.8, 0); parts.push(v);
        return mergeGeos(parts);
      }),
      fixed: 0xe6e2d6,
    },
    geyserSteam: {
      geo: () => geo("geyserS", () => {
        const parts = [];
        const a = new THREE.ConeGeometry(0.9, 4.5, 7); a.translate(0, 3.0, 0); parts.push(a);
        const b = new THREE.ConeGeometry(1.5, 4, 7); b.translate(0.3, 6.2, 0.2); parts.push(b);
        const c = new THREE.IcosahedronGeometry(1.6, 0); c.translate(-0.2, 8.6, 0); parts.push(c);
        return mergeGeos(parts);
      }),
      fixed: 0xf4f6f8, unlit: true, twoSided: true, alpha: 0.42,
    },
    // a hot pool: a sinter lip round water the wrong blue (unlit: it glows)
    hotpoolRim: { geo: () => geo("hpR", () => { const g = new THREE.CylinderGeometry(4.3, 4.6, 0.32, 12); g.translate(0, 0.08, 0); return g; }), fixed: 0xe4dcc4 },
    hotpoolWater: { geo: () => geo("hpW", () => { const g = new THREE.CylinderGeometry(3.6, 3.6, 0.16, 12); g.translate(0, 0.14, 0); return g; }), fixed: 0x2fb0c4, unlit: true },
    // a boardwalk: planks on posts with a handrail, along the road
    boardwalk: {
      geo: () => geo("boardwalk", () => {
        const parts = [];
        const d = new THREE.BoxGeometry(7.2, 0.1, 1.3); d.translate(0, 0.62, 0); parts.push(d);
        for (const x of [-3.3, 3.3]) for (const z of [-0.55, 0.55]) { const p = new THREE.BoxGeometry(0.1, 0.62, 0.1); p.translate(x, 0.31, z); parts.push(p); }
        const r = new THREE.BoxGeometry(7.2, 0.05, 0.05); r.translate(0, 1.3, 0.62); parts.push(r);
        for (const x of [-3.3, 0, 3.3]) { const p = new THREE.BoxGeometry(0.06, 0.7, 0.06); p.translate(x, 0.97, 0.62); parts.push(p); }
        return mergeGeos(parts);
      }),
      fixed: 0x8a7050,
    },
    // a torii: vermilion posts, a dark top beam, the tablet between
    toriiPosts: {
      geo: () => geo("toriiP", () => {
        const parts = [];
        for (const x of [-1.7, 1.7]) { const p = new THREE.CylinderGeometry(0.17, 0.2, 4.4, 8); p.translate(x, 2.2, 0); parts.push(p); }
        const n = new THREE.BoxGeometry(4.0, 0.22, 0.24); n.translate(0, 3.75, 0); parts.push(n);
        return mergeGeos(parts);
      }),
      fixed: 0xc9432a,
    },
    toriiLintel: {
      geo: () => geo("toriiL", () => {
        const parts = [];
        const k = new THREE.BoxGeometry(4.9, 0.34, 0.38); k.translate(0, 4.5, 0); parts.push(k);
        const t = new THREE.BoxGeometry(0.4, 0.5, 0.1); t.translate(0, 4.1, 0.15); parts.push(t);
        return mergeGeos(parts);
      }),
      fixed: 0x2b2622,
    },
    // a stone lantern: base, post, firebox, a little roof, the finial
    lantern: {
      geo: () => geo("lantern", () => {
        const parts = [];
        const b = new THREE.BoxGeometry(0.6, 0.16, 0.6); b.translate(0, 0.08, 0); parts.push(b);
        const p = new THREE.CylinderGeometry(0.12, 0.14, 1.0, 6); p.translate(0, 0.66, 0); parts.push(p);
        const fbx = new THREE.BoxGeometry(0.46, 0.42, 0.46); fbx.translate(0, 1.4, 0); parts.push(fbx);
        const r = new THREE.ConeGeometry(0.55, 0.34, 4); r.rotateY(Math.PI / 4); r.translate(0, 1.78, 0); parts.push(r);
        const fin = new THREE.SphereGeometry(0.09, 6, 4); fin.translate(0, 2.0, 0); parts.push(fin);
        return mergeGeos(parts);
      }),
      color: "rock",
    },
    // a guard rail: galvanised beam on three posts, along the road
    guardrail: {
      geo: () => geo("guardrail", () => {
        const parts = [];
        const r = new THREE.BoxGeometry(7.0, 0.3, 0.06); r.translate(0, 0.72, 0); parts.push(r);
        for (const x of [-2.8, 0, 2.8]) { const p = new THREE.BoxGeometry(0.1, 0.78, 0.14); p.translate(x, 0.39, 0.06); parts.push(p); }
        return mergeGeos(parts);
      }),
      fixed: 0xc8ccd0,
    },
    // a stone guard wall: the shelf road's edge, tidier than a field wall
    guardwall: {
      geo: () => geo("guardwall", () => {
        const parts = [];
        const w = new THREE.BoxGeometry(6.2, 0.75, 0.55); w.translate(0, 0.37, 0); parts.push(w);
        const c = new THREE.BoxGeometry(6.3, 0.12, 0.62); c.translate(0, 0.8, 0); parts.push(c);
        return mergeGeos(parts);
      }),
      color: "wall",
    },
    // an estancia gate: two posts, a crossbar, the name board hanging under it
    estanciagate: {
      geo: () => geo("estanciagate", () => {
        const parts = [];
        for (const x of [-2.2, 2.2]) { const p = new THREE.CylinderGeometry(0.14, 0.16, 3.6, 6); p.translate(x, 1.8, 0); parts.push(p); }
        const c = new THREE.BoxGeometry(4.9, 0.22, 0.22); c.translate(0, 3.55, 0); parts.push(c);
        const sg = new THREE.BoxGeometry(1.6, 0.5, 0.06); sg.translate(0, 3.05, 0); parts.push(sg);
        return mergeGeos(parts);
      }),
      fixed: 0x6b5238,
    },
    /* A lamp post: the post is dark iron, the lamp head wears the shared
     * window material — so it comes on with the night like every window
     * in the game, and a street reads as a string of lights from afar. */
    lamppostPost: {
      geo: () => geo("lampP", () => {
        const parts = [];
        const p = new THREE.CylinderGeometry(0.07, 0.1, 4.4, 6); p.translate(0, 2.2, 0); parts.push(p);
        const a = new THREE.BoxGeometry(0.7, 0.06, 0.06); a.translate(0.3, 4.35, 0); parts.push(a);
        return mergeGeos(parts);
      }),
      fixed: 0x3a3d40, thin: true,
    },
    lamppostLamp: { geo: () => geo("lampL", () => { const g = new THREE.BoxGeometry(0.28, 0.16, 0.28); g.translate(0, 4.28, 0.62); return g; }), glow: true },
    /* A chapel: nave, gable roof, tower, spire, and three tall windows on
     * the street face (+Z) that light with the night. The tallest thing in
     * a town, which is what makes it a town. */
    chapelNave: { geo: () => geo("chN", () => { const g = new THREE.BoxGeometry(7.0, 4.2, 5.0); g.translate(0.8, 2.1, 0); return g; }), color: "wall" },
    chapelRoof: { geo: () => geo("chR", () => { const g = new THREE.BoxGeometry(7.4, 3.6, 3.6); g.rotateX(Math.PI / 4); g.translate(0.8, 4.2, 0); return g; }), color: "cabinRoof" },
    chapelTower: { geo: () => geo("chT", () => { const g = new THREE.BoxGeometry(2.6, 9.5, 2.6); g.translate(-3.6, 4.75, 0); return g; }), color: "wall" },
    chapelSpire: { geo: () => geo("chS", () => { const g = new THREE.ConeGeometry(1.9, 4.2, 4); g.rotateY(Math.PI / 4); g.translate(-3.6, 11.6, 0); return g; }), color: "cabinRoof" },
    chapelWindows: {
      geo: () => geo("chW", () => {
        const parts = [];
        for (const x of [-0.6, 0.8, 2.2]) { const w = new THREE.PlaneGeometry(0.5, 1.4); w.translate(x, 2.4, 2.52); parts.push(w); }
        const t = new THREE.PlaneGeometry(0.4, 0.8); t.translate(-3.6, 7.6, 1.32); parts.push(t);
        return mergeGeos(parts);
      }),
      glow: true,
    },
    /* ---- region marks: what people built or piled up in this place.
     * Same instanced-parts treatment as the trees, so a hundred snow poles
     * cost one draw call. Colours resolve per biome from palette keys. */
    boathouseWalls: { geo: () => geo("bhW", () => { const g = new THREE.BoxGeometry(3.2, 2.0, 2.6); g.translate(0, 1.0, 0); return g; }), color: "cabin" },
    boathouseRoof: { geo: () => geo("bhR", () => { const g = new THREE.ConeGeometry(2.5, 1.1, 4); g.rotateY(Math.PI / 4); g.translate(0, 2.55, 0); return g; }), color: "cabinRoof" },
    boathouseJetty: { geo: () => geo("bhJ", () => { const parts = []; const d = new THREE.BoxGeometry(1.3, 0.16, 6.5); d.translate(0, 0.42, 4.2); parts.push(d); for (let k = 0; k < 3; k++) { const pl = new THREE.BoxGeometry(0.14, 1.0, 0.14); pl.translate(0.5, 0, 2.2 + k * 2.2); parts.push(pl); const pr = new THREE.BoxGeometry(0.14, 1.0, 0.14); pr.translate(-0.5, 0, 2.2 + k * 2.2); parts.push(pr); } return mergeGeos(parts); }), color: "trunk" },
    /* Cut timber stacked to season: two courses of logs on bearers, which
     * is one merged geometry and reads instantly as "somebody works here". */
    woodpile: {
      geo: () => geo("woodpile", () => {
        const parts = [];
        for (let row = 0; row < 2; row++) {
          for (let k = 0; k < 5; k++) {
            const log = new THREE.CylinderGeometry(0.19, 0.19, 2.4, 6);
            log.rotateX(Math.PI / 2);
            log.translate((k - 2) * 0.4 + (row % 2) * 0.2, 0.24 + row * 0.39, 0);
            parts.push(log);
          }
        }
        return mergeGeos(parts);
      }),
      color: "trunk",
    },
    cairn: {
      geo: () => geo("cairn", () => {
        const parts = [];
        const sizes = [0.62, 0.5, 0.4, 0.29, 0.19];
        let y = 0;
        for (let k = 0; k < sizes.length; k++) {
          const st = new THREE.IcosahedronGeometry(sizes[k], 0);
          st.scale(1.15, 0.62, 1);
          st.translate((k % 2 - 0.5) * 0.09, y + sizes[k] * 0.36, (k % 3 - 1) * 0.06);
          parts.push(st);
          y += sizes[k] * 0.72;
        }
        return mergeGeos(parts);
      }),
      color: "rock",
    },
    snowpole: { geo: () => geo("snowpole", () => { const g = new THREE.CylinderGeometry(0.055, 0.07, 2.3, 5); g.translate(0, 1.15, 0); return g; }), color: "birchTrunk", thin: true },
    snowpoleTip: { geo: () => geo("snowpoleTip", () => { const g = new THREE.CylinderGeometry(0.075, 0.075, 0.34, 5); g.translate(0, 2.05, 0); return g; }), color: "cabin", thin: true },
    shrineBody: { geo: () => geo("shrineB", () => { const g = new THREE.BoxGeometry(1.05, 1.45, 0.85); g.translate(0, 0.72, 0); return g; }), color: "cabin" },
    shrineRoof: { geo: () => geo("shrineR", () => { const parts = []; const r = new THREE.ConeGeometry(0.95, 0.5, 4); r.rotateY(Math.PI / 4); r.translate(0, 1.68, 0); parts.push(r); const c1 = new THREE.BoxGeometry(0.08, 0.5, 0.08); c1.translate(0, 2.1, 0); parts.push(c1); const c2 = new THREE.BoxGeometry(0.3, 0.08, 0.08); c2.translate(0, 2.16, 0); parts.push(c2); return mergeGeos(parts); }), color: "cabinRoof" },
    terrace: { geo: () => geo("terrace", () => { const parts = []; const a = new THREE.BoxGeometry(6.2, 1.15, 0.55); a.translate(0, 0.5, 0); parts.push(a); const b = new THREE.BoxGeometry(5.6, 0.95, 0.5); b.translate(0, 1.5, -1.7); parts.push(b); return mergeGeos(parts); }), color: "wall" },
    milestone: { geo: () => geo("milestone", () => { const parts = []; const st = new THREE.CylinderGeometry(0.19, 0.23, 0.9, 6); st.translate(0, 0.45, 0); parts.push(st); const cap = new THREE.SphereGeometry(0.2, 6, 4); cap.translate(0, 0.9, 0); parts.push(cap); return mergeGeos(parts); }), color: "wall" },
    fence: { geo: () => geo("fence", () => { const parts = []; const post = new THREE.CylinderGeometry(0.07, 0.09, 1.15, 5); post.translate(0, 0.57, 0); parts.push(post); for (const h of [0.5, 0.9]) { const w = new THREE.BoxGeometry(7.0, 0.03, 0.03); w.translate(3.5, h, 0); parts.push(w); } return mergeGeos(parts); }), color: "trunk", thin: true },
    /* A hoodoo is a column the weather forgot to finish: a soft shaft that
     * eroded fast, still wearing the hard cap that protected it. */
    hoodoo: {
      geo: () => geo("hoodoo", () => {
        const parts = [];
        const shaft = new THREE.CylinderGeometry(0.95, 1.5, 7.4, 7);
        shaft.translate(0, 3.7, 0); parts.push(shaft);
        const neck = new THREE.CylinderGeometry(0.78, 0.95, 1.5, 7);
        neck.translate(0, 8.1, 0); parts.push(neck);
        const cap = new THREE.CylinderGeometry(1.75, 1.5, 1.3, 7);
        cap.translate(0.12, 9.4, 0); parts.push(cap);
        return mergeGeos(parts);
      }),
      color: "rock",
    },
    windpumpTower: { geo: () => geo("wpT", () => { const g = new THREE.CylinderGeometry(0.16, 0.62, 6.6, 4); g.translate(0, 3.3, 0); return g; }), color: "trunk", thin: true },
    windpumpFan: {
      geo: () => geo("wpF", () => {
        const parts = [];
        const hub = new THREE.CylinderGeometry(0.22, 0.22, 0.26, 6);
        hub.rotateX(Math.PI / 2); hub.translate(0, 6.9, 0.2); parts.push(hub);
        for (let k = 0; k < 8; k++) {
          const b = new THREE.BoxGeometry(0.26, 1.5, 0.05);
          b.translate(0, 1.0, 0);
          b.rotateZ((k / 8) * Math.PI * 2);
          b.translate(0, 6.9, 0.28);
          parts.push(b);
        }
        const vane = new THREE.BoxGeometry(0.05, 0.7, 1.4);
        vane.translate(0, 6.9, -1.1); parts.push(vane);
        return mergeGeos(parts);
      }),
      color: "wall",
    },
    /* ---- special-event props.
     * A turbine is 42 m tall — the tallest thing in the game by a factor
     * of five — and that is the entire point: the bible asks for "highway
     * beneath massive wind turbines", and scale only exists if something
     * out there is unmistakably enormous. Blades are frozen at a hashed
     * angle per instance rather than turning, because a hundred synced
     * rotors look like a screensaver and one still frame of a wind farm
     * looks like a photograph. */
    turbineTower: { geo: () => geo("turbT", () => { const g = new THREE.CylinderGeometry(1.05, 2.3, 42, 8); g.translate(0, 21, 0); return g; }), fixed: 0xd6d8d4 },
    turbineHead: {
      geo: () => geo("turbH", () => {
        const parts = [];
        const nac = new THREE.BoxGeometry(2.4, 2.4, 6.2);
        nac.translate(0, 42.4, -0.6); parts.push(nac);
        const hub = new THREE.CylinderGeometry(1.1, 1.4, 1.6, 8);
        hub.rotateX(Math.PI / 2); hub.translate(0, 42.4, 3.0); parts.push(hub);
        for (let k = 0; k < 3; k++) {
          const b = new THREE.BoxGeometry(1.9, 19, 0.5);
          b.translate(0, 9.5, 0);
          b.rotateZ((k / 3) * Math.PI * 2 + 0.4);
          b.translate(0, 42.4, 3.6);
          parts.push(b);
        }
        return mergeGeos(parts);
      }),
      fixed: 0xe4e6e2,
    },
    /* A waterfall is two planes and a haze: a falling sheet and the pool
     * it lands in. Unlit basic white so it reads against dark rock, which
     * is also what makes the bloom catch it. */
    waterfall: {
      geo: () => geo("waterfall", () => {
        const parts = [];
        const sheet = new THREE.PlaneGeometry(3.2, 22);
        sheet.translate(0, 11, 0); parts.push(sheet);
        const spread = new THREE.PlaneGeometry(5.4, 6);
        spread.translate(0, 3, 0.35); parts.push(spread);
        const pool = new THREE.PlaneGeometry(7, 6);
        pool.rotateX(-Math.PI / 2); pool.translate(0, 0.12, 2.4); parts.push(pool);
        return mergeGeos(parts);
      }),
      fixed: 0xeaf2f4, unlit: true, twoSided: true,
    },
    /* Painted kerbs: alternating red and white is the one piece of visual
     * language that says "somebody raced here" without a single word. */
    kerb: { geo: () => geo("kerb", () => { const g = new THREE.BoxGeometry(4.6, 0.13, 0.95); g.translate(0, 0.06, 0); return g; }), fixed: 0xd8d4cc },
    kerbRed: { geo: () => geo("kerbRed", () => { const g = new THREE.BoxGeometry(0.95, 0.14, 2.3); g.translate(0, 0.065, 1.15); return g; }), fixed: 0xb03828 },
    /* A dome, a drum and a slot. Sits on a ridge and is visible for a
     * kilometre, which is the whole reason it is in the game. */
    observatory: {
      geo: () => geo("observatory", () => {
        const parts = [];
        const base = new THREE.CylinderGeometry(5.4, 6.2, 4.2, 10);
        base.translate(0, 2.1, 0); parts.push(base);
        const drum = new THREE.CylinderGeometry(4.6, 4.6, 1.4, 10);
        drum.translate(0, 4.9, 0); parts.push(drum);
        const dome = new THREE.SphereGeometry(4.6, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
        dome.translate(0, 5.5, 0); parts.push(dome);
        const slot = new THREE.BoxGeometry(1.3, 5.0, 4.9);
        slot.translate(0, 7.4, 2.2); parts.push(slot);
        const hut = new THREE.BoxGeometry(4.4, 2.6, 3.2);
        hut.translate(7.2, 1.3, 1.0); parts.push(hut);
        return mergeGeos(parts);
      }),
      fixed: 0xe6e4dc,
    },
    /* Salt flats: a marker post every ninety metres, because a plain with
     * no features has no speed either — you need something going past. */
    saltpost: { geo: () => geo("saltP", () => { const parts = []; const p = new THREE.CylinderGeometry(0.09, 0.11, 2.6, 5); p.translate(0, 1.3, 0); parts.push(p); const f = new THREE.BoxGeometry(0.5, 0.5, 0.06); f.translate(0, 2.4, 0); parts.push(f); return mergeGeos(parts); }), color: "cabinRoof", thin: true },
    /* Roadworks: a cone is the same orange plastic everywhere on earth. */
    cone: { geo: () => geo("cone", () => { const parts = []; const c = new THREE.CylinderGeometry(0.03, 0.17, 0.58, 6); c.translate(0, 0.29, 0); parts.push(c); const b = new THREE.BoxGeometry(0.4, 0.05, 0.4); b.translate(0, 0.025, 0); parts.push(b); return mergeGeos(parts); }), fixed: 0xd4692f, thin: true },
    // a barrier faces the driver: the board spans across, not edge-on
    barrierBoard: { geo: () => geo("barB", () => { const g = new THREE.BoxGeometry(0.14, 0.42, 2.6); g.translate(0, 0.86, 0); return g; }), fixed: 0xc8503a },
    barrierLegs: {
      geo: () => geo("barL", () => {
        const parts = [];
        for (const z of [-1.05, 1.05]) {
          const l = new THREE.BoxGeometry(0.09, 1.05, 0.09);
          l.translate(0, 0.52, z); parts.push(l);
        }
        return mergeGeos(parts);
      }),
      fixed: 0x50555a, thin: true,
    },
    /* The dam crest: squat concrete bollards pacing the water side, and an
     * intake tower standing out in the reservoir — the two shapes that say
     * "somebody holds this water back on purpose". */
    dampost: { geo: () => geo("damP", () => { const parts = []; const p = new THREE.BoxGeometry(0.34, 0.92, 0.34); p.translate(0, 0.46, 0); parts.push(p); const c = new THREE.BoxGeometry(0.42, 0.12, 0.42); c.translate(0, 0.98, 0); parts.push(c); return mergeGeos(parts); }), fixed: 0xb6b9b1 },
    intaketower: {
      geo: () => geo("intake", () => {
        const parts = [];
        const shaft = new THREE.CylinderGeometry(2.3, 2.5, 10, 9);
        shaft.translate(0, 5, 0); parts.push(shaft);
        const head = new THREE.CylinderGeometry(2.8, 2.8, 1.7, 9);
        head.translate(0, 10.6, 0); parts.push(head);
        const roof = new THREE.CylinderGeometry(0.2, 2.7, 1.1, 9);
        roof.translate(0, 12.0, 0); parts.push(roof);
        return mergeGeos(parts);
      }),
      fixed: 0xaeb3ac,
    },
    /* Thornmoor: a standing stone is older than the road and knows it —
     * a leaning slab, wider at the shoulder, alone on the skyline. */
    standingstone: {
      geo: () => geo("standing", () => {
        const parts = [];
        const slab = new THREE.BoxGeometry(1.1, 3.4, 0.6);
        slab.translate(0, 1.7, 0);
        slab.rotateZ(0.07);
        parts.push(slab);
        const foot = new THREE.BoxGeometry(1.5, 0.4, 1.0);
        foot.translate(0, 0.2, 0); parts.push(foot);
        return mergeGeos(parts);
      }),
      color: "rock",
    },
    /* The Verge: a monolith nobody built and nobody explains — a tall
     * lean slab, pale by day, and GLOWING at dusk because the material is
     * unlit (the tunnel-lamp trick: the bloom pass does the rest). */
    monolith: {
      geo: () => geo("monolith", () => {
        const parts = [];
        const slab = new THREE.BoxGeometry(1.7, 9.5, 1.15);
        slab.translate(0, 4.7, 0);
        slab.rotateZ(0.03);
        parts.push(slab);
        return mergeGeos(parts);
      }),
      fixed: 0xb9c6de, unlit: true,
    },
    /* The old road: a faded slab of somebody else's tarmac, flat on the
     * ground where only the unmarked line ever finds it. */
    oldslab: {
      geo: () => geo("oldslab", () => {
        const g = new THREE.BoxGeometry(5.6, 0.1, 3.4);
        g.translate(0, 0.05, 0);
        return g;
      }),
      fixed: 0x7b766c,
    },
    /* Cut peat, stacked to dry: two low courses of dark bricks. */
    peatstack: {
      geo: () => geo("peat", () => {
        const parts = [];
        for (let r = 0; r < 2; r++) {
          for (let k = 0; k < 3 - r; k++) {
            const b = new THREE.BoxGeometry(0.55, 0.3, 1.6);
            b.translate((k - (2 - r) / 2) * 0.6, 0.16 + r * 0.31, 0);
            parts.push(b);
          }
        }
        return mergeGeos(parts);
      }),
      fixed: 0x3f3830,
    },
    /* Heartland: a hedge is a wall that grew — one long clipped box with a
     * slightly proud top course so it reads trimmed, not extruded. */
    hedge: {
      geo: () => geo("hedge", () => {
        const parts = [];
        const body = new THREE.BoxGeometry(6.4, 1.1, 0.9);
        body.translate(0, 0.55, 0); parts.push(body);
        const top = new THREE.BoxGeometry(6.5, 0.22, 1.02);
        top.translate(0, 1.18, 0); parts.push(top);
        return mergeGeos(parts);
      }),
      fixed: 0x46633a,
    },
    /* Aspenvale: an avalanche fence — slatted boards on two leaning posts,
     * standing in rows on the uphill slope where the snow would come from.
     * Weathered timber; it opts out of the palette because sun-bleached
     * larch is the same grey silver at any altitude. */
    snowfence: {
      geo: () => geo("snowfence", () => {
        const parts = [];
        for (const x of [-1.6, 1.6]) {
          const post = new THREE.BoxGeometry(0.14, 2.1, 0.14);
          post.translate(x, 1.05, 0);
          post.rotateX(0.22);
          parts.push(post);
        }
        for (let i = 0; i < 4; i++) {
          const slat = new THREE.BoxGeometry(4.4, 0.3, 0.05);
          slat.translate(0, 0.5 + i * 0.45, 0.24 * (0.4 + i * 0.45));
          slat.rotateX(0.22);
          parts.push(slat);
        }
        return mergeGeos(parts);
      }),
      fixed: 0x8d8578,
    },
    /* Kaldbrekka: a fish-drying rack — an A-frame ridge with a few dark
     * shapes hung under it. On the white coast it reads instantly as
     * "people live off this water". */
    fishrack: {
      geo: () => geo("fishrack", () => {
        const parts = [];
        for (const z of [-1.4, 1.4]) {
          for (const lean of [-0.5, 0.5]) {
            const leg = new THREE.BoxGeometry(0.1, 2.3, 0.1);
            leg.translate(lean * 0.9, 1.05, z);
            leg.rotateZ(lean * 0.42);
            parts.push(leg);
          }
        }
        const ridge = new THREE.BoxGeometry(0.09, 0.09, 3.4);
        ridge.translate(0, 1.98, 0); parts.push(ridge);
        for (const z of [-1.05, -0.35, 0.35, 1.05]) {
          const fish = new THREE.BoxGeometry(0.34, 0.55, 0.12);
          fish.translate(0, 1.62, z);
          parts.push(fish);
        }
        return mergeGeos(parts);
      }),
      fixed: 0x574a3e,
    },
    /* Avalanche gallery: one concrete pillar of the colonnade. Placed both
     * sides on a 7 m rhythm; the roof is its own onRoad part. */
    gallerypost: {
      geo: () => geo("gallerypost", () => {
        const parts = [];
        const post = new THREE.BoxGeometry(0.55, 4.7, 0.75);
        post.translate(0, 2.35, 0); parts.push(post);
        const foot = new THREE.BoxGeometry(0.85, 0.4, 1.05);
        foot.translate(0, 0.2, 0); parts.push(foot);
        const head = new THREE.BoxGeometry(0.75, 0.35, 0.95);
        head.translate(0, 4.85, 0); parts.push(head);
        return mergeGeos(parts);
      }),
      fixed: 0xb2b5b0,
    },
    /* The gallery roof: a slab spanning the whole deck, with a fascia beam
     * along each edge so it reads as construction rather than a lid. */
    galleryroof: {
      geo: () => geo("galleryroof", () => {
        const parts = [];
        const slab = new THREE.BoxGeometry(12.6, 0.4, 6.6);
        slab.translate(0, 5.2, 0); parts.push(slab);
        for (const x of [-6.0, 6.0]) {
          const beam = new THREE.BoxGeometry(0.6, 0.7, 6.6);
          beam.translate(x, 4.75, 0); parts.push(beam);
        }
        // the slab spans the deck; the fascia beams run along its two edges
        const g = mergeGeos(parts); g.rotateY(-Math.PI / 2); return g;
      }),
      fixed: 0xa8aba6,
    },
    /* Avalanche debris: a chunk of dirty compacted snow with rock in it. */
    snowblock: {
      geo: () => geo("snowblock", () => {
        const parts = [];
        const a = new THREE.BoxGeometry(1.5, 1.0, 1.2);
        a.rotateY(0.5); a.rotateZ(0.12); a.translate(0, 0.45, 0); parts.push(a);
        const b = new THREE.BoxGeometry(1.0, 0.8, 0.9);
        b.rotateY(-0.4); b.rotateX(0.18); b.translate(0.5, 0.75, 0.3); parts.push(b);
        return mergeGeos(parts);
      }),
      fixed: 0xd3dade,
    },
    /* A round bale, lying where the baler left it. */
    haybale: {
      geo: () => geo("haybale", () => {
        const g = new THREE.CylinderGeometry(0.75, 0.75, 1.25, 9);
        g.rotateX(Math.PI / 2);
        g.translate(0, 0.75, 0);
        return g;
      }),
      fixed: 0xc9a95c,
    },
    /* An empty grandstand: tiers rising on both long faces so it reads as
     * a stand from either side of the road, and a roof line on posts. */
    grandstand: {
      geo: () => geo("grand", () => {
        const parts = [];
        for (let t = 0; t < 4; t++) {
          const row = new THREE.BoxGeometry(2.2, 1.1 + t * 1.1, 26 - t * 1.4);
          row.translate(t * 1.05, (1.1 + t * 1.1) / 2, 0);
          parts.push(row);
        }
        const roof = new THREE.BoxGeometry(6.4, 0.28, 27);
        roof.translate(1.6, 6.4, 0); parts.push(roof);
        for (const z of [-12.5, 0, 12.5]) {
          const post = new THREE.BoxGeometry(0.22, 6.3, 0.22);
          post.translate(4.4, 3.15, z); parts.push(post);
        }
        // a stand runs ALONG the straight it watches (+X is along the road)
        const g = mergeGeos(parts); g.rotateY(Math.PI / 2); return g;
      }),
      fixed: 0x8e959b,
    },
    /* A level crossing is three facts: sleepers, steel, and the crossed
     * white signs that say STOP LOOK. The rails run out well past the
     * verge so the line reads as going somewhere, not as road furniture.
     * Built in an X-across working frame, then rotated onto the real one
     * (+X along the road) — the rails must SPAN the carriageway. */
    railbed: {
      geo: () => geo("railbed", () => {
        const parts = [];
        for (let x = -22; x <= 22; x += 1.7) {
          const sl = new THREE.BoxGeometry(0.24, 0.09, 2.1);
          sl.translate(x, 0.05, 0); parts.push(sl);
        }
        const g = mergeGeos(parts); g.rotateY(-Math.PI / 2); return g;
      }),
      fixed: 0x4c4238,
    },
    railsteel: {
      geo: () => geo("railsteel", () => {
        const parts = [];
        for (const z of [-0.75, 0.75]) {
          const r = new THREE.BoxGeometry(44, 0.11, 0.13);
          r.translate(0, 0.13, z); parts.push(r);
        }
        const g = mergeGeos(parts); g.rotateY(-Math.PI / 2); return g;
      }),
      fixed: 0x9a9c9e,
    },
    crossbuck: {
      geo: () => geo("crossbuck", () => {
        const parts = [];
        for (const [px, pz] of [[6.6, -3.4], [-6.6, 3.4]]) {
          const post = new THREE.CylinderGeometry(0.08, 0.1, 3.4, 5);
          post.translate(px, 1.7, pz); parts.push(post);
          for (const a of [0.55, -0.55]) {
            const arm = new THREE.BoxGeometry(1.5, 0.2, 0.07);
            arm.rotateZ(a); arm.translate(px, 3.05, pz); parts.push(arm);
          }
        }
        const g = mergeGeos(parts); g.rotateY(-Math.PI / 2); return g;
      }),
      fixed: 0xe8e4da,
    },
    /* A cattle grid: where the range fence meets the road, the road wins
     * — a strip of steel bars a hoof will not cross and a car barely
     * notices, with a white post at each corner. */
    gridbars: {
      geo: () => geo("gridbars", () => {
        const parts = [];
        for (let z = -1.2; z <= 1.21; z += 0.4) {
          const b = new THREE.BoxGeometry(7.6, 0.09, 0.16);
          b.translate(0, 0.045, z); parts.push(b);
        }
        const g = mergeGeos(parts); g.rotateY(-Math.PI / 2); return g;   // bars span the road
      }),
      fixed: 0x7e8286,
    },
    gridposts: {
      geo: () => geo("gridposts", () => {
        const parts = [];
        for (const [px, pz] of [[3.9, -1.4], [3.9, 1.4], [-3.9, -1.4], [-3.9, 1.4]]) {
          const p = new THREE.BoxGeometry(0.18, 0.8, 0.18);
          p.translate(px, 0.4, pz); parts.push(p);
        }
        const g = mergeGeos(parts); g.rotateY(-Math.PI / 2); return g;
      }),
      fixed: 0xe8e6e0,
    },
    /* The mast is the observatory's working-class cousin: a guyed lattice
     * with a red light on top, because somebody has to carry the weather
     * report over the pass. Beacon unlit so it reads at dusk. */
    mastTower: {
      geo: () => geo("mastTower", () => {
        const parts = [];
        const t = new THREE.CylinderGeometry(0.32, 1.35, 34, 6);
        t.translate(0, 17, 0); parts.push(t);
        for (let k = 0; k < 3; k++) {
          const arm = new THREE.BoxGeometry(3.3, 0.26, 0.26);
          arm.rotateY((k * Math.PI) / 3);
          arm.translate(0, 9 + k * 8.5, 0); parts.push(arm);
        }
        const dish = new THREE.CylinderGeometry(1.05, 1.05, 0.5, 8);
        dish.rotateX(Math.PI / 2); dish.translate(0.9, 24, 0.9); parts.push(dish);
        return mergeGeos(parts);
      }),
      fixed: 0xc6cbd1,
    },
    mastBeacon: { geo: () => geo("mastBeacon", () => { const g = new THREE.SphereGeometry(0.55, 8, 6); g.translate(0, 34.5, 0); return g; }), fixed: 0xff4030, unlit: true },
    mastGuys: {
      geo: () => geo("mastGuys", () => {
        const parts = [];
        const L = Math.sqrt(30 * 30 + 12 * 12);
        for (let k = 0; k < 3; k++) {
          const g = new THREE.CylinderGeometry(0.035, 0.035, L, 3);
          g.translate(0, L / 2, 0);
          g.rotateZ(Math.atan2(12, 30));
          g.rotateY((k * Math.PI * 2) / 3 + 0.5);
          parts.push(g);
        }
        return mergeGeos(parts);
      }),
      fixed: 0x9aa0a6, thin: true,
    },
    /* The monastery is ruin grammar: one gable wall still standing to full
     * height, an arch that no longer holds a door, a side wall down to
     * shoulder height, and the rest is rubble. Roofless on purpose —
     * "walls and sky now". */
    ruinWalls: {
      geo: () => geo("ruinWalls", () => {
        const parts = [];
        const wall = new THREE.BoxGeometry(9, 4.6, 0.7);
        wall.translate(0, 2.3, -3.4); parts.push(wall);
        const gable1 = new THREE.BoxGeometry(5.5, 1.5, 0.7);
        gable1.translate(-0.6, 5.3, -3.4); parts.push(gable1);
        const gable2 = new THREE.BoxGeometry(2.4, 1.3, 0.7);
        gable2.translate(-1.1, 6.6, -3.4); parts.push(gable2);
        for (const jx of [-1.6, 1.6]) {
          const jamb = new THREE.BoxGeometry(0.85, 3.4, 0.7);
          jamb.translate(jx, 1.7, 2.6); parts.push(jamb);
        }
        const lintel = new THREE.BoxGeometry(4.1, 0.85, 0.7);
        lintel.translate(0, 3.8, 2.6); parts.push(lintel);
        const side = new THREE.BoxGeometry(0.7, 2.9, 6.8);
        side.translate(-4.5, 1.45, -0.4); parts.push(side);
        const stub = new THREE.BoxGeometry(0.7, 1.4, 3.2);
        stub.translate(4.4, 0.7, 0.6); parts.push(stub);
        return mergeGeos(parts);
      }),
      fixed: 0xd6cec0,
    },
    ruinRubble: {
      geo: () => geo("ruinRubble", () => {
        const parts = [];
        const at = [[2.8, 4.1], [-2.4, 4.6], [5.2, -1.8], [-5.6, 2.9], [1.4, -5.4], [-3.1, -4.7]];
        for (let k = 0; k < at.length; k++) {
          const r = new THREE.IcosahedronGeometry(0.45 + (k % 3) * 0.28, 0);
          r.scale(1.3, 0.7, 1);
          r.translate(at[k][0], 0.25, at[k][1]); parts.push(r);
        }
        return mergeGeos(parts);
      }),
      fixed: 0xb8ae9e,
    },
    /* A wreck lists. That is the whole grammar of it: the hull rolled off
     * plumb, the mast down at the angle it fell, and the waterline where
     * the water says it is rather than where the boat would like it. */
    wreckHull: {
      geo: () => geo("wreckHull", () => {
        const parts = [];
        const hull = new THREE.BoxGeometry(7.8, 2.0, 2.6);
        hull.rotateX(0.42); hull.translate(0, 0.55, 0); parts.push(hull);
        const bow = new THREE.BoxGeometry(2.3, 1.7, 1.8);
        bow.rotateY(0.4); bow.rotateX(0.42); bow.translate(4.4, 0.5, 0.2); parts.push(bow);
        const stern = new THREE.BoxGeometry(1.9, 1.9, 2.1);
        stern.rotateY(-0.3); stern.rotateX(0.42); stern.translate(-4.2, 0.6, 0.1); parts.push(stern);
        const rail = new THREE.BoxGeometry(8.2, 0.18, 0.2);
        rail.rotateX(0.42); rail.translate(0, 1.62, -0.95); parts.push(rail);
        return mergeGeos(parts);
      }),
      fixed: 0x6f6152,
    },
    wreckMast: {
      geo: () => geo("wreckMast", () => {
        const parts = [];
        const mast = new THREE.CylinderGeometry(0.12, 0.17, 8.6, 5);
        mast.translate(0, 4.3, 0); mast.rotateZ(1.08); mast.rotateY(0.3);
        mast.translate(0.4, 1.1, 0); parts.push(mast);
        const spar = new THREE.CylinderGeometry(0.07, 0.09, 4.6, 5);
        spar.rotateZ(Math.PI / 2 - 0.25); spar.translate(-2.6, 2.4, 0.4); parts.push(spar);
        return mergeGeos(parts);
      }),
      fixed: 0x585048, thin: true,
    },
    /* A mesa is a stack of beds that weathered at different rates, not a
     * box on a box: each layer steps in a little, the softer ones sit
     * back further, and the whole thing leans off-axis so no two read as
     * the same silhouette from the road. */
    mesa: {
      geo: () => geo("mesa", () => {
        const beds = [
          [56, 7.0, 44, 0, 0], [52, 5.0, 41, 1.4, 0.8], [49, 3.0, 38, 0.6, -1.2],
          [46, 6.5, 35, 2.6, 0.4], [40, 2.4, 30, 3.4, 1.6], [37, 5.5, 27, 4.2, -0.6],
          [30, 3.0, 22, 6.0, 1.0], [26, 4.0, 19, 7.2, 2.2],
        ];
        const parts = [];
        let y = 0;
        for (const [w, h, d, ox, oz] of beds) {
          const g = new THREE.BoxGeometry(w, h, d);
          g.translate(ox, y + h / 2, oz);
          parts.push(g);
          y += h;
        }
        return mergeGeos(parts);
      }),
      color: "rock",
    },
  };

  /* merge a few geometries into one (same attributes) */
  function mergeGeos(list) {
    const pos = [], idx = [];
    let base = 0;
    for (const g of list) {
      const p = g.getAttribute("position");
      const nonIndexed = g.index ? g.toNonIndexed() : g;
      const q = nonIndexed.getAttribute("position");
      for (let i = 0; i < q.count; i++) pos.push(q.getX(i), q.getY(i), q.getZ(i));
      base += q.count;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    out.computeVertexNormals();
    return out;
  }

  /* which instanced parts each prop type contributes */
  const PROP_PARTS = {
    spruce: ["spruceLower", "spruceUpper", "trunk"],
    pine: ["pineCrown", "pineTrunk"],
    birch: ["birchCanopy", "birchTrunk"],
    rock: ["rock"],
    cypress: ["cypressCrown", "trunk"],
    olive: ["oliveCanopy", "oliveTrunk"],
    umbrella: ["umbrellaCrown", "umbrellaTrunk"],
    wall: ["wall"],
    cactus: ["cactusBody", "cactusArm"],
    shrub: ["shrub"],
    rockRed: ["rockRed"],
    mesa: ["mesa"],
    // region marks
    boathouse: ["boathouseWalls", "boathouseRoof", "boathouseJetty"],
    woodpile: ["woodpile"],
    cairn: ["cairn"],
    snowpole: ["snowpole", "snowpoleTip"],
    shrine: ["shrineBody", "shrineRoof"],
    terrace: ["terrace"],
    milestone: ["milestone"],
    fence: ["fence"],
    hoodoo: ["hoodoo"],
    windpump: ["windpumpTower", "windpumpFan"],
    // special events
    turbine: ["turbineTower", "turbineHead"],
    saltpost: ["saltpost"],
    waterfall: ["waterfall"],
    kerb: ["kerb", "kerbRed"],
    observatory: ["observatory"],
    railline: ["railbed", "railsteel", "crossbuck"],
    cattlegrid: ["gridbars", "gridposts"],
    radiomast: ["mastTower", "mastBeacon", "mastGuys"],
    monastery: ["ruinWalls", "ruinRubble"],
    shipwreck: ["wreckHull", "wreckMast"],
    cone: ["cone"],
    barrier: ["barrierBoard", "barrierLegs"],
    dampost: ["dampost"],
    intaketower: ["intaketower"],
    grandstand: ["grandstand"],
    standingstone: ["standingstone"],
    peatstack: ["peatstack"],
    hedge: ["hedge"],
    haybale: ["haybale"],
    snowfence: ["snowfence"],
    fishrack: ["fishrack"],
    gallerypost: ["gallerypost"],
    galleryroof: ["galleryroof"],
    snowblock: ["snowblock"],
    // the park countries + the towns
    cottonwood: ["cottonwoodCanopy", "cottonwoodTrunk"],
    cedar: ["cedarLower", "cedarUpper", "cedarTrunk"],
    lodgepole: ["lodgepoleCrown", "lodgepoleTrunk"],
    snag: ["snag"],
    larch: ["larchCrown", "pineTrunk"],
    canyonwall: ["canyonwall"],
    granitetower: ["granitetower"],
    geyser: ["geyserMound", "geyserSteam"],
    hotpool: ["hotpoolRim", "hotpoolWater"],
    boardwalk: ["boardwalk"],
    torii: ["toriiPosts", "toriiLintel"],
    lantern: ["lantern"],
    guardrail: ["guardrail"],
    guardwall: ["guardwall"],
    estanciagate: ["estanciagate"],
    lamppost: ["lamppostPost", "lamppostLamp"],
    chapel: ["chapelNave", "chapelRoof", "chapelTower", "chapelSpire", "chapelWindows"],
  };

  /* canvas sign texture — built once per text */
  const signCache = {};
  function signTexture(text, bg, fg) {
    if (signCache[text]) return signCache[text];
    const cv = document.createElement("canvas");
    cv.width = 512; cv.height = 128;
    const c = cv.getContext("2d");
    c.fillStyle = bg; c.fillRect(0, 0, 512, 128);
    c.fillStyle = fg;
    c.fillRect(0, 0, 512, 10);
    c.font = "700 64px 'Chakra Petch', 'Inter', sans-serif";
    c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(text, 256, 72);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return (signCache[text] = tex);
  }

  /* The waystation: a service garage with an open bay, a flat roof with a
   * deep overhang, an amber lamp over the door, a fuel post, a signboard.
   * Set back on the apron's right, facing the road. */
  function buildWaystation(it, group, origin, pb) {
    pb = pb || pal;
    const g = new THREE.Group();
    const wall = mat(pb.cabin === 0xe8dcc4 ? 0xd9cdb5 : 0x6e5a48), roof = mat(0x2a2f33), trim = mat(pb.cabinRoof), lamp = mat(0xffcf7a), post = mat(0x8a8f92);
    // main shed
    const shed = new THREE.Mesh(geo("wsShed", () => { const b = new THREE.BoxGeometry(9.5, 3.6, 6.4); b.translate(0, 1.8, 0); return b; }), wall);
    g.add(shed);
    // open bay: dark inset on the road-facing side (−z after rotation faces road)
    const bay = new THREE.Mesh(geo("wsBay", () => { const b = new THREE.BoxGeometry(4.2, 3.0, 0.3); b.translate(-1.6, 1.5, -3.25); return b; }), mat(0x151a1c));
    g.add(bay);
    // roof slab with overhang toward the road
    const roofM = new THREE.Mesh(geo("wsRoof", () => { const b = new THREE.BoxGeometry(11, 0.32, 9.2); b.translate(0, 3.75, -1.2); return b; }), roof);
    g.add(roofM);
    // roof posts holding the overhang
    for (const x of [-4.8, 4.8]) {
      const pm = new THREE.Mesh(geo("wsPost", () => { const c = new THREE.CylinderGeometry(0.11, 0.11, 3.6, 6); c.translate(0, 1.8, 0); return c; }), post);
      pm.position.set(x, 0, -5.4);
      g.add(pm);
    }
    // amber lamp over the bay + a warm light — TEAL at a strange outpost,
    // which is the one visual promise the codriver's "odd one, this" makes
    const lampCol = it.strange ? 0x7adfcf : 0xffcf7a;
    const lightCol = it.strange ? 0x5fd8c4 : 0xffb454;
    const lm = new THREE.Mesh(geo("wsLamp", () => { const b = new THREE.BoxGeometry(0.9, 0.22, 0.4); b.translate(0, 3.35, -3.6); return b; }), mat(lampCol));
    lm.position.x = -1.6;
    g.add(lm);
    const light = new THREE.PointLight(lightCol, 1.6, 22, 1.6);
    light.position.set(-1.6, 3.1, -4.2);
    g.add(light);
    // trim stripe
    const stripe = new THREE.Mesh(geo("wsStripe", () => { const b = new THREE.BoxGeometry(9.6, 0.24, 6.5); b.translate(0, 3.0, 0); return b; }), trim);
    g.add(stripe);
    // fuel post
    const fp = new THREE.Mesh(geo("wsPump", () => { const b = new THREE.BoxGeometry(0.6, 1.5, 0.45); b.translate(0, 0.75, 0); return b; }), trim);
    fp.position.set(3.4, 0, -5.2);
    g.add(fp);
    // signboard by the road: WAYSTATION — or OUTPOST, in teal, at the odd one
    const board = new THREE.Mesh(
      geo(it.strange ? "wsBoardS" : "wsBoard", () => new THREE.PlaneGeometry(4.6, 1.15)),
      new THREE.MeshBasicMaterial({
        map: it.strange ? signTexture("OUTPOST", "#16211f", "#7adfcf") : signTexture("WAYSTATION", "#1c2723", "#ffb454"),
        side: THREE.DoubleSide,
      })
    );
    board.position.set(4.6, 3.9, -3.2);
    board.rotation.y = Math.PI;
    g.add(board);
    // a strange outpost has an aerial nobody explains
    if (it.strange) {
      const mastM = new THREE.Mesh(geo("wsMast", () => { const c = new THREE.CylinderGeometry(0.05, 0.07, 4.4, 5); c.translate(0, 6.0, 0); return c; }), post);
      mastM.position.set(-3.6, 0, 1.8);
      g.add(mastM);
      const tip = new THREE.Mesh(geo("wsMastTip", () => { const s = new THREE.SphereGeometry(0.14, 6, 4); s.translate(0, 8.2, 0); return s; }), mat(0x7adfcf));
      tip.position.set(-3.6, 0, 1.8);
      g.add(tip);
    }
    /* The dressing that makes this country's waystation THIS country's:
     * reused part geometries, laid out fixed per biome (the same garage
     * every visit — a place, not a shuffle). All behind or beside the
     * shed, well off the apron. */
    const dress = (key, x, z, rotY) => {
      const def = PARTS[key];
      if (!def || def.colors) return;
      const col = def.fixed != null ? def.fixed : pb[def.color] != null ? pb[def.color] : 0x8a8f92;
      const m = new THREE.Mesh(def.geo(), mat(col));
      m.position.set(x, 0, z);
      m.rotation.y = rotY || 0;
      g.add(m);
    };
    const DRESSING = {
      norrland: [["woodpile", 6.4, 1.6, 0.4], ["woodpile", 7.6, 0.2, -0.3]],
      costa: [["shrineBody", -6.2, 0.8, 0.5], ["shrineRoof", -6.2, 0.8, 0.5], ["milestone", 6.0, -1.2, 0]],
      redgate: [["hoodoo", -7.6, 2.6, 0.7], ["saltpost", 6.0, -1.0, 0]],
      thornmoor: [["peatstack", 6.2, 1.4, 0.3], ["peatstack", 7.4, 0.4, -0.5], ["cairn", -6.4, 1.2, 0]],
      /* hedge/snowfence rot carries a −π/2: their geometries turned 90°
       * when the aligned-part frame was fixed, and the garage layout was
       * tuned to the old look */
      heartland: [["haybale", 6.6, 1.2, 0.6], ["haybale", 7.7, 2.0, -0.2], ["hedge", -7.2, 1.4, 0.12 - Math.PI / 2]],
      aspenvale: [["woodpile", 6.4, 1.4, 0.2], ["snowfence", -7.0, 1.8, 0.15 - Math.PI / 2]],
      kaldbrekka: [["fishrack", 6.6, 1.6, 0.35], ["snowpole", -5.8, -1.4, 0], ["snowpole", -5.8, 1.8, 0]],
      verge: [["monolith", -8.4, 3.2, 0.4], ["cairn", 6.4, -1.2, 0]],
      sandreach: [["hoodoo", -8.0, 2.8, 0.6], ["milestone", 6.0, -1.2, 0]],
      highline: [["woodpile", 6.4, 1.6, 0.4], ["guardwall", -7.0, 1.6, 0.1 - Math.PI / 2]],
      cauldron: [["geyserMound", -7.8, 2.4, 0], ["woodpile", 6.4, 1.4, 0.3]],
      kurotani: [["lantern", 6.0, -1.0, 0], ["lantern", 6.0, 1.6, 0], ["toriiPosts", -7.4, 1.8, 0.2]],
      ventisca: [["estanciagate", -7.2, 1.8, 0.15], ["cairn", 6.4, -1.2, 0]],
    };
    for (const [key, x, z, rotY] of DRESSING[it.biome] || []) dress(key, x, z, rotY);
    g.position.set(it.x - origin.x, it.y, it.z - origin.z);
    g.rotation.y = it.rot;   // face the road: the group's −z side toward the centreline
    group.add(g);
  }

  function buildWaysign(it, group, origin) {
    const g = new THREE.Group();
    const postM = new THREE.Mesh(geo("signPost", () => { const c = new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6); c.translate(0, 1.2, 0); return c; }), mat(0x8a8f92));
    g.add(postM);
    const board = new THREE.Mesh(
      geo("signBoard", () => new THREE.PlaneGeometry(2.2, 0.62)),
      new THREE.MeshBasicMaterial({ map: signTexture("WAYSTATION  200", "#d8ded9", "#1c2723"), side: THREE.DoubleSide })
    );
    board.position.set(0, 2.15, 0);
    /* Face the car, not the road ahead: local +X points the way the road
     * goes, so the board's normal has to be -X or the driver reads the
     * back of it — which renders the text mirrored. */
    board.rotation.y = -Math.PI / 2;
    g.add(board);
    g.position.set(it.x - origin.x, it.y, it.z - origin.z);
    g.rotation.y = it.rot;
    group.add(g);
  }

  /* pickups: small emissive shapes, one mesh each (few per section) */
  const livePickups = [];            // [{mesh, p}]
  const pickupGeo = {
    wrench: () => geo("pkWrench", () => { const g = new THREE.BoxGeometry(0.9, 0.22, 0.22); return g; }),
    canister: () => geo("pkCan", () => new THREE.CylinderGeometry(0.28, 0.28, 0.7, 8)),
    pennant: () => geo("pkPennant", () => { const g = new THREE.ConeGeometry(0.34, 0.9, 4); g.rotateZ(Math.PI / 2); return g; }),
    grit: () => geo("pkGrit", () => new THREE.IcosahedronGeometry(0.34, 0)),
  };
  const pickupMat = {};
  function pmat(kind) {
    if (!pickupMat[kind]) pickupMat[kind] = new THREE.MeshLambertMaterial({ color: PICKUP_KINDS[kind].color, emissive: PICKUP_KINDS[kind].color, emissiveIntensity: 0.35 });
    return pickupMat[kind];
  }
  const ringGeo = () => geo("pkRing", () => new THREE.RingGeometry(0.55, 0.72, 20));
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });

  function addPickup(p, group, origin) {
    const holder = new THREE.Group();
    const m = new THREE.Mesh(pickupGeo[p.kind](), pmat(p.kind));
    holder.add(m);
    const ring = new THREE.Mesh(ringGeo(), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.45;
    holder.add(ring);
    holder.position.set(p.x - origin.x, p.y, p.z - origin.z);
    holder.scale.setScalar(1.6);
    group.add(holder);
    livePickups.push({ mesh: holder, p, phase: (p.x * 0.37 + p.z * 0.11) % 6.28 });
  }

  function buildPickups(sec, group, origin) {
    for (const p of sec.pickups || []) addPickup(p, group, origin);
  }

  const sectionMeshes = new Map();   // section.index -> {group, origin, geos[]}
  const terrainCells = new Map();    // "cx,cz" -> {mesh, origin, lastNeeded}
  const buildQueueS = [];            // sections waiting for meshes
  const dummy = new THREE.Object3D();
  const colTmp = new THREE.Color();

  world.onSectionAdded = (sec) => { buildQueueS.push(sec); };
  /* A souvenir conjured a pickup mid-run: if the owning section's mesh is
   * already standing, grow it now — otherwise buildSection will pick the
   * pickup up from sec.pickups when its turn comes. */
  world.onPickupSpawned = (p, sec) => {
    const rec = sectionMeshes.get(sec.index);
    if (rec) addPickup(p, rec.group, rec.origin);
  };
  world.onSectionRemoved = (sec) => {
    for (const span of sec.spans || []) removeEarlySpan(span);
    for (let i = livePickups.length - 1; i >= 0; i--) if (livePickups[i].p.sectionIndex === sec.index) livePickups.splice(i, 1);
    const rec = sectionMeshes.get(sec.index);
    if (rec) {
      kit.scene.remove(rec.group);
      for (const g of rec.geos) g.dispose();
      for (const m of rec.instanced) m.dispose();
      sectionMeshes.delete(sec.index);
    }
    const at = buildQueueS.indexOf(sec);
    if (at >= 0) buildQueueS.splice(at, 1);
  };

  /* ------------------------------------------------------- road ribbons */

  /* ------------------------------------------------- crossings (spans)
   *
   * A bridge and a tunnel are the same object drawn inside out: a swept
   * box following the road, in the road's own frame. So there is one
   * builder, and the difference between "deck, parapets, piers" and
   * "walls, roof, portals" is a list of beams.
   *
   * A beam is {p0, p1, v0, v1, col} where a lateral endpoint is
   * [sign, offset] meaning sign × (halfWidth + offset) and v is metres
   * above the deck. Segments are emitted in road order so the whole
   * structure can be cut short at the terrain blanket exactly like the
   * ribbon — a bridge standing in the void past the edge of the world
   * would be the loudest version of the bug we just spent a session
   * fixing everywhere else.
   */
  const fordMat = new THREE.MeshBasicMaterial({
    color: 0x5d8ba0, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide,
  });
  /* every dwelling's window shares this: dark glass by day, warm after
   * dusk (setNight drives it — unlit material, so it GLOWS against a
   * night-dark wall instead of shading with it) */
  const windowMat = new THREE.MeshBasicMaterial({ color: 0x14161a, side: THREE.DoubleSide });
  const spanMat = hfog(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  const lampMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });

  function spanFrames(span) {
    const { X, Z, Y, HD, CB, HW, MASK } = world.ring;
    const frames = [];
    const stride = 2;                       // 5 m — smooth enough on a hairpin
    for (let i = span.i0; i <= span.i1; i += stride) {
      const m = i & MASK;
      const s = (i + 1) * world.DS;
      frames.push({ x: X[m], y: Y[m], z: Z[m], rx: -Math.sin(HD[m]), rz: Math.cos(HD[m]), cb: CB[m], hw: HW[m], s, st: spanStrength(span, s), i });
    }
    const lastI = span.i1 & MASK;
    if (frames[frames.length - 1].i !== span.i1) {
      const s = (span.i1 + 1) * world.DS;
      frames.push({ x: X[lastI], y: Y[lastI], z: Z[lastI], rx: -Math.sin(HD[lastI]), rz: Math.cos(HD[lastI]), cb: CB[lastI], hw: HW[lastI], s, st: spanStrength(span, s), i: span.i1 });
    }
    return frames;
  }

  function buildSpan(span, group, origin, pb, cuts) {
    const frames = spanFrames(span);
    if (frames.length < 3) return;
    const tunnel = span.kind === TUNNEL;
    /* Concrete, but this country's concrete: pulled most of the way to a
     * neutral grey so a red-rock viaduct is still recognisably in Redgate
     * without the whole bridge turning terracotta. */
    const base = new THREE.Color(pb.rock).lerp(new THREE.Color(0x8d8880), 0.68);
    const cWall = base.clone().multiplyScalar(0.94);
    const cRoof = base.clone().multiplyScalar(0.82);
    const cPortal = base.clone().multiplyScalar(0.78);
    const cDeck = base.clone().multiplyScalar(0.86);
    const cCap = base.clone().multiplyScalar(1.12);
    const cPier = base.clone().multiplyScalar(0.9);
    const cCover = new THREE.Color(pb.terrain[0]).multiplyScalar(0.94);

    const K = SPAN;
    const beams = tunnel ? [
      { p0: [-1, K.boreHalf + K.wallT], p1: [-1, K.boreHalf], v0: -0.5, v1: K.roofH, col: cWall },
      { p0: [1, K.boreHalf], p1: [1, K.boreHalf + K.wallT], v0: -0.5, v1: K.roofH, col: cWall },
      /* The roof's TOP is ground, not concrete. A 3 m terrain grid cannot
       * resolve the metre-and-a-half lip of hillside that stands either
       * side of the slab, so the slab always shows a little from outside —
       * painted the colour of the hill it is buried in, that reads as the
       * hill continuing over the bore instead of as a plank lying on it. */
      { p0: [-1, [K.boreHalf + K.wallT, K.roofSpread]], p1: [1, [K.boreHalf + K.wallT, K.roofSpread]], v0: K.roofH, v1: K.roofH + 0.85, col: cRoof, colTop: cCover },
    ] : [
      /* Deck, kerb, top rail — with posts between them, emitted below. A
       * solid parapet is nearly invisible from the driver's seat (same
       * grey as the road, at the same height); a balustrade with daylight
       * through it is what actually says "there is nothing under you". */
      { p0: [-1, K.kerb], p1: [1, K.kerb], v0: -K.deckT, v1: -0.03, col: cDeck },
      { p0: [-1, K.kerb], p1: [-1, K.kerb - 0.34], v0: -0.06, v1: 0.44, col: cWall },
      { p0: [1, K.kerb - 0.34], p1: [1, K.kerb], v0: -0.06, v1: 0.44, col: cWall },
      { p0: [-1, K.kerb + 0.07], p1: [-1, K.kerb - 0.42], v0: K.parapet, v1: K.parapet + 0.17, col: cCap },
      { p0: [1, K.kerb - 0.42], p1: [1, K.kerb + 0.07], v0: K.parapet, v1: K.parapet + 0.17, col: cCap },
    ];
    const posts = tunnel ? null : [
      { p0: [-1, K.kerb], p1: [-1, K.kerb - 0.3], v0: 0.44, v1: K.parapet, col: cCap },
      { p0: [1, K.kerb - 0.3], p1: [1, K.kerb], v0: 0.44, v1: K.parapet, col: cCap },
    ];

    const pos = [], col = [], sS = [], sV = [];
    const lpos = [], lcol = [], lS = [], lV = [];
    const cLamp = new THREE.Color(0xffcf92);

    const pt = (f, lat, v) => [
      f.x + f.rx * lat - origin.x,
      f.y + f.cb * lat + v,
      f.z + f.rz * lat - origin.z,
    ];
    /* A lateral endpoint is [sign, offset]; an offset given as [a, b]
     * interpolates with how deep in the span the frame is, so the roof can
     * be exactly bore-wide at the portal and buried in hillside by the
     * middle without ever hanging in the air. */
    const latOf = (f, p) => p[0] * (f.hw + (Array.isArray(p[1]) ? p[1][0] + (p[1][1] - p[1][0]) * f.st : p[1]));
    function quad(a, b, c, d, c3) {
      pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      for (let k = 0; k < 6; k++) col.push(c3.r, c3.g, c3.b);
    }
    /* one segment of a swept box: four faces, no caps */
    function segment(A, B, bm) {
      const a0 = latOf(A, bm.p0), a1 = latOf(A, bm.p1);
      const b0 = latOf(B, bm.p0), b1 = latOf(B, bm.p1);
      const Al = pt(A, a0, bm.v0), Ar = pt(A, a1, bm.v0);
      const AL = pt(A, a0, bm.v1), AR = pt(A, a1, bm.v1);
      const Bl = pt(B, b0, bm.v0), Br = pt(B, b1, bm.v0);
      const BL = pt(B, b0, bm.v1), BR = pt(B, b1, bm.v1);
      quad(AL, AR, BR, BL, bm.colTop || bm.col);                 // top
      quad(Al, Bl, Br, Ar, bm.col.clone().multiplyScalar(0.7));  // underside
      quad(Al, AL, BL, Bl, bm.col.clone().multiplyScalar(0.88)); // one side
      quad(Ar, Br, BR, AR, bm.col.clone().multiplyScalar(0.96)); // the other
    }
    function cap(F, bm, c3) {
      const l0 = latOf(F, bm.p0), l1 = latOf(F, bm.p1);
      quad(pt(F, l0, bm.v0), pt(F, l1, bm.v0), pt(F, l1, bm.v1), pt(F, l0, bm.v1), c3);
    }
    /* A strip of light lying flat against the wall, running along the road
     * — not a bulb. At 140 km/h what you actually see of tunnel lighting is
     * the rhythm of it going past. */
    function lampQuad(F, lat, v, w, h) {
      const ax = F.x + F.rx * lat - origin.x, az = F.z + F.rz * lat - origin.z;
      const tx = -F.rz, tz = F.rx;                 // along the road
      const p = (dt, dv) => [ax + tx * dt, F.y + F.cb * lat + v + dv, az + tz * dt];
      lpos.push(...p(-w, -h), ...p(w, -h), ...p(w, h), ...p(-w, -h), ...p(w, h), ...p(-w, h));
      for (let k = 0; k < 6; k++) lcol.push(cLamp.r, cLamp.g, cLamp.b);
    }

    // ---- piers: probe the valley floor beside the deck, stand a leg on it
    // (a suspension deck hangs from its cables — the towers are its piers;
    // a Verge deck hangs from NOTHING — that country's bridges float)
    const susp = !tunnel && span.suspension;
    const pierAt = new Set();
    if (!tunnel && !susp && !span.floating) {
      for (let d = K.pierStep; d < span.s1 - span.s0 - 12; d += K.pierStep) {
        let best = null, bestD = 1e9;
        for (const f of frames) { const dd = Math.abs(f.s - (span.s0 + d)); if (dd < bestD) { bestD = dd; best = f; } }
        if (best) pierAt.add(best.i);
      }
    }
    function pier(F) {
      // an overpass pier never stands on the road it crosses — the deck
      // simply spans further between legs (world owns the one rule)
      if (span.over && !world.pierFootClear(F.i)) return;
      let floor = Infinity;
      for (const side of [-1, 1]) {
        const lat = side * (F.hw + 11);
        const g = world.groundHeight(F.x + F.rx * lat, F.z + F.rz * lat, F.s);
        if (g) floor = Math.min(floor, g.y);
      }
      if (!Number.isFinite(floor) || F.y - floor < 3.5) return;
      const drop = F.y - floor;
      const A = { ...F, x: F.x - F.rz * 1.5, z: F.z + F.rx * 1.5 };
      const B = { ...F, x: F.x + F.rz * 1.5, z: F.z - F.rx * 1.5 };
      // shaft, then a hammerhead cap carrying the deck
      segment(A, B, { p0: [-1, -F.hw + 1.3], p1: [1, -F.hw + 1.3], v0: -drop - 0.6, v1: -K.deckT, col: cPier });
      cap(A, { p0: [-1, -F.hw + 1.3], p1: [1, -F.hw + 1.3], v0: -drop - 0.6, v1: -K.deckT }, cPier);
      cap(B, { p0: [-1, -F.hw + 1.3], p1: [1, -F.hw + 1.3], v0: -drop - 0.6, v1: -K.deckT }, cPier);
      const A2 = { ...F, x: F.x - F.rz * 0.9, z: F.z + F.rx * 0.9 };
      const B2 = { ...F, x: F.x + F.rz * 0.9, z: F.z - F.rx * 0.9 };
      segment(A2, B2, { p0: [-1, K.kerb], p1: [1, K.kerb], v0: -K.deckT - 1.0, v1: -K.deckT, col: cPier });
    }

    /* ---- suspension dressing: two towers, main cables, hangers.
     * The cable is the classic silhouette: side spans diving from the
     * tower tops to deck anchors at the portals, the main span sagging
     * between the towers as a parabola. Drawn as crossed thin ribbons —
     * at any distance the eye reads the curve, not the section. */
    let towerK = null, cableV = null, towerH = 0;
    const cCable = base.clone().multiplyScalar(0.52);
    if (susp && frames.length >= 9) {
      const n = frames.length;
      towerH = Math.max(13, Math.min(26, span.depth * 0.55));
      const tA = Math.max(1, Math.round(n * 0.26));
      const tB = Math.min(n - 2, Math.round(n * 0.74));
      towerK = [tA, tB];
      cableV = new Float32Array(n);
      const sag = 2.3;
      for (let k = 0; k < n; k++) {
        if (k <= tA) { const t = tA ? k / tA : 1; cableV[k] = 1.1 + (towerH - 1.1) * t * t; }
        else if (k >= tB) { const t = (n - 1 - k) / Math.max(1, n - 1 - tB); cableV[k] = 1.1 + (towerH - 1.1) * t * t; }
        else { const c = 2 * ((k - tA) / (tB - tA)) - 1; cableV[k] = sag + (towerH - sag) * c * c; }
      }
    }
    function ribbon(a, b, w, c3) {
      // two crossed faces so a cable reads from any angle
      quad([a[0], a[1] - w, a[2]], [a[0], a[1] + w, a[2]], [b[0], b[1] + w, b[2]], [b[0], b[1] - w, b[2]], c3);
      quad([a[0] - w, a[1], a[2]], [a[0] + w, a[1], a[2]], [b[0] + w, b[1], b[2]], [b[0] - w, b[1], b[2]], c3);
    }
    function tower(F) {
      // never a leg on a road below (an overpass can be a suspension too)
      if (span.over && !world.pierFootClear(F.i)) return;
      let floor = Infinity;
      for (const side of [-1, 1]) {
        const lat = side * (F.hw + 11);
        const g = world.groundHeight(F.x + F.rx * lat, F.z + F.rz * lat, F.s);
        if (g) floor = Math.min(floor, g.y);
      }
      const below = Number.isFinite(floor) ? Math.max(2, F.y - floor + 0.6) : 4;
      const A = { ...F, x: F.x - F.rz * 1.05, z: F.z + F.rx * 1.05 };
      const B = { ...F, x: F.x + F.rz * 1.05, z: F.z - F.rx * 1.05 };
      for (const side of [-1, 1]) {
        const bm = { p0: [side, K.kerb + 0.55], p1: [side, K.kerb - 0.5], v0: -below, v1: towerH + 1.4, col: cPier };
        segment(A, B, bm); cap(A, bm, cPier); cap(B, bm, cPier);
      }
      // the portal frame over the deck
      const cb = { p0: [-1, K.kerb + 0.4], p1: [1, K.kerb + 0.4], v0: towerH - 1.5, v1: towerH + 0.3, col: cPier };
      segment(A, B, cb); cap(A, cb, cPier); cap(B, cb, cPier);
    }

    // ---- sweep
    for (let k = 0; k < frames.length - 1; k++) {
      const A = frames[k], B = frames[k + 1];
      for (const bm of beams) segment(A, B, bm);
      if (k === 0) for (const bm of beams) cap(A, bm, cPortal);
      if (k === frames.length - 2) for (const bm of beams) cap(B, bm, cPortal);
      if (cableV) {
        for (const side of [-1, 1]) {
          const la = side * (A.hw + K.kerb - 0.12), lb = side * (B.hw + K.kerb - 0.12);
          ribbon(pt(A, la, cableV[k]), pt(B, lb, cableV[k + 1]), 0.15, cCable);
          if (k % 2 === 0 && cableV[k] > 1.7) ribbon(pt(A, la, 0.45), pt(A, la, cableV[k]), 0.055, cCable);
        }
        if (towerK && (k === towerK[0] || k === towerK[1])) tower(A);
      }
      if (pierAt.has(A.i)) pier(A);
      // balustrade posts: one pair every other segment (10 m apart)
      if (posts && k % 2 === 0) {
        const P = { ...A, x: A.x - A.rz * 0.45, z: A.z + A.rx * 0.45 };
        const Q = { ...A, x: A.x + A.rz * 0.45, z: A.z - A.rx * 0.45 };
        for (const bm of posts) { segment(P, Q, bm); cap(P, bm, bm.col); cap(Q, bm, bm.col); }
      }
      /* Tunnel mouths get a collar: jambs and a lintel standing a metre
       * proud of the bore, which is what makes a portal read as built
       * rather than as a hole the terrain happens to have. */
      if (tunnel && (k === 0 || k === frames.length - 2)) {
        const F = k === 0 ? A : B;
        const G = { ...F, x: F.x + (k === 0 ? -1 : 1) * -F.rz * 1.1, z: F.z + (k === 0 ? -1 : 1) * F.rx * 1.1 };
        const jambs = [
          { p0: [-1, K.boreHalf + K.wallT + 0.9], p1: [-1, K.boreHalf - 0.1], v0: -0.5, v1: K.roofH + 1.0, col: cPortal },
          { p0: [1, K.boreHalf - 0.1], p1: [1, K.boreHalf + K.wallT + 0.9], v0: -0.5, v1: K.roofH + 1.0, col: cPortal },
          { p0: [-1, K.boreHalf + K.wallT + 0.9], p1: [1, K.boreHalf + K.wallT + 0.9], v0: K.roofH, v1: K.roofH + 1.0, col: cPortal },
        ];
        for (const bm of jambs) { segment(F, G, bm); cap(F, bm, cPortal); cap(G, bm, cPortal); }
      }
      // wall lamps, warm and sparse — the bloom does the rest
      if (tunnel && k > 0 && k % 5 === 0) {
        for (const side of [-1, 1]) lampQuad(A, side * (A.hw + K.boreHalf - 0.05), K.roofH * 0.74, 1.5, 0.16);
      }
      sS.push(B.s); sV.push(pos.length / 3);
      lS.push(B.s); lV.push(lpos.length / 3);
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, spanMat);
    mesh.frustumCulled = false;
    group.add(mesh);
    /* An OVERPASS deck is exempt from the terrain-blanket cut: its road
     * position is hundreds of metres ahead, but it stands directly over
     * ground that IS drawn (the lower road's corridor), so trimming it by
     * road distance made it invisible from exactly the place a player
     * looks up at it. */
    cuts.push({ mesh, sS, sV, drawn: -1, geo: g, noCut: !!span.over });
    if (lpos.length) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", new THREE.Float32BufferAttribute(lpos, 3));
      lg.setAttribute("color", new THREE.Float32BufferAttribute(lcol, 3));
      const lm = new THREE.Mesh(lg, lampMat);
      lm.frustumCulled = false;
      group.add(lm);
      cuts.push({ mesh: lm, sS: lS, sV: lV, drawn: -1, geo: lg, noCut: !!span.over });
    }
  }

  /* An ASCENDING overpass belongs to a section far past the build horizon
   * while the car passes underneath it, so its deck was invisible from
   * below and popped in later. The span's mesh alone is built EARLY, the
   * moment the car nears the lower passage — everything it needs is live
   * (the crossing holds the lower leg, the upper leg is inside the ring) —
   * and swapped for the owning section's own copy when that builds. */
  const earlySpans = new Map();      // span -> {group, geos, origin}
  function buildEarlySpan(sp) {
    const smp = world.sampleNear(sp.s0);
    if (!smp) return;
    const ownerRec = world.sections.find((r) => r.index === sp.sectionIndex);
    const origin = new THREE.Vector3(smp.x, 0, smp.z);
    const group = new THREE.Group();
    group.position.set(origin.x - kit.anchor.x, 0, origin.z - kit.anchor.z);
    const cuts = [];
    buildSpan(sp, group, origin, palFor(ownerRec ? ownerRec.biomeKey : world.biome.key), cuts);
    kit.scene.add(group);
    earlySpans.set(sp, { group, geos: cuts.map((c) => c.geo), origin });
  }
  function removeEarlySpan(sp) {
    const rec = earlySpans.get(sp);
    if (!rec) return;
    kit.scene.remove(rec.group);
    for (const g of rec.geos) g.dispose();
    earlySpans.delete(sp);
  }

  function buildSection(sec) {
    /* From here on the section's props are geometry, so the world must
     * stop editing them (see pruneOverlaid). */
    sec.built = true;
    const { X, Z, Y, HD, CB, HW, SF, SURF_IDS, MASK } = world.ring;
    const anchor = kit.anchor;
    const m0 = sec.i0 & MASK;
    const origin = new THREE.Vector3(X[m0], 0, Z[m0]);
    const group = new THREE.Group();
    group.position.set(origin.x - anchor.x, 0, origin.z - anchor.z);

    // road colours come from the biome, blended per sample across a transition
    const pHere = palFor(sec.biomeKey);
    const bi0 = world.biomeAt(sec.s0), bi1 = world.biomeAt(sec.s1);
    const inTransition = bi0.t < 1 || bi1.t < 1;
    const pPrev = inTransition ? bi0.prev.palette : pHere;
    const cEdge = new THREE.Color(), cTrack = new THREE.Color(), cCentre = new THREE.Color(), cShoulder = new THREE.Color();
    const cA = new THREE.Color(), cB = new THREE.Color();
    function roadColorsAt(i) {
      const t = inTransition ? world.biomeAt((i + 1) * world.DS).t : 1;
      cEdge.set(pPrev.roadEdge).lerp(cB.set(pHere.roadEdge), t);
      cA.set(pPrev.road).lerp(cB.set(pHere.road), t);
      cTrack.copy(cA).multiplyScalar(1.06);
      cCentre.copy(cA).multiplyScalar(0.94);
      cShoulder.set(pPrev.shoulder).lerp(cB.set(pHere.shoulder), t);
    }
    roadColorsAt(sec.i0);

    // lat stops across the deck: edge | wheel track | crown | track | edge
    const stops = [-1, -0.62, -0.16, 0.16, 0.62, 1];
    const bandCol = [cEdge, cTrack, cCentre, cTrack, cEdge];

    const posArr = [], colArr = [];
    const STEP = 2;
    function push(v) { posArr.push(v.x, v.y, v.z); }
    function lanePoint(i, latFrac, out) {
      const mm = i & MASK;
      const lat = latFrac * HW[mm];
      const rx = -Math.sin(HD[mm]), rz = Math.cos(HD[mm]);
      out.set(
        X[mm] + rx * lat - origin.x,
        Y[mm] + CB[mm] * lat + 0.035,
        Z[mm] + rz * lat - origin.z
      );
    }
    const pA = new THREE.Vector3(), pB = new THREE.Vector3(), pC = new THREE.Vector3(), pD = new THREE.Vector3();
    /* Snow and ice must LOOK like what the tyre law says they are — the
     * paint reads the same SF ring as the physics (Aspenvale's snow line,
     * an iced deck in cold country). Averaged over a few samples so the
     * snowline arrives over ten metres of road, not one triangle. */
    const cSnow = new THREE.Color(0xe6ebf0), cIce = new THREE.Color(0xc2d8e6);
    function surfWhite(i) {
      let sn = 0, ic = 0;
      for (const d of [-6, 0, 6]) {
        const ii = Math.min(sec.i1, Math.max(sec.i0 - 24, i + d));
        const sfk = SURF_IDS[SF[ii & MASK]];
        if (sfk === "snow") sn++;
        else if (sfk === "ice") ic++;
      }
      return { sn: sn / 3, ic: ic / 3 };
    }
    /* Where each step of deck ends up in the vertex buffer, so the ribbon
     * can be drawn only as far as the ground exists (a section can be
     * 600 m long; the terrain blanket reaches 560). */
    const ribS = [], ribV = [];
    /* Puddle potential at a deck vertex: water stands in longitudinal sags,
     * against the camber's low edge, and a little in the wheel ruts —
     * shaped into pools by smooth noise. This is geometry-honest (a slope
     * never holds a puddle), which is the whole point: the shader can only
     * mirror the sky where this says water would actually gather. */
    const pudAt = (i, lf, snK) => {
      const m = i & MASK;
      const iP = Math.max(sec.i0, i - 6) & MASK, iN = Math.min(sec.i1, i + 6) & MASK;
      const hollow = Math.max(0, (Y[iP] + Y[iN]) / 2 - Y[m]);
      const low = Math.max(0, -CB[m] * lf * HW[m]) * 1.8;
      const af = Math.abs(lf);
      const rut = Math.abs(af - 0.62) < 0.01 ? 0.22 : Math.abs(af - 0.16) < 0.01 ? 0.12 : 0;
      const lat = lf * HW[m];
      const px = X[m] - Math.sin(HD[m]) * lat, pz = Z[m] + Math.cos(HD[m]) * lat;
      const msk = Math.max(0, Math.min(1, (vnoise(px / 6.8, pz / 6.8) - 0.5) * 3.4));
      return Math.min(1, 0.16 + hollow * 2.4 + low + rut) * msk * (1 - snK);
    };
    const pudArr = [];
    for (let i = sec.i0; i < sec.i1 - STEP + 1; i += STEP) {
      const j = Math.min(sec.i1, i + STEP);
      if (inTransition && (i & 7) === 0) roadColorsAt(i);
      const shade = 1 + (cnoise(i, 7) - 0.5) * 0.06;
      const sw = surfWhite(i);
      for (let b = 0; b < 5; b++) {
        lanePoint(i, stops[b], pA); lanePoint(i, stops[b + 1], pB);
        lanePoint(j, stops[b], pC); lanePoint(j, stops[b + 1], pD);
        colTmp.copy(bandCol[b]).multiplyScalar(shade);
        if (sw.sn) colTmp.lerp(cSnow, 0.85 * sw.sn);
        if (sw.ic) colTmp.lerp(cIce, 0.8 * sw.ic);
        // CCW from above so the deck faces +Y
        push(pA); push(pB); push(pC);
        push(pB); push(pD); push(pC);
        for (let k = 0; k < 6; k++) colArr.push(colTmp.r, colTmp.g, colTmp.b);
        const puA = pudAt(i, stops[b], sw.sn), puB = pudAt(i, stops[b + 1], sw.sn);
        const puC = pudAt(j, stops[b], sw.sn), puD = pudAt(j, stops[b + 1], sw.sn);
        pudArr.push(puA, puB, puC, puB, puD, puC);
      }
      // shoulder strips
      for (const side of [-1, 1]) {
        const mI = i & MASK, mJ = j & MASK;
        const rxI = -Math.sin(HD[mI]), rzI = Math.cos(HD[mI]);
        const rxJ = -Math.sin(HD[mJ]), rzJ = Math.cos(HD[mJ]);
        const eI = HW[mI], eJ = HW[mJ];
        pA.set(X[mI] + rxI * side * eI - origin.x, Y[mI] + CB[mI] * side * eI + 0.03, Z[mI] + rzI * side * eI - origin.z);
        pB.set(X[mI] + rxI * side * (eI + 1.15) - origin.x, Y[mI] + CB[mI] * side * eI - 0.09, Z[mI] + rzI * side * (eI + 1.15) - origin.z);
        pC.set(X[mJ] + rxJ * side * eJ - origin.x, Y[mJ] + CB[mJ] * side * eJ + 0.03, Z[mJ] + rzJ * side * eJ - origin.z);
        pD.set(X[mJ] + rxJ * side * (eJ + 1.15) - origin.x, Y[mJ] + CB[mJ] * side * eJ - 0.09, Z[mJ] + rzJ * side * (eJ + 1.15) - origin.z);
        colTmp.copy(cShoulder).multiplyScalar(1 + (cnoise(i, side + 3) - 0.5) * 0.1);
        if (sw.sn) colTmp.lerp(cSnow, 0.8 * sw.sn);
        if (sw.ic) colTmp.lerp(cIce, 0.6 * sw.ic);
        if (side > 0) { push(pA); push(pB); push(pC); push(pB); push(pD); push(pC); }
        else { push(pA); push(pC); push(pB); push(pB); push(pC); push(pD); }
        for (let k = 0; k < 6; k++) { colArr.push(colTmp.r, colTmp.g, colTmp.b); pudArr.push(0); }
      }
      ribS.push((j + 1) * world.DS);
      ribV.push(posArr.length / 3);
    }
    const ribbonGeo = new THREE.BufferGeometry();
    ribbonGeo.setAttribute("position", new THREE.Float32BufferAttribute(posArr, 3));
    ribbonGeo.setAttribute("color", new THREE.Float32BufferAttribute(colArr, 3));
    ribbonGeo.setAttribute("aPud", new THREE.Float32BufferAttribute(pudArr, 1));
    ribbonGeo.computeVertexNormals();
    const ribbon = new THREE.Mesh(ribbonGeo, roadMat);
    ribbon.frustumCulled = false;
    group.add(ribbon);

    // ---------- props, grouped into instanced parts by (type, biome)
    const byType = {};
    for (const p of sec.props) {
      const key = p.type + "|" + (p.biome || sec.biomeKey);
      (byType[key] = byType[key] || []).push(p);
    }
    const geos = [ribbonGeo];
    const instanced = [];
    /* Draw lists, in road order. `sList[k]` is where instance k stands, so
     * the per-frame pass can simply shorten `count` — instances beyond the
     * terrain blanket (or, for trunks, beyond the distance a few-centimetre
     * cylinder can be drawn honestly) are not drawn at all. */
    const lists = [];
    const solo = [];        // one-off meshes (cabins, villas): same road-order rule

    /* Seat visual props on the exact triangles the blanket will draw
     * (hands-on #5: "props are not well placed on the ground, often in
     * the sky" — measured at up to 1.5 m of daylight under a trunk; the
     * placer's analytic point and the blanket's 3 m linear triangles are
     * different surfaces). Only ground the BLANKET owns: a prop whose
     * point resolves to deck or shoulder rides the ribbon's analytic
     * profile and keeps its placement height. Deliberate offsets opt out
     * with `noSeat` (the mesa is sunk on purpose, a lakeshore cabin is
     * perched on purpose); a seat metres away from placement means a
     * corner grabbed a structure or another leg entirely — trust the
     * placement then. The sink settles round bases into sloped ground.
     * COLLIDERS keep the analytic height on purpose: physics drives on
     * the analytic ground and the vertical window must agree with it. */
    const seater = makeSeater(world, CELL / RES);
    const SINK = {
      spruce: 0.14, pine: 0.14, birch: 0.14, cypress: 0.14, olive: 0.14,
      umbrella: 0.14, cactus: 0.1, shrub: 0.09, rock: 0.16, rockRed: 0.16,
      cabin: 0.12, villa: 0.12,
      cottonwood: 0.14, cedar: 0.14, lodgepole: 0.14, snag: 0.12, larch: 0.14,
      canyonwall: 0.6, granitetower: 1.5, geyser: 0.1, hotpool: 0.12, lantern: 0.05,
      dwelling: 0.12, chapel: 0.2,
    };
    function seatY(it, type) {
      if (it._ySeat != null) return it._ySeat;
      let y = it.y;
      if (!it.noSeat && type !== "oldslab") {
        const g0 = world.groundHeight(it.x, it.z, null);
        if (g0 && g0.on === "off") {
          const s = seater(it.x, it.z);
          if (s != null && Math.abs(s - it.y) < 2.5) y = s - (SINK[type] || 0) * (it.scale || 1);
        }
      }
      return (it._ySeat = y);
    }

    for (const [key, items] of Object.entries(byType)) {
      const [type, bkey] = key.split("|");
      const pb = palFor(bkey);
      if (type === "waystation") { for (const it of items) buildWaystation(it, group, origin, pb); continue; }
      if (type === "waysign") { for (const it of items) buildWaysign(it, group, origin); continue; }
      if (type === "cabin" || type === "villa" || type === "dwelling") {
        /* a `dwelling` (a hamlet's house, a farmstead) is whatever this
         * country lives in — the same white villa on the coast, the same
         * red cabin in the north — so the towns never import a style */
        const drawAs = type === "dwelling" ? ((BIOMES[bkey] && BIOMES[bkey].cabinType) || "cabin") : type;
        for (const it of items) {
          const cab = new THREE.Group();
          if (drawAs === "villa") {
            const walls = new THREE.Mesh(geo("villaWalls", () => { const g = new THREE.BoxGeometry(7.5, 3.4, 5.5); g.translate(0, 1.7, 0); return g; }), mat(pb.cabin));
            const roof = new THREE.Mesh(geo("villaRoof", () => { const g = new THREE.BoxGeometry(8.2, 0.5, 6.2); g.translate(0, 3.6, 0); return g; }), mat(pb.cabinRoof));
            const wing = new THREE.Mesh(geo("villaWing", () => { const g = new THREE.BoxGeometry(3.4, 2.4, 4.0); g.translate(4.6, 1.2, 0.5); return g; }), mat(pb.cabin));
            cab.add(walls, roof, wing);
            const win = new THREE.Mesh(geo("villaWin", () => {
              const g = new THREE.PlaneGeometry(0.9, 0.62);
              const a = g.clone(); a.translate(-1.6, 1.5, 2.77);
              const b = g.clone(); b.translate(1.6, 1.5, 2.77);
              // yard light on the terrace corner: crossed quads, readable
              // from any angle — a distant dwelling is its light
              const y1 = new THREE.PlaneGeometry(0.44, 0.44); y1.translate(4.2, 2.5, 3.1);
              const y2 = new THREE.PlaneGeometry(0.44, 0.44); y2.rotateY(Math.PI / 2); y2.translate(4.2, 2.5, 3.1);
              return mergeGeos([a, b, y1, y2]);
            }), windowMat);
            cab.add(win);
          } else {
            const walls = new THREE.Mesh(geo("cabinWalls", () => { const g = new THREE.BoxGeometry(4.4, 2.3, 3.4); g.translate(0, 1.15, 0); return g; }), mat(pb.cabin));
            const roofG = geo("cabinRoof", () => { const g = new THREE.ConeGeometry(3.1, 1.5, 4); g.rotateY(Math.PI / 4); g.translate(0, 3.0, 0); return g; });
            const roof = new THREE.Mesh(roofG, mat(pb.cabinRoof));
            cab.add(walls, roof);
            /* One warm window per cabin: dark glass by day, and after dusk
             * the shared material comes up with the night — which is what
             * turns a hamlet on the valley floor into "a lit village far
             * below in the dark" without a single scripted light. */
            const win = new THREE.Mesh(geo("cabinWin", () => {
              const g = new THREE.PlaneGeometry(0.72, 0.5); g.translate(0.85, 1.25, 1.72);
              const y1 = new THREE.PlaneGeometry(0.4, 0.4); y1.translate(2.55, 2.2, 1.95);
              const y2 = new THREE.PlaneGeometry(0.4, 0.4); y2.rotateY(Math.PI / 2); y2.translate(2.55, 2.2, 1.95);
              return mergeGeos([g, y1, y2]);
            }), windowMat);
            cab.add(win);
          }
          cab.position.set(it.x - origin.x, seatY(it, type), it.z - origin.z);
          cab.rotation.y = it.rot;
          group.add(cab);
          solo.push({ obj: cab, s: it.s || sec.s0 });
        }
        continue;
      }
      const parts = PROP_PARTS[type];
      if (!parts) continue;
      items.sort((a, b) => (a.s || 0) - (b.s || 0));
      const sList = items.map((it) => it.s || sec.s0);
      for (const partName of parts) {
        const part = PARTS[partName];
        const colors = part.colors ? pb[part.colors] : null;
        /* `fixed` opts out of the palette entirely. Almost everything in
         * the world should wear its country's colours; a wind turbine
         * should not, because a wind turbine is the same off-white object
         * in every country on earth, and painting it barn-red because
         * Norrland's cabins are barn-red made the blades read as rust. */
        const matl = part.glow ? windowMat
          : colors ? lambertInstance()
            : part.unlit ? unlitMat(part.fixed, part.twoSided, part.alpha)
              : mat(part.fixed != null ? part.fixed : pb[part.color]);
        const inst = new THREE.InstancedMesh(part.geo(), matl, items.length);
        for (let k = 0; k < items.length; k++) {
          const it = items[k];
          dummy.position.set(it.x - origin.x, seatY(it, type), it.z - origin.z);
          dummy.rotation.set(0, it.rot, 0);
          dummy.scale.setScalar(it.scale);
          dummy.updateMatrix();
          inst.setMatrixAt(k, dummy.matrix);
          if (colors) {
            colTmp.set(colors[k % colors.length]).multiplyScalar(0.9 + (k % 7) * 0.035);
            inst.setColorAt(k, colTmp);
          }
        }
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        inst.frustumCulled = false;
        group.add(inst);
        instanced.push(inst);
        lists.push({ inst, sList, thin: !!part.thin, drawn: items.length });
      }
    }

    /* A ford: water lying LEVEL in the hollow. It used to ride the deck a
     * hand proud, following slope and camber — which is how a "puddle"
     * ends up lying on a hillside (hands-on: puddles "never well placed").
     * Now the water finds its own table: the lowest deck point across the
     * span sets the level, the pond fills its whole hollow (a little past
     * the event's bounds if the dip continues), and the shoreline falls
     * exactly where the deck rises through the surface — the depth test
     * against the ribbon draws the banks for free. Transparent and unlit:
     * what sells shallow water is seeing the road through it. */
    if (sec.ford) {
      const fpos = [];
      const plan = pondPlan(world.ring, sec, sec.ford, world.DS);
      const wA = new THREE.Vector3(), wB = new THREE.Vector3(), wC = new THREE.Vector3(), wD = new THREE.Vector3();
      for (let i = plan ? plan.iA : 0; plan && i < plan.iB; i++) {
        const j = i + 1;
        const e0 = plan.shoreHalf(i), e1 = plan.shoreHalf(j);
        if (e0 <= 0 && e1 <= 0) continue;
        lanePoint(i, -e0, wA); lanePoint(i, e0, wB);
        lanePoint(j, -e1, wC); lanePoint(j, e1, wD);
        for (const v of [wA, wB, wC, wD]) v.y = plan.level;
        fpos.push(wA.x, wA.y, wA.z, wB.x, wB.y, wB.z, wC.x, wC.y, wC.z);
        fpos.push(wB.x, wB.y, wB.z, wD.x, wD.y, wD.z, wC.x, wC.y, wC.z);
      }
      if (fpos.length) {
        const fg = new THREE.BufferGeometry();
        fg.setAttribute("position", new THREE.Float32BufferAttribute(fpos, 3));
        const fm = new THREE.Mesh(fg, fordMat);
        fm.frustumCulled = false;
        fm.renderOrder = 2;
        group.add(fm);
        geos.push(fg);
        solo.push({ obj: fm, s: sec.ford.s0 });
      }
    }

    // crossings: built in road order so they cut at the blanket like the ribbon
    const cuts = [];
    for (const span of sec.spans || []) {
      removeEarlySpan(span);      // the section's own copy takes over seamlessly
      buildSpan(span, group, origin, palFor(sec.biomeKey), cuts);
    }
    for (const c of cuts) geos.push(c.geo);

    buildPickups(sec, group, origin);
    kit.scene.add(group);
    sectionMeshes.set(sec.index, { group, origin, geos, instanced, lists, solo, cuts, ribbon, ribS, ribV, ribDrawn: -1, s0: sec.s0, s1: sec.s1 });
  }

  const unlitCache = {};
  function unlitMat(color, twoSided, alpha) {
    const key = color + "|" + (twoSided ? 1 : 0) + "|" + (alpha || 1);
    if (!unlitCache[key]) {
      unlitCache[key] = new THREE.MeshBasicMaterial({
        color, side: twoSided ? THREE.DoubleSide : THREE.FrontSide,
        // steam: translucent and never writing depth, so the trees behind
        // it stay drawn and a column of plumes does not sort against itself
        transparent: !!alpha, opacity: alpha || 1, depthWrite: !alpha,
      });
    }
    return unlitCache[key];
  }

  function lambertInstance() {
    // instanced meshes need their own material instance for instanceColor
    return hfog(new THREE.MeshLambertMaterial());
  }

  /* --------------------------------------------------------- terrain grid */

  /* per-biome terrain colour sets, cached */
  const terrSets = {};
  function terrSet(key) {
    if (terrSets[key]) return terrSets[key];
    const p = palFor(key);
    return (terrSets[key] = {
      terr: p.terrain.map((c) => new THREE.Color(c)),
      rock: new THREE.Color(p.rock),
      lake: new THREE.Color(p.lake),
      shore: new THREE.Color(p.lakeShore),
      shoulder: new THREE.Color(p.shoulder),
      roadUnder: new THREE.Color(p.roadEdge).multiplyScalar(0.9),
    });
  }
  const cMix = new THREE.Color();

  /* The ground colour as a GRADIENT through the country's palette — two
   * octaves of smooth noise at an awkward ratio (one octave has a visible
   * heartbeat, the tree-clump lesson), so meadow, scrub and bare patches
   * come out as coherent shapes with soft edges instead of the per-vertex
   * confetti the old hash pick gave. */
  function terrShade(set, px, pz, out) {
    const t = Math.max(0, Math.min(0.999,
      vnoise(px / 41, pz / 41) * 0.62 + vnoise(px / 13.7, pz / 13.7) * 0.38));
    const gk = t * (set.terr.length - 1);
    const i0 = Math.floor(gk);
    out.copy(set.terr[i0]).lerp(set.terr[Math.min(set.terr.length - 1, i0 + 1)], gk - i0);
    return out;
  }

  function buildTerrainCell(cx, cz, hintS, sFar) {
    const originX = cx * CELL, originZ = cz * CELL;
    const nVerts = RES + 1;
    const positions = new Float32Array(nVerts * nVerts * 3);
    const normals = new Float32Array(nVerts * nVerts * 3);
    const colors = new Float32Array(nVerts * nVerts * 3);
    const smpHint = world.sampleNear(hintS);
    const hintY = smpHint ? smpHint.y : 0;
    /* Colour is decided in a second pass, because rock belongs on ground
     * that is STEEP, and slope needs the neighbouring heights. Keeping the
     * per-vertex ground facts here costs one small array and saves
     * re-querying the world for them. */
    const vGround = new Array(nVerts * nVerts);
    /* Heights are sampled on an EXTENDED grid — one ring of vertices past
     * every edge — so normals, slope and cavity all come from central
     * differences that see across the cell border. computeVertexNormals()
     * per cell could not: border vertices only averaged the triangles
     * inside their own cell, and every 48 m seam showed as a lighting
     * crease drawn in a grid across the hills. */
    const E = nVerts + 2;
    const ext = new Float32Array(E * E);
    let vi = 0;
    for (let gz = -1; gz <= RES + 1; gz++) {
      for (let gx = -1; gx <= RES + 1; gx++) {
        const px = originX + (gx / RES) * CELL;
        const pz = originZ + (gz / RES) * CELL;
        /* No hint. The cell's hint is one road distance for a 48 m square
         * that may be two cells away from it, and the hint OVERRIDES the
         * nearest leg by design (it is there to keep the car on one road
         * through a switchback). Used here it resolved vertices sitting a
         * metre from one leg against another ninety metres up the hill,
         * and answered with that leg's off-road height — drawing the
         * hillside straight over the deck. Reported as "the road clipping
         * through terrain"; measured at up to 3.1 m of it. Terrain wants
         * the ground of whichever road is actually nearest, which is what
         * an unhinted query returns. The hint still serves the fallback
         * below, where there is no corridor to be nearest to. */
        /* One definition of a blanket vertex, shared with the prop seater
         * (render/seat.js) so props sit on the exact triangles drawn here.
         * It carries the bridge-drop rule: a bridge deck is a STRUCTURE
         * and the blanket must not draw it — a grid vertex landing on the
         * deck would come back at road height and silently turn the
         * viaduct into an earth causeway; such vertices fall to the valley
         * floor (or, under an overpass, to the lower road's own ground). */
        const vg = vertGround(world, px, pz, hintS);
        let vy = vg.y;
        if (!Number.isFinite(vy)) { vy = hintY; stats.nanVerts++; }   // a NaN vertex is a hole
        ext[(gz + 1) * E + (gx + 1)] = vy;
        if (gx < 0 || gz < 0 || gx > RES || gz > RES) continue;
        positions[vi * 3] = px - originX;
        positions[vi * 3 + 1] = vy;
        positions[vi * 3 + 2] = pz - originZ;
        vGround[vi] = vg.g;
        vi++;
      }
    }

    /* Second pass — colour. Rock used to be painted wherever the ground
     * rose more than 5 m above the road, which drew a horizontal band at a
     * constant height around every hill: a contour line, not geology. It
     * comes out on SLOPE now (soil does not sit on steep ground), with the
     * threshold broken up by hash noise so the edge wanders, and height
     * only leaning on it. */
    const step = CELL / RES;
    /* The region's palette tint — DECLARED since 7a.1 (heather mauve,
     * wheat gold), but never wired to a renderer until Aspenvale's snow
     * line needed the ground to actually whiten. Both halves of the blend
     * lerp in with their own strengths, so a region change fades rather
     * than pops. */
    function applyRegionTint(g) {
      if (!g || !g.rq) return;
      const rr = world.regionOf(g.rq.s);
      if (!rr || !rr.region) return;
      const pv = rr.prev, cu = rr.region;
      if (pv && pv.tint != null && pv.tintA) colTmp.lerp(cMix.setHex(pv.tint), Math.min(0.9, pv.tintA * (1 - rr.t)));
      if (cu.tint != null && cu.tintA) colTmp.lerp(cMix.setHex(cu.tint), Math.min(0.9, cu.tintA * rr.t));
    }
    for (let gz = 0; gz < nVerts; gz++) {
      for (let gx = 0; gx < nVerts; gx++) {
        const i = gz * nVerts + gx;
        const g = vGround[i];
        const px = originX + (gx / RES) * CELL;
        const pz = originZ + (gz / RES) * CELL;
        const n = cnoise(Math.floor(px * 0.7), Math.floor(pz * 0.7));
        // central differences across the extended grid: normal, slope, cavity
        const ei = (gz + 1) * E + (gx + 1);
        const yh = ext[ei];
        const yW = ext[ei - 1], yE = ext[ei + 1], yN = ext[ei - E], yS = ext[ei + E];
        let nx = (yW - yE) / (2 * step), nz = (yN - yS) / (2 * step);
        const nl = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        normals[i * 3] = nx * nl; normals[i * 3 + 1] = nl; normals[i * 3 + 2] = nz * nl;
        const slope = Math.hypot(yE - yW, yS - yN) / (2 * step);
        const hollow = (yW + yE + yN + yS) / 4 - yh;
        const bi = g ? world.biomeAt(g.rq.s) : world.hereBiome;
        const A = terrSet(bi.biome.key), P = bi.t < 1 ? terrSet(bi.prev.key) : A;
        const bt = bi.t;
        if (g && g.water) {
          colTmp.copy(A.lake).lerp(A.shore, n * 0.25);
          if (bt < 1) colTmp.lerp(cMix.copy(P.lake), 1 - bt);
        } else if (g && g.on === "road") {
          colTmp.copy(A.roadUnder);
          if (bt < 1) colTmp.lerp(P.roadUnder, 1 - bt);
        } else if (g && g.on === "shoulder") {
          colTmp.copy(A.shoulder);
          if (bt < 1) colTmp.lerp(P.shoulder, 1 - bt);
          colTmp.multiplyScalar(0.95 + n * 0.1);
          applyRegionTint(g);
        } else {
          terrShade(A, px, pz, colTmp);
          if (bt < 1) colTmp.lerp(terrShade(P, px, pz, cMix), 1 - bt);
          colTmp.multiplyScalar(0.94 + n * 0.12);
          /* cavity: hollows gather shade, crests catch light — the cheap
           * ambient truth a single hemisphere light cannot give a
           * heightfield, and what makes low-poly ground read as FORM */
          colTmp.multiplyScalar(1 + Math.max(-0.13, Math.min(0.07, -hollow * 0.4)));
          const rel = g ? g.y - hintY : 0;
          const bare = (slope - (0.55 + n * 0.35)) * 1.7 + Math.max(0, rel - 14) * 0.012;
          if (bare > 0) colTmp.lerp(A.rock, Math.min(0.62, bare));
          // the region's palette tint, AFTER rock so snow lies over the
          // crags and the crags still break through where it is steep
          applyRegionTint(g);
        }
        colors[i * 3] = colTmp.r; colors[i * 3 + 1] = colTmp.g; colors[i * 3 + 2] = colTmp.b;
      }
    }
    const idx = [];
    for (let gz = 0; gz < RES; gz++) {
      for (let gx = 0; gx < RES; gx++) {
        const a = gz * nVerts + gx, b = a + 1, c = a + nVerts, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, lambert);
    mesh.position.set(originX - kit.anchor.x, 0, originZ - kit.anchor.z);
    mesh.frustumCulled = false;
    kit.scene.add(mesh);
    /* provisional: built within reach of the generation frontier (a
     * waystation hold, say) — its far side guessed at road that did not
     * exist yet. It is rebuilt once the frontier has moved on. */
    const frontier = world.frontierS();
    const provisional = (sFar != null ? sFar : hintS) + CELL * 2.5 > frontier - 30;
    /* IN PLACE: a rebuilt cell's old mesh leaves the scene only after the
     * new one is in it — the hole rule (see the streaming block below) */
    const key = cx + "," + cz;
    const old = terrainCells.get(key);
    if (old) { kit.scene.remove(old.mesh); old.mesh.geometry.dispose(); }
    terrainCells.set(key, { mesh, cx, cz, originX, originZ, provisional, frontierAtBuild: frontier, lastNeeded: frame, stale: false });
    coverFar(cx, cz);
  }

  /* ------------------------------------------------------- the far shell */
  const farCells = new Map();      // "fx,fz" -> {mesh, fx, fz, originX, originZ, provisional, frontierAtBuild, lastNeeded, stale}
  const farNeeded = new Set();

  /* how far a shell vertex is tucked under the blanket: fully where every
   * near cell touching it is drawn, not at all where one is missing (a
   * vertex on a cell boundary touches two or four) — see THE SEAM */
  function sinkAt(px, pz) {
    const cx = px / CELL, cz = pz / CELL;
    const x0 = Math.floor(cx), z0 = Math.floor(cz);
    const xa = cx === x0 ? x0 - 1 : x0, za = cz === z0 ? z0 - 1 : z0;
    for (let x = xa; x <= x0; x++) {
      for (let z = za; z <= z0; z++) if (!terrainCells.has(x + "," + z)) return 0;
    }
    return FAR_SINK;
  }
  /* a near cell came or went: every shell cell sharing a vertex with it
   * (its own, and the neighbours across a shared boundary) re-tucks */
  function touchFar(cx, cz) {
    const fxa = Math.ceil(cx / 2) - 1, fxb = Math.floor((cx + 1) / 2);
    const fza = Math.ceil(cz / 2) - 1, fzb = Math.floor((cz + 1) / 2);
    for (let fx = fxa; fx <= fxb; fx++) {
      for (let fz = fza; fz <= fzb; fz++) {
        const fc = farCells.get(fx + "," + fz);
        if (fc) fc.stale = true;
      }
    }
  }

  function buildFarCell(fx, fz) {
    const originX = fx * FCELL, originZ = fz * FCELL;
    const baseI = world.nearestSampleFar(originX + FCELL / 2, originZ + FCELL / 2, null);
    if (baseI < 0) return false;
    const baseSmp = world.sampleNear((baseI + 1) * world.DS);
    const baseY = baseSmp ? baseSmp.y : 0;
    const nV = FRES + 1, E = nV + 2;
    const step = FCELL / FRES;
    const ext = new Float32Array(E * E);
    const positions = new Float32Array(nV * nV * 3);
    const normals = new Float32Array(nV * nV * 3);
    const colors = new Float32Array(nV * nV * 3);
    const meta = new Array(nV * nV);
    /* a vertex resolved against the last stretch of generated road is a
     * GUESS about ground the generator has not decided yet — the cell
     * rebuilds once the frontier has moved on (the near blanket's own
     * provisional rule, worn far) */
    let guessed = false;
    let vi = 0;
    for (let gz = -1; gz <= FRES + 1; gz++) {
      for (let gx = -1; gx <= FRES + 1; gx++) {
        const px = originX + (gx / FRES) * FCELL;
        const pz = originZ + (gz / FRES) * FCELL;
        let y, s, water = false, on = null;
        const v = vertGround(world, px, pz, null);
        if (v.g) {
          // inside the corridor: the blanket's own vertex definition, so
          // the two surfaces agree where they meet
          y = v.y; s = v.g.rq ? v.g.rq.s : (baseI + 1) * world.DS;
          water = !!v.g.water; on = v.g.on;
        } else {
          const ni = world.nearestSampleFar(px, pz, baseI);
          const fg = world.farGround(px, pz, ni);
          if (!fg) return false;
          y = fg.y; s = fg.s; water = fg.water;
          if (ni > world.iNext - 48) guessed = true;
        }
        y -= sinkAt(px, pz);
        if (!Number.isFinite(y)) { y = baseY; stats.nanVerts++; }
        ext[(gz + 1) * E + (gx + 1)] = y;
        if (gx < 0 || gz < 0 || gx > FRES || gz > FRES) continue;
        positions[vi * 3] = px - originX;
        positions[vi * 3 + 1] = y;
        positions[vi * 3 + 2] = pz - originZ;
        meta[vi] = { s, water, on };
        vi++;
      }
    }
    // colour: the near blanket's palette logic, at shell distance (no
    // cavity — a 16 m hollow is a landform, not a texture)
    for (let gz = 0; gz < nV; gz++) {
      for (let gx = 0; gx < nV; gx++) {
        const i = gz * nV + gx;
        const m = meta[i];
        const px = originX + (gx / FRES) * FCELL, pz = originZ + (gz / FRES) * FCELL;
        const n = cnoise(Math.floor(px * 0.7), Math.floor(pz * 0.7));
        const ei = (gz + 1) * E + (gx + 1);
        const yW = ext[ei - 1], yE = ext[ei + 1], yN = ext[ei - E], yS = ext[ei + E];
        const nx = (yW - yE) / (2 * step), nz = (yN - yS) / (2 * step);
        const nl = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        normals[i * 3] = nx * nl; normals[i * 3 + 1] = nl; normals[i * 3 + 2] = nz * nl;
        const slope = Math.hypot(yE - yW, yS - yN) / (2 * step);
        const bi = world.biomeAt(m.s);
        const A = terrSet(bi.biome.key), P = bi.t < 1 ? terrSet(bi.prev.key) : A;
        const bt = bi.t;
        if (m.water) {
          colTmp.copy(A.lake).lerp(A.shore, n * 0.25);
          if (bt < 1) colTmp.lerp(cMix.copy(P.lake), 1 - bt);
        } else if (m.on === "road" || m.on === "shoulder") {
          colTmp.copy(m.on === "road" ? A.roadUnder : A.shoulder);
          if (bt < 1) colTmp.lerp(m.on === "road" ? P.roadUnder : P.shoulder, 1 - bt);
        } else {
          terrShade(A, px, pz, colTmp);
          if (bt < 1) colTmp.lerp(terrShade(P, px, pz, cMix), 1 - bt);
          colTmp.multiplyScalar(0.94 + n * 0.12);
          const rel = ext[ei] + sinkAt(px, pz) - baseY;
          const bare = (slope - (0.55 + n * 0.35)) * 1.7 + Math.max(0, rel - 14) * 0.012;
          if (bare > 0) colTmp.lerp(A.rock, Math.min(0.62, bare));
          const rr = world.regionOf(m.s);
          if (rr && rr.region) {
            const pv = rr.prev, cu = rr.region;
            if (pv && pv.tint != null && pv.tintA) colTmp.lerp(cMix.setHex(pv.tint), Math.min(0.9, pv.tintA * (1 - rr.t)));
            if (cu.tint != null && cu.tintA) colTmp.lerp(cMix.setHex(cu.tint), Math.min(0.9, cu.tintA * rr.t));
          }
        }
        colors[i * 3] = colTmp.r; colors[i * 3 + 1] = colTmp.g; colors[i * 3 + 2] = colTmp.b;
      }
    }
    const idx = [];
    for (let gz = 0; gz < FRES; gz++) {
      for (let gx = 0; gx < FRES; gx++) {
        const a = gz * nV + gx, b = a + 1, c = a + nV, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, lambert);
    mesh.position.set(originX - kit.anchor.x, 0, originZ - kit.anchor.z);
    // far cells DO frustum-cull (most of the ring is behind the camera)
    mesh.visible = !farCovered(fx, fz);
    kit.scene.add(mesh);
    const key = fx + "," + fz;
    const old = farCells.get(key);
    if (old) { kit.scene.remove(old.mesh); old.mesh.geometry.dispose(); }
    farCells.set(key, { mesh, fx, fz, originX, originZ, provisional: guessed, frontierAtBuild: world.frontierS(), lastNeeded: frame, stale: false });
    return true;
  }

  /* ------------------------------------------------- streaming the ground
   *
   * THE HOLE RULE (2026-08-30 — Quinn: "I can often see holes in the
   * map"): nothing that is drawn may be taken away before its replacement
   * exists, and nothing the camera can see may wait its turn behind
   * something it cannot. Four things broke it, each a hole:
   *  - the needed set was sampled from carS−130 in 33.6 m steps, so its
   *    lateral edge cells flickered in and out with the car's phase along
   *    the road — dropped one refresh, rebuilt (one per frame) the next;
   *  - a cell whose ground was guessed near the generation frontier was
   *    DELETED when the frontier moved on and rebuilt later: every route
   *    choice threw away a strip of the near blanket and half the far
   *    shell at once, then filled them back one or three per frame;
   *  - the far shell only un-hid where the near blanket had gone on one
   *    frame in ten, so a dropped near cell showed SKY for up to nine;
   *  - one cell per frame, in insertion order: at 30 fps behind a hitch
   *    the far end of the blanket fell behind the car, and a hairpin's
   *    burst of new cells queued behind ones the camera could not see.
   * Now: the sample comb is phase-locked to the world (the set changes
   * only when the car crosses a 24 m mark); a cell leaving the set gets a
   * grace before it is dropped; stale cells are REBUILT IN PLACE (the old
   * mesh stands until the new one is in the scene); the far shell's cover
   * is re-evaluated the moment a near cell comes or goes; and building is
   * paid for in milliseconds, nearest to the car first, holes before wrong
   * ground, with a bigger purse while there is a deficit. fill() spends a
   * lump sum where a run starts or a route is chosen so the first frame
   * is whole. stats() is the audit — `oc.terrain()` in the console,
   * tools/_terrprobe.mjs from outside. */
  let frame = 0;
  const needed = new Map();      // "cx,cz" -> {cx, cz, s, sFar, d2}
  const farOrder = [];           // the ring, nearest the car first
  const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const NEAR_STEP = CELL * 0.5;  // comb pitch: every cell the road crosses gets a tooth
  const NEAR_GRACE = 40;         // frames a near cell outlives the needed set
  const FAR_GRACE = 30;
  const BUDGET_MS = 3;           // build time per frame, steady state
  const BUDGET_DEFICIT_MS = 9;   // while something needed is not drawn
  const stats = {
    frames: 0, holeFrames: 0, worstHoles: 0, holes: 0, patches: 0,
    nearMissing: 0, nearStale: 0, farMissing: 0, farStale: 0,
    built: 0, builtFar: 0, msMax: 0, msSum: 0, nanVerts: 0,
  };

  function farCovered(fx, fz) {
    return terrainCells.has((2 * fx) + "," + (2 * fz))
      && terrainCells.has((2 * fx + 1) + "," + (2 * fz))
      && terrainCells.has((2 * fx) + "," + (2 * fz + 1))
      && terrainCells.has((2 * fx + 1) + "," + (2 * fz + 1));
  }
  /* the far cell under a near cell that just came or went */
  function coverFar(cx, cz) {
    touchFar(cx, cz);
    const fx = Math.floor(cx / 2), fz = Math.floor(cz / 2);
    const fc = farCells.get(fx + "," + fz);
    if (!fc) return;
    const show = !farCovered(fx, fz);
    if (fc.mesh.visible !== show) fc.mesh.visible = show;
  }
  function dropNear(key, cell) {
    kit.scene.remove(cell.mesh);
    cell.mesh.geometry.dispose();
    terrainCells.delete(key);
    coverFar(cell.cx, cell.cz);
  }
  function dropFar(key, cell) {
    kit.scene.remove(cell.mesh);
    cell.mesh.geometry.dispose();
    farCells.delete(key);
  }

  /* the near blanket's needed set: a comb of 5×5 windows along the road,
   * its teeth on fixed 24 m marks so the set never jitters with the car */
  function refreshNeeded(carS) {
    needed.clear();
    const here = world.sampleNear(carS);
    const hx = here ? here.x : 0, hz = here ? here.z : 0;
    const s0 = Math.floor((carS - TERR_BEHIND) / NEAR_STEP) * NEAR_STEP;
    const s1 = carS + TERR_AHEAD * reachK;
    for (let s = s0; s < s1; s += NEAR_STEP) {
      const smp = world.sampleNear(s);
      if (!smp) continue;
      const ccx = Math.floor(smp.x / CELL), ccz = Math.floor(smp.z / CELL);
      const behind = s < carS - 30;
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const cx = ccx + dx, cz = ccz + dz;
          const key = cx + "," + cz;
          const ex = (cx + 0.5) * CELL - hx, ez = (cz + 0.5) * CELL - hz;
          // urgency: distance from the car; behind counts for less — the
          // camera looks forward, and only glances back over a shoulder
          const d2 = (ex * ex + ez * ez) * (behind ? 4 : 1) + (behind ? 40000 : 0);
          const n = needed.get(key);
          if (!n) needed.set(key, { cx, cz, s, sFar: s, d2 });
          else {
            if (d2 < n.d2) { n.d2 = d2; n.s = s; }
            if (s > n.sFar) n.sFar = s;
          }
        }
      }
    }
    const frontier = world.frontierS();
    for (const [key, cell] of terrainCells) {
      if (needed.has(key)) cell.lastNeeded = frame;
      else if (frame - cell.lastNeeded > NEAR_GRACE) { dropNear(key, cell); continue; }
      // built against road the generator had not decided yet: wrong ground,
      // rebuilt in place once the frontier has moved on
      if (cell.provisional && frontier > cell.frontierAtBuild + 40) cell.stale = true;
    }
  }

  function deficitNear() {
    let missing = 0, stale = 0;
    for (const [key] of needed) {
      const cell = terrainCells.get(key);
      if (!cell) missing++; else if (cell.stale) stale++;
    }
    return { missing, stale };
  }

  /* build near cells until the deadline: holes first (nearest first), then
   * stale ground; always at least minN so a slow frame still progresses */
  function buildNear(deadline, minN) {
    let built = 0;
    for (;;) {
      let best = null, bestPri = Infinity;
      for (const [key, n] of needed) {
        const cell = terrainCells.get(key);
        if (cell && !cell.stale) continue;
        const pri = cell ? n.d2 + 1e12 : n.d2;   // every hole outranks every patch of wrong ground
        if (pri < bestPri) { bestPri = pri; best = n; }
      }
      if (!best) break;
      buildTerrainCell(best.cx, best.cz, best.s, best.sFar);
      built++;
      if (built >= minN && nowMs() > deadline) break;
    }
    return built;
  }

  /* the far shell's ring: who is needed, nearest first; who fell out of
   * it or went stale; whose cover changed */
  function refreshFar(carS) {
    const c = world.sampleNear(carS);
    if (!c) return;
    farNeeded.clear();
    farOrder.length = 0;
    const fx0 = Math.floor(c.x / FCELL), fz0 = Math.floor(c.z / FCELL);
    const nR = Math.ceil(FAR_R / FCELL);
    for (let dx = -nR; dx <= nR; dx++) {
      for (let dz = -nR; dz <= nR; dz++) {
        const d2 = (dx * dx + dz * dz) * FCELL * FCELL;
        if (d2 > FAR_R * FAR_R) continue;
        const fx = fx0 + dx, fz = fz0 + dz;
        const key = fx + "," + fz;
        farNeeded.add(key);
        farOrder.push({ key, fx, fz, d2 });
      }
    }
    farOrder.sort((a, b) => a.d2 - b.d2);
    const frontier = world.frontierS();
    for (const [key, cell] of farCells) {
      if (farNeeded.has(key)) cell.lastNeeded = frame;
      else if (frame - cell.lastNeeded > FAR_GRACE) { dropFar(key, cell); continue; }
      if (cell.provisional && frontier > cell.frontierAtBuild + 300) cell.stale = true;
      const show = !farCovered(cell.fx, cell.fz);
      if (cell.mesh.visible !== show) cell.mesh.visible = show;
    }
  }

  function deficitFar() {
    let missing = 0, stale = 0;
    for (const o of farOrder) {
      const cell = farCells.get(o.key);
      if (!cell) missing++; else if (cell.stale) stale++;
    }
    return { missing, stale };
  }

  function buildFar(deadline, minN) {
    let built = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const o of farOrder) {
        const cell = farCells.get(o.key);
        if (pass === 0 ? !!cell : !(cell && cell.stale)) continue;
        if (!buildFarCell(o.fx, o.fz)) continue;
        built++;
        if (built >= minN && nowMs() > deadline) return built;
      }
    }
    return built;
  }

  /* the audit: a needed near cell with nothing drawn under it is a HOLE
   * (sky through the ground); one with only the far shell under it is a
   * PATCH (coarse ground, a hand's breadth low) — tolerable for a frame or
   * two, and what the deficit purse exists to clear */
  function audit(t0) {
    let holes = 0, patches = 0;
    for (const [key, n] of needed) {
      if (terrainCells.has(key)) continue;
      const fc = farCells.get(Math.floor(n.cx / 2) + "," + Math.floor(n.cz / 2));
      if (fc && fc.mesh.visible) patches++; else holes++;
    }
    stats.holes = holes;
    stats.patches = patches;
    if (holes) stats.holeFrames++;
    if (holes > stats.worstHoles) stats.worstHoles = holes;
    const ms = nowMs() - t0;
    stats.msSum += ms;
    if (ms > stats.msMax) stats.msMax = ms;
  }

  /* a lump sum: where a run starts or a route is chosen, build everything
   * needed before the next frame is drawn (bounded by ms) */
  function fill(carS, ms) {
    frame++;
    const t0 = nowMs();
    refreshNeeded(carS);
    refreshFar(carS);
    const deadline = t0 + ms;
    buildNear(deadline, 1);
    buildFar(deadline, 1);
    audit(t0);
  }

  function getStats() {
    const dn = deficitNear(), df = deficitFar();
    return {
      ...stats, nearMissing: dn.missing, nearStale: dn.stale, farMissing: df.missing, farStale: df.stale,
      nearCells: terrainCells.size, farCells: farCells.size, needed: needed.size, farNeeded: farNeeded.size,
      msAvg: stats.frames ? stats.msSum / stats.frames : 0,
    };
  }

  /* Draw-distance setting: the blanket and the draw-cut move TOGETHER —
   * they must, or props stand past drawn terrain (the white-specks rule). */
  let reachK = 1;

  /* Per-frame streaming: figure out what's needed, build one heavy thing. */
  let animT = 0;
  function update(carS, dt) {
    frame++;
    stats.frames++;
    const t0 = nowMs();
    animT += dt || 0.016;
    const propLimit = carS + TERR_AHEAD * reachK - 26;
    for (const lp of livePickups) {
      // taken, or standing where the terrain has not reached yet (a bright
      // little shape hanging in the sky is very hard to un-see)
      const show = !lp.p.taken && lp.p.s <= propLimit;
      if (lp.mesh.visible !== show) lp.mesh.visible = show;
      if (!show) continue;
      lp.mesh.position.y = lp.p.y + Math.sin(animT * 2.2 + lp.phase) * 0.12;
      lp.mesh.rotation.y = animT * 1.4 + lp.phase;
    }

    // overpass decks whose owning section is still past the build horizon:
    // stand them up before the car passes underneath
    if (frame % 9 === 2) {
      for (const sp of world.spans) {
        if (!sp.over || sp.underS0 == null) continue;
        if (earlySpans.has(sp) || sectionMeshes.has(sp.sectionIndex)) continue;
        if (carS > sp.underS0 - 560 && carS < sp.underS1 + 250) buildEarlySpan(sp);
      }
    }

    // sections: build the nearest queued one — never past the terrain
    // blanket, or trees would float against the sky out there
    if (buildQueueS.length) {
      buildQueueS.sort((a, b) => a.s0 - b.s0);
      const sec = buildQueueS[0];
      if (sec.s0 < carS + TERR_AHEAD * reachK - 30) {
        buildQueueS.shift();
        buildSection(sec);
      }
    }

    /* How much of each section to draw.
     *
     * A section can be 600 m long but the terrain blanket only reaches 560 m
     * ahead, so the far end of a freshly built section used to stand in mid
     * air against the sky — read from the road as a cluster of pale specks
     * on the horizon (and the odd floating pickup). And trunks are a few
     * centimetres wide: past a couple of hundred metres they are far under
     * a pixel, and birch bark being white, they shimmered.
     *
     * Both are the same fix. Props are sorted by road position, so cutting
     * a draw list short is one assignment — no per-instance culling, no
     * rebuilt buffers. */
    if (frame % 4 === 0) {
      const terrLimit = carS + TERR_AHEAD * reachK - 26;
      const trunkLimit = carS + TRUNK_DIST;
      for (const rec of sectionMeshes.values()) {
        if (rec.ribbon && rec.ribS.length) {
          let n = rec.ribV[rec.ribV.length - 1];
          if (rec.ribS[rec.ribS.length - 1] > terrLimit) {
            let lo = 0, hi = rec.ribS.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (rec.ribS[mid] <= terrLimit) lo = mid + 1; else hi = mid; }
            n = lo ? rec.ribV[lo - 1] : 0;
          }
          if (n !== rec.ribDrawn) { rec.ribDrawn = n; rec.ribbon.geometry.setDrawRange(0, n); }
        }
        for (const e of rec.solo) {
          const show = e.s <= terrLimit;
          if (e.obj.visible !== show) e.obj.visible = show;
        }
        for (const c of rec.cuts || []) {
          if (c.noCut) continue;       // an overpass deck stands over drawn ground
          let n = c.sV.length ? c.sV[c.sV.length - 1] : 0;
          if (c.sS.length && c.sS[c.sS.length - 1] > terrLimit) {
            let lo = 0, hi = c.sS.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (c.sS[mid] <= terrLimit) lo = mid + 1; else hi = mid; }
            n = lo ? c.sV[lo - 1] : 0;
          }
          if (n !== c.drawn) { c.drawn = n; c.mesh.geometry.setDrawRange(0, n); }
        }
        for (const e of rec.lists) {
          const lim = e.thin ? Math.min(terrLimit, trunkLimit) : terrLimit;
          let n = e.sList.length;
          if (e.sList.length && e.sList[e.sList.length - 1] > lim) {
            let lo = 0, hi = e.sList.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (e.sList[mid] <= lim) lo = mid + 1; else hi = mid; }
            n = lo;
          }
          if (n !== e.drawn) { e.drawn = n; e.inst.count = n; }
        }
      }
    }

    // terrain: the needed sets refresh on a cadence (and at once when empty)
    if (frame % 10 === 1 || needed.size === 0) refreshNeeded(carS);
    if (frame % 10 === 6 || farOrder.length === 0) refreshFar(carS);

    // the purse: a few ms a frame, more while something needed is undrawn
    const dn = deficitNear();
    const deficit = dn.missing > 0 || dn.stale > 6 || !farCells.size || farCells.size < farNeeded.size * 0.6;
    const deadline = t0 + (deficit ? BUDGET_DEFICIT_MS : BUDGET_MS);
    stats.built += buildNear(deadline, 1);
    // the shell always gets a little, or a long near deficit starves it
    stats.builtFar += buildFar(deadline, 2);
    audit(t0);
  }

  // re-sit everything when the anchor snaps
  kit.onRebase(() => {
    for (const rec of sectionMeshes.values()) {
      rec.group.position.set(rec.origin.x - kit.anchor.x, 0, rec.origin.z - kit.anchor.z);
    }
    for (const rec of earlySpans.values()) {
      rec.group.position.set(rec.origin.x - kit.anchor.x, 0, rec.origin.z - kit.anchor.z);
    }
    for (const cell of terrainCells.values()) {
      cell.mesh.position.set(cell.originX - kit.anchor.x, 0, cell.originZ - kit.anchor.z);
    }
    for (const cell of farCells.values()) {
      cell.mesh.position.set(cell.originX - kit.anchor.x, 0, cell.originZ - kit.anchor.z);
    }
  });

  /* tear everything down (new run) */
  function dispose() {
    for (const rec of sectionMeshes.values()) {
      kit.scene.remove(rec.group);
      for (const g of rec.geos) g.dispose();
      for (const m of rec.instanced) m.dispose();
    }
    sectionMeshes.clear();
    for (const rec of earlySpans.values()) {
      kit.scene.remove(rec.group);
      for (const g of rec.geos) g.dispose();
    }
    earlySpans.clear();
    livePickups.length = 0;
    for (const cell of terrainCells.values()) {
      kit.scene.remove(cell.mesh);
      cell.mesh.geometry.dispose();
    }
    terrainCells.clear();
    for (const cell of farCells.values()) {
      kit.scene.remove(cell.mesh);
      cell.mesh.geometry.dispose();
    }
    farCells.clear();
    farNeeded.clear();
    farOrder.length = 0;
    needed.clear();
    buildQueueS.length = 0;
    world.onSectionAdded = null;
    world.onSectionRemoved = null;
  }

  /* wet roads go dark and a little blue — and the puddles fill (aPud ×
   * uWet in the road shader mirrors the sky into the standing water) */
  function setWetness(w) {
    const k = 1 - 0.38 * w;
    roadMat.color.setRGB(k, k, k * (1 + 0.06 * w));
    WET.uWet.value = w;
  }

  /* Windows light up with the night — pushed past 1.0 so the bloom pass
   * turns each one into a warm GLOW: at a hundred metres a lit window is
   * under a pixel of geometry, and a distant village reads as lights,
   * never as window frames (the tunnel-lamp trick, one material for all). */
  function setNight(n) {
    const w = Math.max(0, Math.min(1, n));
    windowMat.color.setHex(0x14161a).lerp(colTmp.setHex(0xffd98a), w).multiplyScalar(1 + 2.2 * w);
  }

  /* Graphics settings, render-only both: terrain vertex density (physics
   * reads the analytic ground fn, never these meshes) and draw distance
   * (blanket + cut + section builds all move off one number). Vegetation
   * density is deliberately NOT a setting: trees are physical colliders,
   * and a thinner forest would be an invisible wall — the one wall the
   * bible forbids. */
  function setDetail(res) {
    if (res === RES) return;
    RES = res;
    // rebuilt in place, nearest first — never a blanket-wide hole
    for (const c of terrainCells.values()) c.stale = true;
  }
  function setReach(k) { reachK = Math.max(0.5, Math.min(1, k)); }
  /* far-shell radius (render-only, like everything here): the ring
   * refresh reads it next cadence — new cells build inside, cells beyond
   * it age out through the grace window, never a visible edit */
  function setFarRadius(m) { FAR_R = Math.max(500, Math.min(1400, m)); }

  return { update, fill, stats: getStats, dispose, setWetness, setNight, setDetail, setReach, setFarRadius };
}
