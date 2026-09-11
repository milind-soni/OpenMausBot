// Stage the Windows CUA executable and native SDK outside ASAR.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

if (process.platform !== "win32") throw new Error("prepare-cua-win is Windows-only");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const stage = join(root, "dist-native", "cua-win32-x64");
const sdkEntry = fileURLToPath(import.meta.resolve("@trycua/cua-driver"));
const sdkRoot = realpathSync(join(dirname(sdkEntry), ".."));
const dependencyRoot = join(sdkRoot, "..", "..");
const sdkPackage = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
const expectedVersion = String(sdkPackage.version);

const release = {
  version: "0.22.1",
  file: "cua-driver-rs-0.22.1-windows-x86_64-binary.zip",
  sha256: "e7d48af7461435903a4fe7e5ae20ba493998bc24a04b5d355c49fdc184b86f4e",
};

if (expectedVersion !== release.version) {
  throw new Error(
    `CUA SDK ${expectedVersion} has no pinned executable asset in prepare-cua-win.mjs; update the release checksum first`,
  );
}

async function binaryVersion(candidate) {
  if (!candidate || !existsSync(candidate)) return null;
  try {
    const { stdout } = await run(candidate, ["--version"], { timeout: 5000 });
    return stdout.match(/cua-driver\s+([\d.]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function officialBinary() {
  const cache = join(root, "node_modules", ".cache", "openmausbot", `cua-driver-${release.version}-win`);
  const cachedBinary = join(cache, "cua-driver.exe");
  if ((await binaryVersion(cachedBinary)) === expectedVersion) return cachedBinary;

  await rm(cache, { recursive: true, force: true });
  await mkdir(cache, { recursive: true });
  const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${release.version}/${release.file}`;
  console.log(`Downloading CUA Driver ${release.version} from the official release…`);
  const response = await fetch(url, { headers: { "user-agent": "OpenMausBot-packager" } });
  if (!response.ok) throw new Error(`CUA Driver download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== release.sha256) {
    throw new Error(`CUA Driver checksum mismatch: expected ${release.sha256}, got ${digest}`);
  }
  const archive = join(cache, release.file);
  await writeFile(archive, bytes);
  await run("powershell", ["-Command", `Expand-Archive -Path "${archive}" -DestinationPath "${cache}"`]);
  if ((await binaryVersion(cachedBinary)) !== expectedVersion) {
    throw new Error(`downloaded CUA Driver does not report version ${expectedVersion}`);
  }
  return cachedBinary;
}

let binary;
if (process.env.CUA_DRIVER_PATH) {
  const suppliedVersion = await binaryVersion(process.env.CUA_DRIVER_PATH);
  if (suppliedVersion !== expectedVersion) {
    throw new Error(
      `CUA_DRIVER_PATH must point to cua-driver ${expectedVersion}; found ${suppliedVersion ?? "an unreadable binary"}`,
    );
  }
  binary = process.env.CUA_DRIVER_PATH;
} else {
  const nativePackage = join(dependencyRoot, "@trycua", "cua-driver-win32-x64-msvc");
  if (!existsSync(nativePackage)) {
    throw new Error(
      `required CUA win32-x64 native package is missing — is pnpm.supportedArchitectures.cpu set in package.json?`,
    );
  }
  const candidate = join(realpathSync(nativePackage), "cua_driver.exe");
  if (!existsSync(candidate)) {
    binary = await officialBinary();
  } else {
    binary = candidate;
  }
}

const details = await stat(binary);
if (!details.isFile()) {
  throw new Error(`cua-driver is not a file: ${binary}`);
}

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await copyFile(binary, join(stage, "cua-driver.exe"));

const nativeDir = join(stage, "cua-sdk", "native");
const winNativePackage = join(dependencyRoot, "@trycua", "cua-driver-win32-x64-msvc");
if (!existsSync(winNativePackage)) {
  throw new Error(
    `required CUA win32-x64 native package is missing`,
  );
}
await mkdir(nativeDir, { recursive: true });
await Promise.all([
  copyFile(join(realpathSync(winNativePackage), "cua_driver_sdk.dll"), join(nativeDir, "cua_driver_sdk.dll")),
  copyFile(join(realpathSync(winNativePackage), "cua_driver_node_runtime.node"), join(nativeDir, "cua_driver_node_runtime.node")),
]);

const bundle = join(stage, "cua-sdk", "cua-sdk.mjs");
await build({
  stdin: {
    contents: [
      'export { EmbeddedCuaDriverHost } from "@trycua/cua-driver/embedded";',
    ].join("\n"),
    resolveDir: root,
    sourcefile: "openmausbot-cua-entry.mjs",
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
// Same redirect as prepare-cua.mjs: the SDK resolves its native library
// through @ubjs at runtime; patch the bundled resolver so
// OPENMAUSBOT_CUA_SDK_LIBRARY (set by electron/cua.mjs to the staged DLL)
// wins over the node_modules lookups that do not exist in the packaged app.
const bundledSource = await readFile(bundle, "utf8");
const resolverPattern = /function resolveLibPath\d*\(opts\) \{/g;
const resolvers = bundledSource.match(resolverPattern) ?? [];
if (resolvers.length !== 1) {
  throw new Error("could not patch the bundled CUA native-library resolver");
}
await writeFile(
  bundle,
  bundledSource.replace(
    resolverPattern,
    `${resolvers[0]}\n      if (process.env.OPENMAUSBOT_CUA_SDK_LIBRARY) return resolveOverride(opts.crateName, process.env.OPENMAUSBOT_CUA_SDK_LIBRARY);`,
  ),
);

console.log(`Staged CUA for win32-x64 from ${binary}`);