import { describe, expect, it } from "vitest";

import { createLineSplitter } from "./mcp-bridge.ts";

describe("MCP line framing", () => {
  it.each(["string", "buffer"] as const)("scans a fragmented %s frame in linear work", (kind) => {
    const fragment = "x".repeat(1024);
    const fragmentCount = 2048;
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    const original = String.prototype.indexOf;
    let searchedCharacters = 0;
    String.prototype.indexOf = function (this: string, search: string, start?: number) {
      if (search === "\n") searchedCharacters += Math.max(0, this.length - (start ?? 0));
      return original.call(this, search, start);
    };
    try {
      for (let i = 0; i < fragmentCount; i++) {
        splitter.push(kind === "buffer" ? Buffer.from(fragment) : fragment);
      }
      splitter.push("\nnext\n");
      splitter.flush();
    } finally {
      String.prototype.indexOf = original;
    }
    expect(lines).toEqual([fragment.repeat(fragmentCount), "next"]);
    expect(searchedCharacters).toBeLessThan(fragment.length * fragmentCount * 4);
  });

  it("keeps pending frames ahead of data pushed by a callback", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => {
      lines.push(line);
      if (line === "first") splitter.push("third\nfourth");
    });
    splitter.push("first\nsecond\n");
    expect(lines).toEqual(["first", "second", "third"]);
    splitter.flush();
    expect(lines).toEqual(["first", "second", "third", "fourth"]);
  });

  it("retains unconsumed frames if a callback throws", () => {
    const lines: string[] = [];
    const failure = new Error("receiver stopped");
    const splitter = createLineSplitter((line) => {
      lines.push(line);
      if (line === "first") throw failure;
    });
    expect(() => splitter.push("first\nsec")).toThrow(failure);
    splitter.push("ond\nthird");
    splitter.flush();
    expect(lines).toEqual(["first", "second", "third"]);
  });

  it("decodes every UTF-8 byte boundary and preserves empty lines", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    for (const byte of Buffer.from("\n🐭\r\n界\nlast")) splitter.push(Buffer.from([byte]));
    splitter.push(Buffer.alloc(0));
    splitter.push("");
    splitter.flush();
    splitter.flush();
    expect(lines).toEqual(["", "🐭\r", "界", "last"]);
  });

  it("flushes an incomplete final code point after preceding text", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push("prefix ");
    splitter.push(Buffer.from([0xf0, 0x9f]));
    splitter.flush();
    splitter.push("next\n");
    splitter.flush();
    expect(lines).toEqual(["prefix �", "next"]);
  });
});
