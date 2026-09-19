// The process-wide delta-context handoffs singleton — direct turns in
// flight and the handed-message records they settle, backed by the Store.
// Extracted verbatim from index.ts (the `new Handoffs({...})` wiring); the
// class and its store contract live in ./delta-context.ts, which stays
// importable by tests without booting the composition root.
import { Handoffs, isContextMessage } from "./delta-context.ts";
import { store } from "./runtime.ts";

export { isContextMessage };

export const handoffs = new Handoffs({
  order: (threadId) => store.activePath(threadId).filter(isContextMessage).map((m) => m.id),
  read: (botId, threadId, instanceId) => store.taskByThread(botId, threadId)?.handedMessages?.[instanceId],
  write: (botId, threadId, instanceId, state) => store.setHandedMessages(botId, threadId, instanceId, state),
  replies: (threadId, turnId) => store.activePath(threadId)
    .filter((m) => m.role === "bot" && m.kind === "text" && !m.from && m.turnId === turnId).map((m) => m.id),
});
