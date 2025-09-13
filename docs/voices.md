# TikTok TTS Voices — IDs and Usage

This page lists how to use voices with Twitch TTS Reader and where to find valid IDs.

Quick usage in chat
- Broadcaster/mod: change default voice for the stream
  - `!voice <voice_id>`
  - Example: `!voice en_male_narration`
- Subscriber/mod: set your personal voice (persists until you reset)
  - `!myvoice <voice_id>`
  - Shorthand: `!<voice_id>` (e.g., `!en_au_002`)
  - Reset to default: `!default_voice` (also accepts `!default voice`, `!reset voice`, `!default`)
- Channel point redemptions: if a reward title matches a friendly voice name in the list, that voice is used for that message.

Where do I find voice IDs?
- This repository includes `tiktokVoices.json` with a curated list of voices. Each entry has:
  - `name`: friendly name (used by channel point rewards)
  - `voice_id`: the ID you paste into chat or set as default
- You can validate candidate IDs locally:
  - `npm run voice:validate -- <id1> <id2> ...`
  - Validate all from the JSON list: `npm run voice:validate:all`

Examples (subset)
- en_male_narration — “Story Teller [Male]”
- en_uk_001 — “Narrator (Chris) [Male]”
- en_au_002 — “Smooth (Alex) [Male]”
- en_us_006 — “Joey [Male]”
- en_us_007 — “Professor [Male]”
- en_us_009 — “Scientist [Male]”
- en_us_010 — “Confidence [Male]”

Complete list
- Open `tiktokVoices.json` in the repo to browse all available voices.
- Note: The upstream service can change availability; use the validator to confirm a voice works for you.

Tips
- For channel point redemptions, set the reward title to match a friendly name exactly (from the JSON). Example: “Narrator (Chris) [Male]”.
- For chat commands, paste the `voice_id` exactly (e.g., `en_au_002`).

