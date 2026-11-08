import fs from "node:fs";
import nativeText from "./native-text.cjs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export function revealDownloadWhenDone(item, reveal) {
  item.once("done", (_event, state) => {
    if (state === "completed") reveal(item.getSavePath());
  });
}

function normalizeSourcePath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error("A file path is required");
  }

  if (/^file:\/\//i.test(rawPath)) {
    try {
      return fileURLToPath(rawPath);
    } catch {
      throw new Error("That file path is invalid");
    }
  }

  if (!path.isAbsolute(rawPath)) throw new Error("That file path is invalid");
  return rawPath;
}

async function canonicalPath(target, fsp, message) {
  try {
    return await fsp.realpath(target);
  } catch {
    throw new Error(message);
  }
}

function assertInside(root, target) {
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("Only files created by your bots can be saved");
  }
}

function assertRegularFile(stats) {
  if (!stats.isFile()) throw new Error("That path is not a file");
}

function isSameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

// Paths come from model-rendered markdown, so they are untrusted.
async function resolveSource(rawPath, { home, fsp, platform }) {
  const target = normalizeSourcePath(rawPath);
  const root = await canonicalPath(
    path.join(home, ".openmausbot"),
    fsp,
    "Only files created by your bots can be saved",
  );
  const filePath = await canonicalPath(target, fsp, "That file no longer exists");
  assertInside(root, filePath);

  const stats = await fsp.stat(filePath, { bigint: true });
  assertRegularFile(stats);
  if (platform === "win32") {
    const pathAfterStat = await canonicalPath(filePath, fsp, "That file no longer exists");
    assertInside(root, pathAfterStat);
  }
  return { filePath, stats };
}

export async function resolveSavablePath(rawPath, { home, fsp = fs.promises, platform = process.platform } = {}) {
  return (await resolveSource(rawPath, { home, fsp, platform })).filePath;
}

async function openSavableFile(rawPath, { home, fsp, platform }) {
  const source = await resolveSource(rawPath, { home, fsp, platform });
  const noFollow = platform === "win32" ? 0 : fs.constants.O_NOFOLLOW ?? 0;
  const handle = await fsp.open(source.filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const openedStats = await handle.stat({ bigint: true });
    assertRegularFile(openedStats);
    if (platform === "win32" && !isSameFile(source.stats, openedStats)) {
      throw new Error("That file changed while it was being opened");
    }
    return { handle, filePath: source.filePath };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function withSavableFile(
  rawPath,
  { home, fsp = fs.promises, platform = process.platform } = {},
  operation,
) {
  const { handle, filePath } = await openSavableFile(rawPath, { home, fsp, platform });
  try {
    return await operation({
      filePath,
      defaultName: path.basename(filePath),
      copyTo: async (destination) => {
        await pipeline(
          handle.createReadStream({ autoClose: false, start: 0 }),
          fs.createWriteStream(destination),
        );
      },
    });
  } finally {
    await handle.close();
  }
}

// Only absolute local filesystem paths reach the desktop shell. Network shares are refused, since merely looking
// one up can hand this computer's sign-in to whoever runs that server.
export async function revealInFolder(rawPath, { reveal, fsp = fs.promises, pathApi = path }) {
  const local = (value) => !/^[\\/]{2}/.test(value) && pathApi.isAbsolute(value);
  if (typeof rawPath !== "string" || rawPath.includes("\0") || /^[a-z][a-z\d+.-]+:/i.test(rawPath) || !local(rawPath)) {
    return "invalid";
  }
  const target = pathApi.normalize(rawPath);
  if (!local(target)) return "invalid";
  let stats;
  try {
    stats = await fsp.stat(target);
  } catch {
    return "missing";
  }
  if (!stats.isFile() && !stats.isDirectory()) return "invalid";
  reveal(target);
  return "shown";
}

/** This app's own logs folder in Explorer or Finder, made first if nothing has been logged yet. The folder is main's
 * own (app.getPath("logs")), never one a page names; `open` is shell.openPath, which answers "" or why it failed. */
export async function openLogsFolder(folder, { open, fsp = fs.promises }) {
  try { await fsp.mkdir(folder, { recursive: true }); } catch {}
  let error = "";
  try { error = await open(folder); } catch (failure) { error = failure?.message ?? String(failure); }
  return { folder, opened: !error, ...(error ? { error: String(error).slice(0, 300) } : {}) };
}

export const OPEN_HTML_MAX_BYTES = 2 * 1024 * 1024;

/** A file name safe to write in our own folder: no folders, control or reserved characters, no Windows device name
 * (CON, NUL, COM1…, which would open the device, not a file), and a .html/.htm end. */
export function htmlCopyName(name) {
  const kept = [...String(name ?? "").split(/[\\/]/).pop()].filter((ch) => ch > "\u001f" && ch !== "\u007f" && !'<>:"|?*'.includes(ch));
  const base = kept.join("").replace(/^[.\s]+|[.\s]+$/g, "");
  const stem = (base.replace(/\.html?$/i, "") || "page").slice(0, 80);
  return `${/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(stem) ? "_" : ""}${stem}${/\.htm$/i.test(base) ? ".htm" : ".html"}`;
}

/** Opens HTML the page already showed in the default browser: a fresh copy in our own temp folder, never a path a page
 * names. `open` is shell.openPath, which answers "" or why it failed. Copies older than a day are cleared first. */
export async function openHtmlCopy(source, name, { dir, open, fsp = fs.promises, now = Date.now(), t = nativeText.englishText.t }) {
  if (typeof source !== "string") throw new Error(t("native.html.nothingToOpen"));
  if (Buffer.byteLength(source, "utf8") > OPEN_HTML_MAX_BYTES) throw new Error(t("native.html.tooLarge"));
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !entry.name.startsWith("p-")) continue;
    const old = path.join(dir, entry.name);
    const stat = await fsp.stat(old).catch(() => null);
    if (stat && now - stat.mtimeMs > 24 * 60 * 60 * 1000) await fsp.rm(old, { recursive: true, force: true }).catch(() => undefined);
  }
  const file = path.join(await fsp.mkdtemp(path.join(dir, "p-")), htmlCopyName(name));
  // The byte order mark tells every browser (Safari reads a bare file: page as Latin-1) that the copy is UTF-8.
  await fsp.writeFile(file, `\ufeff${source}`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const error = await open(file);
  if (error) throw new Error(String(error).slice(0, 300));
  return true;
}

export async function defaultSaveName(dir, sourcePath, { fsp = fs.promises } = {}) {
  const ext = path.extname(sourcePath);
  const stem = path.basename(sourcePath, ext);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = path.join(dir, n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`);
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${stem}${ext}`);
}

export function collisionFreeDownloadPath(dir, sourcePath, { existsSync = fs.existsSync } = {}) {
  const fileName = path.basename(sourcePath);
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  for (let n = 0; ; n += 1) {
    const candidate = path.join(dir, n === 0 ? fileName : `${stem} (${n})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}
