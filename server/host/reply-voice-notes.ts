// "Voice note with every reply": the harness, not the model, speaks a settled reply in the bot's voice and attaches
// it the way a send_voice_note clip lands, so every engine gets it.
import { failedTurnCause } from "../../shared/failed-turn.ts";
import { lastNonReceipt } from "../../src/lib/receipts.ts";
import type { AppConfig } from "../config.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { TurnStop } from "../turn-outcome.ts";
import { serverLine, type ServerLineKey } from "../server-lines.ts";
import { speakable } from "../tts/speech-text.ts";
import { landTurnFiles } from "./turn-attachments.ts";

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

/** A turn that did not finish: what it said, then how it ended, which always fits whole. */
export function endedTurnNoteWords(reply: string, ending: string, max = VOICE_NOTE_MAX_CHARS): string {
  const how = replyNoteWords(ending, max);
  const said = how.length + 1 < max ? replyNoteWords(reply, max - how.length - 1) : "";
  return [said, how].filter(Boolean).join(" ");
}

export interface ReplyVoiceNoteDeps {
  store: Pick<Store, "messagesFor" | "activePath" | "patchMessage" | "appendMessage" | "insertMessageAfter">;
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
  /** the person pressed Stop */
  stoppedByPerson: boolean;
  /** How a turn that did not finish ended; absent when it finished. */
  ending?: {
    stop: TurnStop | undefined;
    /** the engine's error, or its stop reason in words */
    cause: string | undefined;
    /** stopped while it ran, by the harness or anything else */
    interrupted: boolean;
  };
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

  /** Why a turn ended unfinished, when the person should hear it: a turn the harness continues, or one stopped without
   * an error line (a new message from the person went first), ended on purpose. */
  const failureWords = ({ threadId, ending }: SettledTurn): string | undefined => {
    if (!ending || ending.stop?.handoffPath !== undefined) return undefined;
    if (ending.interrupted && failedTurnCause(lastNonReceipt(deps.store.activePath(threadId))?.tool?.name ?? "") === null) return undefined;
    return (ending.stop?.cause ?? ending.cause)?.trim().replace(/^error:\s*/i, "") || undefined;
  };

  /** Resolves once the note is attached or skipped; never throws. */
  async function turnSettled(turn: SettledTurn): Promise<void> {
    const cfg = deps.config();
    if (!turn.turnId || turn.stoppedByPerson || turn.internal || !wantsReplyVoiceNote(turn.bot, cfg)) return;
    const lines = () => deps.store.messagesFor(turn.threadId).filter((message) => message.role === "bot" && message.kind === "text" && message.turnId === turn.turnId);
    const said = lines();
    if (said.some(audio)) return;
    const reply = (said.findLast((message) => message.turnTerminal) ?? said.at(-1))?.text ?? "";
    const failure = failureWords(turn);
    const words = failure
      ? endedTurnNoteWords(reply, serverLine(deps.language(turn.threadId), "server.voice.turnEnded", { reason: deps.redact(failure) }))
      : replyNoteWords(reply);
    if (!words) return;
    if (!deps.voiceReady(cfg, turn.bot.voice)) return tellOnce(turn.bot, turn.threadId, "server.voice.noNoteNoVoice");
    let saved: { path: string; mime: string } | undefined;
    try {
      const spoken = await deps.speak(cfg, words, turn.bot.voice);
      saved = deps.save(Buffer.from(spoken.bytes), spoken.mime);
    } catch (error) {
      return tellOnce(turn.bot, turn.threadId, "server.voice.noNoteFailed", { reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    }
    if (lines().some(audio)) return deps.remove(saved.path);
    landTurnFiles(deps.store, { threadId: turn.threadId, turnId: turn.turnId }, [{ kind: "audio", path: saved.path, mime: saved.mime, text: deps.redact(words) }],
      (line) => deps.store.appendMessage(turn.threadId, line));
  }

  return { turnSettled };
}
