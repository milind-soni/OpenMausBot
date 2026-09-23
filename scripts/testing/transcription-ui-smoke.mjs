// Electron-only isolated UI + protected-storage smoke. No live settings or mic.
import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("../..", import.meta.url));
const data = mkdtempSync(path.join(os.tmpdir(), "omb-transcription-ui-"));
const evidence = process.env.OMB_VERIFY_OUTPUT;
if (!evidence) throw new Error("Set OMB_VERIFY_OUTPUT to an evidence directory.");
app.setPath("userData", data);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
let win, preview, server;
const report = { checks: [], passed: false };
const until = async predicate => {
  const end = Date.now() + 15_000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error("UI condition timed out");
};
async function main() {
try {
  await app.whenReady();
  await fs.mkdir(evidence, { recursive: true });
  let uploads = 0;
  server = createServer((req, res) => {
    if (req.url !== "/v1/audio/transcriptions" || req.method !== "POST") { res.writeHead(404).end(); return; }
    uploads++;
    req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: "Fixture transcription." })); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const { mountPreview } = await import("./preview-fixture.ts");
  preview = await mountPreview({ info: { url: apiUrl } }, { entry: "/scripts/testing/transcription-preview.tsx", route: "/__transcription.html", title: "Transcription", logLevel: "silent" });
  const require = createRequire(import.meta.url);
  const { localOnly, setLocalOrigin } = require("../../electron/local-origin.cjs");
  setLocalOrigin(new URL(preview.previewUrl).origin);
  const { registerStt } = await import("../../electron/stt-service.mjs");
  registerStt({ ipcMain, localOnly });
  win = new BrowserWindow({ show: false, width: 1000, height: 900, webPreferences: { preload: path.join(root, "electron/preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const js = source => win.webContents.executeJavaScript(source);
  const click = label => js(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)} || b.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) throw Error('No enabled button: '+${JSON.stringify(label)}); button.click(); return true; })()`);
  const change = (label, value, select = false) => js(`(() => { const el = document.querySelector('[aria-label=${JSON.stringify(label)}]'); Object.getOwnPropertyDescriptor(${select ? "HTMLSelectElement" : "HTMLInputElement"}.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('${select ? "change" : "input"}',{bubbles:true})); return true; })()`);
  const open = async () => { await click("Transcription settings"); await until(() => js("Boolean(document.querySelector('[aria-label=\"Transcription provider\"]'))")); };
  await win.loadURL(preview.previewUrl);
  await until(() => js("Boolean(document.querySelector('[aria-label=\"Transcription settings\"]'))"));
  for (const action of [
    "window.ogb.sttSave({executable:'C:/unselected/engine.exe'})",
    "window.ogb.sttInstall({id:'base',executable:'C:/unselected/engine.exe'})",
  ]) {
    const rejection = await js(`${action}.then(() => 'unexpected success', error => String(error))`);
    assert.match(rejection, /file picker/);
  }
  report.checks.push("Production IPC rejects unselected engine paths for both save and install");
  await open();
  assert.equal(await js("document.activeElement.getAttribute('role')"), "dialog");
  const height = await js("document.querySelector('[role=dialog]').getBoundingClientRect().height");
  await change("Transcription provider", "openrouter", true);
  await change("Transcription API key", "synthetic-key-never-sent");
  await click("Save"); await until(() => js("!document.querySelector('[role=dialog]')"));
  await new Promise(resolve => { win.webContents.once("did-finish-load", resolve); win.reload(); }); await until(() => js("Boolean(document.querySelector('[aria-label=\"Transcription settings\"]'))")); await open();
  assert.equal(await js("document.querySelector('[aria-label=\"Transcription provider\"]').value"), "openrouter");
  assert(await js("document.body.textContent.includes('Key saved')"));
  assert.equal(await js("document.querySelector('[aria-label=\"Transcription API key\"]').value"), "");
  const encrypted = await fs.readFile(path.join(data, "transcription/settings.enc"));
  assert(!encrypted.includes(Buffer.from("synthetic-key-never-sent")));
  await fs.writeFile(path.join(evidence, "transcription-settings.png"), (await win.webContents.capturePage()).toPNG());
  await change("Transcription provider", "whisper-local", true);
  assert.equal(await js("document.querySelector('[role=dialog]').getBoundingClientRect().height"), height);
  await change("Transcription provider", "compatible", true);
  await change("Transcription endpoint", `${apiUrl}/v1`);
  await click("Save"); await until(() => js("!document.querySelector('[role=dialog]')"));
  const { createSttSettings } = await import("../../electron/stt-settings.mjs");
  const reloaded = await createSttSettings(path.join(data, "transcription"), safeStorage).load();
  assert.equal(reloaded.profiles.openrouter.key, "synthetic-key-never-sent");
  assert.equal(reloaded.provider, "compatible");
  report.checks.push("Real safeStorage protects key; provider and saved-key state survive renderer reload", "Fixed dialog height; initial focus on panel");
  await click("Start recording");
  await until(() => js("Boolean(document.querySelector('[data-phase=recording]'))"));
  await until(() => js("document.querySelector('[data-levels]').dataset.levels.split(',').some(v => Number(v)>0)"));
  await click("Stop recording");
  await until(() => js("Boolean(document.querySelector('[data-phase=idle]'))"));
  await until(() => js("document.querySelector('textarea').value.includes('Fixture transcription.')"));
  assert(uploads > 0);
  report.checks.push("Fake microphone drives live waveform; stop flushes audio through loopback transcription service into editable draft");
  await click("Start recording"); await until(() => js("Boolean(document.querySelector('[data-phase=recording]'))"));
  await click("Switch chat"); await until(() => js("Boolean(document.querySelector('[data-phase=idle]'))"));
  assert.equal(await js("document.querySelector('textarea').value"), "");
  report.checks.push("Changing chats cancels capture and does not copy the transcript");
  report.passed = true;
} catch (error) { report.error = String(error.stack || error); if (win && !win.isDestroyed()) report.renderer = await win.webContents.executeJavaScript("document.body.innerText").catch(() => "unavailable"); }
finally {
  await fs.writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2));
  win?.destroy(); await preview?.close(); server?.close();
  await fs.rm(data, { recursive: true, force: true }).catch(() => {});
  app.exit(report.passed ? 0 : 1);
}

}
void main();
