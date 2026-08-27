import type { OwnerActionOutcome, PerformOwnerActionInput } from "../../collaboration/actions.ts";
import type { DingTalkOwnerActionSink } from "./ports.ts";
import type { DingTalkCardAction } from "./types.ts";
import type { DingTalkCardActionLedger } from "./action-ledger.ts";

export class OwnerCardActionBridge implements DingTalkOwnerActionSink {
  private readonly performOwnerAction: (input: PerformOwnerActionInput) => OwnerActionOutcome;
  private readonly eventLedger?: DingTalkCardActionLedger;

  constructor(
    performOwnerAction: (input: PerformOwnerActionInput) => OwnerActionOutcome,
    eventLedger?: DingTalkCardActionLedger,
  ) {
    this.performOwnerAction = performOwnerAction;
    this.eventLedger = eventLedger;
  }

  perform(action: DingTalkCardAction): OwnerActionOutcome {
    // Action/work item/version/privilege fields from card JSON are deliberately ignored.
    // The opaque token resolves those server-side and the current sender is re-authorized.
    const perform = () =>
      this.performOwnerAction({
        actionToken: action.actionToken,
        sender: action.sender,
        ...(action.reason ? { reason: action.reason } : {}),
        now: action.receivedAt,
      });
    return this.eventLedger ? this.eventLedger.perform(action, perform) : perform();
  }
}
