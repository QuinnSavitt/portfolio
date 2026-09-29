/* Overcrest — the look.
 *
 * The geometry is flat-shaded and low-poly on purpose and that is not
 * changing; what makes a frame worth keeping is the LIGHT on it. This is a
 * small hand-rolled post chain — the vendored three is core-only, no
 * addons — that does the four things that carry a rally photograph:
 *
 *   bloom      the sun, the lamps, wet tarmac and snow bleed a little, the
 *              way an exposure set for the road always does
 *   grade      a filmic shoulder instead of a linear clip, so bright sky
 *              rolls off rather than flattening into paper
 *   vignette   the eye goes to the road
 *   grain      one part in two hundred of noise, which is the difference
 *              between "3D render" and "photograph of a place"
 *
 * Three passes at half resolution for the blur, one composite at full.
 * Everything is a fullscreen triangle; no dependencies beyond THREE core.
 *
 * The grade is deliberately cool in the shadows and warm in the lights —
 * the Overcrest palette is amber against grey-green, and the tone curve
 * should be pushing that, not fighting it.
 */

import * as THREE from "three";

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/* Bright-pass: keep what is above the knee, softly, and keep its colour. */
const BRIGHT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // soft knee so a bright road edge does not pop in and out between frames
  float t = clamp((l - uThreshold) / max(uKnee, 1e-4), 0.0, 1.0);
  gl_FragColor = vec4(c * t * t, 1.0);
}`;

/* Separable 9-tap gaussian, run twice (x then y). */
const BLUR = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uDir;
void main() {
  vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
  sum += texture2D(tDiffuse, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  sum += texture2D(tDiffuse, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  sum += texture2D(tDiffuse, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  sum += texture2D(tDiffuse, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}`;

const COMPOSITE = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uExposure;
uniform float uSat;
uniform vec3 uLift;
uniform vec3 uGain;

