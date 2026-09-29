/* Overcrest — what the car throws up.
 *
 * A rally car is mostly recognisable by its wake: gravel roads smoke behind
 * you, wet roads throw a fine spray, tarmac only smokes when you are asking
 * too much of it, and a landing punches a cloud out of the surface. None of
 * that is decoration — it is the clearest read the player has on how much
 * the tyres are actually doing, which is why it is driven by slip and load
 * rather than by speed alone.
 *
 * One pooled InstancedMesh, positions in world coordinates (re-sat against
 * the render anchor every frame, so it survives a rebase), CPU-integrated.
 * Cheap: a few hundred instances, no sorting, no depth writes.
 */

import * as THREE from "three";

const MAX = 260;

/* How much a surface is willing to leave the ground, and what colour it is
 * when it does. Tarmac barely lifts — its wake is tyre smoke, not dust. */
const SURFACE = {
  gravel: { lift: 1.0, rise: 0.85, life: 0.95, size: 0.12, smoke: 0.15 },
  dirt: { lift: 1.25, rise: 0.8, life: 1.1, size: 0.14, smoke: 0.1 },
  sand: { lift: 1.35, rise: 0.95, life: 1.25, size: 0.16, smoke: 0.08 },
  snow: { lift: 1.1, rise: 1.1, life: 1.3, size: 0.13, smoke: 0.0 },
  mud: { lift: 0.7, rise: 0.4, life: 0.65, size: 0.1, smoke: 0.0 },
  ice: { lift: 0.15, rise: 0.5, life: 0.7, size: 0.08, smoke: 0.0 },
  tarmac: { lift: 0.12, rise: 1.2, life: 0.9, size: 0.11, smoke: 1.0 },
};

