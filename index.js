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
const express = require('express');

// ---------- ENV & Defaults -----------
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
  console.warn('Twitch credentials not fully set. The OBS dock will run; start the bot from the dock when ready.');
}

const enc = new TextEncoder();

// --------- Queue & Chunking ----------
const queue = [];
let playing = false;
let paused = false;
let VOLUME = Math.max(0, Math.min(2, parseFloat(process.env.VOLUME || '1') || 1));

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
      if (paused) break;
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
      ...(VOLUME && VOLUME !== 1 ? ['-filter:a', `volume=${VOLUME}`] : []),
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
// Windows Media Player controller (supports live pause/resume/volume/stop)
const USE_WMP = false; // set true to try WMP controller; false uses SoundPlayer one-shot (reliable audio)
// Native helper (NAudio) preferred; fallback to WMP/SoundPlayer
let helperProc = null;
let helperBuf = '';
let helperAckResolve = null;
let helperDoneResolve = null;
let wmpProc = null;
let wmpBuf = '';
let wmpPending = [];
// Removed basic SoundPlayer fallback; helper is required on Windows
function ensureWmpController() {
  if (wmpProc && !wmpProc.killed) return;
  const psScript = `
$wmp = New-Object -ComObject WMPlayer.OCX
$wmp.settings.volume = 100
$playing = $false
function WriteOut($s){ [Console]::Out.WriteLine($s) | Out-Null }
function PlayPath($p){ $global:playing = $true; $wmp.URL = $p; $wmp.controls.play() }
$reader = [Console]::In
while ($true) {
  while ($reader.Peek() -ne -1) {
    $line = $reader.ReadLine()
    if ($line) {
      if ($line -like 'PLAY *') { $path = $line.Substring(5).Trim(); PlayPath $path; WriteOut 'ACK' }
      elseif ($line -like 'PAUSE*') { $wmp.controls.pause(); WriteOut 'ACK' }
      elseif ($line -like 'RESUME*') { $wmp.controls.play(); WriteOut 'ACK' }
      elseif ($line -like 'STOP*') { $wmp.controls.stop(); WriteOut 'STOPPED' }
      elseif ($line -like 'VOLUME *') { $v = [int]($line.Substring(7).Trim()); if ($v -lt 0){$v=0}; if ($v -gt 100){$v=100}; $wmp.settings.volume = $v; WriteOut 'ACK' }
      else { WriteOut 'ACK' }
    }
  }
  $state = $wmp.playState
  if ($global:playing -and ($state -eq 1 -or $state -eq 8)) { WriteOut 'DONE'; $global:playing = $false }
  Start-Sleep -Milliseconds 50
}
`;
  wmpProc = spawn('powershell.exe', ['-NoLogo','-NoProfile','-STA','-Command', psScript], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
  wmpProc.on('error', (e) => {
    const q = wmpPending; wmpPending = []; q.forEach(p => p.reject(e));
  });
  wmpProc.stdout.on('data', d => {
    wmpBuf += d.toString();
    let idx;
    while ((idx = wmpBuf.indexOf('\n')) !== -1) {
      const line = wmpBuf.slice(0, idx).trim();
      wmpBuf = wmpBuf.slice(idx + 1);
      if (line === 'DONE' || line === 'STOPPED' || line === 'ACK') {
        const t = wmpPending.shift(); if (t) t.resolve(line);
      }
    }
  });
  wmpProc.stderr.on('data', () => {});
  wmpProc.on('close', () => {
    const q = wmpPending; wmpPending = []; q.forEach(p => p.reject(new Error('WMP controller closed')));
  });
}
function wmpSend(cmd) {
  ensureWmpController();
  return new Promise((resolve, reject) => {
    wmpPending.push({ resolve, reject });
    try { wmpProc.stdin.write(cmd + '\n'); } catch (e) { wmpPending.pop(); reject(e); }
  });
}
function helperPathCandidates() {
  const cands = [];
  if (process.env.APP_RESOURCES_DIR) {
    cands.push(path.join(process.env.APP_RESOURCES_DIR, 'AudioHelper.exe'));
    cands.push(path.join(process.env.APP_RESOURCES_DIR, 'audio-helper', 'AudioHelper.exe'));
  }
  // Common dev paths
  cands.push(path.join(process.cwd(), 'audio-helper', 'AudioHelper.exe'));
  cands.push(path.join(__dirname, 'audio-helper', 'AudioHelper.exe'));
  cands.push(path.join(process.cwd(), 'AudioHelper.exe'));
  cands.push(path.join(process.cwd(), 'audio-helper', 'bin', 'Release', 'net6.0-windows', 'win-x64', 'publish', 'AudioHelper.exe'));
  if (process.env.AUDIO_HELPER_PATH) cands.unshift(process.env.AUDIO_HELPER_PATH);
  return cands;
}
function ensureHelperController() {
  if (helperProc && !helperProc.killed) return true;
  const exe = helperPathCandidates().find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!exe) {
    try {
      console.error('[Audio] Helper not found. Searched:', helperPathCandidates().join(' | '));
    } catch {}
    return false;
  }
  helperProc = spawn(exe, [], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
  console.log(`[Audio] Using helper backend: ${exe}`);
  helperProc.on('error', (e) => { const q = helperPending; helperPending = []; q.forEach(p => p.reject(e)); });
  helperProc.stdout.on('data', d => {
    helperBuf += d.toString();
    let idx;
    while ((idx = helperBuf.indexOf('\n')) !== -1) {
      const line = helperBuf.slice(0, idx).trim();
      helperBuf = helperBuf.slice(idx + 1);
      try { console.log(`[Audio] helper: ${line}`); } catch {}
      if (line === 'ACK') { const fn = helperAckResolve; helperAckResolve = null; if (fn) fn(line); }
      else if (line === 'DONE' || line === 'STOPPED') { const fn = helperDoneResolve; helperDoneResolve = null; if (fn) fn(line); }
    }
  });
  helperProc.stderr.on('data', () => {});
  helperProc.on('close', () => { if (helperAckResolve) { try { helperAckResolve(Promise.reject(new Error('Helper closed')));} catch{} } helperAckResolve = null; if (helperDoneResolve) { try { helperDoneResolve(Promise.reject(new Error('Helper closed')));} catch{} } helperDoneResolve = null; });
  return true;
}
function helperSend(cmd) {
  if (!ensureHelperController()) return Promise.reject(new Error('Helper not available'));
  return new Promise((resolve, reject) => {
    helperAckResolve = resolve;
    try { helperProc.stdin.write(cmd + '\n'); } catch (e) { helperAckResolve = null; reject(e); }
  });
}
async function playWavWindowsBlocking(wavPath) {
  if (process.platform !== 'win32') throw new Error('Windows helper required for this path');
  if (!ensureHelperController()) throw new Error('Audio helper not found');
  await helperSend(`PLAY ${wavPath}`);
  const res = await new Promise((resolve, reject) => { helperDoneResolve = resolve; });
  try { console.log('[Audio] clip done'); } catch {}
  return res;
}
function interruptCurrentPlayback() {
  if (process.platform !== 'win32') return false;
  if (helperProc && !helperProc.killed) { try { helperSend('STOP'); return true; } catch { return false; } }
  return false;
}

// --------- Twitch Client (lazy start/stop) ----------
let client = null;
let botRunning = false;
let triedRefreshReconnect = false;

function buildClient() {
  return new tmi.Client({
    options: { debug: false },
    connection: { reconnect: true, secure: true },
    identity: { username: TWITCH_USERNAME, password: TWITCH_OAUTH },
    channels: [`#${TWITCH_CHANNEL}`],
  });
}

function setupClientEvents(c) {
  c.on('connected', (addr, port) => {
    botRunning = true;
    console.log(`Connected to Twitch at ${addr}:${port}, listening in #${TWITCH_CHANNEL}`);
    console.log(`TTS voice: ${TTS_VOICE} | Byte limit: ${BYTE_LIMIT}`);
  });

  c.on('disconnected', async (reason) => {
    console.warn('Disconnected:', reason);
    botRunning = false;
    if (!triedRefreshReconnect && TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET && TWITCH_REFRESH_TOKEN) {
      triedRefreshReconnect = true;
      try {
        await refreshAccessToken();
        if (client) client.opts.identity.password = process.env.TWITCH_OAUTH;
        console.log('Reconnecting after token refresh...');
        if (client) await client.connect();
        triedRefreshReconnect = false; // reset on success
      } catch (e) {
        console.warn('Auto-refresh reconnect failed:', e?.message || e);
      }
    }
  });

  c.on('message', async (channel, tags, message, self) => {
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
}

async function startBot() {
  if (client) return { ok: true, already: true };
  if (!TWITCH_USERNAME || !TWITCH_CHANNEL || !TWITCH_OAUTH) {
    throw new Error('Missing Twitch credentials (TWITCH_USERNAME, TWITCH_CHANNEL, TWITCH_OAUTH)');
  }
  const c = buildClient();
  setupClientEvents(c);
  client = c;
  try {
    await client.connect();
    botRunning = true;
    return { ok: true };
  } catch (e) {
    client = null; botRunning = false;
    throw e;
  }
}

async function stopBot() {
  if (!client) return { ok: true, already: true };
  try { await client.disconnect(); } catch {}
  client.removeAllListeners?.();
  client = null;
  botRunning = false;
  return { ok: true };
}

// Auto-start the Twitch client when credentials are present unless explicitly disabled
if (process.env.AUTOSTART_BOT !== 'false') {
  if (TWITCH_USERNAME && TWITCH_CHANNEL && TWITCH_OAUTH) {
    startBot().catch(e => {
      try { console.warn('Autostart failed:', e?.message || e); } catch {}
    });
  }
}

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
    if (client) client.opts.identity.password = process.env.TWITCH_OAUTH;
  }, THREE_HOURS).unref?.();
}

