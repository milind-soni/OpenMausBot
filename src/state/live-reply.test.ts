import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../../shared/runtime-events";
import {
  forgetLiveReplies,
  hasLiveReply,
  liveReplies,
  liveReplyRows,
  liveReplyText,
  noteLiveReplyEvent,
  noteLiveReplyMessage,
  resetLiveReplies,
  roomLiveSpeaker,
  settleLiveReplies,
  stopLiveReply,
  streamedReply,
  withLiveRows,
} from "./live-reply";
import type { Message } from "@/state/store";

let seq = 0;
const frame = (event: Partial<RuntimeEvent>, threadId = "t"): RuntimeEvent =>
  ({ eventId: `e${++seq}`, provider: "claudeAgent", threadId, createdAt: "2026-11-11T12:00:00.000Z", turnId: "turn-1", ...event } as RuntimeEvent);
const note = (event: Partial<RuntimeEvent>, threadId = "t") => {
  const sent = frame(event, threadId);
  noteLiveReplyEvent(sent);
  return sent;
};
const delta = (text: string, threadId = "t", extra: Partial<RuntimeEvent> = {}) =>
  note({ type: "content.delta", streamKind: "assistant_text", delta: text, ...extra } as Partial<RuntimeEvent>, threadId);
const complete = (text: string, threadId = "t") =>
  note({ type: "item.completed", itemType: "assistant_text", text } as Partial<RuntimeEvent>, threadId);
const shown = (threadId = "t", transcript: { id: string }[] = []) =>
  liveReplyRows(liveReplies(threadId), transcript).rows.map((row) => row.text);

afterEach(() => resetLiveReplies());