export function makeParticles(kit) {
  /* A flattened, irregular blob: at these sizes a sphere reads as a ball
   * and a quad reads as a sprite, but a squashed icosahedron reads as a
   * cloud of something — and it matches the low-poly language. */
  const geo = new THREE.IcosahedronGeometry(0.5, 0);
  geo.scale(1, 0.72, 1);
  /* Basic, not Lambert: dust is lit by the whole sky, not by a sun on one
   * side, and a shaded blob reads as a rock tumbling down the road. */
  const mat = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.42, depthWrite: false, fog: true,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  kit.scene.add(mesh);

  const P = [];
  for (let i = 0; i < MAX; i++) {
    P.push({ live: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0, life: 1, size: 1, spin: 0, r: 1, g: 1, b: 1 });
  }
  let next = 0;
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const tint = new THREE.Color();
  let spawnDebt = 0, exDebt = 0, ambDebt = 0;

  function alloc() {
    // ring allocation: the oldest particle is the one worth losing
    for (let n = 0; n < MAX; n++) {
      const p = P[next];
      next = (next + 1) % MAX;
      if (!p.live) return p;
    }
    const p = P[next];
    next = (next + 1) % MAX;
    return p;
  }

  function emit(x, y, z, vx, vy, vz, size, life, r, g, b) {
    const p = alloc();
    p.live = true;
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.t = 0; p.life = life; p.size = size;
    p.spin = (Math.random() - 0.5) * 3;
    p.r = r; p.g = g; p.b = b;
  }

  // the particle-density setting scales spawn rates; 0 turns the dust off
  let density = 1;
  function setDensity(k) { density = Math.max(0, Math.min(1, k)); }

  /* Per frame. `ground` is the palette colour of what the car is driving
   * on — dust is the road, lifted. */
  function update(dt, car, world, palette, snap) {
    dt = Math.min(0.05, dt || 0.016);
    const wet = (world && world.wetness) || 0;
    const surf = SURFACE[car.surface] || SURFACE.gravel;
    const speed = Math.abs(car.vx);
    const slip = Math.min(1.4, Math.abs(car.beta) * 2.2 + car.wheelspin * 1.1 + (car.handbrake ? 0.5 : 0));

    /* Ground colour, pulled toward the palette's dust and lightened — what
     * comes up is drier and paler than what you see packed on the road. */
    const roadCol = palette.shoulder != null ? palette.shoulder : 0x8f8672;
    tint.set(car.zone === "road" ? palette.road : roadCol);
    const smoke = surf.smoke;
    if (smoke > 0) tint.lerp(col.set(0x9aa0a4), smoke * 0.8);
    if (wet > 0.25) tint.lerp(col.set(0x8ba0ad), Math.min(0.75, wet));    // spray, not dust
    const night = (snap && snap.night) || 0;
    tint.multiplyScalar(1.06 - night * 0.35);

    if (car.grounded && speed > 4) {
      /* Rate: what the tyres are doing, not how fast the scenery moves. A
       * car cruising on gravel trails a little; a car sideways on it is a
       * cloud. Wet ground gives spray instead, and less of it. */
      const loose = surf.lift * (1 - wet * 0.45) + (wet > 0.3 ? 0.35 : 0);
      const work = 0.3 + slip * 1.1 + Math.min(1, speed / 42) * 0.75;
      const rate = loose * work * 105 * density;
      spawnDebt += rate * dt;

      const cosY = Math.cos(car.yaw), sinY = Math.sin(car.yaw);
      const back = -1.45, side = 0.78;
      while (spawnDebt >= 1) {
        spawnDebt -= 1;
        const s = Math.random() < 0.5 ? -1 : 1;
        // rear contact patch, in world space
        const lx = back + (Math.random() - 0.5) * 0.5;
        const lz = s * side + (Math.random() - 0.5) * 0.3;
        const x = car.x + cosY * lx - sinY * lz;
        const z = car.z + sinY * lx + cosY * lz;
        // thrown backwards and outwards from the direction of travel
        const vBack = -(0.18 + speed * 0.1) * (0.6 + Math.random() * 0.8);
        const vSide = s * (0.4 + slip * 2.6) * Math.random();
        const vx = cosY * vBack - sinY * vSide;
        const vz = sinY * vBack + cosY * vSide;
        const vy = surf.rise * (0.5 + Math.random() * 0.9) + slip * 0.5;
        const sz = surf.size * (0.55 + Math.random() * 0.9) * (1 + slip * 0.35);
        const life = surf.life * (0.6 + Math.random() * 0.7);
        const j = 0.9 + Math.random() * 0.2;
        emit(x, car.y + 0.12, z, vx, vy, vz, sz, life, tint.r * j, tint.g * j, tint.b * j);
      }
    } else {
      spawnDebt = 0;
    }

    /* Exhaust on the overrun: lift off at revs and the pipe puts out a
     * string of small dark puffs — the sound's visible half. */
    if (car.grounded && car.throttle < 0.15 && car.rpm > 4200 && speed > 12) {
      exDebt += dt * 7 * density;
      const cosY = Math.cos(car.yaw), sinY = Math.sin(car.yaw);
      while (exDebt >= 1) {
        exDebt -= 1;
        emit(
          car.x - cosY * 1.85 + sinY * 0.5, car.y + 0.3, car.z - sinY * 1.85 - cosY * 0.5,
          -cosY * 1.4, 0.5 + Math.random() * 0.4, -sinY * 1.4,
          0.15, 0.45 + Math.random() * 0.25, 0.3, 0.29, 0.28
        );
      }
    } else exDebt = 0;

    /* Ambient drift: the air itself has somewhere to be. Leaves flutter
     * across the forest countries, sand streams low over the desert, and
     * pale motes rise in The Verge — a handful a second, at speed, so the
     * world moves even where the road is straight. */
    // what the country's air carries is the country's own call (biomes.js `drift`)
    const hbB = world.hereBiome && world.hereBiome.biome ? world.hereBiome.biome : null;
    const ambKind = hbB ? hbB.drift || null : null;
    if (ambKind && speed > 6) {
      ambDebt += dt * (ambKind === "sand" ? 5 : 2.5) * density;
      const cosY = Math.cos(car.yaw), sinY = Math.sin(car.yaw);
      while (ambDebt >= 1) {
        ambDebt -= 1;
        const ahead = 8 + Math.random() * 26;
        const off = (Math.random() - 0.5) * 22;
        const px = car.x + cosY * ahead - sinY * off;
        const pz = car.z + sinY * ahead + cosY * off;
        if (ambKind === "leaf") {
          col.set(palette.birch ? palette.birch[0] : 0x6d8a4a);
          emit(px, car.y + 0.5 + Math.random() * 2.5, pz,
            (Math.random() - 0.5) * 2.5, 0.3 + Math.random() * 0.7, (Math.random() - 0.5) * 2.5,
            0.12, 1.6 + Math.random() * 1.4, col.r, col.g, col.b);
        } else if (ambKind === "sand") {
          col.set(palette.shoulder != null ? palette.shoulder : 0xc9a96a);
          emit(px, car.y + 0.15 + Math.random() * 0.8, pz,
            2.2 + Math.random() * 2.5, 0.15, (Math.random() - 0.5) * 1.4,
            0.2, 1.2 + Math.random(), col.r, col.g, col.b);
        } else {
          emit(px, car.y + 0.4 + Math.random() * 3, pz,
            (Math.random() - 0.5) * 0.8, 0.5 + Math.random() * 0.7, (Math.random() - 0.5) * 0.8,
            0.1, 2.2 + Math.random() * 1.6, 0.78, 0.8, 0.92);
        }
      }
    } else ambDebt = 0;

    // integrate
    const anchor = kit.anchor;
    const fog = kit.scene.fog ? kit.scene.fog.color : null;
    const fogR = fog ? fog.r : 0.8, fogG = fog ? fog.g : 0.85, fogB = fog ? fog.b : 0.85;
    let n = 0;
    for (let i = 0; i < MAX; i++) {
      const p = P[i];
      if (!p.live) continue;
      p.t += dt;
      if (p.t >= p.life) { p.live = false; continue; }
      const k = p.t / p.life;
      // drag, then a slow lift as it loses the ground's push
      const drag = 1 - Math.min(1, 2.6 * dt);
      p.vx *= drag; p.vz *= drag;
      p.vy = p.vy * (1 - 1.4 * dt) + 0.15 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;

      /* Disperses: grows while it is being thrown, then thins away. It
       * dissolves INTO the air — the colour walks toward the fog rather
       * than toward black, because a particle fading to black is a rock
       * getting darker, not dust disappearing. */
      const grow = p.size * (1 + k * 4.2) * (1 - k * k * k * 0.6);
      dummy.position.set(p.x - anchor.x, p.y, p.z - anchor.z);
      dummy.rotation.set(k * p.spin, k * p.spin * 1.7, 0);
      dummy.scale.setScalar(grow);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
      const f = Math.min(1, k * 1.15);
      mesh.instanceColor.setXYZ(
        n,
        p.r + (fogR - p.r) * f,
        p.g + (fogG - p.g) * f,
        p.b + (fogB - p.b) * f
      );
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.visible = n > 0;
  }

  /* A landing, a kerb, a collision: one punch of whatever is underfoot. */
  function burst(car, strength, world, palette) {
    const surf = SURFACE[car.surface] || SURFACE.gravel;
    const wet = (world && world.wetness) || 0;
    tint.set(palette.shoulder != null ? palette.shoulder : 0x8f8672);
    if (wet > 0.25) tint.lerp(col.set(0x8ba0ad), Math.min(0.75, wet));
    const n = Math.round(Math.min(26, 6 + strength * 2.2));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.6 + Math.random() * 1.8) * (0.6 + strength * 0.12);
      emit(
        car.x + Math.cos(a) * 0.9, car.y + 0.1, car.z + Math.sin(a) * 0.9,
        Math.cos(a) * sp, surf.rise * (0.8 + Math.random()) + strength * 0.06, Math.sin(a) * sp,
        surf.size * (0.8 + Math.random()), surf.life * (0.8 + Math.random() * 0.6),
        tint.r, tint.g, tint.b
      );
    }
  }

  /* Hard contact: metal finds rock and it SPARKS — a handful of bright,
   * fast, short-lived points thrown from the sill line. */
  function sparks(car, strength) {
    const n = Math.round(Math.min(14, 3 + strength * 0.8) * Math.max(0.2, density));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2.5 + Math.random() * 5;
      emit(
        car.x + (Math.random() - 0.5) * 2.4, car.y + 0.25, car.z + (Math.random() - 0.5) * 2.4,
        Math.cos(a) * sp, 1.2 + Math.random() * 2.4, Math.sin(a) * sp,
        0.09 + Math.random() * 0.06, 0.22 + Math.random() * 0.18,
        1.0, 0.74 + Math.random() * 0.2, 0.3
      );
    }
  }

  function clear() {
    for (const p of P) p.live = false;
    mesh.count = 0;
  }

  function dispose() {
    kit.scene.remove(mesh);
    geo.dispose(); mat.dispose();
  }

  return { update, burst, sparks, clear, dispose, mesh, setDensity };
}
