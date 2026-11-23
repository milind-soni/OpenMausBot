import type { AppConfig, VpsServer } from "./config.ts";
import { userError, type UserError } from "./user-errors.ts";
import { normalizeVpsConfig } from "./vps-config.ts";
import { vpsLimits } from "./vps-hosts.ts";
import { defaultRunner, vpsDockerArgs, type VpsCommandRunner } from "./vps-computer.ts";

export interface HostCapacity { cpus: number; memoryBytes: number }
type Limits = { cpus?: number; memoryGb?: number };

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

/** The refusal for a limit the machine cannot honour, or null. */
export function hostLimitProblem(alias: string, host: HostCapacity, limits: Limits): UserError | null {
  if (limits.cpus !== undefined && limits.cpus > host.cpus) {
    return userError("serverError.vps.tooManyCores", { server: alias, cores: host.cpus });
  }
  // A machine sold as 4 GB reports a little less; round before comparing.
  const memoryGb = Math.round(host.memoryBytes / GIB);
  if (limits.memoryGb !== undefined && limits.memoryGb > memoryGb) {
    return userError("serverError.vps.tooMuchMemory", { server: alias, memory: memoryGb });
  }
  return null;
}

type Patch = { vps?: unknown; vpsServers?: VpsServer[] };

/** The config as it will be once `patch` is saved, read the same way the save reads it. */
function afterPatch(cfg: AppConfig, patch: Patch): AppConfig {
  let vps = cfg.vps;
  try {
    if (patch.vps !== undefined) vps = normalizeVpsConfig(patch.vps, cfg.vps);
  } catch {
    // The save refuses it with its own words.
  }
  return { ...cfg, vps, vpsServers: patch.vpsServers ?? cfg.vpsServers };
}

const sameLimits = (a: Limits, b: Limits) => a.cpus === b.cpus && a.memoryGb === b.memoryGb;

/** Checks each memory and core limit this save adds or changes, as each server will effectively have it, against what
 * the machine has. Every host that needs a look is asked at once. */
export async function vpsHostLimitProblem(
  cfg: AppConfig,
  patch: Patch,
  capacity: (alias: string) => Promise<HostCapacity | null> = vpsHostCapacity,
): Promise<UserError | null> {
  const after = afterPatch(cfg, patch);
  const aliases = new Set<string>();
  if (after.vps?.sshAlias) aliases.add(after.vps.sshAlias);
  for (const server of after.vpsServers ?? []) aliases.add(server.sshAlias);
  const known = (alias: string) => alias === cfg.vps?.sshAlias || (cfg.vpsServers ?? []).some((server) => server.sshAlias === alias);
  const targets = [...aliases].flatMap((alias) => {
    const limits = vpsLimits(after, alias);
    const hasLimits = limits.cpus !== undefined || limits.memoryGb !== undefined;
    return hasLimits && !(known(alias) && sameLimits(limits, vpsLimits(cfg, alias))) ? [{ alias, limits }] : [];
  });
  const problems = await Promise.all(targets.map(async ({ alias, limits }) => {
    const host = await capacity(alias);
    return host === null ? null : hostLimitProblem(alias, host, limits);
  }));
  return problems.find((problem) => problem !== null) ?? null;
}
