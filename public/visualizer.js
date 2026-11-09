/**
 * visualizer.js — GPU particle system + vinyl record, Three.js.
 *
 * Particles are simulated entirely on the GPU with GPUComputationRenderer
 * (ping-pong float textures), so 150k+ particles cost the CPU almost nothing.
 * Audio inputs drive curl-noise amplitude, colour and radial displacement:
 * broad bass/mid/treble + kick/onset shape the whole scene, while 24 peak
 * logarithmic FFT zones animate separate particle populations when live FFT
 * (tab capture or local file) is available.
 */
import * as THREE from 'https://esm.sh/three@0.169.0';
import { GPUComputationRenderer } from 'https://esm.sh/three@0.169.0/examples/jsm/misc/GPUComputationRenderer.js';

const V = new URL(import.meta.url).search;
const { SceneLayers } = await import(`./viz/layers.js${V}`);
const { PostPipeline } = await import(`./viz/post.js${V}`);

export const COUNT_DEFAULT = 150000;
// 24 zones — same log span as the 48-bin meter, paired for particles. Peak
// (not average) of each pair keeps the Graphic EQ as punchy as canvas#meter.
const SPECTRUM_ZONES = 24;

// Each particle is permanently assigned to one frequency zone through its
// seeded identity. The if-chain avoids dynamic uniform-array indexing so it
// compiles on every WebGL driver.
const SPECTRUM = /* glsl */ `
uniform float uSpectrum[24];
float spectrumFor(float seed) {
  float x = fract(seed * 103.73);
  if (x < 0.0416667) return uSpectrum[0];
  if (x < 0.0833333) return uSpectrum[1];
  if (x < 0.1250000) return uSpectrum[2];
  if (x < 0.1666667) return uSpectrum[3];
  if (x < 0.2083333) return uSpectrum[4];
  if (x < 0.2500000) return uSpectrum[5];
  if (x < 0.2916667) return uSpectrum[6];
  if (x < 0.3333333) return uSpectrum[7];
  if (x < 0.3750000) return uSpectrum[8];
  if (x < 0.4166667) return uSpectrum[9];
  if (x < 0.4583333) return uSpectrum[10];
  if (x < 0.5000000) return uSpectrum[11];
  if (x < 0.5416667) return uSpectrum[12];
  if (x < 0.5833333) return uSpectrum[13];
  if (x < 0.6250000) return uSpectrum[14];
  if (x < 0.6666667) return uSpectrum[15];
  if (x < 0.7083333) return uSpectrum[16];
  if (x < 0.7500000) return uSpectrum[17];
  if (x < 0.7916667) return uSpectrum[18];
  if (x < 0.8333333) return uSpectrum[19];
  if (x < 0.8750000) return uSpectrum[20];
  if (x < 0.9166667) return uSpectrum[21];
  if (x < 0.9583333) return uSpectrum[22];
  return uSpectrum[23];
}
`;

/* ────────────────────────────── GLSL ────────────────────────────── */

const NOISE = /* glsl */ `
vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
}
vec3 noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i + vec3(0,0,0)), hash3(i + vec3(1,0,0)), f.x),
        mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
        mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
// divergence-free curl field → silky fluid motion
vec3 curl(vec3 p) {
  const float e = 0.12;
  vec3 dx = vec3(e,0,0), dy = vec3(0,e,0), dz = vec3(0,0,e);
  vec3 px0 = noise3(p-dx), px1 = noise3(p+dx);
  vec3 py0 = noise3(p-dy), py1 = noise3(p+dy);
  vec3 pz0 = noise3(p-dz), pz1 = noise3(p+dz);
  float x = (py1.z-py0.z) - (pz1.y-pz0.y);
  float y = (pz1.x-pz0.x) - (px1.z-px0.z);
  float z = (px1.y-px0.y) - (py1.x-py0.x);
  return normalize(vec3(x,y,z) / (2.0*e) + 1e-6);
}
`;

