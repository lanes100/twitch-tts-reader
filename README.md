# Twitch TTS Reader

Twitch chat -> TikTok TTS -> audio playback, Windows‑friendly and zero native build.

Use it as a one‑click Electron app (recommended) or as a CLI. No node‑gyp, no native speaker bindings. Uses `ffmpeg-static` to convert MP3 to WAV and `node-wav-player` for playback.

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
Electron app (recommended)
- Dev run: `npm run dev:electron`
- Fill in: Twitch Username, Channel, Client ID/Secret, Redirect URL (defaults to `http://localhost:5173/callback`), optional Helix Client ID override, TTS Endpoint, and Voice.
- Click “Authorize” and log in as the broadcaster. The button turns green and displays “Authorized as @username” when OK. Scopes are enforced: `chat:read chat:edit channel:read:redemptions`.
- Click “Start Bot” (turns green for running; red when stopped). Logs are hidden by default — use “Show Logs”. Dark mode is default; toggle in View → Dark Mode.

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

## Voices
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
