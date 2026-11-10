// `doctor --host`: can this Linux machine run the server and the bots' sandbox? It only looks: files under /proc and /sys,
// version queries to docker, podman and timedatectl, the sockets already listening, and one HEAD request for the time. On
// a server that runs the MausBot connector it also asks that for its own checks, which start one throwaway box probe.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { arch, cpus, homedir, release, totalmem } from "node:os";
import { dirname, join, posix, resolve } from "node:path";

import { PRODUCTION_CLOUD_ORIGIN } from "../devs-report-send.ts";
import { EXIT, flag, usageError } from "./args.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";

export type HostStatus = "ok" | "warn" | "FAIL";

export interface HostCheck {
  id: string;
  status: HostStatus;
  message: string;
  fix?: string;
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The command is not installed. */
  missing: boolean;
}

export interface HostProbe {
  platform: NodeJS.Platform;
  arch: string;
  kernel: string;
  cpus: number;
  memoryBytes: number;
  /** A file's text, or null when it is missing or unreadable. */
  read(path: string): string | null;
  list(path: string): string[];
  run(command: string, args: string[]): Promise<CommandResult>;
  /** Free bytes for an unprivileged user on the disk that holds `path` (or its nearest existing parent). */
  freeBytes(path: string): number | null;
  /** This clock minus network time, in ms, or null when no time server answered. */
  clockOffset(): Promise<number | null>;
  serverAnswers(port: number): Promise<boolean>;
}

export interface HostOptions {
  dataDir: string;
  port: number;
  domain?: string;
}

const GB = 1_000_000_000;
const SIGNED_REQUEST_SKEW_S = 300;
const NTP_FIX = "sudo timedatectl set-ntp true";

const ok = (id: string, message: string): HostCheck => ({ id, status: "ok", message });
const warn = (id: string, message: string, fix?: string): HostCheck => ({ id, status: "warn", message, ...(fix ? { fix } : {}) });
const fail = (id: string, message: string, fix: string): HostCheck => ({ id, status: "FAIL", message, fix });

function osRelease(probe: HostProbe): Record<string, string> {
  const text = probe.read("/etc/os-release") ?? probe.read("/usr/lib/os-release") ?? "";
  return Object.fromEntries(text.split("\n").map((line) => /^([A-Z_]+)=(.*)$/.exec(line.trim())).filter((match) => match !== null)
    .map((match) => [match[1]!, match[2]!.replace(/^"(.*)"$/, "$1")]));
}

function systemCheck(probe: HostProbe): HostCheck {
  const os = osRelease(probe);
  const name = os.PRETTY_NAME || "An unknown Linux";
  const tested = (os.ID === "ubuntu" && ["22.04", "24.04"].includes(os.VERSION_ID ?? "")) || (os.ID === "debian" && os.VERSION_ID === "12");
  const line = `${name}, kernel ${probe.kernel}`;
  return tested ? ok("system", line) : warn("system", `${line}: not a system we test (Ubuntu 24.04 or 22.04, or Debian 12)`);
}

function archCheck(probe: HostProbe): HostCheck {
  if (probe.arch === "x64") return ok("arch", "x86_64");
  if (probe.arch === "arm64") return warn("arch", "arm64: the server runs here, but a self-hosted Team server is supported on x86_64 only");
  return fail("arch", `${probe.arch}: OpenMausBot's images are built for x86_64 and arm64 only`, "use an x86_64 server");
}

async function containerCheck(probe: HostProbe): Promise<HostCheck> {
  const docker = await probe.run("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (docker.ok && docker.stdout.trim()) return ok("containers", `Docker ${docker.stdout.trim()}`);
  if (!docker.missing) {
    return /permission denied/i.test(docker.stderr)
      ? fail("containers", "Docker is installed, but this user cannot reach its daemon", "run as root, or add the user to the docker group: sudo usermod -aG docker $USER")
      : fail("containers", "Docker is installed, but its daemon is not running", "sudo systemctl enable --now docker");
  }
  const podman = await probe.run("podman", ["version", "--format", "{{.Version}}"]);
  if (podman.ok && podman.stdout.trim()) return ok("containers", `Podman ${podman.stdout.trim()}`);
  if (!podman.missing) return fail("containers", "Podman is installed, but does not answer", "podman info names the problem; for a rootless Podman, check /etc/subuid");
  return fail("containers", "Neither Docker nor Podman is installed", "sudo apt-get install -y docker.io   (or podman)");
}

/** What the MausBot connector on this server says of it, when one runs there: its own checks (connector/src/host.ts). */
export interface ConnectorReport {
  checks: { id: string; ok: boolean; warning?: boolean; fix?: string }[];
}

const CONNECTOR = "mausbot-connector";

/** Asks the connector's container, as root may; null where none runs or it cannot be asked. */
export async function connectorReport(probe: HostProbe): Promise<ConnectorReport | null> {
  // `probe --json` exits 1 when a check fails, with the same one line.
  const result = await probe.run("docker", ["exec", CONNECTOR, CONNECTOR, "probe", "--json"]);
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? ""); } catch { return null; }
  const checks = (parsed as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(checks)) return null;
  return {
    checks: checks.filter((check): check is ConnectorReport["checks"][number] =>
      typeof check === "object" && check !== null && typeof check.id === "string" && typeof check.ok === "boolean"),
  };
}

