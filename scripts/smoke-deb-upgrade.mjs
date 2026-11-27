import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  throw new Error(`[smoke-deb-upgrade] ${message}`);
}

if (process.platform !== "linux" || process.env.CI !== "true" || process.getuid?.() !== 0) {
  fail("this system-package test runs only as root on an ephemeral Linux CI runner");
}
const runnerTemp = process.env.RUNNER_TEMP;
if (!runnerTemp || !path.isAbsolute(runnerTemp) || !fs.existsSync(runnerTemp)) {
  fail("RUNNER_TEMP must be an existing absolute CI path");
}
const candidate = path.resolve(process.argv[2] ?? "");
if (!candidate.endsWith(".deb") || !fs.existsSync(candidate)) fail("pass the newly built DEB path");

try {
  const status = execFileSync("dpkg-query", ["-W", "-f=${db:Status-Abbrev}", "openmausbot"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (status.startsWith("ii")) fail("refusing to replace a pre-existing OpenMausBot installation");
} catch (error) {
  if (String(error?.message ?? error).includes("refusing to replace")) throw error;
}

const temporary = fs.mkdtempSync(path.join(path.resolve(runnerTemp), "omb-deb-upgrade-"));
if (path.dirname(temporary) !== path.resolve(runnerTemp)) fail("temporary fixture escaped RUNNER_TEMP");
const legacyRoot = path.join(temporary, "legacy-package");
const controlRoot = path.join(legacyRoot, "DEBIAN");
const legacyApp = path.join(legacyRoot, "opt", "OpenMausBot");
const legacyResources = path.join(legacyApp, "resources");
const legacyDeb = path.join(temporary, "openmausbot_0.1.7_amd64.deb");

try {
  fs.mkdirSync(controlRoot, { recursive: true, mode: 0o755 });
  fs.mkdirSync(legacyResources, { recursive: true, mode: 0o775 });
  fs.chmodSync(legacyApp, 0o775);
  fs.chmodSync(legacyResources, 0o775);
  fs.writeFileSync(
    path.join(controlRoot, "control"),
    [
      "Package: openmausbot",
      "Version: 0.1.7",
      "Architecture: amd64",
      "Maintainer: OpenMausBot CI <ci@openmausbot.invalid>",
      "Description: Legacy OpenMausBot directory-mode upgrade fixture",
      "",
    ].join("\n"),
    { mode: 0o644 },
  );
  fs.writeFileSync(path.join(legacyResources, "legacy-upgrade-fixture"), "0.1.7\n", { mode: 0o644 });

  execFileSync("dpkg-deb", ["--build", "--root-owner-group", legacyRoot, legacyDeb], {
    stdio: "inherit",
  });
  execFileSync("dpkg", ["--install", legacyDeb], { stdio: "inherit" });
  for (const directory of ["/opt/OpenMausBot", "/opt/OpenMausBot/resources"]) {
    const mode = fs.lstatSync(directory).mode & 0o777;
    if (mode !== 0o775) fail(`legacy fixture did not reproduce 0775 at ${directory}`);
  }

  // apt configures the real artifact and resolves its declared desktop
  // dependencies. Calling dpkg directly can leave the package unconfigured on
  // the intentionally minimal runner before its post-install hook is tested.
  execFileSync("apt-get", ["install", "-y", "--no-install-recommends", candidate], {
    env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
    stdio: "inherit",
  });
  for (const directory of [
    "/opt/OpenMausBot",
    "/opt/OpenMausBot/resources",
    "/opt/OpenMausBot/resources/cua-linux-x64",
  ]) {
    const details = fs.lstatSync(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) fail(`unsafe upgraded directory: ${directory}`);
    if (details.uid !== 0 || details.gid !== 0 || (details.mode & 0o777) !== 0o755) {
      fail(`upgraded directory is not root:root 0755: ${directory}`);
    }
  }
  for (const executable of ["cua-driver", "cua-cursor-theme"]) {
    const file = path.join("/opt/OpenMausBot/resources/cua-linux-x64", executable);
    const details = fs.lstatSync(file);
    if (!details.isFile() || details.isSymbolicLink()) fail(`unsafe upgraded executable: ${file}`);
    if (details.uid !== 0 || details.gid !== 0 || (details.mode & 0o777) !== 0o755) {
      fail(`upgraded executable is not root:root 0755: ${file}`);
    }
  }
  const chromiumSandbox = "/opt/OpenMausBot/chrome-sandbox";
  const sandboxDetails = fs.lstatSync(chromiumSandbox);
  if (!sandboxDetails.isFile() || sandboxDetails.isSymbolicLink()) {
    fail(`unsafe upgraded Chromium sandbox: ${chromiumSandbox}`);
  }
  if (
    sandboxDetails.uid !== 0 ||
    sandboxDetails.gid !== 0 ||
    (sandboxDetails.mode & 0o7777) !== 0o4755
  ) {
    fail(`upgraded Chromium sandbox is not root:root 4755: ${chromiumSandbox}`);
  }
  const installedVersion = execFileSync("dpkg-query", ["-W", "-f=${Version}", "openmausbot"], {
    encoding: "utf8",
  }).trim();
  console.log(
    `[smoke-deb-upgrade] OK: 0.1.7 legacy modes repaired by ${installedVersion} without weakening the runtime path`,
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
