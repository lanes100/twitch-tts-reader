// Resolve ffmpeg path; fix asar path when packaged under Electron
const _ffmpegPath = require('ffmpeg-static');
const ffmpegPath = _ffmpegPath && _ffmpegPath.includes('app.asar')
  ? _ffmpegPath.replace('app.asar', 'app.asar.unpacked')
  : _ffmpegPath;
const wavPlayer = require('node-wav-player');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

require('dotenv').config();
const tmi = require('tmi.js');
const fetch = require('node-fetch');        // v2 (CommonJS)
const { TextEncoder } = require('util');

// --------- ENV & Defaults ----------
function clampInt(str, min, max, fallback) {
  const n = Number.parseInt(String(str), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const TWITCH_USERNAME = process.env.TWITCH_USERNAME || '';
const TWITCH_CHANNEL  = process.env.TWITCH_CHANNEL  || '';
const TWITCH_OAUTH    = process.env.TWITCH_OAUTH    || '';
const TTS_ENDPOINT    = process.env.TTS_ENDPOINT || 'https://tiktok-tts.weilnet.workers.dev';
let TTS_VOICE         = process.env.TTS_VOICE || 'en_male_narration';
const VOICES_DOC_URL  = process.env.VOICES_DOC_URL || 'https://lanes100.github.io/twitch-tts-reader/';
const READ_COMMANDS   = (process.env.READ_COMMANDS || 'false').toLowerCase() === 'true';
const SELF_READ       = (process.env.SELF_READ || 'false').toLowerCase() === 'true';
const WRITE_ENV_FILE  = (process.env.WRITE_ENV_FILE || 'true').toLowerCase() !== 'false';
let READ_ALL          = (process.env.READ_ALL || 'true').toLowerCase() === 'true';
let VOICE_PRIVILEGED_ONLY = (process.env.VOICE_PRIVILEGED_ONLY || 'true').toLowerCase() === 'true';
// Always ignore known chat bots (non-configurable)
const KNOWN_BOTS = [
  'streamelements','streamlabs','nightbot','moobot','wizebot','fossabot','cloudbot',
  'commanderroot','soundalerts','stay_hydrated_bot','anotherttvviewer','chatstatsbot',
];
const KNOWN_BOTS_SET = new Set(KNOWN_BOTS);
function isLikelyBot(tags) {
  const name = String(tags.username || '').toLowerCase();
  if (!name) return false;
  if (KNOWN_BOTS_SET.has(name)) return true;
  if (name.endsWith('bot') || name.startsWith('bot') || name.includes('bot_')) return true;
  const disp = String(tags['display-name'] || '').toLowerCase();
  if (disp && disp.includes('bot')) return true;
  return false;
}

// Optional: Twitch OAuth refresh (prevents mid-stream auth issues)
const TWITCH_CLIENT_ID     = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
let   TWITCH_REFRESH_TOKEN = process.env.TWITCH_REFRESH_TOKEN || '';

const BYTE_LIMIT_BASE = clampInt(process.env.BYTE_LIMIT, 1, 300, 300);
// Runtime-adjustable (via !limit); starts at env value:
let BYTE_LIMIT = BYTE_LIMIT_BASE;

if (!TWITCH_USERNAME || !TWITCH_CHANNEL || !TWITCH_OAUTH) {
  console.error('Missing env vars: set TWITCH_USERNAME, TWITCH_CHANNEL, TWITCH_OAUTH');
  process.exit(1);
}

const enc = new TextEncoder();

// --------- Queue & Chunking ----------
const queue = [];
let playing = false;

// --------- Live Config Watch (from Electron) ----------
const APP_CONFIG_PATH = process.env.APP_CONFIG_PATH || '';
if (APP_CONFIG_PATH) {
  try {
    let timer = null;
    const applyCfg = () => {
      try {
        const raw = fs.readFileSync(APP_CONFIG_PATH, 'utf8');
        const cfg = JSON.parse(raw);
        if (cfg && typeof cfg.TTS_VOICE === 'string' && cfg.TTS_VOICE.trim()) {
          TTS_VOICE = cfg.TTS_VOICE.trim();
          // Optional: log change
          console.log(`Voice updated to ${TTS_VOICE}`);
        }
        if (cfg && typeof cfg.READ_ALL !== 'undefined') {
          const v = (String(cfg.READ_ALL).toLowerCase() === 'true');
          READ_ALL = v;
        }
        if (cfg && typeof cfg.VOICE_PRIVILEGED_ONLY !== 'undefined') {
          VOICE_PRIVILEGED_ONLY = (String(cfg.VOICE_PRIVILEGED_ONLY).toLowerCase() === 'true');
        }
      } catch {}
    };
    applyCfg();
    fs.watch(APP_CONFIG_PATH, { persistent: false }, () => {
      clearTimeout(timer);
      timer = setTimeout(applyCfg, 150);
    });
  } catch {}
}

// --------- Voice Resolver (Reward -> Voice) ----------
let voicesIndexByName = new Map(); // lowercased friendly name -> voice_id
let voicesIdSet = new Set();       // set of valid voice_id values
const rewardTitleCache = new Map(); // reward_id -> reward title (friendly name)

function loadVoicesJson() {
  const candidates = [
    path.resolve(process.cwd(), 'tiktokVoices.json'),
    path.resolve(__dirname, 'tiktokVoices.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(arr)) {
          const map = new Map();
          const ids = new Set();
          for (const v of arr) {
            if (v && v.name && v.voice_id) map.set(String(v.name).toLowerCase(), String(v.voice_id));
            if (v && v.voice_id) ids.add(String(v.voice_id));
          }
          voicesIndexByName = map;
          voicesIdSet = ids;
          return;
        }
      }
    } catch {}
  }
}

