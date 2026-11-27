// Stage a pinned Cloudflare Tunnel connector for every desktop architecture
// electron-builder packages on this host; --current stages only this host's
// platform and architecture. Verified before extraction and on every reuse.
// cloudflared's own updater stays disabled.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CLOUDFLARED_VERSION = "2026.10.3";

export const CLOUDFLARED_ASSETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    name: "cloudflared-darwin-arm64.tgz",
    sha256: "1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55",
    binarySha256: "f249139e0541fa589c987397d867cc16c83ab1236d31eb6782f2e4552ee9cf80",
    archive: true,
  }),
  "darwin-x64": Object.freeze({
    name: "cloudflared-darwin-amd64.tgz",
    sha256: "81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000",
    binarySha256: "947e2942d6a59922d80190d23b12f3ade8da16e23e3bd937182a48993b7c00db",
    archive: true,
  }),
  "linux-x64": Object.freeze({
    name: "cloudflared-linux-amd64",
    sha256: "053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0",
    binarySha256: "053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0",
    archive: false,
  }),
  "linux-arm64": Object.freeze({
    name: "cloudflared-linux-arm64",
    sha256: "89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8",
    binarySha256: "89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8",
    archive: false,
  }),
  "win32-x64": Object.freeze({
    name: "cloudflared-windows-amd64.exe",
    sha256: "76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2",
    binarySha256: "76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2",
    archive: false,
  }),
});

export function targetsForHost(platform) {
  // Desktop package targets only. Self-hosted installs use --current instead.
  if (platform === "darwin") return ["darwin-arm64", "darwin-x64"];
  if (platform === "linux") return ["linux-x64"];
  if (platform === "win32") return ["win32-x64"];
  throw new Error(`Cloudflare Tunnel packaging is unsupported on ${platform}`);
}

export function targetForCurrentHost(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!Object.hasOwn(CLOUDFLARED_ASSETS, target)) {
    throw new Error(`Cloudflare Tunnel development is unsupported on ${target}`);
  }
  return target;
}

export function targetsForPreparation({
  current = false,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return current ? [targetForCurrentHost(platform, arch)] : targetsForHost(platform);
}

export function parsePrepareCloudflaredArgs(args = []) {
  const options = { current: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const next = args[index + 1];
    if (argument === "--current" && !options.current) {
      options.current = true;
    } else if (argument === "--root" && !options.root && typeof next === "string" && next !== "") {
      // `openmausbot serve --tunnel` stages into its data dir, not a checkout.
      options.root = next;
      index += 1;
    } else {
      throw new Error("Usage: node scripts/prepare-cloudflared.mjs [--current] [--root DIR]");
    }
  }
  return options;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function verifySha256(value, expected, label = "cloudflared asset") {
  const actual = sha256(value);
  if (actual !== expected) {
    throw new Error(`${label} failed SHA-256 verification (expected ${expected}, received ${actual})`);
  }
  return actual;
}

const executableName = (target) => (target.startsWith("win32-") ? "cloudflared.exe" : "cloudflared");

/** Identify the target from the executable header without running it, so a
 * correctly checksummed asset is never staged into the wrong resource directory. */
export function executableTarget(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);

  // 64-bit little-endian Mach-O. CPU types include ABI64 (0x01000000).
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4);
    if (cpu === 0x0100000c) return "darwin-arm64";
    if (cpu === 0x01000007) return "darwin-x64";
    throw new Error(`unsupported cloudflared Mach-O CPU type 0x${cpu.toString(16)}`);
  }

  // ELF64, little-endian: AMD64 (EM_X86_64 = 62) or ARM64 (EM_AARCH64 = 183).
  if (
    bytes.length >= 20 &&
    bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
    bytes[4] === 2 &&
    bytes[5] === 1
  ) {
    const machine = bytes.readUInt16LE(18);
    if (machine === 62) return "linux-x64";
    if (machine === 183) return "linux-arm64";
  }

  // PE32+ AMD64. e_lfanew points from the DOS header to PE\0\0.
  if (bytes.length >= 0x40 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const pe = bytes.readUInt32LE(0x3c);
    if (
      pe <= bytes.length - 6 &&
      bytes.subarray(pe, pe + 4).equals(Buffer.from([0x50, 0x45, 0, 0])) &&
      bytes.readUInt16LE(pe + 4) === 0x8664
    ) {
      return "win32-x64";
    }
  }

  throw new Error("cloudflared release has an unsupported executable format or architecture");
}

export function verifyPinnedBinary(value, target) {
  const asset = CLOUDFLARED_ASSETS[target];
  if (!asset) throw new Error(`No pinned cloudflared asset for ${target}`);
  const actualTarget = executableTarget(value);
  if (actualTarget !== target) {
    throw new Error(`cloudflared architecture mismatch (expected ${target}, received ${actualTarget})`);
  }
  return verifySha256(value, asset.binarySha256, `${target} cloudflared executable`);
}

function expectedManifest(target) {
  const asset = CLOUDFLARED_ASSETS[target];
  return {
    version: CLOUDFLARED_VERSION,
    target,
    releaseAsset: asset.name,
    releaseAssetSha256: asset.sha256,
    binarySha256: asset.binarySha256,
  };
}

function targetRunsOnHost(target, platform = process.platform, arch = process.arch) {
  return target === `${platform}-${arch}`;
}

