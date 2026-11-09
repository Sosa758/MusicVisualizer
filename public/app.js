/**
 * app.js — Spotify Web Playback SDK + local files + audio-reactive visualizer.
 *
 * Two playback sources:
 *   Spotify — SDK iframe is cross-origin, so particles need tab-audio capture
 *             (or a BPM beat-grid fallback).
 *   Local   — MP3/WAV/etc. through an <audio> element; AnalyserNode attaches
 *             directly, so particles follow the real waveform with no capture.
 */
// The version query must match the one on the <script> tag in index.html.
// Without it, browsers cache visualizer.js/rhythm.js independently of app.js
// and a deploy silently keeps running stale modules.
const V = new URL(import.meta.url).search;
const { Visualizer } = await import(`./visualizer.js${V}`);
const { RhythmEngine } = await import(`./rhythm.js${V}`);
const { LiveAudio, FileAudio } = await import(`./audio.js${V}`);
const { PRESETS } = await import(`./viz/presets.js${V}`);

const $ = (s) => document.querySelector(s);
const api = (p, opts = {}) => fetch(`/api/spotify/${p}`, opts);

const state = {
  source: 'spotify', // 'spotify' | 'local'
  token: null,
  player: null,
  deviceId: null,
  track: null,
  context: null,
  paused: true,
  progressMs: 0,
  durationMs: 0,
  shuffle: false,
  repeat: 'off',
  volume: 0.65,
  queue: [],
  playlists: [],
  lastTick: performance.now(),
};

/* ───────────────────────── visualizer ───────────────────────── */

const viz = new Visualizer($('#scene'));
$('#renderer-info').textContent = viz.renderer.capabilities.isWebGL2 ? 'WebGL2 · GPU compute' : 'WebGL1';

/* ───────────────────────── audio analysis ───────────────────────── */

const rhythm = new RhythmEngine();
const live = new LiveAudio();
live.onStop = () => {
  paintLiveToggle();
  setMeterMode();
};
const fileAudio = new FileAudio($('#local-audio'));
fileAudio.setVolume(state.volume);
fileAudio.onTrack = ({ track, paused, progressMs, durationMs }) => {
  if (state.source !== 'local') return;
  state.paused = paused;
  state.progressMs = progressMs;
  state.durationMs = durationMs;
  state.track = track
    ? { name: track.name, artists: [{ name: 'Local file' }], album: { name: track.fileName }, uri: track.id }
    : null;
  renderTrack();
  renderProgress();
  renderPlayState();
  setStatus(paused ? (track ? 'paused' : 'local') : 'playing', !paused);
  paintLocalList();
};
fileAudio.onEnded = () => {
  if (state.source === 'local') fileAudio.next();
};

const bands = { bass: 0, mid: 0, treble: 0, kick: 0, onset: 0 };
const bpmCache = new Map();
let bpmInFlight = '';
let wantLiveAudio = true;

function paintLiveToggle() {
  const btn = $('#t-live');
  if (!btn) return;
  const on = state.source === 'spotify' && live.ok;
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-checked', String(on));
  btn.disabled = state.source === 'local';
  btn.closest('.toggle-row')?.classList.toggle('dimmed', state.source === 'local');
}

function paintAudioMode() {
  const pill = $('#audio-mode-pill');
  const label = $('#audio-mode-label');
  if (!pill || !label) return;
  const isFile = state.source === 'local' && fileAudio.ready;
  const isLive = state.source === 'spotify' && live.ok;
  const liveLike = isFile || isLive;
  pill.classList.toggle('live', liveLike);
  pill.classList.toggle('beat', !liveLike);
  if (isFile) {
    label.textContent = 'Local FFT';
    pill.title = 'Direct AnalyserNode on the audio file — particles follow the real waveform';
  } else if (isLive) {
    label.textContent = 'Live audio';
    pill.title = 'Real FFT from this tab — particles follow the music across the spectrum';
  } else {
    label.textContent = 'Beat grid';
    pill.title = 'BPM beat fallback — switch to Local file, or enable Live audio and share this tab';
  }
}

function setMeterMode() {
  const el = $('#meter-mode');
  if (el) {
    if (state.source === 'local' && fileAudio.ready) el.textContent = 'spectrum';
    else el.textContent = live.ok ? 'spectrum' : 'beat';
  }
  paintAudioMode();
}

function paintSourceMode() {
  const spotify = state.source === 'spotify';
  $('#mode-spotify')?.classList.toggle('on', spotify);
  $('#mode-local')?.classList.toggle('on', !spotify);
  $('#mode-spotify')?.setAttribute('aria-selected', String(spotify));
  $('#mode-local')?.setAttribute('aria-selected', String(!spotify));
  $('#spotify-lists')?.classList.toggle('hidden', !spotify);
  $('#local-lists')?.classList.toggle('hidden', spotify);
  $('#btn-shuffle')?.classList.toggle('hidden', !spotify);
  $('#btn-repeat')?.classList.toggle('hidden', !spotify);
  paintLiveToggle();
  setMeterMode();
  const hint = $('#device-hint');
  if (hint) {
    hint.textContent = spotify
      ? 'Press play, share this tab, and tick “Share tab audio” so the particles hear Spotify — or switch to Local file for a direct FFT.'
      : 'Add MP3/WAV/etc. and press play. Particles read the file directly — no tab capture needed.';
  }
}

