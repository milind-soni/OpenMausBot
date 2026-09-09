// electron-updater installs an AppImage update by writing the new file under
// the *release asset's* name and unlinking the old one. Our feed names assets
// after the version, so a user whose AppImage is called
// OpenMausBot-0.1.43-x86_64.AppImage ends up with a 0.1.44 file and nothing at
// the old path — every .desktop entry, symlink, dock pin and AppImageLauncher
// registration pointing at it breaks, and the app vanishes from the launcher.
//
// Upstream only overwrites in place when the running file has no version in
// its name. Force that branch unconditionally: the update lands on whatever
// path the user already launches, whatever they named it.
//
// Applied to the generated bundle by scripts/bundle-updater.mjs, and asserted
// on the committed artifact by electron/vendor-updater.node-test.mjs.

// esbuild renames the imported `path` module per build (path2, path3, …), so
// match the identifier instead of pinning one. The back-reference keeps this
// from matching an unrelated join().
const RENAME_ASSIGNMENT =
  /destination = (\w+)\.join\(\1\.dirname\(appImageFile\), \1\.basename\(installerPath\)\);/g;

const IN_PLACE_ASSIGNMENT = "destination = appImageFile;";

// Upstream also deletes the running AppImage before it has validated anything
// and before the replacement exists:
//
//   unlinkSync(appImageFile);
//   const installerPath = this.installerPath;
//   if (installerPath == null) { …; return false; }   // app already deleted
//   execFileSync("mv", ["-f", installerPath, destination]);
//
// Anything that fails past that first line leaves the user with no
// application at all. A failed update should cost them nothing. The staged
// download also lives in the updater cache, which can sit on another
// filesystem, so `mv` may fall back to copy-then-unlink and write into the
// destination while it is still a running executable.
//
// Land it in two steps instead. Moving into a sibling of the destination
// absorbs any cross-filesystem copy, then rename(2) within a single directory
// replaces the old file atomically and works over a running binary. Nothing
// is removed until the replacement is complete.
const UNLINK_BEFORE_INSTALL = /^\s*\(0, fs_1\.unlinkSync\)\(appImageFile\);\n/m;

const MOVE_INTO_PLACE =
  /\(0, child_process_1\.execFileSync\)\("mv", \["-f", installerPath, destination\]\);/;

const ATOMIC_MOVE = [
  'const stagedDestination = `${destination}.new`;',
  '(0, child_process_1.execFileSync)("mv", ["-f", installerPath, stagedDestination]);',
  "(0, fs_1.renameSync)(stagedDestination, destination);",
].join("\n        ");

// BaseUpdater starts doInstall before it asks Electron to quit. An immediate
// spawn can reach the data-directory lease while the old desktop is still
// cleaning up. Electron's relauncher waits for this process to exit instead;
// keep the original AppImage path, not the executable inside its old mount.
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
 * Keep an AppImage update on the running file's path, and never remove that
 * file until the replacement is in place. Queue its restart after the old
 * process exits, without weakening the desktop's data-directory lease.
 *
 * Throws when any step's upstream shape moved: a silently unpatched bundle
 * would ship the launcher-breaking behaviour again.
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
