/**
 * Audio analysis for the particle visualizer.
 *
 * LiveAudio  — tab-capture FFT (hears Spotify's cross-origin iframe mix)
 * FileAudio  — MediaElementSource FFT (local MP3/WAV/etc., no capture prompt)
 *
 * Both expose the same tick() shape so the visualizer can treat them alike.
 */

function createAnalyser(ctx) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  // A little analyser smoothing, then an attack/release envelope below.
  // Raw FFT at 0.08 was stepping the cloud every frame.
  analyser.smoothingTimeConstant = 0.22;
  analyser.minDecibels = -85;
  analyser.maxDecibels = -16;
  return analyser;
}

class SpectrumProbe {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.freq = null;
    this.wave = null;
    this.spectrum = new Float32Array(48);
    this.prevBass = 0;
    this.prevFreq = null;
    this._onsetHold = 0;
    this._onsetEnv = 0;
    this.out = { bass: 0, mid: 0, treble: 0, kick: 0, onset: 0 };
  }

  _bindAnalyser(ctx, analyser) {
    this.ctx = ctx;
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.wave = new Uint8Array(analyser.fftSize);
    this.prevFreq = new Float32Array(analyser.frequencyBinCount);
    this.prevBass = 0;
  }

  _clearOut() {
    this.out.bass = this.out.mid = this.out.treble = this.out.kick = this.out.onset = 0;
    this.spectrum.fill(0);
  }

  _meanHz(lo, hi) {
    const n = this.freq.length;
    const nyquist = this.ctx.sampleRate / 2;
    const i0 = Math.max(0, Math.floor((lo / nyquist) * n));
    const i1 = Math.max(i0 + 1, Math.min(n, Math.ceil((hi / nyquist) * n)));
    let s = 0;
    for (let i = i0; i < i1; i++) s += this.freq[i];
    return s / ((i1 - i0) * 255);
  }

  sample() {
    if (!this.analyser || !this.ctx) return null;
    if (this.ctx.state === 'suspended') this.ctx.resume();

    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.wave);

    const bassRaw = this._meanHz(30, 140);
    const lowMid = this._meanHz(140, 400);
    const midRaw = this._meanHz(400, 2200);
    const trebleRaw = this._meanHz(2200, 11000);

    const comp = (v, g) => Math.min(1, Math.pow(Math.max(0, v) * g, 0.72));
    const bass = comp(bassRaw, 2.4);
    const mid = comp(midRaw * 0.65 + lowMid * 0.35, 2.1);
    const treble = comp(trebleRaw, 2.2);

    let rms = 0;
    for (let i = 0; i < this.wave.length; i++) {
      const x = (this.wave[i] - 128) / 128;
      rms += x * x;
    }
    rms = Math.sqrt(rms / this.wave.length);

    let flux = 0;
    let lowFlux = 0;
    const lowN = Math.max(6, Math.floor(this.freq.length * 0.06));
    for (let i = 0; i < this.freq.length; i++) {
      const d = this.freq[i] / 255 - this.prevFreq[i];
      if (d > 0) {
        flux += d;
        if (i < lowN) lowFlux += d;
      }
      this.prevFreq[i] = this.freq[i] / 255;
    }
    flux /= this.freq.length;
    lowFlux /= lowN;

    const bassRise = Math.max(0, bass - this.prevBass);
    this.prevBass = bass;
    // A short decaying pulse, not a hard two-frame square wave.
    const onsetRaw = Math.min(1, bassRise * 10 + Math.max(0, lowFlux - 0.02) * 4);
    if (onsetRaw > 0.08) this._onsetEnv = Math.max(this._onsetEnv, onsetRaw);
    this._onsetEnv *= 0.78;
    const onset = this._onsetEnv;
    const kickTarget = Math.min(1, bass * 0.7 + bassRise * 2.4 + rms * 0.6);

    const follow = (cur, tgt) => cur + (tgt - cur) * (tgt > cur ? 0.55 : 0.14);
    this.out.bass = follow(this.out.bass, bass);
    this.out.mid = follow(this.out.mid, mid);
    this.out.treble = follow(this.out.treble, treble);
    this.out.kick = follow(this.out.kick, kickTarget);
    this.out.onset = onset;

    const bars = this.spectrum.length;
    const nyquist = this.ctx.sampleRate / 2;
    const loHz = 25;
    const hiHz = Math.min(20000, nyquist);
    const ratio = hiHz / loHz;
    for (let i = 0; i < bars; i++) {
      const lo = loHz * Math.pow(ratio, i / bars);
      const hi = loHz * Math.pow(ratio, (i + 1) / bars);
      const raw = comp(this._meanHz(lo, hi), 2.0);
      this.spectrum[i] = follow(this.spectrum[i], raw);
    }

    return this.out;
  }
}

