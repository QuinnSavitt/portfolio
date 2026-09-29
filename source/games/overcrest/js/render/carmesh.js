/* Overcrest — the Kestrel, in geometry.
 *
 * A boxy five-door rally hatch built from primitives: wide arches, a squat
 * stance, round spot lamps, a proper wing. Cream body with an amber-over-
 * charcoal chevron down the flanks — the "campfire" livery. Everything
 * low-poly and vertex-lit.
 *
 * Phase 14: the car tells its story. Damage arrives in stages (dents, a
 * dead lamp, a cracked screen, a bonnet that will not quite latch, and
 * finally the bumper stays behind on some rock), mud gathers on the lower
 * panels and dries to dust, and a handful of souvenirs bolt something
 * visible on. All of it cheap — a few materials, a few hidden boxes — and
 * all of it reversible, because a full service undoes what it can.
 */

import * as THREE from "three";
import { WHEELS, KESTREL } from "../sim/physics.js";
import { bodyEuler, wheelLift } from "./stance.js";
import { findDef } from "../game/souvenirs.js";

/* 2026-08-31 (Quinn: "souvenirs should cause visual changes to the car"):
 * the bolt-on set grew from eleven to thirty-odd. Rule kept: only the
 * obviously physical souvenirs show — racks, boards, cans, a snorkel, a
 * flag, springs you can see in the ride height, tyres you can see in the
 * hubs, glass that changes colour — never the charms and papers. */

export const LIVERY = {
  body: 0xe9e2cf,      // warm cream
  accent: 0xffb454,    // overcrest amber
  dark: 0x2b2e33,      // charcoal
  glass: 0x1a2126,
  lamp: 0xfff3c4,
  tail: 0xd2452e,
  tyre: 0x191c1f,
  hub: 0xc9c2b0,
};

const MUD_WET = 0x4c3d2c;    // fresh spatter
const MUD_DRY = 0x9b8a6b;    // dried to dust
const SCUFF = 0x8f8a7c;      // scratched-through paint
const DEAD_LAMP = 0x3a3a35;  // a lamp with nothing behind it

