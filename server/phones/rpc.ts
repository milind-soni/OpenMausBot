// The JSON-RPC entry the harness proxy reaches for the device kind: tools/list (filtered to what this bot may run on the
// owner's phones) and tools/call (validate → verdict → pick the phone → for an outbound tool: hold, verdict again → the
// phone still allows it → for an outbound tool: reserve → run as a phone job). The turn's capability must still be live
// before and after the call.
import { isOutboundTool } from "../../shared/outbound.ts";
import { isPhoneToolName, isPhoneWrite, type PhonePlatform, type PhoneToolName } from "../../shared/phone-apps.ts";
import { describeAction } from "./access.ts";
import { PHONE_INSTRUCTIONS, PHONE_NO_PHONE_TEXT } from "./instructions.ts";
import type { PhoneJobOutcome } from "./jobs.ts";
import { PHONE_TOOLS, phoneErrorResult, phoneOkResult, phoneToolCallProblem, type PhoneToolResult } from "./tools.ts";

export const PHONE_INTERNAL_MCP_PATH = "/api/internal/device/mcp";

export type PhoneTarget = { key: string; name: string; platform: PhonePlatform };
/** Why no phone can run the call: the named one is not paired (no_phone), or it does not allow the tool's app (denied). */
export type PhoneRefusal = { ok: false; text: string; code: "no_phone" | "denied" };
/** What the hold decided, carried to the dispatch-time reservation. */
export type PhoneHold = { approved: boolean; fullAccess: boolean };

export interface PhoneRpcDeps {
  assertActive(): void;
  /** The per-bot verdict for one tool name; a refusal's text is returned to the bot as a failed call. */
  authorize(name: string): { ok: true } | { ok: false; text: string };
  /** Which phone runs the tool: the named one, else the default among those allowing its app; null when there is none. */
  phone(preferred: string | undefined, name: PhoneToolName): PhoneTarget | PhoneRefusal | null;
  /** An outbound tool waits on the hold ("Send on your behalf?" card, daily allowance or Full access); nothing is reserved yet. */
  holdSend(name: string, args: Record<string, unknown>): Promise<({ ok: true } & PhoneHold) | { ok: false; text: string }>;
  /** The chosen phone still allows the tool's app: one switched off during the hold refuses here. */
  allows(phone: PhoneTarget, name: PhoneToolName): { ok: true } | PhoneRefusal;
  /** Dispatch-time reservation for an outbound tool, once nothing else can refuse it; a refusal's text reaches the bot. */
  reserveSend(name: string, args: Record<string, unknown>, hold: PhoneHold): { ok: true } | { ok: false; text: string };
  run(phone: PhoneTarget, name: PhoneToolName, args: Record<string, unknown>): Promise<PhoneJobOutcome>;
  /** A successful write (sends included): the handler records it in the bot's activity. */
  onWrite?(record: { tool: PhoneToolName; phone: string; summary: string }): void;
}

export type PhoneToolsList = { tools: (typeof PHONE_TOOLS)[number][]; instructions: string };

export async function phoneRpc(
  request: { method?: unknown; params?: unknown } | null | undefined,
  deps: PhoneRpcDeps,
): Promise<PhoneToolsList | PhoneToolResult> {
  if (request?.method === "tools/list") {
    deps.assertActive();
    return { tools: PHONE_TOOLS.filter((tool) => deps.authorize(tool.name).ok), instructions: PHONE_INSTRUCTIONS };
  }
  if (request?.method !== "tools/call") throw Object.assign(new Error("unsupported device method"), { status: 400 });
  const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown };
  const args = params.arguments ?? {};
  const problem = phoneToolCallProblem(params.name, args);
  if (problem || !isPhoneToolName(params.name)) return phoneErrorResult(problem ?? "Unknown phone tool.", { code: "invalid_input" });
  const name = params.name;
  const input = args as Record<string, unknown>;
  const { phone: preferred, ...jobArgs } = input;
  deps.assertActive();
  const verdict = deps.authorize(name);
  if (!verdict.ok) return phoneErrorResult(verdict.text, { code: "refused" });
  const target = deps.phone(typeof preferred === "string" && preferred.trim() ? preferred : undefined, name);
  if (!target) return phoneErrorResult(PHONE_NO_PHONE_TEXT, { code: "no_phone" });
  if ("text" in target) return phoneErrorResult(target.text, { code: target.code });
  let hold: PhoneHold | null = null;
  if (isOutboundTool(name)) {
    const held = await deps.holdSend(name, input);
    if (!held.ok) return phoneErrorResult(held.text, { code: "refused" });
    // An ended turn must not spend the allowance or record a decision for a send nobody is waiting on.
    deps.assertActive();
    // The hold can wait minutes: a grant lowered meanwhile stops the send, as the connectors route re-checks at dispatch.
    const again = deps.authorize(name);
    if (!again.ok) return phoneErrorResult(again.text, { code: "refused" });
    hold = { approved: held.approved, fullAccess: held.fullAccess };
  }
  const ready = deps.allows(target, name);
  if (!ready.ok) return phoneErrorResult(ready.text, { code: ready.code });
  if (hold) {
    const reserved = deps.reserveSend(name, input, hold);
    if (!reserved.ok) return phoneErrorResult(reserved.text, { code: "refused" });
  }
  const outcome = await deps.run(target, name, jobArgs);
  deps.assertActive();
  if (!outcome.ok) return phoneErrorResult(outcome.error, outcome.code ? { code: outcome.code } : {});
  if (isPhoneWrite(name)) deps.onWrite?.({ tool: name, phone: target.name, summary: `${describeAction(name)} on ${target.name}`.slice(0, 240) });
  return phoneOkResult(outcome.result, { name: target.name, platform: target.platform });
}
