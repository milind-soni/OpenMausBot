import { describe, expect, it } from "vitest";

import { memoryNotes, withMemoryNote, withoutMemoryNote } from "./memory-notes";

const doc = "# Notes\n- Omkar uses Resolve Studio\n* Likes short replies\nplain line\n  - nested one\n";

describe("the notes in MEMORY.md", () => {
  it("are its bullet lines, each with the line it sits on", () => {
    expect(memoryNotes(doc)).toEqual([
      { line: 1, text: "Omkar uses Resolve Studio" }, { line: 2, text: "Likes short replies" }, { line: 4, text: "nested one" },
    ]);
    expect(memoryNotes("")).toEqual([]);
  });

  it("forget one line and leave every other byte alone", () => {
    expect(withoutMemoryNote(doc, 2)).toBe("# Notes\n- Omkar uses Resolve Studio\nplain line\n  - nested one\n");
    expect(withoutMemoryNote(doc, 3), "a line that is not a note is never removed").toBe(doc);
    expect(withoutMemoryNote(doc, 99)).toBe(doc);
  });

  it("add a note as one bullet at the end, on its own line", () => {
    expect(withMemoryNote(doc, "  Prefers the free version ")).toBe(`${doc}- Prefers the free version\n`);
    expect(withMemoryNote("", "First")).toBe("- First\n");
    expect(withMemoryNote("# Notes", "Two\nlines")).toBe("# Notes\n- Two lines\n");
  });
});
