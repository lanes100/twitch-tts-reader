// refresh.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_REFRESH_TOKEN,
} = process.env;

if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !TWITCH_REFRESH_TOKEN) {
  console.error('Need TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_REFRESH_TOKEN in .env');
  process.exit(1);
}

const WRITE_ENV_FILE = (process.env.WRITE_ENV_FILE || 'true').toLowerCase() !== 'false';

function upsertEnv(vars) {
  if (!WRITE_ENV_FILE) return; // Respect no-write mode
  const envPath = path.resolve(process.cwd(), '.env');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch { /* new file */ }
  const lines = content.split(/\r?\n/);

  Object.entries(vars).forEach(([key, value]) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`);
    } else {
      lines.push(`${key}=${value}`);
      content = lines.filter(Boolean).join('\n') + '\n';
    }
  });

  fs.writeFileSync(envPath, content, 'utf8');
  console.log('Updated .env with:', Object.keys(vars).join(', '));
}

async function refresh() {
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
  const refreshToken = data.refresh_token || TWITCH_REFRESH_TOKEN;

  upsertEnv({
    TWITCH_OAUTH: `oauth:${access}`,
    TWITCH_REFRESH_TOKEN: refreshToken,
  });

  // Always set in-memory for this process
  process.env.TWITCH_OAUTH = `oauth:${access}`;
  process.env.TWITCH_REFRESH_TOKEN = refreshToken;

  if (WRITE_ENV_FILE) {
    console.log('Refreshed token OK (saved to .env).');
  } else {
    console.log('Refreshed token OK (skipped .env write; set env vars in your OS).');
  }
}

refresh().catch(err => {
  console.error(err);
  process.exit(1);
});