// --------- Local Control Server (OBS Dock) ----------
try {
  const CTRL_PORT = parseInt(process.env.OBS_CTRL_PORT || '5176', 10);
  const app = express();
  app.use(express.json());

  // Status
  app.get('/api/status', (req, res) => {
    res.json({
      playing,
      paused,
      queue_length: queue.length,
      voice: TTS_VOICE,
      read_all: READ_ALL,
      volume: VOLUME,
      bot_running: !!botRunning,
    });
  });

  // Bot controls
  app.post('/api/bot/start', async (req, res) => {
    try {
      const r = await startBot();
      res.json({ ok: true, ...r, bot_running: !!botRunning });
    } catch (e) {
      res.status(400).json({ ok: false, error: e?.message || String(e), bot_running: false });
    }
  });
  app.post('/api/bot/stop', async (req, res) => {
    try {
      const r = await stopBot();
      res.json({ ok: true, ...r, bot_running: !!botRunning });
    } catch (e) {
      res.status(400).json({ ok: false, error: e?.message || String(e), bot_running: !!botRunning });
    }
  });

  // Pause after current
  app.post('/api/pause', async (req, res) => {
    paused = true;
    if (process.platform === 'win32' && helperProc && !helperProc.killed) { try { await helperSend('PAUSE'); } catch {} }
    else return res.status(400).json({ ok: false, error: 'helper_unavailable' });
    res.json({ ok: true, paused: true });
  });
  app.post('/api/resume', async (req, res) => {
    paused = false;
    if (process.platform === 'win32' && helperProc && !helperProc.killed) { try { await helperSend('RESUME'); } catch {} }
    else return res.status(400).json({ ok: false, error: 'helper_unavailable' });
    if (queue.length && !playing) drainQueue();
    res.json({ ok: true, paused });
  });

  // Skip currently playing (instant stop on Windows)
  app.post('/api/skip-one', (req, res) => {
    const ok = interruptCurrentPlayback();
    res.json({ ok, note: ok ? 'Interrupted current playback.' : 'No active playback to interrupt (or non-Windows).' });
  });

  // Clear pending queue and interrupt current immediately (Windows)
  app.post('/api/skip-all', (req, res) => {
    queue.length = 0;
    const interrupted = interruptCurrentPlayback();
    res.json({ ok: true, cleared: true, interrupted });
  });

  // Set default voice
  app.post('/api/voice', (req, res) => {
    const vid = String(req.body?.voice_id || '').trim();
    if (!vid) return res.status(400).json({ error: 'voice_id required' });
    if (voicesIdSet.size && !voicesIdSet.has(vid)) return res.status(400).json({ error: 'unknown_voice' });
    TTS_VOICE = vid;
    res.json({ ok: true, voice: TTS_VOICE });
  });

  // Toggle read all
  app.post('/api/read-all', (req, res) => {
    const val = String(req.body?.value).toLowerCase();
    const v = (val === 'true' || val === '1' || req.body?.value === true);
    READ_ALL = v;
    res.json({ ok: true, read_all: READ_ALL });
  });

  // Volume (0..2 scalar)
  app.post('/api/volume', async (req, res) => {
    let v = parseFloat(req.body?.value);
    if (Number.isNaN(v)) return res.status(400).json({ error: 'invalid_volume' });
    VOLUME = Math.max(0, Math.min(2, v));
    if (process.platform === 'win32' && helperProc && !helperProc.killed) {
      const n = Math.max(0, Math.min(1, VOLUME));
      try { await helperSend(`VOLUME ${n}`); } catch {}
    } else return res.status(400).json({ ok: false, error: 'helper_unavailable' });
    res.json({ ok: true, volume: VOLUME });
  });

  // Simple OBS dock page
  app.get('/obs', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TTS Controls</title>
<style>
  :root{--bg:#0b0d10;--fg:#e6e6e6;--muted:#a9b1ba;--border:#2a2f36;--panel:#1d232a}
  body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:10px;background:var(--bg);color:var(--fg)}
  label{display:block;margin:8px 0 4px}
  button,input,select{padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--panel);color:var(--fg)}
  button{cursor:pointer}
  input[type=range]{width:220px}
  .row{margin:8px 0}
  .controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;align-items:stretch}
  .status{font-size:13px;color:var(--muted)}
