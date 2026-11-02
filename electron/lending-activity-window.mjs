// See activity, from the menu-bar item: this computer's own record of what its Clouds did here, drawn by main as a static
// page. Security: the record holds what servers sent (folder paths, commands, site names), so every value is escaped,
// and the page runs no script and loads nothing.
import { wordsFor } from "./lending-words.mjs";

const ACTIONS = Object.freeze({
  list_files: "lending.action.listFiles", read_file: "lending.action.readFile", write_file: "lending.action.writeFile",
  edit_file: "lending.action.writeFile", append_file: "lending.action.writeFile", delete_file: "lending.action.deleteFile",
  run_command: "lending.action.runCommand", computer_tools: "lending.action.screenTools", computer_call: "lending.action.screen",
  invalid: "lending.action.invalid", internet: "lending.action.website", chrome: "lending.action.chrome",
});
const ESCAPES = Object.freeze({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" });
const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ESCAPES[character]);

const STYLE = `:root { color-scheme: light dark; --ink: #1d1d1f; --quiet: #6e6e73; --line: #e5e5ea; --refused: #c4302b; --page: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --ink: #f5f5f7; --quiet: #a1a1a6; --line: #38383a; --refused: #ff6b61; --page: #1c1c1e; } }
body { margin: 0; padding: 20px 24px 28px; background: var(--page); color: var(--ink); font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
h1 { margin: 0 0 14px; font-size: 15px; font-weight: 600; }
p { margin: 0; color: var(--quiet); }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; flex-wrap: wrap; gap: 2px 10px; padding: 8px 0; border-top: 1px solid var(--line); }
time, .cloud, .detail { color: var(--quiet); }
time { font-variant-numeric: tabular-nums; }
.detail { flex-basis: 100%; overflow-wrap: anywhere; }
.refused .what { color: var(--refused); }`;

/** The page for `entries` (newest first) in `locale`'s words and dates. */
export function activityPage(entries, locale) {
  const words = wordsFor(locale);
  const lang = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/u.test(locale ?? "") ? locale : "en";
  let when;
  try { when = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }); } catch { when = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }); }
  const rows = entries.map(entry => {
    const what = `${words[ACTIONS[entry.action] ?? "lending.action.other"]}${entry.ok ? "" : ` · ${words["lending.activity.refused"]}`}`;
    return `<li${entry.ok ? "" : ' class="refused"'}><time>${escape(when.format(new Date(entry.at)))}</time><span class="cloud">${escape(entry.server)}</span>`
      + `<span class="what">${escape(what)}</span>${entry.detail ? `<span class="detail" dir="auto">${escape(entry.detail)}</span>` : ""}</li>`;
  }).join("");
  return `<!doctype html><html lang="${escape(lang)}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`
    + `<title>${escape(words["lending.activity.title"])}</title><style>${STYLE}</style></head>`
    + `<body><h1>${escape(words["lending.activity.title"])}</h1>${rows ? `<ul>${rows}</ul>` : `<p>${escape(words["lending.activity.empty"])}</p>`}</body></html>`;
}

/** One window at a time; opening it again shows what was recorded since. */
export function createActivityWindow({ BrowserWindow, icon, background, entries, locale }) {
  let win = null;
  return {
    show() {
      const html = activityPage(entries(), locale());
      if (!win || win.isDestroyed()) {
        win = new BrowserWindow({
          width: 560, height: 640, minWidth: 380, minHeight: 280, show: false, icon, backgroundColor: background(), autoHideMenuBar: true,
          title: wordsFor(locale())["lending.activity.title"],
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, partition: "openmausbot-lending-activity" },
        });
        const opened = win;
        opened.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        opened.webContents.on("will-navigate", event => event.preventDefault());
        opened.once("ready-to-show", () => { if (!opened.isDestroyed()) { opened.show(); opened.focus(); } });
        opened.on("closed", () => { if (win === opened) win = null; });
      } else {
        win.show();
        win.focus();
      }
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
    },
    close() { if (win && !win.isDestroyed()) win.close(); win = null; },
  };
}
