#!/usr/bin/env node
// Push edge function secrets from .env to Supabase
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');

// Only these keys are pushed as edge function secrets
const SECRET_KEYS = [
  'META_WHATSAPP_TOKEN',
  'META_WHATSAPP_PHONE_NUMBER_ID',
  'WEBHOOK_VERIFY_TOKEN',
  'META_WHATSAPP_API_VERSION',
  'META_GRAPH_BASE_URL',
  'GEMINI_PRIMARY_KEY',
  'GEMINI_FALLBACK_ONE',
  'GEMINI_FALLBACK_TWO',
  'GEMINI_MODEL',
];

const envContent = readFileSync(envPath, 'utf-8');
const envVars = {};

for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const value = trimmed.slice(eqIdx + 1).trim();
  envVars[key] = value;
}

const accessToken = envVars.SUPABASE_ACCESS_TOKEN;
if (!accessToken) {
  console.error('Error: SUPABASE_ACCESS_TOKEN not found in .env');
  process.exit(1);
}

const pairs = SECRET_KEYS.filter((key) => {
  if (!envVars[key]) {
    console.warn(`Warning: ${key} not found in .env, skipping`);
    return false;
  }
  return true;
}).map((key) => `${key}=${envVars[key]}`);

if (pairs.length === 0) {
  console.error('No secrets to push.');
  process.exit(1);
}

console.log(`Pushing ${pairs.length} secrets to Supabase...`);

const cmd = `npx supabase secrets set ${pairs.map((p) => `"${p}"`).join(' ')}`;

try {
  execSync(cmd, {
    stdio: 'inherit',
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken },
    cwd: resolve(__dirname, '..'),
  });
  console.log('Secrets updated successfully!');
} catch (err) {
  console.error('Failed to push secrets:', err.message);
  process.exit(1);
}
