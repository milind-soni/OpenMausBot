// The Inbox's bot and status filters for its conversation lists (Active Threads and Finished). Nothing is stored: the
// choice lasts while the panel is open.
import { attentionOwnerName, type AttentionThread } from "../SidebarBotActivity";

export type ThreadStatus = "working" | "waiting" | "finished";

export type ThreadOwner = { key: string; name: string };

/** No owner keeps every bot and room; no status keeps every status. */
export type ThreadFilter = { owner?: ThreadOwner; status?: ThreadStatus };

export function threadFilterOn(filter: ThreadFilter): boolean {
  return Boolean(filter.owner || filter.status);
}

export function threadOwnerKey(row: AttentionThread): string {
  return row.kind === "bot" ? `bot:${row.botId}` : `group:${row.groupId}`;
}

/** The same order the row's own status line uses (attentionRowStatus): waiting on the person or a teammate first, then
 * working or queued; anything else is finished, read or not. */
export function threadStatus(task: AttentionThread["task"]): ThreadStatus {
  if (task.activity === "waiting-on-you" || task.waitingForTeammates === true) return "waiting";
  if (task.busy === true || task.activity === "working" || task.queued === true) return "working";
  return "finished";
}

export function matchesThreadFilter(row: AttentionThread, filter: ThreadFilter): boolean {
  return (!filter.owner || threadOwnerKey(row) === filter.owner.key)
    && (!filter.status || threadStatus(row.task) === filter.status);
}

/** The bots and rooms that own any of these conversations, by name, plus the chosen one when none of its conversations
 * is left, so the picker always shows the choice in force. */
export function threadOwners(rows: readonly AttentionThread[], chosen?: ThreadOwner): ThreadOwner[] {
  const owners = new Map<string, string>();
  for (const row of rows) owners.set(threadOwnerKey(row), attentionOwnerName(row));
  if (chosen && !owners.has(chosen.key)) owners.set(chosen.key, chosen.name);
  return [...owners].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
}
