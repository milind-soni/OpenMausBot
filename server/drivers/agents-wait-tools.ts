import { WAIT_HOURS, WAIT_KINDS } from "../../shared/waits.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

const WAITS = "/api/internal/waits";
export const WAIT_TOOL_NAMES: ReadonlySet<string> = new Set(["wait_until", "list_waits", "cancel_wait"]);

export async function callWaitTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } =
    name === "list_waits"
      ? await context.client.apiResponse(WAITS)
      : await context.client.apiResponse(name === "cancel_wait" ? `${WAITS}/cancel` : WAITS, { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The wait did not go through. Try again shortly."), isError: true };
}

export const WAIT_TOOL_DEFINITIONS = [
  {
    name: "wait_until",
    // Short on purpose: it rides every turn. Its result says when the condition already holds, when this computer cannot
    // check files or programs, and when My Cloud's sleep can delay the message.
    description:
      `Tell the person in this chat when something happens. No AI runs while you wait, only plain code checks. Ends after hours (default ${WAIT_HOURS.default}, 1-${WAIT_HOURS.max}).`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        label: { type: "string", maxLength: 120, description: 'A noun phrase in the person\'s words, e.g. "the build".' },
        kind: {
          type: "string",
          enum: [...WAIT_KINDS],
          description: "url_*: the page at url has or lacks text. file_*: path exists, is gone or changes. process_*: process (name or pid) runs or stops. bot_idle: bot (name or id) finishes its work.",
        },
        url: { type: "string" },
        text: { type: "string" },
        path: { type: "string" },
        process: { type: "string" },
        bot: { type: "string" },
        follow_up: {
          type: "string",
          maxLength: 2000,
          description: "Only if the person asked for something to be done then: that request, for a run that won't see this chat. You carry it out here.",
        },
        hours: { type: "integer", minimum: 1, maximum: WAIT_HOURS.max },
      },
      required: ["label", "kind"],
    },
  },
  {
    name: "list_waits",
    description: "Your waits in this chat that have not ended (wait_until): id, label, what it checks, when it was made and when it stops.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "cancel_wait",
    description: "Stop one of your waits; its id comes from list_waits or wait_until's answer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
    },
  },
];
