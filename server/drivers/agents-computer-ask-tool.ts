import { ASK_FOR_COMPUTER_TOOL, COMPUTER_NEEDS } from "../../shared/computer-ask.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

/** Only on the person's own Cloud (not a Team Cloud), where their own computer is lent to it. */
export const COMPUTER_ASK_TOOL_NAMES: ReadonlySet<string> = new Set([ASK_FOR_COMPUTER_TOOL]);

export async function callComputerAskTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/computer-asks", { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The card did not go through. Try again shortly."), isError: true };
}

export const COMPUTER_ASK_TOOL_DEFINITIONS = [
  {
    name: ASK_FOR_COMPUTER_TOOL,
    description:
      "Ask the person to turn on what a request needs from their own computer when list_shared_computers or shared_computer says it isn't available: one card with your why and a one-tap Turn on. Waits up to 40 s; returns its computer_id once on. If not yet, end your turn: you carry on once it's on.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        need: { type: "string", enum: [...COMPUTER_NEEDS], description: "screen: its apps and screen; folders: its files; terminal: commands." },
        why: { type: "string", maxLength: 200, description: "One sentence for the card: what you'll do there and why." },
      },
      required: ["need", "why"],
    },
  },
];
