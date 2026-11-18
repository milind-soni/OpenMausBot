import { expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import type { BotRecord, Message } from "../store.ts";
import { failedTurnTool } from "../../shared/failed-turn.ts";
import { createReplyVoiceNotes, endedTurnNoteWords, replyNoteWords, wantsReplyVoiceNote, VOICE_NOTE_MAX_CHARS } from "./reply-voice-notes.ts";

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
      activePath: () => messages,
      insertMessageAfter: vi.fn((_thread: string, after: string | undefined, message: Omit<Message, "id" | "at">) => {
        const at = messages.findIndex((m) => m.id === after) + 1;
        messages.splice(at, 0, { id: `inserted${at}`, at: 0, ...message } as Message);
        return messages[at]!;
      }),
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

it("skips a turn the person stopped, an internal or note-carrying turn and an empty reply", async () => {
  for (const [turn, messages] of [
    [{ stoppedByPerson: true, internal: false, ending: { stop: undefined, cause: "stopped", interrupted: true } }, [reply("Hi.")]],
    [{ stoppedByPerson: false, internal: true }, [reply("Hi.")]],
    [{ stoppedByPerson: false, internal: false, ending: { stop: undefined, cause: "the step crashed", interrupted: false } }, [reply("Hi.", { attachments: [{ kind: "audio", path: "/a/own.mp3", mime: "audio/mpeg" }] })]],
    [{ stoppedByPerson: false, internal: false }, [reply("  ")]],
  ] as const) {
    const { deps, notes } = harness([...messages] as Message[]);
    await notes.turnSettled({ bot, threadId: "th", turnId: "t1", ...turn });
    expect(deps.speak).not.toHaveBeenCalled();
  }
});

it("attaches the spoken reply to the turn's last line, words as its transcript", async () => {
  const messages = [reply("Hi there.")];
  const { deps, notes } = harness(messages);
  await notes.turnSettled({ bot, threadId: "th", turnId: "t1", stoppedByPerson: false, internal: false });
  expect(deps.speak).toHaveBeenCalledWith(expect.anything(), "Hi there.", undefined);
  expect(messages[0]!.attachments).toEqual([{ kind: "audio", path: "/a/note.mp3", mime: "audio/mpeg", text: "Hi there." }]);
});

it("tells once, quietly, when the bot has no voice to speak with", async () => {
  const { deps, appended, notes } = harness([reply("Hi.")]);
  deps.voiceReady.mockReturnValue(false);
  await notes.turnSettled({ bot, threadId: "th", turnId: "t1", stoppedByPerson: false, internal: false });
  await notes.turnSettled({ bot, threadId: "th", turnId: "t1", stoppedByPerson: false, internal: false });
  expect(appended).toHaveLength(1);
  expect(appended[0]!.tool?.name).toMatch(/^notice: /);
  expect(deps.speak).not.toHaveBeenCalled();
});

it("speaks how a failed or harness-stopped turn ended, from its error, on a line above that error", async () => {
  const messages: Message[] = [
    { id: "u1", at: 0, role: "user", kind: "text", text: "Go." },
    { id: "e1", at: 2, role: "bot", kind: "activity", tool: failedTurnTool("the same call failed 10 times in a row — the turn was stopped") },
  ];
  const { deps, notes } = harness(messages);
  const stop = { turnId: "t1", cause: "the same call failed 10 times in a row — the turn was stopped" };
  await notes.turnSettled({ bot, threadId: "th", turnId: "t1", stoppedByPerson: false, internal: false, ending: { stop, cause: "interrupted", interrupted: true } });
  const words = "I stopped before finishing: the same call failed 10 times in a row — the turn was stopped";
  expect(deps.speak).toHaveBeenCalledWith(expect.anything(), words, undefined);
  expect(messages.map((m) => m.id)).toEqual(["u1", "inserted1", "e1"]);
  expect(messages[1]).toMatchObject({ role: "bot", kind: "text", text: "", turnId: "t1", attachments: [{ kind: "audio", path: "/a/note.mp3", mime: "audio/mpeg", text: words }] });
});

it("speaks a failed turn's progress first and its ending whole", async () => {
  const messages = [reply("Half the export is done.")];
  const { deps, notes } = harness(messages);
  await notes.turnSettled({ bot, threadId: "th", turnId: "t1", stoppedByPerson: false, internal: false, ending: { stop: undefined, cause: "Error: the export step crashed", interrupted: false } });
  expect(deps.speak).toHaveBeenCalledWith(expect.anything(), "Half the export is done. I stopped before finishing: the export step crashed", undefined);
  expect(messages[0]!.attachments).toHaveLength(1);
  const ending = "I stopped before finishing: it broke.";
  const long = endedTurnNoteWords("word ".repeat(400), ending);
  expect(long.length).toBeLessThanOrEqual(VOICE_NOTE_MAX_CHARS);
  expect(long.endsWith(ending)).toBe(true);
});

it("stays quiet about a turn the harness continues, and about one stopped without an error line, and speaks its reply", async () => {
  for (const ending of [
    { stop: { handoffPath: "/h/next.json", error: "out of steps" }, cause: "out of steps", interrupted: false },
    { stop: { cause: "your new message went first" }, cause: "interrupted", interrupted: true },
  ]) {
    const { deps, notes } = harness([reply("Working on it.")]);
    await notes.turnSettled({ bot, threadId: "th", turnId: "t1", stoppedByPerson: false, internal: false, ending });
    expect(deps.speak).toHaveBeenCalledWith(expect.anything(), "Working on it.", undefined);
  }
});
