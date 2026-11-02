import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { demuxLogs, negotiateApi, pullFailure, pullParams, type DockerInfo } from "../src/docker.ts";
import { BOX_PROBE, boxProbeFix, hostChecks, hostFacts, hostHealth, probeBox, usernsAllowed, type HostReader } from "../src/host.ts";
import { FakeDocker } from "./fake-docker.ts";

const info: DockerInfo = {
  ServerVersion: "28.0.4", OperatingSystem: "Ubuntu 24.04.3 LTS", KernelVersion: "6.8.0-1021-azure", Architecture: "x86_64", NCPU: 4,
  MemTotal: 16 * 1073741824, SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"], DockerRootDir: "/var/lib/docker",
};
const proc: Record<string, string> = {
  "/proc/sys/user/max_user_namespaces": "63786\n", "/proc/sys/kernel/unprivileged_userns_clone": "1\n",
  "/proc/meminfo": "MemTotal:       16384000 kB\nMemFree:  100 kB\nMemAvailable:    8192000 kB\n", "/proc/loadavg": "0.42 0.30 0.20 1/300 4242\n", "/proc/uptime": "12345.67 9999.00\n",
};
const reader = (overrides: Partial<HostReader> & { procs?: Record<string, string | null> } = {}): HostReader => ({
  proc: (path) => (overrides.procs && path in overrides.procs ? overrides.procs[path] : proc[path] ?? null),
  installedSeccomp: () => "{}",
  shippedSeccomp: () => "{}",
  disk: () => ({ free: 120e9, total: 200e9 }),
  ...overrides,
});
const failing = (checks: { id: string; ok: boolean; warning?: boolean; fix?: string }[]) => checks.filter((check) => !check.ok || check.warning).map(({ id, ok, fix }) => ({ id, ok, fix }));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the server's facts and checks", () => {
  it("reports what MausBot needs to know, from Docker's own report and the host's /proc", () => {
    expect(hostFacts(info, reader())).toEqual({ os: "Ubuntu 24.04.3 LTS", kernel: "6.8.0-1021-azure", arch: "x86_64", cpus: 4, memMb: 16384, diskGb: 120, docker: "28.0.4", apparmor: true, userns: true });
    expect(hostHealth(info, reader(), { clockSkewS: 2, box: { ok: true } })).toMatchObject({ diskTotalGb: 200, memAvailableMb: 8000, load1: 0.42, uptimeS: 12345, clockSkewS: 2 });
    expect(failing(hostChecks(info, reader(), { clockSkewS: 2, box: { ok: true } }))).toEqual([]);
  });

  it("says what is wrong in plain words, with the exact fix, for each check that fails", () => {
    const fixes = (value: DockerInfo, read: HostReader, extra = { clockSkewS: 0 as number | null, box: { ok: true } as { ok: boolean; fix?: string } }) => failing(hostChecks(value, read, extra));
    expect(fixes({ ...info, Architecture: "aarch64" }, reader())).toEqual([{ id: "arch", ok: false, fix: "This server has an ARM processor. MausBot runs on Intel or AMD (x86-64) servers for now. Please pick an x86-64 server." }]);
    expect(fixes({ ...info, ServerVersion: "20.10.24" }, reader())[0]).toEqual({ id: "docker", ok: false, fix: "Docker 20.10.24 is too old; MausBot needs Docker 24 or newer. Run: curl -fsSL https://get.docker.com | sudo sh" });
    expect(fixes({ ...info, SecurityOptions: [...info.SecurityOptions!, "name=rootless"] }, reader())[0].id).toBe("rootless");
    expect(fixes({ ...info, SecurityOptions: ["name=seccomp,profile=builtin"] }, reader())[0]).toMatchObject({ id: "apparmor", fix: expect.stringContaining("sudo apt-get install -y apparmor") });
    expect(fixes(info, reader({ installedSeccomp: () => null }))[0]).toEqual({ id: "profiles", ok: false, fix: "The bot box's security profiles on this server are missing or out of date. Run the install command again." });
    expect(fixes(info, reader({ installedSeccomp: () => '{"old":true}' }))[0].id).toBe("profiles");
    expect(fixes(info, reader({ procs: { "/proc/sys/kernel/unprivileged_userns_clone": "0\n" } }))[0]).toMatchObject({ id: "userns", fix: expect.stringContaining("kernel.unprivileged_userns_clone=1") });
    expect(fixes(info, reader({ procs: { "/proc/sys/user/max_user_namespaces": "0" } }))[0].id).toBe("userns");
    expect(fixes(info, reader(), { clockSkewS: 0, box: { ok: false, fix: "the probe's words" } })).toEqual([{ id: "box", ok: false, fix: "the probe's words" }]);
    expect(fixes(info, reader({ disk: () => ({ free: 12e9, total: 200e9 }) }))).toEqual([{ id: "disk", ok: false, fix: "Your server has only 12 GB free. MausBot needs at least 20 GB: free some space or add a disk." }]);
    expect(fixes(info, reader({ disk: () => ({ free: 25e9, total: 200e9 }) }))).toEqual([{ id: "disk", ok: true, fix: "Your server's disk is 88% full. Free some space or add a disk before it fills up." }]);
    expect(fixes({ ...info, MemTotal: 2 * 1073741824 }, reader())).toEqual([{ id: "memory", ok: true, fix: "This server has 2 GB of memory; bots will be slow or stop. We suggest at least 4 GB, and 32 GB for a team of five." }]);
    expect(fixes(info, reader(), { clockSkewS: -700, box: { ok: true } })).toEqual([{ id: "clock", ok: false, fix: "Your server's clock is 12 minutes off, so it can't check our messages. Run: sudo timedatectl set-ntp true" }]);
    expect(usernsAllowed({ proc: () => null })).toBe(true);
  });

  it("runs the box probe from its own image with the home's security settings, as nobody, and says whose the fix is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-connector-probe-"));
    dirs.push(dir);
    const docker = new FakeDocker(dir);
    const image = `ghcr.io/milind-soni/mausbot-connector@sha256:${"1".repeat(64)}`;
    docker.publish(image, null);
    await docker.pull(image);
    expect(await probeBox(docker, image, "{}")).toEqual({ ok: true });
    expect(docker.helperRuns.at(-1)).toEqual(BOX_PROBE);
    docker.probe = { code: 1, output: "bwrap: Failed to make / slave: Permission denied\n" };
    expect(await probeBox(docker, image, "{}")).toEqual({ ok: false, fix: "Our bots' safety box can't start on this server yet: its AppArmor profile is not loaded. Run the install command again to repair it." });
    expect([...docker.containers.keys()]).toEqual([]);
    const created = docker.calls.filter((call) => call.startsWith("create mausbot-probe-"));
    expect(created).toHaveLength(2);
    expect(boxProbeFix("bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.")).toContain("its seccomp profile was not applied");
    expect(boxProbeFix("bwrap: Can't mount proc on /newroot/proc: Operation not permitted")).toContain("Docker here is too old");
    expect(boxProbeFix("bwrap: setting up uid map: Permission denied")).toContain("without its AppArmor profile");
    expect(boxProbeFix("bwrap: Creating new namespace failed: Operation not permitted")).toContain("user namespaces are switched off");
    expect(boxProbeFix("OCI runtime create failed: apparmor failed to apply profile: profile omb-home-narrow not found")).toContain("its AppArmor profile is not loaded");
    expect(boxProbeFix("something else")).toBe("Our bots' safety box can't start on this server yet. Run the install command again to repair it.");
  });
});

