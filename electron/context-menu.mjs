import fs from "node:fs";
import path from "node:path";

import nativeText from "./native-text.cjs";
import { pasteMenuItem } from "./paste-menu-item.mjs";

/** The only types "Open in Default App" hands to the operating system, each with the extension the copy is given. */
const OPENABLE = Object.freeze({
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp", "image/avif": ".avif",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "video/x-m4v": ".m4v",
  "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/aac": ".aac", "audio/wav": ".wav", "audio/x-wav": ".wav",
  "audio/wave": ".wav", "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/flac": ".flac", "audio/x-flac": ".flac",
});
const MEDIA_SAVE_LABEL = Object.freeze({ image: "native.context.saveImageAs", video: "native.context.saveVideoAs", audio: "native.context.saveAudioAs" });
const MEDIA_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp|avif|mp4|webm|mov|m4v|mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;
const PAGE_EXTENSION = /\.(?:html?|php|aspx?|jsp)$/i;
const PENDING_MS = 60_000;
const OPENED_COPY_MS = 24 * 60 * 60 * 1000;

/** A URL the window's own session can download: what the page itself loaded, never a file: path. */
export function downloadableUrl(url) {
  try {
    return ["http:", "https:", "blob:", "data:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** A link that names a file (report.pdf, a chat file route), not a web page. */
export function fileLink(url) {
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") return false;
    if (/^\/api\/(?:attachments\/[^/]+|threads\/[^/]+\/messages\/[^/]+\/file)$/.test(target.pathname)) return true;
    const last = decodeURIComponent(target.pathname).split("/").pop() ?? "";
    return /\.[a-z0-9]{1,8}$/i.test(last) && !PAGE_EXTENSION.test(last);
  } catch {
    return false;
  }
}

/** A file link to a picture, video or audio, by its name or a chat player's link; the download's type is checked again. */
export function mediaLink(url) {
  if (!fileLink(url)) return false;
  const target = new URL(url);
  if (target.pathname.endsWith("/file") && target.searchParams.has("media")) return true;
  return MEDIA_EXTENSION.test(decodeURIComponent(target.pathname));
}

/** A name safe to write in our own folder: no folders, control or reserved characters, no Windows device name. */
export function mediaCopyName(suggested, extension) {
  const kept = [...String(suggested ?? "").split(/[\\/]/).pop()].filter((ch) => ch > "\u001f" && ch !== "\u007f" && !'<>:"|?*'.includes(ch));
  const base = kept.join("").replace(/^[.\s]+|[.\s]+$/g, "");
  const stem = (base.replace(/\.[A-Za-z0-9]{1,8}$/, "") || "media").slice(0, 80);
  return `${/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(stem) ? "_" : ""}${stem}${extension}`;
}

function mimeOf(item) {
  return String(item.getMimeType?.() ?? "").split(";", 1)[0].trim().toLowerCase();
}

/** Chromium's suggested name, with the extension its type implies when it has none (a chat video link ends in /file). */
export function savedName(item) {
  const name = item.getFilename() || "download";
  const extension = OPENABLE[mimeOf(item)];
  return extension && !/\.[A-Za-z0-9]{1,8}$/.test(name) ? `${name}${extension}` : name;
}

/**
 * Save As and Open in Default App go through `webContents.downloadURL`, so each request carries exactly what the page's
 * own request would (the Cloud's session cookie, the desktop's owner header) and streams to disk, never into memory.
 * `claim(item)` runs first in the session's will-download handler and takes only the downloads this menu started.
 */
export function createMediaDownloads({ dialog, shell, openDir, downloadsDir, t = nativeText.englishText.t, now = Date.now, fsSync = fs, log = () => {} }) {
  const pending = new Map();
  const forget = (url) => pending.delete(url);
  const sweepOpened = () => {
    const dir = openDir();
    let entries = [];
    try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("m-")) continue;
      const old = path.join(dir, entry.name);
      try {
        if (now() - fsSync.statSync(old).mtimeMs > OPENED_COPY_MS) fsSync.rmSync(old, { recursive: true, force: true });
      } catch {}
    }
  };
  const tell = (message, detail) => void Promise.resolve(dialog.showMessageBox({ type: "warning", message, ...(detail ? { detail } : {}) })).catch(() => {});

  const openCopy = (item) => {
    const extension = OPENABLE[mimeOf(item)];
    if (!extension) {
      item.cancel();
      tell(t("native.context.cannotOpen"));
      return;
    }
    sweepOpened();
    fsSync.mkdirSync(openDir(), { recursive: true, mode: 0o700 });
    const file = path.join(fsSync.mkdtempSync(path.join(openDir(), "m-")), mediaCopyName(item.getFilename(), extension));
    item.setSavePath(file);
    item.once("done", (_event, state) => {
      if (state !== "completed") return;
      void Promise.resolve(shell.openPath(file)).then((error) => {
        if (error) tell(t("native.context.openFailed"), String(error).slice(0, 300));
      }, (error) => tell(t("native.context.openFailed"), String(error?.message ?? error).slice(0, 300)));
    });
  };

  return {
    /** `mode` is "save" (the system's Save dialog) or "open" (a private copy opened in its default app). */
    start(webContents, url, mode) {
      if (!downloadableUrl(url)) return false;
      pending.set(url, { mode, at: now() });
      try {
        webContents.downloadURL(url);
        return true;
      } catch (error) {
        forget(url);
        log(`context menu download failed: ${error?.message ?? error}`);
        return false;
      }
    },
    claim(item) {
      const url = item.getURLChain?.()[0] ?? item.getURL();
      const intent = pending.get(url);
      if (!intent) return false;
      forget(url);
      if (now() - intent.at > PENDING_MS) return false;
      try {
        if (intent.mode === "open") openCopy(item);
        else item.setSaveDialogOptions({ defaultPath: path.join(downloadsDir(), savedName(item)) });
      } catch (error) {
        item.cancel();
        log(`context menu download failed: ${error?.message ?? error}`);
        tell(t("native.context.openFailed"), String(error?.message ?? error).slice(0, 300));
      }
      return true;
    },
  };
}

