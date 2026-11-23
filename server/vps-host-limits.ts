import type { AppConfig, VpsServer } from "./config.ts";
import { cpusetSize } from "./container-limits.ts";
import { vpsLimits } from "./vps-hosts.ts";
import { defaultRunner, vpsDockerArgs, type VpsCommandRunner } from "./vps-computer.ts";

export interface HostCapacity { cpus: number; memoryBytes: number }

const GIB = 1024 ** 3;

/** What the host's Docker engine can use, or null when the host did not answer: a save is then not held up by an offline machine. */
export async function vpsHostCapacity(alias: string, runner: VpsCommandRunner = defaultRunner): Promise<HostCapacity | null> {
  try {
    const { stdout } = await runner(vpsDockerArgs(alias, ["info", "--format", "{{.NCPU}} {{.MemTotal}}"]), { timeoutMs: 20_000 });
    const [cpus, memoryBytes] = stdout.trim().split(/\s+/).map(Number);
    return Number.isInteger(cpus) && cpus! > 0 && Number.isFinite(memoryBytes) && memoryBytes! > 0 ? { cpus: cpus!, memoryBytes: memoryBytes! } : null;
  } catch {
    return null;
  }
}

function highestCpu(cpuset: string): number {
  return Math.max(...cpuset.split(",").map((part) => Number(part.split("-").pop())));
}

/** Words for a limit the machine cannot honour, or null. */
export function hostLimitProblem(alias: string, host: HostCapacity, limits: { cpus?: number; cpuset?: string; memoryGb?: number }): string | null {
  if (limits.cpus !== undefined && limits.cpus > host.cpus) {
    return `${alias} has ${host.cpus} CPU core${host.cpus === 1 ? "" : "s"}, so ${limits.cpus} cores can't be set`;
  }
  if (limits.cpuset && highestCpu(limits.cpuset) >= host.cpus) {
    return `${alias} has CPUs 0-${host.cpus - 1}, so CPU pinning ${limits.cpuset} can't be set`;
  }
  // A machine sold as 4 GB reports a little less; round before comparing.
  if (limits.memoryGb !== undefined && limits.memoryGb > Math.round(host.memoryBytes / GIB)) {
    return `${alias} has ${(host.memoryBytes / GIB).toFixed(1)} GB of memory, so ${limits.memoryGb} GB can't be set`;
  }
  return null;
}

type Patch = { vps?: { sshAlias?: string; cpus?: number; cpuset?: string; memoryGb?: number }; vpsServers?: VpsServer[] };
type Limits = { cpus?: number; cpuset?: string; memoryGb?: number };

/** The config as it will be once `patch` is saved: an omitted default alias is kept, an empty one clears it, and an empty pin removes it. */
function afterPatch(cfg: AppConfig, patch: Patch): AppConfig {
  if (patch.vps === undefined && patch.vpsServers === undefined) return cfg;
  const { sshAlias, cpus, memoryGb, cpuset } = patch.vps ?? {};
  const vps = { ...cfg.vps, ...(sshAlias === undefined ? {} : { sshAlias }), ...(cpus === undefined ? {} : { cpus }), ...(memoryGb === undefined ? {} : { memoryGb }) };
  if (patch.vps && "cpuset" in patch.vps) delete vps.cpuset;
  if (cpuset) vps.cpuset = cpuset;
  return { ...cfg, vps, vpsServers: patch.vpsServers ?? cfg.vpsServers };
}

const sameLimits = (a: Limits, b: Limits) => a.cpus === b.cpus && a.cpuset === b.cpuset && a.memoryGb === b.memoryGb;

/** Checks each CPU and memory limit this save adds or changes, as each server will effectively have it, against what the machine has. */
export async function vpsHostLimitProblem(cfg: AppConfig, patch: Patch, capacity: (alias: string) => Promise<HostCapacity | null> = vpsHostCapacity): Promise<string | null> {
  const after = afterPatch(cfg, patch);
  const aliases = new Set<string>();
  if (after.vps?.sshAlias) aliases.add(after.vps.sshAlias);
  for (const server of after.vpsServers ?? []) aliases.add(server.sshAlias);
  const targets: ({ alias: string } & Limits)[] = [];
  for (const alias of aliases) {
    const limits = vpsLimits(after, alias);
    if (limits.cpuset && limits.cpus !== undefined && cpusetSize(limits.cpuset) > limits.cpus) {
      return `${alias} pins ${cpusetSize(limits.cpuset)} CPUs (${limits.cpuset}), more than its ${limits.cpus} cores`;
    }
    const known = alias === cfg.vps?.sshAlias || (cfg.vpsServers ?? []).some((server) => server.sshAlias === alias);
    const hasLimits = limits.cpus !== undefined || limits.memoryGb !== undefined || Boolean(limits.cpuset);
    if (hasLimits && !(known && sameLimits(limits, vpsLimits(cfg, alias)))) targets.push({ alias, ...limits });
  }
  const hosts = new Map<string, Promise<HostCapacity | null>>();
  for (const target of targets) {
    if (!hosts.has(target.alias)) hosts.set(target.alias, capacity(target.alias));
    const host = await hosts.get(target.alias)!;
    const problem = host === null ? null : hostLimitProblem(target.alias, host, target);
    if (problem) return problem;
  }
  return null;
}
