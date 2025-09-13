// tools/validate-voice.js
// Validate one or more TTS voice IDs against the configured endpoint.
// Usage:
//   node tools/validate-voice.js narrator
//   node tools/validate-voice.js en_male_storyteller en_us_001
//   npm run voice:validate -- narrator en_us_001

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const TTS_ENDPOINT = process.env.TTS_ENDPOINT || 'https://tiktok-tts.weilnet.workers.dev';
const DEFAULT_TEXT = process.env.TTS_TEST_TEXT || 'Testing voice';
const TIMEOUT_MS = Number(process.env.TTS_TEST_TIMEOUT_MS || 15000);

function usage() {
  console.log('Validate one or more voice IDs against the TTS endpoint');
  console.log('Usage:');
  console.log('  node tools/validate-voice.js <voice> [moreVoices...]');
  console.log('  node tools/validate-voice.js --all   (validate all from tiktokVoices.json)');
  console.log('Examples:');
  console.log('  node tools/validate-voice.js narrator');
  console.log('  npm run voice:validate -- narrator en_male_storyteller');
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
    fetch(url, opts).then((res) => { clearTimeout(to); resolve(res); }, (err) => { clearTimeout(to); reject(err); });
  });
}

async function testVoice(voice) {
  const url = `${TTS_ENDPOINT}/api/generation`;
  const body = { text: DEFAULT_TEXT, voice };
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, TIMEOUT_MS);

  let json;
  try { json = await res.json(); } catch (e) {
    throw new Error(`HTTP ${res.status} (non-JSON)`);
  }
  if (!res.ok || !json?.data) {
    const err = json?.error || `HTTP ${res.status}`;
    throw new Error(err);
  }
  const buf = Buffer.from(json.data, 'base64');
  if (!buf?.length) throw new Error('Empty audio payload');
  return buf.length;
}

async function main() {
  const args = process.argv.slice(2).filter(Boolean);
  if (!args.length) { usage(); process.exit(2); }

  // Load whitelist from tiktokVoices.json if present
  const jsonPath = path.resolve(process.cwd(), 'tiktokVoices.json');
  let whitelist = [];
  if (fs.existsSync(jsonPath)) {
    try {
      const arr = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      whitelist = Array.isArray(arr) ? arr.map(v => v.voice_id).filter(Boolean) : [];
    } catch { /* ignore parse errors */ }
  }

  const useAll = args.length === 1 && args[0] === '--all';
  const voices = useAll ? whitelist : args;
  if (!voices.length) {
    console.log('No voices to validate.');
    if (!useAll) usage();
    process.exit(2);
  }

  console.log(`Endpoint: ${TTS_ENDPOINT}`);
  console.log(`Testing ${voices.length} voice(s)...`);

  let failures = 0;
  for (const v of voices) {
    const voice = String(v).trim();
    if (!voice) continue;
    if (whitelist.length && !whitelist.includes(voice)) {
      console.log(`[WARN] ${voice} is not in tiktokVoices.json list; attempting anyway...`);
    }
    const start = Date.now();
    try {
      const bytes = await testVoice(voice);
      const ms = Date.now() - start;
      console.log(`[OK]  ${voice}  (${bytes} bytes, ${ms}ms)`);
    } catch (e) {
      failures++;
      console.log(`[FAIL] ${voice}  -> ${e?.message || e}`);
    }
  }

  if (failures) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
