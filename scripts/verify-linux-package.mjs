import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { LICENSE_FILES } from "./cua-linux-release.mjs";
import {
  CLOUDFLARED_ASSETS,
  CLOUDFLARED_VERSION,
  executableTarget,
} from "./prepare-cloudflared.mjs";

const require = createRequire(import.meta.url);
const { validateDriverCandidate } = require("../electron/cua-linux.cjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.resolve(process.argv[2] ?? path.join(root, "release"));

function fail(message) {
  throw new Error(`[verify-linux-package] ${message}`);
}

function exactlyOne(suffix) {
  const matches = readdirSync(releaseDir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => path.join(releaseDir, name));
  if (matches.length !== 1) fail(`expected exactly one ${suffix} artifact, found ${matches.length}`);
  return matches[0];
}

function requireFile(file) {
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) fail(`missing file: ${file}`);
}

function requireExecutable(file) {
  requireFile(file);
  try {
    accessSync(file, constants.X_OK);
  } catch {
    fail(`not executable: ${file}`);
  }
}

// electron-updater picks its installer from resources/package-type: present
// and reading "deb" routes to DebUpdater, absent falls back to AppImageUpdater.
// electron/updater.mjs reads the same marker to decide whether the update is
// applied in place or handed to the system package manager. If packaging ever
// puts the marker in both artifacts (or neither), that routing silently
// inverts, so pin it here where both trees are already extracted.
function requirePackageType(resources, label, expected) {
  const marker = path.join(resources, "package-type");
  const found = statSync(marker, { throwIfNoEntry: false })?.isFile()
    ? readFileSync(marker, "utf8").trim()
    : null;
  if (found !== expected) {
    fail(
      `${label} package-type marker is ${JSON.stringify(found)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

function requireUpdaterTarget(resources, label) {
  const updateFile = path.join(resources, "app-update.yml");
  requireFile(updateFile);
  const update = readFileSync(updateFile, "utf8");
  if (!/^owner: milind-soni$/m.test(update) || !/^repo: OpenMausBot$/m.test(update)) {
    fail(`${label} app-update.yml does not point at milind-soni/OpenMausBot`);
  }
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function requireRegularMode(file, mode) {
  const details = lstatSync(file, { throwIfNoEntry: false });
  if (!details?.isFile() || details.isSymbolicLink()) fail(`expected a regular file: ${file}`);
  if ((details.mode & 0o777) !== mode) {
    fail(`expected mode ${mode.toString(8)} for ${file}, found ${(details.mode & 0o777).toString(8)}`);
  }
}

function requireDirectoryMode(directory, mode) {
  const details = lstatSync(directory, { throwIfNoEntry: false });
  if (!details?.isDirectory() || details.isSymbolicLink()) {
    fail(`expected a real directory: ${directory}`);
  }
  if ((details.mode & 0o777) !== mode) {
    fail(
      `expected mode ${mode.toString(8)} for ${directory}, found ${(details.mode & 0o777).toString(8)}`,
    );
  }
}

function requireExactEntries(directory, expected) {
  const actual = readdirSync(directory).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${directory} entries differ: expected ${wanted.join(", ")}; found ${actual.join(", ")}`);
  }
}

