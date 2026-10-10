import { describe, expect, it } from "vitest";

import {
  PASTE_CHARS,
  PASTE_LINES,
  attachmentsFromDroppedFiles,
  byteLength,
  composeMessage,
  fileAttachment,
  isAttachment,
  isLongPaste,
  pasteAttachment,
  pasteSummary,
} from "../src/lib/composer-attachments.ts";

describe("composer paste attachments", () => {
  it("classifies long character and line pastes without changing short text", () => {
    expect(isLongPaste("x".repeat(PASTE_CHARS - 1))).toBe(false);
    expect(isLongPaste("x".repeat(PASTE_CHARS))).toBe(true);
    expect(isLongPaste(Array.from({ length: PASTE_LINES }, () => "x").join("\n"))).toBe(true);
  });

  it("measures UTF-8 once and reports a useful summary", () => {
    const attachment = pasteAttachment("héllo\n世界");
    expect(attachment.size).toBe(byteLength(attachment.text));
    expect(attachment.size).toBeGreaterThan(attachment.text.length);
    expect(attachment.lines).toBe(2);
    expect(pasteSummary(attachment)).toMatch(/^2 lines, /);
  });

  it("composes attachment-only and mixed messages in a stable order", () => {
    const first = pasteAttachment("first");
    const second = pasteAttachment("second");
    expect(composeMessage("", [first])).toBe(
      '<pasted-text index="1">\nfirst\n</pasted-text>',
    );
    expect(composeMessage("  intro  ", [first, second])).toBe(
      'intro\n\n<pasted-text index="1">\nfirst\n</pasted-text>\n\n' +
        '<pasted-text index="2">\nsecond\n</pasted-text>',
    );
  });

  it("keeps unusual file paths inside the attachment attribute", () => {
    const file = fileAttachment("report.txt", '/tmp/a"&<>\t\n\r.txt', 42);
    expect(composeMessage("", [file])).toBe(
      '<attached-file path="/tmp/a&quot;&amp;&lt;&gt;&#9;&#10;&#13;.txt" name="report.txt" />',
    );
  });

  it("preserves drop order and falls back to small pathless text", async () => {
    const dropped = [
      {
        name: "on-disk.md",
        size: 12,
        type: "text/markdown",
        path: "/tmp/on-disk.md",
        text: async () => "not read",
      },
      {
        name: "browser.txt",
        size: 7,
        type: "text/plain",
        path: "",
        text: async () => "browser",
      },
      {
        name: "image.png",
        size: 10,
        type: "image/png",
        path: "",
        text: async () => "not text",
      },
    ];

    const result = await attachmentsFromDroppedFiles(dropped, (file) => file.path);
    expect(result.attachments.map((attachment) => attachment.kind)).toEqual(["file", "paste"]);
    expect(result.attachments[0]).toMatchObject({
      kind: "file",
      name: "on-disk.md",
      path: "/tmp/on-disk.md",
    });
    expect(result.attachments[1]).toMatchObject({ kind: "paste", text: "browser" });
    expect(result.rejectedNames).toEqual(["image.png"]);
  });

  it("rejects malformed persisted attachments", () => {
    expect(isAttachment({ kind: "paste", id: "a", text: "ok", size: 2, lines: 1 })).toBe(true);
    expect(
      isAttachment({ kind: "file", id: "f", name: "notes.txt", path: "/tmp/notes.txt", size: 2 }),
    ).toBe(true);
    expect(isAttachment({ kind: "paste", id: "a", text: "missing size" })).toBe(false);
    expect(isAttachment({ kind: "file", id: "a", text: "wrong kind", size: 2 })).toBe(false);
    expect(isAttachment({ kind: "file", id: "f", name: "empty", path: "", size: 0 })).toBe(false);
  });
});
