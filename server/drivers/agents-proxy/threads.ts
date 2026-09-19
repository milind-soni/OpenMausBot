// Thread tools: the threads this bot opened on itself or on teammates.
// A thread is a real turn with its own run. Five in one turn is a plan
// ("one per pull request"); more than that is a model that has stopped
// deciding. The harness holds the same ceiling; this copy exists so the
// refusal reaches the model without a round trip.
import { createTurnScopedCounter, type Json, type ToolContext, type ToolHandler, type ToolOutcome } from "./context.ts";

const MAX_THREADS_PER_TURN = 5;
const threadsOpenedThisTurn = createTurnScopedCounter();

export const handlers = {
  async list_threads(_args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const query = new URLSearchParams({ fromBotId: ctx.botId, fromThreadId: ctx.threadId });
    const r = await ctx.api(`/api/internal/threads?${query.toString()}`);
    if (r.error) return { text: `Couldn't list threads: ${String(r.error)}`, isError: true };
    const threads = Array.isArray(r.threads) ? r.threads.filter(ctx.jsonRecord) : [];
    if (!threads.length) return { text: "No threads yet: you have none of your own beyond this one, and you have not opened any on a teammate." };
    const stateWord: Record<string, string> = { running: "running", "waiting-on-you": "waiting on the person", queued: "queued", idle: "idle" };
    const lines = threads.map((thread) => {
      const where = thread.own === true ? "yours" : `on @${String(thread.botName)}`;
      const state = stateWord[String(thread.state)] ?? String(thread.state);
      const unread = thread.unread === true ? ", unread for the person" : "";
      const handoff = typeof thread.delegationId === "string" && thread.delegationId ? ` [delegation id: ${thread.delegationId}]` : "";
      return `- #${String(thread.title)} (${where}, ${state}${unread}) [thread id: ${String(thread.threadId)}]${handoff}`;
    });
    return { text: `Threads, newest first:\n${lines.join("\n")}` };
  },
  async close_thread(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const threadId = String(args.thread_id ?? "").trim();
    if (!threadId) return { text: "close_thread needs the thread_id from list_threads or start_thread.", isError: true };
    const r = await ctx.api(`/api/internal/threads/${encodeURIComponent(threadId)}/close`, { method: "POST", body: JSON.stringify({ fromBotId: ctx.botId, fromThreadId: ctx.threadId }) });
    if (r.error) return { text: `Couldn't close that thread: ${String(r.error)}`, isError: true };
    return { text: `Closed #${String(r.title)}${r.botName ? ` on @${String(r.botName)}` : ""}. It stays in the person's sidebar, idle, with a note that you closed it.` };
  },
  async start_thread(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const title = String(args.title ?? "").trim();
    const message = String(args.message ?? "").trim();
    if (!title || !message) return { text: "start_thread needs title (one short line) and message (the complete first message).", isError: true };
    if (threadsOpenedThisTurn(ctx.turnGeneration) >= MAX_THREADS_PER_TURN) {
      return {
        text: `You have already opened ${MAX_THREADS_PER_TURN} threads this turn, which is the limit. Do not retry — finish your turn and tell the person which threads you still wanted to open, so they can open them or ask you again.`,
        isError: true,
      };
    }
    const toBotId = typeof args.bot_id === "string" ? args.bot_id.trim() : "";
    if (ctx.coordinating && toBotId && toBotId !== ctx.botId) {
      return { text: "Use coordinate_bots for teammates; start_thread only opens a separate job on yourself.", isError: true };
    }
    const folder = typeof args.folder === "string" ? args.folder.trim() : "";
    const body: Record<string, unknown> = { fromBotId: ctx.botId, fromThreadId: ctx.threadId, title, message, depth: ctx.depth };
    if (toBotId) body.toBotId = toBotId;
    if (folder) body.folder = folder;
    const r = await ctx.api("/api/internal/threads", { method: "POST", body: JSON.stringify(body) });
    // A refusal opened nothing. A "failed" state opened the thread and could
    // not start its turn — that one still counts, and still has an id.
    if (r.error && r.state !== "failed") return { text: `Couldn't open that thread: ${String(r.error)}`, isError: true };
    threadsOpenedThisTurn(ctx.turnGeneration, 1);
    const threadTitle = String(r.title ?? title);
    const threadId = String(r.threadId ?? "");
    const where = r.self === true ? "on yourself" : `on @${String(r.botName ?? "that bot")}`;
    const opened = `Opened thread #${threadTitle} ${where} [thread id: ${threadId}].`;
    if (r.self === true) {
      if (r.state === "running") {
        return { text: `${opened} It is running now, in parallel with this conversation, and its result stays in that thread — it will not be delivered here. Mention it to the person as #${threadTitle}; use list_threads in a later turn to see how it is going.` };
      }
      if (r.state === "queued") {
        const position = Number(r.position) || 1;
        const limit = Number(r.limit) || 0;
        return { text: `${opened} You are at your limit of ${limit} threads running at once, so it is ${ctx.ordinal(position)} in line and starts as soon as one of them finishes — nothing more to do. Mention it to the person as #${threadTitle}.` };
      }
      return { text: `${opened} It could not start: ${String(r.error ?? "unknown reason")}. The thread exists but nothing is running in it; tell the person.`, isError: true };
    }
    // A peer thread is a handoff: like delegate_bot, it starts after this
    // turn and reports back here, so the id is a claim ticket the model
    // must not cash in this same turn.
    const delegationId = typeof r.delegationId === "string" ? r.delegationId.trim() : "";
    if (delegationId) ctx.delegationTaskIdsThisTurn.add(delegationId);
    const approval = r.approvalRequired === true
      ? " The person must approve this handoff first; their card appears after your turn ends."
      : "";
    const timing = r.state === "queued"
      ? ` @${String(r.botName ?? "that bot")} can run ${Number(r.limit) || 0} threads at once and they are all spoken for, so it waits ${ctx.ordinal(Number(r.position) || 1)} in line for a free slot after this turn ends.`
      : " It starts when this turn ends, like any handoff.";
    return {
      text: `${opened}${timing}${approval} Its result will be delivered to this conversation automatically (delegation id: ${delegationId || "unknown"}). Acknowledge it, mention it to the person as #${threadTitle}, and finish your turn; do not check or wait for it in this turn.`,
    };
  },
  async retry_thread(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const botId = String(args.bot_id ?? "").trim();
    const threadId = String(args.thread_id ?? "").trim();
    const note = typeof args.note === "string" ? args.note.trim() : "";
    if (!botId || !threadId) return { text: "retry_thread needs bot_id and thread_id — both are in the incident report.", isError: true };
    const r = await ctx.api("/api/internal/retry-thread", {
      method: "POST",
      body: JSON.stringify({ fromBotId: ctx.botId, fromThreadId: ctx.threadId, toBotId: botId, toThreadId: threadId, ...(note ? { note } : {}) }),
    });
    if (r.error) return { text: `Couldn't retry that thread: ${String(r.error)}`, isError: true };
    return { text: typeof r.message === "string" ? r.message : "The thread is running again. Its result stays in that thread; you are not woken for it — check it later with session_search or list_threads if you need to." };
  },
} satisfies Record<string, ToolHandler>;