// texture layout: xyz = position, w = life (0..1)
const POSITION_SHADER = /* glsl */ `
uniform float uDelta;
uniform float uSpeed;
uniform float uEffect;
void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 posLife = texture2D(texturePosition, uv);
  vec4 velSeed = texture2D(textureVelocity, uv);

  vec3 pos = posLife.xyz;
  float life = posLife.w;
  vec3 vel = velSeed.xyz;
  float seed = velSeed.w;
  float r = length(pos);
  float effect = floor(uEffect + 0.5);
  bool eq = effect > 3.5 && effect < 4.5;
  bool tunnel = effect > 4.5 && effect < 5.5;

  pos += vel * uDelta * uSpeed;
  r = length(pos);
  life -= uDelta * (eq ? 0.02 : 0.06);

  // Graphic EQ keeps particles in a flat bar field — respawn into columns,
  // not the spherical cloud used by the fluid modes.
  if (eq) {
    float zone = fract(seed * 103.73);
    float bar = floor(zone * 24.0);
    float barX = ((bar + 0.5) / 24.0) * 11.0 - 5.5;
    // Anything still sitting in the old cloud — including the ball that
    // freezes at the origin — is put straight onto its column.
    bool offColumn = abs(pos.x - barX) > 0.4 || abs(pos.z) > 0.45
      || pos.y < -3.5 || pos.y > 8.0 || life <= 0.0;
    if (offColumn) {
      pos = vec3(
        barX + (fract(seed * 19.1) - 0.5) * 0.16,
        -2.4 + fract(seed * 57.3) * 1.0,
        (fract(seed * 7.7) - 0.5) * 0.18
      );
      life = 1.0;
    }
  } else if (tunnel) {
    float rad = length(pos.xy);
    if (life <= 0.0 || pos.z > 12.0 || pos.z < -6.0 || rad > 7.0 || rad < 0.35) {
      float a = fract(seed * 13.13) * 6.2831853;
      float rr = 1.4 + fract(seed * 7.1) * 2.5;
      pos = vec3(cos(a) * rr, sin(a) * rr, -4.0 - fract(seed * 9.2) * 8.0);
      life = 1.0;
    }
  } else if (life <= 0.0 || r > 11.0 || r < 0.35) {
    float a = fract(seed * 13.13) * 6.2831853;
    float b = acos(2.0 * fract(seed * 7.77) - 1.0);
    pos = vec3(sin(b)*cos(a), cos(b)*0.55, sin(b)*sin(a)) * (2.0 + fract(seed*31.1) * 2.2);
    life = 1.0;
  }

  gl_FragColor = vec4(pos, life);
}
`;

