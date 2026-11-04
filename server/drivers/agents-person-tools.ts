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
    description: "Reach a person in their Inbox, with news they may miss here or when asked to tell someone something. Their answer comes back here. Only what you write goes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        to: { type: "string", maxLength: 254, description: "On a team: their name or email." },
        message: { type: "string", maxLength: 2000, description: "Complete on its own." },
      },
      required: ["message"],
    },
  },
];
