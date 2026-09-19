// Section administration: creating specialists, and the Chief-of-Staff
// team-setup and bot-deletion proposals that surface one review card.
import { createTurnScopedCounter, type Json, type ToolContext, type ToolHandler, type ToolOutcome } from "./context.ts";

const MAX_CREATED_PER_TURN = 4;
const createdThisTurn = createTurnScopedCounter();

export const handlers = {
  async create_bot(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const botName = String(args.name ?? "").trim();
    const role = String(args.role ?? "").trim();
    const instructions = String(args.instructions ?? "").trim();
    if (!botName || !role || !instructions) {
      return { text: "create_bot needs name, role, and instructions.", isError: true };
    }
    if (createdThisTurn(ctx.turnGeneration) >= MAX_CREATED_PER_TURN) {
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
    if (r.error) return { text: `Couldn't create bot: ${String(r.error)}`, isError: true };
    createdThisTurn(ctx.turnGeneration, 1);
    return {
      text: `Created @${r.name ?? botName} in ${r.section ?? "General"} [id: ${r.id}]. Assign work with ${ctx.coordinating ? "coordinate_bots" : "delegate_bot"}.`,
    };
  },
  async list_team_setup(_args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    return { text: JSON.stringify(await ctx.api("/api/internal/team-setup-catalog")) };
  },
  propose_team_setup: (args: Json, ctx: ToolContext) => teamProposal(false, args, ctx),
  propose_bot_deletion: (args: Json, ctx: ToolContext) => teamProposal(true, args, ctx),
} satisfies Record<string, ToolHandler>;

/** Both Chief-of-Staff proposals answer with the same review-card shape. */
async function teamProposal(deleting: boolean, args: Json, ctx: ToolContext): Promise<ToolOutcome> {
  const targetBotId = deleting && typeof args.bot_id === "string" ? args.bot_id.trim() : "";
  if (deleting && !targetBotId) {
    return { text: "propose_bot_deletion needs bot_id.", isError: true };
  }
  const result = await ctx.api(deleting ? "/api/internal/bot-deletion-requests" : "/api/internal/team-setup-requests", {
    method: "POST", body: JSON.stringify({ fromBotId: ctx.botId, fromThreadId: ctx.threadId,
      ...(deleting ? { targetBotId, reason: args.reason } : { plan: args }),
    }),
  });
  const completed = ctx.completedProposalResult(result, deleting ? "the requested bot deletion" : "the requested team setup");
  if (completed) return completed;
  return { text: `One review card is visible: ${String(result.title)}. Nothing has been applied. End this turn; the decision and structured result resume you automatically once. Do not ask again, poll, or repeat this proposal.` };
}
