/**
 * visualizer.js — 31-band GPU particle equalizer.
 *
 * Positions and velocities live in ping-pong float textures
 * (GPUComputationRenderer). Each particle is permanently assigned to one
 * 1/3-octave band. That band sets its column, its hue, and how fast it moves.
 * A half-resolution bloom pass composites the points.
 */
import * as THREE from 'https://esm.sh/three@0.169.0';
import { GPUComputationRenderer } from 'https://esm.sh/three@0.169.0/examples/jsm/misc/GPUComputationRenderer.js';

export const COUNT_DEFAULT = 100000;
const BANDS = 31;
const PAN_LIMIT = 7;
const clampPan = (v) => Math.min(PAN_LIMIT, Math.max(-PAN_LIMIT, Number(v) || 0));

const POSITION_SHADER = /* glsl */ `
uniform float uDelta;
uniform float uLife;
uniform float uStyle;
float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 posLife = texture2D(texturePosition, uv);
  vec4 velSeed = texture2D(textureVelocity, uv);
  vec3 pos = posLife.xyz;
  float life = posLife.w;
  vec3 vel = velSeed.xyz;
  float seed = velSeed.w;

  pos += vel * uDelta;
  life -= uDelta * uLife;

  float band = floor(clamp(seed, 0.0, 0.999) * 31.0);
  float barX = ((band + 0.5) / 31.0) * 14.2 - 7.1;
  bool off = life <= 0.0 || length(pos) > 12.0;
  if (off) {
    float angle = seed * 6.28318 * 17.0;
    float radius = 1.2 + fract(seed * 57.3) * 2.7;
    if (uStyle < 0.5) {
      pos = vec3((band - 15.0) * 0.335 + (hash1(seed * 19.1) - 0.5) * 0.16,
        -1.7 + hash1(seed * 57.3) * 0.14, (hash1(seed * 7.7) - 0.5) * 0.3);
    } else if (uStyle < 1.5) {
      pos = vec3(cos(angle) * radius, (fract(seed * 57.3) - 0.5) * 6.0, sin(angle) * radius);
    } else if (uStyle < 2.5) {
      pos = vec3(cos(angle) * radius, sin(angle) * radius * 0.65, (fract(seed * 7.7) - 0.5) * 2.5);
    } else {
      pos = vec3(barX, -2.55, 0.0);
    }
    life = 0.45 + fract(seed * 3.17) * 0.55;
  }
  gl_FragColor = vec4(pos, life);
}
`;

