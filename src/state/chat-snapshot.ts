import { api, snapshotArrays } from "./api";
import { noteSnapshotTails } from "./held-tails";
import { MESSAGE_PAGE_SIZE, shortHeld } from "./message-history";
import { hydratedSelectedId } from "./snapshot-navigation";
import type { Action, AppState, Bot, Group, Message } from "./store";

/** The fewest rows the first snapshot carries of a conversation nobody has open; the server reaches back further when
 * the sidebar, the unread divider or the team map reads an older line. */
export const SNAPSHOT_TAIL = 20;

type ThreadPage = { messages: Message[]; hasMore?: boolean; activeLeafId?: string | null };
type Hydrate = Extract<Action, { type: "hydrate" }>;
export type ChatSnapshot = { bots: Bot[]; groups?: Group[]; sections?: string[]; computerControl?: Hydrate["computerControl"]; botQueuedMessages?: Hydrate["botQueuedMessages"] };
type Read = <T>(path: string) => Promise<T>;

/**
 * Every bot and room, with one page of the conversations that may open and a tail of the others. The conversation the
 * snapshot will open on (or the one open by the time it lands) gets its whole page before it is applied; when that page
 * cannot be read, the tail is applied and paged back once the snapshot lands.
 */
export async function readChatSnapshot(current: () => Pick<AppState, "selectedId">, resumeId: string | undefined, read: Read = api): Promise<ChatSnapshot> {
  const open = [...new Set([current().selectedId, resumeId ?? ""].filter(Boolean))].map(encodeURIComponent).join(",");
  const snapshot = snapshotArrays(await read<ChatSnapshot>(`/api/bots?messages=${MESSAGE_PAGE_SIZE}&tail=${SNAPSHOT_TAIL}${open ? `&open=${open}` : ""}`), "bots");
  const filled = new Set<string>();
  for (;;) {
    const id = hydratedSelectedId(current().selectedId, snapshot.bots, snapshot.groups ?? [], resumeId);
    const owner = snapshot.bots.find((bot) => bot.id === id);
    if (!shortHeld(owner) || filled.has(owner.threadId)) break;
    filled.add(owner.threadId);
    const page = await read<ThreadPage>(`/api/threads/${encodeURIComponent(owner.threadId)}/messages?limit=${MESSAGE_PAGE_SIZE}`).catch(() => null);
    if (!page) break;
    snapshot.bots = snapshot.bots.map((bot) => bot.id === owner.id && bot.threadId === owner.threadId
      ? { ...bot, messages: page.messages, hasMore: Boolean(page.hasMore), ...(page.activeLeafId !== undefined ? { activeLeafId: page.activeLeafId } : {}) }
      : bot);
  }
  noteSnapshotTails(snapshot.bots.filter((bot) => shortHeld(bot)));
  return snapshot;
}
