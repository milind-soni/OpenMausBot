import type { ModelSelection } from "../../shared/wire.ts";
import type { HandoffView, HostTurnResult } from "../coordinator.ts";
import type { LimitResetClock } from "../limit-resets.ts";
import type { TurnEvidence } from "../runtime/types.ts";
import type { Store } from "../store.ts";
import type { LimitTakeover } from "./limit-takeover.ts";

const LIMIT_CARRIED_NOTE = "Your previous turn stopped because its AI reached its usage limit or was signed out, and another AI carries this request on now; continue from where it stopped.";

type Refusal = NonNullable<HostTurnResult["refusedBy"]>;

function progressUnknownUnlessMade(evidence: TurnEvidence | undefined): TurnEvidence {
  const { okToolCalls, ...rest } = evidence ?? {};
  return okToolCalls ? { ...rest, okToolCalls } : rest;
}

export interface HandoffLimitsDeps {
  store: Pick<Store, "projectBotForTask" | "bot">;
  limitClock: Pick<LimitResetClock, "noteLimit">;
  takeover: Pick<LimitTakeover, "noteSignedOut" | "holdModel" | "heldAtStart">;
  enabled(): boolean;
  engineName(instanceId: string): string;
}

export function createHandoffLimits(deps: HandoffLimitsDeps) {
  const hold = (selection: ModelSelection, refusal: Refusal): void => {
    if (refusal.scope === "signed-out") deps.takeover.noteSignedOut(selection.instanceId);
    else if (refusal.scope === "engine") deps.limitClock.noteLimit(selection.instanceId, refusal.resetsAt);
    else deps.takeover.holdModel(selection, refusal.scope, refusal.resetsAt);
  };

  return {
    servedBy(node: HandoffView): { servedBy?: string } {
      const ran = deps.store.projectBotForTask(node.botId, node.threadId)?.modelSelection, own = deps.store.bot(node.botId)?.modelSelection;
      return ran && own && (ran.instanceId !== own.instanceId || ran.model !== own.model) ? { servedBy: `${deps.engineName(ran.instanceId)} ${ran.model}` } : {};
    },
    carriedOn(node: HandoffView, result: HostTurnResult): HostTurnResult | undefined {
      const refusal = result.refusedBy, thread = deps.store.projectBotForTask(node.botId, node.threadId);
      if (result.ok || !refusal || !node.parentId || node.groupId || !thread || !deps.enabled()) return undefined;
      hold(thread.modelSelection, refusal);
      if (deps.takeover.heldAtStart(thread, thread.modelSelection) === null) return undefined;
      return { ...result, evidence: progressUnknownUnlessMade(result.evidence), cap: { note: LIMIT_CARRIED_NOTE } };
    },
  };
}