function editItems(params, paste, t) {
  return [
    { label: t("native.role.undo"), role: "undo", enabled: params.editFlags.canUndo },
    { label: t("native.role.redo"), role: "redo", enabled: params.editFlags.canRedo },
    { type: "separator" },
    { label: t("native.role.cut"), role: "cut", enabled: params.editFlags.canCut },
    { label: t("native.role.copy"), role: "copy", enabled: params.editFlags.canCopy },
    paste,
    { label: t("native.role.pasteAndMatchStyle"), role: "pasteAndMatchStyle", enabled: params.editFlags.canPaste },
    { type: "separator" },
    { label: t("native.role.selectAll"), role: "selectAll", enabled: params.editFlags.canSelectAll },
  ];
}

function mediaItems(params, { webContents, downloads, t }) {
  const kind = Object.hasOwn(MEDIA_SAVE_LABEL, params.mediaType) ? params.mediaType : null;
  if (!kind) return [];
  const items = kind === "image" && params.hasImageContents
    ? [{ label: t("native.context.copyImage"), click: () => webContents.copyImageAt(params.x, params.y) }]
    : [];
  if (downloadableUrl(params.srcURL)) {
    items.push(
      { label: t(MEDIA_SAVE_LABEL[kind]), click: () => downloads.start(webContents, params.srcURL, "save") },
      { label: t("native.context.openInDefaultApp"), click: () => downloads.start(webContents, params.srcURL, "open") },
    );
  }
  return items;
}

/** The window's right-click menu, built from Electron's context-menu params: never empty, so right-click always answers. */
export function contextMenuTemplate(params, { webContents, clipboard, downloads, platform = process.platform, t = nativeText.englishText.t }) {
  const sections = [];
  if (params.misspelledWord) {
    sections.push((params.dictionarySuggestions ?? []).slice(0, 5).map((suggestion) => ({
      label: suggestion,
      click: () => webContents.replaceMisspelling(suggestion),
    })));
  }
  if (params.linkURL) {
    sections.push([
      { label: t("native.context.copyLink"), click: () => clipboard.writeText(params.linkURL) },
      ...(fileLink(params.linkURL) ? [{ label: t("native.context.saveLinkAs"), click: () => downloads.start(webContents, params.linkURL, "save") }] : []),
      ...(mediaLink(params.linkURL) ? [{ label: t("native.context.openInDefaultApp"), click: () => downloads.start(webContents, params.linkURL, "open") }] : []),
    ]);
  }
  const media = mediaItems(params, { webContents, downloads, t });
  sections.push(media);
  if (params.isEditable || params.linkURL || params.misspelledWord || params.selectionText) {
    sections.push(editItems(params, pasteMenuItem(params, clipboard, webContents, t), t));
  } else if (media.length === 0) {
    sections.push([
      { label: t("native.role.copy"), role: "copy", enabled: params.editFlags.canCopy },
      { label: t("native.role.selectAll"), role: "selectAll" },
      { type: "separator" },
      { label: t("native.role.reload"), click: () => webContents.reload() },
    ]);
  }
  if (params.isEditable && (platform === "win32" || platform === "linux")) {
    const { session } = webContents;
    const checked = session.isSpellCheckerEnabled();
    sections.push([{
      label: t("native.context.checkSpelling"),
      type: "checkbox",
      checked,
      click: () => session.setSpellCheckerEnabled(!checked),
    }]);
  }
  return sections.filter((section) => section.length > 0).flatMap((section, index) => index === 0 ? section : [{ type: "separator" }, ...section]);
}
