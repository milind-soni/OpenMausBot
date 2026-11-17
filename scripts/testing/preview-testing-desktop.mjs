// Disposable Electron host for preview-testing-regression.mjs; never packaged.
import { app, BrowserWindow, ipcMain, webContents } from "electron";
import { createServer } from "node:http";
import fs from "node:fs";
import { createPreviewTestingBridge } from "../../electron/preview-testing.mjs";
const { GBS_QA_BASE: base, GBS_QA_SECRET: secret, GBS_QA_CONTROL_PORT: port, GBS_QA_PRELOAD: preload, GBS_QA_USER_DATA: userData, GBS_DATA_DIR: dataDir } = process.env;
if (!base || !secret || !port || !preload || !userData || !dataDir) throw new Error("Use the disposable Preview regression runner.");
app.setPath("userData", userData);
app.whenReady().then(async () => {
  const guests = new Set();
  const bridge = createPreviewTestingBridge({ ipcMain, webContents, guestIds: guests, dataDir });
  const win = new BrowserWindow({ width: 1440, height: 1000, show: true, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: true } });
  bridge.attachWindow(win);
  ipcMain.handle("projects:list", () => []);
  ipcMain.handle("update:get-state", () => ({ status: "idle" }));
  win.webContents.on("will-attach-webview", (_event, prefs) => { prefs.nodeIntegration = false; prefs.contextIsolation = true; prefs.sandbox = true; delete prefs.preload; delete prefs.preloadURL; });
  win.webContents.on("did-attach-webview", (_event, guest) => { guests.add(guest.id); guest.once("destroyed", () => guests.delete(guest.id)); guest.setWindowOpenHandler(() => ({ action: "deny" })); });
  await win.loadURL(base);
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== secret) { res.writeHead(401); return res.end("{}"); }
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {}; let value = { ok: true };
      if (req.url === "/state") value = await win.webContents.executeJavaScript(`(() => { const panel = document.querySelector('aside[aria-label="Quick preview panel"]'); return { text: panel?.innerText, count: document.querySelectorAll('webview').length, panel: panel?.getBoundingClientRect().toJSON() }; })()`);
      if (req.url === "/open-page") await win.webContents.executeJavaScript(`(async () => { document.querySelector('[role="tab"]')?.click(); window.dispatchEvent(new CustomEvent("gbs-open-preview", { detail: { url: ${JSON.stringify(body.url)} } })); for (let i = 0; i < 50; i++) { const load = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Load preview"); if (load) { load.click(); return; } await new Promise(r => setTimeout(r, 100)); } })()`);
      if (req.url === "/control") await win.webContents.executeJavaScript(`window.gbs.previewTesting.control(${JSON.stringify(body)})`);
      if (req.url === "/resize") win.setSize(body.width, body.height);
      if (req.url === "/capture") fs.writeFileSync(body.path, (await win.capturePage()).toPNG());
      if (req.url === "/reload") win.webContents.reload();
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value));
    } catch (error) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
  });
  server.listen(Number(port), "127.0.0.1");
  app.on("before-quit", () => { server.close(); void bridge.dispose(); });
});
