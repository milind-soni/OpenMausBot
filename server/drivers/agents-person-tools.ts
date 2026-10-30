// The agents catalog's message_person tool, shown only on a Team Cloud (OMB_TEAM_PEOPLE), and the internal route behind
// it (server/host/team-messages.ts), which decides where the message goes and refuses in words a bot can repeat.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const PERSON_TOOL_NAMES: ReadonlySet<string> = new Set(["message_person"]);

export async function callPersonTool(_name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const to = typeof args.to === "string" ? args.to.trim() : "";
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!to || !message) return { text: "message_person needs to (a teammate's name or email) and message.", isError: true };
  const { ok, body } = await context.client.apiResponse("/api/internal/people/message", { method: "POST", body: JSON.stringify({ to, message }) });
  return ok ? { text: String(body.text ?? "Passed on.") } : { text: String(body.error ?? "The message could not be passed on. Try again shortly."), isError: true };
}

export const PERSON_TOOL_DEFINITIONS = [
  {
    name: "message_person",
    description:
      "Pass a message to a person on this team, when someone asks you to tell them something (\"tell Bob the launch moved\"). Only your message goes, never this conversation. Someone who can see this conversation is tagged here; anyone else gets it in a new private conversation with you, and their answer can come back here.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        to: { type: "string", maxLength: 254, description: "Their name or email address." },
        message: { type: "string", maxLength: 2000, description: "What to tell them, in your words, complete on its own." },
      },
      required: ["to", "message"],
    },
  },
];
