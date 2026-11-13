// GBS_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node scripts/testing/preview-share-regression.mjs
// Optional GBS_QA_HEADED=1, GBS_CHROME_EXECUTABLE, GBS_QA_ARTIFACTS=/directory.
// Starts only disposable servers and intercepts every chat send before delivery.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PREVIEW_SIZE_PRESETS } from '../../src/lib/previewSizes.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.GBS_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.GBS_PLAYWRIGHT_MODULE).href : 'playwright-core');
const temp = mkdtempSync(join(tmpdir(), 'gbs-preview-share-')), data = join(temp, 'data'), project = join(temp, 'project');
mkdirSync(data); mkdirSync(project);
writeFileSync(join(data, 'config.json'), JSON.stringify({ profile: { name: 'Preview QA', email: '' }, instances: { ghost: { driver: 'not-a-real-driver', displayName: 'QA — no AI' } } }));
writeFileSync(join(project, 'sample.md'), '# Markdown Heading\n\n## Smaller Heading\n\nParagraph with **bold text**.\n\n| Column | Value |\n|---|---|\n| First | Second |\n\n' + 'Wrapping document text. '.repeat(200));
writeFileSync(join(project, 'sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
const children = []; let browser; let logs = '';
async function port() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const serverPort = await port(), uiPort = await port(), api = `http://127.0.0.1:${serverPort}`, ui = `http://127.0.0.1:${uiPort}`;
const env = { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, GBS_DATA_DIR: data, GBS_PROJECTS_FILE: join(data, 'projects.json'), GBS_PORT: String(serverPort) };
function start(args) { const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); child.stderr.on('data', b => { logs = (logs + b).slice(-8000); }); }
async function until(read, valid) { const end = Date.now() + 20000; for (;;) { const value = await read().catch(() => null); if (valid(value)) return value; if (Date.now() > end) throw Error(logs || 'Timed out waiting for QA state'); await new Promise(r => setTimeout(r, 50)); } }
async function stop(child) { if (child.exitCode !== null) return; await new Promise(r => { const t = setTimeout(() => child.kill('SIGKILL'), 3000); t.unref(); child.once('close', () => { clearTimeout(t); r(); }); child.kill('SIGTERM'); }); }
try {
  start(['server/index.ts']); start(['node_modules/vite/bin/vite.js', '--port', String(uiPort), '--strictPort']);
  await until(() => fetch(api + '/api/health'), r => r?.ok); await until(() => fetch(ui), r => r?.ok);
  const registered = await fetch(api + '/api/projects/add-existing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectPath: project }) }).then(r => r.json());
  browser = await chromium.launch({ executablePath: process.env.GBS_CHROME_EXECUTABLE ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), headless: process.env.GBS_QA_HEADED !== '1' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }); page.setDefaultTimeout(15000);
  const sends = [];
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.protocol.startsWith('http') && url.origin !== ui) return route.abort();
    if (request.method() === 'POST' && /\/api\/(bots|groups)\/[^/]+\/messages$/.test(url.pathname)) { sends.push(request.postDataJSON()); return route.fulfill({ status: 202, json: { ok: true } }); }
    return route.continue();
  });
  const source = type => ({ kind: 'file', projectId: registered.project.id, filePath: `sample.${type === 'markdown' ? 'md' : 'png'}`, fileType: type });
  async function open(type, mode = 'canvas') {
    await page.goto(ui);
    await page.evaluate(({ source, presets, mode }) => {
      localStorage.setItem('gbs-email-gate', 'skipped');
      localStorage.setItem('gbs-preview-studio-state-v1', JSON.stringify({ source, input: source.filePath, mode, selectedSizeIds: presets.map(p => p.id), presetId: presets[0].id, autoRefresh: false, zoom: 'fit', rotatedById: {} }));
    }, { source: source(type), presets: PREVIEW_SIZE_PRESETS, mode });
    await page.reload(); await page.getByRole('button', { name: 'Preview', exact: true }).click();
    if (type === 'markdown') await page.getByText('Markdown Heading', { exact: true }).first().waitFor();
    else await page.waitForFunction(() => [...document.querySelectorAll('main img')].some(img => img.src.includes('sample.png') && img.naturalWidth > 0));
    await page.evaluate(() => {
      window.qaExports = []; window.qaMaximumLive = 0;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      window.qaOriginalSrc = descriptor;
      Object.defineProperty(HTMLImageElement.prototype, 'src', { ...descriptor, set(value) { if (String(value).startsWith('data:image/svg+xml;')) window.qaExports.push(decodeURIComponent(String(value).split(',').slice(1).join(','))); descriptor.set.call(this, value); } });
      const count = () => {
        const sections = [...document.querySelectorAll('main section[aria-label$="pixels)"]')];
        const live = sections.filter(s => s.querySelector('.chat-md, img[src*="sample.png"], iframe, webview')).length;
        window.qaMaximumLive = Math.max(window.qaMaximumLive, live);
      };
      window.qaFrameObserver = new MutationObserver(count); window.qaFrameObserver.observe(document.body, { childList: true, subtree: true }); count();
    });
  }
  async function share(all) {
    await page.getByRole('button', { name: 'Share to chat…', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Share preview to chat' });
    if (all) await modal.getByRole('radio', { name: /All selected sizes/ }).check();
    await modal.getByRole('button', { name: /^Send to / }).click();
    return modal;
  }
  await open('markdown', 'single');
  const heading = await page.getByText('Markdown Heading', { exact: true }).evaluate(el => ({ weight: getComputedStyle(el).fontWeight, size: getComputedStyle(el).fontSize }));
  await share(false); await until(async () => sends.length, n => n === 1);
  const exported = await page.evaluate(() => {
    const doc = new DOMParser().parseFromString(window.qaExports[0], 'image/svg+xml');
    const heading = [...doc.querySelectorAll('div')].find(el => el.textContent === 'Markdown Heading');
    return { weight: heading.style.fontWeight, size: heading.style.fontSize, bold: doc.querySelector('strong').style.fontWeight, cells: doc.querySelectorAll('td, th').length, text: doc.documentElement.textContent };
  });
  assert.equal(exported.weight, heading.weight); assert.equal(exported.size, heading.size);
  assert.ok(Number(exported.weight) >= 600); assert.ok(Number(exported.bold) >= 600); assert.equal(exported.cells, 4);
  assert.ok(!exported.text.includes('# Markdown Heading') && !exported.text.includes('**bold text**'));
  console.log('PASS live DIV heading typography survives standalone export; bold/table/no-raw-syntax preserved', heading);
  if (process.env.GBS_QA_ARTIFACTS) { mkdirSync(process.env.GBS_QA_ARTIFACTS, { recursive: true }); writeFileSync(join(process.env.GBS_QA_ARTIFACTS, 'markdown.png'), Buffer.from(sends[0].attachments[0].dataUrl.split(',')[1], 'base64')); }
  for (const type of ['markdown', 'image']) {
    await open(type); const before = sends.length;
    await share(false); await until(async () => sends.length, n => n === before + 1);
    const attachments = sends.at(-1).attachments;
    assert.equal(attachments.length, 1);
    for (let i = 0; i < 1; i++) {
      const viewer = await page.locator("main [data-preview-file-viewer]").boundingBox();
      assert.ok(attachments[i].name.includes(`${Math.round(viewer.width)}x${Math.round(viewer.height)}`));
      assert.equal(attachments[i].mimeType, 'image/png'); assert.ok(attachments[i].dataUrl.startsWith('data:image/png;base64,'));
      const png = Buffer.from(attachments[i].dataUrl.split(',')[1], 'base64');
      const preset = { width: Math.round(viewer.width), height: Math.round(viewer.height) };
      const ratio = type === 'image' ? Math.min(1, 1600 / preset.width, 1200 / preset.height) : Math.min(1, 1600 / preset.width, Math.sqrt(8_000_000 / (preset.width * preset.height)));
      assert.equal(png.readUInt32BE(16), Math.round(preset.width * ratio));
      assert.equal(png.readUInt32BE(20), Math.round(preset.height * ratio));
    }
    const observed = await page.evaluate(() => ({ maximum: window.qaMaximumLive, stages: document.querySelectorAll('[data-preview-capture]').length, frames: document.querySelectorAll('iframe, webview').length }));
    assert.equal(observed.maximum, 0); assert.equal(observed.stages, 0); assert.equal(observed.frames, 0);
    console.log(`PASS ${type}: one full-screen PNG in one intercepted send, max ${observed.maximum} live cards, no extra frames or retained stages`);
  }
  // A failed full-screen capture must send nothing.
  for (const type of ['markdown', 'image']) {
    await open(type); const before = sends.length;
    await page.evaluate(() => {
      window.qaToDataURL = HTMLCanvasElement.prototype.toDataURL; let calls = 0;
      HTMLCanvasElement.prototype.toDataURL = function (...args) { if (++calls === 1) throw Error('QA final capture failed'); return window.qaToDataURL.apply(this, args); };
    });
    const modal = await share(false); await modal.getByRole('alert').waitFor();
    const error = await modal.getByRole('alert').innerText();
    assert.ok(error.includes('QA final capture failed'));
    assert.ok(!error.includes('desktop app')); assert.equal(sends.length, before);
    await page.evaluate(() => { HTMLCanvasElement.prototype.toDataURL = window.qaToDataURL; });
    assert.equal(await page.locator('[data-preview-capture]').count(), 0);
    console.log(`PASS ${type}: capture failure reports its cause, keeps the modal open and sends no partial message`);
  }
  console.log(`5 browser regressions passed on isolated ports ${serverPort}/${uiPort}; every chat send intercepted; no AI turns.`);
} finally { await browser?.close(); for (const child of children) await stop(child); rmSync(temp, { recursive: true, force: true }); }
