import type { ModelSelection } from "../../shared/wire.ts";
import type { HandoffView, HostTurnResult } from "../coordinator.ts";
import type { LimitResetClock } from "../limit-resets.ts";
import type { Store } from "../store.ts";
import type { LimitTakeover } from "./limit-takeover.ts";

const LIMIT_CARRIED_NOTE = "Your previous turn stopped because its AI reached its usage limit or was signed out, and another AI carries this request on now; continue from where it stopped.";

type Refusal = NonNullable<HostTurnResult["refusedBy"]>;

export interface HandoffLimitsDeps {
  store: Pick<Store, "projectBotForTask" | "bot">;
  limitClock: Pick<LimitResetClock, "noteLimit">;
  takeover: Pick<LimitTakeover, "noteSignedOut" | "holdModel" | "heldAtStart">;
  /** OMB_QUOTA_SWITCH: off, nothing carries on by itself. */
  enabled(): boolean;
  engineName(instanceId: string): string;
}

export function createHandoffLimits(deps: HandoffLimitsDeps) {
  /** A refusal recorded as one at a turn's start is: every turn of that AI while it holds, this job's next run included,
   * starts on an AI that can carry it on. */
  const hold = (selection: ModelSelection, refusal: Refusal): void => {
    if (refusal.scope === "signed-out") deps.takeover.noteSignedOut(selection.instanceId);
    else if (refusal.scope === "engine") deps.limitClock.noteLimit(selection.instanceId, refusal.resetsAt);
    else deps.takeover.holdModel(selection, refusal.scope, refusal.resetsAt);
  };

  return {
    /** The AI a job's conversation ran on, for its evidence, when it is not its bot's own. */
    servedBy(node: HandoffView): { servedBy?: string } {
      const ran = deps.store.projectBotForTask(node.botId, node.threadId)?.modelSelection, own = deps.store.bot(node.botId)?.modelSelection;
      return ran && own && (ran.instanceId !== own.instanceId || ran.model !== own.model) ? { servedBy: `${deps.engineName(ran.instanceId)} ${ran.model}` } : {};
    },
    /** A hand-off job its AI's usage limit or sign-out refused runs again while another AI can carry it on: its next
     * turn's start moves its conversation alone there, as for any turn of that AI. Undefined for any other outcome. */
    carriedOn(node: HandoffView, result: HostTurnResult): HostTurnResult | undefined {
      const refusal = result.refusedBy, thread = deps.store.projectBotForTask(node.botId, node.threadId);
      if (result.ok || !refusal || !node.parentId || node.groupId || !thread || !deps.enabled()) return undefined;
      hold(thread.modelSelection, refusal);
      if (deps.takeover.heldAtStart(thread, thread.modelSelection) === null) return undefined;
      // A refusal is not the job stalling: no tool call that worked is progress-unknown, never a no-progress strike.
      const { okToolCalls, ...rest } = result.evidence ?? {};
      return { ...result, evidence: okToolCalls ? { ...rest, okToolCalls } : rest, cap: { note: LIMIT_CARRIED_NOTE } };
    },
  };
}
