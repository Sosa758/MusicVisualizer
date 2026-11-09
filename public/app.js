/**
 * app.js — Spotify Web Playback SDK + local files.
 * The WebGL canvas is an empty scene. Playback does not drive it.
 */
const V = new URL(import.meta.url).search;
const { Visualizer } = await import(`./visualizer.js${V}`);
const { FileAudio, LiveAudio, AudioMotion } = await import(`./audio.js${V}`);

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
$('#renderer-info').textContent = viz.backend;

const live = new LiveAudio();
live.onStop = () => paintLiveToggle();
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

const motion = new AudioMotion();
viz.onAudioTick = (dt) => {
  const spec = state.source === 'local' ? fileAudio.tick() : live.tick();
  return motion.sample(spec, dt);
};

function paintLiveToggle() {
  const on = state.source === 'spotify' && live.ok;
  const btn = $('#t-live');
  if (btn) {
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', String(on));
  }
  const share = $('#btn-share-audio');
  if (share) {
    share.textContent = on ? 'Tab audio on' : 'Share tab audio';
    share.classList.toggle('on', on);
    share.hidden = state.source !== 'spotify';
  }
}

let shareInFlight = null;
function shareTabAudio() {
  if (state.source !== 'spotify') return Promise.resolve(false);
  if (live.ok) {
    if (live.probe?.ctx?.state === 'suspended') live.probe.ctx.resume();
    paintLiveToggle();
    return Promise.resolve(true);
  }
  if (shareInFlight) return shareInFlight;
  shareInFlight = live.start().then(() => {
    const hint = $('#device-hint');
    if (hint) hint.textContent = 'Listening to this tab. The 31 bands follow the Spotify mix.';
    paintLiveToggle();
    return true;
  }).catch((e) => {
    paintLiveToggle();
    if (e.code === 'no-audio') toast('In the share dialog, choose this tab and tick “Share tab audio”');
    else if (e.code === 'unsupported') toast('This browser cannot share tab audio');
    else toast('Choose this tab and tick “Share tab audio”');
    return false;
  }).finally(() => { shareInFlight = null; });
  return shareInFlight;
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
  const liveBtn = $('#t-live');
  liveBtn?.closest('.toggle-row')?.classList.toggle('dimmed', !spotify);
  paintLiveToggle();
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
  shareTabAudio();
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
  shareTabAudio();
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
  }
  state.lastTick = performance.now();
});

setInterval(() => {
  const info = $('#renderer-info');
  if (info) info.textContent = `${viz.backend} · ${viz.fps} fps · ${viz.stats.frameMs.toFixed(1)} ms · ${Math.round(viz.stats.particles / 1000)}k`;
  const fps = $('#fps');
  if (fps) fps.textContent = `${viz.fps} fps`;
}, 500);

$('#btn-settings').onclick = () => $('#panel').classList.toggle('hidden');
$('#btn-close-panel').onclick = () => $('#panel').classList.add('hidden');

function bindSlider(id, labelId, fn, fmt) {
  const el = $(id);
  const out = $(labelId);
  if (!el) return;
  const apply = () => {
    const n = Number(el.value);
    if (out) out.textContent = fmt(n);
    paintRange(el);
    fn(n);
  };
  el.addEventListener('input', apply);
  apply();
}

bindSlider('#s-count', '#v-count', (v) => {
  if (v !== viz.particles.count) viz.setCount(v);
}, (v) => `${Math.round(v / 1000)}k`);
bindSlider('#s-size', '#v-size', (v) => viz.set('uSize', v), (v) => v.toFixed(1));
bindSlider('#s-speed', '#v-speed', (v) => viz.set('uSpeed', v), (v) => v.toFixed(1));
bindSlider('#s-sens', '#v-sens', (v) => viz.set('uSens', v), (v) => v.toFixed(1));
bindSlider('#s-bloom', '#v-bloom', (v) => viz.set('uBloom', v), (v) => v.toFixed(2));
bindSlider('#s-threshold', '#v-threshold', (v) => viz.set('uThreshold', v), (v) => v.toFixed(2));
bindSlider('#s-gravity', '#v-gravity', (v) => viz.set('uGravity', v), (v) => v.toFixed(2));
bindSlider('#s-life', '#v-life', (v) => viz.set('uLife', 1 / Math.max(0.4, v)), (v) => `${v.toFixed(1)}s`);
bindSlider('#s-flow', '#v-flow', (v) => viz.set('uFlow', v), (v) => v.toFixed(1));
bindSlider('#s-hue', '#v-hue', (v) => viz.set('uHue', v), (v) => `${Math.round(v * 360)}°`);
$('#s-style')?.addEventListener('change', (event) => viz.set('uStyle', Number(event.target.value)));

const panX = $('#s-pan-x');
const panY = $('#s-pan-y');
const applyPan = () => {
  const x = Number(panX?.value || 0);
  const y = Number(panY?.value || 0);
  if ($('#v-pan-x')) $('#v-pan-x').textContent = x.toFixed(1);
  if ($('#v-pan-y')) $('#v-pan-y').textContent = y.toFixed(1);
  if (panX) paintRange(panX);
  if (panY) paintRange(panY);
  viz.pan(x, y);
};
panX?.addEventListener('input', applyPan);
panY?.addEventListener('input', applyPan);
$('#btn-reset-view')?.addEventListener('click', () => viz.resetView());
viz.onViewChange = () => {
  if (!panX || !panY) return;
  panX.value = String(viz._panWanted.x);
  panY.value = String(viz._panWanted.y);
  applyPan();
};


function bindToggle(id, key) {
  const btn = $(id);
  if (!btn) return;
  btn.onclick = () => {
    const on = !btn.classList.contains('on');
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', String(on));
    viz.setToggle(key, on);
  };
}
bindToggle('#t-particles', 'particles');
bindToggle('#t-react', 'react');

$('#t-live')?.addEventListener('click', () => shareOrStop());
$('#btn-share-audio')?.addEventListener('click', () => shareOrStop());

async function shareOrStop() {
  if (state.source !== 'spotify') return;
  if (live.ok) {
    live.stop();
    const hint = $('#device-hint');
    if (hint) hint.textContent = 'Tab audio is off. Press Share tab audio, choose this tab, and tick “Share tab audio”.';
    paintLiveToggle();
    return;
  }
  await shareTabAudio();
}

const meter = $('#meter');
const mctx = meter?.getContext('2d');
function drawMeter() {
  if (!meter || !mctx) return;
  const w = meter.width;
  const h = meter.height;
  mctx.clearRect(0, 0, w, h);
  const spec = viz.particles.spectrum;
  const bars = 31;
  const bw = w / bars;
  for (let i = 0; i < bars; i++) {
    const v = spec ? spec[i * 4] || 0 : 0;
    const bh = Math.max(1, v * h);
    const t = i / 30;
    const hue = (1 - t) * 220;
    mctx.fillStyle = `hsla(${hue}, 85%, ${48 + v * 20}%, 0.9)`;
    mctx.fillRect(i * bw + 1, h - bh, Math.max(1, bw - 2), bh);
  }
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
window.__file = fileAudio;
window.__refreshQueue = refreshQueue;
