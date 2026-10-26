// The JSON-RPC entry the harness proxy reaches for the device kind: tools/list (filtered to what this bot may run on the
// owner's phones) and tools/call (validate → verdict → pick the phone → run as a phone job). OpenMausBot adds no card of
// its own: a send opens a sheet on the phone and goes only when the person taps Send there. The turn's capability must
// still be live before and after the call.
import { isPhoneToolName, isPhoneWrite, type PhonePlatform, type PhoneToolName } from "../../shared/phone-apps.ts";
import { describeAction } from "./access.ts";
import { PHONE_INSTRUCTIONS, PHONE_NO_PHONE_TEXT } from "./instructions.ts";
import type { PhoneJobOutcome } from "./jobs.ts";
import { PHONE_TOOLS, phoneErrorResult, phoneOkResult, phoneToolCallProblem, type PhoneToolResult } from "./tools.ts";

export const PHONE_INTERNAL_MCP_PATH = "/api/internal/device/mcp";

export type PhoneTarget = { key: string; name: string; platform: PhonePlatform };
/** Why no phone can run the call: the named one is not paired (no_phone), or it does not allow the tool's app (denied). */
export type PhoneRefusal = { ok: false; text: string; code: "no_phone" | "denied" };

export interface PhoneRpcDeps {
  assertActive(): void;
  /** The per-bot verdict for one tool name; a refusal's text is returned to the bot as a failed call. */
  authorize(name: string): { ok: true } | { ok: false; text: string };
  /** Which phone runs the tool: the named one, else the default among those allowing its app; null when there is none. */
  phone(preferred: string | undefined, name: PhoneToolName): PhoneTarget | PhoneRefusal | null;
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
  const { phone: preferred, ...jobArgs } = args as Record<string, unknown>;
  deps.assertActive();
  const verdict = deps.authorize(name);
  if (!verdict.ok) return phoneErrorResult(verdict.text, { code: "refused" });
  const target = deps.phone(typeof preferred === "string" && preferred.trim() ? preferred : undefined, name);
  if (!target) return phoneErrorResult(PHONE_NO_PHONE_TEXT, { code: "no_phone" });
  if ("text" in target) return phoneErrorResult(target.text, { code: target.code });
  const outcome = await deps.run(target, name, jobArgs);
  deps.assertActive();
  if (!outcome.ok) return phoneErrorResult(outcome.error, outcome.code ? { code: outcome.code } : {});
  if (isPhoneWrite(name)) deps.onWrite?.({ tool: name, phone: target.name, summary: `${describeAction(name)} on ${target.name}`.slice(0, 240) });
  return phoneOkResult(outcome.result, { name: target.name, platform: target.platform });
}
