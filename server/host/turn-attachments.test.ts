import { expect, it, vi } from "vitest";
import { PERSON_STOPPED_TURN_NAME } from "../../shared/client-cancel.ts";
import { failedTurnTool } from "../../shared/failed-turn.ts";
import type { Message } from "../store.ts";
import { landTurnFiles, parkedFilesKey, settleParkedFiles, takeParkedFiles } from "./turn-attachments.ts";

const image = { kind: "image" as const, path: "/a/one.png", mime: "image/png" };
const note = { kind: "audio" as const, path: "/a/two.mp3", mime: "audio/mpeg", text: "  the token is sk-live-abc  " };
const redact = (text: string) => text.replace(/sk-live-\w+/, "[redacted]");

it("lands every turn's voice notes with its images, their words kept as a redacted transcript", () => {
  expect(settleParkedFiles([image, note], redact)).toEqual({
    land: [image, { kind: "audio", path: "/a/two.mp3", mime: "audio/mpeg", text: "the token is [redacted]" }],
    discard: [],
  });
});

it("leaves no transcript on a note recorded without words", () => {
  expect(settleParkedFiles([{ ...note, text: "   " }], redact).land).toEqual([{ kind: "audio", path: "/a/two.mp3", mime: "audio/mpeg" }]);
});

it("discards a goal coordinator's images and keeps its voice notes", () => {
  expect(settleParkedFiles([image, note], redact, true)).toEqual({
    land: [{ kind: "audio", path: "/a/two.mp3", mime: "audio/mpeg", text: "the token is [redacted]" }],
    discard: [image],
  });
});

function thread(rows: Array<Partial<Message>>) {
  const path = rows.map((row, index) => ({ id: `m${index}`, at: index, role: "bot", kind: "text", ...row }) as Message);
  const store = {
    activePath: () => path,
    patchMessage: vi.fn((_thread: string, id: string, patch: Partial<Message>) => { Object.assign(path.find((m) => m.id === id)!, patch); return null; }),
    insertMessageAfter: vi.fn((_thread: string, _after: string | undefined, line: Omit<Message, "id" | "at">) => line as Message),
  };
  const append = vi.fn();
  return { path, store, append };
}

const audio = { kind: "audio" as const, path: "/a/n.mp3", mime: "audio/mpeg", text: "Half done." };

it("puts the files on the turn's last reply line, above the error it ended on", () => {
  const { path, store, append } = thread([
    { role: "user", text: "Go." },
    { text: "Half done.", turnId: "t1" },
    { kind: "activity", tool: failedTurnTool("the next step failed") },
  ]);
  landTurnFiles(store, { threadId: "th", turnId: "t1" }, [audio], append);
  expect(path[1]!.attachments).toEqual([audio]);
  expect(append).not.toHaveBeenCalled();
  expect(store.insertMessageAfter).not.toHaveBeenCalled();
});

it("gives a turn without a reply a line of its own, above the error or stop lines it ended on", () => {
  for (const ending of [failedTurnTool("stopped by the loop guard"), { name: PERSON_STOPPED_TURN_NAME, ok: true }]) {
    const { store, append } = thread([
      { role: "user", text: "Go." },
      { kind: "activity", tool: { name: "agents_send_voice_note", ok: true }, turnId: "t1" },
      { kind: "activity", tool: ending },
    ]);
    landTurnFiles(store, { threadId: "th", turnId: "t1" }, [audio], append);
    expect(store.insertMessageAfter).toHaveBeenCalledWith("th", "m1", { role: "bot", kind: "text", text: "", attachments: [audio], turnId: "t1" });
    expect(append).not.toHaveBeenCalled();
  }
});

it("appends that line when the turn ended without an error line, and does nothing without files", () => {
  const { store, append } = thread([{ role: "user", text: "Go." }]);
  landTurnFiles(store, { threadId: "th", turnId: "t1" }, [], append);
  expect(append).not.toHaveBeenCalled();
  landTurnFiles(store, { threadId: "th", turnId: "t1", from: { botId: "b", name: "B", color: "#fff" } }, [audio], append);
  expect(append).toHaveBeenCalledWith({ role: "bot", kind: "text", text: "", attachments: [audio], turnId: "t1", from: { botId: "b", name: "B", color: "#fff" } });
});

it("takes a settling turn's own files and any the thread parked under another turn, and leaves other threads' alone", () => {
  const one = { kind: "audio" as const, path: "/a/1.mp3", mime: "audio/mpeg" };
  const two = { kind: "image" as const, path: "/a/2.png", mime: "image/png" };
  const three = { kind: "audio" as const, path: "/a/3.mp3", mime: "audio/mpeg" };
  const other = { kind: "audio" as const, path: "/a/4.mp3", mime: "audio/mpeg" };
  const parked = new Map([
    [parkedFilesKey("th", "t2"), [one]],
    [parkedFilesKey("th"), [two]],
    [parkedFilesKey("th", "t1"), [three]],
    [parkedFilesKey("th-2", "t9"), [other]],
  ]);
  expect(takeParkedFiles(parked, "th", "t2")).toEqual({ files: [one, two, three], strays: ["active", "t1"] });
  expect([...parked.keys()]).toEqual([parkedFilesKey("th-2", "t9")]);
  expect(takeParkedFiles(parked, "th", "t3")).toEqual({ files: [], strays: [] });
});
