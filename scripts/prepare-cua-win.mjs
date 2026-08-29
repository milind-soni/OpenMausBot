// Stage the pinned Windows CUA executable and native SDK outside ASAR.
// The release archive is checksum-verified before extraction; Electron then
// owns the embedded daemon and exposes only its stdio MCP proxy to agents.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

if (process.platform !== "win32") throw new Error("prepare-cua-win is Windows-only");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const stage = join(root, "dist-native", "win32-x64");
const cache = join(root, "node_modules", ".cache", "openmausbot", "cua-driver-0.22.1-win32-x64");
const release = Object.freeze({
  version: "0.22.1",
  file: "cua-driver-rs-0.22.1-windows-x86_64-binary.zip",
  sha256: "e7d48af7461435903a4fe7e5ae20ba493998bc24a04b5d355c49fdc184b86f4e",
});

async function binaryVersion(candidate) {
  if (!candidate || !existsSync(candidate)) return null;
  try {
    const { stdout } = await run(candidate, ["--version"], { timeout: 5000 });
    return stdout.match(/cua-driver\s+([\d.]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function releaseDirectory() {
  const cachedBinary = join(cache, "cua-driver.exe");
  if ((await binaryVersion(cachedBinary)) === release.version) return cache;
  await rm(cache, { recursive: true, force: true });
  await mkdir(cache, { recursive: true });
  const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${release.version}/${release.file}`;
  console.log(`Downloading CUA Driver ${release.version} for Windows from the official release…`);
  const response = await fetch(url, { headers: { "user-agent": "OpenMausBot-packager" } });
  if (!response.ok) throw new Error(`CUA Driver download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== release.sha256) {
    throw new Error(`CUA Driver checksum mismatch: expected ${release.sha256}, got ${digest}`);
  }
  const archive = join(cache, release.file);
  await writeFile(archive, bytes);
  await run("tar.exe", ["-xf", archive, "-C", cache], { timeout: 60_000 });
  await rm(archive, { force: true });
  if ((await binaryVersion(cachedBinary)) !== release.version) {
    throw new Error(`downloaded CUA Driver does not report version ${release.version}`);
  }
  return cache;
}

const source = await releaseDirectory();
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const file of [
  "cua-driver.exe",
  "cua-driver-uia.exe",
  "cua-cursor-theme.exe",
  "cua_driver_sdk.dll",
  "cua_driver_node_runtime.node",
]) {
  await copyFile(join(source, file), join(stage, file));
}

const sdkEntry = fileURLToPath(import.meta.resolve("@trycua/cua-driver"));
const sdkRoot = realpathSync(join(dirname(sdkEntry), ".."));
const sdkPackage = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
if (String(sdkPackage.version) !== release.version) {
  throw new Error(`CUA SDK ${sdkPackage.version} does not match driver ${release.version}`);
}
const bundle = join(stage, "cua-sdk.mjs");
await build({
  stdin: {
    contents: 'export { EmbeddedCuaDriverHost, EmbeddedDriverHostOptions } from "@trycua/cua-driver/embedded";',
    resolveDir: root,
    sourcefile: "openmausbot-cua-win-entry.mjs",
    loader: "js",
  },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: {
    js: 'import { createRequire as __openmausbotCreateRequire } from "node:module"; const require = __openmausbotCreateRequire(import.meta.url);',
  },
  outfile: bundle,
  logLevel: "silent",
});
const bundledSource = await readFile(bundle, "utf8");
const resolverPattern = /function resolveLibPath\d*\(opts\) \{/g;
const resolvers = bundledSource.match(resolverPattern) ?? [];
if (resolvers.length !== 1) throw new Error("could not patch the bundled CUA native-library resolver");
await writeFile(
  bundle,
  bundledSource.replace(
    resolverPattern,
    `${resolvers[0]}\n      if (process.env.OPENMAUSBOT_CUA_SDK_LIBRARY) return resolveOverride(opts.crateName, process.env.OPENMAUSBOT_CUA_SDK_LIBRARY);`,
  ),
);

console.log(`Staged CUA Driver ${release.version} for Windows x64`);