// xyz = velocity, w = seed. Physics lives here so velocity actually persists
// across frames. Previously this pass was a no-op, so forces were O(dt²) and
// the cloud could not punch on a beat.
const VELOCITY_SHADER = /* glsl */ `
uniform float uTime;
uniform float uDelta;
uniform float uFlow;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uReact;
uniform float uBassSens;
uniform float uKick;
uniform float uOnset;
uniform float uEffect;
uniform float uThreshold;
${NOISE}
${SPECTRUM}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 posLife = texture2D(texturePosition, uv);
  vec4 velSeed = texture2D(textureVelocity, uv);

  vec3 pos = posLife.xyz;
  float life = posLife.w;
  vec3 vel = velSeed.xyz;
  float seed = velSeed.w;
  float r = length(pos);
  float effect = floor(uEffect + 0.5);
  bool eq = effect > 3.5 && effect < 4.5;

  // The radius gate is for the fluid cloud. In the equalizer it pinned every
  // particle that crossed the origin, which drew a ring in the middle of the bars.
  if (!eq && (life <= 0.0 || r > 11.0 || r < 0.35)) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, seed);
    return;
  }

  float spectral = spectrumFor(seed) * uReact;
  float energy = 1.0 + uReact * (uBass * uBassSens * 1.8 + uKick * 1.4 + uMid * 0.8 + spectral * 1.15);
  vec3 dir = normalize(pos + vec3(1e-5));
  vec3 tangent = normalize(vec3(-pos.z, 0.0, pos.x) + vec3(1e-5));
  vec3 flow = curl(pos * 0.30 + vec3(0.0, uTime * 0.06 * uFlow, 0.0));
  // 0 = lowest band, 1 = highest. Tempo and travel direction both follow it.
  float zone = fract(seed * 103.73);
  float tempo = mix(0.42, 1.85, zone);
  vec3 velIn = vel;

  // 0: balanced spectrum — all 12 zones drive a shared fluid cloud.
  if (effect < 0.5) {
    vel += flow * (0.55 * uFlow * energy) * uDelta;
    float target = 3.4 + uReact * (uBass * uBassSens * 2.4 + uKick * 1.8 + spectral * 1.25) + uMid * 0.5;
    vel += dir * (target - r) * 2.4 * uDelta;
    vel += dir * uReact * (uTreble * 4.0 + spectral * 2.2) * uDelta * (fract(seed * 91.7) - 0.5);
    vel += tangent * (0.35 + uReact * (uBass * 1.2 + uKick * 2.0)) * uFlow * uDelta * 0.55;
  }
  // 1: bass vortex — low frequencies tighten and accelerate the orbit; each
  // spectral zone still changes the altitude and radial texture.
  else if (effect < 1.5) {
    float low = uReact * (uBass * uBassSens + uKick * 0.85);
    vel += flow * (0.22 + spectral * 0.48) * uDelta;
    vel += tangent * (0.50 + low * 4.8 + spectral * 1.4) * uFlow * uDelta;
    vel += dir * ((3.15 + low * 2.8 + spectral * 0.9) - r) * 2.1 * uDelta;
    vel.y += sin(uTime * 2.0 + seed * 41.0) * (low * 2.6 + spectral * 0.55) * uDelta;
  }
  // 2: mid aurora — vocal/instrument mids turn the cloud into vertical,
  // rippling curtains; lows keep the foundation and high zones add texture.
  else if (effect < 2.5) {
    float wave = sin(pos.x * 1.7 + pos.z * 1.25 + uTime * 1.8 + seed * 19.0);
    vec3 aurora = normalize(vec3(cos(pos.y + uTime), wave * 1.8, sin(pos.y - uTime)) + vec3(1e-5));
    vel += flow * (0.22 + uReact * uMid * 1.35 + spectral * 0.40) * uDelta;
    vel += aurora * (uReact * uMid * 3.6 + spectral * 0.9) * uDelta;
    vel += dir * ((3.4 + uReact * uBass * 1.1 + spectral * 0.65) - r) * 1.7 * uDelta;
  }
  // 3: treble sparks — high frequencies scatter short, bright trajectories;
  // the 12 zones make cymbals, hats and high synth detail appear in separate
  // regions rather than flashing the entire cloud together.
  else if (effect < 3.5) {
    float high = uReact * uTreble + spectral * 0.72;
    vec3 sparks = curl(pos * 0.82 + vec3(uTime * 0.7, seed * 9.0, -uTime * 0.4));
    vel += flow * (0.18 + uReact * uBass * 0.35) * uDelta;
    vel += sparks * (high * 4.3 + uReact * uOnset * 2.0) * uDelta;
    vel += tangent * (0.25 + high * 1.6) * uFlow * uDelta;
    vel += dir * ((3.2 + uReact * uMid * 0.75 + spectral * 0.95) - r) * 1.8 * uDelta;
  }
  // 4: graphic EQ — same signal as canvas#meter. 24 columns track peak FFT
  // levels and snap nearly every frame so bars feel as sensitive as the meter.
  else if (effect < 4.5) {
    float bar = floor(zone * 24.0);
    float barX = ((bar + 0.5) / 24.0) * 11.0 - 5.5;
    // Same gate as canvas#meter: zero below threshold, soft map above so a
    // hot mix does not pin every column to the ceiling.
    float thr = clamp(uThreshold, 0.0, 0.95);
    float gated = spectral <= thr ? 0.0 : (spectral - thr) / max(0.2, 1.0 - thr);
    float level = clamp(gated * 0.85 * uBassSens, 0.0, 0.9);
    float height = 0.08 + level * 6.8;
    float stack = fract(seed * 57.3);
    vec3 target = vec3(
      barX + (fract(seed * 19.1) - 0.5) * 0.16,
      -2.4 + stack * height,
      (fract(seed * 7.7) - 0.5) * 0.18
    );
    vec3 to = target - pos;
    // Lows climb straight up. Highs rise faster and shiver across the column.
    to.x *= mix(0.28, 1.45, zone);
    to.z *= mix(0.2, 1.7, zone);
    float wobble = sin(uTime * mix(1.4, 8.5, zone) + seed * 31.0);
    to.x += wobble * zone * 0.16 * (0.2 + level);
    vel = to * mix(9.0, 32.0, zone);
    vel *= pow(mix(0.76, 0.9, zone), uDelta * 60.0);
    gl_FragColor = vec4(vel, seed);
    return;
  }
  // 5: particle tunnel — bass sets travel speed, highs spin wider rings.
  else {
    float rad = max(length(pos.xy), 0.001);
    vec2 radial = pos.xy / rad;
    vec2 spin = vec2(-radial.y, radial.x);
    float targetR = mix(2.6, 1.35, zone) + spectral * 1.15;
    float speed = mix(3.0, 8.0, zone) * (1.0 + uBass * uBassSens * 0.9 + uKick * 0.7);
    vel.xy += radial * (targetR - rad) * 2.4 * uDelta;
    vel.xy += spin * mix(0.25, 2.2, zone) * (0.35 + spectral) * uDelta;
    vel.xy += radial * uReact * uOnset * mix(2.2, 0.4, zone);
    vel.z = mix(vel.z, speed * tempo, 0.18);
    vel *= pow(0.96, uDelta * 60.0);
    gl_FragColor = vec4(vel, seed);
    return;
  }

  // This frame's forces, played slower for bass and faster for treble.
  vel = velIn + (vel - velIn) * tempo;

  // Lows drift out and up. Highs travel along the swirl.
  vec3 lowDir = normalize(dir + vec3(0.0, 0.9, 0.0));
  vec3 highDir = normalize(tangent + flow);
  vec3 bandDir = normalize(mix(lowDir, highDir, zone));
  vel += bandDir * (0.45 + spectral * 3.2) * tempo * uDelta;

  // A soft radial breath on the beat — kicks still hit the low bands hardest.
  vel += lowDir * uReact * uOnset * uBassSens * mix(1.5, 0.45, zone);
  vel += lowDir * uReact * uKick * uBassSens * mix(8.0, 2.2, zone) * uDelta;

  vel *= pow(mix(0.90, 0.965, zone), uDelta * 60.0);

  gl_FragColor = vec4(vel, seed);
}
`;