const VELOCITY_SHADER = /* glsl */ `
uniform float uDelta;
uniform float uSpeed;
uniform float uSens;
uniform float uThreshold;
uniform float uGravity;
uniform float uReact;
uniform float uStyle;
uniform float uTime;
uniform float uPulse;
uniform float uEnergy;
uniform float uFlow;
uniform sampler2D uSpectrumTex;

float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }

float bandLevel(float band) {
  float u = (band + 0.5) / 31.0;
  return texture2D(uSpectrumTex, vec2(u, 0.5)).r;
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 posLife = texture2D(texturePosition, uv);
  vec4 velSeed = texture2D(textureVelocity, uv);
  vec3 pos = posLife.xyz;
  float seed = velSeed.w;

  float band = floor(clamp(seed, 0.0, 0.999) * 31.0);
  float zone = band / 30.0;
  float barX = ((band + 0.5) / 31.0) * 14.2 - 7.1;
  float level = bandLevel(band) * uReact;
  float thr = clamp(uThreshold, 0.0, 0.9);
  float gated = level <= thr ? 0.0 : (level - thr) / max(0.18, 1.0 - thr);
  gated = clamp(gated * uSens, 0.0, 1.0);

  float height = 0.85 + gated * 7.0;
  float stack = hash1(seed * 57.3);
  vec3 target;
  if (uStyle < 0.5) {
    // Prism: translucent curtains whose crown ripples and sheds a few sparks.
    // Compress the EQ so loud bass cannot run off the top of the viewport.
    float prismX = (band - 15.0) * 0.335;
    float prismHeight = clamp(0.65 + gated * 3.85 + uPulse * gated * uReact * 0.35, 0.65, 4.85);
    float tipTaper = 1.0 - smoothstep(0.70, 1.0, stack) * 0.57;
    float shimmer = sin(stack * 11.0 + zone * 14.0 + uTime * (0.65 + gated) * uFlow);
    float width = (0.27 + gated * 0.08) * tipTaper;
    float edge = (hash1(seed * 19.1) - 0.5) * width;
    target = vec3(prismX + edge + shimmer * (0.035 + gated * 0.075),
      -1.7 + stack * prismHeight + sin(zone * 9.0 + uTime * 0.8 * uFlow) * 0.07 * stack,
      (hash1(seed * 7.7) - 0.5) * 0.65 + shimmer * (0.04 + gated * 0.09));
  } else if (uStyle < 1.5) {
    // Helix: low bands near the core, highs flare outward in two ribbons.
    float turn = stack * 12.566 + zone * 6.283 + uTime * (0.17 + gated * 0.54) * uFlow;
    float radius = 1.1 + zone * 2.5 + gated * 1.55 + uPulse * 0.8 * uReact;
    target = vec3(cos(turn) * radius, (stack - 0.5) * (5.5 + gated * 2.5), sin(turn) * radius);
  } else if (uStyle < 2.5) {
    // Nebula: a breathing, tilted orbital disk with frequency-coded radii.
    float angle = seed * 106.0 + uTime * (0.1 + (1.0 - zone) * 0.15) * uFlow;
    float radius = 0.95 + zone * 3.3 + stack * 1.15 + gated * 1.6 + uPulse * uReact * 1.2;
    target = vec3(cos(angle) * radius, sin(angle) * radius * 0.64 + sin(angle * 2.0 + uTime) * 0.2,
      (stack - 0.5) * 2.1 + sin(angle) * radius * 0.34);
  } else {
    target = vec3(barX, -2.55 + stack * height, 0.0);
  }
  float tempo = mix(0.55, 1.65, zone) * uSpeed * (0.65 + gated * 0.7 + uEnergy * uReact * 0.22);
  vec3 vel = (target - pos) * mix(5.0, 14.0, zone) * tempo;
  if (uStyle < 0.5) vel.y -= uGravity * (1.0 - gated) * 1.6;
  else vel += normalize(target + vec3(0.01)) * uPulse * gated * uReact * 4.0;
  vel *= pow(0.93, uDelta * 60.0);
  gl_FragColor = vec4(vel, seed);
}
`;

const RENDER_VERT = /* glsl */ `
precision highp float;
uniform sampler2D texturePosition;
uniform sampler2D textureVelocity;
uniform sampler2D uSpectrumTex;
uniform float uSize;
uniform float uSens;
uniform float uThreshold;
uniform float uReact;
uniform float uStyle;
uniform float uPulse;
uniform float uEnergy;
uniform float uHue;
varying vec3 vColor;
varying float vAlpha;

float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec2 uv = position.xy + 0.5;
  vec4 posLife = texture2D(texturePosition, uv);
  float seed = texture2D(textureVelocity, uv).w;
  vec3 pos = posLife.xyz;
  float band = floor(clamp(seed, 0.0, 0.999) * 31.0);
  float zone = band / 30.0;
  float level = texture2D(uSpectrumTex, vec2((band + 0.5) / 31.0, 0.5)).r * uReact;
  float thr = clamp(uThreshold, 0.0, 0.9);
  float gated = level <= thr ? 0.0 : (level - thr) / max(0.18, 1.0 - thr);
  gated = clamp(gated * uSens, 0.0, 1.0);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float baseHue = uStyle < 0.5 ? mix(0.52, 0.92, zone) :
    (uStyle < 1.5 ? mix(0.80, 0.47, zone) : mix(0.61, 0.92, zone));
  vec3 hue = hsv2rgb(vec3(fract(baseHue + uHue), 0.78 + gated * 0.1, 1.0));
  float flash = uReact * uPulse * (0.16 + gated * 0.5);
  float prismAccent = step(0.95, hash1(seed * 83.7)) * smoothstep(0.65, 0.98, hash1(seed * 57.3));
  float prismOpacity = 0.14 + gated * 0.16 + prismAccent * (0.11 + gated * 0.18);
  vColor = hue * (0.32 + gated * 0.46 + flash);
  if (uStyle < 0.5) vColor = mix(hue * (0.70 + gated * 0.35), vec3(0.82, 0.94, 1.0), prismAccent * (0.34 + gated * 0.34));
  float size = uSize * (0.58 + gated * 0.8 + flash * 0.35) * (0.6 + fract(seed * 13.7) * 0.6);
  gl_PointSize = clamp(size * (150.0 / max(-mv.z, 0.1)), 0.8, uStyle < 0.5 ? 3.8 : 5.0);
  float scatter = uStyle < 0.5 ? prismOpacity : (0.38 + gated * 0.24 + uEnergy * uReact * 0.1);
  vAlpha = scatter * smoothstep(0.0, 0.12, posLife.w);
}
`;