// Frames with no item id are what a server older than item ids sends (a Cloud not yet updated).
describe("a reply as it streams from an older server", () => {
  it("grows with each delta of the bot's words, and leaves reasoning out", () => {
    note({ type: "turn.started" });
    delta("Here is ");
    note({ type: "content.delta", streamKind: "reasoning_text", delta: "thinking hard" } as Partial<RuntimeEvent>);
    delta("the plan for ");
    expect(shown()).toEqual(["Here is the plan for "]);
    delta("today.");
    expect(liveReplies("t")).toHaveLength(1);
    expect(liveReplies("t")[0]!.text).toBe("Here is the plan for today.");
    expect(shown(), "the unfinished last word waits").toEqual(["Here is the plan for "]);
  });

  it("keeps each thread's reply its own", () => {
    delta("one ", "a");
    delta("two ", "b");
    expect(shown("a")).toEqual(["one "]);
    expect(shown("b")).toEqual(["two "]);
    expect(shown("c")).toEqual([]);
  });

  it("stays drawn after the engine finishes until the transcript holds its saved message, then gives way", () => {
    delta("All done ");
    complete("All done here.");
    expect(shown(), "finished: the whole text").toEqual(["All done here."]);
    noteLiveReplyMessage("t", { id: "m1", role: "bot", kind: "text", turnId: "turn-1" });
    expect(liveReplies("t")[0]!.savedAs).toBe("m1");
    expect(shown("t", []), "the frame arrived but the transcript has not drawn it yet").toEqual(["All done here."]);
    const { rows, settled } = liveReplyRows(liveReplies("t"), [{ id: "m1" }]);
    expect(rows, "never both at once").toEqual([]);
    settleLiveReplies("t", settled);
    expect(liveReplies("t")).toEqual([]);
    expect(streamedReply("m1"), "the saved bubble does not play in again").toBe(true);
    expect(streamedReply("m2")).toBe(false);
  });

  it("holds a finished item while the next one streams, each swapped by its own message", () => {
    delta("First part. ");
    complete("First part.");
    noteLiveReplyMessage("t", { id: "m1", role: "bot", kind: "text", turnId: "turn-1" });
    note({ type: "item.started", itemType: "tool", itemId: "x", title: "Bash" } as Partial<RuntimeEvent>);
    delta("Second part ");
    expect(shown()).toEqual(["First part.", "Second part "]);
    expect(shown("t", [{ id: "m1" }])).toEqual(["Second part "]);
  });

  it("ignores a frame it has already seen, so a resumed stream never doubles the text", () => {
    const first = delta("Hello ");
    const second = delta("there ");
    noteLiveReplyEvent(first);
    noteLiveReplyEvent(second);
    expect(liveReplies("t")[0]!.text).toBe("Hello there ");
    const done = complete("Hello there");
    noteLiveReplyMessage("t", { id: "m1", role: "bot", kind: "text", turnId: "turn-1" });
    noteLiveReplyEvent(done);
    noteLiveReplyMessage("t", { id: "m1", role: "bot", kind: "text", turnId: "turn-1" });
    expect(liveReplies("t")).toHaveLength(1);
    expect(liveReplies("t")[0]!.savedAs).toBe("m1");
  });

  it("drops a reply that never got saved when the turn ends, fails or is stopped", () => {
    delta("Partial answer ");
    note({ type: "turn.completed", ok: false } as Partial<RuntimeEvent>);
    expect(liveReplies("t")).toEqual([]);

    delta("Another try ");
    note({ type: "runtime.error", message: "boom", terminal: true } as Partial<RuntimeEvent>);
    expect(liveReplies("t")).toEqual([]);

    delta("A third ");
    note({ type: "runtime.error", message: "a warning" } as Partial<RuntimeEvent>);
    expect(shown(), "a passing warning is no end").toEqual(["A third "]);

    stopLiveReply("t");
    expect(shown(), "what streamed before Stop stays, as an engine may keep it").toEqual(["A third "]);
    delta("late words ");
    expect(shown(), "the rest of a stopped item is not drawn").toEqual(["A third "]);
    note({ type: "turn.completed", ok: false } as Partial<RuntimeEvent>);
    expect(liveReplies("t"), "not kept: the turn's end removes it").toEqual([]);
    note({ type: "turn.started" });
    delta("Fresh ");
    expect(shown()).toEqual(["Fresh "]);
  });

  it("keeps a saved item through the turn's end until the transcript draws it", () => {
    delta("Answer ");
    complete("Answer");
    noteLiveReplyMessage("t", { id: "m1", role: "bot", kind: "text", turnId: "turn-1" });
    note({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    expect(shown()).toEqual(["Answer"]);
  });

  it("drops a finished item the server never saved (a hidden or stopped reply) at the turn's end", () => {
    delta("Request was aborted ");
    complete("The request was aborted.");
    note({ type: "turn.completed", ok: false } as Partial<RuntimeEvent>);
    expect(liveReplies("t")).toEqual([]);
  });

  it("after a gap in the stream, draws nothing until the next item starts clean", () => {
    delta("Before the gap ");
    forgetLiveReplies();
    expect(liveReplies("t")).toEqual([]);
    delta("tail of the item ");
    delta("other thread ", "u");
    expect(shown()).toEqual([]);
    expect(shown("u")).toEqual([]);
    complete("Before the gap tail of the item");
    delta("Next item ");
    expect(shown()).toEqual(["Next item "]);
  });

  it("masks a secret the way the saved message will, and never shows a half-typed one", () => {
    delta("Your key is sk-ant-api03-");
    expect(shown()).toEqual(["Your key is "]);
    delta("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ done.");
    expect(shown()[0]).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(liveReplyText({ text: "plain words", done: false })).toBe("plain ");
  });

  it("shows nothing of a private key until its END line is in", () => {
    const open = "Key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA secretbody\nmore ";
    expect(liveReplyText({ text: open, done: false })).toBe("Key:\n");
    expect(liveReplyText({ text: "Key:\n-----BEGIN RSA PRIV", done: false }), "a header still being written").toBe("Key:\n");
    const closed = `${open}lines\n-----END RSA PRIVATE KEY-----\nDone `;
    expect(liveReplyText({ text: closed, done: false })).not.toMatch(/MIIE|secretbody/);
    expect(liveReplyText({ text: closed, done: false })).toContain("«redacted");
  });

  it("draws nothing for a client abort sentence", () => {
    delta("The request was cancelled by the client.");
    complete("The request was cancelled by the client.");
    expect(shown()).toEqual([]);
    expect(hasLiveReply("t")).toBe(false);
  });

  it("names a room's speaker on the live row, as the saved message will", () => {
    delta("Room words ", "room");
    const from = { botId: "b1", name: "Pepper", color: "green" as const };
    const [row] = liveReplyRows(liveReplies("room"), [], roomLiveSpeaker([{ id: "b1", ...from, color: "green" }], "b1")).rows;
    expect(row).toMatchObject({ role: "bot", kind: "text", from, turnId: "turn-1" });
    expect(row!.id.startsWith("live:")).toBe(true);
  });

  it("names the member the server says is speaking, whoever the room shows as busy", () => {
    const members = [{ id: "b1", name: "Pepper", color: "green" as const }, { id: "b2", name: "Basil", color: "blue" as const }];
    delta("Pepper speaks ", "room", { botId: "b1", itemId: "p" } as Partial<RuntimeEvent>);
    note({ type: "item.completed", itemType: "assistant_text", text: "Pepper speaks.", itemId: "p" } as Partial<RuntimeEvent>, "room");
    delta("Basil answers ", "room", { botId: "b2", itemId: "q" } as Partial<RuntimeEvent>);
    for (const busy of ["b2", null, undefined]) {
      const rows = liveReplyRows(liveReplies("room"), [], roomLiveSpeaker(members, busy)).rows;
      expect(rows.map((row) => row.from?.name), `room busy with ${busy}`).toEqual(["Pepper", "Basil"]);
    }
    delta("Older server ", "u");
    expect(liveReplyRows(liveReplies("u"), [], roomLiveSpeaker(members, "b2")).rows[0]!.from?.name, "an older server names no one: the busy member").toBe("Basil");
    expect(liveReplyRows(liveReplies("u"), [], roomLiveSpeaker(members, null)).rows[0]!.from).toBeUndefined();
  });
});

describe("a reply keyed by the id the server streams it under", () => {
  const said = (text: string, itemId: string) => delta(text, "t", { itemId } as Partial<RuntimeEvent>);
  const finished = (text: string, itemId: string) =>
    note({ type: "item.completed", itemType: "assistant_text", text, itemId } as Partial<RuntimeEvent>);
  const saved = (id: string, itemId: string) => noteLiveReplyMessage("t", { id, role: "bot", kind: "text", turnId: "turn-1", itemId });
  const tool = (itemId: string) => {
    note({ type: "item.started", itemType: "tool", itemId, title: "ls -la" } as Partial<RuntimeEvent>);
    note({ type: "item.completed", itemType: "tool", itemId, ok: true } as Partial<RuntimeEvent>);
  };
  const rows = (transcript: { id: string; itemId?: string }[] = []) => liveReplyRows(liveReplies("t"), transcript).rows.map((row) => row.text);

  it("keeps text, tool, text, tool, text as three messages: never glued, doubled, lost or left behind", () => {
    note({ type: "turn.started" });
    said("Checking the ", "a");
    said("folder first. ", "a");
    expect(rows()).toEqual(["Checking the folder first. "]);
    finished("Checking the folder first.", "a");
    saved("m1", "a");
    tool("c1");
    said("Found three ", "b");
    expect(rows(), "the first is saved but not drawn yet").toEqual(["Checking the folder first.", "Found three "]);
    expect(rows([{ id: "m1", itemId: "a" }]), "drawn: only the new message streams").toEqual(["Found three "]);
    said("files. ", "b");
    finished("Found three files.", "b");
    saved("m2", "b");
    tool("c2");
    said("Done.", "c");
    finished("Done.", "c");
    saved("m3", "c");
    note({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    const transcript = [{ id: "m1", itemId: "a" }, { id: "m2", itemId: "b" }, { id: "m3", itemId: "c" }];
    const drawn = liveReplyRows(liveReplies("t"), transcript);
    expect(drawn.rows).toEqual([]);
    settleLiveReplies("t", drawn.settled);
    expect(liveReplies("t"), "nothing stale once the saved messages land").toEqual([]);
  });

  it("swaps by id even when the message frame never reached the store, as after a reload", () => {
    said("Answer ", "a");
    finished("Answer.", "a");
    expect(rows([{ id: "m9", itemId: "a" }])).toEqual([]);
    expect(rows([{ id: "m9", itemId: "other" }])).toEqual(["Answer."]);
  });

  it("keeps two messages in a row apart when no tool runs between them", () => {
    said("First thought. ", "a");
    finished("First thought.", "a");
    said("Second thought ", "b");
    expect(rows()).toEqual(["First thought.", "Second thought "]);
  });

  it("drops a message the server closed without finishing when its next one starts", () => {
    said("Half a ", "a");
    tool("c1");
    said("Result ", "b");
    expect(rows()).toEqual(["Result "]);
  });

  it("ignores a frame it has already seen, and a word for a message that already finished", () => {
    const first = said("Hello ", "a");
    noteLiveReplyEvent(first);
    finished("Hello there.", "a");
    said("late ", "a");
    expect(rows()).toEqual(["Hello there."]);
  });

  it("does not take an older server's message for a message that streamed under an id", () => {
    said("Keyed ", "a");
    finished("Keyed.", "a");
    noteLiveReplyMessage("t", { id: "old", role: "bot", kind: "text", turnId: "turn-1" });
    expect(liveReplies("t")[0]!.savedAs).toBeUndefined();
    saved("m1", "a");
    expect(liveReplies("t")[0]!.savedAs).toBe("m1");
    expect(streamedReply("m1")).toBe(true);
  });

  it("drops a finished message the server never saved when the turn ends", () => {
    said("<SYSTEM_NOTE>internal ", "a");
    finished("<SYSTEM_NOTE>internal</SYSTEM_NOTE>", "a");
    note({ type: "turn.completed", ok: true } as Partial<RuntimeEvent>);
    expect(liveReplies("t")).toEqual([]);
  });
});

describe("a thread nobody has on screen", () => {
  const reply = (id: string, turnId: string, text: string): Message =>
    ({ id, role: "bot", kind: "text", at: 0, text, turnId, itemId: `${turnId}:x` }) as Message;

  it("keeps nothing stale across 30 turns, and opening it with a small window draws none of them again", () => {
    const transcript: Message[] = [];
    for (let turn = 1; turn <= 30; turn++) {
      const turnId = `turn-${turn}`, itemId = `${turnId}:x`, text = `Reply number ${turn}.`;
      note({ type: "turn.started", turnId }, "bg");
      delta("Reply number ", "bg", { turnId, itemId } as Partial<RuntimeEvent>);
      note({ type: "item.completed", itemType: "assistant_text", text, turnId, itemId } as Partial<RuntimeEvent>, "bg");
      const saved = reply(`m${turn}`, turnId, text);
      noteLiveReplyMessage("bg", saved);
      note({ type: "turn.completed", ok: true, turnId } as Partial<RuntimeEvent>, "bg");
      transcript.push({ id: `ask${turn}`, role: "user", kind: "text", at: 0, text: "again" } as Message, saved);
    }
    expect(liveReplies("bg").length, "only the last turn's saved item waits for its transcript").toBeLessThanOrEqual(1);
    const windowed = transcript.slice(-1);
    const opened = withLiveRows(liveReplies("bg"), windowed, transcript);
    expect(opened.rows, "nothing drawn after the newest message").toEqual(windowed);
    settleLiveReplies("bg", opened.settled);
    expect(liveReplies("bg")).toEqual([]);
  });

  it("matches a saved item against the whole transcript, not the rows a window shows", () => {
    delta("Old answer ", "t", { itemId: "a" } as Partial<RuntimeEvent>);
    note({ type: "item.completed", itemType: "assistant_text", text: "Old answer.", itemId: "a" } as Partial<RuntimeEvent>);
    noteLiveReplyMessage("t", { id: "m1", role: "bot", kind: "text", turnId: "turn-1", itemId: "a" });
    const transcript = [reply("m1", "turn-1", "Old answer."), { id: "later", role: "user", kind: "text", at: 0, text: "next" } as Message];
    const { rows, settled } = withLiveRows(liveReplies("t"), transcript.slice(1), transcript);
    expect(rows.map((row) => row.id)).toEqual(["later"]);
    expect(settled).toHaveLength(1);
  });

  it("draws a streaming reply only under the newest message, never under a window scrolled back or opened at an old one", () => {
    const transcript = [reply("m1", "turn-0", "Old."), { id: "ask", role: "user", kind: "text", at: 0, text: "Now?" } as Message];
    delta("Streaming now ");
    expect(withLiveRows(liveReplies("t"), transcript.slice(0, 1), transcript).rows.map((row) => row.id)).toEqual(["m1"]);
    expect(withLiveRows(liveReplies("t"), transcript, transcript).rows.map((row) => row.text)).toEqual(["Old.", "Now?", "Streaming now "]);
  });

  it("holds a bounded number of items per thread whatever arrives", () => {
    for (let n = 0; n < 100; n++) {
      delta(`Item ${n} `, "t", { itemId: `i${n}` } as Partial<RuntimeEvent>);
      note({ type: "item.completed", itemType: "assistant_text", text: `Item ${n}.`, itemId: `i${n}` } as Partial<RuntimeEvent>);
    }
    expect(liveReplies("t").length).toBeLessThanOrEqual(32);
    expect(liveReplies("t").at(-1)!.text).toBe("Item 99.");
  });
});
