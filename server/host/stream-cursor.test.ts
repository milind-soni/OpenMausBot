import { describe, expect, it } from "vitest";

import { streamCursorSeq } from "./stream-cursor.ts";

describe("streamCursorSeq", () => {
  it("reads this stream's sequence and refuses another stream's or a malformed one", () => {
    expect(streamCursorSeq("abc:12", "abc")).toBe(12);
    expect(streamCursorSeq(["abc:0", "abc:9"], "abc")).toBe(0);
    for (const raw of [undefined, "", "other:12", "abc:-1", "abc:1.5", "abc:x", "abc"]) expect(streamCursorSeq(raw, "abc"), String(raw)).toBeNull();
  });
});