export function buildKestrel() {
  const root = new THREE.Group();       // positioned/yawed per frame
  const body = new THREE.Group();       // carries pitch/roll
  root.add(body);

  const mats = {};
  function mat(c) {
    if (!mats[c]) mats[c] = new THREE.MeshLambertMaterial({ color: c });
    return mats[c];
  }
  /* Lower panels get their OWN materials so mud can tint them without
   * muddying the roof: the world splashes upward, not down. */
  const lowDark = new THREE.MeshLambertMaterial({ color: LIVERY.dark });
  const tyreMat = new THREE.MeshLambertMaterial({ color: LIVERY.tyre });
  /* the hubs and the glass get their OWN materials: studs re-shoe the
   * wheels, aurora glass re-tints the screen (applyBuild) */
  const hubMat = new THREE.MeshLambertMaterial({ color: LIVERY.hub });
  const glassMat = new THREE.MeshLambertMaterial({ color: LIVERY.glass });
  const fogLampMat = new THREE.MeshLambertMaterial({ color: 0xffb040, emissive: 0x3a2200 });
  function box(w, h, d, c, x, y, z, useMat) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), useMat || mat(c));
    m.position.set(x, y, z);
    body.add(m);
    return m;
  }

  // stance: x forward, y up, z right. Wheelbase 2.5, track 1.52.
  /* THE BODY (2026-08-31, Quinn: "we need a better, cleaner car model").
   * One side profile, extruded across the width — nose, bonnet, the rake
   * of the screen, the roof, the hatch, the tail — so the silhouette is a
   * car's and not a stack of boxes. The greenhouse is a second, darker
   * profile wrapped just proud of the pillars (side glass, screen and
   * backlight in one band), and every decal lies FLUSH on the flank
   * instead of floating beside it. Same footprint as before (3.8 m long,
   * 1.66 wide, roof at 1.32) so the lamps, the wing and thirty bolt-ons
   * still land where they were. */
  const W = 1.66;
  const outline = (pts) => {
    const sh = new THREE.Shape();
    sh.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
    sh.closePath();
    return sh;
  };
  const slab = (pts, width, useMat) => {
    const g = new THREE.ExtrudeGeometry(outline(pts), { depth: width, bevelEnabled: false });
    g.translate(0, 0, -width / 2);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, useMat);
    body.add(m);
    return m;
  };
  /* the shell: clockwise from the nose's foot. The wheel arches are cut
   * INTO the outline (an arc of six points over each axle), so from the
   * side there is a real opening with a tyre in it, not a box over a box. */
  const arch = (cx, r) => {
    const out = [];
    for (let k = 0; k <= 6; k++) {
      const th = Math.PI - (k / 6) * Math.PI;       // 180° → 0°, over the top
      out.push([cx + Math.cos(th) * r, 0.28 + Math.sin(th) * r]);
    }
    return out;
  };
  slab([
    [2.06, 0.30], [2.10, 0.46], [2.08, 0.62], [1.98, 0.74],   // nose
    [1.20, 0.86], [0.62, 0.90],                               // bonnet
    [0.28, 1.26], [0.02, 1.32],                               // screen rake to roof
    [-1.02, 1.32], [-1.22, 1.28],                             // roof
    [-1.58, 0.94], [-1.70, 0.76],                             // hatch rake
    [-1.74, 0.46], [-1.72, 0.30],                             // tail
    ...arch(-KESTREL.b, 0.36),                                // rear arch
    [-0.98, 0.26], [0.76, 0.26],                              // floor line
    ...arch(KESTREL.a, 0.36),                                 // front arch
    [1.54, 0.26],
  ], W, mat(LIVERY.body));
  // the greenhouse: a dark band proud of the shell on every side
  slab([
    [0.68, 0.92], [0.34, 1.25], [-1.28, 1.25], [-1.64, 0.92],
  ], W + 0.02, glassMat);
  // B-pillars, so the band reads as glass between posts
  for (const side of [-1, 1]) box(0.06, 0.34, 0.02, LIVERY.body, -0.46, 1.08, side * 0.845);
  // rocker panels: the dark sills, proud of the shell
  box(2.2, 0.16, 1.7, null, 0.0, 0.3, 0, lowDark);
  /* the bonnet is its own plate on the shell's slope, so damage can pop
   * it: laid at the bonnet's angle, base rotation kept for the flutter */
  const bonnet = box(0.92, 0.03, 1.5, LIVERY.body, 1.22, 0.885, 0);
  bonnet.rotation.z = -0.15;
  const splitter = box(0.62, 0.1, 1.7, null, 1.88, 0.3, 0, lowDark);
  // roof vent scoop
  box(0.42, 0.12, 0.5, LIVERY.dark, 0.05, 1.36, 0);
  // wing on twin uprights, planted on the hatch
  box(0.1, 0.36, 0.1, LIVERY.dark, -1.62, 1.0, 0.5);
  box(0.1, 0.36, 0.1, LIVERY.dark, -1.62, 1.0, -0.5);
  const wing = box(0.36, 0.07, 1.56, LIVERY.accent, -1.66, 1.2, 0);
  /* Fender flares (over the axles the sim actually uses). Each flare has
   * its OWN material: the mud on an arch comes from ITS wheel, so a car
   * that ran the right verge is dirty down one side only. */
  const flareMats = WHEELS.map(() => new THREE.MeshLambertMaterial({ color: LIVERY.body }));
  WHEELS.forEach((w, i) => {
    // an eyebrow over the arch, proud of the flank; the opening stays open
    box(0.92, 0.1, 0.2, null, w.px, 0.68, w.py + Math.sign(w.py) * 0.1, flareMats[i]);
    box(0.14, 0.34, 0.2, null, w.px - 0.4, 0.44, w.py + Math.sign(w.py) * 0.1, flareMats[i]);
    box(0.14, 0.34, 0.2, null, w.px + 0.4, 0.44, w.py + Math.sign(w.py) * 0.1, flareMats[i]);
  });
  // livery chevrons down each flank: thin plates, flush, inside the beltline
  for (const side of [-1, 1]) {
    const a = box(0.7, 0.22, 0.012, LIVERY.accent, 0.45, 0.58, side * 0.838);
    a.rotation.z = -0.35;
    const b = box(0.7, 0.22, 0.012, LIVERY.dark, -0.12, 0.58, side * 0.838);
    b.rotation.z = -0.35;
    const c = box(0.7, 0.16, 0.012, LIVERY.accent, -0.66, 0.58, side * 0.838);
    c.rotation.z = -0.35;
  }
  // bumper accent + tow hook
  const bumper = box(0.1, 0.12, 0.5, LIVERY.accent, 2.12, 0.42, 0);
  /* Round spot lamps (the face of the car). Each lamp is its own mesh so
   * one can DIE: the shared live material glows with the headlights, a
   * dead lamp swaps to inert dark glass. Deliberately a fixed order —
   * outer left first, then inner right — the same car every time. */
  const lampLive = new THREE.MeshLambertMaterial({ color: LIVERY.lamp });
  const lampDead = new THREE.MeshLambertMaterial({ color: DEAD_LAMP });
  const lampGeo = new THREE.CylinderGeometry(0.11, 0.13, 0.1, 10);
  lampGeo.rotateZ(Math.PI / 2);
  const lampMeshes = [];
  for (const z of [-0.52, -0.2, 0.2, 0.52]) {
    const lamp = new THREE.Mesh(lampGeo, lampLive);
    lamp.position.set(2.09, 0.66, z);
    body.add(lamp);
    lampMeshes.push(lamp);
  }
  // tail lights
  box(0.06, 0.12, 0.4, LIVERY.tail, -1.73, 0.68, 0.55);
  box(0.06, 0.12, 0.4, LIVERY.tail, -1.73, 0.68, -0.55);
  // mudflaps: just behind each wheel, and each wearing that wheel's dirt
  const flapMats = WHEELS.map(() => new THREE.MeshLambertMaterial({ color: LIVERY.dark }));
  WHEELS.forEach((w, i) => {
    box(0.08, 0.3, 0.3, null, w.px - 0.36, 0.26, w.py + Math.sign(w.py) * 0.04, flapMats[i]);
  });

  /* Damage-stage dressing, built now and hidden: dents where hits land,
   * a cracked screen. Cheap boxes; condition decides what shows. */
  const dents = [
    box(0.3, 0.18, 0.05, SCUFF, 1.8, 0.55, -0.845),
    box(0.5, 0.2, 0.05, SCUFF, 0.1, 0.64, 0.85),
    box(0.35, 0.22, 0.05, SCUFF, -1.4, 0.6, -0.85),
  ];
  /* The cracked screen has its own material so night can make it GLARE —
   * a crack is a scratch by day and a nuisance when the lights are on. */
  const crackMat = new THREE.MeshLambertMaterial({ color: 0xdfe9ea });
  const crack = [
    box(0.02, 0.3, 0.045, null, 0.63, 0.98, 0.12, crackMat),
    box(0.02, 0.045, 0.5, null, 0.63, 0.99, 0.06, crackMat),
  ];
  crack[0].rotation.x = 0.5;
  crack[1].rotation.x = -0.2;
  for (const d of dents.concat(crack)) d.visible = false;
  // the glint: a small additive star seated on the crack, lit by effects.js
  const glintMat = new THREE.MeshBasicMaterial({
    color: 0xeaf4ff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const crackGlare = new THREE.Group();
  for (const a of [0, 1.05, 2.1]) {
    const q = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.05), glintMat);
    q.position.set(0.635, 1.0, 0.09);
    q.rotation.y = Math.PI / 2;
    q.rotation.z = a;
    q.renderOrder = 3;
    crackGlare.add(q);
  }
  crackGlare.visible = false;
  body.add(crackGlare);

  /* Wheels on steering pivots, hung at the sim's own contact points. Each
   * pivot carries its own vertical travel (see updateKestrel) — the body
   * rides its springs, the rubber stays on the deck. */
  const wheels = [];
  const R = KESTREL.wheelR;
  const tyreGeo = new THREE.CylinderGeometry(R, R, 0.26, 12);
  tyreGeo.rotateX(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(R * 0.46, R * 0.46, 0.27, 8);
  hubGeo.rotateX(Math.PI / 2);
  for (const w of WHEELS) {
    const pivot = new THREE.Group();
    pivot.position.set(w.px, R, w.py);
    const tyre = new THREE.Mesh(tyreGeo, tyreMat);
    const hub = new THREE.Mesh(hubGeo, hubMat);
    pivot.add(tyre, hub);
    body.add(pivot);
    wheels.push({ pivot, tyre, front: w.front, px: w.px, pz: w.py });
  }

  /* ---------------------------------------------------------- build addons
   * A few souvenirs change the car you are looking at. With restraint —
   * the bible's word — so the unusual ones stay special: bolt-ons for the
   * obviously physical souvenirs, nothing for the charms and papers. */
  const addons = {};
  const addonGroup = (id) => {
    const g = new THREE.Group();
    g.visible = false;
    body.add(g);
    addons[id] = g;
    return g;
  };
  const abox = (g, w, h, d, c, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c));
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  {   // Mud Flaps (part): proper rally flaps, amber-trimmed
    const g = addonGroup("mud-flaps");
    for (const w of WHEELS) {
      const z = w.py + Math.sign(w.py) * 0.04;
      abox(g, 0.09, 0.34, 0.36, LIVERY.dark, w.px - 0.42, 0.22, z);
      abox(g, 0.09, 0.06, 0.36, LIVERY.accent, w.px - 0.42, 0.07, z);
    }
  }
  {   // Moth Lantern: a roof light pod — it glows with the headlights
    const g = addonGroup("moth-lantern");
    abox(g, 0.14, 0.08, 0.92, LIVERY.dark, -0.02, 1.35, 0);
    const small = new THREE.CylinderGeometry(0.07, 0.08, 0.09, 8);
    small.rotateZ(Math.PI / 2);
    for (const z of [-0.3, 0, 0.3]) {
      const l = new THREE.Mesh(small, lampLive);
      l.position.set(0.08, 1.38, z);
      g.add(l);
    }
  }
  {   // Storm Chaser: a whip antenna, leaned back by the wind it hunts
    const g = addonGroup("storm-chaser");
    const whip = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.02, 0.95, 5), mat(LIVERY.dark));
    whip.position.set(-1.32, 1.5, -0.62);
    whip.rotation.z = 0.16;
    g.add(whip);
    abox(g, 0.09, 0.05, 0.09, LIVERY.dark, -1.25, 1.27, -0.62);
  }
  {   // Tail Dancer: the ribbon on the wing — it flutters at speed
    const g = addonGroup("tail-dancer");
    const r1 = abox(g, 0.22, 0.02, 0.08, LIVERY.accent, -1.82, 1.19, 0.68);
    const r2 = abox(g, 0.18, 0.02, 0.07, LIVERY.tail, -1.98, 1.17, 0.7);
    g.userData.ribbon = [r1, r2];
  }
  {   // Red Line Ribbon: tape straight over the brake lights
    const g = addonGroup("red-line-ribbon");
    abox(g, 0.05, 0.1, 1.3, LIVERY.tail, -1.74, 0.72, 0);
  }
  {   // Patchwork Plating: panels off three other cars, none matching
    const g = addonGroup("patchwork-plating");
    abox(g, 0.55, 0.4, 0.05, 0x76828e, -0.5, 0.62, -0.85);
    abox(g, 0.4, 0.03, 0.5, 0x9aa1a6, 1.3, 0.885, -0.3);
    abox(g, 0.4, 0.3, 0.05, 0x5d6668, -1.2, 0.6, 0.85);
  }
  {   // Scrapheart: one faded blue wing that clearly lived elsewhere
    const g = addonGroup("scrapheart");
    abox(g, 0.6, 0.32, 0.05, 0x6d7f95, 1.35, 0.56, 0.84);
  }
  {   // Rust Never Sleeps: it shows, low on the panels
    const g = addonGroup("rust-never-sleeps");
    abox(g, 0.3, 0.12, 0.05, 0x8a5a33, 1.2, 0.42, 0.83);
    abox(g, 0.4, 0.14, 0.05, 0x8a5a33, -0.8, 0.4, -0.84);
    abox(g, 0.5, 0.1, 0.05, 0x8a5a33, 0.5, 0.33, -0.86);
  }
  {   // Afterburner Coil: a fat tip that has seen colours it shouldn't
    const g = addonGroup("afterburner-coil");
    const tip = new THREE.CylinderGeometry(0.07, 0.075, 0.24, 8);
    tip.rotateZ(Math.PI / 2);
    const t = new THREE.Mesh(tip, mat(0x4a4d52));
    t.position.set(-1.8, 0.3, -0.5);
    g.add(t);
    const glow = new THREE.CylinderGeometry(0.05, 0.05, 0.05, 8);
    glow.rotateZ(Math.PI / 2);
    const gm = new THREE.Mesh(glow, mat(LIVERY.accent));
    gm.position.set(-1.93, 0.3, -0.5);
    g.add(gm);
  }
  {   // Meridian Stone: a fine gold line the length of the car
    const g = addonGroup("meridian-stone");
    abox(g, 3.2, 0.03, 0.02, 0xd9b45a, 0, 0.76, 0.845);
    abox(g, 3.2, 0.03, 0.02, 0xd9b45a, 0, 0.76, -0.845);
  }
  /* ---- the 2026-08-31 set. Roof first: the rack, and the things that
   * ride on one. They are placed so that any combination stacks without
   * passing through each other — boards left/right of centre, the bottle
   * on the right rail, the hide under everything. */
  {   // Roof Rack: rails, crossbars, feet
    const g = addonGroup("roof-rack");
    for (const z of [-0.6, 0.6]) abox(g, 1.5, 0.05, 0.05, LIVERY.dark, -0.3, 1.36, z);
    for (const x of [-0.9, -0.3, 0.3]) abox(g, 0.05, 0.05, 1.28, LIVERY.dark, x, 1.36, 0);
    for (const x of [-0.95, 0.35]) for (const z of [-0.6, 0.6]) abox(g, 0.05, 0.08, 0.05, LIVERY.dark, x, 1.31, z);
  }
  {   // Recovery Boards: two orange traction boards strapped up top
    const g = addonGroup("recovery-boards");
    const a = abox(g, 1.1, 0.04, 0.24, 0xe8641e, -0.3, 1.42, -0.42);
    const b = abox(g, 1.1, 0.04, 0.24, 0xe8641e, -0.3, 1.42, 0.42);
    a.rotation.x = 0.06; b.rotation.x = -0.06;
  }
  {   // Reindeer Hide: a pelt over the roof, brown with a cream saddle
    const g = addonGroup("reindeer-hide");
    abox(g, 1.1, 0.05, 1.0, 0x7d5a3c, -0.32, 1.33, 0);
    abox(g, 0.5, 0.06, 0.6, 0xd9c7a8, -0.4, 1.34, 0.1);
  }
  {   // Tortoise Shell: a ribbed plate over the roof
    const g = addonGroup("tortoise-shell");
    abox(g, 1.3, 0.08, 1.3, 0x5a4a30, -0.32, 1.33, 0);
    for (const x of [-0.7, -0.32, 0.06]) abox(g, 0.04, 0.05, 1.2, 0x3e3220, x, 1.39, 0);
  }
  {   // Helium Bottle: a silver cylinder on the right rail, red band
    const g = addonGroup("helium-bottle");
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.62, 8), mat(0xc8ccd0));
    c.rotation.z = Math.PI / 2; c.position.set(-0.3, 1.46, 0.42); g.add(c);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.1, 8), mat(0xb03030));
    band.rotation.z = Math.PI / 2; band.position.set(-0.52, 1.46, 0.42); g.add(band);
  }
  {   // Field Hospital: a red cross on the roof
    const g = addonGroup("field-hospital");
    abox(g, 0.5, 0.02, 0.16, 0xd8342a, -0.32, 1.335, 0);
    abox(g, 0.16, 0.02, 0.5, 0xd8342a, -0.32, 1.335, 0);
  }
  {   // The Open Road (fabled): one amber stripe the whole length of the car
    const g = addonGroup("the-open-road");
    const s1 = abox(g, 0.9, 0.02, 0.2, LIVERY.accent, 1.22, 0.905, 0); s1.rotation.z = -0.15;
    abox(g, 1.3, 0.02, 0.2, LIVERY.accent, -0.5, 1.335, 0);
    const s2 = abox(g, 0.42, 0.02, 0.2, LIVERY.accent, -1.42, 1.1, 0); s2.rotation.z = 0.76;
  }
  {   // Perpetual Motion (fabled): a gyroscope on the roof that never stops
    const g = addonGroup("perpetual-motion");
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.02, 6, 16), mat(0xd9b45a));
    r1.position.set(-0.32, 1.52, 0); g.add(r1);
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.02, 6, 16), mat(0xd9b45a));
    r2.position.set(-0.32, 1.52, 0); r2.rotation.y = Math.PI / 2; g.add(r2);
    abox(g, 0.04, 0.18, 0.04, LIVERY.dark, -0.32, 1.4, 0);
    g.userData.spin = [r1, r2];
  }
  {   // Bunting Season: little flags along the left roof edge
    const g = addonGroup("bunting-season");
    const cols = [LIVERY.tail, 0xf2ece0, LIVERY.accent, 0x3f7fbf, LIVERY.tail, 0xf2ece0];
    for (let k = 0; k < 6; k++) abox(g, 0.1, 0.08, 0.02, cols[k], -1.0 + k * 0.28, 1.34, -0.74);
  }
  // the back of the car: the hatch, the boot lid, the tailgate
  {   // Jerrycan Country: two cans on the tailgate, amber straps
    const g = addonGroup("jerrycan-country");
    for (const z of [-0.3, 0.3]) {
      abox(g, 0.18, 0.34, 0.3, 0x5b6b3a, -1.83, 0.9, z);
      abox(g, 0.2, 0.04, 0.32, LIVERY.accent, -1.83, 0.98, z);
    }
  }
  {   // Sandbags: two sacks lashed on the boot lid
    const g = addonGroup("sandbags");
    abox(g, 0.5, 0.16, 0.3, 0xc9b58a, -1.3, 1.24, -0.28);
    abox(g, 0.5, 0.16, 0.3, 0xbfa97c, -1.32, 1.24, 0.3);
  }
  {   // Grit Merchant: a yellow grit bin on the boot, left
    const g = addonGroup("grit-merchant");
    abox(g, 0.36, 0.28, 0.3, 0xe0b830, -1.32, 1.3, -0.42);
    abox(g, 0.38, 0.04, 0.32, LIVERY.dark, -1.32, 1.45, -0.42);
  }
  {   // Hi-Vis Jacket: draped over the hatch, reflective stripe and all
    const g = addonGroup("hi-vis-jacket");
    abox(g, 0.34, 0.06, 0.5, 0xd9ff2e, -1.46, 1.08, 0.3);
    abox(g, 0.36, 0.02, 0.08, 0xd8d8d8, -1.46, 1.12, 0.3);
  }
  {   // Grand Tour Sticker: an oval on the hatch glass
    const g = addonGroup("grand-tour-sticker");
    abox(g, 0.02, 0.14, 0.22, 0xf2ece0, -1.63, 0.92, -0.45);
    abox(g, 0.02, 0.06, 0.16, LIVERY.tail, -1.64, 0.92, -0.45);
  }
  {   // Pennant String: pennants strung from a little mast to the wing
    const g = addonGroup("pennant-string");
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.014, 0.5, 5), mat(LIVERY.dark));
    mast.position.set(-1.34, 1.42, -0.62); g.add(mast);
    const cols = [LIVERY.accent, LIVERY.tail, 0xf2ece0, 0x3f7fbf];
    for (let k = 0; k < 4; k++) {
      const t = k / 3;
      abox(g, 0.1, 0.08, 0.02, cols[k], -1.36 - 0.3 * t, 1.72 - 0.4 * t, -0.62 + 1.24 * t);
    }
  }
  {   // The Marshal's Wave (fabled): a chequered flag on a mast, right rear
    const g = addonGroup("marshals-wave");
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.7, 5), mat(LIVERY.dark));
    mast.position.set(-1.3, 1.62, 0.62); g.add(mast);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      abox(g, 0.12, 0.08, 0.01, (i + j) % 2 ? 0xf2f2ee : 0x1c1c1c, -1.36 - i * 0.12, 1.93 - j * 0.08, 0.62);
    }
  }
  // the front and the flanks
  {   // Snorkel: the intake up the right A-pillar to roof height
    const g = addonGroup("snorkel");
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.64, 7), mat(LIVERY.dark));
    pipe.position.set(0.66, 1.02, 0.8); pipe.rotation.z = 0.34; g.add(pipe);
    abox(g, 0.18, 0.1, 0.12, LIVERY.dark, 0.5, 1.36, 0.8);    // the head, facing forward
    abox(g, 0.12, 0.08, 0.1, LIVERY.dark, 0.8, 0.76, 0.82);   // where it leaves the wing
  }
  {   // Tow Rope: coiled on the bonnet
    const g = addonGroup("tow-rope");
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 6, 14), mat(0xe8c840));
    t.position.set(1.3, 0.9, -0.42); t.rotation.x = Math.PI / 2; g.add(t);
  }
  {   // Night Shift: a second pair of spots low on the bumper — they light with the headlights
    const g = addonGroup("night-shift");
    const small = new THREE.CylinderGeometry(0.09, 0.1, 0.1, 8);
    small.rotateZ(Math.PI / 2);
    for (const z of [-0.36, 0.36]) { const l = new THREE.Mesh(small, lampLive); l.position.set(2.15, 0.42, z); g.add(l); }
    abox(g, 0.06, 0.06, 0.9, LIVERY.dark, 2.1, 0.36, 0);
  }
  {   // Fog Lamp Prayer: two amber fogs in the bumper corners
    const g = addonGroup("fog-lamp-prayer");
    const small = new THREE.CylinderGeometry(0.07, 0.08, 0.08, 8);
    small.rotateZ(Math.PI / 2);
    for (const z of [-0.64, 0.64]) { const l = new THREE.Mesh(small, fogLampMat); l.position.set(2.12, 0.36, z); g.add(l); }
  }
  {   // Retired Number Plate: on the nose, above the bumper accent
    const g = addonGroup("retired-plate");
    abox(g, 0.02, 0.12, 0.44, 0xf4f0e2, 2.14, 0.55, 0);
    abox(g, 0.02, 0.05, 0.36, LIVERY.dark, 2.15, 0.55, 0);
  }
  {   // Waystation Bell: a small brass bell on the tow hook
    const g = addonGroup("waystation-bell");
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.07, 0.09, 8), mat(0xd9a84a));
    b.position.set(2.12, 0.32, 0.4); g.add(b);
  }
  {   // Slipstream Plating: silver side skirts and a front lip
    const g = addonGroup("slipstream-plating");
    for (const side of [-1, 1]) abox(g, 2.3, 0.1, 0.06, 0xb8bcc0, 0, 0.26, side * 0.87);
    abox(g, 0.06, 0.08, 1.7, 0xb8bcc0, 2.16, 0.28, 0);
  }

  // contact shadow: soft radial blob
  const cv = document.createElement("canvas");
  cv.width = 64; cv.height = 64;
  const ctx = cv.getContext("2d");
  const grad = ctx.createRadialGradient(32, 32, 5, 32, 32, 31);
  grad.addColorStop(0, "rgba(0,0,0,0.4)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const shadowTex = new THREE.CanvasTexture(cv);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(4.4, 2.6),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.renderOrder = 2;

  /* ---------------------------------------------------- the tag tells
   * (2026-08-31, Quinn: "some (most?) souvenirs should have a visual
   * effect on the car"). A souvenir with no bolt-on of its own wears the
   * tell of its FIRST tag: one physical thing per family, so a build
   * reads on the body without the car turning into a parade float. Boost
   * is a fat twin tailpipe, power a bonnet scoop, precision the door
   * roundels, journey a spare on the tailgate, and so on. applyBuild
   * shows them, deduped: five boost souvenirs are still one tailpipe. */
  {
    const chrome = 0xb9bec4, steel = 0x7d8488, cream = 0xf1ead8;
    {   // boost: a fat twin tailpipe
      const g = addonGroup("tag:boost");
      const pipe = new THREE.CylinderGeometry(0.055, 0.06, 0.3, 8);
      pipe.rotateZ(Math.PI / 2);
      for (const z of [0.42, 0.56]) { const q = new THREE.Mesh(pipe, mat(chrome)); q.position.set(-1.9, 0.3, z); g.add(q); }
    }
    {   // power: a bonnet scoop
      const g = addonGroup("tag:power");
      abox(g, 0.5, 0.11, 0.34, LIVERY.dark, 0.95, 1.0, 0);
      abox(g, 0.12, 0.06, 0.26, 0x101214, 1.2, 1.02, 0);
    }
    {   // flow: a second stripe, low along the flank
      const g = addonGroup("tag:flow");
      for (const z of [-0.86, 0.86]) abox(g, 2.5, 0.05, 0.02, LIVERY.accent, 0.05, 0.5, z);
    }
    {   // durability: a sump guard under the nose
      const g = addonGroup("tag:durability");
      abox(g, 0.72, 0.05, 1.22, steel, 1.72, 0.2, 0);
    }
    {   // combo: the CB whip, tall, on its coil
      const g = addonGroup("tag:combo");
      const whip = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.018, 1.25, 5), mat(LIVERY.dark));
      whip.position.set(-0.62, 1.95, 0.56);
      g.add(whip);
      abox(g, 0.08, 0.1, 0.08, LIVERY.dark, -0.62, 1.36, 0.56);
    }
    {   // journey: a spare wheel strapped to the tailgate
      const g = addonGroup("tag:journey");
      const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.16, 12), tyreMat);
      sp.rotation.z = Math.PI / 2;
      sp.position.set(-1.8, 0.86, -0.4);
      g.add(sp);
      const hb = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.17, 10), hubMat);
      hb.rotation.z = Math.PI / 2;
      hb.position.set(-1.8, 0.86, -0.4);
      g.add(hb);
    }
    {   // pickup: two canisters lashed to the roof, rear
      const g = addonGroup("tag:pickup");
      for (const z of [-0.26, 0.26]) abox(g, 0.18, 0.24, 0.16, LIVERY.accent, -0.85, 1.44, z);
      abox(g, 0.22, 0.03, 0.72, LIVERY.dark, -0.85, 1.33, 0);
    }
    {   // weather: a mast with an anemometer's cups
      const g = addonGroup("tag:weather");
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.55, 5), mat(LIVERY.dark));
      mast.position.set(-0.95, 1.6, -0.5);
      g.add(mast);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        abox(g, 0.06, 0.05, 0.06, cream, -0.95 + Math.cos(a) * 0.11, 1.88, -0.5 + Math.sin(a) * 0.11);
      }
    }
    {   // precision: the door roundels
      const g = addonGroup("tag:precision");
      const disc = new THREE.CylinderGeometry(0.27, 0.27, 0.02, 18);
      disc.rotateX(Math.PI / 2);
      for (const z of [-0.87, 0.87]) { const d = new THREE.Mesh(disc, mat(cream)); d.position.set(0.05, 0.66, z); g.add(d); }
    }
    {   // drift: a rear diffuser with fins
      const g = addonGroup("tag:drift");
      abox(g, 0.5, 0.06, 1.3, LIVERY.dark, -1.75, 0.24, 0);
      for (const z of [-0.45, -0.15, 0.15, 0.45]) abox(g, 0.5, 0.1, 0.02, LIVERY.dark, -1.75, 0.3, z);
    }
    {   // route: a compass bubble on the roof's corner
      const g = addonGroup("tag:route");
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), glassMat);
      dome.position.set(0.3, 1.36, -0.55);
      g.add(dome);
      abox(g, 0.14, 0.03, 0.14, LIVERY.dark, 0.3, 1.32, -0.55);
    }
    {   // recovery: a shovel lashed along the roof
      const g = addonGroup("tag:recovery");
      abox(g, 1.0, 0.04, 0.04, 0x8a6a48, 0.1, 1.38, 0.62);
      abox(g, 0.24, 0.02, 0.18, steel, -0.5, 1.38, 0.62);
    }
    {   // damage: a riveted steel patch on the bonnet
      const g = addonGroup("tag:damage");
      abox(g, 0.42, 0.03, 0.36, steel, 1.05, 0.9, 0.28);
      for (const [x, z] of [[0.88, 0.14], [1.22, 0.14], [0.88, 0.42], [1.22, 0.42]]) abox(g, 0.03, 0.03, 0.03, 0x3a3d40, x, 0.92, z);
    }
    {   // speed: a low front air dam
      const g = addonGroup("tag:speed");
      abox(g, 0.12, 0.09, 1.5, LIVERY.dark, 2.08, 0.19, 0);
    }
    {   // jump: heavy-duty rear shocks, yellow, showing in the arches
      const g = addonGroup("tag:jump");
      const sh = new THREE.CylinderGeometry(0.045, 0.045, 0.28, 8);
      for (const z of [-0.6, 0.6]) { const q = new THREE.Mesh(sh, mat(0xe0c040)); q.position.set(-1.3, 0.56, z); q.rotation.x = 0.25 * Math.sign(z); g.add(q); }
    }
    {   // momentum: a ballast block on the tow bar
      const g = addonGroup("tag:momentum");
      abox(g, 0.22, 0.22, 0.42, 0x3a3d40, -1.98, 0.36, 0);
      abox(g, 0.1, 0.08, 0.08, steel, -2.08, 0.3, 0);
    }
    {   // offroad: a front winch
      const g = addonGroup("tag:offroad");
      abox(g, 0.28, 0.16, 0.56, steel, 2.12, 0.42, 0);
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.4, 10), mat(LIVERY.dark));
      drum.rotation.x = Math.PI / 2;
      drum.position.set(2.2, 0.42, 0);
      g.add(drum);
    }
    {   // crew: a camera rig on the roof
      const g = addonGroup("tag:crew");
      abox(g, 0.04, 0.22, 0.04, LIVERY.dark, 0.25, 1.42, 0.3);
      abox(g, 0.2, 0.12, 0.14, LIVERY.dark, 0.3, 1.56, 0.3);
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.08, 8), mat(0x101214));
      lens.rotation.z = Math.PI / 2;
      lens.position.set(0.44, 1.56, 0.3);
      g.add(lens);
    }
    {   // sweep: a rear number board
      const g = addonGroup("tag:sweep");
      abox(g, 0.03, 0.3, 0.42, cream, -1.77, 0.55, 0.35);
      abox(g, 0.035, 0.05, 0.42, 0x101214, -1.77, 0.66, 0.35);
    }
    {   // powerup: a bottle in the back window
      const g = addonGroup("tag:powerup");
      const bt = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 8), mat(0xc23b2a));
      bt.position.set(-1.15, 1.0, 0.3);
      g.add(bt);
    }
    {   // no-brake: a drag-chute canister on the tail
      const g = addonGroup("tag:no-brake");
      const cn = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.22, 10), mat(LIVERY.accent));
      cn.rotation.z = Math.PI / 2;
      cn.position.set(-1.96, 0.78, 0);
      g.add(cn);
    }
  }

  return {
    root, body, wheels, shadow, wing, bonnet, splitter, bumper,
    dents, crack, crackMat, crackGlare, glintMat, lampMeshes, addons,
    lampMats: { lamp: lampLive, tail: mat(LIVERY.tail) },
    lampDeadMat: lampDead,
    bodyMats: [mat(LIVERY.body), mat(LIVERY.accent)],
    baseCols: [LIVERY.body, LIVERY.accent],
    lowMats: [lowDark, tyreMat],
    lowCols: [LIVERY.dark, LIVERY.tyre],
    flareMats, flapMats, hubMat, glassMat,
    lampHealth: 1, bonnetAjar: false, tyreScaled: false,
    rideOffset: 0, tinMan: false,
    _wk: "",
  };
}

