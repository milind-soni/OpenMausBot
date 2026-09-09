// Download only reviewed vendor assets. Always extract anew from verified
// archives: a previous/partial dist-native tree is never a trusted cache.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { browserBundlePaths, browserBundleSpec } from "../server/browser-bundle-release.ts";
import { executableTarget } from "./prepare-cloudflared.mjs";

export const BROWSER_LICENSE_FILES = [
  "agent-browser-LICENSE.txt", "LICENSE-axe-core.txt", "LICENSE-axe-core-THIRD-PARTY.txt", "README.md",
];
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

export function targetsForPreparation({ current = false, target, platform = process.platform, arch = process.arch } = {}) {
  const targets = target ? [target] : current || platform !== "darwin" ? [`${platform}-${arch}`] : ["darwin-arm64", "darwin-x64"];
  for (const value of targets) browserBundleSpec(value);
  return targets;
}

export function parsePrepareBrowserArgs(args = []) {
  const options = { current: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--current" && !options.current && !options.target) options.current = true;
    else if (args[index] === "--target" && !options.target && !options.current && args[index + 1]) options.target = args[++index];
    else throw new Error("Usage: node scripts/prepare-browser.mjs [--current | --target PLATFORM-ARCH]");
  }
  targetsForPreparation(options);
  return options;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function verifyAssetBytes(bytes, asset) {
  if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) {
    throw new Error(`${asset.asset} failed pinned size/SHA-256 verification`);
  }
}

function inside(root, value) {
  const rel = relative(root, value);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Preserve vendor symlinks, but never permit one to escape the bundle. */
export function bundleInventory(directory) {
  const root = realpathSync(directory);
  const result = [];
  function visit(parent, prefix = "") {
    for (const name of readdirSync(parent).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (path === "manifest.json") continue;
      const file = join(parent, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(file);
        if (isAbsolute(target) || !inside(root, resolve(parent, target)) || !inside(root, realpathSync(file))) {
          throw new Error(`Browser resource symlink escapes its bundle: ${path}`);
        }
        result.push({ path, kind: "symlink", target });
      } else if (stat.isDirectory()) {
        result.push({ path, kind: "directory" });
        visit(file, path);
      } else if (stat.isFile()) {
        result.push({ path, kind: "file", bytes: stat.size, sha256: sha256(readFileSync(file)) });
      } else throw new Error(`Unsupported browser resource type: ${path}`);
    }
  }
  visit(root);
  return result;
}

function regularFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`Missing or invalid browser resource: ${file}`);
}

export function verifyBundleInventory(directory, files) {
  if (!Array.isArray(files) || JSON.stringify(files) !== JSON.stringify(bundleInventory(directory))) throw new Error("Browser bundle inventory is incomplete or modified");
}

/** Called before signing; Developer ID signing necessarily changes Mach-O bytes. */
export function verifyBrowserBundle(directory, target) {
  const spec = browserBundleSpec(target);
  const paths = browserBundlePaths(directory, target);
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Browser bundle must be a real directory");
  regularFile(paths.manifest);
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
  const { files, ...recordedSpec } = manifest;
  if (JSON.stringify(recordedSpec) !== JSON.stringify(spec)) throw new Error("Browser bundle manifest does not match the pinned release");
  for (const file of [paths.engine, paths.chrome, ...BROWSER_LICENSE_FILES.map((name) => join(paths.licenses, name)), join(directory, spec.chrome.license), join(directory, spec.chrome.about)]) regularFile(file);
  const engine = readFileSync(paths.engine);
  const chrome = readFileSync(paths.chrome);
  verifyAssetBytes(engine, spec.engine);
  if (sha256(chrome) !== spec.chrome.executableSha256) throw new Error("Browser executable failed pinned SHA-256 verification");
  if (executableTarget(engine) !== target || executableTarget(chrome) !== target) throw new Error(`Browser executable architecture does not match ${target}`);
  verifyBundleInventory(directory, files);
  return manifest;
}

export async function releaseBytes(asset, cacheDirectory) {
  const cached = cacheDirectory && join(cacheDirectory, asset.asset);
  if (cached && existsSync(cached)) {
    const bytes = readFileSync(cached);
    verifyAssetBytes(bytes, asset);
    return bytes;
  }
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(600_000), redirect: "follow" });
  if (!response.ok) throw new Error(`Could not download ${asset.asset}: HTTP ${response.status}`);
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > asset.bytes) throw new Error(`${asset.asset} exceeded its pinned size`);
    parts.push(part);
  }
  const bytes = Buffer.concat(parts);
  verifyAssetBytes(bytes, asset);
  if (cached) {
    mkdirSync(cacheDirectory, { recursive: true });
    writeFileSync(cached, bytes);
  }
  return bytes;
}

export function browserExtractionCommand(archive, directory, { platform = process.platform, systemRoot = process.env.SystemRoot ?? "C:\\Windows" } = {}) {
  // Git Bash places GNU tar (no ZIP support) on PATH. Windows ships bsdtar;
  // address that exact executable instead of whichever tar appears first.
  return platform === "win32"
    ? { file: win32.join(systemRoot, "System32", "tar.exe"), args: ["-xf", archive, "-C", directory] }
    : { file: "unzip", args: ["-q", archive, "-d", directory] };
}

function extract(archive, directory) {
  const command = browserExtractionCommand(archive, directory);
  const result = spawnSync(command.file, command.args, {
    encoding: "utf8", windowsHide: true, timeout: 120_000,
  });
  if (result.error || result.status !== 0) throw new Error(`Browser archive extraction failed: ${result.error?.message ?? result.stderr ?? result.status}`);
}

export async function stageBrowserTarget(root, target, { cacheDirectory = process.env.OMB_BROWSER_ARCHIVE_DIR ?? join(root, "dist-native", "browser-archives") } = {}) {
  const spec = browserBundleSpec(target);
  const parent = join(root, "dist-native", "browser");
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(join(parent, `.prepare-${target}-`));
  const stage = join(scratch, "bundle");
  const destination = join(parent, target);
  try {
    const [engine, chrome] = await Promise.all([releaseBytes(spec.engine, cacheDirectory), releaseBytes(spec.chrome, cacheDirectory)]);
    mkdirSync(join(stage, "chrome"), { recursive: true });
    const paths = browserBundlePaths(stage, target);
    writeFileSync(paths.engine, engine, { mode: 0o755 });
    const archive = join(scratch, spec.chrome.asset);
    writeFileSync(archive, chrome);
    extract(archive, join(stage, "chrome"));
    if (process.platform !== "win32") {
      chmodSync(paths.engine, 0o755);
      chmodSync(paths.chrome, 0o755);
    }
    mkdirSync(paths.licenses);
    for (const name of BROWSER_LICENSE_FILES) copyFileSync(join(sourceRoot, "third_party", "browser", name), join(paths.licenses, name));
    writeFileSync(paths.manifest, `${JSON.stringify({ ...spec, files: bundleInventory(stage) }, null, 2)}\n`);
    verifyBrowserBundle(stage, target);
    // Keep the previous complete tree until the new one passes every check.
    const previous = join(scratch, "previous");
    if (existsSync(destination)) renameSync(destination, previous);
    try { renameSync(stage, destination); }
    catch (error) {
      if (existsSync(previous)) renameSync(previous, destination);
      throw error;
    }
    console.log(`Browser ready: agent-browser ${spec.engine.version} + Chromium headless ${spec.chrome.version} (${target})`);
    return destination;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const target of targetsForPreparation(parsePrepareBrowserArgs(process.argv.slice(2)))) await stageBrowserTarget(sourceRoot, target);
}
