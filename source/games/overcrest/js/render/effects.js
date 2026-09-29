/* Overcrest — atmospheric effects: stars, rain, headlights, and the
 * celestial rarities.
 *
 * Stars: a Points cloud on the sky dome that fades with the "stars" ramp.
 * Rain: streaks (elongated points) in a box that follows the camera and
 * falls with wind; density from the rain scalar. Headlights: an additive
 * light-pool plane laid on the ground ahead of the car, brighter lamp
 * materials, and a small point light so nearby trunks catch the beam.
 *
 * Sky events (world/celestial.js decides; this file only draws what the
 * snapshot says): meteors are streak quads radiating from a hashed point
 * on the dome; distant lightning is an additive horizon glow driven by
 * the sim's flash value; the double rainbow is two banded ribbons rebuilt
 * each frame opposite the sun; the cloud sea is a soft undulating plane
 * at the inversion height, depth-tested so ridge tops break through it.
 * All pooled; nothing allocates per frame.
 */

import * as THREE from "three";

function softDisc(size, inner, outer, alpha) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const c = cv.getContext("2d");
  const g = c.createRadialGradient(size / 2, size / 2, size * inner, size / 2, size / 2, size * outer);
  g.addColorStop(0, `rgba(255,255,255,${alpha})`);
  g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(cv);
}

