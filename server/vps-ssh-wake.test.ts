import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureVpsSshMaster, prepareVpsSsh, VPS_SSH_DIR, VPS_WAKE_SCRIPT } from "./vps-ssh.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A host that refuses SSH until something creates its `awake` file, as a box paused when idle does until resumed. */
function pausedHost() {
  const root = mkdtempSync(join(tmpdir(), "omb-vps-wake-"));
  roots.push(root);
  const bin = join(root, "bin");
  const data = join(root, "data");
  mkdirSync(bin);
  mkdirSync(data);
  const awake = join(root, "awake");
  const calls = join(root, "calls");
  writeFileSync(join(bin, "ssh"), [
    "#!/bin/sh",
    `echo "$*" >> '${calls}'`,
    'case " $* " in *" check "*) exit 255;; esac',
    `[ -f '${awake}' ] && exit 0`,
    "echo 'ssh: connect to host paused.example port 22: Connection refused' >&2",
    "exit 255",
    "",
  ].join("\n"), { mode: 0o700 });
  const ssh = prepareVpsSsh(data, bin, "linux");
  const wakePath = join(data, VPS_SSH_DIR, VPS_WAKE_SCRIPT);
  const sshCalls = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
  return {
    ssh, awake,
    wakeWith: (body: string, mode = 0o700) => writeFileSync(wakePath, `#!/bin/sh\n${body}\n`, { mode }),
    connectAttempts: () => sshCalls().filter((line) => line.endsWith(" true")).length,
  };
}

describe.skipIf(process.platform === "win32")("VPS wake script", () => {
  it("without a wake script, an unreachable host fails as before", async () => {
    const host = pausedHost();
    await expect(ensureVpsSshMaster(host.ssh, "paused-vps")).rejects.toThrow("Connection refused");
    expect(host.connectAttempts()).toBe(1);
  });

  it("runs the wake script with the alias when the host can't be reached, then connects", async () => {
    const host = pausedHost();
    host.wakeWith(`echo "$1" > '${host.awake}'`);
    await expect(ensureVpsSshMaster(host.ssh, "paused-vps")).resolves.toBeGreaterThanOrEqual(0);
    expect(readFileSync(host.awake, "utf8").trim()).toBe("paused-vps");
    expect(host.connectAttempts()).toBe(2);
  });

  it("does not run the wake script for a host that answers", async () => {
    const host = pausedHost();
    writeFileSync(host.awake, "already up");
    host.wakeWith(`echo woken > '${host.awake}'`);
    await expect(ensureVpsSshMaster(host.ssh, "awake-vps")).resolves.toBe(0);
    expect(readFileSync(host.awake, "utf8")).toBe("already up");
    expect(host.connectAttempts()).toBe(1);
  });

  it("says when the wake script itself fails, and does not try again", async () => {
    const host = pausedHost();
    host.wakeWith("echo 'box not found' >&2; exit 3");
    await expect(ensureVpsSshMaster(host.ssh, "paused-vps")).rejects.toThrow(/Connection refused; the wake script failed: box not found/);
    expect(host.connectAttempts()).toBe(1);
  });

  it("reports the time the wake script took, so the caller's command timeout does not count it", async () => {
    const host = pausedHost();
    host.wakeWith(`PATH=/usr/bin:/bin; sleep 0.4; echo up > '${host.awake}'`);
    await expect(ensureVpsSshMaster(host.ssh, "paused-vps")).resolves.toBeGreaterThanOrEqual(350);
  });

  it("stops a wake script that runs past its own limit", async () => {
    const host = pausedHost();
    host.wakeWith(`PATH=/usr/bin:/bin; sleep 5; echo up > '${host.awake}'`);
    const started = Date.now();
    await expect(ensureVpsSshMaster(host.ssh, "paused-vps", 30_000, 300)).rejects.toThrow(/the wake script failed: VPS SSH initialization timed out/);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(existsSync(host.awake)).toBe(false);
    expect(host.connectAttempts()).toBe(1);
  });

  it("also stops what a timed-out wake script started", async () => {
    const host = pausedHost();
    const late = `${host.awake}-late`;
    host.wakeWith(`PATH=/usr/bin:/bin; (sleep 1; echo late > '${late}') & sleep 5`);
    await expect(ensureVpsSshMaster(host.ssh, "paused-vps", 30_000, 300)).rejects.toThrow(/the wake script failed: VPS SSH initialization timed out/);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(existsSync(late)).toBe(false);
  });

  it("credits a caller that joins a wake under way only with the time it waited", async () => {
    const host = pausedHost();
    host.wakeWith(`PATH=/usr/bin:/bin; sleep 0.6; echo up > '${host.awake}'`);
    const first = ensureVpsSshMaster(host.ssh, "paused-vps");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const joined = await ensureVpsSshMaster(host.ssh, "paused-vps");
    const firstWoke = await first;
    expect(firstWoke).toBeGreaterThanOrEqual(550);
    expect(joined).toBeLessThan(firstWoke - 250);
    expect(host.connectAttempts()).toBe(2);
  });

  it("ignores a wake file that is not executable", async () => {
    const host = pausedHost();
    host.wakeWith(`echo "$1" > '${host.awake}'`, 0o600);
    await expect(ensureVpsSshMaster(host.ssh, "paused-vps")).rejects.toThrow("Connection refused");
    expect(existsSync(host.awake)).toBe(false);
  });
});
