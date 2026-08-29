// Which file the companion sidecar is forked from, and with which Node flags.
//
// Pure on purpose: companion.mjs imports Electron and so cannot be loaded by
// the test runner, and the packaged/built/source ladder below is exactly the
// kind of decision that breaks silently — dev worked because someone had run
// `pnpm build:companion` months ago, packaged worked because CI stages the
// resources, and the one machine with neither got a toggle that lied.
import path from "node:path";

/** Where to fork the sidecar from, or null when nothing runnable exists.
 *
 * Packaged, only the staged resource counts — a packaged app has no sources.
 * In dev the compiled output is preferred when someone has built it (it is
 * what ships, so running it catches packaging drift), and the TypeScript
 * source is the fallback, run the same way the `companion` script in
 * package.json runs it: Node's own type stripping, no build step required.
 * `execArgv` travels with the entry because the two are one decision — the
 * source entry without the flag is a SyntaxError at fork. */
export function resolveCompanionEntry({ isPackaged, resourcesPath, appPath, exists }) {
  const packaged = path.join(resourcesPath, "companion", "index.js");
  if (isPackaged) return exists(packaged) ? { entry: packaged, execArgv: [] } : null;
  const built = path.join(appPath, "dist-companion", "index.js");
  if (exists(built)) return { entry: built, execArgv: [] };
  const source = path.join(appPath, "companion", "src", "index.ts");
  if (exists(source)) return { entry: source, execArgv: ["--experimental-strip-types"] };
  return null;
}

/** Locate the signed Android companion without trusting an inherited
 * environment variable. Packaged builds may only serve the exact staged
 * resource; development builds additionally accept the checked-out release
 * output so the local pairing route is useful after an Android build. */
export function resolveAndroidApk({ isPackaged, resourcesPath, appPath, exists }) {
  const staged = path.join(resourcesPath, "android", "OpenMaus-Chief.apk");
  const candidates = isPackaged
    ? [staged]
    : [
        staged,
        path.join(appPath, "android", "OpenMaus-Chief.apk"),
        path.join(appPath, "android", "app", "build", "outputs", "apk", "release", "app-release.apk"),
      ];
  return candidates.find(exists) ?? null;
}
