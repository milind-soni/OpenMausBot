const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STAGE_PREFIX = "openmausbot-cua-linux-x64-";
const FILES = Object.freeze({
  "cua-driver": "ed5844fadf07b9b72c4a3b3802e1c47233c166d66d6198608d5991f807aab4ac",
  "cua-cursor-theme": "e589b2b7521bbfeaf9e2bfce668a38e80ed1b9790b1327b13d374fc331d8312a",
});

function sha256(file, fileSystem = fs) {
  return createHash("sha256").update(fileSystem.readFileSync(file)).digest("hex");
}

function stageAppImageCuaBundle({
  resourcesPath,
  temporaryRoot = os.tmpdir(),
  fileSystem = fs,
  files = FILES,
} = {}) {
  if (!path.isAbsolute(resourcesPath) || !path.isAbsolute(temporaryRoot)) {
    throw new Error("AppImage CUA staging paths must be absolute");
  }
  const sourceRoot = path.join(resourcesPath, "cua-linux-x64");
  const stageDirectory = fileSystem.mkdtempSync(path.join(temporaryRoot, STAGE_PREFIX));
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
  STAGE_PREFIX,
  cleanupAppImageCuaBundle,
  stageAppImageCuaBundle,
};