/* Damage tells a story, in stages: dust and scratches, then a dent, a dead
 * lamp, a cracked screen, a bonnet that flutters, and at the bottom the
 * bumper is simply gone. Mud is its own axis — a clean car can be filthy
 * and a wrecked one washed. Everything keys off condition and the car's
 * own mud state, so a repair or a wash honestly undoes it. */
export function applyWear(kit, condition, car) {
  const mud = car ? car.mud : 0;
  const mudWet = car ? car.mudWet : 0;
  const mw = car && car.mudW ? car.mudW : [0, 0, 0, 0];
  const w = Math.round(Math.max(0, Math.min(1, 1 - condition / 100)) * 20) / 20;   // 5% steps
  const wk = w + "|" + Math.round(mud * 20) + "|" + Math.round(mudWet * 4) + "|" + Math.round(condition)
    + "|" + mw.map((v) => Math.round(v * 12)).join("");
  if (wk === kit._wk) return;
  kit._wk = wk;

  const mudCol = new THREE.Color(MUD_DRY).lerp(new THREE.Color(MUD_WET), mudWet);
  // paint: scratches dull it; the lower panels take the mud
  for (let i = 0; i < kit.bodyMats.length; i++) {
    kit.bodyMats[i].color.setHex(kit.baseCols[i])
      .lerp(new THREE.Color(SCUFF), w * 0.45)
      .lerp(mudCol, mud * 0.3);
  }
  for (let i = 0; i < kit.lowMats.length; i++) {
    kit.lowMats[i].color.setHex(kit.lowCols[i]).lerp(mudCol, mud * (i === 1 ? 0.5 : 0.85));
  }
  /* Each arch and flap wears the mud of ITS wheel on top of the general
   * spatter — the wheel that ran the verge tells on itself. */
  for (let i = 0; i < kit.flareMats.length; i++) {
    kit.flareMats[i].color.setHex(kit.baseCols[0])
      .lerp(new THREE.Color(SCUFF), w * 0.45)
      .lerp(mudCol, Math.min(1, mud * 0.55 + mw[i] * 0.8));
    kit.flapMats[i].color.setHex(LIVERY.dark).lerp(mudCol, Math.min(1, mud * 0.6 + mw[i] * 0.9));
  }

  // the stages, in the order a hard journey deals them out
  kit.dents[0].visible = condition < 75;
  kit.dents[1].visible = condition < 60;
  kit.dents[2].visible = condition < 40;
  const lamp1 = condition < 55, lamp2 = condition < 28;
  kit.lampMeshes[0].material = lamp1 ? kit.lampDeadMat : kit.lampMats.lamp;
  kit.lampMeshes[2].material = lamp2 ? kit.lampDeadMat : kit.lampMats.lamp;
  kit.lampHealth = 1 - (lamp1 ? 0.28 : 0) - (lamp2 ? 0.3 : 0);
  for (const c of kit.crack) c.visible = condition < 45;
  kit.bonnetAjar = condition < 40;
  kit.splitter.visible = kit.bumper.visible = condition >= 22;
  // the wing: one upright sags first, then the whole thing droops
  kit.wing.rotation.x = condition < 32 ? 0.42 : condition < 60 ? 0.12 : 0;
  kit.wing.position.y = condition < 32 ? 1.12 : 1.2;
  kit.lampMats.lamp.color.setHex(LIVERY.lamp).multiplyScalar(1 - w * 0.4);
}

