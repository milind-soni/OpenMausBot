// The agents catalog's list_threads tool: this bot's own threads and the ones it opened on teammates, newest first,
// one page of the internal route (server/routes/internal-threads.ts) at a time.
import type { Json } from "./agents-client.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export const LIST_THREADS_TOOL = "list_threads";

const STATE_WORD: Record<string, string> = { running: "running", "waiting-on-you": "waiting on the person", queued: "queued", idle: "idle" };

function threadLine(thread: Json): string {
  const where = thread.own === true ? "yours" : `on @${String(thread.botName)}${typeof thread.openedBy === "string" && thread.openedBy ? `, opened by @${thread.openedBy}` : ""}`;
  const state = STATE_WORD[String(thread.state)] ?? String(thread.state);
  const unread = thread.unread === true ? ", unread for the person" : "";
  const handoff = typeof thread.delegationId === "string" && thread.delegationId ? ` [delegation id: ${thread.delegationId}]` : "";
  const waiting = typeof thread.waiting === "string" && thread.waiting ? `: ${thread.waiting}` : "";
  return `- #${String(thread.title)} (${where}, ${state}${waiting}${unread}) [thread id: ${String(thread.threadId)}]${handoff}`;
}

export async function callListThreadsTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const query = new URLSearchParams({ fromBotId: context.botId, fromThreadId: context.threadId, ...(args.page === undefined ? {} : { page: String(args.page) }) });
  const r = await context.client.api(`/api/internal/threads?${query.toString()}`);
  if (r.error) return { text: `Couldn't list threads: ${String(r.error)}`, isError: true };
  const threads = Array.isArray(r.threads) ? r.threads.filter((row): row is Json => typeof row === "object" && row !== null && !Array.isArray(row)) : [];
  const total = typeof r.total === "number" ? r.total : threads.length;
  const page = typeof r.page === "number" ? r.page : 1;
  const pageSize = typeof r.pageSize === "number" ? r.pageSize : threads.length;
  if (!threads.length && total > 0) return { text: `No threads on page ${page}: there are ${total}, ${pageSize} to a page.` };
  if (!threads.length) return { text: "No threads yet: you have none of your own beyond this one, and you have not opened any on a teammate." };
  const first = (page - 1) * pageSize + 1;
  const last = first + threads.length - 1;
  const more = last < total ? `\n\nShowing ${first}-${last} of ${total}. For older ones call list_threads with page ${page + 1}.` : "";
  return { text: `Threads, newest first:\n${threads.map(threadLine).join("\n")}${more}` };
}
