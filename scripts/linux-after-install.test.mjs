import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(root, "build", "linux-after-install.sh");
const removeHook = path.join(root, "build", "linux-after-remove.sh");
const browserPolicy = path.join(root, "build", "linux-openmausbot-browser.apparmor");
const temporaryDirectories = [];

function fixture() {
  const appRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omb-deb-upgrade-"));
  temporaryDirectories.push(appRoot);
  const resources = path.join(appRoot, "resources");
  const cuaRoot = path.join(resources, "cua-linux-x64");
  fs.mkdirSync(cuaRoot, { recursive: true, mode: 0o775 });
  for (const directory of [appRoot, resources, cuaRoot]) fs.chmodSync(directory, 0o775);
  for (const executable of ["cua-driver", "cua-cursor-theme"]) {
    fs.writeFileSync(path.join(cuaRoot, executable), "fixture", { mode: 0o664 });
    fs.chmodSync(path.join(cuaRoot, executable), 0o664);
  }
  const chromiumSandbox = path.join(appRoot, "chrome-sandbox");
  fs.writeFileSync(chromiumSandbox, "fixture", { mode: 0o664 });
  fs.chmodSync(chromiumSandbox, 0o664);
  const browserRoot = path.join(resources, "browser-engine");
  const chromeRoot = path.join(browserRoot, "chrome", "chrome-headless-shell-linux64");
  fs.mkdirSync(chromeRoot, { recursive: true });
  for (const directory of [browserRoot, path.dirname(chromeRoot), chromeRoot]) fs.chmodSync(directory, 0o775);
  fs.writeFileSync(path.join(browserRoot, "agent-browser"), "fixture", { mode: 0o664 });
  fs.writeFileSync(path.join(chromeRoot, "chrome-headless-shell"), "fixture", { mode: 0o664 });
  fs.writeFileSync(path.join(chromeRoot, "chrome_crashpad_handler"), "fixture", { mode: 0o775 });
  fs.writeFileSync(path.join(chromeRoot, "icudtl.dat"), "fixture", { mode: 0o664 });
  fs.copyFileSync(browserPolicy, path.join(resources, "openmausbot-browser.apparmor"));
  const systemRoot = path.join(appRoot, "test-system");
  const apparmorDir = path.join(systemRoot, "apparmor.d");
  fs.mkdirSync(apparmorDir, { recursive: true });
  fs.chmodSync(apparmorDir, 0o755);
  const parser = path.join(systemRoot, "apparmor_parser");
  fs.writeFileSync(parser, '#!/bin/sh\nprintf "profile operation: %s %s\\n" "$1" "$2"\n', { mode: 0o755 });
  const apparmorStatus = path.join(systemRoot, "apparmor_status");
  fs.writeFileSync(apparmorStatus, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(systemRoot, "apparmor_restrict_unprivileged_userns"), "1\n");
  fs.writeFileSync(path.join(systemRoot, "apparmor-profiles"), "openmausbot-browser (unconfined)\n");
  return { appRoot, resources, cuaRoot, chromiumSandbox, browserRoot, chromeRoot, systemRoot, apparmorDir, parser, apparmorStatus };
}

function runHook(appRoot) {
  return spawnSync("/bin/sh", [hook], {
    encoding: "utf8",
    env: { ...process.env, OPENMAUSBOT_POSTINSTALL_TEST_ROOT: appRoot },
  });
}

