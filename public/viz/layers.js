/**
 * Screen-space backgrounds and a 3D waveform ribbon.
 * Audio uniforms are shared. Nothing here starts or routes playback.
 */
import * as THREE from 'https://esm.sh/three@0.169.0';

function bandGlsl() {
  let s = 'float bandAt(float x) {\n';
  for (let i = 0; i < 23; i++) {
    s += `  if (x < ${((i + 1) / 24).toFixed(5)}) return uSpectrum[${i}];\n`;
  }
  s += '  return uSpectrum[23];\n}\n';
  return s;
}

const HEADER = /* glsl */ `
uniform float uSpectrum[24];
uniform float uTime;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uKick;
uniform float uOnset;
uniform vec2 uResolution;
${bandGlsl()}
`;

const FULL_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PLASMA_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${HEADER}
void main() {
  vec2 uv = (vUv - 0.5) * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
  float t = uTime * (0.16 + uBass * 0.14);
  vec2 q = uv;
  q += 0.2 * vec2(sin(uv.y * 3.2 + t), cos(uv.x * 2.8 - t));
  q += 0.08 * uMid * vec2(sin(uv.x * 6.0 - t), cos(uv.y * 5.0 + t));
  float n = sin(q.x * 4.0 + uMid * 2.0) * sin(q.y * 3.4 - t);
  n += 0.55 * sin(length(q) * (5.0 + uTreble * 6.0) - t * 2.2);
  float spec = bandAt(clamp(vUv.x, 0.0, 0.999));
  vec3 col = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + n * 1.4 + spec * 3.5 + uBass);
  col *= 0.16 + spec * 0.62 + uKick * 0.22;
  gl_FragColor = vec4(col, 1.0);
}
`;

const FRACTAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${HEADER}
void main() {
  vec2 uv = (vUv - 0.5) * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
  float zoom = 1.35 + uBass * 0.9;
  vec2 z = uv * zoom;
  vec2 c = z * 0.35 + 0.18 * vec2(sin(uTime * 0.21), cos(uTime * 0.17));
  c += (uMid - 0.4) * 0.35;
  float m = 0.0;
  float keep = 1.0;
  for (int i = 0; i < 24; i++) {
    vec2 nz = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    float inside = step(dot(z, z), 8.0);
    z = mix(z, nz, inside);
    m += inside * keep;
    keep *= inside;
  }
  float spec = bandAt(clamp(vUv.x, 0.0, 0.999));
  vec3 col = 0.5 + 0.5 * cos(vec3(0.4, 0.7, 1.1) * m * 0.2 + vec3(0.2, 2.0, 4.0) + spec * 4.0);
  col *= smoothstep(24.0, 1.0, m) * (0.28 + uTreble * 0.45 + uKick * 0.25);
  gl_FragColor = vec4(col, 1.0);
}
`;

const META_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${HEADER}
float field(vec2 p) {
  float f = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 c = vec2(
      sin(uTime * (0.28 + fi * 0.06) + fi * 1.7),
      cos(uTime * 0.23 + fi * 1.3)
    );
    c *= 0.32 + uBass * 0.28;
    float r = 0.11 + bandAt(fi / 5.0) * 0.2;
    if (fi < 0.5) r += uKick * 0.1;
    float d = length(p - c);
    f += (r * r) / max(d * d, 0.0008);
  }
  return f;
}
void main() {
  vec2 uv = (vUv - 0.5) * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
  float f = field(uv);
  float body = smoothstep(0.9, 1.2, f);
  vec3 col = mix(vec3(0.015, 0.02, 0.04), vec3(0.12, 0.82, 0.55), body);
  col = mix(col, vec3(0.45, 0.28, 1.0), smoothstep(1.5, 2.6, f));
  col += vec3(1.0, 0.45, 0.25) * uOnset * body * 0.45;
  gl_FragColor = vec4(col, 1.0);
}
`;

const WAVE_VERT = /* glsl */ `
uniform float uSpectrum[24];
uniform float uBass;
uniform float uTime;
${bandGlsl()}
varying float vAmp;
varying vec2 vUv;
void main() {
  vUv = uv;
  float amp = bandAt(clamp(uv.x, 0.0, 0.999));
  vec3 p = position;
  p.y += (amp * (1.5 + uBass) + 0.04) * (uv.y - 0.5) * 2.2;
  p.z += sin(uv.x * 10.0 + uTime * 1.4) * amp * 0.18;
  vAmp = amp;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const WAVE_FRAG = /* glsl */ `
precision highp float;
varying float vAmp;
varying vec2 vUv;
void main() {
  vec3 col = mix(vec3(0.15, 0.45, 1.0), vec3(1.0, 0.25, 0.18), vUv.x);
  col *= 0.35 + vAmp * 1.1;
  gl_FragColor = vec4(col, 0.85);
}
`;

export class SceneLayers {
  constructor(scene) {
    this.background = 'none';
    this.uniforms = {
      uSpectrum: { value: new Float32Array(24) },
      uTime: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uKick: { value: 0 },
      uOnset: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
    };

    const mat = (fragmentShader) => new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: FULL_VERT,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.plasmaMat = mat(PLASMA_FRAG);
    this.fractalMat = mat(FRACTAL_FRAG);
    this.metaMat = mat(META_FRAG);

    this.bgScene = new THREE.Scene();
    this.bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.bgQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.plasmaMat);
    this.bgQuad.frustumCulled = false;
    this.bgScene.add(this.bgQuad);

    this.wave = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 1.6, 64, 1),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: WAVE_VERT,
        fragmentShader: WAVE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    this.wave.position.set(0, -1.7, 0.4);
    this.wave.visible = false;
    this.wave.frustumCulled = false;
    scene.add(this.wave);
  }

  setBackground(name) {
    this.background = name || 'none';
    const mat = name === 'fractal' ? this.fractalMat
      : name === 'metaballs' ? this.metaMat
        : this.plasmaMat;
    this.bgQuad.material = mat;
  }

  setWaveform(on) {
    this.wave.visible = !!on;
  }

  sync(audio, t, width, height) {
    const u = this.uniforms;
    u.uTime.value = t;
    u.uBass.value = audio.bass || 0;
    u.uMid.value = audio.mid || 0;
    u.uTreble.value = audio.treble || 0;
    u.uKick.value = audio.kick || 0;
    u.uOnset.value = audio.onset || 0;
    u.uResolution.value.set(width || 1, height || 1);

    const spec = u.uSpectrum.value;
    const src = audio.spectrum;
    if (src?.length) {
      const n = src.length;
      for (let i = 0; i < 24; i++) {
        const from = Math.floor((i * n) / 24);
        const to = Math.max(from + 1, Math.floor(((i + 1) * n) / 24));
        let peak = 0;
        for (let j = from; j < to && j < n; j++) {
          const v = src[j] || 0;
          if (v > peak) peak = v;
        }
        spec[i] = peak;
      }
    } else {
      const b = audio.bass || 0;
      const m = audio.mid || 0;
      const tr = audio.treble || 0;
      for (let i = 0; i < 24; i++) {
        const p = i / 23;
        spec[i] = p < 0.33 ? b : p < 0.66 ? m : tr;
      }
    }
  }

  dispose() {
    this.bgQuad.geometry.dispose();
    this.plasmaMat.dispose();
    this.fractalMat.dispose();
    this.metaMat.dispose();
    this.wave.geometry.dispose();
    this.wave.material.dispose();
  }
}
