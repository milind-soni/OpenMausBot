import { describe, expect, it } from "vitest";

import type { VerbContext } from "./context.ts";
import { checkHost, hostDoctor, hostReport, listeningPorts, type CommandResult, type HostCheck, type HostProbe } from "./host-doctor.ts";
import type { HeadlessIo } from "./output.ts";
import { runHeadless } from "./main.ts";

const GB = 1_000_000_000;
// /proc/net/tcp rows: sl, local address (hex ip:port), remote, state (0A is LISTEN)
const tcp = (...ports: number[]) => ["  sl  local_address rem_address   st", ...ports.map((port, index) =>
  `   ${index}: 00000000:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1`)].join("\n");

/** A healthy Ubuntu 24.04 server; each test breaks one thing. */
function probe(overrides: { files?: Record<string, string | null>; lists?: Record<string, string[]>; commands?: Record<string, Partial<CommandResult>> } & Partial<HostProbe> = {}): HostProbe {
  const files: Record<string, string | null> = {
    "/etc/os-release": 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\nVERSION_ID="24.04"\n',
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0\n",
    "/proc/self/status": "Name:\tnode\nSeccomp:\t0\nSeccomp_filters:\t0\n",
    "/sys/fs/cgroup/cgroup.controllers": "cpuset cpu io memory pids\n",
    "/proc/self/mountinfo": "22 1 253:1 / / rw,relatime - ext4 /dev/mapper/root rw\n30 22 8:2 / /boot rw - ext4 /dev/sda2 rw\n",
    "/sys/dev/block/253:1/dm/uuid": "LVM-abc\n",
    "/sys/class/block/dm-0/dev": "253:0\n",
    "/sys/dev/block/253:0/dm/uuid": "CRYPT-LUKS2-abc-sda3_crypt\n",
    "/proc/net/tcp": tcp(22),
    "/proc/net/tcp6": tcp(),
    ...overrides.files,
  };
  const lists: Record<string, string[]> = { "/proc/self/ns": ["mnt", "net", "user"], "/sys/dev/block/253:1/slaves": ["dm-0"], ...overrides.lists };
  const commands: Record<string, Partial<CommandResult>> = {
    docker: { ok: true, stdout: "27.3.1\n" }, podman: { missing: true }, timedatectl: { ok: true, stdout: "yes\n" }, ...overrides.commands,
  };
  const { files: _files, lists: _lists, commands: _commands, ...rest } = overrides;
  return {
    platform: "linux", arch: "x64", kernel: "6.8.0-45-generic", cpus: 8, memoryBytes: 32 * 2 ** 30,
    read: (path) => files[path] ?? null,
    list: (path) => lists[path] ?? [],
    run: async (command) => ({ ok: false, stdout: "", stderr: "", missing: false, ...commands[command] }),
    freeBytes: () => 412 * GB,
    clockOffset: async () => 200,
    serverAnswers: async () => false,
    ...rest,
  };
}

const OPTIONS = { dataDir: "/srv/mausbot", port: 8799 };
const byId = (checks: HostCheck[], id: string) => checks.find((check) => check.id === id);

