import type { AppConfig, VpsServer } from "./config.ts";
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

/** Checks each CPU and memory limit this save adds or changes against what the machine has. */
export async function vpsHostLimitProblem(cfg: AppConfig, patch: Patch, capacity: (alias: string) => Promise<HostCapacity | null> = vpsHostCapacity): Promise<string | null> {
  const targets: ({ alias: string } & Limits)[] = [];
  if (patch.vps !== undefined) {
    const alias = patch.vps.sshAlias || cfg.vps?.sshAlias;
    const cpus = patch.vps.cpus ?? cfg.vps?.cpus;
    const memoryGb = patch.vps.memoryGb ?? cfg.vps?.memoryGb;
    const cpuset = "cpuset" in patch.vps ? patch.vps.cpuset || undefined : cfg.vps?.cpuset;
    const changed = patch.vps.sshAlias !== undefined && patch.vps.sshAlias !== cfg.vps?.sshAlias
      || (patch.vps.cpus !== undefined && patch.vps.cpus !== cfg.vps?.cpus)
      || (patch.vps.memoryGb !== undefined && patch.vps.memoryGb !== cfg.vps?.memoryGb)
      || ("cpuset" in patch.vps && cpuset !== cfg.vps?.cpuset);
    if (alias && changed && (cpus !== undefined || memoryGb !== undefined || cpuset)) targets.push({ alias, ...(cpus === undefined ? {} : { cpus }), ...(memoryGb === undefined ? {} : { memoryGb }), ...(cpuset ? { cpuset } : {}) });
  }
  for (const server of patch.vpsServers ?? []) {
    const before = cfg.vpsServers?.find((entry) => entry.sshAlias === server.sshAlias);
    const limited = server.cpus !== undefined || server.memoryGb !== undefined || Boolean(server.cpuset);
    if (limited && (server.cpus !== before?.cpus || server.cpuset !== before?.cpuset || server.memoryGb !== before?.memoryGb)) {
      targets.push({ alias: server.sshAlias, ...(server.cpus === undefined ? {} : { cpus: server.cpus }), ...(server.memoryGb === undefined ? {} : { memoryGb: server.memoryGb }), ...(server.cpuset ? { cpuset: server.cpuset } : {}) });
    }
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