</style>
<script>
// OBS dock enhancements
</script>
</head><body>
<h3>TTS Controls</h3>
<div class="row status">Status: <span id="status">…</span></div>
<div class="row controls">
  <button id="botToggle">Start Bot</button>
  <button id="playToggle">Pause</button>
  <button id="skip1">Skip Current</button>
  <button id="skipall">Skip All Pending</button>
  <label style="grid-column:1/-1">Volume (0.0–2.0)</label>
  <div style="display:flex;gap:8px;align-items:center;grid-column:1/-1">
    <input id="vol" type="range" min="0" max="2" step="0.05" value="1"><span id="volv"></span>
  </div>
  <label style="grid-column:1/-1">Default Voice</label>
  <select id="voice" style="grid-column:1/-1"></select>
  <label style="grid-column:1/-1"><input id="readall" type="checkbox"> Read All Messages</label>
  <div class="status" id="error" style="grid-column:1/-1;color:#ff9a9a"></div>
</div>
<script>
const $=s=>document.querySelector(s);
async function api(p,method='GET',body){const r=await fetch(p,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok) throw new Error(await r.text());return r.json();}
let currentStatus=null;
function setButtons(s){
  const botBtn=$('#botToggle');
  const playBtn=$('#playToggle');
  if (botBtn) botBtn.textContent = s.bot_running? 'Stop Bot' : 'Start Bot';
  if (playBtn) playBtn.textContent = s.paused? 'Resume' : 'Pause';
}
function setStatus(s){
  const state = s.bot_running? (s.playing? 'Playing' : (s.paused? 'Paused':'Idle')) : 'Bot Stopped';
  $('#status').textContent = state + ' | Queue: ' + s.queue_length + ' | Voice: ' + s.voice;
}
async function refresh(){
  try{
    const s=await api('/api/status'); currentStatus=s;
    setStatus(s); setButtons(s);
    $('#vol').value=s.volume; $('#volv').textContent=s.volume.toFixed(2);
    $('#readall').checked=!!s.read_all;
    const sel=$('#voice'); if(sel && s.voice && sel.value!==s.voice) sel.value=s.voice;
    $('#error').textContent='';
  }catch(e){$('#status').textContent='Error'; $('#error').textContent=String(e.message||e)}
}
$('#playToggle').onclick=()=>{
  if (!currentStatus) return;
  const path = currentStatus.paused? '/api/resume' : '/api/pause';
  api(path,'POST').then(refresh).catch(e=>{ $('#error').textContent=String(e.message||e) });
};
$('#botToggle').onclick=()=>{
  if (!currentStatus) return;
  const path = currentStatus.bot_running? '/api/bot/stop' : '/api/bot/start';
  api(path,'POST').then(refresh).catch(e=>{ $('#error').textContent=String(e.message||e) });
};
$('#skip1').onclick=()=>api('/api/skip-one','POST').then(refresh);
$('#skipall').onclick=()=>api('/api/skip-all','POST').then(refresh);
$('#vol').oninput=()=>{$('#volv').textContent=Number($('#vol').value).toFixed(2);} 
$('#vol').onchange=()=>api('/api/volume','POST',{value:Number($('#vol').value)}).then(refresh);
$('#readall').onchange=()=>api('/api/read-all','POST',{value:$('#readall').checked}).then(refresh);
async function loadVoices(){try{const res=await fetch('https://raw.githubusercontent.com/lanes100/twitch-tts-reader/main/tiktokVoices.json'); const arr=await res.json(); const sel=$('#voice'); sel.innerHTML=''; arr.forEach(v=>{const o=document.createElement('option'); o.value=v.voice_id; o.textContent=v.name; sel.appendChild(o);}); if(currentStatus && currentStatus.voice) sel.value=currentStatus.voice; sel.onchange=()=>api('/api/voice','POST',{voice_id:sel.value}).then(refresh);}catch(e){}}
loadVoices(); refresh(); setInterval(refresh, 3000);
</script>
</body></html>`);
  });

  app.listen(CTRL_PORT, '127.0.0.1', () => {
    console.log(`OBS Dock available at http://127.0.0.1:${CTRL_PORT}/obs`);
  });
} catch (e) {
  console.warn('Control server failed to start:', e?.message || e);
}





