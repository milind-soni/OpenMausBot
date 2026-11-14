// electron-updater installs an AppImage update under the release asset's name
// and unlinks the old file, breaking every launcher entry that points at the
// versioned path. Upstream overwrites in place only when the running file's
// name has no version, so force that branch.

// esbuild renames the imported `path` module per build (path2, path3, …), so
// match the identifier instead of pinning one. The back-reference keeps this
// from matching an unrelated join().
const RENAME_ASSIGNMENT =
  /destination = (\w+)\.join\(\1\.dirname\(appImageFile\), \1\.basename\(installerPath\)\);/g;

const IN_PLACE_ASSIGNMENT = "destination = appImageFile;";

// Upstream also unlinks the running AppImage before validating anything, then
// `mv`s the staged download from the updater cache, which may be on another
// filesystem. Instead: move into a sibling of the destination, then rename(2)
// over it atomically; nothing is removed until the replacement is complete.
const UNLINK_BEFORE_INSTALL = /^\s*\(0, fs_1\.unlinkSync\)\(appImageFile\);\n/m;

const MOVE_INTO_PLACE =
  /\(0, child_process_1\.execFileSync\)\("mv", \["-f", installerPath, destination\]\);/;

const ATOMIC_MOVE = [
  'const stagedDestination = `${destination}.new`;',
  '(0, child_process_1.execFileSync)("mv", ["-f", installerPath, stagedDestination]);',
  "(0, fs_1.renameSync)(stagedDestination, destination);",
].join("\n        ");

// BaseUpdater starts doInstall before it asks Electron to quit, so an immediate
// spawn can reach the data-directory lease while the old desktop is still
// cleaning up. Electron's relauncher waits for this process to exit instead.
const IMMEDIATE_RELAUNCH = /this\.spawnLog\(destination, \[\], env\);/g;
const QUEUED_RELAUNCH = [
  'const previousSilentInstall = process.env.APPIMAGE_SILENT_INSTALL;',
  'try {',
  '  process.env.APPIMAGE_SILENT_INSTALL = env.APPIMAGE_SILENT_INSTALL;',
  '  if (require("electron").app.relaunch({ execPath: destination, args: [] }) === false) {',
  '    throw new Error("Could not schedule the updated AppImage to restart");',
  '  }',
  '} finally {',
  '  if (previousSilentInstall === undefined) delete process.env.APPIMAGE_SILENT_INSTALL;',
  '  else process.env.APPIMAGE_SILENT_INSTALL = previousSilentInstall;',
  '}',
].join("\n          ");

const REPLACEMENTS = [
  ["rename branch", RENAME_ASSIGNMENT, IN_PLACE_ASSIGNMENT],
  ["unlink before install", UNLINK_BEFORE_INSTALL, ""],
  ["move into place", MOVE_INTO_PLACE, ATOMIC_MOVE],
  ["immediate relaunch", IMMEDIATE_RELAUNCH, QUEUED_RELAUNCH],
];

/**
 * Throws when any step's upstream shape moved: a silently unpatched bundle would
 * ship the launcher-breaking behaviour again.
 */
export function patchAppImageUpdater(source) {
  let patched = source;
  for (const [label, pattern, replacement] of REPLACEMENTS) {
    const found = patched.match(pattern);
    const count = found ? (pattern.global ? found.length : 1) : 0;
    if (count !== 1) {
      throw new Error(
        `Expected exactly 1 AppImage "${label}" site to patch, found ${count}. ` +
          "electron-updater's AppImageUpdater.doInstall changed shape — re-read it and update " +
          "scripts/patch-appimage-updater.mjs before releasing.",
      );
    }
    patched = patched.replace(pattern, replacement);
  }
  return patched;
}
