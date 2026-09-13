// Windows CUA smoke: prove the staged win32 SDK bundle loads through the same
// env-var redirect the packaged app uses and that one embedded driver host can
// start and stop. Mirrors electron/cua.mjs startEmbedded(); run it after
// `pnpm build:cua:win`, which produces dist-native/cua-win32-x64/.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

if (process.platform !== "win32") {
  console.error("smoke-cua-win-embedded is Windows-only");
  process.exit(1);
}

const stage = join(import.meta.dirname, "..", "dist-native", "cua-win32-x64");
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

const sdk = await import(pathToFileURL(bundle).href);
if (typeof sdk.EmbeddedCuaDriverHost !== "function") {
  console.error("staged bundle does not export EmbeddedCuaDriverHost");
  process.exit(1);
}

const host = new sdk.EmbeddedCuaDriverHost(binary, "com.openmausbot.app");
try {
  const conn = await host.start();
  if (!conn?.socketPath) throw new Error("embedded host reported no socketPath");
  console.log("embedded host started:", {
    pid: conn.pid,
    driverVersion: conn.driverVersion,
    contractVersion: conn.contractVersion,
    socketPath: conn.socketPath,
  });
  await host.stop();
  host.uniffiDestroy?.();
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
