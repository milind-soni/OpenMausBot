import type { ProviderAdapter } from "./contracts.ts";
import { supportsWorkspaceFiles } from "./workspace.ts";
import { offeredEffortLevels, type ModelSelection } from "../shared/wire.ts";

type Engine = { driverKind: string; capabilities: ProviderAdapter["capabilities"] };
type Backup = ModelSelection;

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

/** A backup as `engine` takes it now: a saved reasoning level or variant the AI no longer offers is left to its default,
 * so the switch to the backup is not refused for a setting the person chose while it was offered. */
export function withOfferedReasoning(backup: Backup, engine: (Parameters<typeof offeredEffortLevels>[0] & { capabilities?: { modelVariants?: boolean } }) | undefined): Backup {
  if (!engine || (backup.effort === undefined && backup.variant === undefined)) return backup;
  const { effort, variant, ...rest } = backup;
  if (effort !== undefined && offeredEffortLevels(engine, backup.model).includes(effort)) return { ...rest, effort };
  if (variant !== undefined && engine.capabilities?.modelVariants === true) return { ...rest, variant };
  return rest;
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
