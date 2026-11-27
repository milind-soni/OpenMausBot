// The Team Board's three agents tools (docs/team-board.md), mounted on every Team Cloud bot. Each is a
// thin call to its internal route (server/routes/board-tools.ts), which checks the bot, its rooms and every move.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const BOARD_TOOL_NAMES: ReadonlySet<string> = new Set(["board_add", "board_list", "board_update"]);

const PATHS: Record<string, string> = { board_add: "add", board_list: "list", board_update: "update" };

export async function callBoardTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse(`/api/internal/board/${PATHS[name]}`, { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The board did not answer. Try again shortly."), isError: true };
}

const LABELS = { type: "object", additionalProperties: { type: "string", maxLength: 80 }, description: "Tags." };

export const BOARD_TOOL_DEFINITIONS = [
  {
    name: "board_add",
    description: "Split work into items, each on a new room thread; free bots of the room take the ready ones.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        room: { type: "string", description: "Room id or name; default: this room." },
        items: {
          type: "array",
          maxItems: 15,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              key: { type: "string", description: "Its name for needs in this call." },
              title: { type: "string", maxLength: 120 },
              brief: { type: "string", description: "What to do and what done means." },
              needs: { type: "array", items: { type: "string" }, description: "Keys from this call or item ids to finish first." },
              labels: LABELS,
              for: { type: "string", description: "Only this bot of the room may take it." },
            },
            required: ["key", "title"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "board_list",
    description: "Your rooms' work items: state, holder, needs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        room: { type: "string" },
        state: { type: "string", enum: ["waiting", "ready", "working", "needs_person", "done", "failed", "cancelled"] },
      },
    },
  },
  {
    name: "board_update",
    description: "Settle the item you hold (default: this thread's): done or failed (text = result), ask a person (text = question), later (minutes; text = note) or release.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        item: { type: "string", description: "Item id from board_list." },
        move: { type: "string", enum: ["done", "failed", "ask", "later", "release"] },
        text: { type: "string", maxLength: 2000 },
        person: { type: "string", description: "ask: who; default: who made the item." },
        minutes: { type: "integer", minimum: 1, maximum: 1440 },
        labels: LABELS,
      },
    },
  },
];
