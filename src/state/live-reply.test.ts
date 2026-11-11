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
  settleLiveReplies,
  stopLiveReply,
  streamedReply,
} from "./live-reply";

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

describe("a reply as it streams", () => {
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
    expect(liveReplies("t")).toEqual([]);
    delta("late words ");
    expect(shown(), "the rest of a stopped item is not drawn").toEqual([]);
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

  it("draws nothing for a client abort sentence", () => {
    delta("The request was cancelled by the client.");
    complete("The request was cancelled by the client.");
    expect(shown()).toEqual([]);
    expect(hasLiveReply("t")).toBe(false);
  });

  it("names a room's speaker on the live row, as the saved message will", () => {
    delta("Room words ", "room");
    const from = { botId: "b1", name: "Pepper", color: "green" as const };
    const [row] = liveReplyRows(liveReplies("room"), [], from).rows;
    expect(row).toMatchObject({ role: "bot", kind: "text", from, turnId: "turn-1" });
    expect(row!.id.startsWith("live:")).toBe(true);
  });
});
