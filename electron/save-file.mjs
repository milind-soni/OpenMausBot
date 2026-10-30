import fs from "node:fs";
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

// Untrusted path: nothing here opens, reads or runs it. Network shares are refused, since merely looking one up can hand
// this computer's sign-in to whoever runs that server.
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