/* The build, worn on the body: show the bolt-ons for the souvenirs owned.
 * ids is the build's id list; anything without an addon simply isn't one. */
export function applyBuild(kit, ids) {
  const has = new Set(ids || []);
  for (const id in kit.addons) kit.addons[id].visible = has.has(id);
  /* the tag tells: a souvenir without a bolt-on of its own shows its first
   * tag's part (built in buildKestrel; deduped by construction) */
  for (const id of has) {
    if (kit.addons[id]) continue;
    const def = findDef(id);
    const tag = def && def.tags ? def.tags.find((tg) => kit.addons["tag:" + tg]) : null;
    if (tag) kit.addons["tag:" + tag].visible = true;
  }
  // Rally Tyres: a visibly chunkier, wider boot
  const want = has.has("rally-tyres");
  if (want !== kit.tyreScaled) {
    kit.tyreScaled = want;
    for (const w of kit.wheels) w.tyre.scale.set(want ? 1.07 : 1, want ? 1.07 : 1, want ? 1.16 : 1);
  }
  /* Ride height you can see: tall springs and the helium bottle lift the
   * body off its wheels, low-slung and the lead sled sit it down. Render
   * only — the sim's ride height is its own business. */
  const ride = (has.has("tall-springs") ? 0.07 : 0) + (has.has("helium-bottle") ? 0.03 : 0)
    - (has.has("low-slung") ? 0.06 : 0) - (has.has("lead-sled") ? 0.04 : 0);
  kit.rideOffset = Math.max(-0.08, Math.min(0.1, ride));
  // the hubs: studs are bright steel, iron shoes are dull iron, else stock
  kit.hubMat.color.setHex(has.has("studded-tyres") ? 0xdfe3e6 : has.has("iron-shoes") ? 0x4a4d52 : LIVERY.hub);
  // Aurora Glass: the screen goes green-teal and keeps a little of its own light
  const aurora = has.has("aurora-glass");
  kit.glassMat.color.setHex(aurora ? 0x2f8f7a : LIVERY.glass);
  kit.glassMat.emissive.setHex(aurora ? 0x0d3a30 : 0x000000);
  // Tin Man: the cream panels become bare steel; the chevrons stay
  const tin = has.has("tin-man");
  if (tin !== kit.tinMan) {
    kit.tinMan = tin;
    kit.baseCols[0] = tin ? 0xb8bcc0 : LIVERY.body;
    kit._wk = "";     // applyWear repaints from baseCols on its next pass
  }
}

