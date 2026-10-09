// A thread runs on its bot's model unless a person picked another model in
// that thread. A picked model that can't run here gives way to the bot's: the
// turn runs on the bot's model, the thread follows the bot from then on, and
// one line in it says so (index.ts healThreadModel). Whether an engine can
// run is the readiness rule a new bot's engine meets (default-model-selection.ts);
// this decides only when the bot's model stands in.
//
// A model missing from its engine's catalog is not a reason: model IDs are
// free-form at the API boundary, and several engines run IDs their catalog
// does not list (a 1M-context variant, a custom or local model) or learn
// their catalog only once a turn starts. The turn tries the model as picked.
import type { ModelSelection } from "./contracts.ts";
import { readyToRun, signedOut, type DefaultSelectionContext, type SelectableInstance } from "./default-model-selection.ts";
import { sameModelSelection } from "../shared/thread-model.ts";

/** An engine as a turn's start sees it, without waiting on its CLI: whether
 * it is enabled, its catalog, and what its last read said. */
export type ThreadEngine = SelectableInstance & { enabled: boolean };

/** Why a thread's own model gives way to its bot's. */
export type ThreadModelFallback = "unavailable" | "signed-out";

/** What the organisation, or a hosted workspace's assigned models, allow. */
export interface ThreadModelContext extends DefaultSelectionContext {
  allows?: (selection: ModelSelection) => boolean;
}

function canRunOn(engine: ThreadEngine | undefined, selection: ModelSelection, context: ThreadModelContext): engine is ThreadEngine {
  return Boolean(engine?.enabled) && engine!.snapshot.state === "available" && context.refusal?.(engine!) === undefined &&
    context.allows?.(selection) !== false;
}

/** Why this thread's own model gives way to its bot's, or null when the turn
 * runs on it as picked:
 * - "unavailable": its engine is gone, disabled, unavailable or not allowed
 *   (by the organisation, or a hosted workspace's assigned models);
 * - "signed-out": its engine is signed out and the bot's model is on another
 *   engine that can run. On the same engine the turn runs as picked, so the
 *   engine's own sign-in prompt shows; a fallback never hides it. */
export function threadModelFallback(
  own: ModelSelection,
  botModel: ModelSelection,
  engine: (instanceId: string) => ThreadEngine | undefined,
  context: ThreadModelContext = {},
): ThreadModelFallback | null {
  if (sameModelSelection(own, botModel)) return null;
  const mine = engine(own.instanceId);
  if (!canRunOn(mine, own, context)) return "unavailable";
  if (!signedOut(mine)) return null;
  // On the same engine the bot's model is signed out too, so it never stands in.
  const theirs = engine(botModel.instanceId);
  return canRunOn(theirs, botModel, context) && readyToRun(theirs, context) ? "signed-out" : null;
}