async function helixGetRewardTitle(broadcasterId, rewardId) {
  if (rewardTitleCache.has(rewardId)) return rewardTitleCache.get(rewardId);
  const clientId = process.env.TWITCH_CLIENT_ID || '';
  const bearer = (process.env.TWITCH_OAUTH || '').replace(/^oauth:/, '');
  if (!clientId || !bearer) {
    console.warn('Missing TWITCH_CLIENT_ID or TWITCH_OAUTH for Helix lookup');
    return null;
  }
  const url = new URL('https://api.twitch.tv/helix/channel_points/custom_rewards');
  url.searchParams.set('broadcaster_id', String(broadcasterId));
  url.searchParams.set('id', String(rewardId));
  const res = await fetch(url, { headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${bearer}` } });
  let json = null;
  try { json = await res.json(); } catch {}
  if (!res.ok) {
    const code = res.status;
    if (code === 401 || code === 403) {
      console.warn('Helix denied. Ensure scope channel:read:redemptions is granted and re-run auth.');
    } else {
      console.warn(`Helix error ${code}: ${JSON.stringify(json)}`);
    }
    return null;
  }
  const data = Array.isArray(json?.data) ? json.data : [];
  const title = data[0]?.title || null;
  if (title) rewardTitleCache.set(rewardId, title);
  return title;
}

async function resolveVoiceFromRewardId(rewardId, broadcasterId) {
  const title = await helixGetRewardTitle(broadcasterId, rewardId);
  if (!title) return null;
  const id = voicesIndexByName.get(String(title).toLowerCase());
  if (!id) {
    console.warn(`Reward title not found in tiktokVoices.json: ${title}`);
    return null;
  }
  return id;
}

// initial load and watch for updates to voices list
loadVoicesJson();
try { fs.watch(path.resolve(process.cwd(), 'tiktokVoices.json'), { persistent: false }, () => loadVoicesJson()); } catch {}

// --------- Per-User Voice Preferences ----------
const USER_VOICES_PATH = (() => {
  const base = process.env.APP_CONFIG_PATH ? path.dirname(process.env.APP_CONFIG_PATH) : process.cwd();
  return path.join(base, 'userVoices.json');
})();

let userVoices = {};
function loadUserVoices() {
  try {
    if (fs.existsSync(USER_VOICES_PATH)) {
      const obj = JSON.parse(fs.readFileSync(USER_VOICES_PATH, 'utf8'));
      if (obj && typeof obj === 'object') userVoices = obj;
    }
  } catch {}
}
function saveUserVoices() {
  try {
    fs.writeFileSync(USER_VOICES_PATH, JSON.stringify(userVoices, null, 2), 'utf8');
  } catch (e) {
    console.warn('Failed to save user voices:', e?.message || e);
  }
}
loadUserVoices();

// Split to <= byteLimit bytes on word boundaries (emoji/CJK safe)
function splitToUtf8WordChunks(text, byteLimit = 300) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length) {
    if (enc.encode(remaining).length <= byteLimit) {
      chunks.push(remaining);
      break;
    }
    const cps = Array.from(remaining); // code points
    // binary search for max-fit prefix
    let lo = 1, hi = cps.length, fit = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const slice = cps.slice(0, mid).join('');
      const bytes = enc.encode(slice).length;
      if (bytes <= byteLimit) { fit = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    let candidate = cps.slice(0, fit);
    // back to last whitespace to keep whole words
    let boundary = -1;
    for (let i = candidate.length - 1; i >= 0; i--) {
      if (/\s/.test(candidate[i])) { boundary = i; break; }
    }
    if (boundary > 0) candidate = candidate.slice(0, boundary);
    if (!candidate.length) candidate = cps.slice(0, fit); // fallback

    const chunk = candidate.join('').trim();
    if (chunk) chunks.push(chunk);
    remaining = cps.slice(candidate.length).join('').trim();
  }
  return chunks;
}

function enqueue(text, voiceOverride) {
  const parts = splitToUtf8WordChunks(text, BYTE_LIMIT);
  for (const p of parts) queue.push({ text: p, voice: voiceOverride || null });
  if (!playing) drainQueue();
}

async function drainQueue() {
  playing = true;
  try {
    if (!queue.length) return;
    // Pipeline TTS generation for next item while current plays
    let current = queue.shift();
    let currentPromise = synthToWav(current.text, current.voice || undefined);
    while (true) {
      const next = queue.shift();
      const nextPromise = next ? synthToWav(next.text, next.voice || undefined) : null;
      const wavPath = await currentPromise;
      await playWav(wavPath);
      if (!nextPromise) break;
      currentPromise = nextPromise;
    }
  } catch (e) {
    console.error(e?.message || e);
  } finally {
    playing = false;
    // If new items arrived during playback, continue draining
    if (queue.length) drainQueue();
  }
}

// --------- TTS & Playback ----------
async function synthToWav(text, voiceOverride) {
  if (!text) throw new Error('Empty text');
  const res = await fetch(`${TTS_ENDPOINT}/api/generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: voiceOverride || TTS_VOICE }),
  });
  let json;
  try { json = await res.json(); } catch {
    throw new Error(`TTS failed: HTTP ${res.status}`);
  }
  if (!res.ok || !json?.data) {
    const err = json?.error || `HTTP ${res.status}`;
    throw new Error(`TTS failed: ${err}`);
  }
  const mp3Buf = Buffer.from(json.data, 'base64');
  const wavPath = path.join(os.tmpdir(), `tts-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  await new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      '-loglevel', 'error',
      '-y',
      '-f', 'mp3',
      '-i', 'pipe:0',
      '-f', 'wav',
      '-ar', '48000',
      '-ac', '2',
      wavPath
    ], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    ff.on('error', reject);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
    ff.stdin.end(mp3Buf);
  });
  return wavPath;
}

async function playWav(wavPath) {
  try {
    if (process.platform === 'win32') {
      await playWavWindowsBlocking(wavPath);
    } else {
      await wavPlayer.play({ path: wavPath });
    }
  } finally {
    fs.unlink(wavPath, () => {});
  }
}

// Persistent PowerShell player to minimize per-message overhead on Windows
let psPlayer = null;
let psPending = [];
let psBuf = '';
function ensurePsPlayer() {
  if (psPlayer && !psPlayer.killed) return;
  const psScript = "$reader = [Console]::In; while (($line = $reader.ReadLine()) -ne $null) { if (-not [string]::IsNullOrWhiteSpace($line)) { try { $p = New-Object System.Media.SoundPlayer $line; $p.PlaySync(); Write-Output 'DONE' } catch { Write-Output ('ERR:' + $_.Exception.Message) } } }";
  psPlayer = spawn('powershell.exe', ['-NoLogo','-NoProfile','-Command', psScript], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
  psPlayer.on('error', (e) => {
    const q = psPending;
    psPending = [];
    q.forEach(p => p.reject(e));
  });
  psPlayer.stdout.on('data', (d) => {
    psBuf += d.toString();
    let idx;
    while ((idx = psBuf.indexOf('\n')) !== -1) {
      const line = psBuf.slice(0, idx).trim();
      psBuf = psBuf.slice(idx + 1);
      if (!psPending.length) continue;
      const { resolve, reject } = psPending.shift();
      if (line === 'DONE') resolve();
      else if (line.startsWith('ERR:')) reject(new Error(line.slice(4)));
      else resolve();
    }
  });
  psPlayer.stderr.on('data', () => { /* ignore */ });
  psPlayer.on('close', () => {
    const q = psPending; psPending = [];
    q.forEach(p => p.reject(new Error('PowerShell player closed')));
  });
}

function playWavWindowsBlocking(wavPath) {
  ensurePsPlayer();
  return new Promise((resolve, reject) => {
    psPending.push({ resolve, reject });
    try {
      psPlayer.stdin.write(wavPath + '\n');
    } catch (e) {
      psPending.pop();
      reject(e);
    }
  });
}

// --------- Twitch Client ----------
const client = new tmi.Client({
  options: { debug: false },
  connection: { reconnect: true, secure: true },
  identity: { username: TWITCH_USERNAME, password: TWITCH_OAUTH },
  channels: [`#${TWITCH_CHANNEL}`],
});

