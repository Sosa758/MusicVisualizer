/**
 * FileAudio — local file playback through an <audio> element.
 * Supports mp3, wav, ogg, flac, m4a — whatever the browser can decode.
 */
export class FileAudio {
  constructor(audioEl) {
    this.el = audioEl;
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

  get ready() {
    return this.index >= 0 && !!this.el.src;
  }

  get current() {
    return this.index >= 0 ? this.playlist[this.index] : null;
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