/**
 * LiveAudio — real FFT of whatever this tab is playing (Spotify iframe mix).
 */
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
  get out() { return this.probe.out; }

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
    stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => this.stop()));
    return true;
  }

  stop() {
    const was = this.active;
    this.active = false;
    try { this.source?.disconnect(); } catch {}
    try { this.probe.ctx?.close(); } catch {}
    this.stream?.getTracks().forEach((t) => {
      try { t.stop(); } catch {}
    });
    if (this.keepAlive) this.keepAlive.srcObject = null;
    this.source = null;
    this.stream = null;
    this.probe.ctx = null;
    this.probe.analyser = null;
    this.probe._clearOut();
    if (was) this.onStop?.();
  }

  tick() {
    if (!this.ok) return null;
    return this.probe.sample();
  }
}

/**
 * FileAudio — play local files with a direct AnalyserNode (no tab capture).
 * Supports mp3, wav, ogg, flac, m4a — whatever the browser can decode.
 */
export class FileAudio {
  constructor(audioEl) {
    this.el = audioEl;
    this.probe = new SpectrumProbe();
    this.source = null;
    this.gain = null;
    this.active = false;
    this.playlist = [];
    this.index = -1;
    this.onTrack = null;
    this.onEnded = null;

    this.el.addEventListener('ended', () => {
      this.onEnded?.();
    });
    this.el.addEventListener('loadedmetadata', () => this._emitTrack());
    this.el.addEventListener('play', () => this._emitTrack());
    this.el.addEventListener('pause', () => this._emitTrack());
    this.el.addEventListener('timeupdate', () => this._emitTrack(false));
  }

  get ok() {
    return this.active && this.probe.analyser && !this.el.paused && !this.el.ended;
  }

  get ready() {
    return this.active && !!this.probe.analyser;
  }

  get spectrum() { return this.probe.spectrum; }
  get out() { return this.probe.out; }

  get current() {
    return this.index >= 0 ? this.playlist[this.index] : null;
  }

  async ensureGraph() {
    if (this.active && this.probe.ctx) {
      if (this.probe.ctx.state === 'suspended') await this.probe.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    // createMediaElementSource can only be called once per element.
    this.source = ctx.createMediaElementSource(this.el);
    const analyser = createAnalyser(ctx);
    this.gain = ctx.createGain();
    this.source.connect(analyser);
    analyser.connect(this.gain);
    this.gain.connect(ctx.destination);
    this.probe._bindAnalyser(ctx, analyser);
    this.active = true;
    if (ctx.state === 'suspended') await ctx.resume();
  }

  setVolume(v) {
    const vol = Math.min(1, Math.max(0, Number(v) || 0));
    this.el.volume = vol;
    if (this.gain) this.gain.gain.value = 1;
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
    if (!this.ready) return null;
    // Keep sampling while paused so the meter freezes on the last frame
    // rather than dropping to the BPM fallback mid-song.
    if (this.el.paused) {
      this.probe._clearOut();
      return null;
    }
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