async function setSource(mode) {
  if (mode === state.source) return;
  if (mode === 'local') {
    // Stop Spotify so two things aren't playing at once.
    if (state.player && !state.paused) {
      try { await state.player.pause(); } catch {}
    }
    if (live.ok) live.stop();
    state.source = 'local';
    paintSourceMode();
    if (fileAudio.current) {
      fileAudio._emitTrack();
    } else {
      state.track = null;
      state.paused = true;
      state.progressMs = 0;
      state.durationMs = 0;
      renderTrack();
      renderProgress();
      renderPlayState();
      $('#track-artist').textContent = 'Add an audio file to start';
      setStatus('local');
    }
    paintLocalList();
    return;
  }

  fileAudio.pause();
  state.source = 'spotify';
  paintSourceMode();
  setStatus(state.deviceId ? 'ready' : 'connecting', false);
  refreshState();
  refreshQueue();
}

// 8-band EQ multipliers (in dB converted to gain: 10^(dB/20)).
const eqGains = new Float32Array(8).fill(1.0);

function bindEQ() {
  const bands = ['sub', 'bass', 'lmid', 'mid', 'hmid', 'pres', 'treb', 'air'];
  bands.forEach((b, idx) => {
    const input = $(`#s-eq-${b}`);
    const valDisplay = $(`#v-eq-${b}`);
    if (!input) return;
    input.addEventListener('input', () => {
      const db = Number(input.value);
      valDisplay.textContent = db > 0 ? `+${db}` : `${db}`;
      eqGains[idx] = Math.pow(10, db / 20);
    });
  });

  $('#btn-eq-reset')?.addEventListener('click', () => {
    bands.forEach((b, idx) => {
      const input = $(`#s-eq-${b}`);
      const valDisplay = $(`#v-eq-${b}`);
      if (input) input.value = '0';
      if (valDisplay) valDisplay.textContent = '0';
      eqGains[idx] = 1.0;
    });
  });
}
bindEQ();

function applyEQToBands(raw) {
  if (!raw) return raw;
  // Apply 8-band EQ weighting to bass, mid, treble, and 12-zone spectrum
  const subG = eqGains[0], bassG = eqGains[1], lmidG = eqGains[2], midG = eqGains[3];
  const hmidG = eqGains[4], presG = eqGains[5], trebG = eqGains[6], airG = eqGains[7];

  raw.bass = Math.min(1, raw.bass * ((subG + bassG) / 2));
  raw.mid = Math.min(1, raw.mid * ((lmidG + midG + hmidG) / 3));
  raw.treble = Math.min(1, raw.treble * ((presG + trebG + airG) / 3));

  if (raw.spectrum) {
    const spec = raw.spectrum;
    const len = spec.length;
    for (let i = 0; i < len; i++) {
      const p = i / len;
      let g = 1.0;
      if (p < 0.125) g = subG;
      else if (p < 0.25) g = bassG;
      else if (p < 0.375) g = lmidG;
      else if (p < 0.50) g = midG;
      else if (p < 0.625) g = hmidG;
      else if (p < 0.75) g = presG;
      else if (p < 0.875) g = trebG;
      else g = airG;
      spec[i] = Math.min(1, spec[i] * g);
    }
  }
  return raw;
}

viz.onAudioTick = (dt, t) => {
  // Local files win: direct MediaElement FFT, no capture prompt.
  if (state.source === 'local') {
    const fileBands = fileAudio.tick();
    if (fileBands) {
      applyEQToBands(fileBands);
      bands.bass = fileBands.bass;
      bands.mid = fileBands.mid;
      bands.treble = fileBands.treble;
      bands.kick = fileBands.kick;
      bands.onset = fileBands.onset;
      bands.spectrum = fileAudio.spectrum;
      return bands;
    }
  } else {
    const real = live.tick();
    if (real) {
      applyEQToBands(real);
      bands.bass = real.bass;
      bands.mid = real.mid;
      bands.treble = real.treble;
      bands.kick = real.kick;
      bands.onset = real.onset;
      bands.spectrum = live.spectrum;
      return bands;
    }
  }
  const out = rhythm.tick(dt, performance.now());
  applyEQToBands(out);
  bands.bass = out.bass;
  bands.mid = out.mid;
  bands.treble = out.treble;
  bands.kick = out.kick;
  bands.onset = out.onset;
  bands.spectrum = null;
  return bands;
};

let liveStart = null;
async function ensureLiveAudio() {
  if (state.source !== 'spotify') return false;
  if (!wantLiveAudio) return false;
  if (live.ok) return true;
  if (liveStart) return liveStart;
  liveStart = startLiveAudio().finally(() => { liveStart = null; });
  return liveStart;
}

