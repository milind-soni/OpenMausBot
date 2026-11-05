import { expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import type { BotRecord, Message } from "../store.ts";
import { createReplyVoiceNotes, replyNoteWords, wantsReplyVoiceNote, VOICE_NOTE_MAX_CHARS } from "./reply-voice-notes.ts";

it("follows the Voice setting unless the bot made its own choice", () => {
  const on = { tts: { everyReply: true } } as AppConfig;
  const off = {} as AppConfig;
  expect(wantsReplyVoiceNote({}, on)).toBe(true);
  expect(wantsReplyVoiceNote({}, off)).toBe(false);
  expect(wantsReplyVoiceNote({ voiceNoteEveryReply: false }, on)).toBe(false);
  expect(wantsReplyVoiceNote({ voiceNoteEveryReply: true }, off)).toBe(true);
});

it("speaks a long reply up to the last sentence that fits the note limit", () => {
  const sentence = "This sentence is exactly fifty characters long ok. ";
  const words = replyNoteWords(sentence.repeat(40));
  expect(words.length).toBeLessThanOrEqual(VOICE_NOTE_MAX_CHARS);
  expect(words.length).toBeGreaterThan(VOICE_NOTE_MAX_CHARS - sentence.length);
  expect(words.endsWith("ok.")).toBe(true);
  const unbroken = replyNoteWords("word ".repeat(400));
  expect(unbroken.length).toBeLessThanOrEqual(VOICE_NOTE_MAX_CHARS + 1);
  expect(unbroken.endsWith("word…")).toBe(true);
  expect(replyNoteWords("The **report** is [here](https://example.com).")).toBe("The report is here.");
});

function harness(messages: Message[], cfg: AppConfig = { tts: { everyReply: true } } as AppConfig) {
  const appended: Array<Omit<Message, "id" | "at">> = [];
  const deps = {
    store: {
      messagesFor: () => messages,
      patchMessage: vi.fn((_thread: string, id: string, patch: Partial<Message>) => { Object.assign(messages.find((m) => m.id === id)!, patch); return null; }),
      appendMessage: vi.fn((_thread: string, message: Omit<Message, "id" | "at">) => { appended.push(message); return message as Message; }),
    },
    config: () => cfg,
    voiceReady: vi.fn(() => true),
    speak: vi.fn(async () => ({ bytes: Buffer.from("mp3"), mime: "audio/mpeg" })),
    save: vi.fn(() => ({ path: "/a/note.mp3", mime: "audio/mpeg" })),
    remove: vi.fn(),
    redact: (text: string) => text,
    language: () => undefined,
  };
  return { deps, appended, notes: createReplyVoiceNotes(deps as any) };
}

const bot = { id: "b1", name: "Bot" } as BotRecord;
const reply = (text: string, extra: Partial<Message> = {}): Message => ({ id: "m1", at: 1, role: "bot", kind: "text", text, turnId: "t1", turnTerminal: true, ...extra });

it("skips a stopped, internal or note-carrying turn and an empty reply", async () => {
  for (const [turn, messages] of [
    [{ stopped: true, internal: false }, [reply("Hi.")]],
    [{ stopped: false, internal: true }, [reply("Hi.")]],
    [{ stopped: false, internal: false }, [reply("Hi.", { attachments: [{ kind: "audio", path: "/a/own.mp3", mime: "audio/mpeg" }] })]],
    [{ stopped: false, internal: false }, [reply("  ")]],
  ] as const) {
    const { deps, notes } = harness([...messages] as Message[]);
    await notes.turnSettled({ bot, threadId: "th", turnId: "t1", ...turn });
    expect(deps.speak).not.toHaveBeenCalled();
  }
});

it("attaches the spoken reply to the turn's last line, words as its transcript", async () => {
  const messages = [reply("Hi there.")];
  const { deps, notes } = harness(messages);
  await notes.turnSettled({ bot, threadId: "th", turnId: "t1", stopped: false, internal: false });
  expect(deps.speak).toHaveBeenCalledWith(expect.anything(), "Hi there.", undefined);
  expect(messages[0]!.attachments).toEqual([{ kind: "audio", path: "/a/note.mp3", mime: "audio/mpeg", text: "Hi there." }]);
});

it("tells once, quietly, when the bot has no voice to speak with", async () => {
  const { deps, appended, notes } = harness([reply("Hi.")]);
  deps.voiceReady.mockReturnValue(false);
  await notes.turnSettled({ bot, threadId: "th", turnId: "t1", stopped: false, internal: false });
  await notes.turnSettled({ bot, threadId: "th", turnId: "t1", stopped: false, internal: false });
  expect(appended).toHaveLength(1);
  expect(appended[0]!.tool?.name).toMatch(/^notice: /);
  expect(deps.speak).not.toHaveBeenCalled();
});
