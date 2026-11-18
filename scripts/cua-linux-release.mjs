import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const run = promisify(execFile);
const KIB = 1024;
const MIB = KIB * KIB;
const TAR_BLOCK_SIZE = 512;
export const LICENSE_FILES = Object.freeze([
  "LICENSE.md",
  "Inter-OFL-1.1.txt",
  "THIRD_PARTY_LICENSES.html",
  "THIRD_PARTY_NOTICES.md",
  "SBOM.cdx.json",
]);

export const LINUX_CUA_RELEASE = Object.freeze({
  version: "0.41.3",
  archiveName: "cua-driver-rs-0.41.3-linux-x86_64-binary.tar.gz",
  archiveSize: 38_375_345,
  archiveSha256: "a00a7bc4a648adbcbc93bfbf5a058daf71ce8838ee172e33b197aaf649ecee14",
  driverSha256: "83030028e7c9e3f4d753b3b27025135d44eb8d52f562cce0aaaf95777bc1b41f",
  cursorThemeSha256: "d39efb960d207e7328d7a9dd48e3b6565f74be073f9c2ca8dcba86a4d0f28312",
  url:
    "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.41.3/" +
    "cua-driver-rs-0.41.3-linux-x86_64-binary.tar.gz",
  maxArchiveBytes: 64 * MIB,
  maxExpandedBytes: 128 * MIB,
});