const RENDER_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
uniform float uBloom;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;
  float a = pow(smoothstep(0.5, 0.0, d), 2.15);
  gl_FragColor = vec4(vColor * (0.85 + uBloom * 0.55), a * vAlpha);
}
`;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb * 0.227027;
  c += texture2D(tDiffuse, vUv + uDir * 1.4).rgb * 0.316216;
  c += texture2D(tDiffuse, vUv - uDir * 1.4).rgb * 0.316216;
  c += texture2D(tDiffuse, vUv + uDir * 3.2).rgb * 0.070270;
  c += texture2D(tDiffuse, vUv - uDir * 3.2).rgb * 0.070270;
  gl_FragColor = vec4(c, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uBloom;
varying vec2 vUv;
void main() {
  vec3 col = texture2D(tScene, vUv).rgb;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 bright = col * smoothstep(0.25, 0.9, l);
  col += texture2D(tBloom, vUv).rgb * uBloom;
  col += bright * uBloom * 0.25;
  gl_FragColor = vec4(col, 1.0);
}
`;

class GPUParticles {
  constructor(renderer, count, settings) {
    this.renderer = renderer;
    this.settings = { ...settings };
    this.count = count;
    this.spectrum = new Float32Array(BANDS * 4);
    this.specTex = new THREE.DataTexture(this.spectrum, BANDS, 1, THREE.RGBAFormat, THREE.FloatType);
    this.specTex.minFilter = THREE.NearestFilter;
    this.specTex.magFilter = THREE.NearestFilter;
    this.specTex.needsUpdate = true;
    this.build(count);
  }

