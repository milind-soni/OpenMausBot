import type { ProviderAdapter } from "./contracts.ts";
import { supportsWorkspaceFiles } from "./workspace.ts";
import type { ModelSelection } from "../shared/wire.ts";

type Engine = { driverKind: string; capabilities: ProviderAdapter["capabilities"] };
type Backup = Pick<ModelSelection, "instanceId" | "model">;

/** The backups a bot's turn tries, in order, when its AI provably never started it: the bot's own list, which needs no
 * switch, or else the installation's one backup while Automatic recovery is on. */
export function startupBackups(bot: { fallback?: Backup[] }, recovery?: { enabled: boolean; backup?: Backup }): Backup[] {
  if (bot.fallback?.length) return bot.fallback;
  return recovery?.enabled && recovery.backup ? [recovery.backup] : [];
}

/** An automatic switch must not strand the task without its tools or move its filesystem to another machine. A USB
 * phone is not one of those tools: only Codex and Pi drive one, Claude offers it on every desktop, and no Cloud has a
 * USB port, so counting it left a limited Claude bot with no backup but those two. */
export function recoveryCapabilityError(from: Engine, to: Engine): string | undefined {
  if (supportsWorkspaceFiles(from.driverKind) !== supportsWorkspaceFiles(to.driverKind)) {
    return "The backup cannot use the same workspace.";
  }
  const tools = ["agentsMcp", "computerMcp", "composioMcp", "dataMcp", "highlevelMcp", "deviceMcp",
    "browserMcp", "localComputerMcp", "customMcp", "images"] as const;
  if (tools.some(key => from.capabilities[key] === true && to.capabilities[key] !== true)) {
    return "The backup does not support all of this AI's tools and attachments.";
  }
}