client.on('connected', (addr, port) => {
  console.log(`Connected to Twitch at ${addr}:${port}, listening in #${TWITCH_CHANNEL}`);
  console.log(`TTS voice: ${TTS_VOICE} | Byte limit: ${BYTE_LIMIT}`);
});

let triedRefreshReconnect = false;
client.on('disconnected', async (reason) => {
  console.warn('Disconnected:', reason);
  if (!triedRefreshReconnect && TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET && TWITCH_REFRESH_TOKEN) {
    triedRefreshReconnect = true;
    try {
      await refreshAccessToken();
      // Update client identity for next connect
      client.opts.identity.password = process.env.TWITCH_OAUTH;
      console.log('Reconnecting after token refresh...');
      await client.connect();
      triedRefreshReconnect = false; // reset on success
    } catch (e) {
      console.warn('Auto-refresh reconnect failed:', e?.message || e);
    }
  }
});

client.on('message', async (channel, tags, message, self) => {
  const isBroadcaster = !!tags.badges?.broadcaster;
  const isMod = !!tags.mod || isBroadcaster;
  const isSub = tags.subscriber === true || tags.subscriber === '1' || tags.badges?.subscriber;
  const isVip = !!(tags.badges && tags.badges.vip);
  const canChangeVoice = (isMod || isSub || isVip) || !VOICE_PRIVILEGED_ONLY;

  // Public command (handle first so it doesn't get caught by shorthand voice matcher)
  const rawMsg = message.trim();
  if (/^!voices\b/i.test(rawMsg)) {
    client.say(channel, `Voice list and instructions: ${VOICES_DOC_URL}`);
    return;
  }

  // Owner/mod runtime commands (no global voice changes via chat)
  const cmdMatch = message.match(/^!(limit)\s+(.+)$/i);
  if (cmdMatch && isMod) {
    const [, cmd, arg] = cmdMatch;
    if (/^limit$/i.test(cmd)) {
      const newLimit = clampInt(arg, 1, 300, BYTE_LIMIT);
      BYTE_LIMIT = newLimit;
      client.say(channel, `Byte limit set to ${BYTE_LIMIT}.`);
      return;
    }
  }

  // Per-user reset shorthand before voice-id shorthand
  const resetMatch = message.match(/^!(?:default(?:[_\s]*voice)?|reset(?:[_\s]*voice)?)$/i);
  if (resetMatch && canChangeVoice) {
    const uid = String(tags['user-id'] || tags.username);
    if (userVoices[uid]) {
      delete userVoices[uid];
      saveUserVoices();
    }
    client.say(channel, `@${tags['display-name'] || tags.username}, your voice has been reset.`);
    return;
  }
  // Per-user voice set: !voice <voice_id>
  const setVoiceMatch = message.match(/^!voice\s+(\S+)$/i);
  if (setVoiceMatch && canChangeVoice) {
    const input = setVoiceMatch[1].trim();
    if (/^(default|reset)$/i.test(input)) {
      const uid = String(tags['user-id'] || tags.username);
      if (userVoices[uid]) {
        delete userVoices[uid];
        saveUserVoices();
      }
      client.say(channel, `@${tags['display-name'] || tags.username}, your voice has been reset.`);
      return;
    }
    if (voicesIdSet.size && !voicesIdSet.has(input)) {
      client.say(channel, `@${tags['display-name'] || tags.username}, unknown voice id. Type !voices to see the list.`);
      return;
    }
    const uid = String(tags['user-id'] || tags.username);
    userVoices[uid] = input;
    saveUserVoices();
    client.say(channel, `@${tags['display-name'] || tags.username}, your voice is now ${input}.`);
    return;
  }

  if (self && !SELF_READ) return;
  if (isLikelyBot(tags)) return; // ignore bots

  const trimmed = message.trim();
  if (!trimmed) return;

  const isCommand = trimmed.startsWith('!');
  if (isCommand && !READ_COMMANDS) return;

  // Normalize whitespace
  const clean = trimmed.replace(/\s+/g, ' ');
  // Channel points redemption support: tmi tag 'custom-reward-id'
  const rewardId = tags['custom-reward-id'];
  let voiceOverride = null;
  if (rewardId) {
    const broadcasterId = tags['room-id'];
    voiceOverride = await resolveVoiceFromRewardId(rewardId, broadcasterId);
  }
  // Respect READ_ALL toggle: if not a redemption and not READ_ALL, skip reading
  if (!rewardId && !READ_ALL) return;
  if (!voiceOverride) {
    const uid = String(tags['user-id'] || tags.username);
    if (uid && userVoices[uid]) voiceOverride = userVoices[uid];
  }
  enqueue(clean, voiceOverride);
});