export function updateKestrel(kit, car, world, anchor) {
  /* A tumble rotates the body about its axle line, which puts the side and
   * then the roof under the deck. Lift it by what the body's box needs to
   * rest on the ground at that angle (half-width 0.83 on its side, roof
   * height 1.32 upside down) — the car HOPS over its own corner, which is
   * what a roll looks like. Zero when upright, so nothing else moves. */
  const tumble = Math.abs(car.rollSpin || 0);
  const lift = tumble > 1e-3 ? 0.83 * Math.abs(Math.sin(tumble)) + 1.32 * Math.max(0, -Math.cos(tumble)) : 0;
  const ride = kit.rideOffset || 0;
  kit.root.position.set(car.x - anchor.x, car.y + lift + ride, car.z - anchor.z);
  kit.root.rotation.set(0, -car.yaw, 0);
  const e = bodyEuler(car);
  kit.body.rotation.set(e.x, e.y, e.z);

  // the body rides its springs; each wheel hangs to meet its own ground
  const R = KESTREL.wheelR;
  const spin = car.vx / R;
  for (let i = 0; i < kit.wheels.length; i++) {
    const w = kit.wheels[i];
    w.pivot.position.y = wheelLift(car, i, w.px, w.pz, R) - ride;   // the wheels stay on the deck
    w.tyre.rotation.z -= spin * 0.0166;
    if (w.front) w.pivot.rotation.y = -car.steer * 0.9;
  }

  /* Panels in the wind (driven by sim tick, so screenshots are honest):
   * a popped bonnet trembles, the ribbon streams. */
  const wind = Math.min(1, Math.abs(car.vx) / 30);
  const bonnetBase = -0.15;   // the plate lies on the bonnet's slope
  if (kit.bonnetAjar) {
    kit.bonnet.rotation.z = bonnetBase + 0.05 + (Math.sin(car.tick * 0.11) + Math.sin(car.tick * 0.041)) * 0.01 * wind;
  } else if (kit.bonnet.rotation.z !== bonnetBase) kit.bonnet.rotation.z = bonnetBase;
  const pm = kit.addons["perpetual-motion"];
  if (pm && pm.visible) {
    pm.userData.spin[0].rotation.x = car.tick * 0.06;
    pm.userData.spin[1].rotation.z = car.tick * 0.045;
  }
  const td = kit.addons["tail-dancer"];
  if (td && td.visible) {
    const rb = td.userData.ribbon;
    rb[0].rotation.y = Math.sin(car.tick * 0.09) * 0.35 * (0.3 + wind);
    rb[1].rotation.y = Math.sin(car.tick * 0.09 + 1.2) * 0.5 * (0.3 + wind);
  }

  const g = world.groundHeight(car.x, car.z, car.s);
  if (g) {
    kit.shadow.position.set(car.x - anchor.x, g.y + 0.05, car.z - anchor.z);
    kit.shadow.rotation.z = -car.yaw;
    const h = Math.max(0, car.y - g.y);
    const k = Math.max(0.2, 1 - h * 0.2);
    kit.shadow.scale.setScalar(k);
    kit.shadow.material.opacity = k * 0.9;
  }
}

