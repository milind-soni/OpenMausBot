// Windows CUA smoke: prove the staged win32 SDK bundle loads through the same
// env-var redirect the packaged app uses and that one embedded driver host can
// start and stop. Mirrors electron/cua.mjs startEmbedded(); run it after
// `pnpm build:cua:win`, which produces dist-native/cua-win32-x64/.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { assertNoHelperWindows } from "./testing/windows-helper-windows.mjs";

if (process.platform !== "win32") {
  console.error("smoke-cua-win-embedded is Windows-only");
  process.exit(1);
}

const stage = process.env.OMB_CUA_RESOURCES ?? join(import.meta.dirname, "..", "dist-native", "cua-win32-x64");
const binary = join(stage, "cua-driver.exe");
const bundle = join(stage, "cua-sdk", "cua-sdk.mjs");
const dll = join(stage, "cua-sdk", "native", "cua_driver_sdk.dll");

for (const [label, file] of [["cua-driver.exe", binary], ["cua-sdk bundle", bundle], ["sdk dll", dll]]) {
  if (!existsSync(file)) {
    console.error(`staged ${label} is missing at ${file} — run pnpm build:cua:win first`);
    process.exit(1);
  }
}

// The bundled resolver patch (prepare-cua-win.mjs) redirects the SDK's native
// library lookup to exactly this path; verify the redirect is present, or the
// packaged app would fall back to node_modules paths that do not exist.
const bundledSource = readFileSync(bundle, "utf8");
if (!bundledSource.includes("OPENMAUSBOT_CUA_SDK_LIBRARY")) {
  console.error("staged cua-sdk.mjs lacks the OPENMAUSBOT_CUA_SDK_LIBRARY resolver patch — re-run pnpm build:cua:win");
  process.exit(1);
}

process.env.OPENMAUSBOT_CUA_SDK_LIBRARY = dll;
process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "0";
const watchdog = setTimeout(() => {
  console.error("smoke:cua-win timed out");
  process.exit(1); // Closing the host also closes the daemon's parent-liveness pipe.
}, 30_000);

const sdk = await import(pathToFileURL(bundle).href);
if (typeof sdk.EmbeddedCuaDriverHost !== "function") {
  console.error("staged bundle does not export EmbeddedCuaDriverHost");
  process.exit(1);
}

const host = new sdk.EmbeddedCuaDriverHost(binary, "com.openmausbot.app");
try {
  const conn = await host.start({ signal: AbortSignal.timeout(15_000) });
  if (!conn?.socketPath) throw new Error("embedded host reported no socketPath");
  await assertNoHelperWindows([binary]);
  console.log("embedded host started:", {
    pid: conn.pid,
    driverVersion: conn.driverVersion,
    contractVersion: conn.contractVersion,
    socketPath: conn.socketPath,
  });
  await host.stop();
  host.uniffiDestroy?.();
  if (!Number.isInteger(conn.pid) || conn.pid <= 0) throw new Error("missing daemon PID");
  const running = () => {
    try { process.kill(conn.pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  for (let attempt = 0; attempt < 50 && running(); attempt++) await delay(100);
  if (running()) throw new Error("owned daemon survived host.stop()");
  clearTimeout(watchdog);
  console.log("smoke:cua-win OK — staged bundle drives a real embedded host");
} catch (err) {
  try {
    await host.stop();
  } catch {
    // startup already failed; stop is best-effort before destroy
  }
  host.uniffiDestroy?.();
  console.error("smoke:cua-win FAILED:", err);
  process.exit(1);
}