function executableHasPinnedVersion(binary, target) {
  // A dual-architecture macOS package is prepared in one invocation. Do not
  // assume Rosetta is installed or attempt to execute the other architecture;
  // its executable bytes are still pinned and its Mach-O header is checked.
  if (!targetRunsOnHost(target)) return true;
  const result = spawnSync(binary, ["version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  return result.status === 0 && `${result.stdout}\n${result.stderr}`.includes(CLOUDFLARED_VERSION);
}

export function verifyCloudflaredExecutable(binary, target) {
  verifyPinnedBinary(readFileSync(binary), target);
  if (!executableHasPinnedVersion(binary, target)) {
    throw new Error(`${target} executable did not identify as cloudflared ${CLOUDFLARED_VERSION}`);
  }
}

function executableIsCurrent(binary, manifestFile, target) {
  if (!existsSync(binary) || !existsSync(manifestFile)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest(target))) return false;
    verifyCloudflaredExecutable(binary, target);
    return true;
  } catch {
    return false;
  }
}

function extractionFailure(result) {
  return result.error?.message ?? String(result.stderr || result.stdout || `exit status ${result.status}`).trim();
}

/** Retry transient download failures; callers still verify the pinned digest. */
export async function releaseBytes(asset) {
  const cacheDirectory = process.env.OMB_CLOUDFLARED_ARCHIVE_DIR;
  const cached = cacheDirectory ? join(cacheDirectory, asset.name) : "";
  if (cached && existsSync(cached)) return readFileSync(cached);

  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.name}`;
  const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
  for (let attempt = 1; attempt <= 3; attempt++) {
    let failure;
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      await response.body?.cancel().catch(() => {});
      failure = new Error(`could not download ${asset.name}: HTTP ${response.status}`);
      if (!retryableStatuses.has(response.status)) throw failure;
    } catch (error) {
      // Node fetch reports network/body failures as TypeError; each attempt
      // has its own timeout, including reading the complete response body.
      if (!(error instanceof TypeError) && !["TimeoutError", "AbortError"].includes(error?.name)) throw error;
      failure = error;
    }
    if (attempt === 3) throw failure;
    const delay = 1_000 * 2 ** (attempt - 1);
    console.warn(`cloudflared download attempt ${attempt}/3 failed: ${failure.message}; retrying in ${delay}ms`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function stageTarget(root, target) {
  const asset = CLOUDFLARED_ASSETS[target];
  if (!asset) throw new Error(`No pinned cloudflared asset for ${target}`);

  const finalDirectory = join(root, "dist-native", "cloudflared", target);
  const binary = join(finalDirectory, executableName(target));
  const manifestFile = join(finalDirectory, "manifest.json");
  if (executableIsCurrent(binary, manifestFile, target)) {
    console.log(`cloudflared ${CLOUDFLARED_VERSION} already staged for ${target}`);
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), `openmaus-cloudflared-${target}-`));
  try {
    const payload = await releaseBytes(asset);
    verifySha256(payload, asset.sha256, asset.name);

    let candidate;
    if (asset.archive) {
      const archive = join(scratch, basename(asset.name));
      writeFileSync(archive, payload, { mode: 0o600 });
      const extracted = join(scratch, "extracted");
      mkdirSync(extracted, { mode: 0o700 });
      const result = spawnSync("tar", ["-xzf", archive, "-C", extracted], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      });
      if (result.status !== 0) throw new Error(`could not extract ${asset.name}: ${extractionFailure(result)}`);
      candidate = join(extracted, "cloudflared");
    } else {
      candidate = join(scratch, executableName(target));
      writeFileSync(candidate, payload, { mode: 0o700 });
    }
    if (!existsSync(candidate)) throw new Error(`${asset.name} did not contain cloudflared`);
    if (!target.startsWith("win32-")) chmodSync(candidate, 0o700);

    verifyCloudflaredExecutable(candidate, target);

    const parent = dirname(finalDirectory);
    mkdirSync(parent, { recursive: true });
    const stagedDirectory = mkdtempSync(join(parent, `.${target}-`));
    const stagedBinary = join(stagedDirectory, executableName(target));
    copyFileSync(candidate, stagedBinary);
    if (!target.startsWith("win32-")) {
      // copyFile preserves the source mode on Unix in current Node, but make
      // the executable contract explicit instead of depending on that detail.
      chmodSync(stagedBinary, 0o755);
    }
    writeFileSync(
      join(stagedDirectory, "manifest.json"),
      `${JSON.stringify(expectedManifest(target), null, 2)}\n`,
      { mode: 0o600 },
    );
    rmSync(finalDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    renameSync(stagedDirectory, finalDirectory);
    console.log(`staged cloudflared ${CLOUDFLARED_VERSION} for ${target}`);
  } finally {
    // Windows Defender can briefly retain the executable after the version
    // probe exits. Node retries EPERM for recursive removals when asked.
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

export async function prepareCloudflared({
  root = join(dirname(fileURLToPath(import.meta.url)), ".."),
  platform = process.platform,
  arch = process.arch,
  current = false,
} = {}) {
  for (const target of targetsForPreparation({ current, platform, arch })) {
    await stageTarget(root, target);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await prepareCloudflared(parsePrepareCloudflaredArgs(process.argv.slice(2)));
}
