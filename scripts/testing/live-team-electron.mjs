// Disposable Electron renderer smoke, launched only by live-team-ui.e2e.test.ts.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, session } from "electron";

const configPath = process.argv[2];
const config = JSON.parse(readFileSync(configPath, "utf8"));
assert.equal(config.kind, "openmausbot-live-team-fixture");
assert.equal(new URL(config.url).hostname, "127.0.0.1");
assert.equal(process.env.HOME, dirname(configPath));
app.setPath("userData", join(dirname(configPath), "electron-profile"));
app.setPath("sessionData", join(dirname(configPath), "electron-profile"));
app.commandLine.appendSwitch("disable-background-networking");
const requests = [];
const errors = [];
app.whenReady().then(async () => {
try {
  session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
    const url = new URL(request.url);
    const allowed = url.host === new URL(config.url).host || ["data:", "blob:"].includes(url.protocol);
    if (url.pathname.startsWith("/api/")) requests.push({ method: request.method, path: url.pathname });
    callback({ cancel: !allowed });
  });
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000, useContentSize: true,
    webPreferences: { preload: fileURLToPath(new URL("approval-preview-preload.cjs", import.meta.url)), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, description) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error(`Timed out: ${description}`);
  };
  const button = (name) => `[...document.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === ${JSON.stringify(name)} || el.textContent.trim() === ${JSON.stringify(name)})`;
  const click = async (expression) => {
    await until(`Boolean(${expression})`, expression);
    await evaluate(`${expression}.scrollIntoView({block: 'center'})`);
    // The smoke window stays hidden to avoid taking desktop focus. Browser tests
    // cover pointer hit testing. Here dispatch the real control's click handler.
    await evaluate(`${expression}.click()`);
  };
  await win.loadURL(config.url);
  await until("document.querySelector('aside') || document.querySelector('[aria-label=\"Bots and navigation\"]')", "app loaded");
  await evaluate(`localStorage.setItem(${JSON.stringify(`omb-studio:${config.workspaceId}`)}, ${JSON.stringify(JSON.stringify({ presentation: "studio", room: "Launch", calm: false }))}); localStorage.setItem(${JSON.stringify(`omb-computer-panel-view:${config.botId}`)}, 'browser')`);
  // Reload so the studio restores the fixture's saved room through its normal preference path.
  await win.loadURL(config.url);
  await click(button("Tools"));
  await click(button("Team map"));
  await until("document.querySelectorAll('[data-station]').length === 12", "studio restored");
  await evaluate("document.querySelector('.studio-search input').focus()");
  await win.webContents.insertText("Designer");
  await until("document.querySelectorAll('[data-station]').length === 1", "search input");
  const before = requests.length;
  await click(button("Open Designer computer"));
  await until("document.body.innerText.includes('This workstation opens in watch mode.')", "passive workstation");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const passiveRequests = requests.slice(before);
  assert.equal(passiveRequests.some((request) => request.method === "POST" && /computer|browser|box|vps/.test(request.path)), false, "opening a station must not start a browser or computer");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Browser\"][aria-pressed=true]') !== null"), false);
  writeFileSync(join(config.evidence, "electron-workstation.png"), (await win.webContents.capturePage()).toPNG());
  await click(button("Back to studio"));
  await until(`document.activeElement?.closest('[data-station]')?.dataset.station === ${JSON.stringify(config.botId)}`, "station focus restored");
  assert.equal(await evaluate("document.querySelector('.studio-toolbar select').value"), "Launch");
  win.webContents.setZoomFactor(2);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(win.webContents.getZoomFactor(), 2);
  const geometry = await evaluate("({width: innerWidth, height: innerHeight, doc: document.documentElement.scrollWidth, studio: document.querySelector('.live-team').scrollWidth, client: document.querySelector('.live-team').clientWidth})");
  assert.ok(geometry.width <= 720);
  assert.ok(geometry.doc <= geometry.width && geometry.studio <= geometry.client + 1, JSON.stringify(geometry));
  await evaluate("document.querySelector('.live-team').scrollTop = 0");
  writeFileSync(join(config.evidence, "electron-zoom-200.png"), (await win.webContents.capturePage()).toPNG());
  // At true browser zoom the complete studio remains scrollable and its brief reachable.
  await evaluate("document.querySelector('#studio-brief').scrollIntoView({block:'center'}); document.querySelector('#studio-brief').focus()");
  await win.webContents.insertText("A brief at 200 percent zoom.");
  assert.equal(await evaluate("document.querySelector('#studio-brief').value"), "A brief at 200 percent zoom.");
  writeFileSync(join(config.evidence, "electron-zoom-brief.png"), (await win.webContents.capturePage()).toPNG());
  const receipt = { passed: true, electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, geometry, passiveRequests, errors,
    checks: ["real App in isolated Electron renderer", "workspace preferences", "native search input", "remembered browser does not auto-open", "passive computer navigation", "station focus and room return", "200% browser zoom", "brief input at 200%"],
    limitation: "Fixture preload replaces OS integration. This does not verify a packaged app, a provisioned cloud desktop, or Windows/Linux native views." };
  writeFileSync(join(config.evidence, "electron.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
}

});