function connectorChecks(report: ConnectorReport | null): HostCheck[] {
  if (!report) return [];
  const problems = report.checks.filter((check) => !check.ok || check.warning);
  if (!problems.length) return [ok("connector", `MausBot connector: its ${report.checks.length} checks pass, the bots' box among them`)];
  return problems.map((check) => check.ok
    ? warn(`connector-${check.id}`, `MausBot connector: ${check.id}`, check.fix)
    : fail(`connector-${check.id}`, `MausBot connector: the ${check.id} check fails`, check.fix ?? "run MausBot's install command again"));
}

function userNamespaceCheck(probe: HostProbe, connector: ConnectorReport | null): HostCheck {
  const sysctl = (name: string) => probe.read(`/proc/sys/${name.replaceAll(".", "/")}`)?.trim();
  const keep = (setting: string) => `sudo sysctl -w ${setting}   (and put it in /etc/sysctl.d/ to keep it after a reboot)`;
  if (!probe.list("/proc/self/ns").includes("user")) {
    return fail("userns", "Bot sandbox: this kernel has no user namespaces", "use a stock Ubuntu or Debian kernel (CONFIG_USER_NS)");
  }
  if (sysctl("kernel.apparmor_restrict_unprivileged_userns") === "1") {
    // A MausBot home runs under its own AppArmor profile (omb-home-narrow), which allows them for that container alone.
    if (connector?.checks.some((check) => check.id === "box" && check.ok)) {
      return ok("userns", "Unprivileged user namespaces: AppArmor restricts them here, and MausBot's home has them through its own AppArmor profile");
    }
    return fail("userns", "Bot sandbox: AppArmor blocks unprivileged user namespaces", connector
      ? "run MausBot's install command again: it loads the home's own AppArmor profile, so this server-wide switch can stay on"
      : keep("kernel.apparmor_restrict_unprivileged_userns=0"));
  }
  if (sysctl("kernel.unprivileged_userns_clone") === "0") {
    return fail("userns", "Bot sandbox: unprivileged user namespaces are turned off", keep("kernel.unprivileged_userns_clone=1"));
  }
  if (sysctl("user.max_user_namespaces") === "0") {
    return fail("userns", "Bot sandbox: user namespaces are limited to none", keep("user.max_user_namespaces=15000"));
  }
  return ok("userns", "Unprivileged user namespaces are allowed");
}

function seccompCheck(probe: HostProbe): HostCheck {
  return /^Seccomp:\s*\d/m.test(probe.read("/proc/self/status") ?? "")
    ? ok("seccomp", "seccomp is available")
    : fail("seccomp", "Bot sandbox: this kernel has no seccomp", "use a stock Ubuntu or Debian kernel (CONFIG_SECCOMP_FILTER)");
}

function cgroupCheck(probe: HostProbe): HostCheck {
  return probe.read("/sys/fs/cgroup/cgroup.controllers") !== null
    ? ok("cgroup", "cgroup v2")
    : fail("cgroup", "Only cgroup v1 is mounted; the bot box needs cgroup v2", "boot with systemd.unified_cgroup_hierarchy=1 (the default since Ubuntu 21.10 and Debian 11)");
}

function diskCheck(probe: HostProbe, dataDir: string): HostCheck {
  const free = probe.freeBytes(dataDir);
  if (free === null) return warn("disk", `Could not read the free space for ${dataDir}`);
  const shown = `${Math.floor(free / GB)} GB free for ${dataDir}`;
  if (free < 10 * GB) return fail("disk", `${shown}; the server needs at least 10 GB`, "free space on that disk, or pass --data-dir on a larger one");
  if (free < 100 * GB) return warn("disk", `${shown}; a Team server needs 100 GB`, "grow the disk before a team moves in");
  return ok("disk", shown);
}