function paintLocalList() {
  const ul = $('#local-list');
  if (!ul) return;
  ul.innerHTML = '';
  const items = fileAudio.playlist;
  $('#local-count').textContent = items.length ? `${items.length}` : '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No files yet — click Add audio files';
    ul.appendChild(li);
    return;
  }
  items.forEach((it, i) => {
    const li = document.createElement('li');
    if (i === fileAudio.index) li.classList.add('active');
    li.innerHTML = `<div class="q-txt"><b>${escapeHtml(it.name)}</b><span>${escapeHtml(it.fileName)}</span></div>`;
    li.onclick = () => fileAudio.playIndex(i);
    ul.appendChild(li);
  });
}

async function startLiveAudio() {
  try {
    await live.start();
    paintLiveToggle();
    setMeterMode();
    const hint = $('#device-hint');
    if (hint) hint.textContent = 'Listening to this tab — particles follow the real audio.';
    return true;
  } catch (e) {
    paintLiveToggle();
    setMeterMode();
    const hint = $('#device-hint');
    if (e.code === 'no-audio') {
      toast('Tick “Share tab audio” in the browser prompt');
      if (hint) hint.textContent = 'Share this tab and enable “Share tab audio” — that is how the visualizer hears the song.';
    } else if (e.code === 'denied') {
      if (hint) hint.textContent = 'Audio share cancelled. Particles fall back to a beat grid until you allow it.';
    } else if (e.code === 'unsupported') {
      toast('This browser cannot share tab audio');
    }
    return false;
  }
}

function trackIdOf(track) {
  return track?.id || (track?.uri || '').split(':').pop() || '';
}

async function lockBpm(track) {
  if (!track) return;
  const id = trackIdOf(track);
  if (!id) return;
  if (bpmCache.has(id)) {
    rhythm.setBpm(bpmCache.get(id));
    return;
  }
  // setTrack already applied a known tempo — don't round-trip Deezer for those.
  if (rhythm.trackId === id && rhythm.bpm !== 120) {
    bpmCache.set(id, rhythm.bpm);
    return;
  }
  if (bpmInFlight === id) return;
  bpmInFlight = id;

  let isrc = track.external_ids?.isrc || '';
  let artist = track.artists?.[0]?.name || '';
  let title = track.name || '';
  let duration = track.duration_ms || 0;

  // SDK track objects have no ISRC. The Web API track does — that's the
  // reliable key for "this exact recording" on Deezer.
  try {
    if (!isrc && id.length >= 22) {
      const r = await api(`tracks/${id}`);
      if (r.ok) {
        const full = await r.json();
        isrc = full.external_ids?.isrc || '';
        artist = artist || full.artists?.[0]?.name || '';
        title = title || full.name || '';
        duration = duration || full.duration_ms || 0;
      }
    }
    if (rhythm.trackId !== id) return;
    if (!artist || !title) return;

    const q = new URLSearchParams({ title, artist, duration: String(duration), isrc });
    const r = await fetch(`/api/bpm?${q}`);
    if (!r.ok || rhythm.trackId !== id) return;
    const j = await r.json();
    if (j?.bpm > 50 && j.bpm < 220 && rhythm.trackId === id) {
      bpmCache.set(id, j.bpm);
      rhythm.setBpm(j.bpm);
    }
  } catch (e) {
    console.warn('[bpm]', e);
  } finally {
    if (bpmInFlight === id) bpmInFlight = '';
  }
}

/* ───────────────────────── UI helpers ───────────────────────── */

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

const fmt = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function setStatus(text, live = false) {
  const pill = $('#status-pill');
  pill.querySelector('span').textContent = text;
  pill.classList.toggle('live', live);
}

function renderTrack() {
  const t = state.track;
  $('#track-name').textContent = t?.name || '—';
  const fallback = state.source === 'local' ? 'Add an audio file to start' : 'Sign in to start';
  $('#track-artist').textContent = t?.artists?.map((a) => a.name).join(', ') || fallback;
  $('#track-album').textContent = t?.album?.name || '';
  $('#time-dur').textContent = fmt(state.durationMs);
}

function renderProgress() {
  const pct = state.durationMs ? (state.progressMs / state.durationMs) * 100 : 0;
  $('#progress-fill').style.width = `${Math.min(100, pct)}%`;
  $('#progress-knob').style.left = `${Math.min(100, pct)}%`;
  $('#time-cur').textContent = fmt(state.progressMs);
}

function renderPlayState() {
  $('#ic-play').classList.toggle('hidden', !state.paused);
  $('#ic-pause').classList.toggle('hidden', state.paused);
  $('#btn-play').title = state.paused ? 'Play' : 'Pause';
}