const RENDER_VERT = /* glsl */ `
precision highp float;
uniform sampler2D texturePosition;
uniform sampler2D textureVelocity;
uniform float uSize;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uTime;
uniform float uReact;
uniform float uBassSens;
uniform float uKick;
uniform float uOnset;
uniform float uEffect;
uniform float uThreshold;
${SPECTRUM}

varying vec3 vColor;
varying float vAlpha;

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// Permanent zone identity: 0 = lowest band, 1 = highest.
float zoneOf(float seed) {
  return fract(seed * 103.73);
}

// Lows are blue, mids green, highs red.
vec3 frequencyColor(float seed) {
  float hue = mix(0.66, 0.0, zoneOf(seed));
  return hsv2rgb(vec3(hue, 0.88, 1.0));
}

void main() {
  vec2 uv = position.xy + 0.5;   // position attribute is a normalized grid ref
  vec4 posLife = texture2D(texturePosition, uv);
  vec4 velSeed = texture2D(textureVelocity, uv);

  vec3 pos = posLife.xyz;
  float seed = velSeed.w;
  float speed = length(velSeed.xyz);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float r = length(pos);
  float spectral = spectrumFor(seed) * uReact;
  float effect = floor(uEffect + 0.5);
  float kick = uReact * uKick;
  float onset = uReact * uOnset;
  vec3 zoneColor = frequencyColor(seed);

  if (effect > 3.5 && effect < 4.5) {
    // Each column is one band: left (low) blue, right (high) red.
    float thr = clamp(uThreshold, 0.0, 0.95);
    float gated = spectral <= thr ? 0.0 : (spectral - thr) / max(0.2, 1.0 - thr);
    float amp = clamp(gated * 0.85, 0.0, 0.9);
    vColor = zoneColor * (0.38 + amp * 0.72);
    float size = uSize * (0.7 + amp * 1.0) * (0.5 + fract(seed * 57.3) * 0.45);
    gl_PointSize = clamp(size * (150.0 / max(-mv.z, 0.1)), 0.7, 6.5);
    vAlpha = (0.28 + amp * 0.6)
           * smoothstep(0.0, 0.12, posLife.w)
           * (0.55 + uReact * 0.45);
    return;
  }

  // Hue is the particle's band. Loud bands brighten; quiet ones stay dim but keep their color.
  float lit = 0.48 + spectral * 0.62 + speed * 0.06 + kick * 0.10;
  vColor = zoneColor * lit;

  float size = uSize * (1.0 + onset * 0.35 + kick * 0.4 * uBassSens + spectral * 0.22) * (0.55 + fract(seed*57.3) * 0.6);
  float maxSize = mix(5.0, 7.2, clamp(max(kick, onset), 0.0, 1.0));
  gl_PointSize = clamp(size * (150.0 / max(-mv.z, 0.1)), 0.6, maxSize);

  // fade the dense core so the cloud reads as a halo, not a white blob
  vAlpha = smoothstep(11.0, 4.0, r) * (0.22 + speed * 0.28 + kick * 0.35) * (0.55 + uReact * 0.45)
         * smoothstep(0.0, 0.15, posLife.w)
         * smoothstep(0.8, 3.0, r) * 0.32;
}
`;

