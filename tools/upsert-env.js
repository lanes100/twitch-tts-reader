// tools/upsert-env.js
// Usage: node tools/upsert-env.js KEY=VALUE KEY2=VALUE2 ...
const fs = require('fs');
const path = require('path');

function upsertEnv(vars) {
  const envPath = path.resolve(process.cwd(), '.env');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
  const lines = content.split(/\r?\n/);
  for (const [key, value] of Object.entries(vars)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) content = content.replace(re, `${key}=${value}`);
    else { lines.push(`${key}=${value}`); content = lines.filter(Boolean).join('\n') + '\n'; }
  }
  fs.writeFileSync(envPath, content, 'utf8');
}

const pairs = process.argv.slice(2);
const vars = {};
for (const p of pairs) {
  const idx = p.indexOf('=');
  if (idx === -1) continue;
  const k = p.slice(0, idx);
  const v = p.slice(idx + 1);
  vars[k] = v;
}
if (Object.keys(vars).length) upsertEnv(vars);
console.log('Updated .env keys:', Object.keys(vars).join(', '));

