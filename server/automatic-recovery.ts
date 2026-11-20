import type { InstanceConfig, ProviderAdapter } from "./contracts.ts";
import { limitBackupAllowed } from "./limit-failover.ts";
import { supportsWorkspaceFiles } from "./workspace.ts";
import type { ModelSelection } from "../shared/wire.ts";

type Engine = { driverKind: string; capabilities: ProviderAdapter["capabilities"] };
type LimitEngine = { instanceId: string; driverKind: string };
type Backup = Pick<ModelSelection, "instanceId" | "model">;

/** The backups a bot's turn tries, in order, when its AI provably never started it: the bot's own list, which needs no
 * switch, or else the installation's one backup while Automatic recovery is on. */
export function startupBackups(bot: { fallback?: Backup[] }, recovery?: { enabled: boolean; backup?: Backup }): Backup[] {
  if (bot.fallback?.length) return bot.fallback;
  return recovery?.enabled && recovery.backup ? [recovery.backup] : [];
}

/** Every backup a limited bot may be moved to: its own list, then the installation's one backup, which counts only
 * while Automatic recovery is on (the backup stays saved while it is off). */
export function chosenBackups(bot: { fallback?: Backup[] } | null | undefined, recovery?: { enabled: boolean; backup?: Backup }): Backup[] {
  return [...(bot?.fallback ?? []), ...(recovery?.enabled && recovery.backup ? [recovery.backup] : [])];
}

/** An automatic switch must not strand the task without its tools or move its filesystem to another machine. A USB
 * phone is not one of those tools: only Codex and Pi drive one, Claude offers it on every desktop, and no Cloud has a
 * USB port, so counting it left a limited Claude bot with no backup but those two. */
export function recoveryCapabilityError(from: Engine, to: Engine): string | undefined {
  if (supportsWorkspaceFiles(from.driverKind) !== supportsWorkspaceFiles(to.driverKind)) {
    return "The backup cannot use the same workspace.";
  }
  const tools = ["agentsMcp", "computerMcp", "composioMcp", "dataMcp", "emailMcp", "deviceMcp",
    "browserMcp", "localComputerMcp", "customMcp", "images"] as const;
  if (tools.some(key => from.capabilities[key] === true && to.capabilities[key] !== true)) {
    return "The backup does not support all of this AI's tools and attachments.";
  }
}

const sameBackup = (one: Backup, other: Backup) => one.instanceId === other.instanceId && one.model === other.model;

/** An AI this turn already went to, and why it refused the turn at its start, when it did: a usage limit's scope, or a
 * sign-out. */
export type RecoveryAttempt = Backup & { driverKind: string; why?: "engine" | "model" | "credits" | "signed-out" };

export function untriedBackups<T extends Backup>(backups: readonly T[], current: Backup, tried: readonly Backup[] = []): T[] {
  return backups.filter((backup) => !sameBackup(backup, current) && !tried.some((one) => sameBackup(one, backup)));
}

/** Whether `to` may take the turn after every refusal on the way: a signed-out AI or one at its usage limit offers none of
 * its models, and a limit still rules out another sign-in of that plan. */
export function refusalsAllow(attempts: readonly RecoveryAttempt[], to: LimitEngine, toConfig?: Pick<InstanceConfig, "environment" | "access">): boolean {
  return attempts.every((attempt) => attempt.instanceId === to.instanceId ? attempt.why !== "engine" && attempt.why !== "signed-out"
    : attempt.why === undefined || attempt.why === "signed-out" || limitBackupAllowed(attempt, to, toConfig));
}
