// Electron main process for Twitch TTS Reader
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const fetch = require('node-fetch');
const { spawn } = require('child_process');

// Reduce cache-related errors on Windows (disable GPU shader disk cache)
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const STARTUP_LOG = path.join(app.getPath('userData'), 'startup.log');

function logStartup(msg, err) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}${err ? `\n${String(err.stack || err)}` : ''}\n`;
    fs.appendFileSync(STARTUP_LOG, line, 'utf8');
  } catch {}
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

let mainWindow;
let botChild = null;
let oauthServer = null;
let currentTheme = 'dark';
let botRunPoll = null;

// ---- Local control (OBS Dock) helpers ----
const CTRL_HOST = '127.0.0.1';
const CTRL_PORT = parseInt(process.env.OBS_CTRL_PORT || '5176', 10);
async function ctrlFetch(pathname, opts = {}) {
  const url = `http://${CTRL_HOST}:${CTRL_PORT}${pathname}`;
  const init = { ...opts };
  if (opts && opts.body && typeof opts.body === 'object' && !(opts.body instanceof Buffer)) {
    init.headers = { ...(opts.headers || {}), 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(json?.error || text || `HTTP ${res.status}`);
  return json || {};
}
async function ctrlStatus() {
  try { return await ctrlFetch('/api/status'); } catch { return null; }
}
async function waitForControlReady(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await ctrlStatus();
    if (st && typeof st.bot_running !== 'undefined') return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function createWindow() {
  logStartup('Creating BrowserWindow');
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 726,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Load theme from config
  const cfg = loadConfig();
  currentTheme = cfg && cfg.theme ? cfg.theme : 'dark';
  buildMenu();
  try {
    await mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
    logStartup('Loaded renderer.html');
  } catch (e) {
    logStartup('Failed to load renderer.html', e);
    throw e;
  }
}

function ensurePortFree(port) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const cmd = `netstat -ano -p tcp | findstr :${port}`;
      require('child_process').exec(cmd, { windowsHide: true }, (err, stdout) => {
        if (!stdout) return resolve();
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        const pids = new Set();
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.includes('LISTENING')) {
            const pid = parts[parts.length - 1];
            if (/^\d+$/.test(pid)) pids.add(pid);
          }
        }
        if (!pids.size) return resolve();
        let pending = pids.size;
        for (const pid of pids) {
          require('child_process').exec(`taskkill /PID ${pid} /F`, () => {
            if (--pending === 0) setTimeout(resolve, 250);
          });
        }
      });
    } else {
      const cmd = `lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`;
      require('child_process').exec(cmd, (err, stdout) => {
        const pids = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (!pids.length) return resolve();
        let pending = pids.length;
        for (const pid of pids) {
          require('child_process').exec(`kill -9 ${pid}`, () => {
            if (--pending === 0) setTimeout(resolve, 250);
          });
        }
      });
    }
  });
}

async function startOAuth(cfg) {
  const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_REDIRECT_URL = 'http://localhost:5173/callback' } = cfg;
  const requiredScopes = ['chat:read','chat:edit','channel:read:redemptions'];
  const scopes = requiredScopes.join(' ');
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) throw new Error('Missing Twitch Client ID/Secret');
  const port = new URL(TWITCH_REDIRECT_URL).port || 5173;
  const callbackPath = new URL(TWITCH_REDIRECT_URL).pathname || '/callback';

  await ensurePortFree(port);
  const appServer = express();
  oauthServer = appServer.listen(port, () => {
    const auth = new URL('https://id.twitch.tv/oauth2/authorize');
    auth.searchParams.set('client_id', TWITCH_CLIENT_ID);
    auth.searchParams.set('redirect_uri', TWITCH_REDIRECT_URL);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', scopes);
    auth.searchParams.set('force_verify', 'true');
    shell.openExternal(auth.toString());
  });

  appServer.get(callbackPath, async (req, res) => {
    const { code, error, error_description } = req.query;
    if (error) {
      res.status(400).send(`<h3>Twitch error</h3><pre>${error}: ${error_description || ''}</pre>`);
      mainWindow.webContents.send('oauth:error', { error, error_description });
      return;
    }
    if (!code) {
      res.status(400).send('<h3>Missing ?code in callback</h3>');
      return;
    }
    try {
      const url = 'https://id.twitch.tv/oauth2/token';
      const params = new URLSearchParams();
      params.set('client_id', TWITCH_CLIENT_ID);
      params.set('client_secret', TWITCH_CLIENT_SECRET);
      params.set('code', code);
      params.set('grant_type', 'authorization_code');
      params.set('redirect_uri', TWITCH_REDIRECT_URL);
      const resp = await fetch(url, { method: 'POST', body: params });
      const data = await resp.json();
      if (!resp.ok) throw new Error(`${resp.status}: ${JSON.stringify(data)}`);
      const access = data.access_token;
      const refresh = data.refresh_token;
      const newCfg = { ...cfg, TWITCH_OAUTH: `oauth:${access}`, TWITCH_REFRESH_TOKEN: refresh || '' };
      saveConfig(newCfg);
      res.send('<h2>Success! You can close this tab.</h2>');
      mainWindow.webContents.send('oauth:success');
    } catch (e) {
      res.status(500).send(`<pre>${String(e?.message || e)}</pre>`);
      mainWindow.webContents.send('oauth:error', { error: String(e?.message || e) });
    } finally {
      setTimeout(() => { try { oauthServer?.close(); } catch {} oauthServer = null; }, 300);
    }
  });
}

function startBot(cfg) {
  if (botChild) return;
  const current = loadConfig();
  const merged = { ...current, ...cfg };
  // Normalize critical fields to avoid tmi auth errors
  const envUser = String(merged.TWITCH_USERNAME || '').trim().toLowerCase();
  const envChannel = String(merged.TWITCH_CHANNEL || '').trim().replace(/^#/, '');
  let envPass = String(merged.TWITCH_OAUTH || '').trim();
  if (envPass && !envPass.startsWith('oauth:')) envPass = `oauth:${envPass}`;

  const env = {
    ...process.env,
    APP_CONFIG_PATH: CONFIG_PATH,
    APP_RESOURCES_DIR: process.resourcesPath || path.dirname(app.getAppPath()),
    // Pass through everything else from cfg
    ...merged,
    // But enforce normalized connection fields
    TWITCH_USERNAME: envUser,
    TWITCH_CHANNEL: envChannel,
    TWITCH_OAUTH: envPass,
    ELECTRON_RUN_AS_NODE: '1',
  };
  // Resolve bot entry for both dev (electron/main.js) and packaged (app.asar) runs
  let indexPath = path.join(app.getAppPath(), 'index.js');
  if (!fs.existsSync(indexPath)) indexPath = path.join(__dirname, '..', 'index.js');
  if (!fs.existsSync(indexPath)) indexPath = path.resolve(process.cwd(), 'index.js');
  // Ensure the in-process bot will auto-start (can still be controlled via API)
  env.AUTOSTART_BOT = 'true';
  botChild = spawn(process.execPath, [indexPath], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  mainWindow?.webContents.send('bot:started');
  botChild.stdout.on('data', d => mainWindow?.webContents.send('bot:log', d.toString()));
  botChild.stderr.on('data', d => mainWindow?.webContents.send('bot:log', d.toString()));
  // Start polling in-process bot run state to sync UI even when toggled via dock
  if (botRunPoll) { clearInterval(botRunPoll); botRunPoll = null; }
  let lastState = null;
  botRunPoll = setInterval(async () => {
    if (!botChild) { if (lastState !== false) { mainWindow?.webContents.send('bot:running', false); lastState = false; } return; }
    const st = await ctrlStatus();
    const running = !!(st && st.bot_running);
    if (running !== lastState) {
      lastState = running;
      mainWindow?.webContents.send('bot:running', running);
    }
  }, 1000);
  botChild.on('exit', (code) => {
    mainWindow?.webContents.send('bot:exit', code);
    botChild = null;
    if (botRunPoll) { clearInterval(botRunPoll); botRunPoll = null; }
    mainWindow?.webContents.send('bot:running', false);
  });
}

function stopBot() {
  if (!botChild) return;
  try { botChild.kill('SIGINT'); } catch {}
}

app.whenReady().then(() => {
  try {
    // Ensure userData and cache dirs exist and are writable
    const userData = app.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });
    const cacheDir = path.join(userData, 'Cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    app.setPath('cache', cacheDir);
    logStartup(`UserData at: ${userData}`);
    logStartup(`Cache at: ${cacheDir}`);
  } catch (e) {
    logStartup('Failed to ensure userData/cache dirs', e);
  }
  return createWindow();
});
app.whenReady().then(() => logStartup('App ready')).catch(e => logStartup('App ready error', e));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('config:get', async () => loadConfig());
ipcMain.handle('config:set', async (_e, cfg) => {
  const current = loadConfig();
  const merged = { ...current, ...cfg };
  saveConfig(merged);
  return true;
});
ipcMain.handle('oauth:start', async (_e, cfg) => { await startOAuth(cfg); return true; });
ipcMain.handle('bot:start', async (_e, cfg) => {
  if (!botChild) await startBot(cfg);
  // Wait for control server to be ready, then ensure client is running
  await waitForControlReady(8000);
  try { await ctrlFetch('/api/bot/start', { method: 'POST' }); } catch {}
  return true;
});
ipcMain.handle('bot:stop', async () => {
  // Prefer stopping the in-process Twitch client via API; keep process alive
  const ok = await waitForControlReady(3000);
  if (ok) {
    try { await ctrlFetch('/api/bot/stop', { method: 'POST' }); } catch {}
  } else {
    // Fallback: stop the whole child when control is unavailable
    stopBot();
  }
  return true;
});
ipcMain.handle('bot:status', async () => {
  if (!botChild) return false;
  const st = await ctrlStatus();
  if (st && typeof st.bot_running !== 'undefined') return !!st.bot_running;
  return true; // child alive; assume running if status unavailable
});

function loadVoicesList() {
  const candidates = [
    path.join(process.cwd(), 'tiktokVoices.json'),
    path.join(app.getAppPath(), 'tiktokVoices.json'),
    path.join(__dirname, '..', 'tiktokVoices.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(data)) return data.filter(v => v && v.voice_id && v.name);
      }
    } catch {}
  }
  return [];
}

ipcMain.handle('voices:list', async () => loadVoicesList());

// ---- Auth status (validate tokens against Twitch) ----
async function validateToken(rawToken) {
  if (!rawToken) return { ok: false };
  const token = String(rawToken).replace(/^oauth:/, '');
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json?.message || `HTTP ${res.status}` };
    return {
      ok: true,
      client_id: json.client_id,
      login: json.login,
      user_id: json.user_id,
      scopes: Array.isArray(json.scopes) ? json.scopes : [],
      expires_in: json.expires_in,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

ipcMain.handle('auth:status', async () => {
  const cfg = loadConfig();
  const required = ['chat:read', 'chat:edit', 'channel:read:redemptions'];
  const token = await validateToken(cfg.TWITCH_OAUTH);
  function assess(v, required) {
    if (!v.ok) return { present: !!cfg.TWITCH_OAUTH, valid: false, missing: required };
    const scopes = new Set(v.scopes || []);
    const missing = required.filter(s => !scopes.has(s));
    return { present: true, valid: missing.length === 0, missing, info: v };
  }
  return assess(token, required);
});

function buildMenu() {
  const template = [
    {
      label: 'View',
      submenu: [
        {
          label: 'Dark Mode',
          type: 'checkbox',
          checked: currentTheme === 'dark',
          click: (item) => {
            currentTheme = item.checked ? 'dark' : 'light';
            const cfg = loadConfig();
            saveConfig({ ...cfg, theme: currentTheme });
            mainWindow?.webContents.send('theme:changed', currentTheme);
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggledevtools' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

process.on('uncaughtException', (e) => logStartup('UncaughtException', e));
process.on('unhandledRejection', (e) => logStartup('UnhandledRejection', e));
