// The agents catalog's message_person tool and the internal route behind it (server/host/team-messages.ts), which decides
// where the message goes and refuses in words a bot can repeat. On a team it names a person; anywhere else there is one.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const PERSON_TOOL_NAMES: ReadonlySet<string> = new Set(["message_person"]);

export async function callPersonTool(_name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const to = typeof args.to === "string" ? args.to.trim() : "";
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) return { text: "message_person needs message.", isError: true };
  const { ok, body } = await context.client.apiResponse("/api/internal/people/message", { method: "POST", body: JSON.stringify({ ...(to ? { to } : {}), message }) });
  return ok ? { text: String(body.text ?? "Passed on.") } : { text: String(body.error ?? "The message could not be passed on. Try again shortly."), isError: true };
}

export const PERSON_TOOL_DEFINITIONS = [
  {
    name: "message_person",
    description:
      "Get a message to a person's Inbox, when someone asks you to tell them something (\"tell Bob the launch moved\") or when you have news for someone who isn't watching this conversation. Only your message goes, never this conversation, and their answer comes back here. With people on a team, say who with `to`; with none, leave `to` out and it reaches the one person here.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        to: { type: "string", maxLength: 254, description: "Their name or email address, on a team; otherwise leave it out." },
        message: { type: "string", maxLength: 2000, description: "What to tell them, in your words, complete on its own." },
      },
      required: ["message"],
    },
  },
];
