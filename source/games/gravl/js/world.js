/* Gravl — 3D world construction and per-frame visuals.
 *
 * Everything is procedural, low-poly and vertex-coloured: road ribbon,
 * terrain skirts, instanced scenery, sky dome, weather particles and the
 * rally car itself. No textures are fetched from anywhere; the only texture
 * is a tiny CanvasTexture for the start/finish banners and the contact
 * shadow blob.
 */

import * as THREE from "three";
import { DS } from "./track.js";
import { CAR } from "./physics.js";
import { applyDaylight, sunDirection } from "./daylight.js";

/* Suspension travel, metres. The body is drawn on the spring and each wheel
 * is drawn on the ground under it; the gap between the two is the travel. */
const SUS_UP = 0.18, SUS_DOWN = 0.24;

/* ------------------------------------------------------------- palettes */

const PALETTES = {
  finland: {
    skyTop: 0x6fa8d8, skyHor: 0xdfeaf2, fog: 0xd4e2ec,
    sun: 0xfff3d8, sunInt: 1.05, hemi: 0xbcd6ee, hemiG: 0x59704a, hemiInt: 0.75,
    road: 0x9a8c6d, roadEdge: 0x847455, shoulder: 0x6f7a4c,
    terrain: [0x55703f, 0x4c6539, 0x5d7a45, 0x64834b],
    far: 0x44603c, mountain: 0x5a7186,
    foliage: [0x2f5230, 0x3a6337, 0x2a4a2c], trunk: 0x6b503a, rock: 0x8a8d90,
  },
  wales: {
    skyTop: 0x8b98a5, skyHor: 0xcfd6d9, fog: 0xc2ccd0,
    sun: 0xe8ecec, sunInt: 0.72, hemi: 0xaebfc9, hemiG: 0x4c6242, hemiInt: 0.8,
    road: 0x77705c, roadEdge: 0x615b49, shoulder: 0x556842,
    terrain: [0x4a6339, 0x546f40, 0x3f5731, 0x5d7847],
    far: 0x3e5634, mountain: 0x66747d,
    foliage: [0x2c4c2e, 0x365837, 0x24422a], trunk: 0x5c4634, rock: 0x7d8184,
  },
  sweden: {
    skyTop: 0x9fc0dd, skyHor: 0xeef4f8, fog: 0xe6eef4,
    sun: 0xfff6e0, sunInt: 0.95, hemi: 0xd0e2f0, hemiG: 0xcdd8e0, hemiInt: 0.8,
    road: 0xcfd9e2, roadEdge: 0xbac6d1, shoulder: 0xeef3f7,
    terrain: [0xe9eff4, 0xf2f6f9, 0xdde6ee, 0xedf2f6],
    far: 0xdbe5ee, mountain: 0xb9c9d8,
    foliage: [0x37543b, 0x415f44, 0x2e4a33], trunk: 0x5a4636, rock: 0xaab3bb,
    snowTree: true,
  },
  monte: {
    skyTop: 0x7aa3cc, skyHor: 0xe8e2d5, fog: 0xd8d5c8,
    sun: 0xfff0d0, sunInt: 1.0, hemi: 0xc4d2e0, hemiG: 0x8c8878, hemiInt: 0.72,
    road: 0x66666b, roadEdge: 0x55555a, shoulder: 0x8c8878,
    terrain: [0x97927e, 0x8a856f, 0xa29b84, 0x7c785f],
    far: 0x767258, mountain: 0x8d94a2,
    foliage: [0x44603c, 0x3a5535, 0x50694a], trunk: 0x6b573f, rock: 0x9a958a,
  },
  medit: {
    skyTop: 0x5f9fd8, skyHor: 0xf0e9d8, fog: 0xe6dfc9,
    sun: 0xfff2ce, sunInt: 1.12, hemi: 0xccdcec, hemiG: 0x9c9070, hemiInt: 0.72,
    road: 0x6e6d70, roadEdge: 0x5c5b5e, shoulder: 0x998e6c,
    terrain: [0xa89c76, 0x998e68, 0xb2a583, 0x8f855f],
    far: 0x8a805c, mountain: 0x9aa3ad,
    foliage: [0x5c7048, 0x516540, 0x687d54], trunk: 0x77644a, rock: 0xb0a894,
  },
  desert: {
    skyTop: 0x6faede, skyHor: 0xf2e3c8, fog: 0xecdcbd,
    sun: 0xfff0c8, sunInt: 1.18, hemi: 0xd8e2ec, hemiG: 0xb09468, hemiInt: 0.7,
    road: 0xb4a075, roadEdge: 0xa08c62, shoulder: 0xc4ab7c,
    terrain: [0xcfb381, 0xc4a874, 0xd9bd8c, 0xbaa06c],
    far: 0xb59d6e, mountain: 0xba9d78,
    foliage: [0x6f7d47, 0x627040, 0x7b8a51], trunk: 0x8a7350, rock: 0xa8825c,
  },
};