describe("speaking to Docker", () => {
  it("speaks API 1.43 to Docker 24 and at most 1.47 to newer engines, and refuses older ones", () => {
    expect(negotiateApi({ ApiVersion: "1.43", MinAPIVersion: "1.12" })).toBe("1.43");
    expect(negotiateApi({ ApiVersion: "1.45" })).toBe("1.45");
    expect(negotiateApi({ ApiVersion: "1.52", MinAPIVersion: "1.44" })).toBe("1.47");
    expect(negotiateApi({ ApiVersion: "1.41" })).toBeNull();
    expect(negotiateApi({ ApiVersion: "1.60", MinAPIVersion: "1.50" })).toBeNull();
    expect(negotiateApi({ ApiVersion: "garbage" })).toBeNull();
  });

  it("pulls by digest, and reads a failure Docker reports inside a 200 stream", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(pullParams(`ghcr.io/milind-soni/openmausbot-cloud-home@${digest}`)).toEqual({ fromImage: "ghcr.io/milind-soni/openmausbot-cloud-home", tag: digest });
    expect(pullParams("localhost:5000/x:tag")).toEqual({ fromImage: "localhost:5000/x", tag: "tag" });
    expect(pullParams("localhost:5000/x")).toEqual({ fromImage: "localhost:5000/x", tag: "latest" });
    expect(pullFailure('{"status":"Pulling fs layer"}\n{"errorDetail":{"message":"manifest unknown"},"error":"manifest unknown"}\n')).toBe("manifest unknown");
    expect(pullFailure('{"status":"Digest: sha256:x"}\n{"status":"Status: Downloaded newer image"}\n')).toBeNull();
  });

  it("reads a container's framed log stream", () => {
    const frame = (stream: number, text: string) => {
      const body = Buffer.from(text);
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(body.length, 4);
      return Buffer.concat([header, body]);
    };
    expect(demuxLogs(Buffer.concat([frame(1, "out line\n"), frame(2, "err line\n")]))).toBe("out line\nerr line\n");
    expect(demuxLogs(Buffer.alloc(3))).toBe("");
  });
});
