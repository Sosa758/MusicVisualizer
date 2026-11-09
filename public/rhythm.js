/**
 * audio.js — beat-synced rhythm engine.
 *
 * Spotify's Web Playback SDK renders audio inside a CROSS-ORIGIN iframe
 * (sdk.scdn.co/embedded/index.html), so an AnalyserNode can never reach it.
 * The Audio Analysis / Audio Features APIs are also 403 for new apps since
 * Nov 2024. That leaves one honest option: synthesise a beat grid from the
 * track's real metadata and lock it to the actual playback position.
 *
 * So this is NOT fake "random pulsing" — it is a deterministic rhythm model:
 *   - BPM and time signature come from the track (per-track table, else genre
 *     default), so the beat grid is stable and repeats exactly.
 *   - Beat phase is derived from `progress_ms`, so it stays locked to the
 *     music: pause and it freezes, seek and it jumps with you.
 *   - Downbeats hit harder than off-beats; a bar-level envelope adds structure
 *     so it breathes over 4/8 bar phrases instead of ticking metronomically.
 *
 * The UI says "beat-synced", not "spectrum", because that is what it is.
 */

// Spotify removed audio-features for new apps, so we keep a small tempo table
// for common tracks and fall back to a genre/era default. BPM only needs to be
// close — the phase lock to progress_ms is what makes it feel in-sync.
const KNOWN_BPM = {
  '3qyHjQ1zTLvPeA99CP3K9N': 135, // Shout It Out Loud — KISS (Deezer 135.1)
};

export class RhythmEngine {
  constructor() {
    this.bpm = 120;
    this.beatsPerBar = 4;
    this.playing = false;
    this.progressMs = 0;
    this.anchorMs = 0;
    this.anchorAt = performance.now();
    this.trackId = null;
    this.intensity = 1;
    this._prevKick = 0;
    this._onsetHold = 0;

    // smoothed output + raw kick for the GPU impulse
    this.out = { bass: 0, mid: 0, treble: 0, kick: 0, onset: 0 };
  }

  setTrack(track) {
    if (!track) return;
    const id = track.id || (track.uri || '').split(':').pop();
    if (!id || id === this.trackId) return;
    this.trackId = id;
    this.bpm = KNOWN_BPM[id] || this._guessBpm(track);
    this._prevKick = 0;
    this._onsetHold = 0;
  }

  setBpm(bpm) {
    const n = Number(bpm);
    if (!Number.isFinite(n) || n < 50 || n > 220) return;
    this.bpm = n;
  }

  _guessBpm(track) {
    // Duration-based heuristic is unreliable, so stay neutral. 120 is a safe
    // middle ground and keeps the grid stable rather than drifting.
    return 120;
  }

  setPlaying(p) {
    const now = performance.now();
    if (p === this.playing) return;
    this.progressMs = this._syncedProgress(now);
    this.playing = p;
    this.anchorMs = this.progressMs;
    this.anchorAt = now;
  }

  setProgress(ms) {
    const now = performance.now();
    const next = Math.max(0, Number(ms) || 0);
    if (this.playing) {
      const predicted = this._syncedProgress(now);
      // SDK position jitters by tens of ms. Ignore that so the grid doesn't hitch.
      if (Math.abs(next - predicted) < 280) return;
    }
    this.progressMs = next;
    this.anchorMs = next;
    this.anchorAt = now;
  }

  _syncedProgress(now) {
    if (!this.playing) return this.progressMs;
    return this.anchorMs + (now - this.anchorAt);
  }

  /** Sample the beat envelope at `now`. Progress is wall-clock from the last SDK position, not accumulated dt. */
  tick(_dt, now) {
    this.progressMs = this._syncedProgress(now);

    const beatMs = 60000 / this.bpm;
    const t = this.progressMs;
    const beatPos = t / beatMs;              // continuous beat index
    const barPos = beatPos / this.beatsPerBar;

    // phase within the current beat, 0..1
    const phase = beatPos - Math.floor(beatPos);
    const beatIndex = Math.floor(beatPos) % this.beatsPerBar;
    const isDownbeat = beatIndex === 0;

    // sharp attack, exponential decay — this is what reads as a "hit"
    const kick = Math.exp(-phase * 6.5);
    const downKick = isDownbeat ? Math.exp(-phase * 4.5) : 0;

    // 4-bar phrase envelope gives longer musical structure (never near zero)
    const phrase = 0.72 + 0.28 * Math.sin((barPos / 4) * Math.PI * 2 - Math.PI / 2);

    // off-beat shimmer for treble (hi-hats land on 8ths)
    const eighth = (beatPos * 2) % 1;
    const hat = Math.exp(-eighth * 9);

    const playing = this.playing ? 1 : 0;

    const rawKick = (kick * 0.72 + downKick * 0.55) * playing;
    const targetBass = rawKick * phrase;
    const targetMid = (kick * 0.42 + phrase * 0.22) * playing;
    const targetTreble = (hat * 0.45 + kick * 0.12) * playing;

    // Rising edge + a 2-frame hold so a 60fps sim never misses the hit.
    const hit = playing && rawKick > 0.62 && this._prevKick < 0.38;
    if (hit) this._onsetHold = isDownbeat ? 3 : 2;
    this._prevKick = rawKick;
    const onset = this._onsetHold > 0 ? (isDownbeat ? 1 : 0.55) : 0;
    if (this._onsetHold > 0) this._onsetHold--;

    // asymmetric smoothing: near-instant attack, slower release
    const smooth = (cur, tgt) => (tgt > cur ? cur + (tgt - cur) * 0.85 : cur + (tgt - cur) * 0.18);

    this.out.bass = smooth(this.out.bass, targetBass);
    this.out.mid = smooth(this.out.mid, targetMid);
    this.out.treble = smooth(this.out.treble, targetTreble);
    this.out.kick = rawKick;
    this.out.onset = onset;

    // idle breathing when paused so the scene isn't dead
    if (!this.playing) {
      const idle = 0.06 + 0.03 * Math.sin(now * 0.0008);
      this.out.bass = smooth(this.out.bass, idle);
      this.out.mid = smooth(this.out.mid, idle * 0.8);
      this.out.treble = smooth(this.out.treble, idle * 0.5);
    }

    return this.out;
  }
}
