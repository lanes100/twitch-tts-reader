// tools/set-tts-voice.js
// Upserts TTS_VOICE into .env without printing secrets.
const fs = require('fs');
const path = require('path');

function upsertEnv(vars) {
  const envPath = path.resolve(process.cwd(), '.env');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
  const lines = content.split(/\r?\n/);
  for (const [key, value] of Object.entries(vars)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`);
    } else {
      lines.push(`${key}=${value}`);
      content = lines.filter(Boolean).join('\n') + '\n';
    }
  }
  fs.writeFileSync(envPath, content, 'utf8');
}

const VOICE = process.argv[2] || 'en_male_storyteller';
upsertEnv({ TTS_VOICE: VOICE });
console.log('TTS_VOICE updated.');

