import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function startupScreenHtml(iconPath) {
  const icon = fs.readFileSync(iconPath).toString('base64');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>OpenMaus Bot</title><style>
  *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;font-family:Segoe UI,system-ui,sans-serif;color:#f5f5f5;background:transparent}
  main{height:100%;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;border:1px solid #ffffff16;border-radius:20px;background:radial-gradient(ellipse at 50% 22%,#242529 0,#161719 54%,#111214 100%);-webkit-app-region:drag}
  img{width:74px;height:74px;object-fit:contain;margin-bottom:18px;user-select:none;-webkit-user-drag:none}
  h1{font-size:25px;line-height:1.25;font-weight:600;letter-spacing:-.6px;margin:0 0 26px}
  .status{display:flex;align-items:center;gap:9px;color:#999da5;font-size:12px;line-height:18px}
  .spinner{width:13px;height:13px;border-radius:50%;border:1.5px solid #ffffff21;border-top-color:#a6c9ff;animation:spin .9s linear infinite}
  button{position:absolute;right:13px;top:13px;width:30px;height:30px;display:grid;place-items:center;padding:0;color:#999da5;border:0;border-radius:7px;background:transparent;cursor:pointer;-webkit-app-region:no-drag}
  button:hover{color:#fff;background:#ffffff10}button:focus-visible{outline:2px solid #1686ff;outline-offset:2px}button svg{pointer-events:none}
  @keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none;border-color:#a6c9ff}}
  </style></head><body><main><button aria-label="Close" onclick="window.startupScreen.close()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button><img src="data:image/png;base64,${icon}" alt=""><h1>OpenMaus Bot</h1><div class="status" role="status"><span class="spinner" aria-hidden="true"></span>Opening your workspace…</div></main></body></html>`;
}

export function createStartupScreen({
  BrowserWindow, iconPath, platform = process.platform, isQuitting, onQuit,
  onHide, isHidden = () => false, onShow, onFinished,
}) {
  let disposed = false, revealed = false, fallback, resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const splash = new BrowserWindow({
    width: 440, height: 300, resizable: false, maximizable: false,
    fullscreenable: false, frame: false, transparent: true,
    backgroundColor: "#00000000", show: false, icon: iconPath,
    title: "OpenMaus Bot", autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      preload: fileURLToPath(new URL("./startup-screen-preload.cjs", import.meta.url)),
    },
  });
  splash.setMenu(null);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(fallback);
    resolveReady();
    if (!splash.isDestroyed()) splash.destroy();
    onFinished?.();
  };
  splash.on("close", event => {
    if (disposed || isQuitting()) return;
    event.preventDefault();
    if (platform === "win32" && onHide) onHide(splash);
    else onQuit();
  });
  // Renderer window.close() bypasses BrowserWindow's cancellable close path.
  // This dedicated, unprivileged bridge requests the native path instead.
  splash.webContents.on("ipc-message", (_event, channel) => {
    if (channel === "startup-screen:close" && !disposed) splash.close();
  });
  splash.once("ready-to-show", () => {
    if (!disposed && !isQuitting()) { clearTimeout(fallback); splash.show(); resolveReady(); }
  });
  splash.on("show", () => onShow?.(splash));
  splash.once("closed", resolveReady);
  // Server startup waits on ready. A failed loading renderer must not keep
  // it from ever reaching the main window's own bounded recovery path.
  splash.webContents.once("render-process-gone", dispose);
  fallback = setTimeout(dispose, 10_000);
  fallback.unref?.();
  void splash.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(startupScreenHtml(iconPath)))
    .catch(dispose);
  const attach = (win, { maximized = false } = {}) => {
    const reveal = () => {
      if (revealed || win.isDestroyed() || isQuitting()) return;
      revealed = true;
      const minimized = !splash.isDestroyed() && splash.isMinimized();
      if (isHidden()) {
        win.setSkipTaskbar(true);
        win.hide();
        if (maximized) win.once("show", () => win.maximize());
      } else {
        if (maximized) win.maximize();
        if (minimized) { win.showInactive(); win.minimize(); }
        else { win.show(); win.focus(); }
      }
      dispose();
    };
    // React must mount before the loading window gives way to the workspace.
    // Error pages have no React root and can be shown immediately.
    win.webContents.on("did-finish-load", () => {
      if (revealed || win.isDestroyed() || isQuitting()) return;
      void win.webContents.executeJavaScript(`new Promise(resolve => {
        const root = document.getElementById('root');
        if (!root || root.childElementCount) { resolve(); return; }
        const observer = new MutationObserver(() => {
          if (root.childElementCount) { observer.disconnect(); resolve(); }
        });
        observer.observe(root, { childList: true });
      })`).then(reveal).catch(reveal);
    });
    win.webContents.once("render-process-gone", reveal);
    win.once("show", () => { if (!revealed) { revealed = true; dispose(); } });
    win.once("closed", dispose);
    // Preserve a bounded recovery path if the renderer fails to mount.
    fallback = setTimeout(reveal, 10_000);
    fallback.unref?.();
  };
  return { ready, attach, dispose, window: splash };
}