/* The camera crew's tripod: the visual promise of a cinematic cut (owner:
 * "some sort of visual indicator of the camera points"). A three-legged
 * stand, a camera body with its lens along +x (rotate -yaw to aim it, the
 * same convention as the car), and an amber tally lamp so it reads at dusk.
 * Render-only; main.js parks it at the shot's seat and hides it after. */
export function buildTripod() {
  const g = new THREE.Group();
  const metal = new THREE.MeshLambertMaterial({ color: 0x2a2f33 });
  const legGeo = new THREE.CylinderGeometry(0.028, 0.036, 1.56, 5);
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    const foot = new THREE.Vector3(Math.cos(a) * 0.46, 0, Math.sin(a) * 0.46);
    const head = new THREE.Vector3(0, 1.42, 0);
    const leg = new THREE.Mesh(legGeo, metal);
    const dir = head.clone().sub(foot).normalize();
    leg.quaternion.setFromUnitVectors(up, dir);
    leg.position.copy(foot.clone().add(head).multiplyScalar(0.5));
    g.add(leg);
  }
  const bodyM = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.26, 0.24), metal);
  bodyM.position.set(0.02, 1.56, 0);
  g.add(bodyM);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.085, 0.2, 8), metal);
  lens.rotation.z = Math.PI / 2;
  lens.position.set(0.32, 1.56, 0);
  g.add(lens);
  const tally = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.07),
    new THREE.MeshBasicMaterial({ color: 0xffb454 }));
  tally.position.set(-0.18, 1.73, 0);
  g.add(tally);
  return g;
}

