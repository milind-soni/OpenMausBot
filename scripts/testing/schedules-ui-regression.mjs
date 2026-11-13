// Isolated browser regressions; no real AI apps, credentials or model turns.
// Reuse an installed playwright-core (no dependency installation):
// GBS_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node scripts/testing/schedules-ui-regression.mjs
// Optional: GBS_CHROME_EXECUTABLE, GBS_QA_HEADED=1.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const playwrightModule = process.env.GBS_PLAYWRIGHT_MODULE;
const { chromium } = await import(playwrightModule ? pathToFileURL(playwrightModule).href : 'playwright-core');
const temp = mkdtempSync(join(tmpdir(), 'gbs-schedule-ui-'));
const data = join(temp, 'data'); mkdirSync(data);
writeFileSync(join(data, 'config.json'), JSON.stringify({ profile: { name: 'Schedule QA', email: '' }, instances: { ghost: { driver: 'not-a-real-driver', displayName: 'QA — unavailable engine' } } }));
const children = []; let browser; let stderr = '';
async function freePort() {
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; await new Promise(r => server.close(r)); return port;
}
async function until(read, valid, label) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const result = await read().catch(() => null); if (valid(result)) return result;
    if (Date.now() > deadline) throw new Error(`${label}: ${stderr.slice(-1500)}`);
    await new Promise(r => setTimeout(r, 50));
  }
}
const apiPort = await freePort(), uiPort = await freePort();
const env = { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, GBS_DATA_DIR: data, GBS_PROJECTS_FILE: join(data, 'projects.json'), GBS_PORT: String(apiPort) };
const apiBase = `http://127.0.0.1:${apiPort}`, uiBase = `http://127.0.0.1:${uiPort}`;
async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 3000); timer.unref(); child.once('close', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); });
}
function start(args) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); child.stderr.on('data', b => { stderr = (stderr + b).slice(-8000); }); return child;
}
async function api(path, method = 'GET', body) {
  const r = await fetch(apiBase + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  assert.ok(r.ok, `${method} ${path}: ${r.status}`); return r.json();
}
let checks = 0;
const passed = name => { checks++; console.log(`PASS ${name}`); };
try {
  let harness = start(['server/index.ts']);
  await until(() => fetch(apiBase + '/api/health'), r => r?.ok, 'harness ready');
  const { bots } = await api('/api/bots'); const botA = bots.find(b => b.name === 'SoSo'), botB = bots.find(b => b.name === 'Marty');
  const { group } = await api('/api/groups', 'POST', { name: 'QA recovery room', memberIds: [botA.id] });
  await stop(harness);
  // Seed future retries only after the server exits; no live schedule file edits.
  const seed = `import {ScheduleStore} from ${JSON.stringify(pathToFileURL(join(root, 'server/schedules.ts')).href)}; const store=new ScheduleStore(${JSON.stringify(data)}); for(const item of ${JSON.stringify([{ target: { botId: botA.id }, threadId: botA.threadId, botId: botA.id }, { target: { groupId: group.id }, threadId: group.threadId, botId: botA.id }])}) store.upsertResume(item.target,{botId:item.botId,threadId:item.threadId,userMessageId:'qa-request',request:'Disposable retry',attempt:0});`;
  const seeder = spawn(process.execPath, ['--input-type=module', '-e', seed], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let seedError = ''; seeder.stderr.on('data', b => { seedError += b; });
  assert.equal(await new Promise(r => seeder.once('close', r)), 0, seedError);
  harness = start(['server/index.ts']); start(['node_modules/vite/bin/vite.js', '--port', String(uiPort), '--strictPort']);
  await until(() => fetch(apiBase + '/api/health'), r => r?.ok, 'restarted harness ready');
  await until(() => fetch(uiBase), r => r?.ok, 'UI ready');
  const executablePath = process.env.GBS_CHROME_EXECUTABLE ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: process.env.GBS_QA_HEADED !== '1' });
  const page = await browser.newPage({ viewport: { width: 1024, height: 1000 } }); page.setDefaultTimeout(8000);
  await page.addInitScript(() => localStorage.setItem('gbs-email-gate', 'skipped'));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol.startsWith('http') && url.origin !== uiBase) return route.abort();
    if (route.request().method() === 'POST' && /\/api\/(bots|groups)\/[^/]+\/messages/.test(url.pathname)) throw new Error('Regression tried to start a model turn');
    return route.continue();
  });
  await page.goto(uiBase);
  const selectChat = name => page.getByRole('button', { name: new RegExp(`^${name}(?: |$)`) }).first().click();
  await selectChat('SoSo');
  const draft = page.getByRole('textbox', { name: 'Message SoSo', exact: true }); await draft.fill('Preserve this unscheduled draft');
  await page.getByRole('button', { name: 'Send later…', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New schedule' }); await sheet.waitFor();
  assert.ok(await sheet.evaluate(el => el.contains(document.activeElement)));
  let releaseSave; const saveReached = new Promise(resolve => { releaseSave = resolve; });
  let rejectSave; const finishSave = new Promise(resolve => { rejectSave = resolve; });
  await page.route('**/api/schedules', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    releaseSave(); await finishSave; await route.fulfill({ status: 400, json: { error: 'QA rejected schedule' } });
  });
  await sheet.getByRole('button', { name: 'Schedule run', exact: true }).click(); await saveReached;
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement));
  await page.keyboard.press('Escape'); assert.equal(await sheet.count(), 1); // pending save cannot be dismissed
  rejectSave(); await sheet.getByRole('alert').waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'alert');
  passed('failed save restores focus to its error inside the sheet');
  const first = sheet.getByRole('combobox', { name: 'Who should work on this?' });
  await first.focus(); await page.keyboard.press('Shift+Tab');
  assert.equal(await sheet.getByRole('button', { name: 'Schedule run', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Tab'); assert.equal(await first.evaluate(el => el === document.activeElement), true);
  passed('Tab and Shift+Tab wrap after save failure');
  await page.keyboard.press('Escape'); await sheet.waitFor({ state: 'detached' });
  assert.equal(await draft.inputValue(), 'Preserve this unscheduled draft');
  assert.equal(await page.getByRole('button', { name: 'Send later…', exact: true }).evaluate(el => el === document.activeElement), true);
  passed('Escape closes failed sheet, restores trigger focus and preserves draft');
  // Verify failure fallback even if a browser/extension moves focus outside.
  await page.getByRole('button', { name: 'Send later…', exact: true }).click();
  await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
  await page.keyboard.press('Escape'); await sheet.waitFor({ state: 'detached' });
  passed('Escape still reaches the sheet after outside focus loss');
  const snapshot = await api('/api/schedules');
  const retryA = snapshot.schedules.find(s => s.resume?.threadId === botA.threadId), retryRoom = snapshot.schedules.find(s => s.resume?.threadId === group.threadId);
  const notice = () => page.getByRole('status').filter({ hasText: 'Usage ran out.' });
  await notice().getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByText('Automatic resume cancelled.', { exact: true }).waitFor();
  assert.equal((await api('/api/schedules')).schedules.some(s => s.id === retryA.id), false);
  await selectChat('Marty'); assert.equal(await page.getByText('Automatic resume cancelled.', { exact: true }).count(), 0);
  await selectChat('SoSo'); assert.equal(await page.getByText('Automatic resume cancelled.', { exact: true }).count(), 0);
  passed('cancel confirmation stays in its conversation and resets on navigation');
  await selectChat('QA recovery room');
  let mode = 'fail', releaseAction, reachedAction;
  const actionReached = () => new Promise(resolve => { reachedAction = resolve; });
  let waiting = actionReached();
  await page.route(`**/api/schedules/${retryRoom.id}/run-now`, async route => {
    const outcome = mode; reachedAction();
    if (outcome.startsWith('late')) await new Promise(resolve => { releaseAction = resolve; });
    await route.fulfill({ status: outcome.endsWith('success') ? 202 : 400, json: outcome.endsWith('success') ? { ok: true } : { error: 'QA rejected retry' } });
  });
  await notice().getByRole('button', { name: 'Resume now', exact: true }).click(); await waiting;
  await page.getByRole('alert').filter({ hasText: 'Couldn’t update this retry.' }).waitFor();
  await selectChat('Marty'); assert.equal(await page.getByText('Couldn’t update this retry. Try again.', { exact: true }).count(), 0);
  await selectChat('QA recovery room'); assert.equal(await page.getByText('Couldn’t update this retry. Try again.', { exact: true }).count(), 0);
  passed('retry error is isolated between room and bot conversations');
  for (const outcome of ['late-success', 'late-error']) {
    mode = outcome; waiting = actionReached();
    await notice().getByRole('button', { name: 'Resume now', exact: true }).click(); await waiting;
    await selectChat('Marty');
    const response = page.waitForResponse(r => r.url().endsWith(`/api/schedules/${retryRoom.id}/run-now`));
    releaseAction(); const finished = await response; await finished.finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByText('The retry will start when the bot is free.', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Couldn’t update this retry. Try again.', { exact: true }).count(), 0);
    await selectChat('QA recovery room'); // also catches navigate-away-and-back races
    assert.equal(await page.getByText('The retry will start when the bot is free.', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Couldn’t update this retry. Try again.', { exact: true }).count(), 0);
    assert.equal(await notice().getByRole('button', { name: 'Resume now', exact: true }).isEnabled(), true);
    passed(`${outcome} completion cannot update a different or remounted conversation`);
  }
  console.log(`${checks} browser regressions passed; isolated ports ${apiPort}/${uiPort}; no model turns.`);
} finally {
  await browser?.close();
  for (const child of children) await stop(child);
  rmSync(temp, { recursive: true, force: true });
}
