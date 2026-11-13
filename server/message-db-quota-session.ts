import { prepared } from "./message-db.ts";

/** Server-only provenance for a request that may be resent from a durable quota card. A null session is intentional. */
export function setQuotaRequestSession(threadId: string, messageId: string, sessionId: string | undefined): void {
  prepared("INSERT INTO quota_request_sessions (thread_id, message_id, session_id) VALUES (?, ?, ?) ON CONFLICT(thread_id, message_id) DO UPDATE SET session_id = excluded.session_id")
    .run(threadId, messageId, sessionId ?? null);
}

/** Undefined means provenance was never recorded; a present null session is an intentionally unbound request. */
export function quotaRequestSession(threadId: string, messageId: string): { requestSessionId?: string } | undefined {
  const row = prepared("SELECT session_id FROM quota_request_sessions WHERE thread_id = ? AND message_id = ?")
    .get(threadId, messageId) as { session_id: string | null } | undefined;
  return row ? row.session_id === null ? {} : { requestSessionId: row.session_id } : undefined;
}

export function forgetQuotaRequestSession(threadId: string, messageId: string): void {
  prepared("DELETE FROM quota_request_sessions WHERE thread_id = ? AND message_id = ?").run(threadId, messageId);
}
