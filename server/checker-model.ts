import { freeFallback } from "../shared/ai-ranking.ts";
import type { ModelSelection } from "./contracts.ts";
import { readyToRun, selectDefaultModelSelection, type DefaultSelectionContext, type SelectableInstance } from "./default-model-selection.ts";

/** The model a bot that checks other bots' work starts on: the best ready AI of another provider than `current`'s, since a
 * model rarely catches its own mistakes. Null when no other provider is ready; OpenCode's free backup models never count. */
export function otherProviderSelection(
  instances: readonly SelectableInstance[],
  current: ModelSelection,
  context: DefaultSelectionContext = {},
): ModelSelection | null {
  const own = instances.find((instance) => instance.instanceId === current.instanceId)?.driverKind;
  const others = instances.filter((instance) => instance.driverKind !== own && !freeFallback(instance) && readyToRun(instance, context));
  const pick = selectDefaultModelSelection(others, undefined, context);
  return pick.instanceId && pick.model ? pick : null;
}
