import { describe, expect, it } from "vitest";
import { ChatRepeatGuard } from "./chat-repeat-guard.ts";

const failed = { ok: false, text: "ENOENT" };

describe("ChatRepeatGuard", () => {
  it("refuses a call after three identical failures, then stops at the second refusal", () => {
    const guard = new ChatRepeatGuard();
    expect(guard.noteAfter("read", "{}", failed)).toBeUndefined();
    expect(guard.refuses("read", "{}")).toBeNull();
    expect(guard.noteAfter("read", "{}", failed)).toBeUndefined();
    expect(guard.noteAfter("read", "{}", failed)).toContain("will not run again");
    expect(guard.refuses("read", "{}")).toContain("was not run");
    expect(guard.stopped).toBeNull();
    expect(guard.refuses("read", "{}")).toContain("was not run");
    expect(guard.stopped).toContain("read");
  });

  it("treats other inputs and other failures as progress", () => {
    const guard = new ChatRepeatGuard();
    for (const text of ["a", "b", "c", "d"]) guard.noteAfter("read", "{}", { ok: false, text });
    expect(guard.refuses("read", "{}")).toBeNull();
    for (let i = 0; i < 3; i++) guard.noteAfter("read", '{"p":1}', failed);
    expect(guard.refuses("read", '{"p":2}')).toBeNull();
    expect(guard.refuses("read", '{"p":1}')).not.toBeNull();
  });

  it("starts the count over when the call works", () => {
    const guard = new ChatRepeatGuard();
    guard.noteAfter("read", "{}", failed);
    guard.noteAfter("read", "{}", failed);
    guard.noteAfter("read", "{}", { ok: true, text: "fine" });
    guard.noteAfter("read", "{}", failed);
    expect(guard.refuses("read", "{}")).toBeNull();
  });

  it("sees the same call in another key order", () => {
    const guard = new ChatRepeatGuard();
    for (let i = 0; i < 3; i++) guard.noteAfter("read", '{"a":1,"b":2}', failed);
    expect(guard.refuses("read", '{"b":2,"a":1}')).not.toBeNull();
  });

  it("notes a repeated answer at three and stops at ten, even taking turns with another call", () => {
    const guard = new ChatRepeatGuard();
    const same = { ok: true, text: "still running" };
    const notes: Array<string | undefined> = [];
    for (let i = 0; i < 9; i++) {
      notes.push(guard.noteAfter("status", "{}", same));
      guard.noteAfter("other", `{"i":${i}}`, { ok: true, text: String(i) });
    }
    expect(notes[1]).toBeUndefined();
    expect(notes[2]).toContain("3 times");
    expect(guard.stopped).toBeNull();
    guard.noteAfter("status", "{}", same);
    expect(guard.stopped).toContain("status");
  });

  it("never counts a screenshot as the same answer", () => {
    const guard = new ChatRepeatGuard();
    for (let i = 0; i < 20; i++) expect(guard.noteAfter("shot", "{}", { ok: true, text: "ok", images: [{}] })).toBeUndefined();
    expect(guard.stopped).toBeNull();
  });

  it("a changed answer starts over", () => {
    const guard = new ChatRepeatGuard();
    guard.noteAfter("status", "{}", { ok: true, text: "a" });
    guard.noteAfter("status", "{}", { ok: true, text: "a" });
    guard.noteAfter("status", "{}", { ok: true, text: "b" });
    expect(guard.noteAfter("status", "{}", { ok: true, text: "b" })).toBeUndefined();
  });
});
