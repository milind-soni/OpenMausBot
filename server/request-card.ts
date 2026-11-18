import type { RuntimeEvent } from "../shared/runtime-events.ts";
import type { OptionCardData } from "../shared/wire.ts";

type RequestOpened = Extract<RuntimeEvent, { type: "request.opened" }>;
type RequestCardContext = Pick<OptionCardData, "commandAllowlist" | "allowKey" | "held" | "heldCode"> & {
  permission: boolean;
  guestDriven: boolean;
};

export function runtimeRequestCardFields(event: RequestOpened, context: RequestCardContext): Omit<OptionCardData, "title"> {
  const { permission, guestDriven } = context;
  const questions = event.questions?.length ? event.questions : undefined;
  return {
    subtitle: event.summary,
    ...(event.summaryCode ? {
      summaryCode: event.summaryCode,
      ...(event.summaryParams ? { summaryParams: event.summaryParams } : {}),
    } : {}),
    options: event.choices?.length ? event.choices : permission ? ["Allow", "Deny"] : [],
    requestId: event.requestId,
    requestType: permission ? "permission" : "question",
    tool: permission ? event.tool : undefined,
    questionRequest: questions
      ? { version: 1, questions, ...(event.origin === "output" ? { origin: "output" as const } : {}) }
      : undefined,
    commandAllowlist: context.commandAllowlist,
    allowKey: context.allowKey,
    // A guest's turn cannot leave a session grant behind.
    allowSession: permission && event.allowSession && !event.requiresExplicitApproval && !guestDriven ? true : undefined,
    held: context.held,
    heldCode: context.heldCode,
    approvalScope: event.approvalScope,
  };
}
