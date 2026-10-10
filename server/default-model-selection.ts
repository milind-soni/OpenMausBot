import type { EffortLevel, EngineAccess, ModelCatalog, ModelSelection, ProviderSnapshot } from "./contracts.ts";

export interface SelectableInstance {
  instanceId: string;
  driverKind: string;
  snapshot: ProviderSnapshot;
  models: ModelCatalog;
  capabilities?: { effortLevels?: readonly EffortLevel[]; modelVariants?: boolean };
  access?: EngineAccess;
  enabled?: boolean;
}

/** What an enrolled organisation adds to the choice. Both are omitted (or
 * answer nothing) on a desktop that is not enrolled. */
export interface DefaultSelectionContext {
  /** True for a Company instance the enrolled organisation provides. */
  company?: (instanceId: string) => boolean;
  /** Why the organisation's desktop policy refuses an instance for bots. */
  refusal?: (instance: SelectableInstance) => string | undefined;
}

const claudeFirst = (instances: readonly SelectableInstance[]) =>
  instances.find((instance) => instance.driverKind === "claudeAgent") ?? instances[0];

/** Installed and waiting on a sign-in. A custom endpoint brings its own
 * credential, so its sign-in state does not count. */
export function signedOut(instance: SelectableInstance): boolean {
  return instance.snapshot.state === "available" && instance.access !== "custom" && instance.snapshot.authenticated === false;
}

/** The ready rule: an engine can run a turn now when it is available, the
 * organisation allows it, and it is not signed out (signedOut). */
export function readyToRun(instance: SelectableInstance, context: DefaultSelectionContext = {}): boolean {
  return instance.enabled !== false && instance.snapshot.state === "available" && context.refusal?.(instance) === undefined && !signedOut(instance);
}

const defaultModel = (instance: SelectableInstance) => instance.models.default.trim()
  ? instance.models.default
  : instance.models.options.find((model) => model.id.trim())?.id ?? "";

/** The engine a new bot gets, and the one a bot moved off a removed engine
 * gets (computer-engine-removal.ts): one picker for both.
 *
 * A saved choice is intentional: an unavailable provider or removed model
 * sends new bots to setup instead of silently changing their provider.
 * Without one, an engine that can run a turn now wins (Claude first), then the
 * first available one. On an enrolled desktop a working personal engine
 * still beats a Company one, so billing stays the person's explicit choice. */
export function selectDefaultModelSelection(
  instances: readonly SelectableInstance[],
  preferred?: ModelSelection,
  context: DefaultSelectionContext = {},
): ModelSelection {
  if (preferred && (preferred.instanceId || preferred.model)) {
    const instance = instances.find((candidate) => candidate.instanceId === preferred.instanceId);
    if (
      instance?.snapshot.state !== "available" ||
      instance.enabled === false ||
      signedOut(instance) ||
      !preferred.model.trim() ||
      // An organisation that disallows the saved engine makes it unusable,
      // exactly like an unavailable one: setup, never another provider.
      context.refusal?.(instance) !== undefined ||
      (preferred.variant !== undefined && !instance.capabilities?.modelVariants) ||
      !(instance.models.default === preferred.model || instance.models.options.some((model) => model.id === preferred.model))
    ) {
      return { instanceId: "", model: "" };
    }
    const selection = { ...preferred };
    // A saved effort can outlive driver support. Keep the intentional model,
    // but let the provider use its own effort default instead of failing turn 1.
    if (selection.effort && !instance.capabilities?.effortLevels?.includes(selection.effort)) delete selection.effort;
    return selection;
  }
  // The organisation's policy is inert (no refusal) unless this desktop is enrolled.
  const available = instances.filter((instance) => instance.enabled !== false && instance.snapshot.state === "available" && context.refusal?.(instance) === undefined && defaultModel(instance));
  const ready = available.filter((instance) => readyToRun(instance, context));
  const company = context.company;
  const personal = company && instances.some((instance) => company(instance.instanceId))
    ? claudeFirst(ready.filter((instance) => !company(instance.instanceId)))
    : undefined;
  const pick = personal ?? claudeFirst(ready) ?? claudeFirst(available);
  return { instanceId: pick?.instanceId ?? "", model: pick ? defaultModel(pick) : "" };
}

/** Complete a new bot's selection with the workspace's new-bot effort. An
 * explicit effort or model variant is the caller's choice and wins; an engine
 * that does not offer the level keeps sending none rather than failing turn 1. */
export function withNewBotEffort(
  selection: ModelSelection,
  effort: EffortLevel | undefined,
  offered: readonly EffortLevel[] | undefined,
): ModelSelection {
  if (!effort || selection.effort !== undefined || selection.variant !== undefined || !offered?.includes(effort)) {
    return selection;
  }
  return { ...selection, effort };
}