/* Weather adjustments applied over the environment palette */
function applyWeather(pal, stage) {
  const out = Object.assign({}, pal);
  const w = stage.weatherId;
  const mix = (c, t, k) => new THREE.Color(c).lerp(new THREE.Color(t), k).getHex();
  if (w === "overcast") {
    out.skyTop = mix(pal.skyTop, 0x8f9aa5, 0.6);
    out.skyHor = mix(pal.skyHor, 0xc9ced3, 0.5);
    out.fog = mix(pal.fog, 0xc4cacf, 0.5);
    out.sunInt = pal.sunInt * 0.55;
    out.hemiInt = pal.hemiInt * 1.1;
  } else if (w === "rain") {
    out.skyTop = mix(pal.skyTop, 0x5c6a76, 0.72);
    out.skyHor = mix(pal.skyHor, 0xa9b2ba, 0.65);
    out.fog = mix(pal.fog, 0x9fa9b1, 0.6);
    out.sunInt = pal.sunInt * 0.4;
    out.road = mix(pal.road, 0x2c2f34, 0.35);
    out.roadEdge = mix(pal.roadEdge, 0x26292d, 0.35);
  } else if (w === "fog") {
    out.skyTop = mix(pal.skyTop, 0xb9c2c8, 0.8);
    out.skyHor = mix(pal.skyHor, 0xd4dadd, 0.7);
    out.fog = mix(pal.fog, 0xcdd4d8, 0.75);
    out.sunInt = pal.sunInt * 0.45;
  } else if (w === "snowfall") {
    out.skyTop = mix(pal.skyTop, 0xaab8c4, 0.65);
    out.skyHor = mix(pal.skyHor, 0xdde4e9, 0.5);
    out.fog = mix(pal.fog, 0xd6dee4, 0.6);
    out.sunInt = pal.sunInt * 0.6;
  }
  /* `sunset` used to be handled here as a weather condition. It is an hour,
   * not a sky, so it now lives in daylight.js - a stage that draws sunset
   * weather pins the time of day instead, and applyDaylight paints it. The id
   * stays in the environment weather tables because removing it would change
   * the weighted draw and reshuffle every published stage. */
  return out;
}

function jitterColor(c, r, amt) {
  const col = new THREE.Color(c);
  const k = 1 + (r() - 0.5) * amt;
  col.r = Math.min(1, col.r * k); col.g = Math.min(1, col.g * k); col.b = Math.min(1, col.b * k);
  return col;
}

/* tiny deterministic rng for cosmetic jitter */
function cosmeticRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* --------------------------------------------------------------- helpers */

function pushTri(pos, col, a, b, c, color) {
  pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < 3; i++) col.push(color.r, color.g, color.b);
}

function meshFromTris(pos, col, mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  return m;
}

