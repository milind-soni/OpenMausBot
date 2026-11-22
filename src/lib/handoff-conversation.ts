// What a hand-off's exchange view shows: the helper bot's thread as one conversation between two bots.
import { visibleMessages } from "@/state/snapshot-navigation";
import type { Message } from "@/state/store";
import { botLineText } from "./transcript-derivations";

export interface HandoffTranscript {
  messages: Message[];
  activeLeafId: string | null;
  loading: boolean;
  failed: boolean;
}

export type HandoffTranscriptAction =
  | { type: "loaded"; messages: Message[]; activeLeafId: string | null }
  | { type: "failed" }
  | { type: "reload" }
  | { type: "message"; message: Message; patch?: boolean }
  | { type: "active"; activeLeafId: string };

export const LOADING_TRANSCRIPT: HandoffTranscript = { messages: [], activeLeafId: null, loading: true, failed: false };

/** Lines that arrive live while the thread loads are kept: the loaded copy of a line never replaces a newer live one. */
export function handoffTranscript(state: HandoffTranscript, action: HandoffTranscriptAction): HandoffTranscript {
  switch (action.type) {
    case "loaded": {
      const live = new Map(state.messages.map((message) => [message.id, message]));
      const loaded = new Set(action.messages.map((message) => message.id));
      const newer = state.messages.filter((message) => !loaded.has(message.id));
      const messages = [...action.messages.map((message) => live.get(message.id) ?? message), ...newer];
      // A line that came in while loading and continues the branch moves it on, also when the loaded copy holds it.
      const activeLeafId = state.messages.reduce((leaf, message) => (message.parentId ?? null) === leaf ? message.id : leaf,
        state.activeLeafId ?? action.activeLeafId);
      return { messages, activeLeafId, loading: false, failed: false };
    }
    case "failed": return { ...state, loading: false, failed: true };
    // Only lines that arrive after this reload are newer than what it loads.
    case "reload": return { messages: [], activeLeafId: null, loading: true, failed: false };
    case "active": return { ...state, activeLeafId: action.activeLeafId };
    case "message": {
      const existing = state.messages.some((message) => message.id === action.message.id);
      // While loading, a change to a line not held yet is kept: the loaded copy may be older than it.
      if (!existing && action.patch && !state.loading) return state;
      const messages = existing
        ? state.messages.map((message) => message.id === action.message.id ? action.message : message)
        : [...state.messages, action.message];
      const continues = !existing && !state.loading && (action.message.parentId ?? null) === state.activeLeafId;
      return { ...state, messages, activeLeafId: continues ? action.message.id : state.activeLeafId };
    }
  }
}

export interface ConversationSpeaker {
  botId?: string;
  name: string;
  color?: string;
}

export interface ConversationRow {
  id: string;
  at: number;
  text: string;
  /** "asker": a bot that asked; "helper": the bot doing the work; "person": someone typing in the helper's thread. */
  side: "asker" | "helper" | "person";
  speaker: ConversationSpeaker;
}

type Named = ConversationSpeaker & { botId: string };

/** The written lines on the thread's shown branch, each with who said it. Tool steps and cards are left out. */
export function conversationRows(transcript: Pick<HandoffTranscript, "messages" | "activeLeafId">, asker: Named, helper: Named,
  personName: string): ConversationRow[] {
  const rows: ConversationRow[] = [];
  for (const message of visibleMessages(transcript)) {
    if (message.kind !== "text") continue;
    const text = message.role === "bot" ? botLineText(message) : message.text ?? "";
    if (!text.trim()) continue;
    rows.push({ id: message.id, at: message.at, text, ...speakerOf(message, asker, helper, personName) });
  }
  return rows;
}

function speakerOf(message: Message, asker: Named, helper: Named, personName: string): Pick<ConversationRow, "side" | "speaker"> {
  const bot = message.role === "user" ? message.peerAsk ?? message.from : message.from;
  if (bot?.botId === asker.botId) return { side: "asker", speaker: asker };
  if (bot && bot.botId !== helper.botId) {
    return { side: "asker", speaker: { botId: bot.botId, name: bot.name, color: "color" in bot ? bot.color : undefined } };
  }
  if (message.role === "bot") return { side: "helper", speaker: helper };
  return { side: "person", speaker: { name: personName } };
}