client.connect().catch(err => {
  console.error('Twitch connect error:', err);
  process.exit(1);
});

// --------- Token Auto-Refresh (background) ----------
function upsertEnv(vars) {
  if (!WRITE_ENV_FILE) return; // Respect no-write mode
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch { /* new file */ }
    const lines = content.split(/\r?\n/);
    for (const [key, value] of Object.entries(vars)) {
      const re = new RegExp(`^${key}=.*$`, 'm');
      if (re.test(content)) content = content.replace(re, `${key}=${value}`);
      else { lines.push(`${key}=${value}`); content = lines.filter(Boolean).join('\n') + '\n'; }
    }
    fs.writeFileSync(envPath, content, 'utf8');
  } catch (e) {
    console.warn('Failed to persist updated .env tokens:', e?.message || e);
  }
}

async function refreshAccessToken() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !TWITCH_REFRESH_TOKEN) return;
  const url = 'https://id.twitch.tv/oauth2/token';
  const params = new URLSearchParams();
  params.set('client_id', TWITCH_CLIENT_ID);
  params.set('client_secret', TWITCH_CLIENT_SECRET);
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', TWITCH_REFRESH_TOKEN);

  const res = await fetch(url, { method: 'POST', body: params });
  const text = await res.text();
  if (!res.ok) throw new Error(`Refresh failed (${res.status}): ${text}`);

  const data = JSON.parse(text);
  const access = data.access_token;
  TWITCH_REFRESH_TOKEN = data.refresh_token || TWITCH_REFRESH_TOKEN;

  const newOauth = `oauth:${access}`;
  process.env.TWITCH_OAUTH = newOauth;
  process.env.TWITCH_REFRESH_TOKEN = TWITCH_REFRESH_TOKEN;
  upsertEnv({ TWITCH_OAUTH: newOauth, TWITCH_REFRESH_TOKEN });
  console.log('Access token refreshed.');
}

// Proactive refresh every ~3 hours to avoid expiry (~4h)
if (TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET && TWITCH_REFRESH_TOKEN) {
  const THREE_HOURS = 3 * 60 * 60 * 1000;
  setInterval(() => {
    refreshAccessToken().catch(e => console.warn('Background refresh failed:', e?.message || e));
    // Do not force reconnect; token is used on next connect
    client.opts.identity.password = process.env.TWITCH_OAUTH;
  }, THREE_HOURS).unref?.();
}