function bannerTexture(text, bg, fg) {
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = fg;
  ctx.font = "bold 40px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function blobTexture() {
  const cv = document.createElement("canvas");
  cv.width = 64; cv.height = 64;
  const ctx = cv.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
  g.addColorStop(0, "rgba(0,0,0,0.42)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

/* soft round sprite so particles do not render as hard squares */
function puffTexture() {
  const cv = document.createElement("canvas");
  cv.width = 32; cv.height = 32;
  const ctx = cv.getContext("2d");
  const g = ctx.createRadialGradient(16, 16, 2, 16, 16, 15);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.6, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(cv);
}

/* ---------------------------------------------------------------- world */

export function buildWorld(stage, opts) {
  const quality = (opts && opts.quality) || "high";
  // environment -> weather -> hour; see daylight.js for why the hour goes last
  const pal = applyDaylight(applyWeather(PALETTES[stage.env.id], stage), stage.timeOfDay);
  const r = cosmeticRng(stage.seed ^ 0xc05e71c);

  const scene = new THREE.Scene();
  const fogInfo = stage.weather.fog;
  const fogNear = fogInfo >= 1 ? 30 : fogInfo > 0.3 ? 90 : 160;
  const fogFar = fogInfo >= 1 ? 210 : fogInfo > 0.3 ? 480 : quality === "low" ? 620 : 900;
  scene.fog = new THREE.Fog(pal.fog, fogNear, fogFar);

  // ---- lights
  const hemi = new THREE.HemisphereLight(pal.hemi, pal.hemiG, pal.hemiInt);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(pal.sun, pal.sunInt);
  const sd = sunDirection(stage.timeOfDay);
  sun.position.set(sd.x, sd.y, sd.z).multiplyScalar(300);
  scene.add(sun);

  /* At night the directional moon and the hemisphere between them leave the
   * undersides of things completely black, which reads as holes rather than
   * shadow on flat-shaded low-poly geometry. A small ambient floor lifts them
   * back to legible. Daylight hours pass 0 here and get no extra light. */
  if (pal.ambient > 0) scene.add(new THREE.AmbientLight(pal.sun, pal.ambient));

  // ---- sky dome
  {
    const g = new THREE.SphereGeometry(1600, 20, 12);
    const posA = g.getAttribute("position");
    const cols = new Float32Array(posA.count * 3);
    const cTop = new THREE.Color(pal.skyTop), cHor = new THREE.Color(pal.skyHor);
    const tmp = new THREE.Color();
    for (let i = 0; i < posA.count; i++) {
      const y = posA.getY(i) / 1600;
      const t = Math.max(0, Math.min(1, (y + 0.08) * 1.7));
      tmp.copy(cHor).lerp(cTop, Math.pow(t, 0.8));
      cols[i * 3] = tmp.r; cols[i * 3 + 1] = tmp.g; cols[i * 3 + 2] = tmp.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    const sky = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    sky.renderOrder = -10;
    scene.add(sky);
  }

  const geo = stage.geo;
  const lambert = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });

  // ---- stage bounding box (for backdrop placement)
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9, minY = 1e9;
  for (let i = 0; i < geo.n; i++) {
    minX = Math.min(minX, geo.x[i]); maxX = Math.max(maxX, geo.x[i]);
    minZ = Math.min(minZ, geo.z[i]); maxZ = Math.max(maxZ, geo.z[i]);
    minY = Math.min(minY, geo.y[i]);
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;

  /* ---- stars
   *
   * Only at night, and only above the horizon - a night sky with nothing in
   * it reads as a rendering fault rather than as darkness. One Points object,
   * no per-frame work. Positions come from the cosmetic RNG, so the same day
   * gets the same sky. */
  if (pal.stars > 0) {
    const n = quality === "low" ? Math.floor(pal.stars * 0.45) : pal.stars;
    const pos = new Float32Array(n * 3);
    const R = 1480;                       // just inside the sky dome
    for (let i = 0; i < n; i++) {
      // bias towards the upper hemisphere: below the horizon they are hidden
      // by terrain anyway, and spending them overhead looks denser
      const u = r() * 2 - 1;
      const y = Math.abs(u) * 0.92 + 0.06;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const a = r() * Math.PI * 2;
      pos[i * 3] = cx + Math.cos(a) * ring * R;
      pos[i * 3 + 1] = Math.max(minY, 0) + y * R;
      pos[i * 3 + 2] = cz + Math.sin(a) * ring * R;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({
      // sizeAttenuation off so distance does not shrink them to nothing; kept
      // to a couple of pixels because an unmapped Point is a hard square and
      // anything larger reads as confetti rather than a star
      color: 0xdfe8ff, size: 2, sizeAttenuation: false,
      transparent: true, opacity: 0.85, fog: false, depthWrite: false,
    }));
    stars.renderOrder = -9;               // after the dome, before everything
    scene.add(stars);
  }

  // ---- far ground disc + mountain ring
  {
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1500, 40),
      new THREE.MeshLambertMaterial({ color: pal.far })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(cx, minY - 4.5, cz);
    scene.add(disc);

    const mountains = new THREE.Group();
    const mMat = new THREE.MeshLambertMaterial({ color: pal.mountain, flatShading: true });
    const ringR = Math.max(maxX - minX, maxZ - minZ) / 2 + 420;
    for (let i = 0; i < 26; i++) {
      const ang = (i / 26) * Math.PI * 2 + r() * 0.2;
      const h = 60 + r() * 150;
      const m = new THREE.Mesh(new THREE.ConeGeometry(90 + r() * 120, h, 5 + Math.floor(r() * 3)), mMat);
      m.position.set(cx + Math.cos(ang) * (ringR + r() * 200), minY - 6 + h / 2 - 8, cz + Math.sin(ang) * (ringR + r() * 200));
      m.rotation.y = r() * Math.PI;
      mountains.add(m);
    }
    scene.add(mountains);
  }

  // ---- road ribbon + terrain skirts
  {
    const posRoad = [], colRoad = [];
    const posTerr = [], colTerr = [];
    const cRoad = new THREE.Color(pal.road);
    const cEdge = new THREE.Color(pal.roadEdge);
    const cShoulder = new THREE.Color(pal.shoulder);
    const terrCols = pal.terrain.map((c) => new THREE.Color(c));

    const STEP = 2;              // road sampled every 2 samples (4 m)
    const offs = [1.0, 1.12, 1.45, 2.2, 4.0, 7.5, 13, 22, 38, 60];  // × hw or absolute-ish

    /* How far the skirt may fan out from each side of each sample.
     *
     * The outer rings reach ~60 m, which is wider than a hairpin, so on a
     * switchback the skirt sails across the gap and lands on the other leg -
     * carrying this sample's elevation with it and burying that road under a
     * slab of hillside. Look down each lateral ray for the nearest piece of
     * course sitting in front of it and stop half way, so the two skirts meet
     * in the middle instead of overlapping. A straight road finds nothing in
     * its lateral cone and keeps the full reach. */
    const reach = [new Float64Array(geo.n), new Float64Array(geo.n)]; // [left, right]
    {
      const MAXR = offs[offs.length - 1];
      for (let i = 0; i < geo.n; i++) {
        const tx = Math.cos(geo.heading[i]), tz = Math.sin(geo.heading[i]);
        for (let sIdx = 0; sIdx < 2; sIdx++) {
          const side = sIdx === 0 ? -1 : 1;
          const lx = -tz * side, lz = tx * side;
          let best = MAXR * 2;
          for (let j = 0; j < geo.n; j += 2) {
            if (Math.abs(j - i) < 5) continue;
            const dx = geo.x[j] - geo.x[i], dz = geo.z[j] - geo.z[i];
            const along = dx * lx + dz * lz;
            if (along <= 0 || along >= best) continue;
            // only count road that is genuinely out to the side, not ahead
            if (Math.abs(dx * tx + dz * tz) > along) continue;
            best = along;
          }
          reach[sIdx][i] = Math.min(MAXR, best / 2);
        }
      }
      // widen nothing, narrow neighbours: keeps the skirt edge from stepping
      const sm = [new Float64Array(geo.n), new Float64Array(geo.n)];
      for (let sIdx = 0; sIdx < 2; sIdx++) {
        for (let i = 0; i < geo.n; i++) {
          let v = reach[sIdx][i];
          for (let k = -3; k <= 3; k++) {
            const j = i + k;
            if (j >= 0 && j < geo.n) v = Math.min(v, reach[sIdx][j]);
          }
          sm[sIdx][i] = v;
        }
        reach[sIdx].set(sm[sIdx]);
      }
    }

    // clamp a lateral offset to the reach, keeping the shoulder intact
    function limit(i, lat) {
      const cap = Math.max(stage.hwArr[i] + 4, reach[lat < 0 ? 0 : 1][i]);
      return Math.sign(lat) * Math.min(Math.abs(lat), cap);
    }

    function groundAt(i, lat) {
      // lat: signed lateral in metres. Resolved against the sample we are
      // actually drawing rather than by nearest-point search, which snaps to
      // the wrong leg of the course out here and hangs terrain in the air.
      const hx = -Math.sin(geo.heading[i]), hz = Math.cos(geo.heading[i]);
      const px = geo.x[i] + hx * lat, pz = geo.z[i] + hz * lat;
      const g = stage.groundAtSample(i, lat, px, pz);
      return { x: px, y: g ? g.y : geo.y[i], z: pz };
    }

    function roadPoint(i, lat) {
      const hx = -Math.sin(geo.heading[i]), hz = Math.cos(geo.heading[i]);
      return {
        x: geo.x[i] + hx * lat,
        y: geo.y[i] + stage.cambArr[i] * lat + 0.02,
        z: geo.z[i] + hz * lat,
      };
    }

    for (let i = 0; i < geo.n - STEP; i += STEP) {
      const j = i + STEP;
      const hwI = stage.hwArr[i], hwJ = stage.hwArr[j];

      // road deck: edge strip, centre, edge strip
      const bright = 1 + (r() - 0.5) * 0.07;
      const cc = cRoad.clone().multiplyScalar(bright);
      const lanes = [
        [-hwI, -hwI * 0.82, -hwJ, -hwJ * 0.82, cEdge],
        [-hwI * 0.82, hwI * 0.82, -hwJ * 0.82, hwJ * 0.82, cc],
        [hwI * 0.82, hwI, hwJ * 0.82, hwJ, cEdge],
      ];
      for (const [aL, aR, bL, bR, col] of lanes) {
        const p1 = roadPoint(i, aL), p2 = roadPoint(i, aR);
        const p3 = roadPoint(j, bL), p4 = roadPoint(j, bR);
        // CCW seen from above (+Y) so the deck faces the sky
        pushTri(posRoad, colRoad, p1, p2, p3, col);
        pushTri(posRoad, colRoad, p2, p4, p3, col);
      }

      // bridge: draw side skirts and skip terrain
      if (stage.flagArr[i] & 1) {
        const deckL1 = roadPoint(i, -hwI), deckL2 = roadPoint(j, -hwJ);
        const deckR1 = roadPoint(i, hwI), deckR2 = roadPoint(j, hwJ);
        const dark = new THREE.Color(0x4a4038);
        for (const [t1, t2] of [[deckL1, deckL2], [deckR1, deckR2]]) {
          const b1 = { x: t1.x, y: t1.y - 2.2, z: t1.z };
          const b2 = { x: t2.x, y: t2.y - 2.2, z: t2.z };
          pushTri(posTerr, colTerr, t1, t2, b1, dark);
          pushTri(posTerr, colTerr, b1, t2, b2, dark);
        }
        continue;
      }

      // terrain skirts each side
      for (let side = -1; side <= 1; side += 2) {
        for (let o = 0; o < offs.length - 1; o++) {
          const l1 = limit(i, side * (offs[o] <= 2.2 ? hwI * offs[o] : hwI + (offs[o] - 1)));
          const l2 = limit(i, side * (offs[o + 1] <= 2.2 ? hwI * offs[o + 1] : hwI + (offs[o + 1] - 1)));
          const m1 = limit(j, side * (offs[o] <= 2.2 ? hwJ * offs[o] : hwJ + (offs[o] - 1)));
          const m2 = limit(j, side * (offs[o + 1] <= 2.2 ? hwJ * offs[o + 1] : hwJ + (offs[o + 1] - 1)));
          const p1 = groundAt(i, l1), p2 = groundAt(i, l2);
          const p3 = groundAt(j, m1), p4 = groundAt(j, m2);
          let col;
          if (offs[o] < 1.4) col = cShoulder.clone().multiplyScalar(1 + (r() - 0.5) * 0.1);
          else col = terrCols[Math.floor(r() * terrCols.length)].clone().multiplyScalar(1 + (r() - 0.5) * 0.12);
          if (side > 0) {
            pushTri(posTerr, colTerr, p1, p2, p3, col);
            pushTri(posTerr, colTerr, p2, p4, p3, col);
          } else {
            pushTri(posTerr, colTerr, p1, p3, p2, col);
            pushTri(posTerr, colTerr, p2, p3, p4, col);
          }
        }
      }
    }
    scene.add(meshFromTris(posRoad, colRoad, lambert));
    scene.add(meshFromTris(posTerr, colTerr, lambert));
  }

  // ---- instanced scenery
  const dummy = new THREE.Object3D();
  const foliageCols = pal.foliage.map((c) => new THREE.Color(c));

  function instanced(geometry, material, items, place) {
    if (!items.length) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    for (let k = 0; k < items.length; k++) {
      place(items[k], dummy, k);
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  }

  function instancedColored(geometry, items, place, colorOf) {
    if (!items.length) return null;
    const mat = new THREE.MeshLambertMaterial();
    const mesh = new THREE.InstancedMesh(geometry, mat, items.length);
    for (let k = 0; k < items.length; k++) {
      place(items[k], dummy, k);
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);
      mesh.setColorAt(k, colorOf(items[k], k));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  }

  const byType = {};
  for (const it of stage.scenery) {
    (byType[it.t] = byType[it.t] || []).push(it);
  }

  const trunkMat = new THREE.MeshLambertMaterial({ color: pal.trunk });

  // conifers (pine, spruce, spruceSnow, cypress)
  for (const [type, hFol, rFol, hTrunk, snowy] of [
    ["pine", 4.6, 1.7, 1.6, false],
    ["spruce", 5.6, 1.5, 1.0, false],
    ["spruceSnow", 5.4, 1.6, 1.0, true],
    ["cypress", 4.8, 0.9, 0.5, false],
  ]) {
    const items = byType[type];
    if (!items) continue;
    const foliageGeo = new THREE.ConeGeometry(rFol, hFol, 6);
    foliageGeo.translate(0, hTrunk + hFol / 2, 0);
    instancedColored(foliageGeo, items,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.rotation.set(0, it.rot, 0); d.scale.setScalar(it.sc); },
      (it, k) => snowy
        ? new THREE.Color(0xe8eef2).lerp(foliageCols[k % 3], 0.35 + (k % 5) * 0.06)
        : foliageCols[k % 3].clone().multiplyScalar(0.9 + (k % 7) * 0.04));
    const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, hTrunk + 0.4, 5);
    trunkGeo.translate(0, hTrunk / 2, 0);
    instanced(trunkGeo, trunkMat, items,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.rotation.set(0, it.rot, 0); d.scale.setScalar(it.sc); });
  }

  // round-canopy trees (birch, blob, olive)
  for (const [type, hT, rC, squash] of [
    ["birch", 2.6, 1.5, 1.0],
    ["blob", 1.6, 2.0, 0.9],
    ["olive", 1.2, 1.8, 0.72],
  ]) {
    const items = byType[type];
    if (!items) continue;
    const canGeo = new THREE.IcosahedronGeometry(rC, 0);
    canGeo.scale(1, squash, 1);
    canGeo.translate(0, hT + rC * squash * 0.7, 0);
    instancedColored(canGeo, items,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.rotation.set(0, it.rot, 0); d.scale.setScalar(it.sc); },
      (it, k) => foliageCols[k % 3].clone().multiplyScalar(0.92 + (k % 5) * 0.05));
    const trGeo = new THREE.CylinderGeometry(0.12, 0.18, hT + 0.3, 5);
    trGeo.translate(0, hT / 2, 0);
    instanced(trGeo, type === "birch" ? new THREE.MeshLambertMaterial({ color: 0xd8d8d0 }) : trunkMat, items,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.rotation.set(0, it.rot, 0); d.scale.setScalar(it.sc); });
  }

  // bushes / shrubs
  for (const type of ["bush", "shrub"]) {
    const items = byType[type];
    if (!items) continue;
    const g = new THREE.IcosahedronGeometry(0.8, 0);
    g.scale(1, 0.7, 1); g.translate(0, 0.5, 0);
    instancedColored(g, items,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.rotation.set(0, it.rot, 0); d.scale.setScalar(it.sc); },
      (it, k) => foliageCols[k % 3].clone().multiplyScalar(1.02 + (k % 4) * 0.04));
  }

  // cactus
  if (byType.cactus) {
    const g = new THREE.CylinderGeometry(0.28, 0.34, 2.4, 6);
    g.translate(0, 1.2, 0);
    instanced(g, new THREE.MeshLambertMaterial({ color: 0x4f7a3d }), byType.cactus,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.rotation.set(0, it.rot, 0); d.scale.setScalar(it.sc); });
  }

  // rocks
  for (const [type, col] of [["rock", pal.rock], ["rockRed", 0xa8825c], ["boulder", pal.rock]]) {
    const items = byType[type];
    if (!items) continue;
    const g = new THREE.IcosahedronGeometry(0.85, 0);
    g.scale(1.25, 0.8, 1);
    g.translate(0, 0.32, 0);
    instancedColored(g, items,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.rotation.set(0, it.rot, it.rot * 0.3); d.scale.setScalar(it.sc); },
      (it, k) => new THREE.Color(col).multiplyScalar(0.88 + (k % 6) * 0.05));
  }

  // poles and posts
  if (byType.snowpole) {
    const g = new THREE.CylinderGeometry(0.05, 0.05, 1.5, 4);
    g.translate(0, 0.75, 0);
    instanced(g, new THREE.MeshLambertMaterial({ color: 0xe07830 }), byType.snowpole,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.rotation.set(0, 0, 0); d.scale.setScalar(1); });
  }
  if (byType.post) {
    const g = new THREE.CylinderGeometry(0.09, 0.09, 1.1, 5);
    g.translate(0, 0.55, 0);
    instanced(g, new THREE.MeshLambertMaterial({ color: 0xc84040 }), byType.post,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.scale.setScalar(it.sc); });
  }

  // barriers / walls / snow walls
  if (byType.barrier) {
    const g = new THREE.BoxGeometry(0.9, 0.62, 0.16);
    g.translate(0, 0.5, 0);
    instanced(g, new THREE.MeshLambertMaterial({ color: 0xd8dcdd }), byType.barrier,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.rotation.set(0, it.rot, 0); });
  }
  if (byType.wall) {
    const g = new THREE.BoxGeometry(1.4, 0.85, 0.45);
    g.translate(0, 0.42, 0);
    instancedColored(g, byType.wall,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.rotation.set(0, it.rot, 0); },
      (it, k) => new THREE.Color(0xb8ac92).multiplyScalar(0.9 + (k % 4) * 0.06));
  }
  if (byType.snowwall) {
    const g = new THREE.BoxGeometry(1.3, 0.8, 0.8);
    g.translate(0, 0.35, 0);
    instanced(g, new THREE.MeshLambertMaterial({ color: 0xf2f6f9 }), byType.snowwall,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.rotation.set(0, it.rot, 0); d.scale.setScalar(it.sc); });
  }

  // houses
  if (byType.house) {
    const wallGeo = new THREE.BoxGeometry(6.4, 3.0, 5.2);
    wallGeo.translate(0, 1.5, 0);
    instancedColored(wallGeo, byType.house,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.rotation.set(0, it.rot, 0); d.scale.setScalar(it.sc); },
      (it, k) => new THREE.Color([0xe8e0d0, 0xd8c8b0, 0xe0d4c4, 0xc8b8a0][k % 4]));
    const roofGeo = new THREE.ConeGeometry(4.6, 1.9, 4);
    roofGeo.rotateY(Math.PI / 4);
    roofGeo.translate(0, 3.9, 0);
    instancedColored(roofGeo, byType.house,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.rotation.set(0, it.rot, 0); d.scale.setScalar(it.sc); },
      (it, k) => new THREE.Color([0xa05038, 0x8a4632, 0x96503c][k % 3]));
  }

  // spectators: body capsule + head, bright jackets
  if (byType.spectator) {
    const bodyGeo = new THREE.CylinderGeometry(0.22, 0.26, 1.05, 6);
    bodyGeo.translate(0, 0.62, 0);
    const jacket = [0xe04838, 0x3868c8, 0xe8b028, 0x38a058, 0xd868b8, 0xe87828];
    instancedColored(bodyGeo, byType.spectator,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.rotation.set(0, it.rot, 0); d.scale.setScalar(it.sc); },
      (it, k) => new THREE.Color(jacket[k % jacket.length]));
    const headGeo = new THREE.SphereGeometry(0.16, 6, 5);
    headGeo.translate(0, 1.32, 0);
    instancedColored(headGeo, byType.spectator,
      (it, d) => { d.position.set(it.x, it.y, it.z); d.scale.setScalar(it.sc); },
      (it, k) => new THREE.Color(0xe0b090).multiplyScalar(0.85 + (k % 4) * 0.07));
  }

  // start / finish arches
  for (const it of stage.scenery) {
    if (it.t !== "startArch" && it.t !== "finishArch") continue;
    const grp = new THREE.Group();
    const hw = (it.hw || 4) + 1.4;
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xdddddd });
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4.6, 6), poleMat);
      pole.position.set(0, 2.3, side * hw);
      grp.add(pole);
    }
    const isStart = it.t === "startArch";
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.9, hw * 2),
      [
        new THREE.MeshBasicMaterial({ map: bannerTexture(isStart ? "START" : "FINISH", isStart ? "#c8281e" : "#111", "#fff") }),
        new THREE.MeshBasicMaterial({ map: bannerTexture(isStart ? "START" : "FINISH", isStart ? "#c8281e" : "#111", "#fff") }),
        new THREE.MeshBasicMaterial({ color: 0x999999 }),
        new THREE.MeshBasicMaterial({ color: 0x999999 }),
        new THREE.MeshBasicMaterial({ map: bannerTexture(isStart ? "START" : "FINISH", isStart ? "#c8281e" : "#111", "#fff"), }),
        new THREE.MeshBasicMaterial({ map: bannerTexture(isStart ? "START" : "FINISH", isStart ? "#c8281e" : "#111", "#fff"), }),
      ]
    );
    // orient the banner across the road: box's long axis is Z, rotate to heading
    banner.position.set(0, 4.35, 0);
    grp.add(banner);
    grp.position.set(it.x, it.y, it.z);
    grp.rotation.y = -it.rot;
    scene.add(grp);
  }

  // ---- the car
  let ghostPitch = 0;
  const { carGroup, wheels, bodyGroup, pods } = buildCar(false);
  scene.add(carGroup);

  /* ---- headlights
   *
   * Only when the hour needs them. Two spot lights rather than one so the
   * beams splay either side of the nose and give the road some shape; shadows
   * are left off, which is what keeps this affordable.
   *
   * Both the lights and their aim point are children of carGroup, so they
   * inherit the car's transform and need no per-frame updates at all - a
   * SpotLight only requires that its target be somewhere in the scene graph.
   */
  if (pal.headlights) {
    const aim = new THREE.Object3D();
    aim.position.set(34, -2.5, 0);          // well down the road, slightly low
    carGroup.add(aim);

    // Dimmer at dusk than at midnight: at sunset they read as running lights
    // against a sky that is still bright, and cranking them up just blows out
    // the road surface.
    const night = stage.timeOfDay === "night";
    const power = night ? 130 : 48;

    for (const side of [0.62, -0.62]) {
      const lamp = new THREE.SpotLight(0xfff2d0, power, night ? 92 : 55, 0.46, 0.45, 1.1);
      lamp.position.set(2.25, 0.62, side);
      lamp.target = aim;
      carGroup.add(lamp);
    }

    /* The lamp lenses themselves are Lambert like the rest of the body, so
     * they go dark exactly when they are supposed to look lit. Swap them for
     * an unlit material so they read as emitting rather than reflecting. */
    if (pods) pods.material = new THREE.MeshBasicMaterial({ color: night ? 0xfff6d8 : 0xffeeb8 });
  }
  const ghost = buildCar(true);
  ghost.carGroup.visible = false;
  scene.add(ghost.carGroup);

  // contact shadows
  const blobTex = blobTexture();
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(3.6, 2.2),
    new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  scene.add(shadow);

  // ---- dust particles
  const DUST_N = quality === "low" ? 120 : 260;
  const dust = {
    n: DUST_N, idx: 0,
    pos: new Float32Array(DUST_N * 3),
    vel: new Float32Array(DUST_N * 3),
    life: new Float32Array(DUST_N),
    points: null,
  };
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(dust.pos, 3));
    const isSnow = stage.env.id === "sweden";
    const isTarmac = stage.surfKey.indexOf("tarmac") === 0;
    const base = isSnow ? 0xeef4f8 : isTarmac ? 0x8a8a88 : new THREE.Color(pal.road).multiplyScalar(1.06).getHex();
    // Points ignore lights, so without this the dust stays at noon brightness
    // and turns into glowing orbs after dark.
    const col = new THREE.Color(base).multiplyScalar(pal.unlitDim).getHex();
    dust.points = new THREE.Points(g, new THREE.PointsMaterial({
      color: col, size: 0.85, map: puffTexture(), transparent: true, opacity: 0.4,
      depthWrite: false, sizeAttenuation: true,
    }));
    dust.points.frustumCulled = false;
    for (let i = 0; i < DUST_N; i++) dust.pos[i * 3 + 1] = -100;
    scene.add(dust.points);
  }

  // ---- precipitation
  let precip = null;
  if (stage.weatherId === "rain" || stage.weatherId === "snowfall") {
    const N = quality === "low" ? 300 : 700;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 60;
      pos[i * 3 + 1] = Math.random() * 30;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 60;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const snow = stage.weatherId === "snowfall";
    precip = {
      n: N, pos,
      snow,
      points: new THREE.Points(g, new THREE.PointsMaterial({
        // unlit, like the dust - dimmed to the hour for the same reason
        color: new THREE.Color(snow ? 0xffffff : 0x9fb4c8).multiplyScalar(pal.unlitDim).getHex(),
        size: snow ? 0.4 : 0.2,
        map: puffTexture(), transparent: true, opacity: snow ? 0.9 : 0.55, depthWrite: false,
      })),
    };
    precip.points.frustumCulled = false;
    scene.add(precip.points);
  }

  return {
    scene, pal, carGroup, bodyGroup, wheels, ghost, shadow, dust, precip,
    updateCar, updateGhost, spawnDust, updateParticles,
  };

  /* ------------------------------------------------- per-frame updaters */

  function updateCar(car, steerVisual, dt) {
    const step = dt > 0 ? Math.min(0.05, dt) : 1 / 60;
    const bodyY = car.contactOK ? car.bodyY : car.y;
    carGroup.position.set(car.x, bodyY, car.z);
    carGroup.rotation.set(0, -car.yaw, 0);
    /* Nose-up and right-side-up are positive. Both used to be negated here,
     * so the car leaned into the hill it was descending and its front wheels
     * hung a wheelbase of slope clear of the road - the steeper the descent,
     * the worse it looked, because the error is twice the grade. */
    bodyGroup.rotation.set(-car.roll, 0, car.pitch);

    const sinP = Math.sin(car.pitch), cosP = Math.cos(car.pitch);
    const sinR = Math.sin(car.roll), cosR = Math.cos(car.roll);
    const up = Math.max(0.4, cosP * cosR);
    const spin = (car.vx / CAR.wheelR) * step;
    const k = 1 - Math.exp(-step * 26);
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      w.mesh.rotation.z -= spin;
      if (w.front) w.pivot.rotation.y = -steerVisual * 0.9;
      /* Drop each hub onto the ground beneath it. A body point (x, y, z) is
       * drawn at world height bodyY + (x sinP + y cosP) cosR + z sinR, so
       * solving that for y gives the local height that stands this tyre on
       * its own contact patch; the body keeps the averaged plane and the
       * springs absorb the difference. */
      let t = 0;
      if (car.airborne) t = -SUS_DOWN * 0.55;          // wheels hang in flight
      else if (car.contactOK) {
        const want = car.contact[i] + CAR.wheelR;
        const local = (want - bodyY - w.x * sinP * cosR - w.z * sinR) / up;
        t = Math.max(-SUS_DOWN, Math.min(SUS_UP, local - CAR.wheelR));
      }
      w.travel += (t - w.travel) * k;
      w.pivot.position.y = CAR.wheelR + w.travel;
    }
    const g = stage.groundHeight(car.x, car.z, car.s);
    if (g) {
      shadow.position.set(car.x, g.y + 0.06, car.z);
      shadow.rotation.z = -car.yaw;
      const h = Math.max(0, car.y - g.y);
      const k = Math.max(0.25, 1 - h * 0.22);
      shadow.scale.setScalar(k);
      shadow.material.opacity = k;
    }
  }

  function updateGhost(state, dt) {
    if (!state) { ghost.carGroup.visible = false; return; }
    ghost.carGroup.visible = true;
    ghost.carGroup.position.set(state.x, state.y, state.z);
    ghost.carGroup.rotation.set(0, -state.yaw, 0);
    /* A ghost frame is a pose, not a chassis - it stores no attitude at all.
     * Read one back off the ground under its axles so the replay climbs and
     * drops with the road instead of sliding down it flat. */
    const cosY = Math.cos(state.yaw), sinY = Math.sin(state.yaw);
    const gf = stage.groundHeight(state.x + cosY * CAR.a, state.z + sinY * CAR.a, state.s);
    const gr = stage.groundHeight(state.x - cosY * CAR.b, state.z - sinY * CAR.b, state.s);
    // clear of the ground by more than the suspension can reach: it is flying
    const flying = !gf || !gr || state.y - Math.max(gf.y, gr.y) > 0.55;
    const target = flying ? ghostPitch * 0.94 : Math.atan((gf.y - gr.y) / (CAR.a + CAR.b));
    ghostPitch += (target - ghostPitch) * (1 - Math.exp(-(dt > 0 ? Math.min(0.05, dt) : 1 / 60) * 12));
    ghost.bodyGroup.rotation.set(0, 0, ghostPitch);
  }

  function spawnDust(car, amount) {
    const cosY = Math.cos(car.yaw), sinY = Math.sin(car.yaw);
    for (let k = 0; k < amount; k++) {
      const i = dust.idx = (dust.idx + 1) % dust.n;
      const side = k % 2 === 0 ? 1 : -1;
      // behind each rear wheel
      const bx = car.x - cosY * 1.5 - sinY * 0.7 * side;
      const bz = car.z - sinY * 1.5 + cosY * 0.7 * side;
      dust.pos[i * 3] = bx; dust.pos[i * 3 + 1] = car.y + 0.25; dust.pos[i * 3 + 2] = bz;
      dust.vel[i * 3] = -cosY * car.vx * 0.12 + (Math.random() - 0.5) * 1.6;
      dust.vel[i * 3 + 1] = 1.1 + Math.random() * 1.7;
      dust.vel[i * 3 + 2] = -sinY * car.vx * 0.12 + (Math.random() - 0.5) * 1.6;
      dust.life[i] = 0.7 + Math.random() * 0.5;
    }
  }

  function updateParticles(dt, camPos) {
    for (let i = 0; i < dust.n; i++) {
      if (dust.life[i] <= 0) continue;
      dust.life[i] -= dt;
      if (dust.life[i] <= 0) { dust.pos[i * 3 + 1] = -100; continue; }
      dust.pos[i * 3] += dust.vel[i * 3] * dt;
      dust.pos[i * 3 + 1] += dust.vel[i * 3 + 1] * dt;
      dust.pos[i * 3 + 2] += dust.vel[i * 3 + 2] * dt;
      dust.vel[i * 3 + 1] -= 1.4 * dt;
    }
    dust.points.geometry.attributes.position.needsUpdate = true;

    if (precip) {
      const fall = precip.snow ? 3.2 : 22;
      const drift = precip.snow ? 1.1 : 0.3;
      for (let i = 0; i < precip.n; i++) {
        precip.pos[i * 3 + 1] -= fall * (0.7 + (i % 5) * 0.12) * dt;
        precip.pos[i * 3] += drift * dt * Math.sin(i);
        if (precip.pos[i * 3 + 1] < -2) {
          precip.pos[i * 3] = (Math.random() - 0.5) * 60;
          precip.pos[i * 3 + 1] = 26 + Math.random() * 6;
          precip.pos[i * 3 + 2] = (Math.random() - 0.5) * 60;
        }
      }
      precip.points.position.set(camPos.x, camPos.y - 12, camPos.z);
      precip.points.geometry.attributes.position.needsUpdate = true;
    }
  }
}

/* --------------------------------------------------------------- the car */

function buildCar(isGhost) {
  const carGroup = new THREE.Group();
  const bodyGroup = new THREE.Group();
  carGroup.add(bodyGroup);

  function mat(color) {
    if (isGhost) {
      return new THREE.MeshLambertMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.32, depthWrite: false });
    }
    return new THREE.MeshLambertMaterial({ color });
  }

  const livery = 0xe8e4dc;      // off-white body
  const accent = 0xc8281e;      // red stripes
  const dark = 0x1c2026;

  // lower body
  const body = new THREE.Mesh(new THREE.BoxGeometry(3.85, 0.5, 1.68), mat(livery));
  body.position.y = 0.5;
  bodyGroup.add(body);
  // nose taper
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.34, 1.5), mat(livery));
  nose.position.set(2.05, 0.44, 0);
  bodyGroup.add(nose);
  // cabin
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.52, 1.42), mat(livery));
  cabin.position.set(-0.25, 1.0, 0);
  bodyGroup.add(cabin);
  // windows: slightly larger dark box inset
  const glass = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.38, 1.46), mat(dark));
  glass.position.set(-0.22, 1.02, 0);
  bodyGroup.add(glass);
  // stripes
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.14, 0.5), mat(accent));
  stripe.position.set(0, 0.78, 0);
  bodyGroup.add(stripe);
  const stripeSide1 = new THREE.Mesh(new THREE.BoxGeometry(3.87, 0.12, 1.7), mat(accent));
  stripeSide1.position.set(0, 0.34, 0);
  bodyGroup.add(stripeSide1);
  // spoiler
  const wing = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.08, 1.5), mat(accent));
  wing.position.set(-1.95, 1.06, 0);
  bodyGroup.add(wing);
  const winglet1 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.26, 0.08), mat(dark));
  winglet1.position.set(-1.9, 0.9, 0.5);
  bodyGroup.add(winglet1);
  const winglet2 = winglet1.clone();
  winglet2.position.z = -0.5;
  bodyGroup.add(winglet2);
  // light pods
  const pods = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.16, 1.0), mat(0xfff4c8));
  pods.position.set(2.32, 0.62, 0);
  bodyGroup.add(pods);
  // returned so the world can light them up when the hour is dark

  /* Wheels: parent pivots so the fronts can steer and each corner can take
   * up its own suspension travel. They sit on the physics axles (CAR.a/CAR.b
   * out from the CG, which is where this group's origin is), so the plane the
   * body is drawn on is the plane the contact patches actually describe.
   * Order matches car.contact: front +d, front -d, rear +d, rear -d. */
  const wheels = [];
  const wheelGeo = new THREE.CylinderGeometry(CAR.wheelR, CAR.wheelR, 0.28, 10);
  wheelGeo.rotateX(Math.PI / 2);
  for (const [wx, wz, front] of [
    [CAR.a, CAR.halfTrack, true], [CAR.a, -CAR.halfTrack, true],
    [-CAR.b, CAR.halfTrack, false], [-CAR.b, -CAR.halfTrack, false],
  ]) {
    const pivot = new THREE.Group();
    pivot.position.set(wx, CAR.wheelR, wz);
    const wheel = new THREE.Mesh(wheelGeo, mat(0x14161a));
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.3, 8), mat(0xb8b4a8));
    hub.rotation.x = Math.PI / 2;
    pivot.add(wheel);
    pivot.add(hub);
    // on bodyGroup, not carGroup: the body carries the roll/pitch attitude, and
    // wheels parented to carGroup stayed flat while it leaned, so they visibly
    // came away from the arches
    bodyGroup.add(pivot);
    wheels.push({ mesh: wheel, pivot, front, x: wx, z: wz, travel: 0 });
  }

  return { carGroup, bodyGroup, wheels, pods };
}
