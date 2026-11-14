// A model missing from its engine's catalog is no reason to fall back: engines run IDs their catalog does not list.
import type { ModelSelection } from "./contracts.ts";
import { readyToRun, signedOut, type DefaultSelectionContext, type SelectableInstance } from "./default-model-selection.ts";
import { sameModelSelection } from "../shared/thread-model.ts";

export type ThreadEngine = SelectableInstance & { enabled: boolean };

export type ThreadModelFallback = "unavailable" | "signed-out";

export interface ThreadModelContext extends DefaultSelectionContext {
  allows?: (selection: ModelSelection) => boolean;
}

function canRunOn(engine: ThreadEngine | undefined, selection: ModelSelection, context: ThreadModelContext): engine is ThreadEngine {
  return Boolean(engine?.enabled) && engine!.snapshot.state === "available" && context.refusal?.(engine!) === undefined &&
    context.allows?.(selection) !== false;
}

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
