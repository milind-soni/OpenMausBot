// The agents catalog's decide and extract tools: small helper models that judge or read and can never act, so every bot
// on every engine has them. The internal route (server/routes/helper-tools.ts) says plainly when none is set up.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

const HELPER_TOOL_ROUTES: Readonly<Record<string, string>> = { decide: "helpers/decide", extract: "helpers/extract" };
export const HELPER_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(HELPER_TOOL_ROUTES));

export async function callHelperTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse(`/api/internal/${HELPER_TOOL_ROUTES[name]}`, { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The helper model did not answer. Try again shortly."), isError: true };
}

export const HELPER_TOOL_DEFINITIONS = [
  {
    name: "decide",
    description: "Ask a decision model typed questions about some state; it answers with probabilities and cannot act.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        state: { type: "string", description: "What to judge: text or JSON." },
        questions: {
          type: "object",
          description: 'Up to 8. id → {"type":"choice","instructions":"…","options":{"key":"meaning"}}, {"type":"yesno","instructions":"…"} or {"type":"score","instructions":"…","levels":["lowest",…]}',
          additionalProperties: { type: "object" },
        },
      },
      required: ["state", "questions"],
    },
  },
  {
    name: "extract",
    description: "Read typed values out of text or an image; null where it does not say. Not for long sums or table totals.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fields: {
          type: "object",
          description: 'Up to 30. name → {"type":"string|number|date|boolean|enum","description":"…","options":[…] for enum}',
          additionalProperties: { type: "object" },
        },
        text: { type: "string" },
        file: { type: "string", description: "Or a .png, .jpg, .webp or text file in your working folder." },
      },
      required: ["fields"],
    },
  },
];
