import fs from "node:fs";
import path from "node:path";
import { PreviewBrowserSession } from "./preview-browser.mjs";

export function createPreviewTestingBridge({ ipcMain, webContents, guestIds, dataDir }) {
  const windows = new Set();
  const sessions = new Map();
  let config = null, stopped = false, pollTimer = null;
  const publicSessions = hostId => [...sessions.values()].filter(r => r.info.state !== "closed" && (r.mount || r.info.state === "error") && (!hostId || r.hostId === hostId)).map(r => ({ ...r.info, canResume: Boolean(r.browser && r.wc && !r.wc.isDestroyed()) }));
  const publish = () => { for (const win of windows) if (!win.isDestroyed()) win.webContents.send("preview-testing:sessions", publicSessions(win.webContents.id)); };
  const trusted = event => [...windows].some(w => !w.isDestroyed() && w.webContents === event.sender && event.senderFrame === event.sender.mainFrame);
  const request = async (body) => {
    if (!config) throw new Error("Preview bridge unavailable. Restart the updated desktop app and harness.");
    const response = await fetch(`${config.url}/api/preview-testing/bridge`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`Preview bridge HTTP ${response.status}; restart the updated desktop app/harness.`);
    return response.json();
  };
  const stopLocal = (r, reason) => {
    r.abort?.abort();
    r.waiting?.reject(new Error(reason)); r.waiting = null;
    if (r.wc && !r.wc.isDestroyed()) r.wc.stop();
    r.info.state = "paused"; r.info.activity = reason;
  };
  const dispose = r => { stopLocal(r, "Session closed"); r.browser?.dispose(); r.browser = null; };
  const pauseSession = async (id, action = "pause", reason = "User took control") => {
    const r = sessions.get(id);
    if (!r) throw new Error("No such Preview testing session.");
    if (action === "resume" && (!r.wc || r.wc.isDestroyed() || !r.browser)) throw new Error("Page was destroyed. Close this session and open a new one.");
    r.pendingControl = true;
    if (action !== "resume") stopLocal(r, reason);
    if (action === "close") { dispose(r); r.info.state = "closed"; }
    publish();
    try {
      await request({ sessionId: id, control: action, reason });
      if (action === "resume") {
        if (!r.wc || r.wc.isDestroyed() || !r.browser) throw new Error("Page was destroyed. Close this session and open a new one.");
        r.info.state = "ready"; r.info.activity = "Idle";
      }
    } catch (error) { if (action !== "resume") r.needsPause = true; throw error; } finally { r.pendingControl = false; publish(); }
  };
  const allowedURL = (r, raw) => {
    try {
      const url = new URL(raw);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
      const isLocal = host => ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(host);
      const origins = [config.url, ...[...windows].filter(w => !w.isDestroyed()).map(w => w.webContents.getURL())];
      const appURL = origins.some(origin => {
        try { const app = new URL(origin); return app.origin === url.origin || (isLocal(app.hostname) && isLocal(url.hostname) && app.port === url.port && app.protocol === url.protocol); } catch { return false; }
      });
      if (!appURL) return true;
      // Project HTML is served with the existing opaque-origin sandbox CSP.
      if (r.info.source.kind !== "file") return false;
      const expected = new URL(r.info.url);
      return url.origin === expected.origin && url.pathname === expected.pathname;
    } catch { return false; }
  };
  const run = async command => {
    const r = sessions.get(command.sessionId);
    if (!r) return request({ id: command.id, error: "Session no longer exists." }).catch(() => {});
    const abort = new AbortController(); r.abort = abort;
    const check = () => { if (abort.signal.aborted || ["paused", "closed", "error"].includes(r.info.state)) throw new Error("Preview action cancelled."); };
    try {
      check();
      if (!r.hostId) r.hostId = [...windows].find(win => !win.isDestroyed())?.webContents.id;
      if (!r.hostId) throw new Error("Open a Studio window before testing.");
      for (const win of windows) if (!win.isDestroyed() && win.webContents.id === r.hostId) win.webContents.send("preview-testing:active", r.info.id);
      if (command.operation === "open") {
        if (guestIds.size >= 6) throw new Error("Six Preview frames are already open. Close one first.");
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Preview frame did not become ready.")), 20_000);
          r.waiting = { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } };
          r.mount = true; publish();
        });
      }
      check();
      if (!r.browser) throw new Error("Preview page is unavailable. Close this session and open a new one.");
      r.info.activity = command.operation; publish();
      let result;
      if (command.operation === "resize") {
        r.info.width = command.args.width; r.info.height = command.args.height; r.info.responsive = command.args.responsive;
        publish();
        // Wait for the real view to reflow, not a screenshot-sized approximation.
        const expected = r.info.responsive ? null : r.info.width;
        const deadline = Date.now() + 3000;
        do {
          check();
          const viewport = await r.browser.script('({ width: innerWidth, height: innerHeight })');
          if (!expected || (viewport.width === expected && viewport.height === r.info.height)) { result = { url: r.wc.getURL(), viewport }; break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        if (!result) throw new Error("Preview viewport did not resize in time.");
      } else result = await r.browser.perform(command.operation, command.args, abort.signal);
      check();
      await request({ id: command.id, sessionId: r.info.id, result });
      if (r.info.state === "opening") r.info.state = "ready";
    } catch (error) {
      if (command.operation === "open" && r.info.state !== "paused") { r.info.state = "error"; r.info.error = error.message; }
      await request({ id: command.id, error: String(error.message ?? error).slice(0, 1000) }).catch(() => {});
    } finally { if (r.abort === abort) r.abort = null; r.info.activity = "Idle"; publish(); }
  };
  async function poll() {
    if (stopped) return;
    try {
      const next = JSON.parse(fs.readFileSync(path.join(dataDir, "preview-testing-bridge.json"), "utf8"));
      const endpoint = new URL(next.url);
      if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || typeof next.token !== "string" || next.token.length !== 64) throw new Error("Invalid Preview bridge descriptor.");
      if (config && config.token !== next.token) { for (const r of sessions.values()) dispose(r); sessions.clear(); publish(); }
      config = next;
      const state = await request();
      const ids = new Set(state.sessions.map(s => s.id));
      for (const [id, r] of sessions) if (!ids.has(id)) { dispose(r); sessions.delete(id); }
      for (const info of state.sessions) {
        let r = sessions.get(info.id);
        if (!r) { r = { info, mount: false, browser: null, wc: null, waiting: null, abort: null, pendingControl: false }; sessions.set(info.id, r); }
        else if (!r.pendingControl) {
          if (info.state === "paused" && r.info.state !== "paused") stopLocal(r, info.activity);
          r.info = r.abort ? { ...info, width: r.info.width, height: r.info.height, responsive: r.info.responsive, activity: r.info.activity } : info;
        }
      }
      for (const r of sessions.values()) if (r.needsPause) {
        stopLocal(r, "Connection interrupted; stopped for user review");
        await request({ sessionId: r.info.id, control: "pause", reason: "Connection interrupted; stopped for user review" });
        r.needsPause = false;
      }
      publish();
      for (const command of state.commands) {
        const r = sessions.get(command.sessionId);
        if (r && !["paused", "closed", "error"].includes(r.info.state)) void run(command);
      }
    } catch {
      // Never leave an apparently live automation lease after connection loss.
      for (const r of sessions.values()) if (!["paused", "closed", "error"].includes(r.info.state)) { stopLocal(r, "Desktop/harness connection lost"); r.needsPause = true; }
      publish();
    } finally { if (!stopped) pollTimer = setTimeout(poll, 350); }
  }
  ipcMain.handle("preview-testing:start", event => { if (!trusted(event)) throw new Error("Untrusted Preview host."); return publicSessions(event.sender.id); });
  ipcMain.handle("preview-testing:control", (event, { sessionId, action }) => {
    if (!trusted(event) || !["pause", "resume", "close"].includes(action)) throw new Error("Untrusted Preview control.");
    return pauseSession(String(sessionId), action);
  });
  ipcMain.handle("preview-testing:register", async (event, { sessionId, webContentsId }) => {
    const r = sessions.get(String(sessionId));
    const wc = webContents.fromId(webContentsId);
    if (!trusted(event) || !r?.waiting || r.hostId !== event.sender.id || !guestIds.has(webContentsId) || !wc || wc.hostWebContents !== event.sender || !allowedURL(r, wc.getURL())) throw new Error("Invalid Preview target registration.");
    r.wc = wc; r.browser = new PreviewBrowserSession(wc, url => allowedURL(r, url));
    const guard = (e, urlOrDetails) => {
      const url = typeof urlOrDetails === "string" ? urlOrDetails : urlOrDetails?.url ?? e.url;
      if (!allowedURL(r, url)) { e.preventDefault(); r.browser.log({ kind: "navigation", error: "Studio or non-http(s) navigation blocked" }); }
    };
    wc.on("will-navigate", guard); wc.on("will-redirect", guard); wc.on("will-frame-navigate", guard);
    wc.once("destroyed", () => {
      if (["closed", "error"].includes(r.info.state)) { r.browser?.dispose(); r.browser = null; r.wc = null; return; }
      stopLocal(r, "Preview frame was destroyed");
      r.browser?.dispose(); r.browser = null; r.wc = null;
      void request({ sessionId: r.info.id, control: "pause", reason: "Preview frame was destroyed" }).catch(() => {});
      publish();
    });
    await r.browser.ready;
    r.waiting?.resolve(); r.waiting = null;
    return { ok: true };
  });
  return {
    attachWindow(win) {
      windows.add(win);
      const invalidate = () => {
        for (const r of sessions.values()) if (r.hostId === win.webContents.id && !["closed", "error"].includes(r.info.state)) {
          stopLocal(r, "Studio window reloaded or closed; open a new test session");
          r.browser?.dispose(); r.browser = null; r.wc = null;
          r.pendingControl = true;
          void request({ sessionId: r.info.id, control: "pause", reason: r.info.activity }).catch(() => { r.needsPause = true; }).finally(() => { r.pendingControl = false; });
        }
        publish();
      };
      win.webContents.on("did-start-navigation", details => { if (details.isMainFrame && !details.isSameDocument) invalidate(); });
      win.on("close", invalidate);
      win.on("closed", () => windows.delete(win));
      if (!pollTimer) pollTimer = setTimeout(poll, 0);
    },
    async dispose() { stopped = true; clearTimeout(pollTimer); for (const r of sessions.values()) dispose(r); await request({ disconnected: true }).catch(() => {}); },
  };
}