  build(count) {
    this.disposeGpu();
    this.count = count;
    const size = Math.ceil(Math.sqrt(count));
    this.size = size;
    this.realCount = size * size;
    const gpu = new GPUComputationRenderer(size, size, this.renderer);
    this.gpu = gpu;

    const posTex = gpu.createTexture();
    const velTex = gpu.createTexture();
    const pArr = posTex.image.data;
    const vArr = velTex.image.data;
    for (let i = 0; i < this.realCount; i++) {
      const i4 = i * 4;
      const seed = Math.random();
      const band = Math.min(BANDS - 1, Math.floor(seed * BANDS));
      pArr[i4] = (band - 15) * 0.335 + (Math.random() - 0.5) * 0.16;
      pArr[i4 + 1] = -1.7 + Math.random() * 0.14;
      pArr[i4 + 2] = (Math.random() - 0.5) * 0.3;
      pArr[i4 + 3] = 0.45 + Math.random() * 0.55;
      vArr[i4] = vArr[i4 + 1] = vArr[i4 + 2] = 0;
      vArr[i4 + 3] = seed;
    }

    this.posVar = gpu.addVariable('texturePosition', POSITION_SHADER, posTex);
    this.velVar = gpu.addVariable('textureVelocity', VELOCITY_SHADER, velTex);
    gpu.setVariableDependencies(this.posVar, [this.posVar, this.velVar]);
    gpu.setVariableDependencies(this.velVar, [this.posVar, this.velVar]);

    const sim = {
      uDelta: { value: 1 / 60 },
      uSpeed: { value: 1 },
      uSens: { value: 1.2 },
      uThreshold: { value: 0.18 },
      uGravity: { value: 0.4 },
      uLife: { value: 0.2 },
      uReact: { value: 1 },
      uStyle: { value: 0 },
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uEnergy: { value: 0 },
      uFlow: { value: 1 },
      uSpectrumTex: { value: this.specTex },
    };
    this.posVar.material.uniforms = { ...this.posVar.material.uniforms, ...sim };
    this.velVar.material.uniforms = { ...this.velVar.material.uniforms, ...sim };
    this.sim = this.velVar.material.uniforms;

    const err = gpu.init();
    if (err) {
      console.error('GPUComputationRenderer', err);
      this.unsupported = true;
      return;
    }

    const geo = new THREE.BufferGeometry();
    const refs = new Float32Array(this.realCount * 2);
    for (let i = 0; i < this.realCount; i++) {
      refs[i * 2] = (i % size) / size - 0.5;
      refs[i * 2 + 1] = Math.floor(i / size) / size - 0.5;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(refs, 2));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        texturePosition: { value: null },
        textureVelocity: { value: null },
        uSpectrumTex: { value: this.specTex },
        uSize: { value: 1 },
        uBloom: { value: 0.65 },
        uSens: { value: 1.2 },
        uThreshold: { value: 0.18 },
        uReact: { value: 1 },
        uStyle: { value: 0 },
        uPulse: { value: 0 },
        uEnergy: { value: 0 },
        uHue: { value: 0 },
      },
      vertexShader: RENDER_VERT,
      fragmentShader: RENDER_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    for (const [k, v] of Object.entries(this.settings)) this.set(k, v);
  }

  set(name, value) {
    this.settings[name] = value;
    if (this.sim?.[name]) this.sim[name].value = value;
    if (this.posVar?.material.uniforms[name]) this.posVar.material.uniforms[name].value = value;
    if (this.material?.uniforms[name]) this.material.uniforms[name].value = value;
  }

  update(dt, audio) {
    if (this.unsupported || !this.gpu) return;
    const src = audio?.spectrum;
    if (src?.length) {
      for (let i = 0; i < BANDS; i++) this.spectrum[i * 4] = src[Math.min(src.length - 1, i)] || 0;
    } else {
      for (let i = 0; i < BANDS; i++) this.spectrum[i * 4] *= 0.9;
    }
    this.specTex.needsUpdate = true;
    this.set('uPulse', audio?.pulse || 0);
    this.set('uEnergy', audio?.energy || 0);
    this.sim.uTime.value += Math.min(dt, 1 / 20);
    const dtClamped = Math.min(dt, 1 / 30);
    this.posVar.material.uniforms.uDelta.value = dtClamped;
    this.velVar.material.uniforms.uDelta.value = dtClamped;
    this.gpu.compute();
    this.material.uniforms.texturePosition.value = this.gpu.getCurrentRenderTarget(this.posVar).texture;
    this.material.uniforms.textureVelocity.value = this.gpu.getCurrentRenderTarget(this.velVar).texture;
  }

  disposeGpu() {
    if (this.points) {
      this.points.geometry.dispose();
      this.material.dispose();
      this.points = null;
    }
    this.gpu?.dispose?.();
    this.gpu = null;
  }

  dispose() {
    this.disposeGpu();
    this.specTex.dispose();
  }
}

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.audio = { spectrum: null };
    this.onAudioTick = null;
    this.enabled = { particles: true };
    this.settings = {
      uSpeed: 1,
      uSize: 1,
      uBloom: 0.65,
      uSens: 1.2,
      uThreshold: 0.18,
      uGravity: 0.4,
      uLife: 0.2,
      uReact: 1,
      uStyle: 0,
      uFlow: 1,
      uHue: 0,
    };

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(0x000000, 1);
    this.backend = this.renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1';

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 80);
    this._target = new THREE.Vector3(0, 0.2, 0);
    this._pan = { x: 0, y: 0 };
    this._panWanted = { x: 0, y: 0 };
    this._panDrag = false;
    this._spherical = new THREE.Spherical(13.2, 1.28, 0.04);
    this._dragging = false;
    this._last = { x: 0, y: 0 };

    this.clock = new THREE.Clock();
    this.fps = 0;
    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this.stats = { backend: this.backend, fps: 0, frameMs: 0, particles: COUNT_DEFAULT };

    this.particles = new GPUParticles(this.renderer, COUNT_DEFAULT, this.settings);
    this.scene.add(this.particles.points);

    this._buildBloom();
    this._bindOrbit();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
    this._loop = this._loop.bind(this);
    this.renderer.setAnimationLoop(this._loop);
  }

  _buildBloom() {
    const rt = () => new THREE.WebGLRenderTarget(2, 2);
    this.rtScene = rt();
    this.rtA = rt();
    this.rtB = rt();
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadScene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: QUAD_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        uBloom: { value: 0.65 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
  }

  _bindOrbit() {
    const el = this.canvas;
    el.style.touchAction = 'none';
    el.style.cursor = 'grab';
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2 && e.pointerType === 'mouse') return;
      this._dragging = true;
      this._panDrag = e.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey;
      this._last.x = e.clientX;
      this._last.y = e.clientY;
      el.style.cursor = this._panDrag ? 'move' : 'grabbing';
      try { el.setPointerCapture(e.pointerId); } catch {}
    });
    el.addEventListener('pointermove', (e) => {
      if (!this._dragging) return;
      const dx = e.clientX - this._last.x;
      const dy = e.clientY - this._last.y;
      this._last.x = e.clientX;
      this._last.y = e.clientY;
      if (this._panDrag) {
        this.pan(this._panWanted.x - dx * 0.016, this._panWanted.y + dy * 0.016);
        return;
      }
      this._spherical.theta -= dx * 0.005;
      this._spherical.phi = Math.min(Math.PI - 0.15, Math.max(0.25, this._spherical.phi - dy * 0.004));
    });
    const up = () => {
      this._dragging = false;
      this._panDrag = false;
      el.style.cursor = 'grab';
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('dblclick', () => this.resetView());
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._spherical.radius = Math.min(28, Math.max(6, this._spherical.radius + e.deltaY * 0.01));
    }, { passive: false });
  }

  pan(dx, dy) {
    this._panWanted.x = clampPan(dx);
    this._panWanted.y = clampPan(dy);
    this._pan.x = this._panWanted.x;
    this._pan.y = this._panWanted.y;
    this._applyCamera();
  }

  resetView() {
    this._panWanted.x = 0;
    this._panWanted.y = 0;
    this._pan.x = 0;
    this._pan.y = 0;
    this._spherical.theta = 0.04;
    this._spherical.phi = 1.28;
    this._spherical.radius = 13.2;
    this._applyCamera();
    this.onViewChange?.();
  }

  _applyCamera() {
    const offset = (this.settings.uStyle < 0.5 ? -2.2 : 0) + this._pan.x;
    this._target.x += (offset - this._target.x) * 0.08;
    this._target.y += (0.2 + this._pan.y - this._target.y) * 0.08;
    this.camera.position.setFromSpherical(this._spherical).add(this._target);
    this.camera.lookAt(this._target);
  }

  set(name, value) {
    this.settings[name] = value;
    this.particles.set(name, value);
  }

  setCount(n) {
    this.scene.remove(this.particles.points);
    const visible = this.particles.points.visible;
    this.particles.build(n);
    this.particles.points.visible = visible;
    this.scene.add(this.particles.points);
    this.stats.particles = n;
  }

  setToggle(name, on) {
    this.enabled[name] = on;
    if (name === 'particles') this.particles.points.visible = on;
    if (name === 'react') this.set('uReact', on ? 1 : 0);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this._applyCamera();
    this.camera.updateProjectionMatrix();
    const bw = this.canvas.width;
    const bh = this.canvas.height;
    this.rtScene.setSize(bw, bh);
    this.rtA.setSize(Math.max(2, bw >> 1), Math.max(2, bh >> 1));
    this.rtB.setSize(Math.max(2, bw >> 1), Math.max(2, bh >> 1));
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.ortho);
  }

  _draw() {
    const bloom = this.settings.uBloom || 0;
    if (bloom < 0.02) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.renderer.setRenderTarget(this.rtScene);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    this.blurMat.uniforms.tDiffuse.value = this.rtScene.texture;
    this.blurMat.uniforms.uDir.value.set(1.2 / this.rtA.width, 0);
    this._pass(this.blurMat, this.rtA);
    this.blurMat.uniforms.tDiffuse.value = this.rtA.texture;
    this.blurMat.uniforms.uDir.value.set(0, 1.2 / this.rtA.height);
    this._pass(this.blurMat, this.rtB);

    this.compositeMat.uniforms.tScene.value = this.rtScene.texture;
    this.compositeMat.uniforms.tBloom.value = this.rtB.texture;
    this.compositeMat.uniforms.uBloom.value = bloom;
    this._pass(this.compositeMat, null);
  }

  _loop() {
    const dt = Math.min(this.clock.getDelta(), 1 / 20);
    if (document.hidden) return;
    if (this.onAudioTick) {
      const audio = this.onAudioTick(dt);
      if (audio) this.audio = audio;
      else this.audio = { spectrum: null };
    }
    this.particles.update(dt, this.audio);
    this._applyCamera();
    const t0 = performance.now();
    this._draw();
    const ms = performance.now() - t0;
    this.stats.frameMs = (this.stats.frameMs || 0) * 0.85 + ms * 0.15;
    this._fpsAcc += dt;
    this._fpsFrames++;
    if (this._fpsAcc > 0.5) {
      this.fps = Math.round(this._fpsFrames / this._fpsAcc);
      this.stats.fps = this.fps;
      this.stats.particles = this.particles.count;
      this._fpsAcc = 0;
      this._fpsFrames = 0;
    }
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.setAnimationLoop(null);
    this.particles.dispose();
    this.rtScene.dispose();
    this.rtA.dispose();
    this.rtB.dispose();
    this.renderer.dispose();
  }
}
