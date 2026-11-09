/**
 * audio.js — local playback plus a 31-band 1/3-octave analyser.
 * Spotify audio is read by capturing this tab. Local files attach directly.
 */
export const EQ_BANDS = 31;

// Feed a fast, beat-sensitive envelope alongside the full 31-band FFT.
// A rising bass transient creates a pulse; a sustained tone does not.
export class AudioMotion {
  constructor() {
    this.pulse = 0;
    this.energy = 0;
    this.previousBass = 0;
    this.bass = 0;
    this.mid = 0;
    this.treble = 0;
  }

  sample(spectrum, dt = 1 / 60) {
    const decay = Math.exp(-Math.max(0, dt) * 8);
    if (!spectrum?.length) {
      this.pulse *= decay;
      this.energy *= Math.exp(-Math.max(0, dt) * 7);
      this.previousBass = 0;
      this.bass = this.mid = this.treble = 0;
      return { spectrum: null, pulse: this.pulse, energy: this.energy, bass: 0, mid: 0, treble: 0 };
    }
    const avg = (start, end) => {
      let sum = 0;
      for (let i = start; i < end; i++) sum += Math.max(0, Number(spectrum[i]) || 0);
      return sum / (end - start);
    };
    this.bass = avg(2, 11);
    this.mid = avg(11, 23);
    this.treble = avg(23, 31);
    const level = this.bass * 0.42 + this.mid * 0.38 + this.treble * 0.20;
    this.energy += (level - this.energy) * (level > this.energy ? 0.75 : 0.12);
    const onset = Math.max(0, this.bass - this.previousBass) * 1.25;
    this.pulse = Math.max(this.pulse * decay, Math.min(1, onset));
    this.previousBass = this.bass;
    return { spectrum, pulse: this.pulse, energy: this.energy,
      bass: this.bass, mid: this.mid, treble: this.treble };
  }
}

function createAnalyser(ctx) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.2;
  analyser.minDecibels = -90;
  analyser.maxDecibels = -18;
  return analyser;
}

class SpectrumProbe {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.freq = null;
    this.spectrum = new Float32Array(EQ_BANDS);
    this._smooth = new Float32Array(EQ_BANDS);
  }

  _bindAnalyser(ctx, analyser) {
    this.ctx = ctx;
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
  }

  _meanHz(lo, hi) {
    const n = this.freq.length;
    const nyquist = this.ctx.sampleRate / 2;
    const i0 = Math.max(0, Math.floor((lo / nyquist) * n));
    const i1 = Math.max(i0 + 1, Math.min(n, Math.ceil((hi / nyquist) * n)));
    let peak = 0;
    for (let i = i0; i < i1; i++) if (this.freq[i] > peak) peak = this.freq[i];
    return peak / 255;
  }

  sample() {
    if (!this.analyser || !this.ctx) return null;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.analyser.getByteFrequencyData(this.freq);
    const nyquist = this.ctx.sampleRate / 2;
    for (let i = 0; i < EQ_BANDS; i++) {
      const center = 20 * Math.pow(2, i / 3);
      const lo = Math.max(18, center / Math.pow(2, 1 / 6));
      const hi = Math.min(nyquist, center * Math.pow(2, 1 / 6));
      const raw = Math.min(1, Math.pow(Math.max(0, this._meanHz(lo, hi)) * 2.15, 0.78));
      const cur = this._smooth[i];
      this._smooth[i] = cur + (raw - cur) * (raw > cur ? 0.62 : 0.16);
      this.spectrum[i] = this._smooth[i];
    }
    return this.spectrum;
  }
}

export class LiveAudio {
  constructor() {
    this.probe = new SpectrumProbe();
    this.source = null;
    this.stream = null;
    this.keepAlive = null;
    this.active = false;
    this.onStop = null;
  }

  get ok() {
    return this.active && this.probe.analyser && this.stream?.getAudioTracks().some((t) => t.readyState === 'live');
  }

  get spectrum() { return this.probe.spectrum; }

  async start() {
    if (this.ok) {
      if (this.probe.ctx?.state === 'suspended') await this.probe.ctx.resume();
      return true;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      const err = new Error('unsupported');
      err.code = 'unsupported';
      throw err;
    }
    const opts = {
      video: { frameRate: 1, width: 16, height: 16 },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        suppressLocalAudioPlayback: false,
      },
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      systemAudio: 'include',
      surfaceSwitching: 'exclude',
    };
    let stream;
    try {
      if (typeof CaptureController === 'function') {
        const controller = new CaptureController();
        controller.setFocusBehavior?.('no-focus-change');
        stream = await navigator.mediaDevices.getDisplayMedia({ ...opts, controller });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia(opts);
      }
    } catch (e) {
      const err = new Error('denied');
      err.code = e.name === 'NotAllowedError' ? 'denied' : 'failed';
      throw err;
    }
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      const err = new Error('no-audio');
      err.code = 'no-audio';
      throw err;
    }
    this.stop();
    this.stream = stream;
    this.keepAlive = document.getElementById('capture-sink');
    if (this.keepAlive) {
      this.keepAlive.srcObject = stream;
      this.keepAlive.muted = true;
      this.keepAlive.play?.().catch(() => {});
    }
    const ctx = new AudioContext();
    this.source = ctx.createMediaStreamSource(stream);
    const analyser = createAnalyser(ctx);
    this.source.connect(analyser);
    this.probe._bindAnalyser(ctx, analyser);
    this.active = true;
    stream.getAudioTracks()[0].addEventListener('ended', () => this.stop());
    return true;
  }

  stop() {
    const was = this.active;
    this.active = false;
    try { this.source?.disconnect(); } catch {}
    try { this.probe.ctx?.close(); } catch {}
    this.stream?.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    if (this.keepAlive) this.keepAlive.srcObject = null;
    this.source = null;
    this.stream = null;
    this.probe.ctx = null;
    this.probe.analyser = null;
    if (was) this.onStop?.();
  }

  tick() {
    if (!this.ok) return null;
    return this.probe.sample();
  }
}