// Pin the complete upstream archive shape, even though OpenMausBot extracts
// only the two CLI runtime files. A release that silently grows a new native
// payload must receive an explicit review and checksum update first.
const ARCHIVE_MEMBERS = Object.freeze({
  "cua-driver": Object.freeze({
    kind: "file",
    size: 61_925_800,
    sha256: LINUX_CUA_RELEASE.driverSha256,
    staged: true,
    mode: 0o755,
  }),
  "cua-cursor-theme": Object.freeze({
    kind: "file",
    size: 5_090_720,
    sha256: LINUX_CUA_RELEASE.cursorThemeSha256,
    staged: true,
    mode: 0o755,
  }),
  "libcua_driver_sdk.so": Object.freeze({
    kind: "file",
    size: 51_420_328,
    sha256: "a6402f2e892089cdece4a622b062be734683f771c8d7b4a0b122895974673685",
  }),
  "cua_driver_node_runtime.node": Object.freeze({
    kind: "file",
    size: 972_456,
    sha256: "4441cf353e15773db90707543c3a4cab64f3312f001de825f117c5df95f8b375",
  }),
  "cua_driver_abi.h": Object.freeze({
    kind: "file",
    size: 7_762,
    sha256: "e952620e41ac81b2d900886c7b0a24ebc6268a4edb8df88cc9971ae34af4ba0d",
  }),
  "wayland-helper/": Object.freeze({ kind: "directory", size: 0 }),
  "wayland-helper/winrects@cua/": Object.freeze({ kind: "directory", size: 0 }),
  "wayland-helper/winrects@cua/extension.js": Object.freeze({
    kind: "file",
    size: 47_360,
    sha256: "b7b5b922e68a8ee53eb549a3d2f85dd28259140633c0c34123f16910f7ac8e0c",
  }),
  "wayland-helper/winrects@cua/metadata.json": Object.freeze({
    kind: "file",
    size: 231,
    sha256: "1853170d66280f1a096af0e33bb400e3740cddf07bf3e2f1e3bbeaf33550e1d0",
  }),
  "wayland-helper/install.sh": Object.freeze({
    kind: "file",
    size: 1_932,
    sha256: "1f36c163562d8d7a3a711e69625adc33895a511a1ca0f2bb8f516c3aca0906fb",
  }),
  "wayland-helper/README.md": Object.freeze({
    kind: "file",
    size: 8_974,
    sha256: "359bc52eb9639b7242a05d597e4a2ac6d0ea91622d4d4eed89412b594d5f2e17",
  }),
});

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tarString(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function tarOctal(buffer, start, length, label) {
  const raw = tarString(buffer, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error(`invalid tar ${label}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid tar ${label}`);
  return value;
}

function tarHeaderChecksum(header) {
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  return copy.reduce((sum, value) => sum + value, 0);
}

function safeArchivePath(name) {
  if (
    !name ||
    name.includes("\\") ||
    name.includes("\0") ||
    path.posix.isAbsolute(name) ||
    name.split("/").some((component) => component === ".." || component === ".")
  ) {
    throw new Error(`unsafe CUA archive path: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Parse the pinned tarball without delegating extraction to a general-purpose
 * archive tool. Only regular files and directories from the reviewed manifest
 * are accepted; links, PAX/GNU extensions, devices and duplicate names fail.
 */
export function parseLinuxCuaArchive(
  archiveBytes,
  release = LINUX_CUA_RELEASE,
  archiveMembers = ARCHIVE_MEMBERS,
) {
  if (!Buffer.isBuffer(archiveBytes)) archiveBytes = Buffer.from(archiveBytes);
  if (archiveBytes.length > release.maxArchiveBytes) {
    throw new Error("CUA archive exceeds the compressed size limit");
  }
  if (release.archiveSize != null && archiveBytes.length !== release.archiveSize) {
    throw new Error("CUA archive size does not match the pinned release");
  }
  if (sha256(archiveBytes) !== release.archiveSha256) {
    throw new Error("CUA archive checksum mismatch");
  }

  let tar;
  try {
    tar = gunzipSync(archiveBytes, { maxOutputLength: release.maxExpandedBytes });
  } catch (error) {
    throw new Error(`CUA archive could not be decompressed safely: ${error?.message ?? error}`);
  }
  if (tar.length > release.maxExpandedBytes) {
    throw new Error("CUA archive exceeds the expanded size limit");
  }

  const seen = new Set();
  const staged = new Map();
  let offset = 0;
  let ended = false;
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((value) => value === 0)) {
      ended = true;
      break;
    }

    const expectedChecksum = tarOctal(header, 148, 8, "checksum");
    if (expectedChecksum !== tarHeaderChecksum(header)) {
      throw new Error("CUA archive contains an invalid tar header checksum");
    }
    const prefix = tarString(header, 345, 155);
    const basename = tarString(header, 0, 100);
    const name = safeArchivePath(prefix ? `${prefix}/${basename}` : basename);
    if (seen.has(name)) throw new Error(`duplicate CUA archive member: ${name}`);
    seen.add(name);

    const expected = archiveMembers[name];
    if (!expected) throw new Error(`unexpected CUA archive member: ${name}`);
    const typeByte = header[156];
    const kind = typeByte === 0 || typeByte === 0x30 ? "file" : typeByte === 0x35 ? "directory" : "special";
    if (kind !== expected.kind) {
      throw new Error(`unsupported CUA archive member type for ${name}`);
    }
    if (tarString(header, 157, 100)) {
      throw new Error(`CUA archive links are not allowed: ${name}`);
    }

    const size = tarOctal(header, 124, 12, "member size");
    if (size !== expected.size) throw new Error(`unexpected CUA archive member size for ${name}`);
    const dataOffset = offset + TAR_BLOCK_SIZE;
    const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    const nextOffset = dataOffset + paddedSize;
    if (nextOffset > tar.length) throw new Error(`truncated CUA archive member: ${name}`);

    if (kind === "file") {
      const bytes = Buffer.from(tar.subarray(dataOffset, dataOffset + size));
      if (sha256(bytes) !== expected.sha256) {
        throw new Error(`CUA archive member checksum mismatch: ${name}`);
      }
      if (expected.staged) staged.set(name, bytes);
    }
    offset = nextOffset;
  }

  if (!ended || !tar.subarray(offset).every((value) => value === 0)) {
    throw new Error("CUA archive has invalid trailing data");
  }
  for (const name of Object.keys(archiveMembers)) {
    if (!seen.has(name)) throw new Error(`CUA archive is missing reviewed member: ${name}`);
  }
  return staged;
}

function releaseManifest() {
  return Object.freeze({
    schemaVersion: 1,
    version: LINUX_CUA_RELEASE.version,
    platform: "linux",
    arch: "x64",
    archive: {
      name: LINUX_CUA_RELEASE.archiveName,
      url: LINUX_CUA_RELEASE.url,
      size: LINUX_CUA_RELEASE.archiveSize,
      sha256: LINUX_CUA_RELEASE.archiveSha256,
    },
    sourceCommit: "bd0e299c67dec6397b3d41a259452b2ea13a1cd5",
    files: {
      "cua-driver": {
        sha256: LINUX_CUA_RELEASE.driverSha256,
        mode: "0755",
      },
      "cua-cursor-theme": {
        sha256: LINUX_CUA_RELEASE.cursorThemeSha256,
        mode: "0755",
      },
    },
  });
}

async function binaryVersion(binary) {
  const { stdout } = await run(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 256 * KIB,
    env: {
      LANG: "C",
      LC_ALL: "C",
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    },
  });
  return stdout.trim();
}

async function validateBinaryManifest(binary) {
  const { stdout } = await run(binary, ["manifest"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 256 * KIB,
    env: {
      LANG: "C",
      LC_ALL: "C",
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    },
  });
  const manifest = JSON.parse(stdout);
  const invocationCommand = manifest.mcp_invocation?.command;
  const invocationPath =
    typeof invocationCommand === "string" && invocationCommand.length > 0
      ? await realpath(invocationCommand).catch(() => null)
      : null;
  if (
    manifest.schema_version !== "1" ||
    manifest.binary_version !== LINUX_CUA_RELEASE.version ||
    invocationPath !== (await realpath(binary)) ||
    JSON.stringify(manifest.mcp_invocation?.args) !== JSON.stringify(["mcp"])
  ) {
    throw new Error("staged CUA Driver returned an incompatible manifest");
  }
}

export async function validateStagedLayout(stageDirectory) {
  const stageDetails = await lstat(stageDirectory);
  if (
    !stageDetails.isDirectory() ||
    stageDetails.isSymbolicLink() ||
    (stageDetails.mode & 0o777) !== 0o755
  ) {
    throw new Error("staged CUA release root must be a real 0755 directory");
  }
  const rootEntries = (await readdir(stageDirectory)).sort();
  const expectedRootEntries = ["cua-cursor-theme", "cua-driver", "licenses", "release.json"];
  if (JSON.stringify(rootEntries) !== JSON.stringify(expectedRootEntries)) {
    throw new Error("staged CUA release contains unexpected or missing entries");
  }
  const licensesDirectory = path.join(stageDirectory, "licenses");
  const licenseDirectoryDetails = await lstat(licensesDirectory);
  if (
    !licenseDirectoryDetails.isDirectory() ||
    licenseDirectoryDetails.isSymbolicLink() ||
    (licenseDirectoryDetails.mode & 0o777) !== 0o755
  ) {
    throw new Error("staged CUA licenses must be a real 0755 directory");
  }
  const licenseEntries = (await readdir(licensesDirectory)).sort();
  if (JSON.stringify(licenseEntries) !== JSON.stringify([...LICENSE_FILES].sort())) {
    throw new Error("staged CUA licenses contain unexpected or missing entries");
  }
  return { licensesDirectory };
}

async function validateStagedRuntime(stageDirectory, { licenseDirectory }) {
  const { licensesDirectory } = await validateStagedLayout(stageDirectory);
  const manifestDetails = await lstat(path.join(stageDirectory, "release.json"));
  if (
    !manifestDetails.isFile() ||
    manifestDetails.isSymbolicLink() ||
    (manifestDetails.mode & 0o777) !== 0o644
  ) {
    throw new Error("staged CUA release manifest must be a regular 0644 file");
  }
  const manifest = JSON.parse(
    await readFile(path.join(stageDirectory, "release.json"), "utf8"),
  );
  if (JSON.stringify(manifest) !== JSON.stringify(releaseManifest())) {
    throw new Error("staged CUA release manifest does not match the pinned release");
  }
  for (const [name, expected] of Object.entries(releaseManifest().files)) {
    const file = path.join(stageDirectory, name);
    const details = await lstat(file);
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      (details.mode & 0o777) !== Number.parseInt(expected.mode, 8)
    ) {
      throw new Error(`staged CUA runtime has an invalid mode: ${name}`);
    }
    if (sha256(await readFile(file)) !== expected.sha256) {
      throw new Error(`staged CUA runtime checksum mismatch: ${name}`);
    }
  }
  for (const name of LICENSE_FILES) {
    const details = await lstat(path.join(licensesDirectory, name));
    if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o777) !== 0o644) {
      throw new Error(`staged CUA license resource has an invalid type or mode: ${name}`);
    }
    const expected = await readFile(path.join(licenseDirectory, name));
    const actual = await readFile(path.join(licensesDirectory, name));
    if (!actual.equals(expected)) throw new Error(`staged CUA license resource mismatch: ${name}`);
  }
  if ((await binaryVersion(path.join(stageDirectory, "cua-driver"))) !== `cua-driver ${LINUX_CUA_RELEASE.version}`) {
    throw new Error(`staged CUA Driver does not report version ${LINUX_CUA_RELEASE.version}`);
  }
  await validateBinaryManifest(path.join(stageDirectory, "cua-driver"));
  return manifest;
}

export async function readBoundedResponseBody(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel?.();
    throw new Error("downloaded CUA archive exceeds the compressed size limit");
  }
  if (!response.body) throw new Error("CUA Driver download returned no response body");
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        throw new Error("downloaded CUA archive exceeds the compressed size limit");
      }
      chunks.push(bytes);
    }
  } catch (error) {
    try {
      await response.body.cancel?.();
    } catch {}
    throw error;
  }
  return Buffer.concat(chunks, total);
}

async function readVerifiedArchive({
  archivePath,
  cachePath,
  fetchImpl,
  offline,
  downloadTimeoutMs,
}) {
  for (const candidate of [archivePath, cachePath].filter(Boolean)) {
    try {
      const bytes = await readFile(candidate);
      if (
        bytes.length === LINUX_CUA_RELEASE.archiveSize &&
        sha256(bytes) === LINUX_CUA_RELEASE.archiveSha256
      ) {
        return bytes;
      }
      if (candidate === archivePath) throw new Error("provided CUA archive checksum mismatch");
    } catch (error) {
      if (candidate === archivePath || error?.code !== "ENOENT") throw error;
    }
  }
  if (offline) throw new Error("offline CUA staging requires an existing verified stage or archive cache");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), downloadTimeoutMs);
  timeout.unref?.();
  let bytes;
  try {
    const response = await fetchImpl(LINUX_CUA_RELEASE.url, {
      headers: { "user-agent": "OpenMausBot-packager" },
      signal: controller.signal,
    });
    if (!response?.ok) {
      throw new Error(`CUA Driver download failed: HTTP ${response?.status ?? "unknown"}`);
    }
    bytes = await readBoundedResponseBody(response, LINUX_CUA_RELEASE.maxArchiveBytes);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("CUA Driver download timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (bytes.length !== LINUX_CUA_RELEASE.archiveSize) {
    throw new Error("downloaded CUA archive size does not match the pinned release");
  }
  if (sha256(bytes) !== LINUX_CUA_RELEASE.archiveSha256) {
    throw new Error("downloaded CUA archive checksum mismatch");
  }
  const cacheDirectory = path.dirname(cachePath);
  await mkdir(cacheDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(cacheDirectory, ".cua-archive-"));
  try {
    const temporaryArchive = path.join(temporaryDirectory, LINUX_CUA_RELEASE.archiveName);
    await writeFile(temporaryArchive, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporaryArchive, cachePath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return bytes;
}

export async function stageLinuxCua({
  rootDirectory,
  platform = process.platform,
  arch = process.arch,
  offline = false,
  archivePath,
  fetchImpl = globalThis.fetch,
  downloadTimeoutMs = 120_000,
} = {}) {
  if (platform !== "linux" || arch !== "x64") {
    throw new Error(`bundled CUA staging supports only linux/x64, received ${platform}/${arch}`);
  }
  if (!rootDirectory || !path.isAbsolute(rootDirectory)) {
    throw new Error("rootDirectory must be an absolute path");
  }
  // Linux local control spawns this reviewed CLI directly and deliberately
  // excludes the npm SDK's native .node/.so files. Do not couple the Linux
  // release pin to @trycua/cua-driver, which serves the separate macOS SDK
  // path and may advance independently.

  const stageDirectory = path.join(rootDirectory, "dist-native", "cua-linux-x64");
  const licenseDirectory = path.join(rootDirectory, "third_party", "cua-driver");
  if (offline) {
    try {
      await validateStagedRuntime(stageDirectory, { licenseDirectory });
      return { stageDirectory, source: "existing-stage", manifest: releaseManifest() };
    } catch {
      // An invalid stage is never trusted. A verified cache may still satisfy
      // an explicitly offline release build below.
    }
  }

  const cachePath = path.join(
    rootDirectory,
    "node_modules",
    ".cache",
    "openmausbot",
    LINUX_CUA_RELEASE.archiveName,
  );
  const archive = await readVerifiedArchive({
    archivePath,
    cachePath,
    fetchImpl,
    offline,
    downloadTimeoutMs,
  });
  const files = parseLinuxCuaArchive(archive);

  const stageParent = path.dirname(stageDirectory);
  await mkdir(stageParent, { recursive: true });
  const temporary = await mkdtemp(path.join(stageParent, ".cua-linux-x64-"));
  const backup = `${stageDirectory}.previous`;
  let previousMoved = false;
  try {
    await chmod(temporary, 0o755);
    for (const [name, bytes] of files) {
      const expected = ARCHIVE_MEMBERS[name];
      await writeFile(path.join(temporary, name), bytes, { mode: expected.mode, flag: "wx" });
      await chmod(path.join(temporary, name), expected.mode);
    }
    await mkdir(path.join(temporary, "licenses"), { mode: 0o755 });
    await chmod(path.join(temporary, "licenses"), 0o755);
    for (const name of LICENSE_FILES) {
      await copyFile(path.join(licenseDirectory, name), path.join(temporary, "licenses", name));
      await chmod(path.join(temporary, "licenses", name), 0o644);
    }
    await writeFile(path.join(temporary, "release.json"), `${JSON.stringify(releaseManifest(), null, 2)}\n`, {
      mode: 0o644,
      flag: "wx",
    });
    await validateStagedRuntime(temporary, { licenseDirectory });

    await rm(backup, { recursive: true, force: true });
    try {
      await rename(stageDirectory, backup);
      previousMoved = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(temporary, stageDirectory);
    if (previousMoved) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (previousMoved) {
      try {
        await rename(backup, stageDirectory);
      } catch {}
    }
    throw error;
  }

  return { stageDirectory, source: archivePath ? "archive" : "official-release", manifest: releaseManifest() };
}
