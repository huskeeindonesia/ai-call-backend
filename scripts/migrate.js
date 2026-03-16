// Allow expired/self-signed certs on the local Supabase instance
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
dotenv.config();

const __dir = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dir, '../db/schema.sql'), 'utf8');

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !key) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

// Supabase self-hosted: pg-meta is at /pg/v0/query
// Supabase cloud:       pg-meta is at /pg/v0/query on the project ref endpoint
const endpoint = `${supabaseUrl}/pg/v0/query`;

console.log(`Connecting to: ${supabaseUrl}\n`);

// Try pg-meta endpoints in order
const endpoints = [
  { url: `${supabaseUrl}/pg/v0/query`,   body: JSON.stringify({ query: sql }) },
  { url: `${supabaseUrl}/pg/query`,      body: JSON.stringify({ query: sql }) },
];

let succeeded = false;
for (const ep of endpoints) {
  console.log(`Trying: ${ep.url}`);
  let res;
  try {
    res = await fetch(ep.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'x-pg-search-path': 'public',
      },
      body: ep.body,
    });
  } catch (err) {
    console.error(`  network error: ${err.message}`);
    continue;
  }

  const text = await res.text();
  console.log(`  HTTP ${res.status}: ${text.slice(0, 300)}`);

  if (res.ok) {
    console.log('\n✅ Schema applied successfully.');
    succeeded = true;
    break;
  }
}

if (!succeeded) {
  console.log('\n⚠️  pg-meta not reachable. Run the SQL manually in Supabase Studio:');
  console.log(`  ${supabaseUrl}/project/default/sql\n`);
  console.log('--- SQL to run ---');
  console.log(sql);
  process.exit(1);
}