/** The block device under `dataDir`, then every device it sits on: a dm-crypt mapping among them is an encrypted disk. */
function encryptedCheck(probe: HostProbe, dataDir: string): HostCheck {
  const mounts = (probe.read("/proc/self/mountinfo") ?? "").split("\n").map((line) => line.split(" ")).filter((fields) => fields.length > 4);
  const path = posix.resolve(dataDir);
  const mount = mounts.filter(([, , , , point]) => path === point || path.startsWith(point === "/" ? "/" : `${point}/`))
    .sort((a, b) => b[4]!.length - a[4]!.length)[0];
  if (!mount || mount[2]!.startsWith("0:")) return warn("encryption", `Could not tell whether ${dataDir} is on an encrypted disk`);
  const seen = new Set<string>();
  const encrypted = (device: string): boolean => {
    if (seen.has(device)) return false;
    seen.add(device);
    if ((probe.read(`/sys/dev/block/${device}/dm/uuid`) ?? "").startsWith("CRYPT-")) return true;
    return probe.list(`/sys/dev/block/${device}/slaves`).some((slave) => {
      const dev = probe.read(`/sys/class/block/${slave}/dev`)?.trim();
      return dev ? encrypted(dev) : false;
    });
  };
  return encrypted(mount[2]!)
    ? ok("encryption", `${dataDir} is on an encrypted disk`)
    : warn("encryption", `${dataDir} is not on an encrypted disk`, "use LUKS full-disk encryption, unless your provider encrypts the disk at rest");
}

function sizeCheck(probe: HostProbe): HostCheck {
  const memory = Math.round(probe.memoryBytes / 2 ** 30);
  const line = `${probe.cpus} CPUs, ${memory} GB memory`;
  if (probe.memoryBytes < 2 * 2 ** 30) return fail("size", `${line}; the server needs at least 2 GB`, "use a larger server");
  if (probe.cpus < 4 || probe.memoryBytes < 7.5 * 2 ** 30) return warn("size", `${line}; a Team server needs at least 4 CPUs and 8 GB`, "use a larger server for a team");
  return ok("size", `${line} (a team of 20 needs 8 CPUs and 16 GB)`);
}

/** Listening TCP ports, from /proc/net/tcp and tcp6: state 0A is LISTEN. */
export function listeningPorts(probe: HostProbe): Set<number> {
  const ports = new Set<number>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of (probe.read(table) ?? "").split("\n").slice(1)) {
      const [, local, , state] = line.trim().split(/\s+/);
      if (state === "0A" && local) ports.add(Number.parseInt(local.split(":").at(-1)!, 16));
    }
  }
  return ports;
}

async function portChecks(probe: HostProbe, options: HostOptions): Promise<HostCheck[]> {
  const taken = listeningPorts(probe);
  const ours = taken.has(options.port) && await probe.serverAnswers(options.port);
  const server = !taken.has(options.port) ? ok("port", `Port ${options.port} is free for the server`)
    : ours ? ok("port", `OpenMausBot already answers on port ${options.port}`)
      : fail("port", `Port ${options.port} is taken by another program`, `stop it (sudo ss -ltnp 'sport = :${options.port}' names it), or run the server with --port N`);
  const web = [80, 443].filter((port) => taken.has(port));
  if (!web.length) return [server, ok("web-ports", "Ports 80 and 443 are free")];
  const which = web.length === 2 ? "Ports 80 and 443 are" : `Port ${web[0]} is`;
  const named = `sudo ss -ltnp 'sport = :${web[0]}' names it`;
  if (ours) return [server, warn("web-ports", `${which} in use: by this server's Caddy if it serves --domain, else by another program`, named)];
  return [server, options.domain
    ? fail("web-ports", `${which} taken, and --domain ${options.domain} needs 80 and 443`, `stop that program (${named}), or use --tunnel instead`)
    : warn("web-ports", `${which} taken: serving on your own domain needs 80 and 443 (a tunnel or Tailscale does not)`, named)];
}

