/**
 * visualizer.js — empty WebGL scene.
 * The canvas is a Three.js renderer with a camera and a cleared frame.
 * Playback does not drive this scene.
 */
import * as THREE from 'https://esm.sh/three@0.169.0';

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
    this.camera.position.set(0, 0, 8);

    this.clock = new THREE.Clock();
    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this.fps = 0;
    this.backend = this.renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1';
    this.stats = { backend: this.backend, fps: 0, frameMs: 0 };

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();

    this._loop = this._loop.bind(this);
    this.renderer.setAnimationLoop(this._loop);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _loop() {
    const dt = Math.min(this.clock.getDelta(), 1 / 20);
    if (document.hidden) return;
    const t0 = performance.now();
    this.renderer.render(this.scene, this.camera);
    const ms = performance.now() - t0;
    this.stats.frameMs = (this.stats.frameMs || 0) * 0.85 + ms * 0.15;
    this._fpsAcc += dt;
    this._fpsFrames++;
    if (this._fpsAcc > 0.5) {
      this.fps = Math.round(this._fpsFrames / this._fpsAcc);
      this.stats.fps = this.fps;
      this._fpsAcc = 0;
      this._fpsFrames = 0;
    }
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
  }
}
