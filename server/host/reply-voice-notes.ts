// "Voice note with every reply": the harness, not the model, speaks a settled reply in the bot's voice and attaches
// it the way a send_voice_note clip lands, so every engine gets it.
import type { AppConfig } from "../config.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import { serverLine, type ServerLineKey } from "../server-lines.ts";
import { speakable } from "../tts/speech-text.ts";

/** The longest note, the same bound send_voice_note keeps. */
export const VOICE_NOTE_MAX_CHARS = 1000;

/** A bot's own switch wins; without one it follows the installation's Voice setting. */
export function wantsReplyVoiceNote(bot: Pick<BotRecord, "voiceNoteEveryReply">, cfg: AppConfig): boolean {
  return bot.voiceNoteEveryReply ?? cfg.tts?.everyReply === true;
}

/** What the note says: the reply as speech, cut at the last sentence that fits, or at a word with an ellipsis. */
export function replyNoteWords(reply: string, max = VOICE_NOTE_MAX_CHARS): string {
  const text = speakable(reply);
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const sentence = Math.max(...[...head.matchAll(/[.!?。！？](?=\s|$)/gu)].map((match) => match.index! + 1), 0);
  if (sentence >= max / 2) return head.slice(0, sentence).trim();
  const word = head.lastIndexOf(" ");
  return `${(word >= max / 2 ? head.slice(0, word) : head).trim()}…`;
}

export interface ReplyVoiceNoteDeps {
  store: Pick<Store, "messagesFor" | "patchMessage" | "appendMessage">;
  config(): AppConfig;
  voiceReady(cfg: AppConfig, voice?: string): boolean;
  speak(cfg: AppConfig, text: string, voice?: string): Promise<{ bytes: Uint8Array | Buffer; mime: string }>;
  save(bytes: Buffer, mime: string): { path: string; mime: string };
  remove(path: string): void;
  redact(text: string): string;
  /** The language a line in this conversation is written in. */
  language(threadId: string): string | undefined;
}

export interface SettledTurn {
  bot: BotRecord;
  threadId: string;
  turnId: string | undefined;
  /** the person stopped it */
  stopped: boolean;
  /** a teammate's or the coordinator's turn, not one the person reads as a reply */
  internal: boolean;
}

const audio = (message: Message) => message.attachments?.some((file) => file.kind === "audio") === true;

export function createReplyVoiceNotes(deps: ReplyVoiceNoteDeps) {
  const told = new Set<string>();
  // Quiet and once per bot and cause: a missing voice must not add a line to every reply.
  const tellOnce = (bot: BotRecord, threadId: string, why: ServerLineKey, params?: Record<string, string>) => {
    const key = `${bot.id}:${why}`;
    if (told.has(key)) return;
    told.add(key);
    deps.store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${serverLine(deps.language(threadId), why, params)}`, ok: true } });
  };

  /** Resolves once the note is attached or skipped; never throws. */
  async function turnSettled(turn: SettledTurn): Promise<void> {
    const cfg = deps.config();
    if (!turn.turnId || turn.stopped || turn.internal || !wantsReplyVoiceNote(turn.bot, cfg)) return;
    const lines = deps.store.messagesFor(turn.threadId).filter((message) => message.role === "bot" && message.kind === "text" && message.turnId === turn.turnId);
    if (lines.some(audio)) return;
    const reply = lines.findLast((message) => message.turnTerminal) ?? lines.at(-1);
    const words = replyNoteWords(reply?.text ?? "");
    if (!reply || !words) return;
    if (!deps.voiceReady(cfg, turn.bot.voice)) return tellOnce(turn.bot, turn.threadId, "server.voice.noNoteNoVoice");
    let saved: { path: string; mime: string } | undefined;
    try {
      const spoken = await deps.speak(cfg, words, turn.bot.voice);
      saved = deps.save(Buffer.from(spoken.bytes), spoken.mime);
    } catch (error) {
      return tellOnce(turn.bot, turn.threadId, "server.voice.noNoteFailed", { reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    }
    const current = deps.store.messagesFor(turn.threadId).find((message) => message.id === reply.id);
    if (!current || audio(current)) return deps.remove(saved.path);
    deps.store.patchMessage(turn.threadId, reply.id, {
      attachments: [...(current.attachments ?? []), { kind: "audio", path: saved.path, mime: saved.mime, text: deps.redact(words) }],
    });
  }

  return { turnSettled };
}
