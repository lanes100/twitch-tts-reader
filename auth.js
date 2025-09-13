// auth.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2 (CJS)
const express = require('express');
const { exec } = require('child_process');
// 'open' v9 is ESM-only; use dynamic import when needed

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_SCOPES = 'chat:read chat:edit',
  TWITCH_REDIRECT_URL = 'http://localhost:5173/callback',
} = process.env;

const WRITE_ENV_FILE = (process.env.WRITE_ENV_FILE || 'true').toLowerCase() !== 'false';

if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
  console.error('Please set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env');
  process.exit(1);
}

const PORT = new URL(TWITCH_REDIRECT_URL).port || 5173;
const CALLBACK_PATH = new URL(TWITCH_REDIRECT_URL).pathname || '/callback';

function upsertEnv(vars) {
  if (!WRITE_ENV_FILE) return; // Respect no-write mode
  const envPath = path.resolve(process.cwd(), '.env');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch { /* new file */ }
  const lines = content.split(/\r?\n/);

  Object.entries(vars).forEach(([key, value]) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      // replace existing
      content = content.replace(re, `${key}=${value}`);
    } else {
      // append
      lines.push(`${key}=${value}`);
      content = lines.filter(Boolean).join('\n') + '\n';
    }
  });

  fs.writeFileSync(envPath, content, 'utf8');
  console.log('Updated .env with:', Object.keys(vars).join(', '));
}

function execPromise(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' });
    });
  });
}

async function findPidsOnPort(port) {
  const platform = process.platform;
  if (platform === 'win32') {
    const { stdout } = await execPromise(`netstat -ano -p tcp | findstr :${port}`);
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const pids = new Set();
    for (const line of lines) {
      // Example:  TCP    0.0.0.0:5173         0.0.0.0:0              LISTENING       12952
      const parts = line.trim().split(/\s+/);
      const hasPort = parts.some(p => p.endsWith(`:${port}`));
      const isListening = parts.includes('LISTENING');
      const pid = parts[parts.length - 1];
      if (hasPort && isListening && /^\d+$/.test(pid)) pids.add(pid);
    }
    return Array.from(pids);
  }
  // macOS/Linux
  const { stdout } = await execPromise(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`);
  return stdout.split(/\r?\n/).map(s => s.trim()).filter(s => s);
}

async function ensurePortFree(port) {
  try {
    const pids = await findPidsOnPort(port);
    if (!pids.length) return;
    console.warn(`Port ${port} is in use by PID(s): ${pids.join(', ')} — attempting to terminate.`);
    if (process.platform === 'win32') {
      for (const pid of pids) {
        await execPromise(`taskkill /PID ${pid} /F`);
      }
    } else {
      for (const pid of pids) {
        await execPromise(`kill -9 ${pid}`);
      }
    }
    // small delay to allow OS to release
    await new Promise(r => setTimeout(r, 250));
  } catch (e) {
    console.warn(`Failed to ensure port ${port} is free: ${e?.message || e}`);
  }
}

async function exchangeCodeForTokens(code) {
  const url = 'https://id.twitch.tv/oauth2/token';
  const params = new URLSearchParams();
  params.set('client_id', TWITCH_CLIENT_ID);
  params.set('client_secret', TWITCH_CLIENT_SECRET);
  params.set('code', code);
  params.set('grant_type', 'authorization_code');
  params.set('redirect_uri', TWITCH_REDIRECT_URL);

  const res = await fetch(url, { method: 'POST', body: params });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}): ${txt}`);
    }
  return res.json();
}

async function start() {
  const app = express();

  app.get(CALLBACK_PATH, async (req, res) => {
    const { code, error, error_description } = req.query;
    if (error) {
      res.status(400).send(`<h3>Twitch error</h3><pre>${error}: ${error_description || ''}</pre>`);
      console.error('OAuth error:', error, error_description);
      return;
    }
    if (!code) {
      res.status(400).send('<h3>Missing ?code in callback</h3>');
      return;
    }

    try {
      const data = await exchangeCodeForTokens(code);
      const access = data.access_token;
      const refresh = data.refresh_token;

      // Write tokens to .env
      const vars = {
        TWITCH_OAUTH: `oauth:${access}`,
        TWITCH_REFRESH_TOKEN: refresh || '',
      };
      // Always set in-memory values for this process
      process.env.TWITCH_OAUTH = vars.TWITCH_OAUTH;
      process.env.TWITCH_REFRESH_TOKEN = vars.TWITCH_REFRESH_TOKEN;

      upsertEnv(vars);

      if (WRITE_ENV_FILE) {
        res.send(`<h2>Success!</h2><p>Your token was saved to <code>.env</code>.</p>
          <p>You can close this tab and run your bot.</p>`);
        console.log('Got access token and refresh token. Saved to .env.');
      } else {
        res.send(`<h2>Success!</h2>
          <p>WRITE_ENV_FILE=false — not writing secrets to <code>.env</code>.</p>
          <p>Please set <code>TWITCH_OAUTH</code> and <code>TWITCH_REFRESH_TOKEN</code> in your OS environment.</p>`);
        console.log('Got access+refresh. Skipped .env write due to WRITE_ENV_FILE=false.');
      }
    } catch (e) {
      console.error(e);
      res.status(500).send(`<h3>Exchange failed</h3><pre>${String(e.message || e)}</pre>`);
    } finally {
      // Give the browser a moment, then stop the server
      setTimeout(() => process.exit(0), 500);
    }
  });

  await ensurePortFree(PORT);

  const server = app.listen(PORT, () => {
    // Build authorize URL
    const auth = new URL('https://id.twitch.tv/oauth2/authorize');
    auth.searchParams.set('client_id', TWITCH_CLIENT_ID);
    auth.searchParams.set('redirect_uri', TWITCH_REDIRECT_URL);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', TWITCH_SCOPES); // space-separated
    console.log('Opening browser for Twitch consent...');
    (async () => {
      try {
        const { default: open } = await import('open');
        await open(auth.toString());
      } catch (e) {
        console.warn('Could not open browser automatically. Visit this URL:', auth.toString());
      }
    })();
  });

  // Safety: close on Ctrl+C
  process.on('SIGINT', () => { server.close(() => process.exit(0)); });
}

start().catch(err => {
  console.error(err);
  process.exit(1);
});
