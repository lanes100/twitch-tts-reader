# Twitch TTS Reader

Twitch chat -> TikTok TTS -> audio playback. Windows‑friendly, no native builds.

## OBS Dock Control Panel
- Local dock URL: `http://127.0.0.1:5176/obs` (configurable via `OBS_CTRL_PORT`).
- Always on: the dock server runs even if the bot isn’t connected yet.
- Controls:
  - Start/Stop Bot (starts/stops the Twitch client)
  - Play/Pause toggle
  - Skip Current / Skip All Pending
  - Volume slider (0.0–2.0)
  - Default Voice selector
  - Read All Messages toggle
- Compact grid layout with proper wrapping to fit square docks.

API (for advanced usage)
- GET `/api/status` → `{ playing, paused, queue_length, voice, read_all, volume, bot_running }`
- POST `/api/bot/start`
- POST `/api/bot/stop`
- POST `/api/pause`
- POST `/api/resume`
- POST `/api/skip-one`
- POST `/api/skip-all`
- POST `/api/voice` `{ voice_id }`
- POST `/api/read-all` `{ value: boolean }`
- POST `/api/volume` `{ value: number }` (0..2; Windows helper adjusts device volume 0..1)

## End‑User Quick Start (Recommended)
- Create a Twitch Application
    1. Go to https://dev.twitch.tv/console/apps and click “Register Your Application”.
    2. Name: anything (e.g., "TTS Reader").
    3. OAuth Redirect URL: `http://localhost:5173/callback`
    4. Category: Website Integration.
    5. After creating, open the app to copy the `Client ID` and generate a `Client Secret`.
    6. Scopes required: `chat:read chat:edit`.
