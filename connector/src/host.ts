// What this server is and whether MausBot can run on it, from Docker's own report and the host's /proc (the
// connector's container shares the host's kernel). Every failing check carries the plain-words fix for its owner.
import { createHash, randomBytes } from "node:crypto";

import type { Docker, DockerInfo } from "./docker.ts";
import { errorText } from "./log.ts";
import type { HostCheck, HostFacts, HostHealth } from "./protocol.ts";
import { APPARMOR_PROFILE, HOME_CAPABILITIES, LABELS, SECCOMP_FILE } from "./settings.ts";

const MIN_DISK_GB = 20;
const MIN_MEMORY_GB = 4;
const MAX_CLOCK_SKEW_S = 300;

export interface HostReader {
  /** A /proc file's text, or null. */
  proc(path: string): string | null;
  /** The installed seccomp profile (/etc/mausbot) and the one this connector carries, as text, or null. */
  installedSeccomp(): string | null;
  shippedSeccomp(): string | null;
  /** Bytes free and in total where Docker keeps its volumes. */
  disk(): { free: number; total: number };
}

const int = (value: string | null | undefined) => {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Unprivileged user namespaces: some kernels switch them off with either of these. */
export function usernsAllowed(reader: Pick<HostReader, "proc">): boolean {
  const max = int(reader.proc("/proc/sys/user/max_user_namespaces"));
  const clone = reader.proc("/proc/sys/kernel/unprivileged_userns_clone");
  return (max === null || max > 0) && (clone === null || clone.trim() === "1");
}

export function dockerMajor(version: string): number {
  return int(/^(\d+)/.exec(version)?.[1]) ?? 0;
}

const securityOption = (info: DockerInfo, name: string) => (info.SecurityOptions ?? []).some((option) => option.split(",").includes(`name=${name}`));

export function hostFacts(info: DockerInfo, reader: HostReader): HostFacts {
  return {
    os: info.OperatingSystem,
    kernel: info.KernelVersion,
    arch: info.Architecture,
    cpus: info.NCPU,
    memMb: Math.round(info.MemTotal / 1048576),
    diskGb: Math.floor(reader.disk().free / 1e9),
    docker: info.ServerVersion,
    apparmor: securityOption(info, "apparmor"),
    userns: usernsAllowed(reader),
  };
}

const digest = (text: string | null) => (text === null ? null : createHash("sha256").update(text).digest("hex"));

export interface BoxProbeResult {
  ok: boolean;
  /** Plain words for the owner when the box cannot start. */
  fix?: string;
}

/** Each check MausBot needs to pass on a server, in order, with the line its owner sees when it fails. */
export function hostChecks(info: DockerInfo, reader: HostReader, extra: { clockSkewS: number | null; box: BoxProbeResult | null }): HostCheck[] {
  const checks: HostCheck[] = [];
  const add = (check: HostCheck) => checks.push(check);
  add(info.Architecture === "x86_64"
    ? { id: "arch", ok: true }
    : { id: "arch", ok: false, fix: "This server has an ARM processor. MausBot runs on Intel or AMD (x86-64) servers for now. Please pick an x86-64 server." });
  add(dockerMajor(info.ServerVersion) >= 24
    ? { id: "docker", ok: true }
    : { id: "docker", ok: false, fix: `Docker ${info.ServerVersion} is too old; MausBot needs Docker 24 or newer. Run: curl -fsSL https://get.docker.com | sudo sh` });
  add(securityOption(info, "rootless")
    ? { id: "rootless", ok: false, fix: "Docker runs in rootless mode here. MausBot needs the standard Docker service: run curl -fsSL https://get.docker.com | sudo sh" }
    : { id: "rootless", ok: true });
  add(securityOption(info, "apparmor") && securityOption(info, "seccomp")
    ? { id: "apparmor", ok: true }
    : { id: "apparmor", ok: false, fix: "Your server is missing AppArmor's tools, a standard part of Ubuntu and Debian. Run: sudo apt-get install -y apparmor, then restart the server." });
  const installed = digest(reader.installedSeccomp());
  add(installed !== null && installed === digest(reader.shippedSeccomp())
    ? { id: "profiles", ok: true }
    : { id: "profiles", ok: false, fix: "The bot box's security profiles on this server are missing or out of date. Run the install command again." });
  add(usernsAllowed(reader)
    ? { id: "userns", ok: true }
    : { id: "userns", ok: false, fix: "Your server switches off a Linux feature our bots' safety box needs. Run: printf 'user.max_user_namespaces=63000\\nkernel.unprivileged_userns_clone=1\\n' | sudo tee /etc/sysctl.d/90-mausbot.conf && sudo sysctl --system" });
  if (extra.box) add(extra.box.ok ? { id: "box", ok: true } : { id: "box", ok: false, fix: extra.box.fix });
  const { free, total } = reader.disk();
  const freeGb = Math.floor(free / 1e9);
  if (freeGb < MIN_DISK_GB) add({ id: "disk", ok: false, fix: `Your server has only ${freeGb} GB free. MausBot needs at least ${MIN_DISK_GB} GB: free some space or add a disk.` });
  else if (total > 0 && (total - free) / total >= 0.85) add({ id: "disk", ok: true, warning: true, fix: `Your server's disk is ${Math.round(((total - free) / total) * 100)}% full. Free some space or add a disk before it fills up.` });
  else add({ id: "disk", ok: true });
  const memGb = Math.round((info.MemTotal / 1073741824) * 10) / 10;
  add(memGb >= MIN_MEMORY_GB - 0.5
    ? { id: "memory", ok: true }
    : { id: "memory", ok: true, warning: true, fix: `This server has ${memGb} GB of memory; bots will be slow or stop. We suggest at least ${MIN_MEMORY_GB} GB, and 32 GB for a team of five.` });
  if (extra.clockSkewS !== null) {
    add(Math.abs(extra.clockSkewS) <= MAX_CLOCK_SKEW_S
      ? { id: "clock", ok: true }
      : { id: "clock", ok: false, fix: `Your server's clock is ${Math.round(Math.abs(extra.clockSkewS) / 60)} minutes off, so it can't check our messages. Run: sudo timedatectl set-ntp true` });
  }
  return checks;
}

export function hostHealth(info: DockerInfo, reader: HostReader, extra: { clockSkewS: number | null; box: BoxProbeResult | null }): HostHealth {
  const meminfo = reader.proc("/proc/meminfo") ?? "";
  const available = int(/^MemAvailable:\s+(\d+)/m.exec(meminfo)?.[1]);
  const load = Number.parseFloat((reader.proc("/proc/loadavg") ?? "").split(" ")[0] ?? "");
  const uptime = Number.parseFloat((reader.proc("/proc/uptime") ?? "").split(" ")[0] ?? "");
  const { total } = reader.disk();
  return {
    ...hostFacts(info, reader),
    diskTotalGb: Math.floor(total / 1e9),
    memAvailableMb: available === null ? 0 : Math.round(available / 1024),
    load1: Number.isFinite(load) ? Math.round(load * 100) / 100 : 0,
    uptimeS: Number.isFinite(uptime) ? Math.floor(uptime) : 0,
    clockSkewS: extra.clockSkewS,
    checks: hostChecks(info, reader, extra),
  };
}

/** The probe the home's own box check starts with (server/bot-box/detect.ts probeBwrap), run unprivileged. */
export const BOX_PROBE = [
  "bwrap", "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--die-with-parent",
  "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
  "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "/bin/true",
];

const REINSTALL = "Run the install command again to repair it.";

/** What bubblewrap says when the box cannot start, mapped to whose it is to fix. */
export function boxProbeFix(output: string): string {
  if (/apparmor/i.test(output) && /profile|not found|load/i.test(output)) return `Our bots' safety box can't start on this server yet: its AppArmor profile is not loaded. ${REINSTALL}`;
  if (/No permissions to create new namespace/i.test(output)) return `Our bots' safety box can't start on this server yet: its seccomp profile was not applied. ${REINSTALL}`;
  if (/Failed to make \/ slave/i.test(output)) return `Our bots' safety box can't start on this server yet: its AppArmor profile is not loaded. ${REINSTALL}`;
  if (/Can't mount proc/i.test(output)) return "Our bots' safety box can't start on this server yet: Docker here is too old to unmask /proc. Run: curl -fsSL https://get.docker.com | sudo sh";
  if (/setting up uid map/i.test(output)) return `Our bots' safety box can't start on this server yet: the box ran without its AppArmor profile. ${REINSTALL}`;
  if (/Creating new namespace failed/i.test(output)) return "Our bots' safety box can't start on this server yet: Linux user namespaces are switched off. Run: printf 'user.max_user_namespaces=63000\\nkernel.unprivileged_userns_clone=1\\n' | sudo tee /etc/sysctl.d/90-mausbot.conf && sudo sysctl --system";
  return `Our bots' safety box can't start on this server yet. ${REINSTALL}`;
}

/** Runs BOX_PROBE in a throwaway container from `image` with the home's own security settings, as nobody. */
export async function probeBox(docker: Docker, image: string, seccomp: string): Promise<BoxProbeResult> {
  const name = `mausbot-probe-${randomBytes(4).toString("hex")}`;
  try {
    await docker.createContainer(name, {
      Image: image,
      Entrypoint: [BOX_PROBE[0]],
      Cmd: BOX_PROBE.slice(1),
      User: "65534:65534",
      Labels: { [LABELS.role]: "helper" },
      HostConfig: {
        Init: true,
        NetworkMode: "none",
        SecurityOpt: [`apparmor=${APPARMOR_PROFILE}`, `seccomp=${seccomp}`, "no-new-privileges=true"],
        MaskedPaths: [],
        ReadonlyPaths: [],
        CapDrop: ["ALL"],
        CapAdd: [...HOME_CAPABILITIES],
      },
    });
    try {
      await docker.startContainer(name);
    } catch (error) {
      return { ok: false, fix: boxProbeFix(errorText(error)) };
    }
    const code = await docker.waitContainer(name, 60_000);
    if (code === 0) return { ok: true };
    return { ok: false, fix: boxProbeFix(await docker.logs(name, 20)) };
  } finally {
    await docker.removeContainer(name).catch(() => {});
  }
}

export const PROFILE_FILES = { seccomp: SECCOMP_FILE, apparmor: `${APPARMOR_PROFILE}.apparmor` } as const;