async function clockCheck(probe: HostProbe): Promise<HostCheck> {
  const [offset, ntp] = await Promise.all([probe.clockOffset(), probe.run("timedatectl", ["show", "-p", "NTPSynchronized", "--value"])]);
  const synced = ntp.ok ? ntp.stdout.trim() === "yes" : null;
  if (offset === null) {
    return synced ? ok("clock", "Clock is kept synchronised (network time could not be reached to compare)")
      : warn("clock", synced === false ? "Clock is not kept synchronised, and network time could not be reached" : "Could not check the clock", NTP_FIX);
  }
  const seconds = Math.abs(offset) / 1_000;
  const off = seconds < 1.5 ? "within 1 s of network time" : `${Math.round(seconds)} s ${offset > 0 ? "ahead of" : "behind"} network time`;
  if (seconds > SIGNED_REQUEST_SKEW_S) return fail("clock", `Clock is ${off}; signed requests allow ${SIGNED_REQUEST_SKEW_S} s`, NTP_FIX);
  if (seconds > 30 || synced === false) return warn("clock", `Clock is ${off}${synced === false ? ", and not kept synchronised" : ""}`, NTP_FIX);
  return ok("clock", `Clock is ${off} (signed requests allow ${SIGNED_REQUEST_SKEW_S} s)`);
}

export async function checkHost(probe: HostProbe, options: HostOptions): Promise<HostCheck[]> {
  if (probe.platform !== "linux") {
    const name = probe.platform === "darwin" ? "macOS" : probe.platform === "win32" ? "Windows" : probe.platform;
    return [fail("platform", `doctor --host checks a Linux server, and this is ${name}`, "run it on the Linux server that will host OpenMausBot")];
  }
  const [containers, ports, clock, connector] = await Promise.all([containerCheck(probe), portChecks(probe, options), clockCheck(probe), connectorReport(probe)]);
  return [systemCheck(probe), archCheck(probe), containers, userNamespaceCheck(probe, connector), seccompCheck(probe), cgroupCheck(probe),
    diskCheck(probe, options.dataDir), encryptedCheck(probe, options.dataDir), sizeCheck(probe), ...ports, clock, ...connectorChecks(connector)];
}

export function hostReport(checks: readonly HostCheck[]): { result: Record<string, unknown>; exitCode: number; human: string[] } {
  const problems = checks.filter((check) => check.status === "FAIL").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return {
    result: { ok: problems === 0, problems, warnings, checks },
    exitCode: problems ? EXIT.hostMissing : EXIT.done,
    human: [
      ...checks.flatMap((check) => [`${check.status.padEnd(6)}${check.message}`, ...(check.fix && check.status !== "ok" ? [`      fix: ${check.fix}`] : [])]),
      problems ? `${plural(problems, "problem")}${warnings ? `, ${plural(warnings, "warning")}` : ""}.` : `Ready${warnings ? `, with ${plural(warnings, "warning")}` : ""}.`,
    ],
  };
}

function run(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((done) => {
    execFile(command, args, { timeout: 10_000, env: { ...process.env, LC_ALL: "C" } }, (error, stdout, stderr) => {
      done({ ok: !error, stdout: String(stdout), stderr: String(stderr), missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT" });
    });
  });
}

export function systemProbe(): HostProbe {
  const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
  return {
    platform: process.platform, arch: arch(), kernel: release(), cpus: cpus().length, memoryBytes: totalmem(),
    read,
    list: (path) => { try { return readdirSync(path); } catch { return []; } },
    run,
    freeBytes(path) {
      let at = resolve(path);
      while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
      try {
        const stats = statfsSync(at);
        return Number(stats.bavail) * Number(stats.bsize);
      } catch {
        return null;
      }
    },
    async clockOffset() {
      try {
        const before = Date.now();
        const response = await fetch(PRODUCTION_CLOUD_ORIGIN, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5_000) });
        const after = Date.now();
        const date = Date.parse(response.headers.get("date") ?? "");
        // An HTTP date is whole seconds: the server's clock was somewhere in the second after it.
        return Number.isFinite(date) ? (before + after) / 2 - (date + 500) : null;
      } catch {
        return null;
      }
    },
    async serverAnswers(port) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
        return ((await response.json()) as { app?: unknown }).app === "openmausbot";
      } catch {
        return false;
      }
    },
  };
}

export async function hostDoctor(ctx: VerbContext, probe: HostProbe = systemProbe()): Promise<VerbOutcome> {
  const rawPort = flag(ctx.flags, "port") ?? ctx.env.OMB_PORT ?? "8799";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw usageError("--port must be 1-65535");
  // A Linux machine's path, also when the checks are tested on Windows.
  const dataDir = posix.resolve(flag(ctx.flags, "data-dir") ?? (ctx.env.OMB_DATA_DIR || join(homedir(), ".openmausbot")));
  const domain = flag(ctx.flags, "domain")?.trim().toLowerCase();
  return hostReport(await checkHost(probe, { dataDir, port, ...(domain ? { domain } : {}) }));
}
