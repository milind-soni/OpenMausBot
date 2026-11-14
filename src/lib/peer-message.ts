// Peers' words arrive as user-role lines; keyed on role alone they would read as the person's own.
import type { WireMessage as Message } from "../../shared/wire.ts";

export type PeerDelivery = "ask_bot" | "delegate_bot" | "start_thread" | "coordinate_bots";

export interface PeerLine {
  botId?: string;
  name: string;
  delivery: PeerDelivery;
  body: string;
  unattended?: boolean;
}

/** The one note, `[From @X (bot) · message | assignment · …]`, and the openings rows stored before it carry. */
const PROVENANCE_NOTE =
  /^\[(?:From @([^·\]]+?) \(bot\) · (message|assignment) · |(Message from|Delegated by|Thread opened by) @([^,\]]+), another bot in this OpenMausBot workspace)[^\]]*\]\s*/;

const DELIVERY: Record<string, PeerDelivery> = {
  message: "ask_bot",
  assignment: "delegate_bot",
  "Message from": "ask_bot",
  "Delegated by": "delegate_bot",
  "Thread opened by": "start_thread",
};

export function peerLine(message: Pick<Message, "role" | "text" | "peerAsk">): PeerLine | null {
  if (message.role !== "user") return null;
  const text = message.text ?? "";
  const note = PROVENANCE_NOTE.exec(text);
  const name = message.peerAsk?.name ?? (note?.[1] ?? note?.[4])?.trim();
  if (!name) return null;
  return {
    botId: message.peerAsk?.botId,
    name,
    delivery: (note && DELIVERY[note[2] ?? note[3] ?? ""]) || "ask_bot",
    body: note ? text.slice(note[0].length) : text,
    ...(message.peerAsk?.unattended ? { unattended: true } : {}),
  };
}

export function peerRequest(
  message: Pick<Message, "role" | "text" | "from" | "roomRequest">,
  threadBotId: string,
): PeerLine | null {
  if (message.role !== "bot" || message.roomRequest?.phase !== "request") return null;
  const from = message.from;
  if (!from?.name || from.botId === threadBotId) return null;
  return { botId: from.botId, name: from.name, delivery: "coordinate_bots", body: message.text ?? "" };
}

const COMPACT_CHARS = 160;
const COMPACT_LINES = 3;
const PREVIEW_CHARS = 240;

/** A long request from another bot folds to one line until opened. Null when it already fits on one. */
export function peerPreview(body: string): string | null {
  const text = body.trim();
  if (text.length <= COMPACT_CHARS && text.split("\n").length <= COMPACT_LINES) return null;
  const flat = text.replace(/\s+/g, " ");
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS).trimEnd()}…` : flat;
}

export interface ExchangeLine {
  id: string;
  from: "peer" | "bot";
  text: string;
  at: number;
}

type ExchangeMessage = Pick<Message, "id" | "role" | "kind" | "text" | "at" | "peerAsk" | "from" | "roomRequest" | "requestMessageId">;

/** One peer's requests in this thread and the bot's written answers to each, for the side view. */
export function peerExchange(
  messages: readonly ExchangeMessage[],
  threadBotId: string,
  peer: Pick<PeerLine, "botId" | "name">,
): ExchangeLine[] {
  const lines: ExchangeLine[] = [];
  let answering = false;
  const asked = new Set<string>();
  for (const m of messages) {
    const from = peerLine(m) ?? peerRequest(m, threadBotId);
    if (from) {
      answering = peer.botId && from.botId ? from.botId === peer.botId : from.name === peer.name;
      if (answering) {
        asked.add(m.id);
        lines.push({ id: m.id, from: "peer", text: from.body, at: m.at });
      }
    } else if (m.role === "user") {
      answering = false;
    } else if (
      m.role === "bot" && m.kind === "text" && m.text?.trim() &&
      // Another room member's reply is not this bot's answer; a reply names its request when it can.
      (!m.from || m.from.botId === threadBotId) &&
      (m.requestMessageId ? asked.has(m.requestMessageId) : answering)
    ) {
      lines.push({ id: m.id, from: "bot", text: m.text, at: m.at });
    }
  }
  return lines;
}
