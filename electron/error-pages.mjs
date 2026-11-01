import path from "node:path";
import { pathToFileURL } from "node:url";
import { desktopText } from "./i18n.mjs";

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** The page the main window shows when the background server never came up. */
export function buildErrorPage({ allPortsOccupied, logDir }) {
  const serverLogPath = path.join(logDir, "server.log");
  const serverLogHref = pathToFileURL(serverLogPath).href;
  const reason = allPortsOccupied
    ? desktopText("desktop.extra.errorPage.ports")
    : desktopText("desktop.extra.errorPage.slow");
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#121212;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:360px"><div style="font-size:40px">🐭</div><h2 style="font-weight:600;margin:12px 0 6px">${escapeHtml(desktopText("desktop.extra.errorPage.serverTitle"))}</h2><p style="color:#fcfcfc99;line-height:1.5">${escapeHtml(reason)} ${escapeHtml(desktopText("desktop.extra.errorPage.logHint"))} <a target="_blank" rel="noopener" href="${serverLogHref}" style="color:#fcfcfc">${escapeHtml(serverLogPath)}</a>.</p></div></body>`,
    )
  );
}

/** The page the live-desktop viewer shows when it cannot open. */
export function desktopViewerErrorPage(message, retryUrl) {
  const escape = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html><meta name="color-scheme" content="dark"><title>${escape(desktopText("desktop.extra.errorPage.viewerTitle"))}</title>
      <body style="margin:0;display:grid;place-items:center;height:100vh;background:#121212;color:#f5f5f5;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">
        <main style="max-width:420px;padding:32px;text-align:center"><h2 style="margin:0 0 10px;font-size:18px">${escape(desktopText("desktop.extra.errorPage.viewerHeading"))}</h2>
        <p style="margin:0 0 20px;color:#a1a1aa;line-height:1.5">${escape(message)}</p>
        <a href="${escape(retryUrl)}" target="_blank" rel="noreferrer" style="display:inline-block;border-radius:9px;background:#fff;color:#111;padding:9px 14px;text-decoration:none;font-weight:600">${escape(desktopText("desktop.extra.errorPage.openBrowser"))}</a></main>
      </body>`)
  );
}
