# AGENTS.md

Guidance for agents working in this repository.

## What this is

A Spotify web player with a GPU particle visualizer, served at
**https://spotify.sh10151.uk** through a Cloudflare Tunnel.

- **Backend:** Node 24 + Express 4, `server/index.js`, port **3100**, bound to `127.0.0.1`.
- **Frontend:** plain ES modules, **no bundler, no build step, no React**. Three.js loads
  from `esm.sh` at runtime.
- **State:** single user, single Spotify account. OAuth tokens persist in `.tokens.json`.

Do not introduce a bundler, a framework, or a build pipeline. The absence of a build step
is deliberate — it keeps deploys to "edit a file, restart the service".

## Layout

```
server/index.js      OAuth (PKCE), token refresh, Spotify API proxy, static serving
public/index.html    Markup + the asset version query (see "Deploying changes")
public/app.js        SDK init, UI wiring, queue, controls, boot()
public/visualizer.js Three.js scene, GPU particle sim, vinyl mesh
public/rhythm.js     RhythmEngine — beat grid locked to playback position
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

Browsers cache aggressively and this has caused repeated "my fix didn't work" confusion.
Two separate caches are involved:

1. **The HTML** — `index.html` carries the asset version. Cloudflare is configured to
   **bypass cache** for HTML and JS/CSS on this host, and Node sends `no-store` for HTML.
2. **The imported modules** — `app.js` imports `visualizer.js` and `rhythm.js`. Versioning
   `app.js?v=N` alone does **not** version its imports; they get cached independently.

**Every frontend change requires a version bump:**

```js
// public/index.html
<script type="module" src="/app.js?v=10"></script>
```

`app.js` reads that query and forwards it to its imports:

```js
const V = new URL(import.meta.url).search;
const { Visualizer } = await import(`./visualizer.js${V}`);
const { RhythmEngine } = await import(`./rhythm.js${V}`);
```

So bumping `?v=` in `index.html` is the single action that busts all three. Then restart
the service. If a change appears not to land, check
`performance.getEntriesByType('resource')` in the browser console — all three modules
should show the same `?v=`.

## Audio-reactivity architecture — do not simplify this away

**The Spotify SDK iframe is cross-origin.** Its internal `<audio>` cannot be reached with
`createMediaElementSource()`, so direct FFT of the SDK element is impossible.

**The supported path is deliberate tab capture.** `public/audio.js` calls
`navigator.mediaDevices.getDisplayMedia()` after a user gesture, with `preferCurrentTab`.
When the user selects **this tab** and checks **“Share tab audio”**, the browser exposes a
`MediaStream` containing the tab's final mixed output — including Spotify's cross-origin
iframe. An `AnalyserNode` reads that stream safely and produces:

- 48 true logarithmic FFT bins from **25 Hz to 20 kHz** (or Nyquist when lower), used by
  the on-screen meter;
- 12 grouped spectrum zones uploaded to the GPU, each assigned to a different particle
  population, so low bass, low mids, mids, presence, and high-frequency air affect
  different parts of the cloud;
- broad bass/mid/treble values plus kick/onset, used for the larger radial and vinyl hits.

This is the only real all-frequency path. It requires a real user click and browser chooser;
the automated browser cannot grant it. The **Live audio (this tab)** switch starts/stops it.
The meter must say **`spectrum live`** and the hint must say **“Listening to this tab”**
before claiming actual audio sync. If it says **`beat <BPM> bpm`**, `rhythm.js` is active.

**Fallback:** Spotify's Audio Analysis and Audio Features APIs return HTTP 403 for this app.
When capture is denied or unavailable, `rhythm.js` runs a deterministic BPM grid locked to
`progress_ms`. This remains beat-synced, but it is not measured spectrum data. Keep the UI
labels honest.

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

`class Visualizer` — owns the scene, camera, lights, vinyl mesh, and particle system.

```js
setAudio({bass, mid, treble})  // per-frame audio bands
setCount(n)                    // rebuild particle buffers (expensive, ~1s)
setParam(name, value)          // sim uniforms:    uFlow, uSpeed
setRender(name, value)         // render uniforms:  uSize, uBloom, uBassSens
setEffect(effect)              // 0 spectrum bloom | 1 bass vortex | 2 mid aurora | 3 treble sparks
setToggle(name, on)            // 'particles' | 'vinyl' | 'react'
```

`uFlow` and `uReact` exist in **both** the sim and render uniform sets because both shaders
use them — update both if you change either.

Particles are simulated **entirely on the GPU** with `GPUComputationRenderer` — position
and velocity ping-pong through float textures, driven by curl noise. The CPU only uploads
three audio uniforms per frame.

**`setCount()` rebuilds the particle system.** Desired slider values live in
`this._settings` and are re-applied to the new system. If you add a new uniform, add it to
`_settings` too — otherwise it silently resets whenever the count slider moves. This bug
has already happened once.

### `public/rhythm.js`

`class RhythmEngine` — `setTrack()`, `setPlaying()`, `setProgress()`, `tick(dt, now)`.

BPM comes from a per-track table (`KNOWN_BPM`), defaulting to 120. **Adding a track's real
BPM is the single most effective way to improve sync** — the phase lock does the rest.

### Debug handles

Exposed on `window` for console inspection:

```js
window.__viz          // Visualizer instance (fps, particles, uniforms)
window.__state        // app state (queue, track, paused, …)
window.__rhythm       // RhythmEngine
window.__refreshQueue // force a queue refetch
```

## Testing

The automated browser cannot produce a user gesture, so **real audio playback cannot be
tested headlessly**. To exercise the beat engine without playback:

```js
window.__rhythm.setPlaying(true);
window.__rhythm.setProgress(0);
```

Then sample `window.__viz.audio.bass` — it should oscillate (peaks ~0.2–0.4, decaying
toward ~0.05), not sit flat.

Headless FPS is ~27 because the test browser uses SwiftShader (software GL). That is not
representative of real hardware.

Verify visually with a screenshot before claiming the render is correct. Check for: white
blob / overexposure, vinyl visible, particle cloud well-formed, no UI clipping.

## History

- Particle over-brightness (150k additive sprites blew out to a white blob) — fixed with
  clamped point size, core fade, and halo falloff.
- Volume slider escaped its panel — flex `min-width: 0`.
- Queue boot race — `refreshQueue()` ran before the SDK had a device and failed in a bare
  `catch {}`; now retries every 2.5s, up to 12 times.
- Particle rebuild reset all other sliders — see `_settings` above.
- "Bass sensitivity" slider wrote to an unused global — now a real `uBassSens` uniform.
- Token-refresh race — see `refreshInFlight` above.
- Module cache-busting — see "Deploying changes" above.
