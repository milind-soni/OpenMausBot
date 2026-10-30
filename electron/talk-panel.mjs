import { fileURLToPath } from "node:url";

export const TALK_PANEL = Object.freeze({ width: 400, margin: 24, minHeight: 56, maxHeight: 240, fadeMs: 180 });
const MASCOT_PX = 28;
/** Lines of 13 px text at 1.4 that fit the tallest box with its label and padding. */
const TEXT_LINES = 10;
const LIGHT = "color-scheme:light;--panel:#f7f7f7f5;--border:#0000001a;--ink:#0d0d0d;--ink2:#444444;--accent:#0b62c4;--warning:#8a5a00;--danger:#c02b3a;--hover:#0000000d";

export const TALK_LABELS = Object.freeze({
  listening: "Listening…",
  sending: "Sending to MausBot…",
  thinking: "MausBot is thinking…",
  reply: "MausBot",
  "needs-you": "MausBot needs you · Open chat",
  "still-working": "Still working · Open chat",
  error: "",
});

const panels = new WeakSet();

export function isTalkPanel(win) {
  return panels.has(win);
}

export function talkPanelBounds(workArea, height) {
  const h = Math.min(TALK_PANEL.maxHeight, Math.max(TALK_PANEL.minHeight, Math.round(height)));
  return {
    x: Math.round(workArea.x + (workArea.width - TALK_PANEL.width) / 2),
    y: Math.round(workArea.y + workArea.height - TALK_PANEL.margin - h),
    width: TALK_PANEL.width,
    height: h,
  };
}

export function replyPreview(text, limit = 400) {
  const plain = String(text ?? "")
    .slice(0, limit * 4)
    .replace(/```/g, " ")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[\s(])([*_])(?=\S)(.+?)(?<=\S)\2(?=$|[\s).,;:!?])/g, "$1$3")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= limit) return plain;
  const room = plain.slice(0, limit - 1);
  const space = plain[limit - 1] === " " ? limit - 1 : room.lastIndexOf(" ");
  return `${(space > 0 ? plain.slice(0, space) : room).trimEnd()}…`;
}

export function talkPanelHtml(iconBase64) {
  const labels = JSON.stringify(TALK_LABELS);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>MausBot</title><style>
:root{color-scheme:dark light}
body{color-scheme:dark;--panel:#111111f5;--border:#ffffff16;--ink:#fcfcfc;--ink2:#fcfcfcbf;--accent:#1084fe;--warning:#ff9800;--danger:#ff5667;--hover:#ffffff14}
body.light{${LIGHT}}
@media (prefers-color-scheme: light){body:not(.dark){${LIGHT}}}
*{box-sizing:border-box}html,body{margin:0;background:transparent;overflow:hidden;font:13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--ink);-webkit-user-select:none;user-select:none}
body{opacity:0;transition:opacity 160ms ease}body.on{opacity:1}
#card{position:relative;display:flex;gap:12px;align-items:flex-start;min-height:56px;padding:14px 40px 14px 14px;border:1px solid var(--border);border-radius:16px;background:var(--panel);cursor:pointer}
#mascot{position:relative;flex:none;width:${MASCOT_PX}px;height:${MASCOT_PX}px}#mascot img{width:${MASCOT_PX}px;height:${MASCOT_PX}px;object-fit:contain;display:block;-webkit-user-drag:none}
#mascot::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:2px solid var(--accent);opacity:0;pointer-events:none}
body.listening #mascot::after{animation:pulse 1.4s ease-out infinite}
#body{flex:1;min-width:0;align-self:center}
#label{font-weight:600}#label:empty{display:none}
body.needs-you #label,body.still-working #label{color:var(--warning)}body.error #text{color:var(--danger)}
#text{color:var(--ink2);overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${TEXT_LINES};overflow:hidden}#text:empty{display:none}#label:not(:empty)+#text{margin-top:2px}
#close{position:absolute;top:8px;right:8px;width:24px;height:24px;display:grid;place-items:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--ink2);cursor:pointer}
#close:hover{background:var(--hover);color:var(--ink)}#close svg{pointer-events:none}
@keyframes pulse{from{transform:scale(.9);opacity:.8}to{transform:scale(1.35);opacity:0}}
@media (prefers-reduced-motion: reduce){body{transition:none}body.listening #mascot::after{animation:none;opacity:.7}}
</style></head><body><div id="card"><div id="mascot"><img src="data:image/png;base64,${iconBase64}" alt=""></div><div id="body"><div id="label"></div><div id="text" role="status"></div></div><button id="close" type="button" aria-label="Dismiss"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><script>
const LABELS=${labels};
const card=document.getElementById("card"),label=document.getElementById("label"),text=document.getElementById("text");
function render(view){
  document.body.className=["on",view.state,view.theme].filter(Boolean).join(" ");
  label.textContent=LABELS[view.state]||"";
  text.textContent=view.text||(view.state==="listening"?"Let go to send":"");
  return Math.ceil(card.getBoundingClientRect().height);
}
function fadeOut(){document.body.classList.remove("on")}
card.addEventListener("click",()=>window.talk.open());
document.getElementById("close").addEventListener("click",e=>{e.stopPropagation();window.talk.dismiss()});
</script></body></html>`;
}

/** The mascot as a PNG at twice its CSS size, for Retina displays. */
function mascotPng(nativeImage, iconPath) {
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) throw new Error(`no talk box icon at ${iconPath}`);
  return icon.resize({ width: 2 * MASCOT_PX, height: 2 * MASCOT_PX, quality: "best" }).toPNG().toString("base64");
}

