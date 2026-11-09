# AGENTS.md

Guidance for agents working in this repository.

## What this is

A Spotify web player with local-file playback and a 31-band GPU particle equalizer, served at
**https://spotify.sh10151.uk** through a Cloudflare Tunnel.

- **Backend:** Node 24 + Express 4, `server/index.js`, port **3100**, bound to `127.0.0.1`.
- **Frontend:** plain ES modules, **no bundler, no build step, no React**. Three.js loads
  from `esm.sh` at runtime.
- **State:** single user, single Spotify account. OAuth tokens persist in `.tokens.json`.

The WebGL canvas is a 31-band particle equalizer. Each particle belongs to one
third-octave band, which sets its column, color, and speed.

Do not introduce a bundler, a framework, or a build pipeline. The absence of a build step
is deliberate — it keeps deploys to "edit a file, restart the service".

## Layout

```
server/index.js      OAuth (PKCE), token refresh, Spotify API proxy, static serving
public/index.html    Markup + the asset version query (see "Deploying changes")
public/app.js        SDK init, UI wiring, queue, controls, boot()
public/audio.js      Local file playback
public/visualizer.js 31-band GPU particle equalizer
public/styles.css    Dark UI theme
```

## Running it

```bash
systemctl --user restart spotify-player     # apply changes
systemctl --user is-active spotify-player   # should print "active"
journalctl --user -u spotify-player -n 50 --no-pager
curl -s https://spotify.sh10151.uk/healthz  # {"ok":true,"configured":true}
```

`configured: false` means `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` are missing from
`.env` — the server reads `.env` **once at boot**, so a restart is required after editing it.

### Secrets

`.env` holds `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `REDIRECT_URI`, `FRONTEND_URL`,
`PORT`. **Never read, print, echo, or commit `.env` or `.tokens.json`.** Never put their
contents into a summary, log, or chat message. `.env.example` documents the shape.

## Deploying changes — read this before editing anything

Browsers cache aggressively. `index.html` carries the asset version, and `app.js` forwards
that query to its imports:

```js
const V = new URL(import.meta.url).search;
const { Visualizer } = await import(`./visualizer.js${V}`);
const { FileAudio } = await import(`./audio.js${V}`);
```

Bump `?v=` in `index.html` after a frontend change, then restart the service.

## Code map

### `server/index.js`

| Route | Purpose |
|---|---|
| `GET /healthz` | Liveness + whether credentials are configured |
| `GET /auth/login` | Redirect to Spotify with PKCE challenge |
| `GET /callback` | Exchange code, persist tokens, redirect to app |
| `GET /auth/token` | Current access token for the SDK |
| `GET /auth/status` | Auth state + profile |
| `POST /auth/logout` | Clear tokens |
| `ALL /api/spotify/*` | Authenticated proxy to `api.spotify.com/v1/*` |

Token refresh is guarded by `refreshInFlight` (single-flight). **Keep that guard.** Spotify
rotates refresh tokens; concurrent refreshes make the losers persist a stale token, which
logs the user out at next expiry.

`validAccessToken()` is `async` and can throw on network failure. Keep it inside try/catch
in every route — an unhandled rejection in Express 4 leaves the request hanging with no
response.

### `public/visualizer.js`

`class Visualizer` owns a WebGL2 renderer and a GPU ping-pong particle system.
Particles form 31 equalizer columns. `uGravity` pulls them down and `uLife` is how
fast they respawn. A half-resolution bloom pass runs after the points.

### Debug handles

```js
window.__viz          // Visualizer instance
window.__state        // app state (queue, track, paused, …)
window.__file         // local file player
window.__refreshQueue // force a queue refetch
```
