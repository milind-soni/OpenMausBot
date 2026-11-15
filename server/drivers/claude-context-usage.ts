// Claude Code counts its own context window by category: {type:"control_request", request:{subtype:"get_context_usage"}}
// on stdin is answered by a control_response (2.1.325). With detail "summary" it answers from the last response's usage
// and local estimates and makes no token-count call. A CLI that does not know the request answers subtype "error".
import type { Writable } from "node:stream";
import type { ContextBreakdown } from "../../shared/context-breakdown.ts";

const ID_PREFIX = "context-usage-";
const tokens = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;

/** Rows marked deferred are tool schemas kept out of the window, so they are left out. */
export function claudeContextBreakdown(response: any): ContextBreakdown | null {
  const used = tokens(response?.totalTokens);
  const window = tokens(response?.maxTokens);
  if (used === null || !window || !Array.isArray(response.categories)) return null;
  const categories: ContextBreakdown["categories"] = [];
  for (const row of response.categories) {
    const count = tokens(row?.tokens);
    if (row?.kind === "deferred" || row?.isDeferred === true) continue;
    if (typeof row?.id !== "string" || count === null || (row.kind !== "used" && row.kind !== "buffer" && row.kind !== "free")) return null;
    categories.push({ id: row.id, kind: row.kind, tokens: count });
  }
  if (!categories.length) return null;
  const parts = response.messageBreakdown;
  const messages = parts && typeof parts === "object" ? {
    toolCalls: tokens(parts.toolCallTokens), toolResults: tokens(parts.toolResultTokens), attachments: tokens(parts.attachmentTokens),
    assistant: tokens(parts.assistantMessageTokens), user: tokens(parts.userMessageTokens),
  } : null;
  const autoCompactAt = tokens(response.autoCompactThreshold);
  return {
    tokens: used, window, categories,
    ...(messages && Object.values(messages).every((value) => value !== null) ? { messages: messages as ContextBreakdown["messages"] } : {}),
    ...(typeof response.isAutoCompactEnabled === "boolean" ? { autoCompact: response.isAutoCompactEnabled } : {}),
    ...(response.isAutoCompactEnabled === true && autoCompactAt ? { autoCompactAt } : {}),
  };
}

/** `write` settles true once the frame reached the CLI's stdin, false when it could not be sent. */
export function claudeContextUsage(write: (frame: unknown) => Promise<boolean>) {
  const pending = new Map<string, (breakdown: ContextBreakdown | null) => void>();
  let sent = 0;
  const settle = (id: string, breakdown: ContextBreakdown | null) => {
    const resolve = pending.get(id);
    pending.delete(id);
    resolve?.(breakdown);
  };
  return {
    /** Consumes every answer to its own requests, one nobody waits for any more included, so the driver neither reads
     * nor logs it: a context read leaves nothing on disk. False for every other frame. */
    frame(o: any): boolean {
      const id = o?.type === "control_response" ? o.response?.request_id : undefined;
      if (typeof id !== "string" || !id.startsWith(ID_PREFIX)) return false;
      if (pending.has(id)) settle(id, o.response.subtype === "success" ? claudeContextBreakdown(o.response.response) : null);
      return true;
    },
    /** null when the CLI has no answer: it does not know the request, it exited, or `signal` gave up waiting. */
    read(signal?: AbortSignal): Promise<ContextBreakdown | null> {
      if (signal?.aborted) return Promise.resolve(null);
      const id = `${ID_PREFIX}${++sent}`;
      return new Promise((resolve) => {
        const giveUp = () => settle(id, null);
        pending.set(id, (breakdown) => { signal?.removeEventListener("abort", giveUp); resolve(breakdown); });
        signal?.addEventListener("abort", giveUp, { once: true });
        void write({ type: "control_request", request_id: id, request: { subtype: "get_context_usage", detail: "summary" } })
          .then((delivered) => { if (!delivered) settle(id, null); });
      });
    },
    close(): void {
      for (const id of pending.keys()) settle(id, null);
    },
  };
}

/** A CLI that already exited needs no answer: the write is skipped, like the driver's writeUser. */
export function writeControlFrame(stdin: Writable, frame: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    if (!stdin.writable || stdin.destroyed) return resolve(false);
    try { stdin.write(`${JSON.stringify(frame)}\n`, (err) => resolve(!err)); } catch { resolve(false); }
  });
}

type LiveSession = { closing: boolean; child: { exitCode: number | null }; context: Pick<ReturnType<typeof claudeContextUsage>, "read"> };

/** A session that is closing or whose CLI exited has nobody left to ask. */
export async function liveContextBreakdown(session: LiveSession | undefined, signal?: AbortSignal): Promise<ContextBreakdown | null> {
  return session && !session.closing && session.child.exitCode === null ? session.context.read(signal) : null;
}