function renderQueue() {
  const ul = $('#queue-list');
  ul.innerHTML = '';

  // Spotify's queue can legitimately contain the same track many times when
  // repeat is on. Collapse consecutive duplicates so the list is readable,
  // and show a count badge instead of ten identical rows.
  const raw = state.queue || [];
  const items = [];
  const counts = new Map();
  for (const it of raw) {
    const last = items[items.length - 1];
    if (last && last.uri === it.uri) {
      counts.set(it.uri, (counts.get(it.uri) || 1) + 1);
    } else {
      items.push(it);
    }
  }

  $('#queue-count').textContent = raw.length ? `${raw.length}` : '';

  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = state.token
      ? 'Queue is empty — pick a playlist below'
      : 'Sign in to see your queue';
    ul.appendChild(li);
    return;
  }

  for (const it of items.slice(0, 12)) {
    const li = document.createElement('li');
    const img = it.album?.images?.[2]?.url || it.album?.images?.[0]?.url || '';
    const artists = (it.artists || []).map((a) => a.name).join(', ');
    const repeat = counts.get(it.uri);
    li.innerHTML = `${img ? `<img src="${img}" alt="">` : ''}
      <div class="q-txt"><b>${escapeHtml(it.name)}</b><span>${escapeHtml(artists)}</span></div>
      ${repeat ? `<em class="q-rep">×${repeat}</em>` : ''}`;
    li.onclick = () => playFromContext(it);
    ul.appendChild(li);
  }
}

function renderPlaylists() {
  const ul = $('#playlist-list');
  if (!ul) return;
  ul.innerHTML = '';
  const items = state.playlists || [];
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = state.token ? 'No playlists found' : '';
    if (state.token) ul.appendChild(li);
    return;
  }
  for (const p of items.slice(0, 8)) {
    const li = document.createElement('li');
    const img = p.images?.[2]?.url || p.images?.[p.images.length - 1]?.url || p.images?.[0]?.url || '';
    const n = p.tracks?.total;
    li.innerHTML = `${img ? `<img src="${img}" alt="">` : ''}
      <div class="q-txt"><b>${escapeHtml(p.name)}</b><span>${n != null ? `${n} tracks` : ''}</span></div>`;
    li.onclick = () => startPlayback({ context_uri: p.uri });
    ul.appendChild(li);
  }
}

