// What, of what reaches a Team Cloud person, is worth an email while they are away (team-away.ts), and the
// names that email may carry. Security invariant: a private chat's event names no bot and no place, and nothing here
// reads a message's words.
import { liveCardKind } from "../../shared/live-approval.ts";
import type { Notification, NotifyKind } from "../../shared/notification.ts";
import { audienceMember, type Audience } from "../audience.ts";
import type { AwayEvent, AwayKind } from "./team-away.ts";
import type { Store } from "../store.ts";
import type { Delivery, Item } from "./person-inbox.ts";

const WAITING: ReadonlySet<NotifyKind> = new Set(["approval", "question", "sign-in", "secret"]);
const INBOX_KINDS: Partial<Record<NotifyKind, { kind: AwayKind; routine?: true }>> = {
  approval: { kind: "waiting" }, question: { kind: "waiting" }, "sign-in": { kind: "waiting" }, secret: { kind: "waiting" },
  mention: { kind: "mention" }, done: { kind: "finished", routine: true }, "routine-failed": { kind: "failed", routine: true },
};

export interface TeamAwayEventsDeps {
  audienceOf(threadId: string): Audience;
  store: Pick<Store, "bot" | "groupByThread" | "activePath" | "messagesFor">;
  /** The lines in this person's inbox they have not opened and that still wait on them. */
  unseen(person: string): readonly { id: string }[];
  /** A bot replied in this shared conversation after where this person has read it up to. */
  unread?(person: string, threadId: string, groupId?: string): boolean;
  noticed(event: AwayEvent): void;
}

export function createTeamAwayEvents(deps: TeamAwayEventsDeps) {
  const shared = (threadId: string) => audienceMember(deps.audienceOf(threadId)) === null;
  const groupName = (threadId: string, groupId?: string) => (groupId ? deps.store.groupByThread(threadId)?.name : undefined);
  const openCard = (threadId: string, requestId?: string) => deps.store.messagesFor(threadId)
    .findLast((message) => !message.inbox && liveCardKind(message.card) !== null && (!requestId || message.card?.requestId === requestId));

  /** A line reached a person's inbox. */
  function delivered(item: Item, delivery: Delivery): void {
    const mapped = INBOX_KINDS[delivery.notify];
    if (!mapped || delivery.assistant) return;
    const origin = delivery.origin;
    const open = origin ? shared(origin.threadId) : false;
    const still = () => deps.unseen(item.person).some((one) => one.id === item.id);
    const about = mapped.kind === "waiting" && origin && delivery.card?.requestId ? `ask:${origin.threadId}:${delivery.card.requestId}` : `inbox:${item.id}`;
    const conversation = mapped.routine && origin ? origin.threadId : undefined;
    const thread = !mapped.routine && origin ? origin.threadId : undefined;
    const base = { person: item.person, about, still, ...(conversation ? { conversation } : {}), ...(thread ? { thread } : {}) };
    if (!open) {
      if (mapped.kind === "mention") {
        if (delivery.from.email) deps.noticed({ ...base, item: { kind: "mention", who: delivery.from.name, private: true } });
        return;
      }
      deps.noticed({ ...base, item: { kind: mapped.kind, private: true, ...(mapped.routine ? { routine: true } : {}) } });
      return;
    }
    const place = groupName(origin!.threadId, origin!.groupId) ?? deps.store.bot(origin!.botId)?.name;
    const named = place && place !== delivery.from.name ? { place } : {};
    deps.noticed({ ...base, item: { kind: mapped.kind, who: delivery.from.name, ...named, ...(mapped.routine ? { routine: true } : {}) } });
  }

  /** A notification went out as it is, past the inbox: a question in the person's own private chat, or a reply to what
   * someone asked in a shared place. */
  function notified(original: Notification, routed: Notification | null, how: { routine?: boolean } = {}): void {
    if (!routed || routed.forPerson || original.forPerson || how.routine) return;
    const { threadId } = original;
    const own = audienceMember(deps.audienceOf(threadId));
    if (WAITING.has(original.kind)) {
      const card = own ? openCard(threadId) : undefined;
      const requestId = card?.card?.requestId;
      if (!own || !requestId) return;
      deps.noticed({ person: own, item: { kind: "waiting", private: true }, about: `ask:${threadId}:${requestId}`, thread: threadId, still: () => openCard(threadId, requestId) !== undefined });
      return;
    }
    if ((original.kind !== "done" && original.kind !== "turn-failed") || own) return;
    const asked = deps.store.activePath(threadId).findLast((message) => message.role === "user" && !message.peerAsk && message.sender?.id);
    const person = asked?.sender?.id;
    if (!asked || !person) return;
    const group = groupName(threadId, original.groupId), { groupId } = original;
    deps.noticed({
      person, about: `${original.kind}:${threadId}:${asked.id}`, conversation: threadId,
      ...(deps.unread ? { still: () => deps.unread!(person, threadId, groupId) } : {}),
      item: { kind: original.kind === "done" ? "finished" : "failed", who: original.botName, ...(group ? { place: group } : {}) },
    });
  }

  return { delivered, notified };
}

export type TeamAwayEvents = ReturnType<typeof createTeamAwayEvents>;