const RENDER_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
uniform float uBloom;
uniform float uKick;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;
  float a = pow(smoothstep(0.5, 0.0, d), 2.2);
  gl_FragColor = vec4(vColor * (1.0 + uBloom * 0.85 + uKick * 0.12), a * vAlpha);
}
`;

/* ────────────────────────────── particle system ────────────────────────────── */

class GPUParticles {
  constructor(renderer, count, settings) {
    this.renderer = renderer;
    // Desired uniform values survive a rebuild. Without this, changing the
    // particle count re-created the materials at their defaults and silently
    // discarded every slider/toggle the user had set.
    this.settings = settings || {
      uSize: 1, uBloom: 0.85, uFlow: 1, uReact: 1, uSpeed: 1, uBassSens: 1.2,
      uEffect: 0, uThreshold: 0.28,
    };
    this.build(count);
  }

  build(count) {
    this.dispose();
    this.count = count;

    // pick a texture size whose w*h >= count
    const size = Math.ceil(Math.sqrt(count));
    this.size = size;
    this.realCount = size * size;

    const gpu = new GPUComputationRenderer(size, size, this.renderer);
    this.unsupported = false;

    const posTex = gpu.createTexture();
    const velTex = gpu.createTexture();
    const pArr = posTex.image.data;
    const vArr = velTex.image.data;

    for (let i = 0; i < this.realCount; i++) {
      const i4 = i * 4;
      const a = Math.random() * Math.PI * 2;
      const b = Math.acos(2 * Math.random() - 1);
      const r = 2.0 + Math.pow(Math.random(), 0.7) * 2.6;
      pArr[i4] = Math.sin(b) * Math.cos(a) * r;
      pArr[i4 + 1] = Math.cos(b) * r * 0.55;
      pArr[i4 + 2] = Math.sin(b) * Math.sin(a) * r;
      pArr[i4 + 3] = Math.random();          // life

      vArr[i4] = 0;
      vArr[i4 + 1] = 0;
      vArr[i4 + 2] = 0;
      vArr[i4 + 3] = Math.random();          // seed
    }

    this.posVar = gpu.addVariable('texturePosition', POSITION_SHADER, posTex);
    this.velVar = gpu.addVariable('textureVelocity', VELOCITY_SHADER, velTex);
    gpu.setVariableDependencies(this.posVar, [this.posVar, this.velVar]);
    gpu.setVariableDependencies(this.velVar, [this.posVar, this.velVar]);

    // 12 grouped bands are uploaded every frame from LiveAudio's 48-bin FFT.
    // Reuse this typed array; allocating in the render loop causes GC stutter.
    this.spectrum = new Float32Array(SPECTRUM_ZONES);
    this.uniforms = {
      uTime: { value: 0 }, uDelta: { value: 1 / 60 }, uFlow: { value: 1 },
      uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
      uReact: { value: 1 }, uSpeed: { value: 1 }, uBassSens: { value: 1.2 },
      uKick: { value: 0 }, uOnset: { value: 0 }, uEffect: { value: 0 },
      uThreshold: { value: 0.28 },
      uSpectrum: { value: this.spectrum },
    };
    Object.assign(this.posVar.material.uniforms, this.uniforms);
    Object.assign(this.velVar.material.uniforms, this.uniforms);

    const err = gpu.init();
    if (err !== null) {
      console.error('GPUComputationRenderer:', err);
      this.unsupported = true;
      return;
    }
    this.gpu = gpu;

    // render-side geometry: a UV grid, positions come from the texture
    const geo = new THREE.BufferGeometry();
    const refs = new Float32Array(this.realCount * 3);
    for (let i = 0; i < this.realCount; i++) {
      const x = (i % size) / size;
      const y = Math.floor(i / size) / size;
      refs[i * 3] = x;
      refs[i * 3 + 1] = y;
      refs[i * 3 + 2] = 0;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(refs, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20);

    this.renderUniforms = {
      texturePosition: { value: null },
      textureVelocity: { value: null },
      uSize: { value: 1 },
      uBloom: { value: 0.85 },
      uTime: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uReact: { value: 1 },
      uBassSens: { value: 1.2 },
      uKick: { value: 0 },
      uOnset: { value: 0 },
      uEffect: { value: 0 },
      uThreshold: { value: 0.28 },
      uSpectrum: { value: this.spectrum },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: RENDER_VERT,
      fragmentShader: RENDER_FRAG,
      uniforms: this.renderUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.material = mat;

    // Re-apply whatever the user had configured before this rebuild.
    for (const [k, v] of Object.entries(this.settings)) this._apply(k, v);
  }

  /** Write a setting to whichever uniform group owns it, and remember it. */
  _apply(name, v) {
    this.settings[name] = v;
    if (this.uniforms?.[name]) this.uniforms[name].value = v;
    if (this.renderUniforms?.[name]) this.renderUniforms[name].value = v;
  }

  update(dt, audio, t) {
    if (this.unsupported || !this.gpu) return;
    const u = this.uniforms;
    u.uTime.value = t;
    u.uDelta.value = Math.min(dt, 1 / 30);
    u.uBass.value = audio.bass || 0;
    u.uMid.value = audio.mid || 0;
    u.uTreble.value = audio.treble || 0;
    u.uKick.value = audio.kick || 0;
    u.uOnset.value = audio.onset || 0;

    // Fold the live 48-bin FFT into particle zones. Use the PEAK of each
    // group (not the average) so Graphic EQ stays as sensitive as #meter.
    const sourceSpectrum = audio.spectrum;
    if (sourceSpectrum?.length) {
      const sourceLength = sourceSpectrum.length;
      for (let i = 0; i < SPECTRUM_ZONES; i++) {
        const from = Math.floor((i * sourceLength) / SPECTRUM_ZONES);
        const to = Math.max(from + 1, Math.floor(((i + 1) * sourceLength) / SPECTRUM_ZONES));
        let peak = 0;
        for (let j = from; j < to && j < sourceLength; j++) {
          const v = sourceSpectrum[j] || 0;
          if (v > peak) peak = v;
        }
        this.spectrum[i] = peak;
      }
    } else {
      // Beat-grid fallback so Graphic EQ still moves without tab capture.
      const b = Math.max(u.uBass.value, u.uKick.value);
      const m = u.uMid.value;
      const tr = u.uTreble.value;
      for (let i = 0; i < SPECTRUM_ZONES; i++) {
        const p = i / (SPECTRUM_ZONES - 1);
        const base = p < 0.28 ? b : p < 0.62 ? m : tr;
        const wobble = 0.72 + 0.28 * Math.sin(t * 6.0 + i * 1.7);
        this.spectrum[i] = Math.min(1, base * wobble);
      }
    }

    this.gpu.compute();

    const ru = this.renderUniforms;
    ru.texturePosition.value = this.gpu.getCurrentRenderTarget(this.posVar).texture;
    ru.textureVelocity.value = this.gpu.getCurrentRenderTarget(this.velVar).texture;
    ru.uTime.value = t;
    ru.uBass.value = u.uBass.value;
    ru.uMid.value = u.uMid.value;
    ru.uTreble.value = u.uTreble.value;
    ru.uKick.value = u.uKick.value;
    ru.uOnset.value = u.uOnset.value;
  }

  set(name, v) {
    this._apply(name, v);
  }

  setRender(name, v) {
    this._apply(name, v);
  }

  dispose() {
    if (this.points) {
      this.points.geometry.dispose();
      this.material.dispose();
    }
    if (this.gpu) this.gpu.dispose?.();
    this.points = null;
    this.gpu = null;
    this.unsupported = false;
  }
}

/* ────────────────────────────── scene ────────────────────────────── */

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.enabled = { particles: true, vinyl: true, react: true };
    this.audio = { bass: 0, mid: 0, treble: 0 };
    // Owned here (not by GPUParticles) so it outlives particle rebuilds.
    this._settings = null;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
    this.camera.position.set(1.6, 2.4, 12.5);

    // Spherical orbit around the vinyl. Drag to rotate; wheel to zoom.
    this._orbitTarget = new THREE.Vector3(0, 0, 0);
    this._spherical = new THREE.Spherical(12.8, 1.22, 0.18);
    this._orbitDragging = false;
    this._orbitLast = { x: 0, y: 0 };
    this._orbitAuto = true;

    this.clock = new THREE.Clock();
    this._buildLights();
    this._buildVinyl();
    this._buildParticles(COUNT_DEFAULT);
    this.layers = new SceneLayers(this.scene);
    this.post = new PostPipeline(this.renderer);
    this.quality = 'high';
    this.preset = null;
    this.backend = this.renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1';
    this._frameMs = 0;
    this._bufW = 2;
    this._bufH = 2;
    this.stats = {
      backend: this.backend, fps: 0, frameMs: 0,
      particles: COUNT_DEFAULT, preset: 'Live',
    };
    this._bindOrbit();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();

    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this.fps = 0;

    this._loop = this._loop.bind(this);
    this.onAudioTick = null;
    this.renderer.setAnimationLoop(this._loop);
  }

  _bindOrbit() {
    const el = this.canvas;
    el.style.touchAction = 'none';
    el.style.cursor = 'grab';

    this._onPointerDown = (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      this._orbitDragging = true;
      this._orbitAuto = false;
      this._orbitLast.x = e.clientX;
      this._orbitLast.y = e.clientY;
      el.style.cursor = 'grabbing';
      try { el.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    };

    this._onPointerMove = (e) => {
      if (!this._orbitDragging) return;
      const dx = e.clientX - this._orbitLast.x;
      const dy = e.clientY - this._orbitLast.y;
      this._orbitLast.x = e.clientX;
      this._orbitLast.y = e.clientY;
      // Horizontal drag → azimuth, vertical → elevation.
      this._spherical.theta -= dx * 0.005;
      this._spherical.phi -= dy * 0.005;
      this._spherical.phi = Math.min(Math.PI - 0.12, Math.max(0.18, this._spherical.phi));
      e.preventDefault();
    };

    this._onPointerUp = (e) => {
      if (!this._orbitDragging) return;
      this._orbitDragging = false;
      el.style.cursor = 'grab';
      try { el.releasePointerCapture(e.pointerId); } catch {}
    };

    this._onWheel = (e) => {
      this._orbitAuto = false;
      this._spherical.radius *= Math.exp(e.deltaY * 0.0011);
      this._spherical.radius = Math.min(28, Math.max(5.5, this._spherical.radius));
      e.preventDefault();
    };

    // Canvas sits under a pointer-events:none vignette, so empty-scene
    // pointer hits land here. UI panels are higher z-index and keep their clicks.
    el.addEventListener('pointerdown', this._onPointerDown, { passive: false });
    el.addEventListener('pointermove', this._onPointerMove, { passive: false });
    el.addEventListener('pointerup', this._onPointerUp);
    el.addEventListener('pointercancel', this._onPointerUp);
    el.addEventListener('wheel', this._onWheel, { passive: false });
  }

  _applyOrbit(dt = 0) {
    if (this._orbitAuto && !this._orbitDragging) {
      this._spherical.theta += dt * 0.08;
    }
    this.camera.position.setFromSpherical(this._spherical).add(this._orbitTarget);
    this.camera.lookAt(this._orbitTarget);
  }

  _buildLights() {
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(4, 8, 6);
    this.scene.add(key);

    const rim = new THREE.PointLight(0x7c5cff, 26, 26, 2);
    rim.position.set(-5, 1.5, -4);
    this.scene.add(rim);

    const green = new THREE.PointLight(0x1ed760, 20, 22, 2);
    green.position.set(5, -1.5, -3);
    this.scene.add(green);

    this.scene.add(new THREE.AmbientLight(0x404050, 0.9));
  }

  _buildVinyl() {
    this.vinyl = new THREE.Group();
    this.vinyl.position.y = -0.2;

    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(2.55, 2.55, 0.055, 160, 1),
      new THREE.MeshStandardMaterial({ color: 0x0b0b0e, roughness: 0.28, metalness: 0.85 })
    );
    this.vinyl.add(disc);

    const label = new THREE.Mesh(
      new THREE.CylinderGeometry(0.82, 0.82, 0.062, 96),
      new THREE.MeshStandardMaterial({ color: 0x1ed760, roughness: 0.55, metalness: 0.1 })
    );
    label.position.y = 0.002;
    this.vinyl.add(label);

    const hole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 0.09, 24),
      new THREE.MeshStandardMaterial({ color: 0x050507, roughness: 1 })
    );
    hole.position.y = 0.008;
    this.vinyl.add(hole);

    const grooveMat = new THREE.MeshBasicMaterial({
      color: 0x9a9aae, transparent: true, opacity: 0.075, side: THREE.DoubleSide,
    });
    for (let i = 0; i < 34; i++) {
      const r = 0.92 + i * 0.048;
      const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.006, 128), grooveMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.030;
      this.vinyl.add(ring);
    }

    const outer = new THREE.Mesh(
      new THREE.RingGeometry(2.5, 2.56, 160),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, side: THREE.DoubleSide })
    );
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = 0.030;
    this.vinyl.add(outer);

    this.vinyl.rotation.x = -Math.PI / 2.35;
    this.vinyl.rotation.z = 0.18;
    this.scene.add(this.vinyl);
  }

  _buildParticles(count) {
    // Share the settings object so a rebuild (new instance) inherits whatever
    // the user configured — sliders and toggles must not silently reset.
    this.particles = new GPUParticles(this.renderer, count, this._settings);
    this.scene.add(this.particles.points);
    this.particles.points.visible = this.enabled.particles;
  }

  setAudio(a) { this.audio = a; }

  setCount(n) {
    this.scene.remove(this.particles.points);
    this.particles.dispose();
    this._buildParticles(n);
    this.particles.points.visible = this.enabled.particles;
  }

  setParam(name, value) {
    this._settings = this._settings || this.particles.settings;
    this.particles.set(name, value);
    this._settings[name] = value;
  }

  setRender(name, value) {
    this._settings = this._settings || this.particles.settings;
    this.particles.setRender(name, value);
    this._settings[name] = value;
  }

  setEffect(effect) {
    this.setParam('uEffect', effect);
    // The record sits in the middle of the bars and the tunnel.
    const mode = Math.round(effect);
    const hideRecord = mode === 4 || mode === 5;
    this.vinyl.visible = hideRecord ? false : this.enabled.vinyl;
  }

  setQuality(name) {
    this.quality = name === 'performance' || name === 'ultra' ? name : 'high';
    const dpr = window.devicePixelRatio || 1;
    const ratio = this.quality === 'performance' ? 1 : Math.min(dpr, 2);
    this.renderer.setPixelRatio(ratio);
    this.post.setQuality(this.quality);
    this.resize();
  }

  applyPreset(preset) {
    if (!preset) return;
    this.preset = preset;
    this.setToggle('particles', preset.particles !== false);
    this.setToggle('vinyl', !!preset.vinyl);
    this.setEffect(preset.effect ?? 0);
    this.layers.setBackground(preset.background || 'none');
    this.layers.setWaveform(!!preset.waveform);
    if (preset.bloom != null) this.setRender('uBloom', preset.bloom);
    this.post.setParams(preset.post || { bloom: 0, trails: 0, aberration: 0, vignette: 0.28 });
    this.stats.preset = preset.name || 'Live';
  }

  capturePreset() {
    return {
      id: 'custom',
      name: 'Saved look',
      effect: this._settings?.uEffect ?? 0,
      background: this.layers.background,
      waveform: this.layers.wave.visible,
      particles: this.enabled.particles,
      vinyl: this.enabled.vinyl,
      bloom: this._settings?.uBloom ?? 0.85,
      post: { ...this.post.params },
    };
  }

  _draw() {
    const layered = this.layers.background !== 'none' || this.post.active;
    if (!layered) {
      this.renderer.setRenderTarget(null);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.post.render(this.scene, this.camera, this.layers, this.audio);
  }

  setToggle(name, on) {
    this.enabled[name] = on;
    if (name === 'particles') this.particles.points.visible = on;
    if (name === 'vinyl') this.vinyl.visible = on;
    if (name === 'react') {
      this.particles.set('uReact', on ? 1 : 0);
      this.particles.setRender('uReact', on ? 1 : 0);
    }
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Only seed a default distance before the user has orbited.
    if (this._orbitAuto) {
      const wide = w / h > 1.4;
      this._spherical.radius = wide ? 12.5 : w < 760 ? 16 : 13.5;
      this._spherical.theta = wide ? 0.18 : 0;
      this._spherical.phi = 1.22;
    }
    this._applyOrbit(0);
    this.camera.updateProjectionMatrix();
    this._bufW = this.canvas.width;
    this._bufH = this.canvas.height;
    this.post.setSize(this._bufW, this._bufH);
  }

  _loop() {
    const dt = Math.min(this.clock.getDelta(), 1 / 20);
    if (document.hidden) return;
    const t = this.clock.elapsedTime;

    // Sample the beat engine every frame. A 100ms timer misses kick transients
    // and the particle cloud just sits there looking unsynced.
    if (this.onAudioTick) {
      const bands = this.onAudioTick(dt, t);
      if (bands) this.audio = bands;
    }

    this.particles.update(dt, this.audio, t);
    const kick = this.audio.kick || 0;
    const onset = this.audio.onset || 0;
    this.vinyl.rotation.z += dt * (0.35 + kick * 2.4) + onset * 0.035;
    const vs = 1 + kick * 0.045;
    this.vinyl.scale.set(vs, vs, vs);

    this._applyOrbit(dt);
    this.layers.sync(this.audio, t, this._bufW, this._bufH);

    const t0 = performance.now();
    this._draw();
    this._frameMs = this._frameMs * 0.85 + (performance.now() - t0) * 0.15;

    this._fpsAcc += dt;
    this._fpsFrames++;
    if (this._fpsAcc > 0.5) {
      this.fps = Math.round(this._fpsFrames / this._fpsAcc);
      this._fpsAcc = 0;
      this._fpsFrames = 0;
    }
    this.stats.backend = this.backend;
    this.stats.fps = this.fps;
    this.stats.frameMs = this._frameMs;
    this.stats.particles = this.particles?.count || 0;
    this.stats.preset = this.preset?.name || 'Live';
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointercancel', this._onPointerUp);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.renderer.setAnimationLoop(null);
    this.particles.dispose();
    this.layers.dispose();
    this.post.dispose();
    this.renderer.dispose();
  }
}
