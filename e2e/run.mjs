import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const data = resolve('.origin-data-e2e');
await mkdir(data, { recursive: true });
// Never attach this harness to a cloud backend or borrow another checkout's servers.
for (const source of [process.env, existsSync('.env.local') ? Object.fromEntries((await readFile('.env.local', 'utf8')).split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).split(' #')[0].trim()])) : {}]) {
  assert.ok(!source.CONVEX_DEPLOY_KEY, 'Remove CONVEX_DEPLOY_KEY before E2E');
  assert.ok(!source.CONVEX_DEPLOYMENT || /^(anonymous|local):/.test(source.CONVEX_DEPLOYMENT), 'E2E requires an anonymous/local deployment');
  for (const key of ['NEXT_PUBLIC_CONVEX_URL', 'NEXT_PUBLIC_CONVEX_SITE_URL']) if (source[key]) {
    const url = new URL(source[key]);
    assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `${key} must be HTTP loopback`);
  }
}
let lock;
try { lock = await open(`${data}/runner.lock`, 'wx'); }
catch { throw new Error('E2E already owns this checkout (runner.lock). Use a separate worktree for simultaneous runs. Remove a stale lock only after checking its PID.'); }
await lock.writeFile(String(process.pid));
const children = new Set();
let stopping = false;
async function terminate(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') await new Promise(r => { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('exit', r); });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
}
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of [...children].reverse()) {
    await terminate(child);
  }
  await lock.close();
  await rm(`${data}/runner.lock`, { force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop().then(() => process.exit(130)));
function launch(script, args, log) {
  const child = spawn(process.execPath, [script, ...args], { env: process.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const stream = createWriteStream(`${data}/${log}.log`, { flags: 'w' });
  child.stdout.pipe(stream); child.stderr.pipe(stream);
  child.on('error', e => stream.write(String(e)));
  children.add(child);
  return child;
}
async function command(script, args, name) {
  console.log(`E2E: ${name}`);
  const child = launch(script, args, name);
  if (['backend', 'playwright'].includes(name)) { child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); }
  const code = await new Promise((r, reject) => {
    const timeout = setTimeout(() => void terminate(child).then(() => reject(new Error(`${name} exceeded its time budget; inspect .origin-data-e2e/${name}.log`))), name === 'playwright' ? 660000 : 180000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', value => { clearTimeout(timeout); r(value); });
  });
  if (code !== 0) throw new Error(`${name} exited ${code}; see .origin-data-e2e/${name}.log`);
}
async function port() {
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const value = server.address().port; await new Promise(r => server.close(r)); return value;
}
async function ready(url, child, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode} before ${url}; inspect .origin-data-e2e logs`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(5000) })).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
try {
  // A parent terminal may belong to a different local worktree. Load this one's
  // selection afresh after bootstrap rather than inheriting those loopback URLs.
  for (const key of ['CONVEX_DEPLOYMENT', 'NEXT_PUBLIC_CONVEX_URL', 'NEXT_PUBLIC_CONVEX_SITE_URL', 'ORIGIN_INTEGRATION_SECRET']) delete process.env[key];
  process.env.CONVEX_AGENT_MODE = 'anonymous';
  const { chromium } = await import('@playwright/test');
  if (!existsSync(chromium.executablePath())) await command(resolve('node_modules/@playwright/test/cli.js'), ['install', 'chromium'], 'browser');
  const convex = resolve('node_modules/convex/bin/main.js');
  const ports = existsSync('.env.local') ? [] : ['--local-cloud-port', String(await port()), '--local-site-port', String(await port())];
  await command(convex, ['dev', '--once', ...ports], 'bootstrap');
  process.loadEnvFile('.env.local');
  const watcher = launch(convex, ['dev', '--tail-logs', 'disable'], 'convex');
  await ready(`${process.env.NEXT_PUBLIC_CONVEX_URL}/version`, watcher);
  process.env.ORIGIN_INTEGRATION_SECRET = randomBytes(32).toString('hex');
  const secretFile = `${data}/integration.env`;
  // The local deployment seals integration secrets (MCP OAuth, GitHub) with ORIGIN_SEALING_KEY. Keep an existing key so
  // data sealed by earlier runs stays readable; create one only on a fresh deployment.
  let sealing = '';
  try { sealing = execFileSync(process.execPath, [convex, 'env', 'get', 'ORIGIN_SEALING_KEY'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not set yet */ }
  await writeFile(secretFile, `ORIGIN_INTEGRATION_SECRET=${process.env.ORIGIN_INTEGRATION_SECRET}\n${sealing ? '' : `ORIGIN_SEALING_KEY=${randomBytes(32).toString('base64')}\n`}`, { mode: 0o600 });
  await command(convex, ['env', 'set', '--from-file', secretFile, '--force'], 'integration');
  await rm(secretFile, { force: true });
  process.env.ORIGIN_E2E_APP_URL = `http://127.0.0.1:${process.env.ORIGIN_E2E_PORT || await port()}`;
  process.env.ORIGIN_PUBLIC_URL = process.env.ORIGIN_SITE_URL = process.env.ORIGIN_E2E_APP_URL;
  // Deliberately no GitHub/SMTP/model credentials. The fixtures use only local transports.
  const next = resolve('node_modules/next/dist/bin/next');
  const development = process.env.ORIGIN_E2E_DEV === '1';
  if (!development) await command(next, ['build', '--webpack'], 'build');
  const app = launch(next, [development ? 'dev' : 'start', ...(development ? ['--webpack'] : []), '--hostname', '127.0.0.1', '--port', new URL(process.env.ORIGIN_E2E_APP_URL).port], 'next');
  await ready(`${process.env.ORIGIN_E2E_APP_URL}/login`, app);
  let failures = 0;
  for (const [script, args, name] of [
    [resolve('node_modules/@playwright/test/cli.js'), ['test', '--config=e2e/playwright.config.mjs', ...process.argv.slice(2)], 'playwright'],
  ]) try { await command(script, args, name); } catch (e) { failures++; console.error(e.message); }
  process.exitCode = failures ? 1 : 0;
  console.log(`E2E: ${failures ? 'FAILED' : 'PASSED'}; browser report: playwright-report/index.html; server logs: .origin-data-e2e/`);
} catch (e) { console.error(e); process.exitCode = 1; }
finally { await stop(); }
