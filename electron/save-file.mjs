import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

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

// Paths come from model-rendered markdown, so they are untrusted. Resolve the
// root and target before checking containment, then retain the target identity
// for the open step below.
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

// Kept as a narrow validation seam for callers and tests that only need the
// canonical path. The save flow uses withSavableFile so it cannot forget to
// close the stable source handle.
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

// The callback owns the save operation while this module owns the source
// handle. This keeps validation, stable copying, and cleanup at one seam.
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

// The name the save dialog opens on: "report.docx", or "report (2).docx" when
// that already exists, so accepting the default never quietly replaces an
// earlier download. Only a suggestion — the user can type over it, and the
// dialog's own overwrite confirmation covers the final choice. Bounded so a
// directory full of collisions cannot spin forever.
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