/* THE SWEEP CAR (2026-08-31, Quinn: "I want to be able to see the sweep
 * car"). A marshal's estate: white, an orange chevron band, a roof bar of
 * amber beacons that flash left-right, big lamps, the SWEEP board on the
 * bar. main.js seats it on the road at the pursuer's exact metre every
 * frame. Render-only: the sweep itself is a number in run.js, and the
 * harness never sees this. */
export function buildSweepCar() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const m = (c, e) => new THREE.MeshLambertMaterial(e != null ? { color: c, emissive: e } : { color: c });
  const white = m(0xeef0f2), orange = m(0xf06a1e), dark = m(0x2b2e33), tyre = m(0x191c1f), glass = m(0x1a2126);
  const beaconA = m(0xffb020, 0x6a3a00), beaconB = m(0xffb020, 0x6a3a00);
  const lamp = m(0xfff3c4, 0x5a4a20);
  const b = (w, h, d, mt, x, y, z) => { const k = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mt); k.position.set(x, y, z); body.add(k); return k; };
  // a longer, squarer body than the Kestrel: an estate with a long roof
  b(4.3, 0.62, 1.7, white, 0, 0.62, 0);
  b(2.9, 0.5, 1.58, white, -0.35, 1.16, 0);
  b(2.2, 0.36, 1.62, glass, -0.3, 1.14, 0);
  b(4.32, 0.14, 1.72, orange, 0, 0.58, 0);
  b(0.3, 0.22, 1.5, dark, 2.1, 0.4, 0);
  b(0.3, 0.22, 1.5, dark, -2.1, 0.4, 0);
  for (const z of [-0.55, 0.55]) b(0.08, 0.16, 0.3, lamp, 2.16, 0.74, z);
  for (const z of [-0.55, 0.55]) b(0.06, 0.12, 0.26, m(0xd2452e, 0x3a0c08), -2.16, 0.74, z);
  b(1.1, 0.1, 0.36, dark, -0.4, 1.46, 0);
  const bl = b(0.28, 0.16, 0.3, beaconA, -0.1, 1.56, -0.36);
  const br = b(0.28, 0.16, 0.3, beaconB, -0.1, 1.56, 0.36);
  b(0.6, 0.16, 0.34, orange, -0.75, 1.56, 0);
  const wheels = [];
  const wg = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 14);
  wg.rotateX(Math.PI / 2);
  for (const [x, z] of [[1.4, -0.8], [1.4, 0.8], [-1.4, -0.8], [-1.4, 0.8]]) {
    const w = new THREE.Mesh(wg, tyre);
    w.position.set(x, 0.33, z);
    root.add(w);
    wheels.push(w);
  }
  // the beacons' throw: an amber pool on the road it is closing on
  const light = new THREE.PointLight(0xffa030, 0, 40, 1.6);
  light.position.set(-0.1, 1.9, 0);
  root.add(light);
  root.visible = false;
  return { root, body, wheels, beacons: [bl, br], beaconMats: [beaconA, beaconB], light, blink: 0 };
}

/* seat the sweep car on the road at s (world metres), spin the wheels at
 * the road's pace, flash the bar; `dark` (0..1) is how much the beacons
 * get to light the ground */
export function updateSweepCar(kit, world, s, anchor, dt, dark) {
  const smp = world.sampleNear(s);
  if (!smp) { kit.root.visible = false; return; }
  kit.root.visible = true;
  kit.root.position.set(smp.x - anchor.x, smp.y, smp.z - anchor.z);
  kit.root.rotation.set(0, -smp.heading, 0);
  const v = Math.max(8, world.profileAt ? (world.profileAt(s) || 0) : 20) * 0.85;
  for (const w of kit.wheels) w.rotation.z -= (v / 0.33) * dt;
  kit.blink = (kit.blink + dt * 2.4) % 2;
  const left = kit.blink < 1;
  kit.beaconMats[0].emissive.setHex(left ? 0xffa020 : 0x2a1600);
  kit.beaconMats[1].emissive.setHex(left ? 0x2a1600 : 0xffa020);
  kit.light.intensity = (0.5 + 1.8 * (dark || 0)) * (left ? 1 : 0.4);
}