function escapeHtml(s = '') {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ───────────────────────── Spotify API ───────────────────────── */

function contextUriOf(track) {
  return state.context?.uri || track?.album?.uri || null;
}

/** Play a context (album/playlist) or a list of uris — never both. */
async function startPlayback(body) {
  if (!state.deviceId) return toast('Player is not ready yet');
  ensureLiveAudio();
  const r = await api(`me/player/play?device_id=${state.deviceId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    console.warn('[play]', r.status, err);
    toast('Could not start playback');
    return false;
  }
  rhythm.setPlaying(true);
  scheduleQueueRefresh(600);
  return true;
}

// Clicking a queued track with `{ uris: [one] }` wipes the rest of the queue.
// Jump inside the current album/playlist instead.
function playFromContext(track) {
  if (!track?.uri) return;
  const ctx = contextUriOf(track);
  if (ctx) {
    return startPlayback({ context_uri: ctx, offset: { uri: track.uri } });
  }
  return startPlayback({ uris: [track.uri] });
}

function applyTrack(track, { progressMs, paused, context, shuffle, repeat } = {}) {
  if (!track) return;
  state.track = track;
  state.durationMs = track.duration_ms || state.durationMs;
  if (progressMs != null) state.progressMs = progressMs;
  if (paused != null) state.paused = paused;
  if (context !== undefined) state.context = context;
  if (shuffle != null) state.shuffle = shuffle;
  if (repeat != null) state.repeat = repeat;
  rhythm.setTrack(state.track);
  lockBpm(state.track);
  if (paused != null) rhythm.setPlaying(!paused);
  if (progressMs != null) rhythm.setProgress(progressMs);
  renderTrack();
  renderProgress();
  renderPlayState();
  if (shuffle != null) $('#btn-shuffle').classList.toggle('active', state.shuffle);
  if (repeat != null) $('#btn-repeat').classList.toggle('active', state.repeat !== 'off');
}

async function fillQueueFromAlbum() {
  const album = state.track?.album;
  const albumId = album?.id || (album?.uri || '').split(':').pop();
  if (!albumId) return false;
  try {
    const r = await api(`albums/${albumId}/tracks?limit=50`);
    if (!r.ok) return false;
    const j = await r.json();
    const items = j.items || [];
    const idx = items.findIndex((t) => t.uri === state.track.uri);
    const rest = (idx >= 0 ? items.slice(idx + 1) : items).map((t) => ({
      ...t,
      album,
    }));
    state.queue = rest;
    return true;
  } catch (e) {
    console.warn('[queue] album fallback', e);
    return false;
  }
}

let queueRefreshTimer;
function scheduleQueueRefresh(ms = 400) {
  clearTimeout(queueRefreshTimer);
  queueRefreshTimer = setTimeout(() => refreshQueue(), ms);
}

async function refreshQueue() {
  try {
    const r = await api('me/player/queue');
    if (!r.ok) {
      console.warn('[queue] HTTP', r.status);
      if (!state.queue.length) await fillQueueFromAlbum();
      renderQueue();
      return;
    }
    const j = await r.json();
    const q = j.queue || [];
    const unique = new Set(q.map((t) => t.uri));
    // A single-track context (or repeat-track) looks like a queue of one song.
    // Prefer the rest of the album so Up next is actually useful.
    const isolated =
      !state.context?.uri && (q.length === 0 || (unique.size <= 1 && unique.has(state.track?.uri)));
    if (q.length && !isolated) state.queue = q;
    else if (!(await fillQueueFromAlbum()) && q.length) state.queue = q;
    renderQueue();
  } catch (e) {
    console.error('[queue] failed', e);
  }
}

async function loadPlaylists() {
  try {
    const r = await api('me/playlists?limit=12');
    if (!r.ok) return;
    const j = await r.json();
    state.playlists = j.items || [];
    renderPlaylists();
  } catch (e) {
    console.warn('[playlists]', e);
  }
}

async function hydrateFromRecent() {
  try {
    const r = await api('me/player/recently-played?limit=1');
    if (!r.ok) return;
    const j = await r.json();
    const item = j.items?.[0];
    if (!item?.track) return;
    applyTrack(item.track, {
      progressMs: 0,
      paused: true,
      context: item.context || null,
    });
    await fillQueueFromAlbum();
    renderQueue();
  } catch (e) {
    console.warn('[recent]', e);
  }
}

async function refreshState() {
  try {
    const r = await api('me/player');
    if (r.status === 204) {
      if (!state.track) await hydrateFromRecent();
      return;
    }
    if (!r.ok) return;
    const j = await r.json();
    if (j?.item) {
      applyTrack(j.item, {
        progressMs: j.progress_ms,
        paused: !j.is_playing,
        context: j.context || null,
        shuffle: j.shuffle_state,
        repeat: j.repeat_state,
      });
    }
  } catch (e) {
    console.warn('[state] refresh failed', e);
  }
}

/* ───────────────────────── SDK ───────────────────────── */

function initSDK(token) {
  if (!window.Spotify) {
    window.onSpotifyWebPlaybackSDKReady = () => initSDK(token);
    return;
  }

  const player = new window.Spotify.Player({
    name: 'Vinyl GL · Web Player',
    getOAuthToken: async (cb) => {
      try {
        const r = await fetch('/auth/token');
        if (r.ok) {
          const j = await r.json();
          state.token = j.access_token;
          cb(j.access_token);
        } else {
          setStatus('signed out');
          toast('Session expired — sign in again');
        }
      } catch (e) {
        console.error('[sdk token]', e);
        toast('Could not reach the server for a token');
      }
    },
    volume: state.volume,
  });

  player.addListener('ready', ({ device_id }) => {
    state.deviceId = device_id;
    setStatus('ready', true);
    console.log('[sdk] device ready', device_id);
    api('me/player', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [device_id], play: false }),
    }).catch(() => {});
    refreshState().then(() => refreshQueue());
  });

  player.addListener('not_ready', () => setStatus('offline'));

  player.addListener('player_state_changed', (s) => {
    if (!s || state.source !== 'spotify') return;
    const t = s.track_window.current_track;
    const prevUri = state.track?.uri;
    applyTrack(
      {
        name: t.name,
        artists: t.artists,
        album: t.album,
        duration_ms: s.duration,
        uri: t.uri,
        id: t.id,
      },
      {
        progressMs: s.position,
        paused: s.paused,
        context: s.context || null,
      }
    );
    state.lastTick = performance.now();
    setStatus(s.paused ? 'paused' : 'playing', !s.paused);

    const next = s.track_window?.next_tracks || [];
    if (next.length && !state.queue.length) {
      state.queue = next;
      renderQueue();
    }
    if (t.uri !== prevUri) scheduleQueueRefresh(500);
  });

  player.addListener('autoplay_failed', () =>
    toast('Press play once — the browser blocked autoplay')
  );

  player.addListener('initialization_error', ({ message }) => console.error('[sdk init]', message));
  player.addListener('authentication_error', ({ message }) => {
    console.error('[sdk auth]', message);
    toast('Spotify auth failed — sign in again');
  });
  player.addListener('account_error', () =>
    toast('Spotify Premium is required for in-browser playback')
  );

  player.connect().then((ok) => {
    if (!ok) toast('Could not connect to Spotify');
  }).catch((e) => {
    console.error('[sdk connect]', e);
    setStatus('offline');
    toast('Could not connect to Spotify');
  });

  state.player = player;
}

/* ───────────────────────── controls ───────────────────────── */

$('#mode-spotify')?.addEventListener('click', () => setSource('spotify'));
$('#mode-local')?.addEventListener('click', () => setSource('local'));

$('#btn-add-files')?.addEventListener('click', () => $('#file-input')?.click());
$('#file-input')?.addEventListener('change', async (e) => {
  const input = e.target;
  const n = fileAudio.addFiles(input.files || []);
  input.value = '';
  if (!n) return toast('No supported audio files in that selection');
  paintLocalList();
  if (state.source !== 'local') await setSource('local');
  if (fileAudio.index < 0) await fileAudio.playIndex(0);
  toast(`Added ${n} file${n === 1 ? '' : 's'}`);
});
$('#btn-clear-files')?.addEventListener('click', () => {
  fileAudio.clear();
  paintLocalList();
  if (state.source === 'local') {
    state.track = null;
    state.paused = true;
    state.progressMs = 0;
    state.durationMs = 0;
    renderTrack();
    renderProgress();
    renderPlayState();
    $('#track-artist').textContent = 'Add an audio file to start';
    setStatus('local');
  }
});

$('#btn-play').onclick = async () => {
  if (state.source === 'local') {
    if (!fileAudio.playlist.length) {
      $('#file-input')?.click();
      return toast('Add an audio file first');
    }
    await fileAudio.toggle();
    return;
  }
  if (!state.player) return toast('Sign in first');
  ensureLiveAudio();
  // Isolated `{ uris: [one] }` playback has no next track. If Spotify gave us
  // no album/playlist context, resume inside the album so Up next fills.
  if (state.paused && !state.context?.uri) {
    const albumUri = state.track?.album?.uri;
    if (albumUri && state.track?.uri) {
      const ok = await startPlayback({
        context_uri: albumUri,
        offset: { uri: state.track.uri },
        position_ms: Math.floor(state.progressMs) || 0,
      });
      if (ok) return;
    }
    if (!state.track && state.playlists[0]) {
      const ok = await startPlayback({ context_uri: state.playlists[0].uri });
      if (ok) return;
    }
  }
  state.player.togglePlay();
};

$('#btn-next').onclick = () => {
  if (state.source === 'local') {
    fileAudio.next();
    return;
  }
  state.player?.nextTrack();
  scheduleQueueRefresh(700);
};
$('#btn-prev').onclick = () => {
  if (state.source === 'local') {
    fileAudio.prev();
    return;
  }
  state.player?.previousTrack();
  scheduleQueueRefresh(700);
};

$('#btn-shuffle').onclick = async () => {
  if (state.source !== 'spotify') return;
  state.shuffle = !state.shuffle;
  $('#btn-shuffle').classList.toggle('active', state.shuffle);
  await api(`me/player/shuffle?state=${state.shuffle}`, { method: 'PUT' });
  refreshQueue();
};

$('#btn-repeat').onclick = async () => {
  if (state.source !== 'spotify') return;
  const order = ['off', 'context', 'track'];
  state.repeat = order[(order.indexOf(state.repeat) + 1) % 3];
  $('#btn-repeat').classList.toggle('active', state.repeat !== 'off');
  toast(`Repeat: ${state.repeat}`);
  await api(`me/player/repeat?state=${state.repeat}`, { method: 'PUT' });
};

const volEl = $('#volume');
function paintRange(el) {
  const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--pct', `${pct}%`);
}
volEl.addEventListener('input', () => {
  state.volume = volEl.value / 100;
  $('#vol-label').textContent = volEl.value;
  paintRange(volEl);
  fileAudio.setVolume(state.volume);
  state.player?.setVolume(state.volume);
});
paintRange(volEl);

// seek
const prog = $('#progress');
let seeking = false;
function seekFromEvent(e) {
  const rect = prog.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  state.progressMs = pct * state.durationMs;
  renderProgress();
  return pct;
}
prog.addEventListener('pointerdown', (e) => {
  seeking = true;
  prog.setPointerCapture(e.pointerId);
  seekFromEvent(e);
});
prog.addEventListener('pointermove', (e) => seeking && seekFromEvent(e));
prog.addEventListener('pointerup', (e) => {
  if (!seeking) return;
  seeking = false;
  const pct = seekFromEvent(e);
  const ms = Math.floor(pct * state.durationMs);
  if (state.source === 'local') {
    fileAudio.seek(ms);
  } else {
    state.player?.seek(ms);
    rhythm.setProgress(ms);
  }
  state.lastTick = performance.now();
});

/* ───────────────────────── panel ───────────────────────── */

$('#btn-settings').onclick = () => $('#panel').classList.toggle('hidden');
$('#btn-close-panel').onclick = () => $('#panel').classList.add('hidden');

function bindSlider(id, labelId, fn, fmtFn = (v) => v) {
  const el = $(id);
  const out = $(labelId);
  const apply = () => {
    out.textContent = fmtFn(el.value);
    paintRange(el);
    fn(Number(el.value));
  };
  el.addEventListener('input', apply);
  apply();
}

bindSlider('#s-count', '#v-count', (v) => {
  if (v === viz.particles.count) return;
  viz.setCount(v);
}, (v) => `${Math.round(v / 1000)}k`);

bindSlider('#s-size', '#v-size', (v) => viz.setRender('uSize', v), (v) => Number(v).toFixed(1));
bindSlider('#s-flow', '#v-flow', (v) => viz.setParam('uFlow', v), (v) => Number(v).toFixed(1));
bindSlider('#s-bass', '#v-bass', (v) => viz.setRender('uBassSens', v), (v) => Number(v).toFixed(1));
bindSlider('#s-bloom', '#v-bloom', (v) => viz.setRender('uBloom', v), (v) => Number(v).toFixed(1));

// Shared with canvas#meter and Graphic EQ particles — keep them locked together.
let eqThreshold = 0.28;
function gateSpectrum(v, thr = eqThreshold) {
  const t = Math.min(0.95, Math.max(0, thr));
  if (v <= t) return 0;
  // Map (threshold → 1) into (0 → ~0.9) so hot lows don't always pin the top.
  return Math.min(0.9, ((v - t) / Math.max(0.2, 1 - t)) * 0.85);
}
bindSlider('#s-threshold', '#v-threshold', (v) => {
  eqThreshold = v;
  viz.setParam('uThreshold', v);
  viz.setRender('uThreshold', v);
}, (v) => Number(v).toFixed(2));

const EFFECT_HINTS = [
  'Balanced fluid motion. Every live frequency zone changes a different particle group.',
  'Bass and kicks tighten the orbit; harmonics control altitude and color texture.',
  'Mids shape vertical aurora curtains; bass anchors the cloud and highs add shimmer.',
  'Treble and high-spectrum zones throw fast blue-white sparks; bass preserves the body.',
  'Graphic equalizer locked to the same FFT as the meter. Raise EQ threshold if bars stay maxed out.',
  'Particles stream out of a tunnel. Bass sets the speed, highs spin the outer rings.',
];
const effectSelect = $('#s-effect');
function applyEffect() {
  const effect = Number(effectSelect?.value || 0);
  viz.setEffect(effect);
  const hint = $('#effect-hint');
  if (hint) hint.textContent = EFFECT_HINTS[effect] || EFFECT_HINTS[0];
}
effectSelect?.addEventListener('change', applyEffect);
applyEffect();

const presetSelect = $('#s-preset');
const SAVED_KEY = 'viz-custom-preset';
function rememberPreset(preset) {
  if (!presetSelect || !preset?.id) return;
  let opt = presetSelect.querySelector(`option[value="${preset.id}"]`);
  if (!opt) {
    opt = document.createElement('option');
    opt.value = preset.id;
    presetSelect.appendChild(opt);
  }
  opt.textContent = preset.name;
  opt._preset = preset;
}
for (const preset of PRESETS) rememberPreset(preset);
try {
  const saved = JSON.parse(localStorage.getItem(SAVED_KEY) || 'null');
  if (saved?.id) rememberPreset(saved);
} catch {}

function syncToggle(id, on) {
  const btn = $(id);
  if (!btn) return;
  btn.classList.toggle('on', !!on);
  btn.setAttribute('aria-checked', String(!!on));
}

function applyPreset(preset) {
  if (!preset) return;
  viz.applyPreset(preset);
  if (effectSelect) effectSelect.value = String(preset.effect ?? 0);
  const hint = $('#effect-hint');
  if (hint) hint.textContent = preset.description || EFFECT_HINTS[preset.effect] || EFFECT_HINTS[0];
  syncToggle('#t-particles', preset.particles !== false);
  syncToggle('#t-vinyl', !!preset.vinyl);
  const bloom = $('#s-bloom');
  const bloomLabel = $('#v-bloom');
  if (bloom && preset.bloom != null) {
    bloom.value = String(preset.bloom);
    if (bloomLabel) bloomLabel.textContent = Number(preset.bloom).toFixed(2);
  }
}

presetSelect?.addEventListener('change', () => {
  const opt = presetSelect.selectedOptions[0];
  if (opt?._preset) applyPreset(opt._preset);
});

$('#s-quality')?.addEventListener('change', (e) => {
  viz.setQuality(e.target.value);
});

$('#btn-save-preset')?.addEventListener('click', () => {
  const snap = viz.capturePreset();
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(snap)); } catch {}
  rememberPreset(snap);
  if (presetSelect) presetSelect.value = snap.id;
  const toast = $('#toast');
  if (toast) {
    toast.textContent = 'Saved the current look on this browser';
    toast.classList.remove('hidden');
    clearTimeout(applyPreset._toast);
    applyPreset._toast = setTimeout(() => toast.classList.add('hidden'), 1800);
  }
});

function bindToggle(id, key) {
  const btn = $(id);
  btn.onclick = () => {
    const on = !btn.classList.contains('on');
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', String(on));
    viz.setToggle(key, on);
  };
}
bindToggle('#t-particles', 'particles');
bindToggle('#t-vinyl', 'vinyl');
bindToggle('#t-react', 'react');

$('#t-live')?.addEventListener('click', async () => {
  if (state.source === 'local') {
    toast('Local file mode already has a direct FFT — tab capture is not needed');
    return;
  }
  if (live.ok) {
    wantLiveAudio = false;
    live.stop();
    paintLiveToggle();
    setMeterMode();
    const hint = $('#device-hint');
    if (hint) hint.textContent = 'Live audio off — falling back to a beat grid.';
    return;
  }
  wantLiveAudio = true;
  await ensureLiveAudio();
});

/* spectrum meter */
const meter = $('#meter');
const mctx = meter.getContext('2d');
function drawMeter() {
  const w = meter.width, h = meter.height;
  mctx.clearRect(0, 0, w, h);
  const bars = 48;
  const bw = w / bars;
  const liveSpec = (state.source === 'local' && fileAudio.ready)
    ? fileAudio.spectrum
    : (live.ok ? live.spectrum : null);
  for (let i = 0; i < bars; i++) {
    const p = i / bars;
    let v = liveSpec
      ? liveSpec[i]
      : p < 0.3 ? Math.max(bands.kick, bands.bass) : p < 0.65 ? bands.mid : bands.treble;
    // EQ threshold gates this canvas the same way as the particle Graphic EQ.
    if (liveSpec) v = gateSpectrum(v, eqThreshold);
    const spread = liveSpec ? 1 : 0.82 + 0.18 * Math.sin(i * 0.9);
    const bh = Math.max(1, v * h * spread);
    const grad = mctx.createLinearGradient(0, h, 0, h - bh);
    grad.addColorStop(0, 'rgba(30,215,96,.85)');
    grad.addColorStop(1, 'rgba(140,120,255,.9)');
    mctx.fillStyle = grad;
    mctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
  }
  $('#fps').textContent = `${viz.fps} fps`;
  const info = $('#renderer-info');
  if (info && viz.stats) {
    const s = viz.stats;
    const count = s.particles >= 1000 ? `${Math.round(s.particles / 1000)}k` : String(s.particles);
    info.textContent = `${s.backend} · ${s.fps} fps · ${s.frameMs.toFixed(1)} ms · ${count} · ${s.preset}`;
  }
  const bpmEl = $('#bpm-label');
  if (bpmEl) {
    if (state.source === 'local' && fileAudio.ready) bpmEl.textContent = 'local';
    else if (live.ok) bpmEl.textContent = 'live';
    else bpmEl.textContent = rhythm.trackId ? `${Math.round(rhythm.bpm)} bpm` : '';
  }
  setMeterMode();
  requestAnimationFrame(drawMeter);
}
drawMeter();

paintSourceMode();
paintLocalList();

/* ───────────────────────── tick ───────────────────────── */

setInterval(() => {
  const now = performance.now();
  // Local file progress comes from the <audio> element via onTrack.
  if (state.source === 'spotify' && !state.paused && !seeking) {
    state.progressMs = Math.min(
      state.durationMs,
      state.progressMs + (now - state.lastTick)
    );
    renderProgress();
  }
  state.lastTick = now;
}, 100);

setInterval(() => {
  if (state.source === 'spotify' && state.token) refreshQueue();
}, 20000);

// Keep the beat grid on whatever Spotify says is playing — track skips and
// play/pause from another device never reach the SDK listener otherwise.
setInterval(() => {
  if (state.source === 'spotify' && state.token) refreshState();
}, 1000);

// First queue load once the SDK has a device — the API can 401/204 before that.
let queueBootTries = 0;
const queueBootTimer = setInterval(async () => {
  queueBootTries++;
  await refreshQueue();
  if (state.queue.length > 0 || queueBootTries > 12) clearInterval(queueBootTimer);
}, 2500);

/* ───────────────────────── boot ───────────────────────── */

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('error')) toast(`Sign-in failed: ${params.get('error')}`);

  try {
    const r = await fetch('/auth/status');
    if (!r.ok) throw new Error(`status HTTP ${r.status}`);
    const j = await r.json();

    if (!j.authenticated) {
      $('#btn-login').classList.remove('hidden');
      $('#btn-login').onclick = () => (location.href = '/auth/login');
      setStatus('signed out');
      renderQueue();
      return;
    }

    $('#btn-login').classList.add('hidden');
    setStatus('connecting');

    const t = await fetch('/auth/token');
    if (!t.ok) {
      setStatus('signed out');
      $('#btn-login').classList.remove('hidden');
      $('#btn-login').onclick = () => (location.href = '/auth/login');
      return;
    }
    const tj = await t.json();
    state.token = tj.access_token;

    if (j.profile?.product && j.profile.product !== 'premium') {
      toast('This account is not Premium — in-browser playback will fail');
    }

    initSDK(state.token);
    await refreshState();
    await refreshQueue();
    loadPlaylists();
  } catch (e) {
    // Never leave the UI parked on "connecting" with no explanation.
    console.error('[boot] failed', e);
    setStatus('offline');
    toast('Could not reach the server — check the service and reload');
    return;
  }

  // keep the access token fresh for the SDK
  setInterval(async () => {
    try {
      const rr = await fetch('/auth/token');
      if (rr.ok) state.token = (await rr.json()).access_token;
    } catch (e) {
      console.warn('[token] refresh failed', e);
    }
  }, 20 * 60 * 1000);
}

boot();

// expose for debugging in devtools
window.__viz = viz;
window.__state = state;
window.__rhythm = rhythm;
window.__live = live;
window.__file = fileAudio;
window.__refreshQueue = refreshQueue;
