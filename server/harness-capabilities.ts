// What a bot gains or loses when its default engine (instanceId, hence
// driver) changes. Two per-driver facts decide it: whether the driver mounts
// the agents tool catalog at all (adapter capabilities.agentsMcp — a bot on
// a driver without it is never even told about the team tools), and which
// approval levels the destination driver implements. Turn-scoped catalog
// flags are identical on both sides of a switch, so the comparison below
// uses one envelope profile and lets the per-driver capability decide the
// delta; the tool names themselves come from the real catalog, so this
// never drifts from what a turn is actually shown.
import { APPROVAL_MODES, type ApprovalMode, supportsApprovalMode as driverKindSupportsApprovalMode } from "../shared/approval-mode.ts";
import { availableTools, type CatalogProfile } from "./drivers/agents-catalog.ts";
import type { ModelSelection } from "./contracts.ts";

export interface DriverCapabilities {
  driverKind: string | undefined;
  /** True when this driver mounts turn.integrations.agents as MCP tools. */
  agentsMcp: boolean;
}

/** The widest turn the harness can build: every optional integration on, a
 * Chief of Staff (the only role shown the Chief-only tools) and a
 * coordinating (room) turn, where the room-only coordination tools exist.
 * So the count is an upper bound, not one bot's catalog. Both sides of a
 * comparison get the same profile; only the driver's own capability can
 * differ. */
const ENVELOPE: CatalogProfile = {
  externalRuntime: false,
  coordinating: true,
  ownThreadCreation: true,
  skillAuthoring: true,
  sharedComputers: true,
  voiceNotes: true,
  // Not a tool it adds: a Cloud home only hides its Local VM shell.
  cloudHome: false,
  chief: true,
  botId: "",
};

/** Extra card lines for an engine switch, empty when nothing changes. */
export function harnessCapabilityLines(from: DriverCapabilities | undefined, to: DriverCapabilities | undefined): string[] {
  if (!from || !to) return [];
  const lines: string[] = [];
  if (from.agentsMcp !== to.agentsMcp) {
    const names = availableTools(ENVELOPE).map((tool) => tool.name);
    const coordination = ["coordinate_bots", "ask_bot", "delegate_bot"].filter((name) => names.includes(name));
    lines.push(
      to.agentsMcp
        ? "Gains peer coordination and the other team tools: " + names.length + " tools including " + coordination.join(", ") + "."
        : "Loses peer coordination and every team tool: " + names.length + " tools including " + coordination.join(", ") + " go away.",
    );
  }
  if (from.driverKind !== to.driverKind) {
    const lost = APPROVAL_MODES.filter((mode) => driverKindSupportsApprovalMode(from.driverKind, mode) && !driverKindSupportsApprovalMode(to.driverKind, mode));
    const gained = APPROVAL_MODES.filter((mode) => !driverKindSupportsApprovalMode(from.driverKind, mode) && driverKindSupportsApprovalMode(to.driverKind, mode));
    if (lost.length) lines.push("Loses approval levels: " + lost.join(", ") + ".");
    if (gained.length) lines.push("Gains approval levels: " + gained.join(", ") + ".");
  }
  return lines;
}

/** The registry surface the approval lookup needs: resolve an instance to
 * the driver that would run it. Structural, so tests can pass a fake. */
export type ApprovalModeRegistry = {
  cliTarget(instanceId: string): { driverKind: string } | null;
};

/** What an approval gate hands the support check: a model selection (its
 * instanceId is the routing key) or an already-resolved driver view. */
export type ApprovalModeTarget =
  | { driverKind: string | undefined }
  | ModelSelection
  | undefined;

/** Binds the registry to the approval-support check so each gate passes its
 * model selection — or a driver view it already holds — and stops
 * unwrapping registry.cliTarget(...)?.driverKind at every call site. The
 * lookup prefers shadow state, so a mid-reconfig instance answers with the
 * driver it would actually run. */
export function createApprovalModeSupport(registry: ApprovalModeRegistry) {
  return function supportsApprovalMode(target: ApprovalModeTarget, mode: ApprovalMode): boolean {
    const driverKind = target === undefined
      ? undefined
      : "driverKind" in target
        ? target.driverKind
        : registry.cliTarget(target.instanceId)?.driverKind;
    return driverKindSupportsApprovalMode(driverKind, mode);
  };
}
