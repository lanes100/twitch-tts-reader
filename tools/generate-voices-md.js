const fs = require('fs');
const path = require('path');

function buildMarkdown(voices) {
  const lines = [];
  lines.push('# TikTok TTS Voices — IDs and Usage');
  lines.push('');
  lines.push('This page lists how to use voices with Twitch TTS Reader and the complete list of IDs.');
  lines.push('');
  lines.push('Quick usage in chat');
  lines.push('- Broadcaster/mod: change default voice for the stream');
  lines.push('  - `!voice <voice_id>`');
  lines.push('  - Example: `!voice en_male_narration`');
  lines.push('- Subscriber/mod: set your personal voice (persists until you reset)');
  lines.push('  - `!myvoice <voice_id>`');
  lines.push('  - Shorthand: `!<voice_id>` (e.g., `!en_au_002`)');
  lines.push('  - Reset to default: `!default_voice` (also accepts `!default voice`, `!reset voice`, `!default`)');
  lines.push('- Channel point redemptions: if a reward title matches a friendly voice name in the list, that voice is used for that message.');
  lines.push('');
  lines.push('Complete list');
  lines.push('');
  for (const v of voices) {
    if (!v || !v.voice_id || !v.name) continue;
    lines.push(`- ${v.name}`);
    lines.push('```');
    lines.push(v.voice_id);
    lines.push('```');
    lines.push('');
  }
  lines.push('Note: The upstream service can change availability; use the validator to confirm a voice works for you.');
  lines.push('');
  lines.push('Tips');
  lines.push('- For channel point redemptions, set the reward title to match a friendly name exactly (from the list).');
  lines.push('- For chat commands, paste the `voice_id` exactly (e.g., `en_au_002`).');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const root = process.cwd();
  const jsonPath = path.join(root, 'tiktokVoices.json');
  const outPath = path.join(root, 'docs', 'voices.md');
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const voices = JSON.parse(raw);
  const md = buildMarkdown(voices);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md, 'utf8');
  console.log('Wrote', outPath, 'with', voices.length, 'voices');
}

main();

