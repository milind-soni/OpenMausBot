// Run with: node scripts/smoke-app-permissions.mjs
// Linux CI needs xvfb-run. Uses a fake microphone and captures only its own
// disposable page, never the user's microphone, camera, desktop, or app data.
import electron from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { appPermissionAllowed } from "../electron/app-permissions.mjs";
import screenPreview from "../electron/screen-preview.cjs";

// Chromium can write cache files after app.quit. The Node parent owns cleanup
// so the disposable profile is removed only after the Electron child exits.
if (!process.versions.electron) {
  const data = mkdtempSync(join(tmpdir(), "omb-permission-smoke-"));
  let code = 1;
  try {
    const result = spawnSync(electron, [fileURLToPath(import.meta.url), data], { stdio: "inherit", timeout: 40_000 });
    if (result.error) throw result.error;
    code = result.status ?? 1;
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
  process.exit(code);
}

const { app, BrowserWindow, session } = electron;
const data = process.argv[2];
assert.ok(data, "Run this smoke with Node so its parent owns the temporary profile");
app.setPath("userData", data);
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
const timeout = setTimeout(() => { console.error("Permission smoke timed out"); app.exit(1); }, 30_000);

async function run() {
  const servers = [0, 1].map(() => createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>Isolated permission smoke</title><p>Only this test page is captured.</p>");
  }));
  let win;
  try {
    await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve))));
    const [origin, foreignOrigin] = servers.map(server => `http://127.0.0.1:${server.address().port}`);
    await app.whenReady();
    const guard = screenPreview.createDisplayMediaGuard();
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    session.defaultSession.setPermissionCheckHandler((contents, permission, requesting, details) =>
      appPermissionAllowed(permission, requesting || contents?.getURL() || "", origin, details));
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(appPermissionAllowed(permission, details?.requestingUrl ?? contents?.getURL() ?? "", origin, details)));
    const displayDecisions = [];
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const allowed = guard.consume(request, origin);
      displayDecisions.push(allowed);
      // Electron can capture this fixture's WebContents without screen access.
      screenPreview.invokeDisplayMediaCallback(callback, allowed ? { video: request.frame } : {});
    });
    const capture = expression => win.webContents.executeJavaScript(`
      (${expression}).then(stream => {
        const tracks = stream.getTracks().map(track => track.kind);
        stream.getTracks().forEach(track => track.stop());
        return { tracks };
      }).catch(error => ({ error: error.name }))`, true);
    const microphone = "navigator.mediaDevices.getUserMedia({audio:true})";
    const camera = "navigator.mediaDevices.getUserMedia({video:true})";
    const display = "navigator.mediaDevices.getDisplayMedia({video:true,audio:false})";
    await win.loadURL(origin);
    assert.deepEqual(await capture(microphone), { tracks: ["audio"] });
    assert.deepEqual(await capture(camera), { error: "NotAllowedError" });
    assert.ok((await capture(display)).error, "screen capture needs an intent");
    assert.equal(guard.begin(win.webContents.mainFrame), true);
    assert.deepEqual(await capture(display), { tracks: ["video"] });
    assert.ok((await capture(display)).error, "screen intent is one-shot");
    assert.deepEqual(displayDecisions, [false, true, false]);
    await win.loadURL(foreignOrigin);
    assert.deepEqual(await capture(microphone), { error: "NotAllowedError" });
    assert.equal(guard.begin(win.webContents.mainFrame), true);
    assert.ok((await capture(display)).error, "another origin must not capture");
    assert.deepEqual(displayDecisions, [false, true, false], "foreign capture must not reach source selection");
    console.log(JSON.stringify({ electron: process.versions.electron, microphone: "allowed", camera: "denied", display: "intent-bound", foreignOrigin: "denied" }));
  } finally {
    clearTimeout(timeout);
    win?.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}

// Do not top-level-await app readiness: Electron finishes loading this module
// before emitting ready. Keep fixture startup errors visible and bounded.
void run().then(() => app.quit(), error => { console.error(error); app.exit(1); });
