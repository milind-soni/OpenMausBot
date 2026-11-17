import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, 'data', 'keys.json');

const PORT = parseInt(process.env.PORT || '4000', 10);
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
if (!ADMIN_SECRET) {
  console.warn('WARNING: ADMIN_SECRET is not set in environment variables. Admin endpoints are disabled.');
}

function readKeys() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading keys:', err);
    return {};
  }
}

function writeKeys(keys) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(keys, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving keys:', err);
  }
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

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-secret',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function checkAdminAuth(req) {
  if (!ADMIN_SECRET) return false;
  const secretHeader = req.headers['x-admin-secret'];
  const authHeader = req.headers['authorization'];
  if (secretHeader && secretHeader === ADMIN_SECRET) return true;
  if (authHeader && authHeader.replace(/^Bearer\s+/i, '') === ADMIN_SECRET) return true;
  return false;
}

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-secret'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Health check
  if (url.pathname === '/health' || url.pathname === '/api/health') {
    sendJson(res, 200, { status: 'ok', server: 'otech-license-server', timestamp: new Date().toISOString() });
    return;
  }

  // Verify Key: GET /api/verify?key=... or POST /api/verify { key }
  if (url.pathname === '/api/verify' || url.pathname === '/verify') {
    let key = url.searchParams.get('key');
    if (!key && req.method === 'POST') {
      const body = await parseJsonBody(req);
      key = body?.key;
    }

    if (!key) {
      sendJson(res, 400, { valid: false, error: 'Key is required', reason: 'missing_key' });
      return;
    }

    key = key.trim().toUpperCase();
    const keys = readKeys();
    const entry = keys[key];

    if (!entry) {
      sendJson(res, 200, { valid: false, error: 'License key not found', reason: 'not_found' });
      return;
    }

    if (entry.revoked) {
      sendJson(res, 200, { valid: false, error: 'License key has been revoked', reason: 'revoked' });
      return;
    }

    const now = new Date();
    const expiresAt = new Date(entry.expiresAt);
    if (expiresAt < now) {
      sendJson(res, 200, {
        valid: false,
        error: 'License key has expired',
        reason: 'expired',
        plan: entry.plan,
        customer: entry.customer,
        phone: entry.phone,
        expiresAt: entry.expiresAt
      });
      return;
    }

    sendJson(res, 200, {
      valid: true,
      key: entry.key,
      plan: entry.plan || 'local',
      customer: entry.customer,
      phone: entry.phone,
      shop: entry.shop,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      serverTime: now.toISOString()
    });
    return;
  }

  // Admin: List Keys: GET /api/list-keys
  if (url.pathname === '/api/list-keys' || url.pathname === '/list-keys') {
    if (!checkAdminAuth(req)) {
      sendJson(res, 401, { error: 'Unauthorized: Invalid Admin Secret' });
      return;
    }
    const keys = readKeys();
    sendJson(res, 200, { keys: Object.values(keys) });
    return;
  }

  // Admin: Generate Key: POST /api/generate-key
  if (url.pathname === '/api/generate-key' || url.pathname === '/generate-key') {
    if (!checkAdminAuth(req)) {
      sendJson(res, 401, { error: 'Unauthorized: Invalid Admin Secret' });
      return;
    }

    const body = await parseJsonBody(req);
    const plan = (body?.plan === 'cloud') ? 'cloud' : 'local';
    const customer = body?.customer || 'عميل';
    const phone = body?.phone || '';
    const shop = body?.shop || '';
    const days = parseInt(body?.durationDays || '30', 10);

    const key = body?.key ? body.key.trim().toUpperCase() : generateKeyString();
    const now = new Date();
    const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const keys = readKeys();
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
    sendJson(res, 201, { success: true, license: keys[key] });
    return;
  }

  // Admin: Revoke Key: POST /api/revoke-key
  if (url.pathname === '/api/revoke-key' || url.pathname === '/revoke-key') {
    if (!checkAdminAuth(req)) {
      sendJson(res, 401, { error: 'Unauthorized: Invalid Admin Secret' });
      return;
    }

    const body = await parseJsonBody(req);
    const key = body?.key?.trim()?.toUpperCase();
    if (!key) {
      sendJson(res, 400, { error: 'Key is required' });
      return;
    }

    const keys = readKeys();
    if (!keys[key]) {
      sendJson(res, 404, { error: 'Key not found' });
      return;
    }

    keys[key].revoked = true;
    keys[key].revokedAt = new Date().toISOString();
    writeKeys(keys);

    sendJson(res, 200, { success: true, message: `Key ${key} revoked successfully`, license: keys[key] });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OTECH License Server running at http://0.0.0.0:${PORT}`);
  console.log(`Data stored in: ${DATA_FILE}`);
});