- Download the latest Windows installer from [GitHub Releases](https://github.com/lanes100/twitch-tts-reader/releases) (Twitch TTS Reader Setup x.y.z.exe).
- Run the installer
- Open “Twitch TTS Reader”. In the window:
- Fill Twitch Username and Channel (no #)
- Paste your Twitch Client ID and Secret (from Twitch Dev Console)
- Keep Redirect URL as `http://localhost:5173/callback` unless you changed it in the app settings on Twitch
- Choose a Voice from the dropdown (friendly names from tiktokVoices.json)
- Optional: toggle “Read All Messages” if you want every message read aloud (you can change this live while streaming). Channel point redemptions are always read.
- Click “Authorize”. The button turns green and reads “Authorized as @username” when successful.
- Click “Start Bot” (button turns green while running). Logs are hidden by default—click “Show Logs” to view.
- Dark mode is default. Toggle View → Dark Mode to switch.

### In‑Chat Commands
- Broadcaster/mods:
  - `!limit <1..300>`: set byte chunk limit for messages
  - `!voice <voice_id>`: set the default TTS voice (e.g., `!voice en_male_narration`)
- Subscribers and mods (per‑user voice):
  - `!myvoice <voice_id>`: set your personal voice
  - `!<voice_id>`: shorthand, e.g., `!en_au_002`
  - `!default_voice`: reset your personal voice to the default
  - Voice IDs must exist in the built‑in `tiktokVoices.json` list

### Channel Point Redemptions
- When a user redeems a channel points reward, the bot fetches the reward title via Twitch Helix.
- If the reward title matches a friendly voice name in `tiktokVoices.json`, that voice is used for the entire message (all chunks), regardless of the Read All toggle.
- Required scope: `channel:read:redemptions` (granted automatically when you authorize in the app).

### Behavior Notes
- Messages never overlap: the bot queues messages and plays them in order.
- Minimal delay: while one message plays, the next is generated in parallel.
- The Read All toggle applies live. Redemptions always read. Admin/voice commands are handled but not spoken unless you enable command reading.
- Logs: click “Show Logs” to reveal; click again to hide.
- Dock is available even when the bot is stopped; Electron app and dock buttons stay in sync.

### Troubleshooting
- “Authorize” stays gray or missing scopes: click Authorize again and consent; force verify is enabled. Ensure you log in as the channel broadcaster.
- No sound: verify Windows audio isn’t muted; try a different voice; check Logs.
- App won’t launch or is blank: see startup log at `%APPDATA%/Twitch TTS Reader/startup.log` and reinstall the latest release.
- Installer runs but app won’t start: download a fresh installer from Releases.

## Features
- UTF‑8 byte‑aware message chunking (≤300 bytes, emoji/CJK safe)
- Queue with gap to avoid overlapping audio
- TikTok TTS via the `weilnet` Cloudflare Worker
- Windows‑first playback; cross‑platform compatible
- Simple chat commands: `!limit <1..300>`, `!voice <voice_id>`
- OAuth Authorization Code flow with background token refresh
- Voice validator tool; optional curated list via `tiktokVoices.json`

## Prerequisites
- Node.js 18+ (Node 20/22 OK)
- Twitch account
- A Twitch application (Client ID + Secret)

## 1) Create a Twitch Application
1. Go to https://dev.twitch.tv/console/apps and click “Register Your Application”.
2. Name: anything (e.g., "TTS Reader").
3. OAuth Redirect URL: `http://localhost:5173/callback`
4. Category: Website Integration.
5. After creating, open the app to copy the `Client ID` and generate a `Client Secret`.
6. Scopes required: `chat:read chat:edit`.

You can change the redirect port/URL later; if you do, keep the app settings and `.env` in sync.

## 2) Configure (Electron or CLI)
1. Install dependencies:
   - `npm install`
2. Create your env file:
   - `cp .env.example .env`
Electron app (recommended for end users)
- See the “End‑User Quick Start” at the top of this README.

CLI (optional, advanced)
1. Copy env: `cp .env.example .env`
2. Edit `.env` with your values. Ensure `TWITCH_SCOPES` includes: `chat:read chat:edit channel:read:redemptions`.
3. Authorize: `npm run auth` (opens browser)
4. Start: `npm start`

Single authorization
- The same authorization is used for chat and for Helix (channel points).
- Ensure `TWITCH_SCOPES` includes: `chat:read chat:edit channel:read:redemptions`.

Notes about secrets
- `.env` is gitignored. `.env.example` is tracked with placeholders.
- To avoid writing secrets to disk during auth/refresh, set `WRITE_ENV_FILE=false` (env var). Tokens will remain in memory for the process only.

## 3) Authorize the Bot (OAuth)
Run the auth helper to open a browser for consent:

```
npm run auth
```

Tips
- If the wrong account appears, use a private/incognito window or log out of Twitch first.
- If port 5173 is busy, the script attempts to terminate any listener automatically. You may also change `TWITCH_REDIRECT_URL` and update your Twitch app settings to match.

## 4) Start the Bot

```
npm start
```

On connect, it will join `#<TWITCH_CHANNEL>` and speak incoming chat messages according to your settings.

### Chat Commands (mods/broadcaster)
- `!limit <n>` — set the UTF‑8 byte chunk size (1..300)
- `!voice <voice_id>` — set the TikTok voice ID at runtime

### Per‑User Voices (subs/mods)
- `!myvoice <voice_id>` — set your personal voice
- `!<voice_id>` — shorthand, e.g., `!en_au_002`
- `!default_voice` — reset your personal voice to the default

## Voices
- Browse and preview voices online: https://lanes100.github.io/twitch-tts-reader/ (play sample and copy `!voice` commands)
- Default voice: `en_male_narration`
- You can persist a voice by setting `TTS_VOICE` in `.env` or at runtime with the command above.
- `tiktokVoices.json` contains a curated list of voices (id + human name). This file is optional but used by the validator tool.

### Validate Voice IDs
- Validate one or more specific voices:
  - `npm run voice:validate -- en_male_narration en_uk_001`
- Validate all voices found in `tiktokVoices.json`:
  - `npm run voice:validate:all`

Environment for validator (optional)
- `TTS_TEST_TEXT` — phrase to synthesize (default: "Testing voice")
- `TTS_TEST_TIMEOUT_MS` — request timeout (default: 15000)

## Tokens and Refresh
- Access tokens expire after ~4 hours. The app proactively refreshes in the background every ~3 hours using your `TWITCH_REFRESH_TOKEN` and updates in‑memory credentials (and `.env` if `WRITE_ENV_FILE=true`).
- You can also refresh manually:
  - `npm run refresh`

## Troubleshooting
- EADDRINUSE on port 5173 during auth: the script tries to terminate listeners automatically; otherwise change `TWITCH_REDIRECT_URL` and Twitch app settings to match.
- Browser didn’t open: copy the URL printed in the console and open it manually.
- TTS errors: run the voice validator to confirm a voice ID is accepted by the endpoint.
- Helix 401/403 for redemptions: ensure the token used for Helix has `channel:read:redemptions`. Re-run auth to grant new scopes, or set `TWITCH_BROADCASTER_OAUTH` with a broadcaster token.
- Audio output: ensure system audio isn’t blocked/muted. Playback uses `node-wav-player` with `ffmpeg-static` conversion.

## Project Notes
- Windows‑first, no native build steps.
- UTF‑8 byte limit and chunking keep emoji/CJK intact.
- Endpoint default: `https://tiktok-tts.weilnet.workers.dev`.

Electron vs CLI
- The Electron app stores configuration in its own app data and doesn’t require `.env`.
- The CLI (`npm start`) uses `.env`. Keep `.env.example` as a template.

OBS Dock integration
- Electron uses the local control API to start/stop the in‑process Twitch client so the dock and app stay synchronized.
- The renderer’s “Start Bot”/“Stop Bot” toggle reflects changes done in the dock (polled by the main process and emitted as an event).

## Release Builds (Windows)

Local build
- `npm install`
- `npm run build:electron` (uses electron‑builder)
- Output: `dist/` contains the NSIS installer (`.exe`) and unpacked app.

CI/CD plan (GitHub Actions)
- Trigger: on Git tag (e.g., `v*`) or manual dispatch.
- Runner: `windows-latest` to build the Windows installer.
- Steps:
  - Checkout repo
  - Setup Node (e.g., 20.x) with caching
  - `npm ci`
  - `npm run build:electron`
  - Upload artifacts (dist/*.exe, dist/*.yml) to the workflow run
  - Optional: Create GitHub Release and attach artifacts

Example workflow outline (add to `.github/workflows/release.yml`)

```
name: Build Electron (Windows)
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch: {}

jobs:
  build-win:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run build:electron
      - uses: actions/upload-artifact@v4
        with:
          name: twitch-tts-reader-win
          path: |
            dist/*.exe
            dist/*.yml
      # Optional: publish a release when building from tags
      - name: Create GitHub Release
        if: startsWith(github.ref, 'refs/tags/')
        uses: softprops/action-gh-release@v2
        with:
          files: |
            dist/*.exe
            dist/*.yml
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Notes
- Code signing: if you have a code signing cert, configure it per electron‑builder docs (env vars on the runner) to avoid SmartScreen warnings.
- Cache: electron caches downloads between runs; Node modules are cached via setup-node.
- Artifacts: you can also upload the unpacked `dist/win-unpacked` for portable usage.

## Acknowledgements
- TikTok TTS Cloudflare Worker by Weilbyte — the default endpoint used here
  - GitHub: https://github.com/Weilbyte/TikTok-Voice
  - Endpoint default: `https://tiktok-tts.weilnet.workers.dev`
- Libraries
  - tmi.js (Twitch IRC)
  - electron / electron-builder
  - ffmpeg-static
  - node-wav-player

## Environment Reference
- `OBS_CTRL_PORT` (default `5176`) — port for the local control server and OBS dock.
- `AUTOSTART_BOT` (default `true`) — when credentials are present, auto‑start the Twitch client at launch. Set to `false` to require manual start.
