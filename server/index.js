import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3100);
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;
const FRONTEND_URL = process.env.FRONTEND_URL || `http://127.0.0.1:${PORT}`;

// Persisted session secret so restarts don't log the user out.
const SECRET_FILE = path.join(ROOT, '.session-secret');
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  try {
    SESSION_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, SESSION_SECRET, { mode: 0o600 });
  }
}

const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
].join(' ');

const AUTH_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';

const app = express();
app.use(cookieParser(SESSION_SECRET));
app.set('trust proxy', 1);

/* ------------------------------------------------------------------ */
/* Token store — single-user, in memory + on disk so restarts keep it  */
/* ------------------------------------------------------------------ */
const TOKEN_FILE = path.join(ROOT, '.tokens.json');
let tokens = null;
try {
  tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
} catch {
  tokens = null;
}
function saveTokens(t) {
  tokens = t;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
}

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function basicAuth() {
  return 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

// Single-flight: concurrent callers must share ONE refresh. Spotify rotates the
// refresh token on use, so parallel refreshes race and the losers persist a
// stale refresh_token — which logs the user out on the next expiry.
let refreshInFlight = null;

async function refreshAccessToken() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    if (!tokens?.refresh_token) return null;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID,
    });
    const r = await fetch(`${AUTH_BASE}/api/token`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!r.ok) {
      console.error('refresh failed', r.status, await r.text());
      return null;
    }
    const j = await r.json();
    saveTokens({
      access_token: j.access_token,
      refresh_token: j.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + (j.expires_in - 60) * 1000,
      scope: j.scope || tokens.scope,
    });
    return tokens.access_token;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function validAccessToken() {
  if (!tokens) return null;
  if (Date.now() < (tokens.expires_at || 0)) return tokens.access_token;
  return refreshAccessToken();
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
app.get('/healthz', (_req, res) => res.json({ ok: true, configured: Boolean(CLIENT_ID && CLIENT_SECRET) }));

// Tempo lookup — Spotify's audio-features API is 403 for this app. Deezer still
// publishes BPM, which is what actually locks the particle grid to a track.
const bpmCache = new Map();
const usableBpm = (n) => {
  const bpm = Number(n);
  return bpm > 40 && bpm < 220 ? bpm : null;
};

async function deezerJson(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  return r.json();
}

app.get('/api/bpm', async (req, res) => {
  const isrc = String(req.query.isrc || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  const title = String(req.query.title || '').slice(0, 120);
  const artist = String(req.query.artist || '').slice(0, 80);
  const duration = Number(req.query.duration) || 0;
  const key = isrc || `${artist.toLowerCase()}|${title.toLowerCase()}`;
  if (!key) return res.json({ bpm: null });
  if (bpmCache.has(key)) return res.json(bpmCache.get(key));
  try {
    let bpm = null;
    if (isrc) {
      const full = await deezerJson(`https://api.deezer.com/track/isrc:${isrc}`);
      bpm = usableBpm(full?.bpm);
    }
    if (bpm == null && title && artist) {
      const q = new URLSearchParams({ q: `${title} ${artist}`, limit: '8' });
      const j = await deezerJson(`https://api.deezer.com/search?${q}`);
      const durSec = duration > 20 ? duration / 1000 : 0;
      const artistLc = artist.toLowerCase();
      const scored = [];
      for (const t of j?.data || []) {
        const an = (t.artist?.name || '').toLowerCase();
        if (!an.includes(artistLc) && !artistLc.includes(an)) continue;
        const dt = durSec ? Math.abs((t.duration || 0) - durSec) : 0;
        scored.push({ id: t.id, dt });
      }
      scored.sort((a, b) => a.dt - b.dt);
      for (const t of scored.slice(0, 5)) {
        const full = await deezerJson(`https://api.deezer.com/track/${t.id}`);
        bpm = usableBpm(full?.bpm);
        if (bpm != null) break;
      }
    }
    const out = { bpm };
    if (bpm != null) bpmCache.set(key, out);
    res.json(out);
  } catch (e) {
    console.warn('[bpm]', e);
    res.json({ bpm: null });
  }
});

app.get('/auth/login', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).send('Spotify credentials missing. Fill in .env and restart.');
  }
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  res.cookie('sp_pkce', verifier, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https',
    maxAge: 10 * 60 * 1000,
    path: '/',
  });

  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: SCOPES,
    show_dialog: 'false',
  });
  res.redirect(`${AUTH_BASE}/authorize?${q}`);
});

