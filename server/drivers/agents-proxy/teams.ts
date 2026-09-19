// Section administration: creating specialists, and the Chief-of-Staff
// team-setup and bot-deletion proposals that surface one review card.
import type { Json, ToolContext, ToolHandler, ToolOutcome } from "./context.ts";

const MAX_CREATED_PER_TURN = 4;
let createdThisTurn = 0;

export const handlers = {
  async create_bot(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const botName = String(args.name ?? "").trim();
    const role = String(args.role ?? "").trim();
    const instructions = String(args.instructions ?? "").trim();
    if (!botName || !role || !instructions) {
      return { text: "create_bot needs name, role, and instructions.", isError: true };
    }
    if (createdThisTurn >= MAX_CREATED_PER_TURN) {
      return { text: `You can create at most ${MAX_CREATED_PER_TURN} bots in one turn. Use the team you have before adding more.`, isError: true };
    }
    const r = await ctx.api(`/api/internal/create-bot`, {
      method: "POST",
      body: JSON.stringify({
        fromBotId: ctx.botId,
        fromThreadId: ctx.threadId,
        name: botName,
        role,
        instructions,
      }),
    });
    createdThisTurn += 1;
    return {
      text: `Created @${r.name ?? botName} in ${r.section ?? "General"} [id: ${r.id}]. Assign work with ${ctx.coordinating ? "coordinate_bots" : "delegate_bot"}.`,
    };
  },
  async list_team_setup(_args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    return { text: JSON.stringify(await ctx.api("/api/internal/team-setup-catalog")) };
  },
  propose_team_setup: (args: Json, ctx: ToolContext) => teamProposal(false, args, ctx),
  propose_bot_deletion: (args: Json, ctx: ToolContext) => teamProposal(true, args, ctx),
  async retry_thread(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const botId = String(args.bot_id ?? "").trim();
    const threadId = String(args.thread_id ?? "").trim();
    const note = typeof args.note === "string" ? args.note.trim() : "";
    if (!botId || !threadId) {
      return { text: "retry_thread needs bot_id and thread_id — both are in the incident report.", isError: true };
    }
    const r = await ctx.api("/api/internal/retry-thread", {
      method: "POST",
      body: JSON.stringify({ fromBotId: ctx.botId, fromThreadId: ctx.threadId, toBotId: botId, toThreadId: threadId, ...(note ? { note } : {}) }),
    });
    if (r.error) return { text: `Couldn't retry that thread: ${String(r.error)}`, isError: true };
    return { text: typeof r.message === "string" ? r.message : "The thread is running again. Its result stays in that thread; you are not woken for it — check it later with session_search or list_threads if you need to." };
  },
} satisfies Record<string, ToolHandler>;

/** Both Chief-of-Staff proposals answer with the same review-card shape. */
async function teamProposal(deleting: boolean, args: Json, ctx: ToolContext): Promise<ToolOutcome> {
  const result = await ctx.api(deleting ? "/api/internal/bot-deletion-requests" : "/api/internal/team-setup-requests", {
    method: "POST", body: JSON.stringify({ fromBotId: ctx.botId, fromThreadId: ctx.threadId,
      ...(deleting ? { targetBotId: args.bot_id, reason: args.reason } : { plan: args }),
    }),
  });
  const completed = ctx.completedProposalResult(result, deleting ? "the requested bot deletion" : "the requested team setup");
  if (completed) return completed;
  return { text: `One review card is visible: ${String(result.title)}. Nothing has been applied. End this turn; the decision and structured result resume you automatically once. Do not ask again, poll, or repeat this proposal.` };
}
