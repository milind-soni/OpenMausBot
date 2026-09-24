import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareVpsSsh as prepare, vpsSshConfigText } from "./vps-ssh.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "omb-vps-ssh-")); dirs.push(dir); return dir; };
function prepareVpsSsh(...args: Parameters<typeof prepare>) {
  const result = prepare(...args);
  if (result.configPath) {
    const dir = dirname(JSON.parse(readFileSync(result.configPath, "utf8").match(/^  ControlPath (.+)$/m)![1]!));
    if (dir.startsWith("/tmp/omb-ssh-") && !dirs.includes(dir)) dirs.push(dir);
  }
  return result;
}

describe("VPS SSH connection sharing supplied by the app", () => {
  it("does nothing on Windows, where OpenSSH has no connection sharing", () => {
    const data = scratch();
    expect(prepareVpsSsh(data, "C:\\Windows\\System32", "win32")).toEqual({ configPath: null, path: "C:\\Windows\\System32" });
    expect(existsSync(join(data, "ssh"))).toBe(false);
  });
});

// The sharing itself is POSIX: forward-slash control paths, colon-separated
// PATH, file modes. Windows never installs it, so these do not run there.
describe.skipIf(process.platform === "win32")("VPS SSH connection sharing on POSIX", () => {
  it("writes a config that includes the person's own file first and fills in sharing and timeouts", () => {
    const home = scratch();
    const userConfig = join(home, "config"); writeFileSync(userConfig, "Host my-vps\n  ControlMaster no\n");
    const text = vpsSshConfigText("/data/ssh", userConfig, join(home, "missing-system-config"));
    const lines = text.split("\n");
    // theirs first, so ssh's first-value-wins rule keeps their choices
    expect(lines.findIndex((line) => line === `Include ${JSON.stringify(userConfig)}`)).toBeLessThan(lines.indexOf("Host *"));
    expect(text).toContain("  ControlMaster auto");
    expect(text).toContain('  ControlPath "/data/ssh/cm-%C"');
    expect(text).toContain("  ControlPersist 10m");
    expect(text).toContain("  ServerAliveInterval 15");
    expect(text).toContain("  ConnectTimeout 10");
    expect(text).not.toContain("missing-system-config");
    // no user file: no dangling Include
    expect(vpsSshConfigText("/data/ssh", join(home, "absent"), join(home, "absent2"))).not.toContain("Include");
  });

  it("installs a shim docker finds ahead of the real ssh, pointing at that config, with private modes", () => {
    const data = scratch(), fakeBin = scratch();
    const realSsh = join(fakeBin, "ssh"); writeFileSync(realSsh, "#!/bin/sh\nexit 0\n"); chmodSync(realSsh, 0o755);
    const setup = prepareVpsSsh(data, `${fakeBin}:/usr/bin`, "darwin");
    expect(setup.configPath).toBe(join(data, "ssh", "config"));
    expect(setup.path.split(":")[0]).toBe(join(data, "ssh", "bin"));
    const shim = readFileSync(join(data, "ssh", "bin", "ssh"), "utf8");
    expect(shim).toContain(`exec '${realSsh}' -F '${setup.configPath}' "$@"`);
    expect(statSync(join(data, "ssh", "bin", "ssh")).mode & 0o777).toBe(0o700);
    expect(statSync(setup.configPath!).mode & 0o777).toBe(0o600);
    expect(statSync(join(data, "ssh")).mode & 0o777).toBe(0o700);
    // idempotent: a second call leaves the same files
    expect(prepareVpsSsh(data, `${fakeBin}:/usr/bin`, "darwin")).toEqual(setup);
  });

  it("never picks its own shim as the real ssh, and leaves PATH alone when no ssh exists", () => {
    const data = scratch();
    mkdirSync(join(data, "ssh", "bin"), { recursive: true });
    writeFileSync(join(data, "ssh", "bin", "ssh"), "#!/bin/sh\n"); chmodSync(join(data, "ssh", "bin", "ssh"), 0o700);
    const setup = prepareVpsSsh(data, `${join(data, "ssh", "bin")}:${scratch()}`, "linux");
    expect(setup.path.startsWith(join(data, "ssh", "bin"))).toBe(true); // the caller's own PATH, unchanged
    expect(setup.path.split(":").filter((entry) => entry === join(data, "ssh", "bin"))).toHaveLength(1);
    expect(existsSync(setup.configPath!)).toBe(true);
  });

  it.skipIf(!existsSync("/usr/bin/ssh"))("quotes spaces in user config and socket paths for OpenSSH", () => {
    const home = scratch();
    const userConfig = join(home, "my config");
    writeFileSync(userConfig, "Host fixture-vps\n  HostName 192.0.2.1\n");
    const config = vpsSshConfigText("/isolated/space path/100%", userConfig, join(home, "absent"));
    // A real file, not /dev/stdin: spawnSync feeds stdin through a socketpair, and
    // Linux refuses to reopen it (ENXIO), so the CI runners cannot read the config.
    const generatedConfig = join(home, "generated config");
    writeFileSync(generatedConfig, config);
    const parsed = spawnSync("/usr/bin/ssh", ["-G", "-F", generatedConfig, "fixture-vps"], { encoding: "utf8" });
    expect(parsed.status, parsed.stderr).toBe(0);
    expect(parsed.stdout).toContain("hostname 192.0.2.1\n");
    expect(parsed.stdout).toContain("controlpath /isolated/space path/100%/cm-");
  });

  it("uses a stable private short socket path for a long data directory", () => {
    const data = join(scratch(), "long-data-path-".repeat(10));
    const setup = prepareVpsSsh(data, "/usr/bin", "darwin");
    const controlPath = JSON.parse(readFileSync(setup.configPath!, "utf8").match(/^  ControlPath (.+)$/m)![1]!);
    expect(Buffer.byteLength(controlPath.replace("%C", "0".repeat(40)))).toBeLessThanOrEqual(80);
    expect(statSync(dirname(controlPath)).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(controlPath)).uid).toBe(process.getuid!());
    expect(prepareVpsSsh(data, "/usr/bin", "darwin")).toEqual(setup);
  });

  it("does not follow a pre-existing symlink for the short control directory", () => {
    const data = join(scratch(), "long-data-path-".repeat(10));
    const id = createHash("sha256").update(resolve(data, "ssh")).digest("hex").slice(0, 12);
    const controlDir = `/tmp/omb-ssh-${process.getuid!()}-${id}`;
    dirs.push(controlDir);
    const target = scratch();
    symlinkSync(target, controlDir);
    expect(() => prepare(data, "/usr/bin", "linux")).toThrow("not private");
  });

  it("keeps shell metacharacters literal in executable and data paths", () => {
    const data = join(scratch(), "data $UNSET `literal` 'quoted'");
    const bin = join(scratch(), "bin $UNSET `literal` 'quoted'");
    mkdirSync(bin);
    const realSsh = join(bin, "ssh");
    writeFileSync(realSsh, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const setup = prepareVpsSsh(data, bin, "linux");
    const result = spawnSync(join(data, "ssh", "bin", "ssh"), ["fixture-vps", "arg with spaces"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split("\n").slice(0, -1)).toEqual(["-F", setup.configPath, "fixture-vps", "arg with spaces"]);
  });

});
