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
