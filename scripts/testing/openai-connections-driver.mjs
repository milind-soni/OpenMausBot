// Electron renderer driver for verify-openai-connections.ts; never loads the app preload.
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, session } from "electron";

const [url, output, providerBase] = process.argv.slice(2);
const home = mkdtempSync(join(tmpdir(), "omb-connections-ui-"));
app.setPath("userData", home);
app.setPath("sessionData", home);
app.commandLine.appendSwitch("disable-background-networking");
let win;
let exitCode = 0;
app.whenReady().then(async () => {
try {
  session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
    callback({ cancel: new URL(request.url).host !== new URL(url).host });
  });
  win = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
  const until = async (code, description) => {
    for (let i = 0; i < 300; i++) { if (await evaluate(code)) return; await pause(); }
    throw new Error(`Timed out: ${description}`);
  };
  const button = (label) => `[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
  const input = (label) => `[...document.querySelectorAll('label')].find(el => el.querySelector('span')?.textContent === ${JSON.stringify(label)})?.querySelector('input')`;
  const click = async (label) => {
    await until(`Boolean(${button(label)}) && !${button(label)}.disabled`, label);
    await evaluate(`${button(label)}.click()`);
  };
  const fill = async (label, value) => {
    await evaluate(`(() => { const el = ${input(label)}; if (!el) throw new Error('Missing input: ${label}'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  };
  const screenshot = async (name) => {
    await pause();
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `${name}: horizontal overflow`);
    writeFileSync(join(output, name), (await win.webContents.capturePage()).toPNG());
  };
  const add = async (name, keyless = false) => {
    await click("Add connection");
    await fill("Connection name", name);
    await fill("Base URL", providerBase);
    if (keyless) await evaluate("(() => { const el = document.querySelector('form select'); el.value = 'none'; el.dispatchEvent(new Event('change', {bubbles:true})); })()");
    else await fill("API key", "fixture-only-key");
    await fill("Default model (optional)", "fixture/shared-model");
  };
  await win.loadURL(url);
  await add("Research provider");
  await click("Check model catalog");
  await until("document.querySelector('form [role=status]')?.textContent.includes('Catalog accessible')", "catalog verdict");
  await click("Test model response");
  await until("document.querySelector('form [role=status]')?.textContent.includes('Model responded successfully')", "response verdict");
  await screenshot("desktop-form.png");
  await click("Save connection");
  await until("!document.querySelector('form') && document.body.textContent.includes('Research provider')", "saved named connection");
  await add("Local provider", true);
  await click("Save connection");
  await until("!document.querySelector('form') && document.body.textContent.includes('Local provider')", "saved keyless connection");
  await screenshot("desktop-connections.png");
  await evaluate("document.querySelector('[data-tour=model]').click()");
  await until("Boolean(document.querySelector('[aria-label=\"Local provider\"]'))", "keyless provider in model picker");
  await evaluate("document.querySelector('[aria-label=\"Local provider\"]').click()");
  await until("[...document.querySelectorAll('[data-model-picker-content] button')].some(el => el.textContent.includes('fixture/shared-model'))", "keyless model remains selectable");
  await evaluate("[...document.querySelectorAll('[data-model-picker-content] button')].find(el => el.textContent.includes('fixture/shared-model')).click()");
  await until("document.querySelector('[data-model-account]')?.textContent.includes('Local provider')", "selected keyless connection visible in bot model");
  await evaluate("document.querySelector('[data-tour=model]').click()");
  await until("Boolean(document.querySelector('[aria-label=\"Research provider\"]'))", "named provider in model picker");
  await evaluate("document.querySelector('[aria-label=\"Research provider\"]').click()");
  await screenshot("desktop-model-picker.png");
  await until("[...document.querySelectorAll('[data-model-picker-content] button')].some(el => el.textContent.includes('fixture/shared-model'))", "provider model option");
  await evaluate("[...document.querySelectorAll('[data-model-picker-content] button')].find(el => el.textContent.includes('fixture/shared-model')).click()");
  await until("document.querySelector('[data-model-account]')?.textContent.includes('Research provider')", "selected connection visible in bot model");
  await evaluate("document.querySelector('[aria-label=\"Edit Research provider\"]').click()");
  assert.equal(await evaluate(`${input("API key")}.value`), "", "saved credentials are never read into the form");
  await fill("Base URL", `${providerBase}/changed`);
  assert.equal(await evaluate(`${button("Save connection")}.disabled`), true, "a new endpoint cannot inherit the saved key");
  assert.equal(await evaluate(`${button("Check model catalog")}.disabled`), true);
  await fill("API key", "fixture-replacement-key");
  await fill("Base URL", "http://user:password@127.0.0.1/v1");
  await click("Save connection");
  await until("Boolean(document.querySelector('form [role=alert]'))", "invalid endpoint rejected");
  assert.equal(await evaluate(`${input("Connection name")}.value`), "Research provider", "failed save preserves name");
  assert.equal(await evaluate(`${input("API key")}.value.length > 0`), true, "failed save preserves key draft");
  await fill("Base URL", providerBase);
  await fill("Connection name", "Research provider updated");
  await click("Save connection");
  await until("!document.querySelector('form') && document.body.textContent.includes('Research provider updated')", "edited connection");
  await win.reload();
  await until("document.body.textContent.includes('Research provider updated') && document.body.textContent.includes('Local provider')", "connections survive reload");
  win.setSize(390, 1000);
  await screenshot("mobile-connections.png");
  await evaluate("document.querySelector('[aria-label=\"Edit Local provider\"]').click()");
  await evaluate("document.querySelector('form').scrollIntoView({ block: 'start' })");
  await screenshot("mobile-form.png");
  await click("Cancel");
  await evaluate("document.querySelector('[aria-label=\"Remove Local provider\"]').click()");
  await until("Boolean(document.querySelector('[role=alertdialog]'))", "removal confirmation");
  await evaluate("[...document.querySelectorAll('[role=alertdialog] button')].find(el=>el.textContent==='Remove').click()");
  await until("!document.body.textContent.includes('Local provider')", "connection removed");
  assert.equal(await evaluate("document.body.textContent.includes('Research provider updated')"), true, "deleting one connection preserves the other");
  writeFileSync(join(output, "ui-result.json"), JSON.stringify({ ok: true, checks: ["create separate authenticated and keyless connections", "catalog and response checks", "endpoint change requires key", "failure preserves draft", "edit", "reload persistence", "bot selects keyless and authenticated connection models", "delete isolation", "desktop and mobile without horizontal overflow"] }, null, 2));
  win.destroy();

} catch (error) {
  if (win && !win.isDestroyed()) {
    writeFileSync(join(output, "failure.png"), (await win.webContents.capturePage()).toPNG());
    console.error(await win.webContents.executeJavaScript("document.body.innerText"));
  }
  console.error(error);
  exitCode = 1;
} finally {
  if (win && !win.isDestroyed()) win.destroy();
  rmSync(home, { recursive: true, force: true });
  app.exit(exitCode);
}
});