export function createTalkPanel({ BrowserWindow, screen, nativeImage, iconPath, onOpen, onDismiss, theme: initialTheme = null }) {
  let win = null;
  let loaded = false;
  let shown = false;
  let view = null;
  let latest = 0;
  let page = null;
  let area = null;
  let theme = initialTheme;

  const workArea = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const live = target => target && !target.isDestroyed();

  function create() {
    page ??= `data:text/html;charset=utf-8,${encodeURIComponent(talkPanelHtml(mascotPng(nativeImage, iconPath)))}`;
    area = workArea();
    const target = new BrowserWindow({
      type: "panel",
      ...talkPanelBounds(area, TALK_PANEL.minHeight),
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      // Electron/macOS: lets a click on an inactive window reach the page.
      acceptFirstMouse: true,
      hiddenInMissionControl: true,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        preload: fileURLToPath(new URL("./talk-panel-preload.cjs", import.meta.url)),
      },
    });
    panels.add(target);
    target.excludedFromShownWindowsMenu = true;
    target.setAlwaysOnTop(true, "screen-saver");
    // Electron/macOS: skipTransformProcessType keeps the Dock icon.
    target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    target.webContents.on("will-navigate", event => event.preventDefault());
    target.webContents.on("did-finish-load", () => {
      if (win !== target) return;
      loaded = true;
      if (view) repaint();
    });
    target.webContents.on("ipc-message", (_event, channel) => {
      if (channel === "talk-panel:open") onOpen();
      else if (channel === "talk-panel:dismiss") onDismiss();
    });
    target.on("closed", () => {
      if (win === target) win = null;
    });
    target.loadURL(page).catch(() => {});
    return target;
  }

  async function paint() {
    const target = win;
    const ticket = ++latest;
    const payload = JSON.stringify({ state: view.state, text: replyPreview(view.text), ...(theme ? { theme } : {}) });
    let height;
    try {
      height = await target.webContents.executeJavaScript(`render(${payload})`);
    } catch {
      return;
    }
    if (win !== target || ticket !== latest || !live(target)) return;
    target.setBounds(talkPanelBounds(area, height));
    if (!shown) {
      shown = true;
      target.showInactive();
    }
  }

  const repaint = () => void paint().catch(() => {});

  return {
    render(next) {
      view = next;
      if (!win) {
        win = create();
        loaded = false;
        shown = false;
      }
      if (loaded) repaint();
    },
    /** The app's skin, light or dark; the box follows macOS until a page of the app says which. */
    setTheme(next) {
      if (next === theme) return;
      theme = next;
      if (win && loaded && view) repaint();
    },
    close() {
      const target = win;
      if (!target) return;
      win = null;
      view = null;
      if (!live(target)) return;
      if (loaded) {
        target.webContents.executeJavaScript("fadeOut()").catch(() => {});
        setTimeout(() => { if (live(target)) target.destroy(); }, TALK_PANEL.fadeMs);
      } else {
        target.destroy();
      }
    },
    hovered() {
      if (!live(win)) return false;
      const point = screen.getCursorScreenPoint();
      const box = win.getBounds();
      return point.x >= box.x && point.x < box.x + box.width && point.y >= box.y && point.y < box.y + box.height;
    },
  };
}
