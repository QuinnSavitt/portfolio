/* Overcrest — scene, sky and backdrop.
 *
 * The world renders in an anchored frame: sim coordinates are float64 and
 * grow forever, so every mesh is placed at (world − anchor) and the anchor
 * re-snaps to a 256 m grid as the car travels. Rebasing shifts a handful
 * of group positions — geometry is never rebuilt for precision.
 *
 * Sky is a vertex-graded dome (zenith → horizon band), with a sun disc,
 * layered ridge silhouettes and a far floor — all following the camera,
 * all recolorable for time-of-day (Phase 6 will drive them).
 */

import * as THREE from "three";

export function makeScene(canvas, palette) {
  /* high-performance: on a dual-GPU laptop the browser must wake the real
   * one — the integrated chip is exactly the machine the quality ladder
   * exists for, but only when it is the only machine there is */
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(palette.fog, 140, 700);

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 4200);

  // ---- lights
  const hemi = new THREE.HemisphereLight(palette.hemiSky, palette.hemiGround, palette.hemiInt);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(palette.sun, palette.sunInt);
  sun.position.set(-260, 340, 160);
  scene.add(sun);
  /* Sun-side rim (7a.3 "light it properly"): a second directional at the
   * sun's azimuth but held grazing-low, so at the golden hours the sun-side
   * faces of trees, crests and the car catch a warm edge the high Lambert
   * sun cannot give them. Gated on snap.golden — noon and night keep the
   * signed-off look; weather and bores stand it down. */
  const rim = new THREE.DirectionalLight(0xffc890, 0);
  rim.position.set(-300, 26, 180);
  scene.add(rim);

  /* Height fog (7a.3): the air lies in the low ground. One shared uniform
   * block feeds every material chunks.js opts in (terrain, road, props,
   * spans): ground below the driver's own level leans toward the fog
   * colour with distance — a depth cue that makes a valley read as AIR,
   * not a weather front (fronts still come from the atmosphere). The same
   * patch gives the distance fog a gentler curve (pow 0.88), so the
   * terrain blanket's edge dissolves instead of cutting. */
  const HF = {
    uHFLevel: { value: -4 },      // world Y where the haze begins (driver level − 4)
    uHFDepth: { value: 30 },      // fully hazed this far below the level
    uHFAmount: { value: 0.3 },    // ceiling, driven by time + weather
    uHFNear: { value: 90 },       // no haze inside this distance (the near field stays crisp)
    uHFFar: { value: 430 },
  };
  // `?matfx=0` — judge the 7a.3 materials pass against the old flat look
  const MATFX = new URLSearchParams(location.search).get("matfx") !== "0";
  function enableHeightFog(mat) {
    if (!MATFX) return mat;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, HF);
      shader.vertexShader = shader.vertexShader
        .replace("#include <fog_pars_vertex>",
          "#include <fog_pars_vertex>\n#ifdef USE_FOG\nvarying float vHeightFog;\nuniform float uHFLevel, uHFDepth, uHFAmount, uHFNear, uHFFar;\n#endif")
        .replace("#include <fog_vertex>",
          "#include <fog_vertex>\n#ifdef USE_FOG\n{\n  vec4 hfP = vec4( transformed, 1.0 );\n  #ifdef USE_INSTANCING\n    hfP = instanceMatrix * hfP;\n  #endif\n  hfP = modelMatrix * hfP;\n  float hfBelow = smoothstep( uHFLevel, uHFLevel - uHFDepth, hfP.y );\n  float hfDist = smoothstep( uHFNear, uHFFar, vFogDepth );\n  vHeightFog = hfBelow * hfDist * uHFAmount;\n}\n#endif");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <fog_pars_fragment>",
          "#include <fog_pars_fragment>\n#ifdef USE_FOG\nvarying float vHeightFog;\n#endif")
        .replace("#include <fog_fragment>",
          "#ifdef USE_FOG\n  float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );\n  fogFactor = max( pow( fogFactor, 0.88 ), vHeightFog );\n  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );\n#endif");
    };
    mat.customProgramCacheKey = () => "hfog1";
    return mat;
  }

  /* ---- sky dome: shaded per PIXEL now, not per vertex. The old dome was
   * ~350 vertex colours re-lerped on the CPU every third frame and it
   * banded badly at dusk; the shader draws the same two-stop gradient
   * (identical mapping, so every palette and weather tint carries over)
   * and then earns the redraw: light gathers around the sun the way air
   * actually scatters it, a low sun raises the earth's shadow and the
   * belt of Venus on the far horizon, and on high detail a clear night
   * gets a milky way with a dark rift, a powder of faint stars between
   * the named ones, and airglow over the hills. Dithered, so the sky is
   * a gradient and never a staircase. All of it reads the same
   * atmosphere snapshot the rest of the frame does. */
  const skyU = {
    uTop: { value: new THREE.Color(palette.skyTop) },
    uHor: { value: new THREE.Color(palette.skyHor) },
    uFog: { value: new THREE.Color(palette.fog) },
    uSunDir: { value: new THREE.Vector3(-0.62, 0.7, 0.4).normalize() },
    uSunCol: { value: new THREE.Color(0xfff2d9) },
    uAntiDir: { value: new THREE.Vector3(0.84, 0, -0.54).normalize() },
    uBeltCol: { value: new THREE.Color(0xd9927f) },
    uShadCol: { value: new THREE.Color(0x47547a) },
    uGlowK: { value: 0.15 }, uHaloK: { value: 0.2 }, uBeltK: { value: 0 },
    uNightK: { value: 0 }, uEclK: { value: 0 }, uHorFogK: { value: 0.5 },
    uDetail: { value: 2 },
  };
  const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
  const SKY_FRAG = `
varying vec3 vDir;
uniform vec3 uTop, uHor, uFog, uSunCol, uSunDir, uAntiDir, uBeltCol, uShadCol;
uniform float uGlowK, uHaloK, uBeltK, uNightK, uEclK, uHorFogK, uDetail;

float h21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float vn2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x),
             mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
  vec3 d = normalize(vDir);
  // the same two-stop mapping the vertex dome used — the baseline look
  float t = clamp((d.y + 0.06) * 1.9, 0.0, 1.0);
  vec3 col = mix(uHor, uTop, pow(t, 0.72));
  // the crown keeps its depth instead of washing flat
  col = mix(col, uTop * vec3(0.86, 0.9, 1.03), smoothstep(0.5, 1.0, t) * 0.45);
  // the rim seats into the air: the horizon leans to the fog line
  col = mix(col, uFog, smoothstep(0.12, -0.06, d.y) * uHorFogK);

  // forward scatter: the sky brightens around the sun, most near the horizon
  float sunAmt = max(dot(d, uSunDir), 0.0);
  float horiz = 1.0 - t;
  col += uSunCol * pow(sunAmt, 3.0) * (0.35 + 0.65 * horiz * horiz) * uGlowK;
  col += uSunCol * pow(sunAmt, 32.0) * uHaloK;

  // the far side of a low sun: earth's shadow, the belt of Venus above it
  float aAmt = pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), uAntiDir), 0.0), 5.0);
  col = mix(col, uBeltCol, exp(-pow((d.y - 0.055) * 16.0, 2.0)) * aAmt * uBeltK);
  col = mix(col, uShadCol, exp(-pow((d.y - 0.008) * 22.0, 2.0)) * aAmt * uBeltK * 0.85);

  // an eclipse is dusk on every horizon at once
  col += uBeltCol * exp(-pow((d.y - 0.02) * 14.0, 2.0)) * uEclK * 0.4;

  if (uNightK > 0.004) {
    // airglow: the green breath just over the hills on a deep clear night
    col += vec3(0.09, 0.15, 0.12) * exp(-pow((d.y - 0.06) * 11.0, 2.0)) * uNightK * 0.35;
    if (uDetail > 1.5) {
      // the milky way: a tilted band of cloud-fine light with a dark rift
      float bandD = dot(d, vec3(0.3524, 0.2819, 0.8961));
      float band = exp(-pow(bandD * 3.6, 2.0));
      if (band > 0.01) {
        vec2 mw = vec2(dot(d, vec3(-0.9306, 0.0, 0.3660)), dot(d, vec3(0.1029, -0.9597, 0.2615)));
        float n = vn2(mw * 6.0) * 0.55 + vn2(mw * 14.0) * 0.30 + vn2(mw * 29.0) * 0.15;
        float rift = 1.0 - 0.7 * exp(-pow((bandD + 0.05) * 10.0, 2.0)) * smoothstep(0.2, 0.6, vn2(mw * 3.1 + 7.3));
        float mwA = band * (0.2 + 0.8 * n) * rift * uNightK;
        col += vec3(0.40, 0.47, 0.60) * mwA * 0.42;
        col += vec3(0.55, 0.47, 0.40) * mwA * mwA * 0.34;
      }
      // star dust: a powder of faint suns between the named stars
      vec2 cell = floor(d.xz * 720.0) + floor((d.y + 1.0) * 720.0) * vec2(0.618, 0.318);
      float sh = h21(cell);
      float dust = step(0.9982, sh) * (0.35 + 0.65 * h21(cell + 3.7));
      col += vec3(0.75, 0.8, 0.95) * dust * uNightK * 0.6 * smoothstep(0.0, 0.12, d.y);
    }
  }

  // dither: an 8-bit gradient dies by banding without it
  col += (h21(gl_FragCoord.xy) - 0.5) * 0.008;
  gl_FragColor = vec4(col, 1.0);
}`;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(2600, 24, 14), new THREE.ShaderMaterial({
    uniforms: skyU, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    side: THREE.BackSide, depthWrite: false,
  }));
  sky.renderOrder = -20;
  sky.frustumCulled = false;
  scene.add(sky);

  // sun disc: a soft billboard high in the sky
  const sunSpriteTex = (() => {
    const cv = document.createElement("canvas");
    cv.width = 128; cv.height = 128;
    const c = cv.getContext("2d");
    const g = c.createRadialGradient(64, 64, 6, 64, 64, 62);
    g.addColorStop(0, "rgba(255,246,224,1)");
    g.addColorStop(0.25, "rgba(255,240,200,0.85)");
    g.addColorStop(1, "rgba(255,236,190,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(cv);
  })();
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sunSpriteTex, fog: false, depthWrite: false, depthTest: false, transparent: true,
  }));
  sunSprite.scale.setScalar(520);
  sunSprite.renderOrder = -19;
  scene.add(sunSprite);
  /* the halo: a much larger, much fainter breath of the same light behind
   * the disc — it earns its keep at the golden hours, when the low sun
   * should own a QUARTER of the sky, and stands down at noon */
  const sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sunSpriteTex, fog: false, depthWrite: false, depthTest: false, transparent: true, opacity: 0,
  }));
  sunHalo.scale.setScalar(1500);
  sunHalo.renderOrder = -20;
  scene.add(sunHalo);

  /* eclipse corona: a dark disc with a thin bright rim, laid over the sun
   * near totality (the celestial system drives snap.eclipse) */
  const coronaTex = (() => {
    const cv = document.createElement("canvas");
    cv.width = 128; cv.height = 128;
    const c = cv.getContext("2d");
    const g = c.createRadialGradient(64, 64, 26, 64, 64, 62);   // outer glow
    g.addColorStop(0, "rgba(235,240,255,0.85)");
    g.addColorStop(0.35, "rgba(220,228,255,0.3)");
    g.addColorStop(1, "rgba(210,220,255,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
    c.fillStyle = "rgba(8,10,20,0.96)";                          // the moon
    c.beginPath(); c.arc(64, 64, 27, 0, Math.PI * 2); c.fill();
    return new THREE.CanvasTexture(cv);
  })();
  const corona = new THREE.Sprite(new THREE.SpriteMaterial({
    map: coronaTex, fog: false, depthWrite: false, depthTest: false, transparent: true, opacity: 0,
  }));
  corona.scale.setScalar(240);
  corona.renderOrder = -19;
  scene.add(corona);

  // ---- ridge silhouettes: two rings of jagged strips, far and farther
  function ridgeRing(radius, height, color, seedMul) {
    const SEG = 96;
    const posArr = [], idxArr = [];
    // integer harmonics so the ring closes on itself without a seam
    const f1 = Math.round(3 * seedMul), f2 = Math.round(8 * seedMul), f3 = Math.round(15 * seedMul);
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      // deterministic jaggedness (cosmetic only — not part of the sim)
      const n = Math.sin(a * f1 + seedMul * 11) * 0.5
        + Math.sin(a * f2 + seedMul * 29) * 0.3
        + Math.sin(a * f3 + seedMul * 47) * 0.2;
      const h = height * (0.55 + 0.45 * n);
      const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
      posArr.push(x, -40, z, x, h, z);
    }
    for (let i = 0; i < SEG; i++) {
      const b = i * 2;
      idxArr.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(posArr, 3));
    g.setIndex(idxArr);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, fog: false, depthWrite: true, side: THREE.DoubleSide }));
    m.renderOrder = -15;
    return m;
  }
  const ridgeFar = ridgeRing(2200, 300, palette.ridgeFar, 1.0);
  const ridgeNear = ridgeRing(1500, 210, palette.ridgeNear, 1.7);
  scene.add(ridgeFar, ridgeNear);

  // far floor: the world beyond the streamed terrain
  const farFloor = new THREE.Mesh(
    new THREE.CircleGeometry(2400, 40),
    new THREE.MeshBasicMaterial({ color: palette.farFloor, fog: false })
  );
  farFloor.rotation.x = -Math.PI / 2;
  farFloor.renderOrder = -18;
  scene.add(farFloor);

  // ---- render anchor
  const anchor = new THREE.Vector3(0, 0, 0);
  const listeners = [];

  function updateAnchor(carX, carZ) {
    const snap = 256;
    const ax = Math.floor(carX / snap) * snap;
    const az = Math.floor(carZ / snap) * snap;
    if (ax !== anchor.x || az !== anchor.z) {
      const dx = ax - anchor.x, dz = az - anchor.z;
      anchor.set(ax, 0, az);
      for (const fn of listeners) fn(dx, dz, anchor);
    }
  }

  /* backdrop follows the camera (in render space) each frame */
  let sunV = { x: -0.62, y: 0.7, z: 0.4 };
  function updateBackdrop(camPos, groundY) {
    // the haze level rides the road: ground below your own level is "low"
    HF.uHFLevel.value = groundY - 4;
    sky.position.copy(camPos);
    ridgeFar.position.set(camPos.x, groundY - 30, camPos.z);
    ridgeNear.position.set(camPos.x, groundY - 26, camPos.z);
    farFloor.position.set(camPos.x, groundY - 22, camPos.z);
    sunSprite.position.set(camPos.x + sunV.x * 2000, camPos.y + Math.max(-120, sunV.y * 2000), camPos.z + sunV.z * 2000);
    sunHalo.position.copy(sunSprite.position);
    corona.position.copy(sunSprite.position);
  }

  /* ---- atmosphere: repaint sky/fog/lights from a time+weather snapshot */
  const cTop = new THREE.Color(), cHor = new THREE.Color(), cFog = new THREE.Color(), cTmp = new THREE.Color();
  const cRidgeNear = new THREE.Color(palette.ridgeNear), cRidgeFar = new THREE.Color(palette.ridgeFar), cFloor = new THREE.Color(palette.farFloor);
  const cGrey = new THREE.Color(0x9aa3aa);
  function applyAtmosphere(snap, pal) {
    pal = pal || palette;
    cRidgeNear.set(pal.ridgeNear); cRidgeFar.set(pal.ridgeFar); cFloor.set(pal.farFloor);
    const s = snap.sky;
    cTop.set(s.top); cHor.set(s.hor); cFog.set(s.fog);
    // overcast flattens and greys the sky; fog pulls everything to the fog colour
    if (snap.overcast > 0) {
      cTmp.copy(cGrey).multiplyScalar(0.55 + 0.45 * s.ground);
      cTop.lerp(cTmp, snap.overcast * 0.75);
      cHor.lerp(cTmp, snap.overcast * 0.55);
      cFog.lerp(cTmp, snap.overcast * 0.6);
    }
    /* the AURA half of the weather (hands-on #5): rain settles the whole
     * sky into blue-grey — before this, it rained out of untouched blue —
     * deep rain is a STORM and turns it slate, and snowfall goes the
     * other way entirely: milky, bright-ish, light from everywhere. All
     * three ride weather fields that blend across 40 s fronts, so the sky
     * FADES between states the way weather actually arrives. */
    const storm = Math.max(0, ((snap.rain || 0) - 0.6) / 0.4);
    if (snap.rain > 0) {
      const snowy = Math.min(snap.rain, snap.snow || 0);
      cTmp.setHex(0x5a6470).multiplyScalar(0.5 + 0.5 * s.ground);
      cTop.lerp(cTmp, snap.rain * 0.5);
      cHor.lerp(cTmp, snap.rain * 0.34);
      cFog.lerp(cTmp, snap.rain * 0.3);
      if (storm > 0) {
        cTmp.setHex(0x39404c).multiplyScalar(0.45 + 0.55 * s.ground);
        cTop.lerp(cTmp, storm * 0.55);
        cHor.lerp(cTmp, storm * 0.4);
        cFog.lerp(cTmp, storm * 0.35);
      }
      if (snowy > 0) {
        cTmp.setHex(0xccd3d9).multiplyScalar(0.5 + 0.5 * s.ground);
        cTop.lerp(cTmp, snowy * 0.5);
        cHor.lerp(cTmp, snowy * 0.55);
        cFog.lerp(cTmp, snowy * 0.45);
      }
    }
    if (snap.fog > 0) { cTop.lerp(cFog, snap.fog * 0.85); cHor.lerp(cFog, snap.fog * 0.9); }
    /* An eclipse is not night: it is a wrong, silver-slate dark that falls
     * in the middle of the day, with the horizon still faintly lit all the
     * way round. The celestial system hands us how deep in we are. */
    const ecl = snap.eclipse || 0;
    if (ecl > 0) {
      cTop.lerp(cTmp.setHex(0x1c2340), ecl * 0.88);
      cHor.lerp(cTmp.setHex(0x545070), ecl * 0.72);
      cFog.lerp(cTmp.setHex(0x2a3050), ecl * 0.6);
    }

    // (the dome reads cTop/cHor/cFog as uniforms — written at the end,
    // once night, golden and the bore are known)
    // fog: distance shrinks with fog banks and a little at night
    scene.fog.color.copy(cFog);
    const clear = 1 - snap.fog * 0.82 - snap.rain * 0.25 - snap.overcast * 0.12 - storm * 0.14;
    scene.fog.near = 30 + 110 * Math.max(0.05, clear);
    scene.fog.far = 220 + 480 * Math.max(0.05, clear);
    // lights
    sunV = snap.sun;
    const sunUp = Math.max(0.03, snap.sun.y);
    sun.color.set(s.sun);
    sun.intensity = s.k * (1 - snap.overcast * 0.55) * (1 - snap.fog * 0.5) * (1 - snap.rain * 0.3) * (1 - storm * 0.35) * (1 - 0.93 * ecl);
    sun.position.set(sunV.x * 300, Math.max(30, sunV.y * 300), sunV.z * 300);
    hemi.intensity = s.amb * (1 + snap.overcast * 0.25) * (1 - snap.fog * 0.15) * (1 - storm * 0.22) * (1 - 0.55 * ecl);
    hemi.color.copy(cTop).lerp(cHor, 0.4);
    hemi.groundColor.set(pal.hemiGround).multiplyScalar(0.4 + 0.6 * s.ground);
    // a distant strike lifts the whole world for a frame or two
    const lf = snap.lightning || 0;
    if (lf > 0) {
      hemi.intensity += lf * 0.45;
      scene.fog.color.lerp(cTmp.setHex(0xbfc9de), lf * 0.35);
    }
    // sun/moon disc
    const night = s.stars;
    sunSprite.material.color.set(night > 0.5 ? 0xdde6f2 : s.sun);
    sunSprite.material.opacity = sunUp > 0.05 || night > 0.5 ? (1 - snap.overcast * 0.9) * (1 - snap.fog * 0.95) : 0;
    sunSprite.scale.setScalar(night > 0.5 ? 220 : 520);
    // the sun goes out near totality; the corona takes its place
    sunSprite.material.opacity *= 1 - 0.88 * ecl;
    /* the halo lives at the golden hours: low warm sun spreads across a
     * quarter of the sky, and at noon or in weather it stands down */
    const golden = snap.golden || 0;
    sunHalo.material.color.set(s.sun);
    sunHalo.material.opacity = sunSprite.material.opacity * golden * 0.34 * (night > 0.5 ? 0 : 1);
    corona.material.opacity = Math.max(0, (ecl - 0.55) / 0.45) * (1 - snap.overcast * 0.8) * (sunUp > 0.05 ? 1 : 0);
    if (night > 0.5) sunV = { x: -snap.sun.x, y: -snap.sun.y, z: -snap.sun.z };   // the moon opposite the sun
    /* Inside a tunnel the sun does not reach you. The sky dome is occluded
     * by the bore anyway, so what actually sells it is the light going out
     * of the world: the sun folds away, the ambient collapses to a dim
     * cool bounce off concrete, and the fog closes right in so the far end
     * is a small bright hole rather than a corridor to the horizon. */
    const encl = snap.tunnel || 0;
    if (encl > 0) {
      sun.intensity *= 1 - 0.94 * encl;
      hemi.intensity = hemi.intensity * (1 - 0.82 * encl) + 0.1 * encl;
      hemi.color.lerp(cTmp.setHex(0x6e6f74), encl * 0.85);
      hemi.groundColor.lerp(cTmp.setHex(0x2a2a2c), encl * 0.8);
      scene.fog.color.lerp(cTmp.setHex(0x161719), encl * 0.9);
      scene.fog.near = scene.fog.near * (1 - encl) + 8 * encl;
      scene.fog.far = scene.fog.far * (1 - encl) + 115 * encl;
      // the sun sprite ignores depth on purpose (it is a backdrop), which
      // would hang it in front of the roof — take it away by hand
      sunSprite.material.opacity *= 1 - encl;
      sunHalo.material.opacity *= 1 - encl;
    }
    /* the rim rides the sun's azimuth, held low; the height fog deepens
     * at the golden hours and in wet air, thins a little at night, and
     * stands down entirely in a bore */
    rim.color.set(s.sun);
    rim.intensity = (MATFX ? 1 : 0) * s.k * golden * 0.42 * (1 - snap.overcast * 0.8) * (1 - snap.fog * 0.85)
      * (1 - snap.rain * 0.5) * (1 - encl) * (night > 0.5 ? 0 : 1);
    rim.position.set(sunV.x * 300, 26, sunV.z * 300);
    const hfA = 0.3 + golden * 0.3 + snap.fog * 0.4 + snap.rain * 0.18 + snap.overcast * 0.08;
    HF.uHFAmount.value = Math.min(0.8, hfA) * (1 - encl) * (1 - 0.3 * night);
    // backdrop tints toward the fog/horizon
    const haze = Math.min(1, snap.fog * 1.1 + snap.rain * 0.3);
    ridgeFar.material.color.copy(cRidgeFar).multiplyScalar(0.3 + 0.7 * s.ground).lerp(cFog, Math.min(1, 0.45 + haze * 0.7));
    ridgeNear.material.color.copy(cRidgeNear).multiplyScalar(0.3 + 0.7 * s.ground).lerp(cFog, Math.min(1, 0.25 + haze * 0.85));
    farFloor.material.color.copy(cFloor).multiplyScalar(0.25 + 0.75 * s.ground).lerp(cFog, Math.min(1, 0.5 + haze * 0.6));
    /* ---- the dome's uniforms, written once everything is known. The
     * scatter and halo crossfade from sun to moon around the night line so
     * neither pops; cloud, fog, a bore and totality all stand them down. */
    {
      const U = skyU;
      U.uTop.value.copy(cTop); U.uHor.value.copy(cHor); U.uFog.value.copy(cFog);
      U.uSunDir.value.set(sunV.x, sunV.y, sunV.z).normalize();
      const clearK = Math.max(0, (1 - snap.overcast * 0.85) * (1 - snap.fog * 0.9) * (1 - 0.9 * ecl) * (1 - encl));
      const dayK = Math.max(0, 1 - night * 2);
      const moonK = Math.max(0, (night - 0.5) * 2);
      if (night > 0.5) U.uSunCol.value.setHex(0x9fb2d6); else U.uSunCol.value.set(s.sun);
      U.uGlowK.value = ((0.10 + golden * 0.5) * dayK + 0.10 * moonK) * clearK;
      U.uHaloK.value = ((0.16 + golden * 0.3) * dayK + 0.12 * moonK) * clearK;
      // the far side of a low sun: earth's shadow with the belt above it
      U.uAntiDir.value.set(-snap.sun.x, 0, -snap.sun.z).normalize();
      U.uBeltK.value = golden * clearK * 0.55 * dayK;
      U.uBeltCol.value.setHex(0xd9927f).lerp(cHor, 0.35);
      U.uShadCol.value.setHex(0x47547a).lerp(cTop, 0.3);
      U.uNightK.value = Math.max(0, (night - 0.35) / 0.65) * clearK;
      U.uEclK.value = ecl * (1 - snap.overcast * 0.8);
      U.uHorFogK.value = Math.min(0.85, 0.5 + snap.fog * 0.35 + haze * 0.1);
    }
    return { night, fogCol: cFog };
  }

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);

  /* the quality ladder's hand on the dome: 2 = the full night sky
   * (milky way, star dust), 1 = scatter and belt only — the expensive
   * pixels are the noise taps, and only where night actually shows them */
  function setSkyDetail(n) { skyU.uDetail.value = n; }

  return {
    renderer, scene, camera, sun, hemi, anchor,
    updateAnchor, updateBackdrop, applyAtmosphere, resize, enableHeightFog, setSkyDetail,
    onRebase: (fn) => listeners.push(fn),
  };
}