export function makeEffects(kit) {
  const scene = kit.scene;

  // ---------------- stars
  const N_STARS = 900;
  const starPos = new Float32Array(N_STARS * 3);
  const starCol = new Float32Array(N_STARS * 3);
  const h01 = (n) => { let v = Math.imul(n ^ 0x9e37, 0x85ebca6b); v = Math.imul(v ^ (v >>> 13), 0xc2b2ae35); v ^= v >>> 16; return (v >>> 0) / 4294967296; };
  for (let i = 0; i < N_STARS; i++) {
    // hemisphere, denser toward zenith, hashed spread (cosmetic)
    const a = h01(i * 2 + 1) * Math.PI * 2;
    const y = 0.06 + Math.pow(h01(i * 2), 0.6) * 0.92;
    const r = Math.sqrt(1 - y * y) * 2400;
    starPos[i * 3] = Math.cos(a) * r; starPos[i * 3 + 1] = y * 2400; starPos[i * 3 + 2] = Math.sin(a) * r;
    const w = 0.7 + ((i * 7) % 5) * 0.075;
    const warm = (i % 11) === 0;
    starCol[i * 3] = w * (warm ? 1 : 0.85); starCol[i * 3 + 1] = w * 0.9; starCol[i * 3 + 2] = w * (warm ? 0.7 : 1);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute("color", new THREE.BufferAttribute(starCol, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
    size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0,
    fog: false, depthWrite: false, map: softDisc(32, 0.05, 0.5, 1),
  }));
  stars.renderOrder = -19;
  stars.frustumCulled = false;
  scene.add(stars);

  // ---------------- rain
  const N_RAIN = 900;
  const rainPos = new Float32Array(N_RAIN * 3);
  const rainVel = new Float32Array(N_RAIN);
  for (let i = 0; i < N_RAIN; i++) {
    rainPos[i * 3] = (((i * 0.7548776662) % 1) - 0.5) * 70;
    rainPos[i * 3 + 1] = ((i * 0.5698402909) % 1) * 30;
    rainPos[i * 3 + 2] = (((i * 0.3247179572) % 1) - 0.5) * 70;
    rainVel[i] = 18 + ((i * 13) % 7) * 1.4;
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
  const streakTex = (() => {
    const cv = document.createElement("canvas");
    cv.width = 32; cv.height = 32;
    const c = cv.getContext("2d");
    const g = c.createLinearGradient(0, 0, 0, 32);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, "rgba(255,255,255,0.9)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(14, 0, 4, 32);
    return new THREE.CanvasTexture(cv);
  })();
  const rain = new THREE.Points(rainGeo, new THREE.PointsMaterial({
    color: 0xdfe8ef, size: 0.6, transparent: true, opacity: 0, depthWrite: false,
    map: streakTex, sizeAttenuation: true,
  }));
  rain.frustumCulled = false;
  scene.add(rain);

  // ---------------- snow (the same precipitation scalar, a different animal:
  // slow, drifting sideways, and it hangs in the headlights)
  const N_SNOW = 700;
  const snowPos = new Float32Array(N_SNOW * 3);
  const snowVel = new Float32Array(N_SNOW);
  for (let i = 0; i < N_SNOW; i++) {
    snowPos[i * 3] = (((i * 0.7548776662) % 1) - 0.5) * 64;
    snowPos[i * 3 + 1] = ((i * 0.5698402909) % 1) * 26;
    snowPos[i * 3 + 2] = (((i * 0.3247179572) % 1) - 0.5) * 64;
    snowVel[i] = 2.1 + ((i * 13) % 7) * 0.24;
  }
  const snowGeo = new THREE.BufferGeometry();
  snowGeo.setAttribute("position", new THREE.BufferAttribute(snowPos, 3));
  const snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({
    color: 0xf4f7fa, size: 0.34, transparent: true, opacity: 0, depthWrite: false,
    map: softDisc(32, 0.05, 0.5, 0.95), sizeAttenuation: true,
  }));
  snow.frustumCulled = false;
  scene.add(snow);
  let snowDriftT = 0;

  /* ---------------- clouds (hands-on #5: "we need clouds")
   *
   * A pool of soft billboard puffs on a high shell around the camera —
   * backdrop-anchored like the stars and the ridge rings. COVER comes
   * from the weather fields (overcast builds the sheet, rain darkens it,
   * deep rain turns it slate and sinks the bases), and because those
   * fields blend across 40 s fronts and the puffs each fade over a few
   * seconds, the sky CHANGES the way weather does — the "fading skybox"
   * is the clouds arriving and leaving. Golden hour warms the sun side;
   * night puts them out; a lightning flash lights the bases near the
   * strike. Depth-tested, so the horizon-low ones rise from behind the
   * ridges instead of lying on them. */
  const cloudTex = (variant) => {
    const cv = document.createElement("canvas");
    cv.width = 256; cv.height = 128;
    const c = cv.getContext("2d");
    const lumps = variant === 0
      ? [[62, 58, 46], [118, 44, 58], [178, 56, 44], [92, 70, 34], [150, 72, 36]]
      : [[52, 62, 40], [128, 52, 66], [204, 62, 38], [96, 78, 30], [168, 78, 30], [228, 70, 24]];
    for (const [x, y, r] of lumps) {
      const g = c.createRadialGradient(x, y, r * 0.12, x, y, r);
      g.addColorStop(0, "rgba(255,255,255,0.85)");
      g.addColorStop(0.65, "rgba(255,255,255,0.38)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, 256, 128);
    }
    return new THREE.CanvasTexture(cv);
  };
  const cloudTexes = [cloudTex(0), cloudTex(1)];
  /* 70 puffs in the pool; the quality ladder says how many may fly. Each
   * puff is its own sprite (a draw call and a lot of soft overdraw), so
   * the cap is one of the cheapest levers a weak GPU has — and on ultra
   * the extra sixteen make the big skies properly stacked. */
  const N_CLOUD = 70;
  let cloudCap = 54;
  const clouds = [];
  for (let i = 0; i < N_CLOUD; i++) {
    const mat = new THREE.SpriteMaterial({
      map: cloudTexes[i % 2], transparent: true, opacity: 0,
      depthWrite: false, fog: false, color: 0xffffff,
    });
    const sp = new THREE.Sprite(mat);
    const w = 260 + h01(i * 41 + 9) * 340;
    sp.scale.set(w, w * (0.3 + h01(i * 43 + 11) * 0.18), 1);
    sp.renderOrder = -19;
    sp.visible = false;
    scene.add(sp);
    clouds.push({
      sp,
      az: h01(i * 29 + 3) * Math.PI * 2,
      r: 950 + h01(i * 31 + 5) * 950,
      /* elevation ratio keeps every puff above the ridge sightline
       * (~0.121 at the far ring); storms sink the bases toward it */
      elev: 0.155 + h01(i * 37 + 7) * 0.13,
      drift: (0.0016 + h01(i * 47 + 13) * 0.0022) * (h01(i * 53 + 19) < 0.5 ? 1 : -1),
      op: 0,
      base: 0.42 + h01(i * 59 + 17) * 0.3,
    });
  }
  const cCloudLit = new THREE.Color(), cCloudTmp = new THREE.Color();
  /* the first frame seats every puff AT its target — the fade is for
   * fronts arriving mid-drive, not for boot; and under virtual-time
   * screenshots rAF barely ticks, so an accumulated fade would show an
   * empty sky (the meteor lesson, again) */
  let cloudsPrimed = false;

  // ---------------- meteors (celestial: snap.meteors)
  const N_MET = 5;
  const metTex = (() => {
    const cv = document.createElement("canvas");
    cv.width = 64; cv.height = 8;
    const c = cv.getContext("2d");
    const g = c.createLinearGradient(0, 0, 64, 0);     // bright head, long tail
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.75, "rgba(220,235,255,0.55)");
    g.addColorStop(0.94, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(0, 2, 64, 4);
    return new THREE.CanvasTexture(cv);
  })();
  const meteors = [];
  for (let i = 0; i < N_MET; i++) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: metTex, transparent: true, opacity: 0, fog: false, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      })
    );
    m.renderOrder = -18;
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    m.visible = false;
    scene.add(m);
    meteors.push({ mesh: m, k: -1, touched: false, life: 0.7, speed: 600, P0: new THREE.Vector3(), D: new THREE.Vector3() });
  }
  /* The shower is a pure function of the event's SIM clock (snap.meteorT):
   * streak k exists in a fixed window, so a fast-forwarded or resumed run
   * shows exactly the sky it would have shown live — and a screenshot
   * under virtual time actually catches one. */
  const MET_CADENCE = 1.1;
  let radiantAz = 0, metWas = false;

  /* ---------------- distant lightning (celestial: snap.lightning)
   *
   * Two pieces now, both DEPTH-TESTED and pushed beyond the far ridge
   * ring, so the light rises from BEHIND the horizon instead of lying
   * across it (hands-on #5: the old glow ignored depth and its disc
   * straddled the ridge line). The glow is the storm's throat; the BOLT
   * is a jagged sprite that pops only at the flash peak, hashed per
   * strike (shape, lean, height, a small azimuth wander), its foot
   * swallowed by the hills the way a real distant strike is. The
   * world-lift and fog kick live in scene.js as before; the clouds above
   * catch the flash near the strike's azimuth. */
  const boltGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softDisc(128, 0.02, 0.5, 0.9), fog: false, depthWrite: false,
    transparent: true, opacity: 0, blending: THREE.AdditiveBlending, color: 0xe6ecff,
  }));
  boltGlow.scale.set(1500, 620, 1);
  boltGlow.renderOrder = -18;
  scene.add(boltGlow);
  const boltTex = (k) => {
    const cv = document.createElement("canvas");
    cv.width = 96; cv.height = 256;
    const c = cv.getContext("2d");
    c.strokeStyle = "rgba(255,255,255,0.95)";
    c.lineWidth = 3;
    c.shadowColor = "rgba(200,220,255,0.9)";
    c.shadowBlur = 9;
    c.beginPath();
    let x = 48, y = 8;
    c.moveTo(x, y);
    for (let s = 1; s <= 7; s++) {
      x += (h01(k * 31 + s * 7) - 0.5) * 34;
      y = 8 + (240 * s) / 7;
      c.lineTo(x, y);
      /* one fork partway down */
      if (s === 3 + (k % 2)) {
        c.stroke();
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x + (h01(k * 17 + 5) - 0.5) * 60, y + 60 + h01(k * 13 + 9) * 40);
        c.lineWidth = 1.6;
        c.stroke();
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(x, y);
      }
    }
    c.stroke();
    return new THREE.CanvasTexture(cv);
  };
  const boltTexes = [boltTex(1), boltTex(2)];
  const bolt = new THREE.Sprite(new THREE.SpriteMaterial({
    map: boltTexes[0], fog: false, depthWrite: false, transparent: true,
    opacity: 0, blending: THREE.AdditiveBlending, color: 0xeef3ff,
  }));
  bolt.scale.set(150, 430, 1);
  bolt.renderOrder = -18;
  scene.add(bolt);
  let flashK = 0, lastLf = 0;
  let gustT = 0;   // the storm wind's clock (presentation only)

  // ---------------- double rainbow (celestial: snap.rainbow)
  /* Two banded ribbons on the dome, centred on the anti-solar point:
   * primary at 42°, secondary at 51° with the colours reversed and
   * fainter. Additive, so a vertex fades by darkening its colour —
   * which is also how the ends sink into the horizon. */
  const BOW_ARC = 40;
  const BOW_ROWS = [
    [1.0, 0.28, 0.22, 0.5], [1.0, 0.55, 0.16, 0.9], [1.0, 0.9, 0.28, 1.0],
    [0.38, 0.92, 0.42, 1.0], [0.3, 0.58, 1.0, 0.9], [0.58, 0.4, 1.0, 0.5],
  ];
  function makeBow(theta0, theta1, reversed, gain) {
    const rows = reversed ? BOW_ROWS.slice().reverse() : BOW_ROWS;
    const nR = rows.length;
    const pos = new Float32Array((BOW_ARC + 1) * nR * 3);
    const col = new Float32Array((BOW_ARC + 1) * nR * 3);
    const idx = [];
    for (let i = 0; i < BOW_ARC; i++) for (let r = 0; r < nR - 1; r++) {
      const a = i * nR + r, b = (i + 1) * nR + r;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0, fog: false, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    mesh.renderOrder = -17;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { mesh, rows, theta0, theta1, gain };
  }
  const bows = [makeBow(40.4, 42.6, false, 1), makeBow(50.2, 52.4, true, 0.38)];
  const bC = new THREE.Vector3(), bU1 = new THREE.Vector3(), bU2 = new THREE.Vector3(), bD = new THREE.Vector3();
  function updateBow(bow, sun, camPos, alpha) {
    bow.mesh.material.opacity = alpha * bow.gain;
    if (alpha <= 0.01) { bow.mesh.visible = false; return; }
    bow.mesh.visible = true;
    bow.mesh.position.copy(camPos);
    bC.set(-sun.x, -sun.y, -sun.z).normalize();
    bU1.set(0, 1, 0).cross(bC).normalize();
    if (bU1.lengthSq() < 1e-6) bU1.set(1, 0, 0);
    bU2.copy(bU1).cross(bC).normalize();
    if (bU2.y < 0) bU2.negate();
    const pos = bow.mesh.geometry.getAttribute("position");
    const col = bow.mesh.geometry.getAttribute("color");
    const nR = bow.rows.length;
    for (let i = 0; i <= BOW_ARC; i++) {
      const phi = (i / BOW_ARC - 0.5) * 2.5;
      const cp = Math.cos(phi), sp = Math.sin(phi);
      for (let r = 0; r < nR; r++) {
        const th = ((bow.theta0 + (bow.theta1 - bow.theta0) * (r / (nR - 1))) * Math.PI) / 180;
        const st = Math.sin(th), ct = Math.cos(th);
        bD.set(
          bC.x * ct + (bU2.x * cp + bU1.x * sp) * st,
          bC.y * ct + (bU2.y * cp + bU1.y * sp) * st,
          bC.z * ct + (bU2.z * cp + bU1.z * sp) * st
        );
        const k = i * nR + r;
        pos.setXYZ(k, bD.x * 2050, bD.y * 2050, bD.z * 2050);
        // sink into the horizon rather than stopping at it
        const hf = Math.max(0, Math.min(1, (bD.y + 0.02) / 0.1));
        const row = bow.rows[r];
        col.setXYZ(k, row[0] * row[3] * hf, row[1] * row[3] * hf, row[2] * row[3] * hf);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  // ---------------- cloud sea (celestial: snap.cloudSea / cloudSeaY)
  /* Depth-tested against the world, so ground above the layer shows and
   * ground below it is swallowed — a ridge top becomes an island. */
  const SEA_N = 20;
  const seaGeo = new THREE.PlaneGeometry(4800, 4800, SEA_N, SEA_N);
  const sea = new THREE.Mesh(seaGeo, new THREE.MeshBasicMaterial({
    color: 0xeef2f5, transparent: true, opacity: 0, fog: false, depthWrite: false,
  }));
  sea.rotation.x = -Math.PI / 2;
  sea.renderOrder = 2;
  sea.visible = false;
  scene.add(sea);
  const seaWhite = new THREE.Color(0xf6f8fa);
  let seaT = 0;

  // ---------------- aurora (celestial: snap.aurora / auroraT / auroraAz)
  /* Three curtains hung across one quarter of the sky: columns of light
   * with a sharp bright green base fading to violet at the top, waving on
   * the event's SIM clock (a fast-forwarded night lands mid-dance, and a
   * screenshot under virtual time actually catches it). Additive vertex
   * colours double as alpha, the same trick as the rainbow. */
  const AUR_COLS = 44, AUR_ROWS = 4;
  const AUR_ROWCOL = [
    [0.1, 0.85, 0.3, 0.7],     // the sharp lower edge
    [0.14, 0.95, 0.4, 1.0],    // brightest, just above it
    [0.22, 0.6, 0.48, 0.45],   // going teal
    [0.4, 0.2, 0.55, 0],       // violet, fading to sky
  ];
  function makeCurtain(gain) {
    const pos = new Float32Array(AUR_COLS * AUR_ROWS * 3);
    const col = new Float32Array(AUR_COLS * AUR_ROWS * 3);
    const idx = [];
    for (let i = 0; i < AUR_COLS - 1; i++) for (let r = 0; r < AUR_ROWS - 1; r++) {
      const a = i * AUR_ROWS + r, b = (i + 1) * AUR_ROWS + r;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0, fog: false, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    mesh.renderOrder = -18;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { mesh, gain };
  }
  const curtains = [makeCurtain(1), makeCurtain(0.6), makeCurtain(0.75)];

  // ---------------- headlights
  const poolTex = (() => {
    const cv = document.createElement("canvas");
    cv.width = 128; cv.height = 256;
    const c = cv.getContext("2d");
    // a forward cone: bright near the car, fanning out and fading ahead
    const g = c.createLinearGradient(0, 256, 0, 0);
    g.addColorStop(0, "rgba(255,225,170,0.0)");
    g.addColorStop(0.15, "rgba(255,225,170,0.55)");
    g.addColorStop(0.55, "rgba(255,225,170,0.28)");
    g.addColorStop(1, "rgba(255,225,170,0)");
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(48, 256); c.lineTo(80, 256); c.lineTo(128, 0); c.lineTo(0, 0); c.closePath();
    c.fill();
    return new THREE.CanvasTexture(cv);
  })();
  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 34),
    new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  pool.rotation.x = -Math.PI / 2;
  pool.renderOrder = 3;
  scene.add(pool);
  const noseLight = new THREE.PointLight(0xffe0b0, 0, 34, 1.4);
  scene.add(noseLight);
  const tailGlow = new THREE.PointLight(0xff5a3a, 0, 9, 2);
  scene.add(tailGlow);

  const tmp = new THREE.Vector3();
  const mP = new THREE.Vector3(), mD = new THREE.Vector3(), mSide = new THREE.Vector3(), mLong = new THREE.Vector3();

  function seatMeteor(slot, k, yaw) {
    slot.k = k;
    /* Most streaks fall in the sky the driver is actually looking at —
     * the rest anywhere, so a glance around still finds one. A shower
     * that performs only behind the car is a shower nobody sees. */
    const front = h01(k * 91 + 4) < 0.7;
    const az = front ? yaw + (h01(k * 31 + 5) - 0.5) * 2.2
      : radiantAz + (h01(k * 31 + 5) - 0.5) * 5.6;
    const el = 0.2 + h01(k * 53 + 9) * 0.62;
    const ce = Math.sqrt(1 - el * el);
    slot.P0.set(Math.cos(az) * ce, el, Math.sin(az) * ce);
    // away from the radiant, flattened onto the dome's tangent plane
    const rce = Math.sqrt(1 - 0.75 * 0.75);
    mD.set(Math.cos(radiantAz) * rce, 0.75, Math.sin(radiantAz) * rce);
    slot.D.copy(slot.P0).sub(mD);
    slot.D.addScaledVector(slot.P0, -slot.D.dot(slot.P0)).normalize();
    slot.P0.multiplyScalar(2200);
    slot.life = 0.5 + h01(k * 17 + 3) * 0.45;
    slot.speed = 500 + h01(k * 71 + 8) * 320;
  }

  /* per frame. snap = atmosphere snapshot; car in world coords; kit.anchor */
  function update(snap, car, world, dt, camPos, carKit) {
    const lampMats = carKit && carKit.lampMats ? carKit.lampMats : carKit;
    // a dead spot lamp is a dimmer night: the pool and the throw both fade
    const lampHealth = carKit && carKit.lampHealth != null ? carKit.lampHealth : 1;
    // stars — an eclipse brings a few of them out in the middle of the day
    stars.position.copy(camPos);
    stars.material.opacity = Math.max(
      snap.sky.stars * (1 - snap.overcast) * (1 - snap.fog),
      (snap.eclipse || 0) * 0.5 * (1 - snap.overcast)
    );

    // precipitation: in cold country the same scalar falls as snow
    const coldAmt = Math.max(0, Math.min(1, snap.snow || 0));
    const rainAmt = (snap.rain || 0) * (1 - coldAmt);
    const storm = snap.storm || 0;
    rain.material.opacity = Math.min(0.9, rainAmt * 1.0 + storm * 0.15);
    rain.material.size = 0.45 + rainAmt * 0.35 + storm * 0.3;
    if (rainAmt > 0.02) {
      /* the wind: a steady side drift in rain; in a storm it GUSTS — the
       * whole curtain leans and eases on a slow, uneven cycle, and the
       * drops come down faster (owner: storms should be felt) */
      gustT += dt;
      const gust = 1 + storm * (1.6 + 1.3 * Math.sin(gustT * 0.7 + Math.sin(gustT * 0.23) * 2.0));
      const windX = -Math.sin(car.yaw) * 0.6 * gust, windZ = Math.cos(car.yaw) * 0.6 * gust;   // side drift
      const fall = 1 + storm * 0.45;
      const carDX = Math.cos(car.yaw) * car.vx * dt, carDZ = Math.sin(car.yaw) * car.vx * dt;
      const arr = rainGeo.attributes.position.array;
      const live = Math.floor(N_RAIN * Math.min(1, rainAmt * 1.4 + storm * 0.2));
      for (let i = 0; i < N_RAIN; i++) {
        const o = i * 3;
        if (i >= live) { arr[o + 1] = -50; continue; }
        arr[o + 1] -= rainVel[i] * fall * dt;
        arr[o] += windX * dt * 4 - carDX * 0.15;
        arr[o + 2] += windZ * dt * 4 - carDZ * 0.15;
        if (arr[o + 1] < -3 || arr[o + 1] > 40) {
          arr[o] = (((i * 0.7548776662 + snap.u * 7) % 1) - 0.5) * 70;
          arr[o + 1] = 24 + ((i * 0.31) % 1) * 12;
          arr[o + 2] = (((i * 0.3247179572 + snap.u * 3) % 1) - 0.5) * 70;
        }
      }
      rainGeo.attributes.position.needsUpdate = true;
      rain.position.set(camPos.x, camPos.y - 8, camPos.z);
    }

    // snow: slow fall, sinusoidal side drift, recycled through a taller box
    const snowAmt = (snap.rain || 0) * coldAmt;
    snow.material.opacity = Math.min(0.9, snowAmt * 1.2);
    if (snowAmt > 0.02) {
      snowDriftT += dt;
      const carDX = Math.cos(car.yaw) * car.vx * dt, carDZ = Math.sin(car.yaw) * car.vx * dt;
      const arr = snowGeo.attributes.position.array;
      const live = Math.floor(N_SNOW * Math.min(1, snowAmt * 1.4));
      for (let i = 0; i < N_SNOW; i++) {
        const o = i * 3;
        if (i >= live) { arr[o + 1] = -50; continue; }
        arr[o + 1] -= snowVel[i] * dt;
        arr[o] += Math.sin(snowDriftT * 0.9 + i * 1.7) * dt * 1.6 - carDX * 0.1;
        arr[o + 2] += Math.cos(snowDriftT * 0.7 + i * 2.3) * dt * 1.6 - carDZ * 0.1;
        if (arr[o + 1] < -3 || arr[o + 1] > 30) {
          arr[o] = (((i * 0.7548776662 + snap.u * 7) % 1) - 0.5) * 64;
          arr[o + 1] = 20 + ((i * 0.31) % 1) * 8;
          arr[o + 2] = (((i * 0.3247179572 + snap.u * 3) % 1) - 0.5) * 64;
        }
      }
      snowGeo.attributes.position.needsUpdate = true;
      snow.position.set(camPos.x, camPos.y - 6, camPos.z);
    }

    // ---- meteors: streaks radiating from a hashed point on the dome
    const mp = snap.meteors || 0;
    for (const m of meteors) m.touched = false;
    if (mp > 0.02 && snap.meteorT != null) {
      if (!metWas) { radiantAz = h01(Math.floor(snap.u * 997) * 13 + 1) * Math.PI * 2; metWas = true; }
      const u = snap.meteorT;
      const kTop = Math.floor(u / MET_CADENCE) + 1;
      for (let k = Math.max(0, kTop - 3); k <= kTop; k++) {
        if (h01(k * 13 + 7) < 0.18) continue;              // misses: rhythm, not clockwork
        const t0 = k * MET_CADENCE + h01(k * 5 + 1) * 0.6;
        const life = 0.5 + h01(k * 17 + 3) * 0.45;
        if (u < t0 || u > t0 + life) continue;
        let slot = null, free = null;
        for (const m of meteors) { if (m.k === k) { slot = m; break; } if (m.k < 0 && !free) free = m; }
        if (!slot && free) { seatMeteor(free, k, car.yaw); slot = free; }
        if (!slot) continue;
        slot.touched = true;
        const age = u - t0;
        const a = Math.sin(Math.PI * Math.min(1, age / slot.life)) * mp * (1 - snap.overcast);
        slot.mesh.visible = a > 0.01;
        if (!slot.mesh.visible) continue;
        mP.copy(slot.P0).addScaledVector(slot.D, slot.speed * age);
        mD.copy(mP).normalize();
        mLong.copy(slot.D).multiplyScalar(170);
        mSide.copy(mD).cross(slot.D).multiplyScalar(6);
        slot.mesh.matrix.makeBasis(mLong, mSide, mD);
        slot.mesh.matrix.setPosition(tmp.copy(camPos).add(mP));
        slot.mesh.matrixWorldNeedsUpdate = true;   // manual matrix: three will not notice on its own
        slot.mesh.material.opacity = a * 0.9;
      }
    } else metWas = false;
    for (const m of meteors) if (!m.touched && m.k >= 0) { m.k = -1; m.mesh.visible = false; }

    // ---- clouds: cover from the weather, colour from the hour
    {
      const storm = Math.max(0, ((snap.rain || 0) - 0.6) / 0.4);
      const cover = Math.min(1, 0.14 + (snap.overcast || 0) * 0.95 + (snap.rain || 0) * 0.7);
      const liveN = Math.round(Math.min(N_CLOUD, cloudCap) * cover);
      const night = snap.sky.stars;
      cCloudLit.set(0xffffff).multiplyScalar(0.62 + 0.38 * snap.sky.ground);
      cCloudLit.lerp(cCloudTmp.set(0x99a1ab), Math.min(1, (snap.overcast || 0) * 0.9 + (snap.rain || 0) * 0.75));
      cCloudLit.lerp(cCloudTmp.set(0x3a414d), storm * 0.75);
      /* snowfall pales the bases back out — snow clouds are wool, not thunder */
      const snowyC = Math.min(snap.rain || 0, snap.snow || 0);
      if (snowyC > 0) cCloudLit.lerp(cCloudTmp.set(0xb9c0c7), snowyC * 0.7);
      if (night > 0.5) cCloudLit.multiplyScalar(0.28);
      const sunAz = Math.atan2(snap.sun.z, snap.sun.x);
      const lfC = snap.lightning || 0, lazC = snap.lightningAz || 0;
      const g = snap.golden || 0;
      for (let i = 0; i < clouds.length; i++) {
        const cl = clouds[i];
        cl.az += cl.drift * dt;
        const target = i < liveN ? cl.base * (1 - snap.fog * 0.92) * (1 - (snap.tunnel || 0)) : 0;
        cl.op = cloudsPrimed ? cl.op + (target - cl.op) * Math.min(1, dt / 2.4) : target;
        const m = cl.sp.material;
        m.opacity = cl.op;
        if (cl.op < 0.01) { cl.sp.visible = false; continue; }
        cl.sp.visible = true;
        cl.sp.position.set(
          camPos.x + Math.cos(cl.az) * cl.r,
          camPos.y + cl.r * cl.elev * (1 - storm * 0.22),
          camPos.z + Math.sin(cl.az) * cl.r
        );
        m.color.copy(cCloudLit);
        if (g > 0 && night < 0.5) {
          const d = Math.cos(cl.az - sunAz) * 0.5 + 0.5;
          m.color.lerp(cCloudTmp.set(snap.sky.sun), g * d * 0.45 * (1 - storm));
        }
        if (lfC > 0.02 && Math.abs(Math.atan2(Math.sin(cl.az - lazC), Math.cos(cl.az - lazC))) < 0.55) {
          m.color.lerp(cCloudTmp.set(0xdfe6f5), lfC * 0.7);
        }
      }
      cloudsPrimed = true;
    }

    // ---- distant lightning: glow behind the horizon, a bolt at the peak
    const lf = snap.lightning || 0;
    if (lf > 0.5 && lastLf <= 0.5) flashK++;   // one count per strike
    lastLf = lf;
    if (lf > 0.01) {
      const az = snap.lightningAz || 0;
      boltGlow.position.set(camPos.x + Math.cos(az) * 2400, camPos.y + 120 + lf * 60, camPos.z + Math.sin(az) * 2400);
      boltGlow.material.opacity = lf;
      const bOn = lf > 0.42 && h01(flashK * 7 + 2) > 0.35;   // not every strike shows its bolt
      if (bOn) {
        const az2 = az + (h01(flashK * 11 + 5) - 0.5) * 0.24;
        bolt.material.map = boltTexes[flashK % 2];
        bolt.scale.set(150 * (h01(flashK * 3 + 1) < 0.5 ? 1 : -1), 380 + h01(flashK * 13 + 3) * 120, 1);
        bolt.position.set(camPos.x + Math.cos(az2) * 2380, camPos.y + 60 + h01(flashK * 17 + 1) * 120, camPos.z + Math.sin(az2) * 2380);
        bolt.material.opacity = Math.min(1, (lf - 0.42) * 2.4);
      } else bolt.material.opacity = 0;
    } else { boltGlow.material.opacity = 0; bolt.material.opacity = 0; }

    // ---- double rainbow, anti-solar; fades as the sun climbs or cloud closes
    const rb = (snap.rainbow || 0)
      * Math.max(0, 1 - snap.overcast * 1.5)
      * Math.max(0, Math.min(1, (0.55 - snap.sun.elev) / 0.12))
      * Math.max(0, Math.min(1, (snap.sun.elev - 0.02) / 0.05));
    for (const bow of bows) updateBow(bow, snap.sun, camPos, rb * 0.62);

    // ---- cloud sea below an inversion
    const cs = snap.cloudSea || 0;
    if (cs > 0.01) {
      sea.visible = true;
      seaT += dt;
      sea.position.set(camPos.x, snap.cloudSeaY, camPos.z);
      const pos = seaGeo.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) + camPos.x, y = pos.getY(i) + camPos.z;
        pos.setZ(i, Math.sin(x * 0.004 + seaT * 0.06) * 3.2 + Math.cos(y * 0.0031 - seaT * 0.045) * 2.6);
      }
      pos.needsUpdate = true;
      // the sea wears the hour: fog-white by day, slate under stars
      sea.material.color.setHex(snap.sky.fog).lerp(seaWhite, 0.55 * snap.sky.ground);
      sea.material.opacity = 0.96 * cs;
    } else sea.visible = false;

    // ---- aurora: curtains of light, dancing on the event's sim clock.
    // The look is RAYS — brightness varies hard column to column, with
    // near-black gaps between them, and the curtain's ends fade out.
    // Three low-alpha curtains overlap; a single bright one saturates
    // additive blending into a flat green slab (it did).
    const au = (snap.aurora || 0) * (1 - snap.overcast) * Math.min(1, snap.sky.stars * 1.6);
    for (let c = 0; c < curtains.length; c++) {
      const cur = curtains[c];
      cur.mesh.visible = au > 0.01;
      cur.mesh.material.opacity = au * cur.gain * 0.28;
      if (!cur.mesh.visible) continue;
      cur.mesh.position.copy(camPos);
      const t = (snap.auroraT || 0) * (0.16 + c * 0.05);
      const az0 = (snap.auroraAz || 0) + (c - 1) * 0.55;
      const pos = cur.mesh.geometry.getAttribute("position");
      const col = cur.mesh.geometry.getAttribute("color");
      for (let i = 0; i < AUR_COLS; i++) {
        const f = i / (AUR_COLS - 1);
        const az = az0 + (f - 0.5) * (1.3 + c * 0.3)
          + Math.sin(f * 5 + t * 2.1 + c * 2) * 0.05
          + Math.sin(f * 11 - t * 1.3) * 0.025;
        const elBase = 0.27 + Math.sin(f * 2.3 + t * 0.8 + c) * 0.08;
        // rays: a squared sine so the peaks are narrow and the gaps are dark,
        // drifting along the curtain as the sky "dances"
        const ray = Math.pow(0.5 + 0.5 * Math.sin(f * 23 + t * 2.7 + c * 3.1), 2.2);
        const swell = 0.6 + 0.4 * Math.sin(f * 4.7 - t * 1.1 + c * 1.7);
        const endFade = Math.min(1, Math.min(f, 1 - f) / 0.12);
        const bright = (0.18 + 0.82 * ray) * swell * endFade * endFade;
        for (let r = 0; r < AUR_ROWS; r++) {
          const el = elBase + (r / (AUR_ROWS - 1)) * (0.3 + 0.1 * ray + 0.04 * Math.sin(f * 4 - t));
          const ce = Math.sqrt(Math.max(0, 1 - el * el));
          const k = i * AUR_ROWS + r;
          pos.setXYZ(k, Math.cos(az) * ce * 2100, el * 2100, Math.sin(az) * ce * 2100);
          const row = AUR_ROWCOL[r];
          const a = row[3] * bright;
          col.setXYZ(k, row[0] * a, row[1] * a, row[2] * a);
        }
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }

    /* Headlights: on from dusk to dawn, in heavy weather — and inside a
     * tunnel, which is the moment they stop being scenery and start being
     * the thing you are steering by. Stars and rain stop at the portal. */
    const encl = snap.tunnel || 0;
    if (encl > 0) {
      stars.material.opacity *= 1 - encl;
      rain.material.opacity *= 1 - encl;
      snow.material.opacity *= 1 - encl;
      for (const cur of curtains) cur.mesh.material.opacity *= 1 - encl;
    }
    const dark = Math.max(0, Math.min(1, (0.55 - snap.sky.ground) / 0.35));
    const lights = Math.max(dark, encl, snap.fog * 0.6, snap.rain * 0.4, snap.overcast * 0.2 * dark);
    const fx = Math.cos(car.yaw), fz = Math.sin(car.yaw);
    const ax = kit.anchor.x, az = kit.anchor.z;
    if (lights > 0.02) {
      const g = world.groundHeight(car.x + fx * 15, car.z + fz * 15, car.s);
      pool.position.set(car.x - ax + fx * 17, (g ? g.y : car.y) + 0.12, car.z - az + fz * 17);
      pool.rotation.z = -car.yaw + Math.PI / 2;
      pool.material.opacity = lights * 0.9 * lampHealth;
      noseLight.position.set(car.x - ax + fx * 4, car.y + 1.0, car.z - az + fz * 4);
      noseLight.intensity = lights * 2.4 * lampHealth;
      tailGlow.position.set(car.x - ax - fx * 2.4, car.y + 0.6, car.z - az - fz * 2.4);
      tailGlow.intensity = dark * (car.brake > 0.2 ? 0.7 : 0.18);
    } else {
      pool.material.opacity = 0;
      noseLight.intensity = 0;
      tailGlow.intensity = 0;
    }
    if (lampMats) {
      lampMats.lamp.emissive.setHex(0xfff0c0).multiplyScalar(lights);
      lampMats.tail.emissive.setHex(0xff3a20).multiplyScalar(Math.max(lights * 0.6, car.brake > 0.2 ? 0.9 : 0));
    }
    /* A cracked screen is a scratch by day and a GLARE by night: the crack
     * catches whatever light the car is making — a soft star that flickers
     * with the road. Driven by the sim tick, so screenshots are honest. */
    if (carKit && carKit.crackGlare) {
      const cracked = carKit.crack && carKit.crack[0].visible;
      const on = cracked && lights > 0.05;
      carKit.crackGlare.visible = !!on;
      if (on) {
        const flick = 0.65 + 0.35 * Math.sin(car.tick * 0.23) * Math.sin(car.tick * 0.071);
        carKit.glintMat.opacity = 0.38 * lights * flick;
      }
      if (carKit.crackMat) carKit.crackMat.emissive.setHex(0xcfe0e6).multiplyScalar(cracked ? lights * 0.5 : 0);
    }
    return lights;
  }

  function setCloudCap(n) { cloudCap = Math.max(8, Math.min(N_CLOUD, n | 0)); }

  return { update, setCloudCap };
}
