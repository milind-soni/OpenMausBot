// Which signed-in session sent each line, noted at the send route. On a Cloud home the desktop app lends its computer
// with the same session as its window (one cookie jar), so a line from that session was typed on that computer: the
// person's "my computer" is that one. Bound to the thread and the sendId, so no other line can borrow it. In memory on
// purpose: after a restart a line only loses the hint, and the bot asks as before.
const LIMIT = 2_000;
const sessions = new Map<string, string>();
const key = (threadId: string, sendId: string): string => `${threadId}\n${sendId}`;

/** The first send of a line names its session: a later send reusing that sendId is a conflict the route refuses, and
 * must not take over the hint of the line already queued. True when this call noted it. */
export function noteSendingSession(threadId: string, sendId: string, session: string): boolean {
  const at = key(threadId, sendId);
  if (sessions.has(at)) return false;
  sessions.set(at, session);
  if (sessions.size > LIMIT) sessions.delete(sessions.keys().next().value!);
  return true;
}

/** Drops the session a refused send noted, so an accepted retry of that line names its own. */
export function forgetSendingSession(threadId: string, sendId: string): void {
  sessions.delete(key(threadId, sendId));
}

/** The session that sent this line, when the send route noted one. */
export function sendingSession(threadId: string, sendId: string | undefined): string | undefined {
  return sendId === undefined ? undefined : sessions.get(key(threadId, sendId));
}
