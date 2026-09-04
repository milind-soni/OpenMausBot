// Bot⇄bot comms visibility: channel creation, message mirroring, and
// per-thread chips. Extracted from /api/internal/ask-bot so delegations
// (delegate_bot) and any future peer flow reuse the same UX without a copy.

import { sectionKey, type BotRecord, type GroupRecord, type Message, type Store } from "./store.ts";

/** What a peer-exchange helper needs from the outside world:
 * the store (for persisted messages + groups) and the SSE broadcasters
 * so chat clients see the change without waiting for a refresh. */
export interface CommsBus {
  store: Store;
  /** SSE broadcast (kind: "message" envelope). */
  broadcast: (payload: Record<string, unknown>) => void;
  /** SSE broadcast (kind: "group" envelope) for a single group. */
}

/** Find or create the channel for a peer exchange. When an originating
 * group is supplied and both bots are members, the exchange is mirrored
 * back into that group. Otherwise the pair's DM is used (creating it if
 * necessary) so 1:1-bot-thread delegations keep their historical fallback. */
export function getOrCreateChannel(
  store: Store,
  from: BotRecord,
  target: BotRecord,
  originatingGroup?: GroupRecord,
): GroupRecord {
  if (
    originatingGroup &&
    !originatingGroup.dm &&
    originatingGroup.memberIds.includes(from.id) &&
    originatingGroup.memberIds.includes(target.id)
  ) {
    return originatingGroup;
  }
  const existing = store.dmGroup(from.id, target.id);
  if (existing) {
    if (sectionKey(existing.section) !== sectionKey(from.section)) {
      return store.patchGroup(existing.id, { section: from.section }) ?? existing;
    }
    return existing;
  }
  return store.createGroup(`${from.name} ⇄ ${target.name}`, [from.id, target.id], true, from.section);
}

/** Whether this mirror is worth a badge, and the group frame either way.
 *
 * A pair channel is the bots' own coordination: the person asked ONE bot,
 * and the hops behind its answer are that bot's work, not mail addressed to
 * them. Badging every hop turned the sidebar, the dock and the phone into a
 * running commentary on chatter nobody asked to watch. What is NOT withheld
 * is the record — the messages and chips above are already written, and the
 * frame still goes out so the channel keeps its place in every client's
 * list. Hidden bot-to-bot talk is where a prompt injection would propagate
 * unobserved; silence the alert, never the record. A shared room is the
 * other case: people are reading it, so it badges as it always has. */
function markMirrored(bus: CommsBus, channel: GroupRecord, notify: boolean | undefined): void {
  const patch: Partial<Pick<GroupRecord, "unread">> = {};
  if (notify ?? !channel.dm) patch.unread = true;
  bus.store.patchGroup(channel.id, patch);
}

/** Mirror `from`'s outgoing message into the channel and drop chips into
 * both 1:1 threads linking to the channel. The chips are what make
 * bot-to-bot turns observable — those turns cost the user tokens, and a
 * hidden exchange is exactly the kind of mistake peer coordination is
 * supposed to avoid. `notify` decides only whether the channel also raises
 * a badge; it defaults to off for a bot⇄bot pair channel. */
export function mirrorExchange(
  bus: CommsBus,
  from: BotRecord,
  target: BotRecord,
  message: string,
  channel: GroupRecord | undefined,
  sourceThreadId = from.threadId,
  notify?: boolean,
): void {
  const note = (threadId: string, m: Omit<Message, "id" | "at">) => {
    bus.store.appendMessage(threadId, m);
    return message;
  };
  if (channel) {
    note(channel.threadId, {
      role: "bot",
      kind: "text",
      text: message,
      from: { botId: from.id, name: from.name, color: from.color },
    });
  }
  note(sourceThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Messaged @${target.name}` },
    comm: channel
      ? { groupId: channel.id, withBotId: target.id, withName: target.name, withColor: target.color }
      : undefined,
  });
  note(target.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Message from @${from.name}` },
    comm: channel
      ? { groupId: channel.id, withBotId: from.id, withName: from.name, withColor: from.color }
      : undefined,
  });
  if (channel) markMirrored(bus, channel, notify);
}

/** Mirror `target`'s reply into the channel so the channel stays the
 * single authoritative record of the exchange. The 1:1 threads already
 * carry their own chips from `mirrorExchange`. */
export function mirrorReply(
  bus: CommsBus,
  target: BotRecord,
  reply: string,
  channel: GroupRecord | undefined,
  notify?: boolean,
): void {
  if (!channel || !reply.trim()) return;
  bus.store.appendMessage(channel.threadId, {
    role: "bot",
    kind: "text",
    text: reply,
    from: { botId: target.id, name: target.name, color: target.color },
  });
  markMirrored(bus, channel, notify);
}

/** Mirror a terminal activity note into the channel — for async handoffs
 * whose terminal state is not a reply (turn failed, was stopped, or never
 * started). Prior art (A2A, MCP Tasks) is unanimous that every terminal
 * state of an async handoff should be visible where the human is looking,
 * and the channel is that place. */
export function mirrorActivity(
  bus: CommsBus,
  from: BotRecord,
  channel: GroupRecord | undefined,
  name: string,
  ok: boolean,
  notify?: boolean,
): void {
  if (!channel) return;
  bus.store.appendMessage(channel.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name, ok },
    from: { botId: from.id, name: from.name, color: from.color },
  });
  markMirrored(bus, channel, notify);
}
