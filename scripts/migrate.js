#!/usr/bin/env node
// Run DB schema migration against Supabase.
// Usage: node scripts/migrate.js

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Allow self-signed / expired certs on self-hosted Supabase
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // Try loading from .env manually
  const envPath = join(__dirname, '..', '.env');
  try {
    const envText = readFileSync(envPath, 'utf8');
    for (const line of envText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // ignore
  }
}

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sqlPath = join(__dirname, '..', 'db', 'schema.sql');
const sql = readFileSync(sqlPath, 'utf8');

console.log(`Running migration against ${supabaseUrl} ...`);

// Try Supabase pg endpoint paths (varies by version)
const endpoints = [
  `${supabaseUrl}/pg/v0/query`,
  `${supabaseUrl}/pg/query`,
  `${supabaseUrl}/rest/v1/rpc/exec_sql`,
];

let lastError;
for (const url of endpoints) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ query: sql }),
    });
    const text = await res.text();
    if (res.ok) {
      console.log(`Migration successful via ${url}`);
      console.log(text.slice(0, 500));
      process.exit(0);
    }
    console.warn(`${url} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    lastError = text;
  } catch (err) {
    console.warn(`${url} → fetch error: ${err.message}`);
    lastError = err.message;
  }
}

console.error('All migration endpoints failed. Last error:', lastError);
process.exit(1);
