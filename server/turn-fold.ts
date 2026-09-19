// The turn fold's in-flight bookkeeping, extracted from index.ts. The two
// maps are module-level mutable singletons: every fold site, route, and
// helper that reads or writes them imports them from here, so the
// bookkeeping stays one table per server process. The fold body itself
// remains in index.ts — it closes over the store and provider registry.
// keyed by `${threadId}:${itemId}` / `${threadId}:${requestId}` — provider
// item/request ids are only unique within a thread, so two bots acting at
// once can collide on a bare id and patch each other's messages.
export const toolMessageByItem = new Map<string, string>(); // threadId:itemId -> messageId
export const askMessageByRequest = new Map<string, string>(); // threadId:requestId -> messageId

export function requestBehavior(value: unknown): "allow" | "deny" | "answer" | null {
  return value === "allow" || value === "deny" || value === "answer" ? value : null;
}
