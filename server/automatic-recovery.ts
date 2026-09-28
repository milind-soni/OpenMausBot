import type { ProviderAdapter } from "./contracts.ts";
import { supportsWorkspaceFiles } from "./workspace.ts";

type Engine = { driverKind: string; capabilities: ProviderAdapter["capabilities"] };

/** An automatic switch must not strand the task without its tools or move
 * its filesystem to another machine. Approval and organisation policy are
 * checked by the ordinary model-switch and turn-admission gates. */
export function recoveryCapabilityError(from: Engine, to: Engine): string | undefined {
  if (from.capabilities.remoteAgent || to.capabilities.remoteAgent ||
      supportsWorkspaceFiles(from.driverKind) !== supportsWorkspaceFiles(to.driverKind)) {
    return "The backup cannot use the same workspace.";
  }
  const tools = ["agentsMcp", "computerMcp", "cloudComputerMcp", "composioMcp",
    "phoneMcp", "browserMcp", "localComputerMcp", "customMcp", "images"] as const;
  if (tools.some(key => from.capabilities[key] === true && to.capabilities[key] !== true)) {
    return "The backup does not support all of this engine's tools and attachments.";
  }
}
