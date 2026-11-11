// Stage the macOS CUA executable and native SDK outside ASAR. The npm SDK does
// not ship the `cua-driver` CLI, so packaging fails loudly without one.
// CUA_DRIVER_PATH is the CI/release override; otherwise an exact-version
// installed binary or the checksummed official release asset.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, chmod, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { resolveCuaMacArches } from "./cua-mac-arches.mjs";
import { LIPO_ARCH, writeThinMachO } from "./mac-thin.mjs";

if (process.platform !== "darwin") throw new Error("prepare-cua is macOS-only");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const stage = join(root, "dist-native");
const sdkEntry = fileURLToPath(import.meta.resolve("@trycua/cua-driver"));
const sdkRoot = realpathSync(join(dirname(sdkEntry), ".."));
const dependencyRoot = join(sdkRoot, "..", "..");
const sdkPackage = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
const expectedVersion = String(sdkPackage.version);
const release = {
  version: "0.45.4",
  file: "cua-driver-rs-0.45.4-darwin-universal-binary.tar.gz",
  sha256: "7dff49530847419828770a1737788cd50642026c0d679a9a4ef383259db94ac5",
};
if (expectedVersion !== release.version) {
  throw new Error(
    `CUA SDK ${expectedVersion} has no pinned executable asset in prepare-cua.mjs; update the release checksum first`,
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
  const cache = join(root, "node_modules", ".cache", "openmausbot", `cua-driver-${release.version}`);
  const cachedBinary = join(cache, "cua-driver");
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
  await run("/usr/bin/tar", ["-xzf", archive, "-C", cache, "cua-driver"]);
  await chmod(cachedBinary, 0o755);
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
  // The locally installed app may be a single-arch build; both shipped arches
  // need it, so fall back to the official universal binary rather than fail.
  const installed = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
  const installedUniversal = async () => {
    try {
      const { stdout } = await run("/usr/bin/lipo", ["-archs", installed]);
      return stdout.includes("arm64") && stdout.includes("x86_64");
    } catch {
      return false;
    }
  };
  binary =
    (await binaryVersion(installed)) === expectedVersion && (await installedUniversal())
      ? installed
      : await officialBinary();
}
const details = await stat(binary);
if (!details.isFile() || (details.mode & 0o111) === 0) {
  throw new Error(`cua-driver is not an executable file: ${binary}`);
}

// Each mac arch's staging dir (picked via ${arch} in extraResources) gets only
// its own slice of the universal driver and SDK files. The driver is asserted
// universal, so a non-universal pin fails here rather than on an Intel Mac.
const MAC_ARCHES = resolveCuaMacArches(process.env);

const { stdout: archList } = await run("/usr/bin/lipo", ["-archs", binary]);
for (const arch of MAC_ARCHES) {
  const lipoName = LIPO_ARCH[arch];
  if (!archList.trim().split(/\s+/).includes(lipoName)) {
    throw new Error(`cua-driver at ${binary} is not universal: has [${archList.trim()}], needs ${lipoName}`);
  }
}

for (const arch of MAC_ARCHES) {
  const archStage = join(stage, arch);
  await rm(archStage, { recursive: true, force: true });
  await mkdir(archStage, { recursive: true });
  await writeThinMachO(binary, join(archStage, "cua-driver"), LIPO_ARCH[arch]);
  await chmod(join(archStage, "cua-driver"), 0o755);
  // A binary copied out of CuaDriver.app keeps a bundle-relative signature whose
  // Info.plist is gone; electron-builder replaces this temporary one.
  await run("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", join(archStage, "cua-driver")]);

  const nativeDir = join(archStage, "cua-sdk", "native");
  const nativePackage = join(dependencyRoot, "@trycua", `cua-driver-darwin-${arch}`);
  if (!existsSync(nativePackage)) {
    throw new Error(
      `required CUA darwin-${arch} native package is missing — is supportedArchitectures.cpu set in pnpm-workspace.yaml?`,
    );
  }
  await mkdir(nativeDir, { recursive: true });
  await Promise.all(["libcua_driver_sdk.dylib", "cua_driver_node_runtime.node"].map((name) =>
    writeThinMachO(join(realpathSync(nativePackage), name), join(nativeDir, name), LIPO_ARCH[arch])));
}

// One ESM file, so electron-builder's node_modules exclusion cannot drop it. The
// SDK's @ubjs native lookups are redirected to the files staged beside it.
const bundle = join(stage, MAC_ARCHES[0], "cua-sdk", "cua-sdk.mjs");
await build({
  stdin: {
    contents: [
      'export { EmbeddedCuaDriverHost } from "@trycua/cua-driver/embedded";',
      'export { requestMacOSPermissions, hasRequiredMacOSPermissions } from "@trycua/cua-driver/electron";',
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

for (const arch of MAC_ARCHES.slice(1)) {
  await copyFile(bundle, join(stage, arch, "cua-sdk", "cua-sdk.mjs"));
}

console.log(`Staged CUA for ${MAC_ARCHES.join(" + ")} from ${binary}`);
