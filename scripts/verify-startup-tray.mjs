// Disposable real-Electron check. No workspace, server, credentials or CUA.
// Run with Node: node scripts/verify-startup-tray.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const flag = "--omb-startup-fixture";
if (!process.versions.electron) {
  const output = mkdtempSync(join(tmpdir(), "openmausbot-startup-evidence-"));
  const env = { ...process.env, HOME: output, USERPROFILE: output,
    APPDATA: join(output, "roaming"), LOCALAPPDATA: join(output, "local") };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)("electron"),
    [fileURLToPath(import.meta.url), flag, output], { env, stdio: "inherit" });
  const watchdog = setTimeout(() => child.kill(), 45_000);
  const code = await new Promise(resolve => {
    child.on("error", error => { console.error(error); resolve(1); });
    child.on("exit", value => resolve(value ?? 1));
  });
  clearTimeout(watchdog);
  console.log(`Startup/tray evidence: ${output}`);
  assert.equal(code, 0, "Electron fixture failed");
  assert.equal(JSON.parse(readFileSync(join(output, "receipt.json"), "utf8")).passed, true);
} else {
  assert.ok(process.argv.includes(flag));
  const output = process.argv[process.argv.indexOf(flag) + 1];
  const record = value => appendFileSync(join(output, "progress.log"), `${value}\n`);
  const { app, BrowserWindow, Menu, Tray, nativeImage, session } = await import("electron");
  const { createStartupScreen } = await import("../electron/startup-screen.mjs");
  const { createSystemTray } = await import("../electron/system-tray.mjs");
  app.setPath("userData", join(output, "profile"));
  app.setPath("sessionData", join(output, "profile"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.on("window-all-closed", () => {});
  void app.whenReady().then(async () => {
  record("ready");
  session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
    callback({ cancel: !request.url.startsWith("data:") });
  });
  const iconPath = fileURLToPath(new URL("../electron/resources/app-icon.png", import.meta.url));
  let active, quitting = false, tray, splash, trayMenu;
  const requestQuit = () => { quitting = true; };
  try {
    tray = createSystemTray({ Tray,
      Menu: { buildFromTemplate: template => (trayMenu = Menu.buildFromTemplate(template)) },
      nativeImage, iconPath, getWindow: () => active, onQuit: requestQuit });
    splash = createStartupScreen({ BrowserWindow, iconPath, platform: "win32",
      isQuitting: () => quitting, onQuit: requestQuit, onHide: win => tray.hide(win),
      isHidden: () => tray.isHidden(), onShow: win => tray.windowShown(win),
      onFinished: () => record("splash disposed") });
    active = splash.window;
    active.on("close", event => record(`close prevented=${event.defaultPrevented}`));
    active.on("closed", () => record("splash closed"));
    await splash.ready;
    record("splash shown");
    await delay(150);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "startup-screen.png"), (await active.webContents.capturePage()).toPNG());
    assert.equal(await active.webContents.executeJavaScript("document.querySelector('h1').textContent"), "OpenMaus Bot");
    assert.equal(await active.webContents.executeJavaScript("typeof process"), "undefined");
    // Exercise the actual renderer close button.
    await active.webContents.executeJavaScript("document.querySelector('button').click()");
    record("clicked close");
    await delay(100);
    assert.equal(active.isVisible(), false);
    assert.equal(tray.isHidden(), true);
    const win = new BrowserWindow({ show: false, width: 500, height: 360,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.on("show", () => tray.windowShown(win));
    win.on("show", () => record(`workspace show visible=${win.isVisible()}`));
    win.on("hide", () => record("workspace hide"));
    splash.attach(win);
    await win.loadURL("data:text/html,<div id='root'></div>");
    await delay(100);
    assert.equal(splash.window.isDestroyed(), false);
    await win.webContents.executeJavaScript("document.getElementById('root').innerHTML='<p>Workspace ready</p>'");
    for (let i = 0; i < 50 && !splash.window.isDestroyed(); i++) await delay(20);
    assert.equal(splash.window.isDestroyed(), true);
    assert.equal(win.isVisible(), false);
    active = win;
    assert.equal(tray.show(), true);
    record(`restore visible=${win.isVisible()} minimized=${win.isMinimized()}`);
    for (let i = 0; i < 50 && !win.isVisible(); i++) await delay(20);
    assert.equal(win.isVisible(), true);
    assert.equal(tray.isHidden(), false);
    // Select the real native MenuItem without manipulating the operator's tray.
    trayMenu.items[2].click();
    assert.equal(quitting, true);
    tray.destroy(); win.destroy();
    record("checks complete");
    writeFileSync(join(output, "receipt.json"), JSON.stringify({
      passed: true, platform: process.platform, screenshot: "startup-screen.png",
      checks: ["sandboxed loading renderer", "close hides loading window", "waits for mounted content",
        "startup dismissal keeps workspace hidden", "tray restores workspace", "quit callback"],
      limitations: "No full application, OS popup clicks, installed package, update download or CUA startup exercised.",
    }, null, 2));
    app.exit(0);
  } catch (error) {
    console.error(error); splash?.dispose(); tray?.destroy(); app.exit(1);
  }
  }).catch(error => { console.error(error); app.exit(1); });
}
