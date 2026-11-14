const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STAGE_PREFIX = "openmausbot-cua-linux-x64-";
const LEGACY_STAGE_GRACE_MS = 10 * 60 * 1000;
const FILES = Object.freeze({
  "cua-driver": "83030028e7c9e3f4d753b3b27025135d44eb8d52f562cce0aaaf95777bc1b41f",
  "cua-cursor-theme": "d39efb960d207e7328d7a9dd48e3b6565f74be073f9c2ca8dcba86a4d0f28312",
});

function sha256(file, fileSystem = fs) {
  return createHash("sha256").update(fileSystem.readFileSync(file)).digest("hex");
}

function processIsAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processReferencesDirectory(directory, {
  fileSystem = fs,
  procRoot = "/proc",
} = {}) {
  let processes;
  try {
    processes = fileSystem.readdirSync(procRoot);
  } catch {
    // Cleanup is optional; deleting a stage that might still be in use is not.
    return true;
  }
  for (const processName of processes) {
    if (!/^\d+$/.test(processName)) continue;
    for (const linkName of ["exe", "cwd"]) {
      let target;
      try {
        target = fileSystem.readlinkSync(path.join(procRoot, processName, linkName));
      } catch {
        continue;
      }
      const liveTarget = target.endsWith(" (deleted)") ? target.slice(0, -10) : target;
      if (liveTarget === directory || liveTarget.startsWith(`${directory}${path.sep}`)) return true;
    }
  }
  return false;
}

function safeStageContents(directory, {
  currentUid = process.getuid?.(),
  fileSystem = fs,
  files = FILES,
} = {}) {
  let entries;
  try {
    entries = fileSystem.readdirSync(directory);
  } catch {
    return false;
  }
  for (const name of entries) {
    const expectedHash = files[name];
    if (!expectedHash) return false;
    const candidate = path.join(directory, name);
    let details;
    try {
      details = fileSystem.lstatSync(candidate);
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        details.uid !== currentUid ||
        (details.mode & 0o777) !== 0o755 ||
        sha256(candidate, fileSystem) !== expectedHash
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function reapStaleAppImageCuaBundles({
  temporaryRoot = os.tmpdir(),
  currentUid = process.getuid?.(),
  fileSystem = fs,
  files = FILES,
  isDirectoryActive = (directory) => processReferencesDirectory(directory, { fileSystem }),
  isProcessAlive = processIsAlive,
  legacyGraceMs = LEGACY_STAGE_GRACE_MS,
  now = Date.now(),
} = {}) {
  if (!path.isAbsolute(temporaryRoot) || !Number.isInteger(currentUid)) return [];
  let names;
  try {
    names = fileSystem.readdirSync(temporaryRoot);
  } catch {
    return [];
  }
  const removed = [];
  const escapedPrefix = STAGE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const candidatePattern = new RegExp(`^${escapedPrefix}(?:(\\d+)-)?[A-Za-z0-9]{6}$`);
  for (const name of names) {
    const match = candidatePattern.exec(name);
    if (!match) continue;
    const directory = path.join(temporaryRoot, name);
    let details;
    try {
      details = fileSystem.lstatSync(directory);
    } catch {
      continue;
    }
    if (
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      details.uid !== currentUid ||
      (details.mode & 0o777) !== 0o700
    ) {
      continue;
    }
    const ownerPid = match[1] ? Number(match[1]) : null;
    if (ownerPid !== null && isProcessAlive(ownerPid)) continue;
    if (ownerPid === null && now - details.mtimeMs < legacyGraceMs) continue;
    if (isDirectoryActive(directory)) continue;
    if (!safeStageContents(directory, { currentUid, fileSystem, files })) continue;
    try {
      fileSystem.rmSync(directory, { recursive: true, force: false });
      removed.push(directory);
    } catch {
    }
  }
  return removed;
}

function stageAppImageCuaBundle({
  resourcesPath,
  temporaryRoot = os.tmpdir(),
  fileSystem = fs,
  files = FILES,
  processId = process.pid,
} = {}) {
  if (
    !path.isAbsolute(resourcesPath) ||
    !path.isAbsolute(temporaryRoot) ||
    !Number.isSafeInteger(processId) ||
    processId <= 0
  ) {
    throw new Error("AppImage CUA staging paths must be absolute");
  }
  const sourceRoot = path.join(resourcesPath, "cua-linux-x64");
  const stageDirectory = fileSystem.mkdtempSync(
    path.join(temporaryRoot, `${STAGE_PREFIX}${processId}-`),
  );
  fileSystem.chmodSync(stageDirectory, 0o700);
  try {
    for (const [name, expectedHash] of Object.entries(files)) {
      const source = path.join(sourceRoot, name);
      const sourceDetails = fileSystem.lstatSync(source);
      if (!sourceDetails.isFile() || sourceDetails.isSymbolicLink()) {
        throw new Error(`AppImage CUA source must be a regular file: ${name}`);
      }
      const destination = path.join(stageDirectory, name);
      fileSystem.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      fileSystem.chmodSync(destination, 0o755);
      const destinationDetails = fileSystem.lstatSync(destination);
      if (
        !destinationDetails.isFile() ||
        destinationDetails.isSymbolicLink() ||
        (destinationDetails.mode & 0o777) !== 0o755 ||
        sha256(destination, fileSystem) !== expectedHash
      ) {
        throw new Error(`AppImage CUA staged file failed integrity validation: ${name}`);
      }
    }
    return Object.freeze({
      directory: stageDirectory,
      driverPath: path.join(stageDirectory, "cua-driver"),
    });
  } catch (error) {
    fileSystem.rmSync(stageDirectory, { recursive: true, force: true });
    throw error;
  }
}

function cleanupAppImageCuaBundle(stage, {
  temporaryRoot = os.tmpdir(),
  fileSystem = fs,
} = {}) {
  const directory = stage?.directory;
  if (
    !path.isAbsolute(directory ?? "") ||
    path.dirname(directory) !== path.resolve(temporaryRoot) ||
    !path.basename(directory).startsWith(STAGE_PREFIX)
  ) {
    throw new Error("refusing to clean an unexpected AppImage CUA stage");
  }
  const details = fileSystem.lstatSync(directory, { throwIfNoEntry: false });
  if (!details) return;
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("refusing to clean a replaced AppImage CUA stage");
  }
  fileSystem.rmSync(directory, { recursive: true, force: false });
}

module.exports = {
  FILES,
  LEGACY_STAGE_GRACE_MS,
  STAGE_PREFIX,
  cleanupAppImageCuaBundle,
  reapStaleAppImageCuaBundles,
  stageAppImageCuaBundle,
};
