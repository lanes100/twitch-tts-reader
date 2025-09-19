// Generate short MP3 samples for each voice into docs/samples/<voice_id>.mp3
// Usage: node tools/generate-voice-samples.js [--text "Sample text"] [--concurrency 4]

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const TTS_ENDPOINT = process.env.TTS_ENDPOINT || 'https://tiktok-tts.weilnet.workers.dev';
const ROOT = process.cwd();
const VOICES_JSON = path.join(ROOT, 'tiktokVoices.json');
const OUT_DIR = path.join(ROOT, 'docs', 'samples');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { text: 'This is my voice.', concurrency: 4, force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--text' && args[i + 1]) { opts.text = args[++i]; continue; }
    if (a === '--concurrency' && args[i + 1]) { opts.concurrency = Math.max(1, parseInt(args[++i], 10) || 4); continue; }
    if (a === '--force') { opts.force = true; continue; }
  }
  return opts;
}

async function synthSample(voiceId, text) {
  const url = `${TTS_ENDPOINT}/api/generation`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: voiceId })
  });
  let json;
  try { json = await res.json(); } catch {}
  if (!res.ok || !json?.data) {
    const err = json?.error || `HTTP ${res.status}`;
    throw new Error(err);
  }
  return Buffer.from(json.data, 'base64');
}

async function main() {
  const { text, concurrency, force } = parseArgs();
  const raw = fs.readFileSync(VOICES_JSON, 'utf8');
  const voices = JSON.parse(raw).filter(v => v && v.voice_id);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Generating samples to ${OUT_DIR} (voices: ${voices.length}, concurrency: ${concurrency})`);

  let idx = 0;
  let ok = 0, fail = 0, skipped = 0;
  const work = voices.map(v => async () => {
    const out = path.join(OUT_DIR, `${v.voice_id}.mp3`);
    if (!force && fs.existsSync(out)) { skipped++; return; }
    try {
      const buf = await synthSample(v.voice_id, text);
      fs.writeFileSync(out, buf);
      ok++;
      process.stdout.write(`\r[${ok + fail + skipped}/${voices.length}] ${v.voice_id}   `);
    } catch (e) {
      fail++;
      console.warn(`\nFailed ${v.voice_id}: ${e?.message || e}`);
    }
  });

  // Simple concurrency runner
  const queue = work.slice();
  async function runOne() { const fn = queue.shift(); if (!fn) return; await fn(); return runOne(); }
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, () => runOne());
  await Promise.all(runners);
  console.log(`\nDone. ok=${ok} skipped=${skipped} fail=${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });

