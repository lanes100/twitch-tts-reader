// Electron main process for Twitch TTS Reader
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const fetch = require('node-fetch');
const { spawn } = require('child_process');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

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

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
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
  await mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
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
    // Pass through everything else from cfg
    ...merged,
    // But enforce normalized connection fields
    TWITCH_USERNAME: envUser,
    TWITCH_CHANNEL: envChannel,
    TWITCH_OAUTH: envPass,
  };
  botChild = spawn(process.execPath, [path.join(process.cwd(), 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  mainWindow?.webContents.send('bot:started');
  botChild.stdout.on('data', d => mainWindow?.webContents.send('bot:log', d.toString()));
  botChild.stderr.on('data', d => mainWindow?.webContents.send('bot:log', d.toString()));
  botChild.on('exit', (code) => { mainWindow?.webContents.send('bot:exit', code); botChild = null; });
}

function stopBot() {
  if (!botChild) return;
  try { botChild.kill('SIGINT'); } catch {}
}

app.whenReady().then(createWindow);

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
ipcMain.handle('bot:start', async (_e, cfg) => { startBot(cfg); return true; });
ipcMain.handle('bot:stop', async () => { stopBot(); return true; });
ipcMain.handle('bot:status', async () => !!botChild);

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