app.get('/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) return res.redirect(`${FRONTEND_URL}/?error=${encodeURIComponent(error)}`);
  const verifier = req.cookies?.sp_pkce;
  if (!code || !verifier) return res.redirect(`${FRONTEND_URL}/?error=missing_code`);

  try {
    const r = await fetch(`${AUTH_BASE}/api/token`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }),
    });
    if (!r.ok) throw new Error(`token exchange ${r.status}: ${await r.text()}`);
    const j = await r.json();
    saveTokens({
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Date.now() + (j.expires_in - 60) * 1000,
      scope: j.scope,
    });
    res.clearCookie('sp_pkce', { path: '/' });
    res.redirect(`${FRONTEND_URL}/`);
  } catch (e) {
    console.error(e);
    res.redirect(`${FRONTEND_URL}/?error=token_exchange_failed`);
  }
});

// The browser asks here for a fresh access token before initialising the SDK.
app.get('/auth/token', async (_req, res) => {
  try {
    const t = await validAccessToken();
    if (!t) return res.status(401).json({ error: 'not_authenticated' });
    res.json({ access_token: t, expires_at: tokens.expires_at });
  } catch (e) {
    console.error('[auth/token]', e);
    res.status(502).json({ error: 'token_refresh_failed' });
  }
});

app.get('/auth/status', async (_req, res) => {
  if (!tokens) return res.json({ authenticated: false });
  let profile = null;
  try {
    const t = await validAccessToken();
    const r = await fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${t}` } });
    if (r.ok) {
      const p = await r.json();
      profile = { id: p.id, name: p.display_name, product: p.product, image: p.images?.[0]?.url || null };
    }
  } catch {}
  res.json({ authenticated: true, profile, scope: tokens.scope });
});

app.post('/auth/logout', (_req, res) => {
  tokens = null;
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
  res.json({ ok: true });
});

// Generic proxy: /api/spotify/<path> -> https://api.spotify.com/v1/<path>
app.all('/api/spotify/*', async (req, res) => {
  let t;
  try {
    t = await validAccessToken();
  } catch (e) {
    console.error('[proxy] token', e);
    return res.status(502).json({ error: 'token_refresh_failed' });
  }
  if (!t) return res.status(401).json({ error: 'not_authenticated' });

  const sub = req.params[0] || '';
  const url = new URL(`${API_BASE}/${sub}`);
  for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, String(v));

  const init = {
    method: req.method,
    headers: { Authorization: `Bearer ${t}` },
  };
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) {
      init.body = raw;
      init.headers['Content-Type'] = req.headers['content-type'] || 'application/json';
    }
  }

  try {
    const r = await fetch(url, init);
    const text = await r.text();
    res.status(r.status);
    if (text) res.type(r.headers.get('content-type') || 'application/json').send(text);
    else res.end();
  } catch (e) {
    res.status(502).json({ error: 'proxy_failed', detail: String(e) });
  }
});

/* ------------------------------------------------------------------ */
/* Static frontend                                                     */
/* ------------------------------------------------------------------ */
app.use(express.static(path.join(ROOT, 'public'), {
  extensions: ['html'],
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    // HTML must never be cached: it carries the asset version query string.
    // JS/CSS get a short TTL so a deploy lands within a minute.
    if (/\.html?$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (/\.(js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    }
  },
}));
app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

// Express 4 does not catch rejected promises from async handlers, so an
// unexpected throw would leave the request hanging. Fail loudly instead.
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'internal_error' });
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[spotify-player] listening on http://127.0.0.1:${PORT}`);
  console.log(`[spotify-player] redirect URI: ${REDIRECT_URI}`);
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('[spotify-player] WARNING: SPOTIFY_CLIENT_ID / SECRET not set in .env');
  }
});
