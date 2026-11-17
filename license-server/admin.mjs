#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, 'data', 'keys.json');

function readKeys() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeKeys(keys) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(keys, null, 2), 'utf8');
}

function generateKeyString() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let part1 = '';
  let part2 = '';
  for (let i = 0; i < 4; i++) {
    part1 += chars[crypto.randomInt(chars.length)];
    part2 += chars[crypto.randomInt(chars.length)];
  }
  return `OTECH-JO-${part1}-${part2}`;
}

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === 'help') {
  console.log(`
OTECH License Admin CLI
=======================
Usage:
  node admin.mjs list                       List all licenses
  node admin.mjs gen <local|cloud> <name> <phone> <shop> [days]
                                            Generate a new license key
  node admin.mjs verify <key>               Verify a key locally
  node admin.mjs revoke <key>               Revoke a license key
`);
  process.exit(0);
}

const keys = readKeys();

if (command === 'list') {
  console.log('Registered Licenses:');
  console.table(Object.values(keys).map(k => ({
    Key: k.key,
    Plan: k.plan,
    Customer: k.customer,
    Phone: k.phone,
    Shop: k.shop,
    Expires: k.expiresAt ? k.expiresAt.slice(0, 10) : 'N/A',
    Revoked: k.revoked ? 'YES' : 'No'
  })));
  process.exit(0);
}

if (command === 'gen' || command === 'generate') {
  const plan = args[1] === 'cloud' ? 'cloud' : 'local';
  const customer = args[2] || 'عميل';
  const phone = args[3] || '';
  const shop = args[4] || '';
  const days = parseInt(args[5] || '365', 10);

  const key = generateKeyString();
  const now = new Date();
  const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  keys[key] = {
    key,
    plan,
    customer,
    phone,
    shop,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    revoked: false
  };

  writeKeys(keys);
  console.log('✅ Generated License Successfully:');
  console.log(JSON.stringify(keys[key], null, 2));
  process.exit(0);
}

if (command === 'verify') {
  const key = (args[1] || '').trim().toUpperCase();
  const entry = keys[key];
  if (!entry) {
    console.error('❌ License not found');
    process.exit(1);
  }
  const expired = new Date(entry.expiresAt) < new Date();
  console.log(`Key: ${entry.key}`);
  console.log(`Plan: ${entry.plan}`);
  console.log(`Customer: ${entry.customer}`);
  console.log(`Expires: ${entry.expiresAt} (${expired ? 'EXPIRED' : 'ACTIVE'})`);
  console.log(`Revoked: ${entry.revoked ? 'YES' : 'NO'}`);
  process.exit(0);
}

if (command === 'revoke') {
  const key = (args[1] || '').trim().toUpperCase();
  if (!keys[key]) {
    console.error('❌ Key not found');
    process.exit(1);
  }
  keys[key].revoked = true;
  keys[key].revokedAt = new Date().toISOString();
  writeKeys(keys);
  console.log(`✅ Revoked ${key} successfully`);
  process.exit(0);
}

console.error('Unknown command:', command);
process.exit(1);
