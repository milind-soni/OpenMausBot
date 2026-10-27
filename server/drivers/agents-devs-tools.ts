// The agents catalog's report_bug tool: a person's message that tags @devs is a bug report for the MausBot team, and
// the bot answering it writes the summary that goes with it.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const DEVS_TOOL_NAMES: ReadonlySet<string> = new Set(["report_bug"]);
export const DEVS_REPORT_PATH = "/api/internal/devs/report";

export async function callDevsTool(_name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const wentWrong = text(args.went_wrong);
  if (!wentWrong) return { text: "report_bug needs went_wrong: what the person says went wrong.", isError: true };
  const body = { went_wrong: wentWrong, ...(text(args.you_saw) ? { you_saw: text(args.you_saw) } : {}), ...(text(args.steps) ? { steps: text(args.steps) } : {}) };
  const { ok, body: answer } = await context.client.apiResponse(DEVS_REPORT_PATH, { method: "POST", body: JSON.stringify(body) });
  return ok ? { text: String(answer.text ?? "Sent.") } : { text: String(answer.error ?? "The report could not be sent. Try again shortly."), isError: true };
}

export const DEVS_TOOL_DEFINITIONS = [
  {
    name: "report_bug",
    description:
      "Send the person's bug report to the MausBot team (OpenMausBot's developers) with the app's diagnostics. Only for a message that tags @devs, once. No passwords, keys, tokens or file contents.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        went_wrong: { type: "string", maxLength: 2000, description: "What the person says went wrong." },
        you_saw: { type: "string", maxLength: 3000, description: "What you saw here: errors, failed tools, stuck steps, or nothing unusual." },
        steps: { type: "string", maxLength: 2000, description: "Steps to reproduce." },
      },
      required: ["went_wrong"],
    },
  },
];