function requireContained(root, target) {
  const canonicalRoot = realpathSync(root);
  const canonicalTarget = realpathSync(target);
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`)) {
    fail(`${target} resolves outside ${root}`);
  }
}

function verifyCompliance(licenses, label) {
  const notices = readFileSync(path.join(licenses, "THIRD_PARTY_NOTICES.md"), "utf8");
  const html = readFileSync(path.join(licenses, "THIRD_PARTY_LICENSES.html"), "utf8");
  const sbom = JSON.parse(readFileSync(path.join(licenses, "SBOM.cdx.json"), "utf8"));
  const components = sbom.components ?? [];
  if (components.length !== 339) {
    fail(`${label} SBOM must contain 330 registry packages, 8 Cua packages, and Inter`);
  }
  const componentRefs = new Set();
  for (const component of components) {
    const reference = component["bom-ref"];
    if (typeof reference !== "string" || reference.length === 0) {
      fail(`${label} SBOM component has no bom-ref: ${component.name ?? "unknown"}`);
    }
    if (componentRefs.has(reference)) fail(`${label} SBOM repeats bom-ref ${reference}`);
    componentRefs.add(reference);
  }
  const registry = components.filter((component) => component.group === "crates.io");
  const trycua = components.filter((component) => component.group === "trycua");
  const fonts = components.filter((component) => component.group === "rsms");
  if (registry.length !== 330 || trycua.length !== 8 || fonts.length !== 1) {
    fail(`${label} SBOM component groups do not match the reviewed runtime graph`);
  }
  const trycuaNames = trycua.map((component) => component.name).sort();
  if (
    JSON.stringify(trycuaNames) !==
    JSON.stringify([
      "cua-driver",
      "cua-driver-contract",
      "cua-driver-core",
      "cua-driver-sdk",
      "cursor-overlay",
      "cursor-theme-cli",
      "pip-preview",
      "platform-linux",
    ])
  ) {
    fail(`${label} SBOM Cua workspace allowlist changed`);
  }
  if (fonts[0]?.name !== "Inter" || fonts[0]?.version !== "4.001") {
    fail(`${label} SBOM is missing the reviewed Inter font component`);
  }
  const registryIds = new Set();
  for (const component of registry) {
    const packageId = component.properties?.find(
      (property) => property.name === "openmausbot:cargo:package-id",
    )?.value;
    if (typeof packageId !== "string" || !packageId.startsWith("registry+")) {
      fail(`${label} SBOM registry component has no exact Cargo package ID`);
    }
    if (registryIds.has(packageId)) fail(`${label} SBOM repeats ${packageId}`);
    registryIds.add(packageId);
    if (!component.hashes?.some((hash) => hash.alg === "SHA-256" && /^[a-f0-9]{64}$/.test(hash.content))) {
      fail(`${label} SBOM registry component has no Cargo.lock checksum: ${component.name}`);
    }
    if (!notices.includes(`| ${component.name.replaceAll("|", "\\|")} | ${component.version} |`)) {
      fail(`${label} notices are missing SBOM attribution for ${component.name}@${component.version}`);
    }
  }
  const attributed = new Set(
    [...html.matchAll(/<tr data-package-id="([^"]+)">/g)].map((match) => match[1]),
  );
  if (attributed.size !== 330) {
    fail(`${label} license report does not cover the reviewed 330 registry packages`);
  }
  for (const packageId of attributed) {
    if (!registryIds.has(packageId)) {
      fail(`${label} license report contains an unknown Cargo package: ${packageId}`);
    }
  }
  const mpls = components
    .filter((component) => JSON.stringify(component.licenses).includes("MPL-2.0"))
    .map((component) => `${component.name}@${component.version}`)
    .sort();
  if (
    JSON.stringify(mpls) !==
    JSON.stringify([
      "option-ext@0.2.0",
      "uniffi@0.31.0",
      "uniffi_core@0.31.0",
      "uniffi_internal_macros@0.31.0",
      "uniffi_macros@0.31.0",
      "uniffi_meta@0.31.0",
      "uniffi_pipeline@0.31.0",
    ])
  ) {
    fail(`${label} MPL component set changed`);
  }
  const rootDependency = sbom.dependencies?.find(
    (dependency) => dependency.ref === "pkg:generic/cua-driver-linux-x64@0.19.3",
  );
  const rootReferences = rootDependency?.dependsOn;
  const uniqueRootReferences = new Set(rootReferences ?? []);
  if (
    !Array.isArray(rootReferences) ||
    rootReferences.length !== componentRefs.size ||
    uniqueRootReferences.size !== rootReferences.length ||
    [...uniqueRootReferences].some((reference) => !componentRefs.has(reference))
  ) {
    fail(`${label} SBOM root must reference every reviewed component`);
  }
  for (const expected of [
    "Mozilla Public License 2.0",
    "SIL Open Font License 1.1",
    "bumpalo@3.20.2",
    "typed-path@0.12.3",
    "zip@8.6.0",
    "zlib-rs@0.6.6",
    "zopfli@0.8.3",
  ]) {
    if (!(html + notices.replaceAll(" | ", "@")).includes(expected)) {
      fail(`${label} compliance records are missing ${expected}`);
    }
  }
}

function verifyCuaResources(resources, label, {
  directoryMode = 0o755,
  validateRuntimePath = true,
} = {}) {
  requireDirectoryMode(resources, directoryMode);
  const cuaRoot = path.join(resources, "cua-linux-x64");
  const licenses = path.join(cuaRoot, "licenses");
  requireDirectoryMode(cuaRoot, directoryMode);
  requireDirectoryMode(licenses, directoryMode);
  requireExactEntries(cuaRoot, ["cua-driver", "cua-cursor-theme", "licenses", "release.json"]);
  requireExactEntries(licenses, [
    "LICENSE.md",
    "Inter-OFL-1.1.txt",
    "THIRD_PARTY_LICENSES.html",
    "THIRD_PARTY_NOTICES.md",
    "SBOM.cdx.json",
  ]);
  requireContained(resources, cuaRoot);
  requireContained(cuaRoot, licenses);
  const driver = path.join(cuaRoot, "cua-driver");
  const cursorTheme = path.join(cuaRoot, "cua-cursor-theme");
  requireRegularMode(driver, 0o755);
  requireRegularMode(cursorTheme, 0o755);
  requireContained(cuaRoot, driver);
  requireContained(cuaRoot, cursorTheme);
  const expectedHashes = new Map([
    [driver, "ed5844fadf07b9b72c4a3b3802e1c47233c166d66d6198608d5991f807aab4ac"],
    [cursorTheme, "e589b2b7521bbfeaf9e2bfce668a38e80ed1b9790b1327b13d374fc331d8312a"],
  ]);
  for (const [file, expected] of expectedHashes) {
    const actual = sha256(file);
    if (actual !== expected) fail(`${label} has the wrong hash for ${path.basename(file)}: ${actual}`);
  }

  const commandEnvironment = {
    LANG: "C",
    LC_ALL: "C",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
  };
  const version = execFileSync(driver, ["--version"], {
    encoding: "utf8",
    env: commandEnvironment,
    timeout: 5_000,
  }).trim();
  if (version !== "cua-driver 0.19.3") fail(`${label} CUA version is ${JSON.stringify(version)}`);
  const manifest = JSON.parse(
    execFileSync(driver, ["manifest"], {
      encoding: "utf8",
      env: commandEnvironment,
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    }),
  );
  const invocationCommand = manifest.mcp_invocation?.command;
  let invocationPath = null;
  if (typeof invocationCommand === "string" && invocationCommand.length > 0) {
    try {
      invocationPath = realpathSync(invocationCommand);
    } catch {}
  }
  if (
    manifest.schema_version !== "1" ||
    manifest.binary_version !== "0.19.3" ||
    invocationPath !== realpathSync(driver) ||
    JSON.stringify(manifest.mcp_invocation?.args) !== JSON.stringify(["mcp"])
  ) {
    fail(`${label} CUA manifest does not match the packaged executable`);
  }

  for (const name of LICENSE_FILES) {
    requireRegularMode(path.join(licenses, name), 0o644);
    requireContained(licenses, path.join(licenses, name));
  }
  requireRegularMode(path.join(cuaRoot, "release.json"), 0o644);
  const release = JSON.parse(readFileSync(path.join(cuaRoot, "release.json"), "utf8"));
  const expectedRelease = {
    schemaVersion: 1,
    version: "0.19.3",
    platform: "linux",
    arch: "x64",
    archive: {
      name: "cua-driver-rs-0.19.3-linux-x86_64-binary.tar.gz",
      url:
        "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.19.3/" +
        "cua-driver-rs-0.19.3-linux-x86_64-binary.tar.gz",
      size: 27_248_614,
      sha256: "3db9d4257d84bacaf7eb104d225f85613ce67edbb20d6eeb83c1384b6d8a5b10",
    },
    sourceCommit: "a1672e7b11951275ecfba3384264d4530185d0db",
    files: {
      "cua-driver": { sha256: expectedHashes.get(driver), mode: "0755" },
      "cua-cursor-theme": { sha256: expectedHashes.get(cursorTheme), mode: "0755" },
    },
  };
  if (JSON.stringify(release) !== JSON.stringify(expectedRelease)) {
    fail(`${label} release.json does not match the reviewed Linux CUA release`);
  }
  const sbom = JSON.parse(readFileSync(path.join(licenses, "SBOM.cdx.json"), "utf8"));
  const components = new Set(
    (sbom.components ?? []).map((component) => `${component.name}@${component.version}`),
  );
  for (const expected of ["uniffi_core@0.31.0", "option-ext@0.2.0"]) {
    if (!components.has(expected)) fail(`${label} SBOM is missing ${expected}`);
  }
  verifyCompliance(licenses, label);

  if (validateRuntimePath) {
    const validation = validateDriverCandidate(driver);
    if (validation.status !== "found" || validation.path !== realpathSync(driver)) {
      fail(`${label} packaged CUA path fails the runtime trust policy: ${JSON.stringify(validation)}`);
    }
  }
  return expectedHashes;
}

function verifyCloudflaredResources(resources, label, { directoryMode = 0o755 } = {}) {
  const cloudflaredRoot = path.join(resources, "cloudflared");
  const executable = path.join(cloudflaredRoot, "cloudflared");
  requireDirectoryMode(cloudflaredRoot, directoryMode);
  requireExactEntries(cloudflaredRoot, ["cloudflared"]);
  requireContained(resources, cloudflaredRoot);
  requireRegularMode(executable, 0o755);
  requireContained(cloudflaredRoot, executable);

  const expectedHash = CLOUDFLARED_ASSETS["linux-x64"].binarySha256;
  const actualHash = sha256(executable);
  if (actualHash !== expectedHash) {
    fail(`${label} has the wrong hash for cloudflared: ${actualHash}`);
  }
  if (executableTarget(readFileSync(executable)) !== "linux-x64") {
    fail(`${label} cloudflared does not contain the reviewed Linux x64 executable`);
  }
  const version = execFileSync(executable, ["version"], {
    encoding: "utf8",
    timeout: 5_000,
  }).trim();
  if (!version.startsWith(`cloudflared version ${CLOUDFLARED_VERSION} `)) {
    fail(`${label} cloudflared version is ${JSON.stringify(version)}`);
  }

  const licenses = path.join(resources, "licenses");
  requireDirectoryMode(licenses, directoryMode);
  for (const name of ["cloudflared-LICENSE.txt", "cloudflared-README.md"]) {
    requireRegularMode(path.join(licenses, name), 0o644);
    requireContained(licenses, path.join(licenses, name));
  }
  if (sha256(path.join(licenses, "cloudflared-LICENSE.txt")) !== sha256(path.join(root, "LICENSE"))) {
    fail(`${label} cloudflared license text differs from the reviewed Apache 2.0 text`);
  }
  if (
    sha256(path.join(licenses, "cloudflared-README.md")) !==
    sha256(path.join(root, "third_party", "cloudflared", "README.md"))
  ) {
    fail(`${label} cloudflared release provenance differs from the reviewed record`);
  }

  return actualHash;
}

const appImage = exactlyOne(".AppImage");
const deb = exactlyOne(".deb");
const unpacked = path.join(releaseDir, "linux-unpacked");
const executable = path.join(unpacked, "openmausbot");
const resources = path.join(unpacked, "resources");

requireExecutable(appImage);
requireExecutable(executable);
requireDirectoryMode(unpacked, 0o755);
for (const relative of ["app.asar", "ui/index.html", "server/index.js"]) {
  requireFile(path.join(resources, relative));
}
for (const forbidden of ["speech-helper", "cua-driver", "cua-sdk"]) {
  if (statSync(path.join(resources, forbidden), { throwIfNoEntry: false })) {
    fail(`unsupported Linux resource was bundled: ${forbidden}`);
  }
}
const unpackedCuaHashes = verifyCuaResources(resources, "linux-unpacked");
const unpackedCloudflaredHash = verifyCloudflaredResources(resources, "linux-unpacked");
requireUpdaterTarget(resources, "linux-unpacked");

const fields = execFileSync(
  "dpkg-deb",
  ["--field", deb, "Package", "Version", "Architecture", "Maintainer", "Section", "Priority"],
  { encoding: "utf8" },
);
for (const expected of [
  "Package: openmausbot",
  "Architecture: amd64",
  "Maintainer: Milind Soni",
  "Section: utils",
  "Priority: optional",
]) {
  if (!fields.includes(expected)) fail(`DEB metadata is missing ${JSON.stringify(expected)}`);
}

const extracted = mkdtempSync(path.join(tmpdir(), "omb-deb-verify-"));
try {
  execFileSync("dpkg-deb", ["--extract", deb, extracted]);
  const debAppRoot = path.join(extracted, "opt", "OpenMausBot");
  requireDirectoryMode(debAppRoot, 0o755);
  const debResources = path.join(debAppRoot, "resources");
  // Routes the in-app updater to the package-manager hand-off.
  requirePackageType(debResources, "DEB", "deb");
  requireUpdaterTarget(debResources, "DEB");
  const debHashes = verifyCuaResources(debResources, "DEB");
  const debCloudflaredHash = verifyCloudflaredResources(debResources, "DEB");
  if (debCloudflaredHash !== unpackedCloudflaredHash) {
    fail(`DEB and linux-unpacked cloudflared hashes differ`);
  }
  for (const [unpackedFile, expected] of unpackedCuaHashes) {
    const packaged = path.join(debResources, "cua-linux-x64", path.basename(unpackedFile));
    if (debHashes.get(packaged) !== expected) fail(`DEB and linux-unpacked CUA hashes differ`);
  }
  const desktopFile = path.join(
    extracted,
    "usr",
    "share",
    "applications",
    "com.openmausbot.app.desktop",
  );
  const scalableIcon = path.join(
    extracted,
    "usr",
    "share",
    "icons",
    "hicolor",
    "scalable",
    "apps",
    "openmausbot.svg",
  );
  requireFile(desktopFile);
  requireFile(scalableIcon);
  const desktop = readFileSync(desktopFile, "utf8");
  for (const expected of [
    "Name=OpenMausBot",
    "Exec=/opt/OpenMausBot/openmausbot %U",
    "Icon=openmausbot",
    "StartupWMClass=com.openmausbot.app",
    "Categories=Utility;",
  ]) {
    if (!desktop.includes(expected)) fail(`desktop entry is missing ${JSON.stringify(expected)}`);
  }
  execFileSync("desktop-file-validate", [desktopFile], { stdio: "inherit" });
} finally {
  rmSync(extracted, { recursive: true, force: true });
}

const appImageExtracted = mkdtempSync(path.join(tmpdir(), "omb-appimage-verify-"));
try {
  const offset = execFileSync(appImage, ["--appimage-offset"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  if (!/^\d+$/.test(offset)) fail(`AppImage returned an invalid SquashFS offset: ${offset}`);
  const squashRoot = path.join(appImageExtracted, "squashfs-root");
  execFileSync(
    "unsquashfs",
    ["-no-progress", "-offset", offset, "-d", squashRoot, appImage],
    { stdio: ["ignore", "ignore", "inherit"], timeout: 60_000 },
  );
  const appImageDirectoryMode = lstatSync(squashRoot).mode & 0o777;
  if (![0o755, 0o775].includes(appImageDirectoryMode)) {
    fail(
      `expected AppImage directory mode 755 or 775 for ${squashRoot}, found ${appImageDirectoryMode.toString(8)}`,
    );
  }
  const appImageResources = path.join(squashRoot, "resources");
  // No marker: the AppImage keeps the in-place restart-to-update path.
  requirePackageType(appImageResources, "AppImage", null);
  requireUpdaterTarget(appImageResources, "AppImage");
  // Depending on the pinned appimagetool runtime, SquashFS directories are
  // emitted as root:root 0755 or 0775. Require one mode consistently across
  // the reviewed resource tree. The app never executes through that path:
  // Electron stages and re-hashes the two pinned binaries into a fresh 0700
  // directory first. The AppImage smoke below proves that packaged path,
  // while this extraction verifies inputs.
  const appImageHashes = verifyCuaResources(appImageResources, "AppImage", {
    directoryMode: appImageDirectoryMode,
    validateRuntimePath: false,
  });
  const appImageCloudflaredHash = verifyCloudflaredResources(appImageResources, "AppImage", {
    directoryMode: appImageDirectoryMode,
  });
  if (appImageCloudflaredHash !== unpackedCloudflaredHash) {
    fail(`AppImage and linux-unpacked cloudflared hashes differ`);
  }
  for (const [unpackedFile, expected] of unpackedCuaHashes) {
    const packaged = path.join(appImageResources, "cua-linux-x64", path.basename(unpackedFile));
    if (appImageHashes.get(packaged) !== expected) fail(`AppImage and linux-unpacked CUA hashes differ`);
  }
} finally {
  rmSync(appImageExtracted, { recursive: true, force: true });
}

console.log(`[verify-linux-package] OK\n- ${path.basename(appImage)}\n- ${path.basename(deb)}`);