function runRemoveHook(appRoot, operation = "remove") {
  return spawnSync("/bin/sh", [removeHook, operation], {
    encoding: "utf8",
    env: { ...process.env, OPENMAUSBOT_POSTINSTALL_TEST_ROOT: appRoot },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Linux DEB sandbox policy", () => {
  it("allows user namespaces only for the exact installed browser executable", () => {
    const policy = fs.readFileSync(browserPolicy, "utf8").replace(/^\s*#.*$/gm, "");
    expect(policy).toContain("profile openmausbot-browser /opt/OpenMausBot/resources/browser-engine/chrome/chrome-headless-shell-linux64/chrome-headless-shell flags=(unconfined)");
    expect(policy).toContain("userns,");
    expect(policy).not.toMatch(/\*|@\{HOME\}|\/home\/|\/tmp\//);
  });

  it.skipIf(process.platform === "win32")("keeps both privileged hooks valid POSIX shell", () => {
    for (const script of [hook, removeHook]) {
      const result = spawnSync("/bin/sh", ["-n", script], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
  });
});

describe.skipIf(process.platform !== "linux")("Linux DEB upgrade hook", () => {
  it("repairs legacy directory and executable modes idempotently", () => {
    const { appRoot, resources, cuaRoot, chromiumSandbox, browserRoot, chromeRoot, apparmorDir } = fixture();

    for (let pass = 0; pass < 2; pass += 1) {
      const result = runHook(appRoot);
      expect(result.status, result.stderr).toBe(0);
      for (const directory of [appRoot, resources, cuaRoot, browserRoot, path.dirname(chromeRoot), chromeRoot]) {
        expect(fs.lstatSync(directory).mode & 0o777).toBe(0o755);
      }
      for (const executable of ["cua-driver", "cua-cursor-theme"]) {
        expect(fs.lstatSync(path.join(cuaRoot, executable)).mode & 0o777).toBe(0o755);
      }
      expect(fs.lstatSync(chromiumSandbox).mode & 0o7777).toBe(0o4755);
      for (const executable of [path.join(browserRoot, "agent-browser"), path.join(chromeRoot, "chrome-headless-shell"), path.join(chromeRoot, "chrome_crashpad_handler")]) {
        expect(fs.lstatSync(executable).mode & 0o7777).toBe(0o755);
      }
      expect(fs.lstatSync(path.join(chromeRoot, "icudtl.dat")).mode & 0o777).toBe(0o644);
      expect(fs.readFileSync(path.join(apparmorDir, "openmausbot-browser"), "utf8")).toBe(fs.readFileSync(browserPolicy, "utf8"));
      expect(result.stdout).toContain(`profile operation: -r ${apparmorDir}/openmausbot-browser`);
    }
  });

  it("refuses to follow a replaced package directory symlink", () => {
    const { appRoot, resources } = fixture();
    const external = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omb-deb-external-"));
    temporaryDirectories.push(external);
    fs.chmodSync(external, 0o777);
    fs.rmSync(resources, { recursive: true });
    fs.symlinkSync(external, resources, "dir");

    const result = runHook(appRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing or unsafe");
    expect(fs.lstatSync(external).mode & 0o777).toBe(0o777);
  });

  it("fails the install when a bundled executable is missing", () => {
    const { appRoot, cuaRoot } = fixture();
    fs.unlinkSync(path.join(cuaRoot, "cua-driver"));

    const result = runHook(appRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("package executable is missing or unsafe");
  });

  it("fails the install when the Chromium sandbox is replaced by a symlink", () => {
    const { appRoot, chromiumSandbox } = fixture();
    const external = path.join(appRoot, "external-sandbox");
    fs.writeFileSync(external, "fixture", { mode: 0o755 });
    fs.unlinkSync(chromiumSandbox);
    fs.symlinkSync(external, chromiumSandbox, "file");

    const result = runHook(appRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Chromium sandbox is missing or unsafe");
  });

  it("refuses browser sidecar symlinks without changing their targets", () => {
    const { appRoot, chromeRoot } = fixture();
    const external = path.join(appRoot, "external-browser-library");
    fs.writeFileSync(external, "outside", { mode: 0o666 });
    fs.chmodSync(external, 0o666);
    fs.symlinkSync(external, path.join(chromeRoot, "libEGL.so"));
    const result = runHook(appRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("browser resource is missing or unsafe");
    expect(fs.lstatSync(external).mode & 0o777).toBe(0o666);
  });

  it("fails closed if the restricted host cannot load AppArmor policy", () => {
    const { appRoot, parser } = fixture();
    fs.unlinkSync(parser);
    const result = runHook(appRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("needs apparmor and apparmor_parser");
  });

  it("refuses browser hard links without changing another file's permissions", () => {
    const { appRoot, chromeRoot } = fixture();
    const external = path.join(appRoot, "external-browser-data");
    fs.writeFileSync(external, "outside", { mode: 0o666 });
    fs.chmodSync(external, 0o666);
    fs.linkSync(external, path.join(chromeRoot, "linked-data"));
    const result = runHook(appRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsafe hard link");
    expect(fs.lstatSync(external).mode & 0o777).toBe(0o666);
  });

  it("does not require AppArmor when user namespaces are unrestricted", () => {
    const { appRoot, systemRoot, parser } = fixture();
    fs.unlinkSync(parser);
    fs.writeFileSync(path.join(systemRoot, "apparmor_restrict_unprivileged_userns"), "0\n");
    expect(runHook(appRoot).status).toBe(0);
  });

  it("reads numeric procfs sysctls without byte-at-a-time shell reads", () => {
    const { appRoot, systemRoot } = fixture();
    // A harmless read-only stand-in with the same numeric procfs handler.
    // Unlike an ordinary fixture file, procfs ends a subsequent read at EOF;
    // dash's read builtin therefore exits 1 before seeing the newline.
    const procSysctl = "/proc/sys/kernel/core_uses_pid";
    expect(fs.readFileSync(procSysctl, "utf8").trim()).toMatch(/^[01]$/);
    const restriction = path.join(systemRoot, "apparmor_restrict_unprivileged_userns");
    fs.unlinkSync(restriction);
    fs.symlinkSync(procSysctl, restriction);
    const result = runHook(appRoot);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("profile operation: -r");
  });

  it.each(["0", "1"])("reads an unterminated restriction value %s", (value) => {
    const { appRoot, systemRoot } = fixture();
    fs.writeFileSync(path.join(systemRoot, "apparmor_restrict_unprivileged_userns"), value);
    const result = runHook(appRoot);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("profile operation: -r");
  });

  it.each(["", "2\n", "0 1\n", "disabled\n"])("fails closed for an invalid restriction value %j", (value) => {
    const { appRoot, systemRoot } = fixture();
    fs.writeFileSync(path.join(systemRoot, "apparmor_restrict_unprivileged_userns"), value);
    const result = runHook(appRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restriction is invalid");
    expect(result.stdout).not.toContain("profile operation");
  });

  it("stages but does not load policy when AppArmor is disabled on an unrestricted host", () => {
    const { appRoot, systemRoot, apparmorStatus, apparmorDir } = fixture();
    fs.writeFileSync(apparmorStatus, "#!/bin/sh\nexit 1\n");
    fs.writeFileSync(path.join(systemRoot, "apparmor_restrict_unprivileged_userns"), "0\n");
    const result = runHook(appRoot);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("profile operation");
    expect(fs.readFileSync(path.join(apparmorDir, "openmausbot-browser"), "utf8")).toBe(fs.readFileSync(browserPolicy, "utf8"));
  });

  it("does not claim sandbox setup when restriction is active but AppArmor is unavailable", () => {
    const { appRoot, apparmorStatus } = fixture();
    fs.writeFileSync(apparmorStatus, "#!/bin/sh\nexit 1\n");
    const result = runHook(appRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restrictions are active but AppArmor is unavailable");
    expect(result.stdout).not.toContain("profile operation");
  });

  it("refuses an AppArmor destination symlink without overwriting its target", () => {
    const { appRoot, apparmorDir } = fixture();
    const external = path.join(appRoot, "external-policy");
    fs.writeFileSync(external, "outside");
    fs.symlinkSync(external, path.join(apparmorDir, "openmausbot-browser"));
    const result = runHook(appRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("profile target is unsafe");
    expect(fs.readFileSync(external, "utf8")).toBe("outside");
  });

  it("keeps the profile on upgrade and removes only its own policy on uninstall", () => {
    const { appRoot, apparmorDir } = fixture();
    expect(runHook(appRoot).status).toBe(0);
    const profile = path.join(apparmorDir, "openmausbot-browser");
    const unrelated = path.join(apparmorDir, "another-app");
    fs.writeFileSync(unrelated, "unrelated policy");
    expect(runRemoveHook(appRoot, "upgrade").status).toBe(0);
    expect(fs.existsSync(profile)).toBe(true);
    const removed = runRemoveHook(appRoot);
    expect(removed.status, removed.stderr).toBe(0);
    expect(removed.stdout).toContain(`profile operation: -R ${profile}`);
    expect(fs.existsSync(profile)).toBe(false);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("unrelated policy");
    expect(runRemoveHook(appRoot, "purge").status).toBe(0);
  });

  it("removes an already unloaded profile without asking the kernel again", () => {
    const { appRoot, apparmorDir, systemRoot } = fixture();
    expect(runHook(appRoot).status).toBe(0);
    fs.writeFileSync(path.join(systemRoot, "apparmor-profiles"), "another-app (enforce)\n");
    const result = runRemoveHook(appRoot);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("profile operation");
    expect(fs.existsSync(path.join(apparmorDir, "openmausbot-browser"))).toBe(false);
  });

  it("removes staged policy without kernel operations when AppArmor is disabled", () => {
    const { appRoot, apparmorDir, apparmorStatus, parser } = fixture();
    expect(runHook(appRoot).status).toBe(0);
    fs.writeFileSync(apparmorStatus, "#!/bin/sh\nexit 1\n");
    fs.writeFileSync(parser, "#!/bin/sh\nexit 1\n");
    const result = runRemoveHook(appRoot);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("profile operation");
    expect(fs.existsSync(path.join(apparmorDir, "openmausbot-browser"))).toBe(false);
  });

  it("keeps the exact policy available for repair if the kernel refuses to unload it", () => {
    const { appRoot, apparmorDir, parser } = fixture();
    expect(runHook(appRoot).status).toBe(0);
    fs.writeFileSync(parser, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const result = runRemoveHook(appRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not unload");
    expect(fs.existsSync(path.join(apparmorDir, "openmausbot-browser"))).toBe(true);
  });

  it("does not delete a loaded policy when its AppArmor parser is missing", () => {
    const { appRoot, apparmorDir, parser } = fixture();
    expect(runHook(appRoot).status).toBe(0);
    fs.unlinkSync(parser);
    const result = runRemoveHook(appRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("needs apparmor_parser to unload");
    expect(fs.existsSync(path.join(apparmorDir, "openmausbot-browser"))).toBe(true);
  });

  it("rejects a test override outside the private temporary root", () => {
    const result = runHook(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must stay under /tmp");
  });

  it("resolves the test root before applying the temporary-directory boundary", () => {
    const escaped = path.join(fs.realpathSync(os.tmpdir()), "..", path.relative("/", root));
    const result = runHook(escaped);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must stay under /tmp");
  });
});