/**
 * FileAudio — local file playback. The element is routed through an
 * AnalyserNode once, then to the speakers.
 */
export class FileAudio {
  constructor(audioEl) {
    this.el = audioEl;
    this.playlist = [];
    this.index = -1;
    this.onTrack = null;
    this.onEnded = null;
    this.probe = new SpectrumProbe();
    this._ctx = null;

    this.el.addEventListener('ended', () => this.onEnded?.());
    this.el.addEventListener('loadedmetadata', () => this._emitTrack());
    this.el.addEventListener('play', () => this._emitTrack());
    this.el.addEventListener('pause', () => this._emitTrack());
    this.el.addEventListener('timeupdate', () => this._emitTrack(false));
  }

  get ready() {
    return this.index >= 0 && !!this.el.src;
  }

  get spectrum() { return this.probe.spectrum; }

  get current() {
    return this.index >= 0 ? this.playlist[this.index] : null;
  }

  async ensureGraph() {
    if (this._ctx) {
      if (this._ctx.state === 'suspended') await this._ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this._ctx = ctx;
    const source = ctx.createMediaElementSource(this.el);
    const analyser = createAnalyser(ctx);
    source.connect(analyser);
    analyser.connect(ctx.destination);
    this.probe._bindAnalyser(ctx, analyser);
    if (ctx.state === 'suspended') await ctx.resume();
  }

  setVolume(v) {
    this.el.volume = Math.min(1, Math.max(0, Number(v) || 0));
  }

  addFiles(fileList) {
    const files = [...fileList].filter((f) =>
      /^audio\//.test(f.type) || /\.(mp3|wav|ogg|flac|m4a|aac|opus|webm)$/i.test(f.name)
    );
    if (!files.length) return 0;
    for (const file of files) {
      this.playlist.push({
        id: `${file.name}:${file.size}:${file.lastModified}`,
        name: file.name.replace(/\.[^.]+$/, ''),
        fileName: file.name,
        size: file.size,
        url: URL.createObjectURL(file),
        file,
      });
    }
    return files.length;
  }

  clear() {
    this.pause();
    for (const t of this.playlist) {
      try { URL.revokeObjectURL(t.url); } catch {}
    }
    this.playlist = [];
    this.index = -1;
    this.el.removeAttribute('src');
    this.el.load();
    this._emitTrack();
  }

  async playIndex(i) {
    if (i < 0 || i >= this.playlist.length) return false;
    await this.ensureGraph();
    this.index = i;
    const track = this.playlist[i];
    if (this.el.src !== track.url) {
      this.el.src = track.url;
      this.el.load();
    }
    try {
      await this.el.play();
      this._emitTrack();
      return true;
    } catch (e) {
      console.warn('[file] play', e);
      return false;
    }
  }

  async toggle() {
    if (!this.playlist.length) return false;
    await this.ensureGraph();
    if (this.index < 0) return this.playIndex(0);
    if (this.el.paused) {
      try {
        await this.el.play();
        this._emitTrack();
        return true;
      } catch {
        return false;
      }
    }
    this.el.pause();
    this._emitTrack();
    return true;
  }

  pause() {
    this.el.pause();
    this._emitTrack();
  }

  seek(ms) {
    if (!Number.isFinite(ms)) return;
    this.el.currentTime = Math.max(0, ms / 1000);
    this._emitTrack();
  }

  async next() {
    if (!this.playlist.length) return false;
    const i = this.index < 0 ? 0 : (this.index + 1) % this.playlist.length;
    return this.playIndex(i);
  }

  async prev() {
    if (!this.playlist.length) return false;
    if (this.el.currentTime > 3) {
      this.seek(0);
      return true;
    }
    const i = this.index <= 0 ? this.playlist.length - 1 : this.index - 1;
    return this.playIndex(i);
  }

  tick() {
    if (!this.probe.analyser || this.el.paused) return null;
    return this.probe.sample();
  }

  _emitTrack(force = true) {
    if (!force && !this.onTrack) return;
    const track = this.current;
    this.onTrack?.({
      track,
      paused: this.el.paused || this.el.ended || !track,
      progressMs: (this.el.currentTime || 0) * 1000,
      durationMs: (Number.isFinite(this.el.duration) ? this.el.duration : 0) * 1000,
    });
  }
}