describe("doctor --host", () => {
  it("passes a healthy server, one line per check", async () => {
    const report = hostReport(await checkHost(probe(), OPTIONS));
    expect(report.exitCode).toBe(0);
    expect(report.human).toEqual([
      "ok    Ubuntu 24.04.1 LTS, kernel 6.8.0-45-generic",
      "ok    x86_64",
      "ok    Docker 27.3.1",
      "ok    Unprivileged user namespaces are allowed",
      "ok    seccomp is available",
      "ok    cgroup v2",
      "ok    412 GB free for /srv/mausbot",
      "ok    /srv/mausbot is on an encrypted disk",
      "ok    8 CPUs, 32 GB memory (a team of 20 needs 8 CPUs and 16 GB)",
      "ok    Port 8799 is free for the server",
      "ok    Ports 80 and 443 are free",
      "ok    Clock is within 1 s of network time (signed requests allow 300 s)",
      "Ready.",
    ]);
  });

  it.each([
    ["AppArmor's switch", { files: { "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n" } }, "userns", "kernel.apparmor_restrict_unprivileged_userns=0"],
    ["Debian's switch", { files: { "/proc/sys/kernel/unprivileged_userns_clone": "0\n" } }, "userns", "kernel.unprivileged_userns_clone=1"],
    ["a zero namespace limit", { files: { "/proc/sys/user/max_user_namespaces": "0\n" } }, "userns", "user.max_user_namespaces="],
    ["a kernel without user namespaces", { lists: { "/proc/self/ns": ["mnt", "net"] } }, "userns", "CONFIG_USER_NS"],
    ["no seccomp", { files: { "/proc/self/status": "Name:\tnode\n" } }, "seccomp", "CONFIG_SECCOMP_FILTER"],
    ["cgroup v1", { files: { "/sys/fs/cgroup/cgroup.controllers": null } }, "cgroup", "systemd.unified_cgroup_hierarchy=1"],
    ["no Docker or Podman", { commands: { docker: { missing: true }, podman: { missing: true } } }, "containers", "apt-get install -y docker.io"],
    ["a Docker daemon this user cannot reach", { commands: { docker: { stderr: "permission denied while trying to connect to the Docker daemon socket" } } }, "containers", "usermod -aG docker"],
    ["a stopped Docker daemon", { commands: { docker: { stderr: "Cannot connect to the Docker daemon. Is the docker daemon running?" } } }, "containers", "systemctl enable --now docker"],
    ["under 10 GB free", { freeBytes: () => 6 * GB }, "disk", "--data-dir"],
    ["under 2 GB memory", { memoryBytes: 1 * 2 ** 30 }, "size", "larger server"],
    ["a clock 10 minutes off", { clockOffset: async () => 600_000 }, "clock", "timedatectl set-ntp true"],
    ["a processor we build nothing for", { arch: "s390x" }, "arch", "x86_64"],
    ["the server's port taken by another program", { files: { "/proc/net/tcp": tcp(22, 8799) } }, "port", "--port N"],
  ] as const)("fails on %s (exit 7) and says the fix in one line", async (_name, overrides, id, fix) => {
    const checks = await checkHost(probe(overrides as Parameters<typeof probe>[0]), OPTIONS);
    expect(byId(checks, id)).toMatchObject({ status: "FAIL", fix: expect.stringContaining(fix) });
    expect(checks.filter((check) => check.status === "FAIL")).toHaveLength(1);
    const report = hostReport(checks);
    expect(report.exitCode).toBe(7);
    const at = report.human.findIndex((line) => line.startsWith("FAIL  "));
    expect(report.human[at + 1]).toBe(`      fix: ${byId(checks, id)!.fix}`);
    expect(report.human.at(-1)).toBe("1 problem.");
  });

  it("asks the MausBot connector on a server that runs one: its home's own AppArmor profile stands in for the server-wide switch", async () => {
    const connector = (box: boolean) => async (command: string, args: string[]): Promise<CommandResult> => {
      if (command === "docker" && args[0] === "exec") {
        const checks = [{ id: "profiles", ok: true }, box ? { id: "box", ok: true } : { id: "box", ok: false, fix: "Our bots' safety box can't start on this server yet. Run the install command again to repair it." }];
        return { ok: box, stdout: `${JSON.stringify({ ok: box, checks })}\n`, stderr: "", missing: false };
      }
      return command === "docker" ? { ok: true, stdout: "29.1.3\n", stderr: "", missing: false } : { ok: true, stdout: "yes\n", stderr: "", missing: false };
    };
    const stock = { files: { "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n" } };
    const passing = await checkHost(probe({ ...stock, run: connector(true) }), OPTIONS);
    expect(byId(passing, "userns")).toMatchObject({ status: "ok", message: expect.stringContaining("its own AppArmor profile") });
    expect(byId(passing, "connector")).toEqual({ id: "connector", status: "ok", message: "MausBot connector: its 2 checks pass, the bots' box among them" });
    expect(hostReport(passing).exitCode).toBe(0);
    const failing = await checkHost(probe({ ...stock, run: connector(false) }), OPTIONS);
    expect(byId(failing, "userns")).toMatchObject({ status: "FAIL", fix: expect.stringContaining("install command again") });
    expect(byId(failing, "connector-box")).toMatchObject({ status: "FAIL", fix: expect.stringContaining("Run the install command again") });
    expect(hostReport(failing).exitCode).toBe(7);
    // No connector here (docker exec answers with something else): nothing about one, and the server-wide fix.
    const plain = await checkHost(probe(stock), OPTIONS);
    expect(plain.some((check) => check.id.startsWith("connector"))).toBe(false);
    expect(byId(plain, "userns")?.fix).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
  });

  it("warns, and still passes, on what a standalone server can live with", async () => {
    const checks = await checkHost(probe({
      arch: "arm64", cpus: 2, memoryBytes: 4 * 2 ** 30, freeBytes: () => 40 * GB, clockOffset: async () => 45_000,
      files: { "/etc/os-release": 'PRETTY_NAME="Fedora Linux 40"\nID=fedora\nVERSION_ID=40\n', "/sys/dev/block/253:0/dm/uuid": null, "/proc/net/tcp": tcp(22, 443) },
    }), OPTIONS);
    expect(checks.filter((check) => check.status === "warn").map((check) => check.id).sort())
      .toEqual(["arch", "clock", "disk", "encryption", "size", "system", "web-ports"]);
    const report = hostReport(checks);
    expect(report.exitCode).toBe(0);
    expect(report.human.at(-1)).toBe("Ready, with 7 warnings.");
    expect(byId(checks, "clock")!.message).toBe("Clock is 45 s ahead of network time");
  });

  it("needs ports 80 and 443 for --domain, unless this server already answers", async () => {
    const taken = { files: { "/proc/net/tcp": tcp(22, 80, 8799), "/proc/net/tcp6": tcp(443) } };
    expect(byId(await checkHost(probe(taken), { ...OPTIONS, domain: "maus.example.com" }), "web-ports"))
      .toMatchObject({ status: "FAIL", message: "Ports 80 and 443 are taken, and --domain maus.example.com needs 80 and 443" });
    const ours = await checkHost(probe({ ...taken, serverAnswers: async () => true }), { ...OPTIONS, domain: "maus.example.com" });
    expect(byId(ours, "port")).toMatchObject({ status: "ok", message: "OpenMausBot already answers on port 8799" });
    expect(byId(ours, "web-ports")!.status).toBe("warn");
  });

  it("reads listening sockets from /proc/net, IPv4 and IPv6", () => {
    expect([...listeningPorts(probe({ files: { "/proc/net/tcp": tcp(22, 8799), "/proc/net/tcp6": tcp(443) } }))].sort((a, b) => a - b)).toEqual([22, 443, 8799]);
  });

  it("says when the clock cannot be compared, and passes when NTP keeps it", async () => {
    expect(byId(await checkHost(probe({ clockOffset: async () => null }), OPTIONS), "clock")!.status).toBe("ok");
    expect(byId(await checkHost(probe({ clockOffset: async () => null, commands: { timedatectl: { ok: true, stdout: "no\n" } } }), OPTIONS), "clock"))
      .toMatchObject({ status: "warn", fix: "sudo timedatectl set-ntp true" });
  });

  it("finds Podman when Docker is missing", async () => {
    const checks = await checkHost(probe({ commands: { docker: { missing: true }, podman: { ok: true, stdout: "4.9.3\n" } } }), OPTIONS);
    expect(byId(checks, "containers")).toEqual({ id: "containers", status: "ok", message: "Podman 4.9.3" });
  });

  it.each([["darwin", "macOS"], ["win32", "Windows"]] as const)("says it is for Linux servers on %s", async (platform, name) => {
    const report = hostReport(await checkHost(probe({ platform }), OPTIONS));
    expect(report.exitCode).toBe(7);
    expect(report.human[0]).toBe(`FAIL  doctor --host checks a Linux server, and this is ${name}`);
  });

  it("takes the data folder, port and domain from its flags, else the environment", async () => {
    const seen: string[] = [];
    const watching = probe({ freeBytes: (path) => { seen.push(path); return 412 * GB; } });
    const ctx = (flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv = {}) => ({ flags, env }) as unknown as VerbContext;
    await hostDoctor(ctx({ host: true }, { OMB_DATA_DIR: "/srv/from-env" }), watching);
    const flagged = await hostDoctor(ctx({ host: true, "data-dir": "/srv/mausbot", port: "9000", domain: "Maus.Example.com" }), probe({
      freeBytes: (path) => { seen.push(path); return 412 * GB; }, files: { "/proc/net/tcp": tcp(443, 9000) } }));
    expect(seen).toEqual(["/srv/from-env", "/srv/mausbot"]);
    expect((flagged.result as { checks: HostCheck[] }).checks.filter((check) => check.status === "FAIL").map((check) => check.message))
      .toEqual(["Port 9000 is taken by another program", "Port 443 is taken, and --domain maus.example.com needs 80 and 443"]);
    await expect(hostDoctor(ctx({ host: true, port: "99999" }), probe())).rejects.toMatchObject({ exitCode: 2 });
  });

  it("is doctor --host on the command line, and its flags belong to it", async () => {
    const io: HeadlessIo = { out: () => undefined, err: () => undefined, readStdin: async () => "" };
    expect(await runHeadless(["doctor", "--domain", "maus.example.com"], { io, env: {} })).toBe(2);
    expect(await runHeadless(["doctor", "--host", "--wait", "1m"], { io, env: {} })).toBe(2);
  });

  // Elsewhere it would probe this machine for real.
  it.skipIf(process.platform === "linux")("prints one JSON document saying it is for Linux, and exits 7", async () => {
    const out: string[] = [];
    const io: HeadlessIo = { out: (text) => out.push(text), err: () => undefined, readStdin: async () => "" };
    expect(await runHeadless(["doctor", "--host", "--json"], { io, env: {} })).toBe(7);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, problems: 1, checks: [{ id: "platform", status: "FAIL", fix: expect.any(String) }] });
  });
});
