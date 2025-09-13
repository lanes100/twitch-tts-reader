# twitch-tts-reader — workspace context for CodeX

## Purpose
Read Twitch chat with tmi.js, split messages into ≤300 UTF-8 bytes at word boundaries, queue chunks, call TikTok TTS endpoint, and **play audio on Windows** without native Node addons.

## Design decisions (keep these!)
- No native modules (speaker/lame) to avoid node-gyp on Windows/Node 22.
- Playback path: Base64 MP3 → **ffmpeg-static** → temp WAV → **PowerShell .NET SoundPlayer** (PlaySync).
- OAuth: Authorization Code flow. `auth.js` writes `TWITCH_OAUTH=oauth:...` and `TWITCH_REFRESH_TOKEN` to `.env`. `refresh.js` rotates tokens.
- Byte limit: configurable via `.env` (clamped to 300). Long messages split on **word boundaries** with **UTF-8 byte** accounting (emoji/CJK safe).
- Optional runtime commands: `!limit <n>` and `!voice <id>` (mods/broadcaster).

## Files
- `index.js` — Twitch bot, queue, chunking, ffmpeg → WAV → PowerShell playback.
- `auth.js` — local web callback; exchanges `code` → tokens; writes `.env`.
- `refresh.js` — refreshes access token using `TWITCH_REFRESH_TOKEN`.
- `.env` — Twitch creds and settings (see sample below).
- `.vscode/*` — tasks/launch configs (optional).

## .env shape (redact secrets!)
TWITCH_USERNAME=laneskeybot
TWITCH_CHANNEL=laneskb
TWITCH_OAUTH=oauth:...            # written by auth.js
TTS_ENDPOINT=https://tiktok-tts.weilnet.workers.dev
TTS_VOICE=en_us_001
BYTE_LIMIT=300
READ_COMMANDS=false
SELF_READ=false
TWITCH_CLIENT_ID=...
TWITCH_CLIENT_SECRET=...
TWITCH_SCOPES=chat:read chat:edit
TWITCH_REDIRECT_URL=http://localhost:5173/callback
TWITCH_REFRESH_TOKEN=...

## Open tasks you can help with (for the agent)
- Add cross-platform playback (macOS: `afplay`, Linux: `aplay/paplay`) chosen by `process.platform`.
- Auto-refresh on 401 inside `index.js` (invoke refresh flow and retry once).
- Add per-user rate limit + queue length cap.
- Add whitelist of TTS voices and a `!voices` command.

## Constraints
- Windows-first; avoid native compilations.
- Respect UTF-8 byte limit (not code units).
- Avoid blocking the message loop longer than necessary; queue handles sequencing.
