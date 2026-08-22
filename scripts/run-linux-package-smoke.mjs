import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prefixName = "omb-linux-smoke-runtime-";
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function cleanupRuntime(directory) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch {
      // dbus-run-session can exit just before a portal-owned runtime socket
      // disappears. Give that bounded teardown a moment before treating a
      // persistent runtime as a lifecycle failure.
      await delay(100);
    }
  }
  throw new Error(`[run-linux-package-smoke] could not clean released runtime ${directory}`);
}
const appImages = readdirSync(path.join(root, "release")).filter((name) => name.endsWith(".AppImage"));
if (appImages.length !== 1) {
  throw new Error(`[run-linux-package-smoke] expected exactly one AppImage, found ${appImages.length}`);
}
const [appImage] = appImages;

for (const executable of [
  path.join(root, "release", "linux-unpacked", "openmausbot"),
  path.join(root, "release", appImage),
]) {
  const runtimeDirectory = mkdtempSync(path.join(tmpdir(), prefixName));
  chmodSync(runtimeDirectory, 0o700);
  const bundled = spawnSync(
    "dbus-run-session",
    ["--", "xvfb-run", "-a", process.execPath, path.join(root, "scripts", "smoke-linux-package.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: runtimeDirectory,
        OMB_SMOKE_BUNDLED_CUA: "1",
        OMB_SMOKE_EXECUTABLE: executable,
      },
      stdio: "inherit",
    },
  );
  if (bundled.error) throw bundled.error;
  if (bundled.status !== 0) {
    console.error(`[run-linux-package-smoke] bundled runtime kept at ${runtimeDirectory}`);
    process.exitCode = bundled.status ?? 1;
    break;
  }
  await cleanupRuntime(runtimeDirectory);
}

if (process.exitCode === undefined) for (const lane of [
  { name: "x11", wayland: false, hardDeath: false },
  { name: "wayland", wayland: true, hardDeath: false },
  { name: "x11-hard-death", wayland: false, hardDeath: true },
]) {
  const runtimeDirectory = mkdtempSync(path.join(tmpdir(), prefixName));
  if (
    path.dirname(runtimeDirectory) !== path.resolve(tmpdir()) ||
    !path.basename(runtimeDirectory).startsWith(prefixName)
  ) {
    throw new Error(`[run-linux-package-smoke] unexpected temporary path: ${runtimeDirectory}`);
  }

  chmodSync(runtimeDirectory, 0o700);
  const result = spawnSync(
    "dbus-run-session",
    ["--", "xvfb-run", "-a", process.execPath, path.join(root, "scripts", "smoke-linux-package.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: runtimeDirectory,
        OMB_SMOKE_WAYLAND: lane.wayland ? "1" : "0",
        OMB_SMOKE_HARD_DEATH: lane.hardDeath ? "1" : "0",
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`[run-linux-package-smoke] ${lane.name} runtime kept at ${runtimeDirectory}`);
    process.exitCode = result.status ?? 1;
    break;
  }
  await cleanupRuntime(runtimeDirectory);
}
