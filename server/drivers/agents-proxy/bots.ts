// Teammate tools: the roster, and the ask/delegate lifecycle around it.
// ask_bot, delegate_bot and the thread handoffs in threads.ts share the
// delegation id set through the context so a bot never polls a task it
// created in the same turn.
import { peerName } from "../../peer-roster.ts";
import type { Json, ToolContext, ToolHandler, ToolOutcome } from "./context.ts";

export const handlers = {
  async list_bots(_args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const r = await ctx.api(`/api/internal/agents?self=${encodeURIComponent(ctx.botId)}`);
    const bots = (r.bots as Array<Json>) ?? [];
    if (!bots.length) return { text: "No other reachable bots yet." };
    const lines = bots.map((b) => {
      const role = b.title ? ` — ${b.title}` : "";
      const about = b.description ? ` (${String(b.description).slice(0, 120)})` : "";
      // statusText is the server's own wording for what the teammate is
      // doing; an older server only sends busy, so fall back to that.
      const state = typeof b.statusText === "string"
        ? (b.status === "available" ? "" : b.statusText)
        : (b.busy ? "busy" : "");
      const team = typeof b.section === "string" ? `, team: ${peerName(b.section) || "General"}` : "";
      return `- ${b.name}${role}${about} [id: ${b.id}, model: ${b.model}${team}${state ? `, ${state}` : ""}]`;
    });
    return {
      text: `Reachable teammates:\n${lines.join("\n")}\n\n${ctx.coordinating ? "Use coordinate_bots for advice or concrete work, then end your turn. Busy teammates queue and results resume you automatically." : "Assign work with delegate_bot. Use ask_bot only for a short answer you need inline."}`,
    };
  },
  async ask_bot(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const toBotId = String(args.bot_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    if (!toBotId || !message) return { text: "ask_bot needs bot_id and message.", isError: true };
    const r = await ctx.api(`/api/internal/ask-bot`, {
      method: "POST",
      body: JSON.stringify({ fromBotId: ctx.botId, fromThreadId: ctx.threadId, toBotId, message, depth: ctx.depth }),
    });
    if (r.timeout) {
      // The peer's turn outlived the synchronous wait, so the harness
      // converted the ask into a delegation — the reply is not lost.
      const taskId = String(r.taskId ?? "").trim();
      if (taskId) ctx.delegationTaskIdsThisTurn.add(taskId);
      const waitedMinutes = Math.max(1, Math.round((Number(r.waitedMs) || 0) / 60_000));
      return {
        text: `${r.toBotName ?? "That bot"} is still working after ${waitedMinutes} minute${waitedMinutes === 1 ? "" : "s"} — the ask was converted to a delegation so the reply is not lost. Task id: ${taskId}. Finish your turn now; the result will be delivered to this conversation automatically. Use check_delegation in a later turn only if the user asks for status.`,
      };
    }
    if (r.busy) {
      // The harness queues the message as a delegation when it can; the
      // task id is the asker's claim ticket for the eventual reply.
      const taskId = String(r.taskId ?? "").trim();
      if (taskId) {
        ctx.delegationTaskIdsThisTurn.add(taskId);
        return {
          text: `${r.toBotName ?? "That bot"} is busy right now, so your message was queued as a delegation instead — it runs after your current turn ends. Task id: ${taskId}. Finish your turn now; the result will be delivered to this conversation automatically. Use check_delegation in a later turn only if the user asks for status.`,
        };
      }
      return { text: `That bot is busy right now — try again after it finishes.` };
    }
    if (r.error) return { text: `Couldn't reach that bot: ${r.error}`, isError: true };
    return { text: `${r.botName ?? "Bot"} replied:\n${r.text ?? "(no reply)"}` };
  },
  async delegate_bot(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const toBotId = String(args.bot_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!toBotId || !message) return { text: "delegate_bot needs bot_id and message.", isError: true };
    const body: Record<string, unknown> = {
      fromBotId: ctx.botId,
      fromThreadId: ctx.threadId,
      toBotId,
      message,
      depth: ctx.depth,
    };
    if (reason) body.reason = reason;
    const r = await ctx.api(`/api/internal/delegate-bot`, { method: "POST", body: JSON.stringify(body) });
    if (r.error) return { text: `Couldn't queue the delegation: ${r.error}`, isError: true };
    // Fire-and-forget by contract: the harness returns immediately, the
    // peer turn runs after our current turn finishes. The task id is the
    // bot's claim ticket for the outcome.
    const note = typeof r.message === "string" ? r.message : "Delegation queued.";
    const taskId = typeof r.taskId === "string" ? r.taskId.trim() : "";
    if (taskId) ctx.delegationTaskIdsThisTurn.add(taskId);
    const suffix = taskId
      ? ` Task id: ${taskId}. Acknowledge the assignment and finish your turn; the result will be delivered to this conversation automatically. Do not check or wait for it in this turn.`
      : "";
    return { text: `${note}${suffix}` };
  },
  check_delegation: (args: Json, ctx: ToolContext) => delegationStatus("check_delegation", args, ctx),
  wait_delegation: (args: Json, ctx: ToolContext) => delegationStatus("wait_delegation", args, ctx),
} satisfies Record<string, ToolHandler>;

/** check_delegation and wait_delegation are one status read; only the wait
 * blocks, and the texts say which tool was called. */
async function delegationStatus(name: "check_delegation" | "wait_delegation", args: Json, ctx: ToolContext): Promise<ToolOutcome> {
  const taskId = String(args.task_id ?? "").trim();
  if (!/^[\w-]{4,64}$/.test(taskId)) {
    return { text: `${name} needs the "task_id" that delegate_bot returned, e.g. {"task_id":"1f0c2f4e-..."}.`, isError: true };
  }
  if (ctx.delegationTaskIdsThisTurn.has(taskId)) {
    return {
      text: `Task ${taskId} was delegated during this turn. Finish your response now so the other bot can work; its result will be delivered to this conversation automatically. Do not check or wait for a newly delegated task until a later turn.`,
      isError: true,
    };
  }
  const timeout = Math.min(Math.max(Math.trunc(Number(args.timeout_seconds) || 60), 1), 240);
  const waitMs = name === "wait_delegation" ? timeout * 1000 : 0;
  const query = new URLSearchParams({ fromBotId: ctx.botId, fromThreadId: ctx.threadId, wait_ms: String(waitMs) });
  const r = await ctx.api(`/api/internal/delegations/${encodeURIComponent(taskId)}?${query.toString()}`);
  const who = typeof r.toBotName === "string" && r.toBotName ? `@${r.toBotName}` : "the peer";
  if (r.status === "done") return { text: `${who} finished task ${taskId}:\n${String(r.result || "(no reply text)")}` };
  if (r.status === "queued") {
    const why = r.targetStatus === "waiting-on-user"
      ? ` ${who} is waiting on the user, so it goes through after they answer.`
      : r.targetStatus === "working" ? ` ${who} is busy with other work.` : "";
    const expiresInMs = Number(r.expiresInMs);
    const expiry = !Number.isFinite(expiresInMs)
      ? ""
      : expiresInMs <= 0
        ? " It is past its 24-hour limit and will expire the next time it cannot be delivered."
        : ` It expires if not picked up within ${Math.ceil(expiresInMs / 3_600_000)} hour${Math.ceil(expiresInMs / 3_600_000) === 1 ? "" : "s"}.`;
    return { text: `Task ${taskId} is still queued — ${who} hasn't picked it up yet${waitMs ? ` after ${timeout}s` : ""}.${why}${expiry} Keep working and check again later.` };
  }
  if (r.status === "running") {
    const elapsedMs = Number.isFinite(r.elapsedMs) ? Number(r.elapsedMs) : 0;
    const minutes = Math.floor(elapsedMs / 60_000);
    const elapsed = minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round(elapsedMs / 1000)}s`;
    const activity = Array.isArray(r.recentActivity) ? r.recentActivity.filter((line: unknown) => typeof line === "string") : [];
    const recent = activity.length
      ? activity.map((line: string) => `  - ${line}`).join("\n")
      : "  (no visible activity yet — if this stays empty, the peer may be stuck, not working; say so instead of promising progress)";
    return {
      text: `Task ${taskId} is running with ${who} — going on ${elapsed} now.${waitMs ? ` (still going after ${timeout}s)` : ""}\nRecent activity:\n${recent}\nJudge progress by this activity, not by waiting: real work keeps producing lines; the same silence for a long stretch usually means stuck.`,
    };
  }
  return { text: `Task ${taskId} ended without a reply — ${String(r.status ?? "unknown")}${r.result ? `: ${String(r.result)}` : ""}.`, isError: true };
}
