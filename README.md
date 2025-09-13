# Twitch TTS Reader

Twitch chat -> TikTok TTS -> audio playback, Windows‑friendly and zero native build.

Works with Node 18+. No node-gyp, no native speaker bindings. Uses `ffmpeg-static` to convert MP3 to WAV and `node-wav-player` for playback.

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

## 2) Configure Environment
1. Install dependencies:
   - `npm install`
2. Create your env file:
   - `cp .env.example .env`
3. Edit `.env` and fill:
   - `TWITCH_USERNAME` — your bot account username
   - `TWITCH_CHANNEL` — the channel to join (without `#`)
   - `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`
   - Optional defaults: `TTS_VOICE` (default: `en_male_narration`), `BYTE_LIMIT`, etc.

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
- Audio output: ensure system audio isn’t blocked/muted. Playback uses `node-wav-player` with `ffmpeg-static` conversion.

## Project Notes
- Windows‑first, no native build steps.
- UTF‑8 byte limit and chunking keep emoji/CJK intact.
- Endpoint default: `https://tiktok-tts.weilnet.workers.dev`.

