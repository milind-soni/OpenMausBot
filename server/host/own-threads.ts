import type { ApprovalMode } from "../../shared/approval-mode.ts";

export const THREAD_ROLES = ["implementation", "research", "review", "design", "test", "general"] as const;
export type ThreadRole = (typeof THREAD_ROLES)[number];

export const isThreadRole = (value: unknown): value is ThreadRole => (THREAD_ROLES as readonly unknown[]).includes(value);

export function withRole(role: ThreadRole | undefined, message: string): string {
  return role ? `Act as the ${role} helper for this task.\n\n${message}` : message;
}

/** Custom is one provider's own rule set with no rank of its own; work handed on reads it as Auto. */
const RANK: Record<ApprovalMode, number> = { ask: 0, edits: 1, auto: 2, custom: 2, full: 3 };

/** Security invariant: a thread a bot opens on itself never runs at a broader level than the turn that opened it. */
export function ownThreadLevel(ceiling: ApprovalMode, own: ApprovalMode): ApprovalMode {
  if (own === ceiling || RANK[own] <= RANK[ceiling]) return own;
  return ceiling === "custom" ? "auto" : ceiling;
}

export const REQUEST_ID_MAX = 128;
const REMEMBERED = 500;

/** start_thread's request_id: the same opener asking again with the same id gets the thread it already opened. */
export function createOwnThreadRequests<T extends { threadId?: unknown }>() {
  const opened = new Map<string, T>();
  const key = (botId: string, fromThreadId: string, requestId: string) => JSON.stringify([botId, fromThreadId, requestId]);
  return {
    find(botId: string, fromThreadId: string, requestId: string, exists: (threadId: string) => boolean): T | undefined {
      const k = key(botId, fromThreadId, requestId);
      const found = opened.get(k);
      if (found && typeof found.threadId === "string" && exists(found.threadId)) return found;
      opened.delete(k);
      return undefined;
    },
    remember(botId: string, fromThreadId: string, requestId: string, body: T): void {
      opened.set(key(botId, fromThreadId, requestId), body);
      if (opened.size > REMEMBERED) opened.delete(opened.keys().next().value!);
    },
  };
}

export type OwnThreadRequests<T extends { threadId?: unknown }> = ReturnType<typeof createOwnThreadRequests<T>>;
