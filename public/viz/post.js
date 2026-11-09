/**
 * Half-resolution bloom, feedback trails, chromatic aberration, vignette.
 * Used only when a preset turns a pass on. Otherwise the scene draws directly.
 */
import * as THREE from 'https://esm.sh/three@0.169.0';

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const EXTRACT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(c * smoothstep(0.35, 0.95, l), 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb * 0.227027;
  c += texture2D(tDiffuse, vUv + uDir * 1.3846).rgb * 0.316216;
  c += texture2D(tDiffuse, vUv - uDir * 1.3846).rgb * 0.316216;
  c += texture2D(tDiffuse, vUv + uDir * 3.2308).rgb * 0.070270;
  c += texture2D(tDiffuse, vUv - uDir * 3.2308).rgb * 0.070270;
  gl_FragColor = vec4(c, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tHist;
uniform float uBloom;
uniform float uTrails;
uniform float uAberration;
uniform float uVignette;
uniform float uBass;
varying vec2 vUv;
void main() {
  vec2 centered = vUv - 0.5;
  float shift = uAberration * (0.004 + uBass * 0.006) * length(centered);
  vec2 dir = centered * shift;
  float r = texture2D(tScene, vUv + dir).r;
  float g = texture2D(tScene, vUv).g;
  float b = texture2D(tScene, vUv - dir).b;
  vec3 col = vec3(r, g, b);
  col += texture2D(tBloom, vUv).rgb * uBloom;
  vec3 hist = texture2D(tHist, vUv).rgb;
  col = mix(col, max(col, hist * 0.92), clamp(uTrails, 0.0, 0.85));
  float vig = smoothstep(0.95, 0.25, length(centered));
  col *= mix(1.0, vig, clamp(uVignette, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}
`;

const COPY_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tDiffuse, vUv);
}
`;

function makeTarget(w, h) {
  return new THREE.WebGLRenderTarget(w, h, {
    depthBuffer: true,
    stencilBuffer: false,
  });
}

export class PostPipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.params = { bloom: 0, trails: 0, aberration: 0, vignette: 0.28 };
    this.scale = 1;
    this.blurPasses = 2;
    this._w = 2;
    this._h = 2;

    this.rtScene = makeTarget(2, 2);
    this.rtA = makeTarget(2, 2);
    this.rtB = makeTarget(2, 2);
    this.hist = [makeTarget(2, 2), makeTarget(2, 2)];
    this.histIndex = 0;

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.extractMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: QUAD_VERT,
      fragmentShader: EXTRACT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uDir: { value: new THREE.Vector2() },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        tHist: { value: null },
        uBloom: { value: 0 },
        uTrails: { value: 0 },
        uAberration: { value: 0 },
        uVignette: { value: 0.28 },
        uBass: { value: 0 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: QUAD_VERT,
      fragmentShader: COPY_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this._black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this._black.needsUpdate = true;
  }

  get active() {
    const p = this.params;
    return p.bloom > 0.01 || p.trails > 0.01 || p.aberration > 0.001;
  }

  setParams(next) {
    if (!next) return;
    Object.assign(this.params, next);
  }

  setQuality(name) {
    this.scale = name === 'performance' ? 0.65 : 1;
    this.blurPasses = name === 'ultra' ? 3 : name === 'performance' ? 1 : 2;
    this.setSize(this._w, this._h);
  }

  setSize(w, h) {
    this._w = Math.max(2, w | 0);
    this._h = Math.max(2, h | 0);
    const rw = Math.max(2, Math.floor(this._w * this.scale));
    const rh = Math.max(2, Math.floor(this._h * this.scale));
    this.rtScene.setSize(rw, rh);
    const bw = Math.max(2, rw >> 1);
    const bh = Math.max(2, rh >> 1);
    this.rtA.setSize(bw, bh);
    this.rtB.setSize(bw, bh);
    this.hist[0].setSize(rw, rh);
    this.hist[1].setSize(rw, rh);
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  render(scene, camera, layers, audio) {
    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.autoClear;
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(this.rtScene);
    renderer.clear(true, true, false);
    if (layers.background !== 'none') {
      renderer.render(layers.bgScene, layers.bgCamera);
    }
    renderer.clearDepth();
    renderer.autoClear = false;
    renderer.render(scene, camera);
    renderer.autoClear = prevClear;

    const bloomOn = this.params.bloom > 0.01;
    if (bloomOn) {
      this.extractMat.uniforms.tDiffuse.value = this.rtScene.texture;
      this._pass(this.extractMat, this.rtA);
      const bw = this.rtA.width;
      const bh = this.rtA.height;
      let read = this.rtA;
      let write = this.rtB;
      for (let i = 0; i < this.blurPasses; i++) {
        this.blurMat.uniforms.tDiffuse.value = read.texture;
        this.blurMat.uniforms.uDir.value.set(1 / bw, 0);
        this._pass(this.blurMat, write);
        const swap = read;
        read = write;
        write = swap;
        this.blurMat.uniforms.tDiffuse.value = read.texture;
        this.blurMat.uniforms.uDir.value.set(0, 1 / bh);
        this._pass(this.blurMat, write);
        const swap2 = read;
        read = write;
        write = swap2;
      }
      this._bloomTex = read.texture;
    }

    const next = this.hist[this.histIndex];
    const prev = this.hist[1 - this.histIndex];
    const c = this.compositeMat.uniforms;
    c.tScene.value = this.rtScene.texture;
    c.tBloom.value = bloomOn ? this._bloomTex : this._black;
    c.tHist.value = prev.texture;
    c.uBloom.value = bloomOn ? this.params.bloom : 0;
    c.uTrails.value = this.params.trails;
    c.uAberration.value = this.params.aberration;
    c.uVignette.value = this.params.vignette;
    c.uBass.value = audio?.bass || 0;
    this._pass(this.compositeMat, next);

    this.copyMat.uniforms.tDiffuse.value = next.texture;
    this._pass(this.copyMat, null);
    this.histIndex = 1 - this.histIndex;
    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    this.rtScene.dispose();
    this.rtA.dispose();
    this.rtB.dispose();
    this.hist[0].dispose();
    this.hist[1].dispose();
    this.extractMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.copyMat.dispose();
    this.quad.geometry.dispose();
  }
}