// cheap hash grain. no texture, no bandwidth
float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  c += texture2D(tBloom, vUv).rgb * uBloom;

  c *= uExposure;

  /* Soft shoulder, and ONLY a shoulder. A full Reinhard curve compresses
   * the midtones too, which drains a palette that was chosen deliberately
   *. the greens went grey the first time. Below the knee this is exactly
   * the colour the artist lit; above it, highlights roll off instead of
   * clipping, so a bright sky keeps its gradient behind the ridges. */
  const float K = 0.70;
  vec3 over = max(c - K, 0.0);
  c = min(c, K) + (1.0 - K) * (1.0 - exp(-over / (1.0 - K)));

  // lift/gain: cool the shadows, warm the lights. the Overcrest palette
  c = uLift + c * (uGain - uLift);

  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat);

  // vignette, on the diagonal so wide screens do not get a letterbox
  vec2 q = vUv - 0.5;
  float v = 1.0 - dot(q, q) * uVignette;
  c *= clamp(v, 0.0, 1.0);

  // grain, scaled down in the highlights where it would look like dirt
  float g = hash(vUv * 1024.0 + fract(uTime) * 91.7) - 0.5;
  c += g * uGrain * (1.0 - l * 0.7);

  c = clamp(c, 0.0, 1.0);
  /* Linear → sRGB, by hand. Three applies the output transform when it
   * renders to the canvas, but not for a RawShaderMaterial writing there
   * itself. miss this and the whole game renders like late dusk at noon,
   * which is exactly how it looked the first time. */
  c = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  gl_FragColor = vec4(c, 1.0);
}`;

function fullscreenQuad(material) {
  // a single oversized triangle: no seam down the middle, one less vertex
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  return new THREE.Mesh(g, material);
}

export function makePost(renderer, scene, camera) {
  const size = new THREE.Vector2();
  /* MSAA on the scene target. The canvas's own `antialias: true` only
   * covers the direct-render fallback — with the post chain on, the scene
   * draws into this target, and without samples every polygon edge in the
   * game was a staircase: terrain silhouettes, the road's high-contrast
   * edge, parapets. The quality ladder drives `samples` (4 where the GPU
   * can afford it, 0 on the eco floor) and `scale` — the 3D frame can
   * render at a fraction of the canvas and be composited back up at full
   * resolution, so the HUD and the grade stay crisp while the raster cost
   * falls with the square of the scale. WebGL1 gets byte targets and no
   * MSAA: the look survives, the ceiling just sits lower. */
  const isGL2 = renderer.capabilities.isWebGL2;
  const rtType = isGL2 ? THREE.HalfFloatType : THREE.UnsignedByteType;
  let scale = 1;
  let samples = isGL2 ? Math.min(4, renderer.capabilities.maxSamples || 0) : 0;

  function targetSize() {
    renderer.getSize(size);
    const p = renderer.getPixelRatio();
    return {
      w: Math.max(2, Math.round(size.x * p * scale)),
      h: Math.max(2, Math.round(size.y * p * scale)),
    };
  }
  const ts = targetSize();
  let sceneRT = new THREE.WebGLRenderTarget(ts.w, ts.h, {
    type: rtType, depthBuffer: true, stencilBuffer: false, samples,
  });
  const halfOpts = { type: rtType, depthBuffer: false, stencilBuffer: false };
  let brightRT = new THREE.WebGLRenderTarget(Math.max(1, ts.w >> 1), Math.max(1, ts.h >> 1), halfOpts);
  let blurRT = new THREE.WebGLRenderTarget(Math.max(1, ts.w >> 1), Math.max(1, ts.h >> 1), halfOpts);

  const brightMat = new THREE.RawShaderMaterial({
    vertexShader: "precision highp float;\nattribute vec3 position;\nattribute vec2 uv;\n" + VERT,
    fragmentShader: BRIGHT,
    uniforms: {
      tDiffuse: { value: null },
      uThreshold: { value: 0.72 },
      uKnee: { value: 0.45 },
    },
  });
  const blurMat = new THREE.RawShaderMaterial({
    vertexShader: "precision highp float;\nattribute vec3 position;\nattribute vec2 uv;\n" + VERT,
    fragmentShader: BLUR,
    uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
  });
  const compMat = new THREE.RawShaderMaterial({
    vertexShader: "precision highp float;\nattribute vec3 position;\nattribute vec2 uv;\n" + VERT,
    fragmentShader: COMPOSITE,
    uniforms: {
      tDiffuse: { value: null },
      tBloom: { value: null },
      uBloom: { value: 0.5 },
      uVignette: { value: 0.55 },
      uGrain: { value: 0.018 },
      uTime: { value: 0 },
      uExposure: { value: 1.06 },
      uSat: { value: 1.12 },
      uLift: { value: new THREE.Vector3(0.008, 0.012, 0.022) },
      uGain: { value: new THREE.Vector3(1.02, 1.0, 0.96) },
    },
  });

  const quadScene = new THREE.Scene();
  const quadCam = new THREE.Camera();
  const quad = fullscreenQuad(brightMat);
  quadScene.add(quad);

  function draw(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target || null);
    renderer.render(quadScene, quadCam);
  }

  let enabled = true;

  /* Time of day drives the grade: nights are cooler and grainier with more
   * bloom (headlights, lamps), golden hour is warm and glows, midday is
   * clean. `snap` is the atmosphere snapshot. */
  function applyAtmosphere(snap) {
    if (!snap) return;
    const night = snap.night || 0;
    const golden = snap.golden || 0;
    const wet = snap.wetness || 0;
    const u = compMat.uniforms;
    u.uBloom.value = 0.34 + night * 0.5 + golden * 0.3 + wet * 0.16;
    brightMat.uniforms.uThreshold.value = 0.78 - night * 0.3 - wet * 0.08;
    u.uExposure.value = 1.06 + night * 0.1;
    u.uSat.value = 1.14 - night * 0.24;
    u.uGrain.value = 0.016 + night * 0.03;
    u.uVignette.value = 0.5 + night * 0.35;
    // shadows go blue at night, lights go amber at golden hour
    u.uLift.value.set(0.006 + night * 0.004, 0.010 + night * 0.010, 0.020 + night * 0.030);
    u.uGain.value.set(1.02 + golden * 0.10, 1.0 + golden * 0.01, 0.96 - golden * 0.06);
    /* A tunnel is a dark room with two very bright holes in it, and that
     * is exactly the situation bloom and a tight vignette are for: the
     * wall lamps smear, the exit glares, the edges of the frame close in. */
    /* a storm: the exposure drops, the colour drains, the edges close in,
     * more grain — and a strike blows the whole frame open for a moment */
    const storm = snap.storm || 0;
    if (storm > 0) {
      u.uExposure.value -= storm * 0.09;
      u.uSat.value -= storm * 0.2;
      u.uVignette.value += storm * 0.24;
      u.uGrain.value += storm * 0.012;
    }
    const lf = snap.lightning || 0;
    if (lf > 0) { u.uExposure.value += lf * 0.4; u.uBloom.value += lf * 0.35; }
    const encl = snap.tunnel || 0;
    if (encl > 0) {
      u.uBloom.value += encl * 0.55;
      brightMat.uniforms.uThreshold.value -= encl * 0.34;
      u.uVignette.value += encl * 0.45;
      u.uSat.value -= encl * 0.2;
      u.uExposure.value += encl * 0.12;
      u.uLift.value.x += encl * 0.006; u.uLift.value.y += encl * 0.005; u.uLift.value.z += encl * 0.004;
    }
  }

  const stats = { calls: 0, triangles: 0 };

  function render(dt) {
    if (!enabled) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }
    compMat.uniforms.uTime.value += dt || 0.016;

    renderer.setRenderTarget(sceneRT);
    renderer.clear();
    renderer.render(scene, camera);
    /* Snapshot the SCENE's cost here. three resets renderer.info on every
     * render() call, and the post chain does four more of them, so anyone
     * reading info afterwards sees the composite quad — one draw call and
     * no triangles, which is a very reassuring lie. */
    stats.calls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;

    brightMat.uniforms.tDiffuse.value = sceneRT.texture;
    draw(brightMat, brightRT);

    const px = 1 / brightRT.width, py = 1 / brightRT.height;
    blurMat.uniforms.tDiffuse.value = brightRT.texture;
    blurMat.uniforms.uDir.value.set(px, 0);
    draw(blurMat, blurRT);
    blurMat.uniforms.tDiffuse.value = blurRT.texture;
    blurMat.uniforms.uDir.value.set(0, py);
    draw(blurMat, brightRT);

    compMat.uniforms.tDiffuse.value = sceneRT.texture;
    compMat.uniforms.tBloom.value = brightRT.texture;
    draw(compMat, null);
    renderer.setRenderTarget(null);
  }

  function resize() {
    const t = targetSize();
    sceneRT.setSize(t.w, t.h);
    brightRT.setSize(Math.max(1, t.w >> 1), Math.max(1, t.h >> 1));
    blurRT.setSize(Math.max(1, t.w >> 1), Math.max(1, t.h >> 1));
  }

  /* the quality ladder's hand: render scale and MSAA sample count. A
   * sample change rebuilds the scene target (three allocates MSAA storage
   * at creation); a scale change is just a resize. Rare events both. */
  function configure(opts) {
    if (opts.scale != null) scale = Math.max(0.4, Math.min(1, opts.scale));
    if (opts.samples != null && isGL2) {
      const want = Math.min(opts.samples, renderer.capabilities.maxSamples || 0);
      if (want !== samples) {
        samples = want;
        sceneRT.dispose();
        const t = targetSize();
        sceneRT = new THREE.WebGLRenderTarget(t.w, t.h, {
          type: rtType, depthBuffer: true, stencilBuffer: false, samples,
        });
      }
    }
    resize();
  }

  function setEnabled(on) { enabled = !!on; }

  function dispose() {
    sceneRT.dispose(); brightRT.dispose(); blurRT.dispose();
    brightMat.dispose(); blurMat.dispose(); compMat.dispose();
    quad.geometry.dispose();
  }

  return { render, resize, configure, applyAtmosphere, setEnabled, dispose, stats, uniforms: compMat.uniforms };
}
