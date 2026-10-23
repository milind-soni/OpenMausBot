import { DRAIN_COALESCE_MAX_ITEMS } from "../admission.ts";
import { digestPromptLine } from "../digest.ts";
import { escapeNotes, peerProvenanceNote, webhookPostNote } from "../peer-provenance.ts";
import { peerName } from "../peer-roster.ts";
import { roomReactionNote } from "../reactions.ts";
import { speakerOf, transcriptText, type PersonName } from "../replies.ts";
import { roomTurnNarrationIds } from "../room-reply.ts";
import type { Message, Store } from "../store.ts";

export const GROUP_CONTEXT_MESSAGES = DRAIN_COALESCE_MAX_ITEMS;

export interface RoomLine {
  id: string;
  text: string;
}

export interface RoomWindow {
  text: string;
  lines: RoomLine[];
  order: string[];
  readable: string[];
}

export function isRoomContextMessage(m: Pick<Message, "kind" | "text" | "digest" | "roomRequest">): boolean {
  return Boolean((m.kind === "text" && m.text) || (m.kind === "digest" && m.digest) || m.roomRequest?.phase === "result");
}

export interface RoomTranscriptDeps {
  store: Pick<Store, "messagesFor">;
  teammateReportContext(requestId: string, readerBotId?: string): string;
}

export function createRoomTranscript({ store, teammateReportContext }: RoomTranscriptDeps) {
  function window(
    threadId: string,
    userName: PersonName,
    textOverrides?: ReadonlyArray<{ messageId: string; text: string }>,
    readerBotId?: string,
  ): RoomWindow {
    const messages = store.messagesFor(threadId);
    const messagesById = new Map(messages.map((message) => [message.id, message]));
    const overrides = new Map(textOverrides?.map((override) => [override.messageId, override.text]));
    const narration = roomTurnNarrationIds(messages);
    const context = messages.filter(isRoomContextMessage);
    const readable = context.filter((m) => !narration.has(m.id));
    const shown = readable.slice(-GROUP_CONTEXT_MESSAGES);
    const texts = shown
      .map((m) => {
        if (m.kind === "digest" && m.digest) {
          return digestPromptLine(m.digest, m.from ? peerName(m.from.name) : "a bot");
        }
        if (m.roomRequest?.phase === "result") {
          return teammateReportContext(m.roomRequest.id, readerBotId);
        }
        const overridden = overrides.get(m.id);
        const rendered = overridden !== undefined ? { ...m, text: overridden } : m;
        const person = speakerOf(userName, m);
        const speaker = m.role === "user"
          ? m.via === "api" ? `${person} (sent through the local API, not typed)` : person
          : m.from ? peerName(m.from.name) : "Bot";
        const body = escapeNotes(transcriptText(rendered, messagesById, userName));
        // An outside app chose these words: the bot it is shown as reads the note too, and one JSON string cannot start a line of its own.
        if (m.webhookPost && m.role === "bot") return `${webhookPostNote(m.from?.name ?? "Bot")}\n${speaker}: ${JSON.stringify(body)}`;
        const line = `${speaker}: ${body}${roomReactionNote(m, userName)}`;
        if (!m.peerPost || !m.from || m.from.botId === readerBotId) return line;
        return `${peerProvenanceNote({ botName: m.from.name, delivery: "post_to_room", unattended: m.peerPost.unattended })}\n${line}`;
      });
    return {
      text: texts.join("\n"),
      lines: shown.map((m, index) => ({ id: m.id, text: texts[index]! })),
      order: context.map((m) => m.id),
      readable: readable.map((m) => m.id),
    };
  }

  return { window };
}
