/* Overcrest — dev overlay: the debug drawings the bible asks for.
 *
 * Toggled with V under ?debug=1. Three layers, all cheap line geometry
 * rebuilt a few times a second:
 *   · the road spline ahead (centreline + edge ticks), green
 *   · every collider within reach, drawn as the circle physics tests, red
 *   · the pace notes, drawn as posts standing at `atS` (what the call is
 *     ABOUT — the same place the HUD chip counts down to), coloured amber
 *
 * Render-only, allocated once, never in the sim. Nothing here exists
 * unless the overlay is on.
 */

import * as THREE from "three";

const MAX_SEGS = 4096;

export function makeDevLines(kit, world) {
  const group = new THREE.Group();
  group.visible = false;
  kit.scene.add(group);

  function lineMesh(hex) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_SEGS * 6), 3));
    const m = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.85, depthTest: false }));
    m.renderOrder = 9;
    m.frustumCulled = false;
    group.add(m);
    return m;
  }
  const road = lineMesh(0x64e08c);
  const cols = lineMesh(0xe05a48);
  const noteL = lineMesh(0xffb454);

  let t = 0;

  function put(arr, n, x1, y1, z1, x2, y2, z2, ax, az) {
    if (n * 6 + 5 >= arr.length) return n;
    arr[n * 6 + 0] = x1 - ax; arr[n * 6 + 1] = y1; arr[n * 6 + 2] = z1 - az;
    arr[n * 6 + 3] = x2 - ax; arr[n * 6 + 4] = y2; arr[n * 6 + 5] = z2 - az;
    return n + 1;
  }

  function update(car, dt) {
    if (!group.visible) return;
    t += dt;
    if (t < 0.12) return;   // ~8 Hz is plenty for a debug view
    t = 0;
    const ax = kit.anchor.x, az = kit.anchor.z;

    // the spline: centreline + a half-width tick every 30 m
    {
      const arr = road.geometry.attributes.position.array;
      let n = 0, prev = null;
      for (let s = car.s - 60; s < car.s + 700; s += 10) {
        const p = world.sampleNear(s);
        if (!p) { prev = null; continue; }
        if (prev) n = put(arr, n, prev.x, prev.y + 0.3, prev.z, p.x, p.y + 0.3, p.z, ax, az);
        if (Math.round(s / 10) % 3 === 0) {
          const rx = -Math.sin(p.heading), rz = Math.cos(p.heading);
          n = put(arr, n, p.x - rx * p.hw, p.y + 0.3, p.z - rz * p.hw, p.x + rx * p.hw, p.y + 0.3, p.z + rz * p.hw, ax, az);
        }
        prev = p;
      }
      road.geometry.setDrawRange(0, n * 2);
      road.geometry.attributes.position.needsUpdate = true;
    }

    // colliders: the actual circles the physics tests, as octagons
    {
      const arr = cols.geometry.attributes.position.array;
      let n = 0;
      const cx = Math.floor(car.x / 8), cz = Math.floor(car.z / 8);
      const R = 22;   // cells: ~175 m around the car
      for (let dx = -R; dx <= R; dx++) {
        for (let dz = -R; dz <= R; dz++) {
          const bag = world.colliderHash.get((cx + dx) + "," + (cz + dz));
          if (!bag) continue;
          for (const c of bag) {
            const g = world.groundHeight(c.x, c.z, car.s);
            const y = (g ? g.y : car.y) + 0.5;
            for (let k = 0; k < 8; k++) {
              const a0 = (k / 8) * Math.PI * 2, a1 = ((k + 1) / 8) * Math.PI * 2;
              n = put(arr, n,
                c.x + Math.cos(a0) * c.r, y, c.z + Math.sin(a0) * c.r,
                c.x + Math.cos(a1) * c.r, y, c.z + Math.sin(a1) * c.r, ax, az);
            }
            if (n * 6 + 5 >= arr.length) break;
          }
        }
      }
      cols.geometry.setDrawRange(0, n * 2);
      cols.geometry.attributes.position.needsUpdate = true;
    }

    // pace notes: a post at atS (the thing itself), taller for lower gears
    {
      const arr = noteL.geometry.attributes.position.array;
      let n = 0;
      for (const note of world.notes) {
        const at = note.atS != null ? note.atS : note.s;
        if (at < car.s - 30 || at > car.s + 800) continue;
        const p = world.sampleNear(at);
        if (!p) continue;
        const g = typeof note.grade === "number" ? note.grade : note.grade === "hp" ? 0 : 7;
        const h = 2 + (7 - Math.min(7, g)) * 0.8;
        const rx = -Math.sin(p.heading), rz = Math.cos(p.heading);
        const side = note.dir === 1 ? 1 : -1;
        const bx = p.x + rx * (p.hw + 0.8) * side, bz = p.z + rz * (p.hw + 0.8) * side;
        n = put(arr, n, bx, p.y, bz, bx, p.y + h, bz, ax, az);
        // a flag pointing the corner's way
        n = put(arr, n, bx, p.y + h, bz, bx + rx * side * 1.4, p.y + h - 0.5, bz + rz * side * 1.4, ax, az);
      }
      noteL.geometry.setDrawRange(0, n * 2);
      noteL.geometry.attributes.position.needsUpdate = true;
    }
  }

  function toggle() { group.visible = !group.visible; return group.visible; }
  function dispose() { kit.scene.remove(group); }

  return { update, toggle, dispose, get on() { return group.visible; } };
}
