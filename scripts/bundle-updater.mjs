// Bundle electron-updater into one self-contained file the packaged app can
// require. This app ships ZERO node_modules at runtime (the harness + UI are
// pre-compiled into Resources), so a main-process dependency has to be
// vendored. esbuild inlines electron-updater + its whole dep tree; `electron`
// stays external (resolved from the runtime). Output ships via files:electron/**.
//
// The bundle is then patched so an AppImage update keeps the path the user
// launches — see scripts/patch-appimage-updater.mjs for why.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

import { patchAppImageUpdater } from "./patch-appimage-updater.mjs";
import { patchMacUpdater } from "./patch-mac-updater.mjs";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "electron/vendor/electron-updater.cjs");
const entryPoint = require.resolve("electron-updater");

await build({
  entryPoints: [entryPoint],
  // Keep source labels reproducible when an isolated worktree reuses the
  // identical node_modules tree through a symlink.
  absWorkingDir: entryPoint.split(`${sep}node_modules${sep}`)[0],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron"],
  outfile,
  logLevel: "info",
});

// Throws when upstream's shape moved, so a bundle that would silently break
// AppImage launchers never reaches a release.
await writeFile(outfile, patchMacUpdater(patchAppImageUpdater(await readFile(outfile, "utf8"))));
console.log("patched AppImage replacement and native Mac staging readiness");
