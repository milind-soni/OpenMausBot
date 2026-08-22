// The scrubber, against payloads built to contain what it removes.
//
// The proxy test proves nothing leaks through end to end. It cannot prove
// the scrubber does any work, because whether the harness leaks depends on
// which version is checked out. That is what these pin.
import { describe, expect, it } from "vitest";

import { createSseScrubber, isJson, MAX_SSE_EVENT_BYTES, scrub } from "../src/wire.ts";

describe("scrub", () => {
  it("removes resumeCursors wherever it is nested", () => {
    const bot = {
      id: "b1",
      name: "Rio",
      resumeCursors: { ghost: "session-abc" },
      tasks: [
        { threadId: "t1", title: "One", resumeCursors: { ghost: "session-def" } },
        { threadId: "t2", title: "Two" },
      ],
    };
    const cleaned = scrub({ bots: [bot], groups: [] });

    expect(JSON.stringify(cleaned)).not.toContain("resumeCursors");
    expect(JSON.stringify(cleaned)).not.toContain("session-abc");
    expect(JSON.stringify(cleaned)).not.toContain("session-def");
    // and nothing else was disturbed
    expect(cleaned).toEqual({
      bots: [{ id: "b1", name: "Rio", tasks: [{ threadId: "t1", title: "One" }, { threadId: "t2", title: "Two" }] }],
      groups: [],
    });
  });

  it("withholds the VPS host label but keeps the configured signal", () => {
    // GET /api/config and the `config` SSE frame echo the VPS SSH alias — a
    // label naming one of the user's servers. The phone renders
    // configured-or-not, so that is all it may receive.
    const status = {
      box: { configured: false },
      vps: { configured: true, sshAlias: "prod-vps" },
    };
    const cleaned = scrub(status);

    expect(JSON.stringify(cleaned)).not.toContain("sshAlias");
    expect(JSON.stringify(cleaned)).not.toContain("prod-vps");
    expect(cleaned).toEqual({ box: { configured: false }, vps: { configured: true } });
  });

  it("leaves values it does not own alone", () => {
    expect(scrub(null)).toBe(null);
    expect(scrub(42)).toBe(42);
    expect(scrub("resumeCursors")).toBe("resumeCursors"); // a string, not a key
    expect(scrub([1, [2, [3]]])).toEqual([1, [2, [3]]]);
  });
});

describe("isJson", () => {
  it("matches only real JSON content types", () => {
    expect(isJson("application/json")).toBe(true);
    expect(isJson("application/json; charset=utf-8")).toBe(true);
    expect(isJson("APPLICATION/JSON")).toBe(true);
    expect(isJson("image/png")).toBe(false);
    expect(isJson("text/event-stream")).toBe(false);
    expect(isJson(undefined)).toBe(false);
  });

  // A structured suffix is the registered way of saying "JSON underneath",
  // and the harness only has to answer one error as RFC 9457 for a body that
  // skips scrubbing to reach a phone.
  it("matches structured JSON suffixes too", () => {
    expect(isJson("application/problem+json")).toBe(true);
    expect(isJson("application/vnd.openmausbot.bot+json; charset=utf-8")).toBe(true);
    expect(isJson("APPLICATION/PROBLEM+JSON")).toBe(true);
    // and does not match something that merely ends in the letters
    expect(isJson("text/notjson")).toBe(false);
  });
});

describe("createSseScrubber", () => {
  it("keeps the blank-line terminator that ends an event", () => {
    // The failure this guards against is silent: a stream that never
    // terminates an event parses to nothing while both ends look healthy.
    const out = createSseScrubber()('data: {"kind":"hello"}\n\n');
    expect(out).toBe('data: {"kind":"hello"}\n\n');
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("scrubs the payload but never the id: line", () => {
    const frame = 'id: abc123:7\ndata: {"kind":"bot","bot":{"id":"b1","resumeCursors":{"g":"s"}}}\n\n';
    const out = createSseScrubber()(frame);

    expect(out).toContain("id: abc123:7\n");
    expect(out).not.toContain("resumeCursors");
    const data = JSON.parse(out.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    expect(data).toEqual({ kind: "bot", bot: { id: "b1" } });
  });

  it("emits an event as soon as it is complete, not when the chunk ends", () => {
    const scrubStream = createSseScrubber();
    // one event split across three arbitrary chunk boundaries
    expect(scrubStream('id: a:1\nda')).toBe("");
    expect(scrubStream('ta: {"kind":"bot"}')).toBe("");
    expect(scrubStream("\n\nid: a:2\n")).toBe('id: a:1\ndata: {"kind":"bot"}\n\n');
    // the second event is still incomplete and correctly withheld
    expect(scrubStream('data: {"kind":"message"}\n\n')).toBe('id: a:2\ndata: {"kind":"message"}\n\n');
  });

  it("passes keepalive comments and unparseable data through untouched", () => {
    const scrubStream = createSseScrubber();
    expect(scrubStream(": keepalive\n\n")).toBe(": keepalive\n\n");
    expect(scrubStream("data: not json at all\n\n")).toBe("data: not json at all\n\n");
  });

  it("refuses to buffer an event that never terminates", () => {
    // "Buffer to the frame boundary" is bounded only by the sender behaving.
    // An upstream that never sends the blank line — broken, or hostile —
    // otherwise grows this buffer for as long as the stream stays open.
    const scrubStream = createSseScrubber();
    const chunk = "x".repeat(256 * 1024);
    let sent = 0;
    expect(() => {
      for (;;) {
        scrubStream(chunk);
        sent += chunk.length;
        if (sent > MAX_SSE_EVENT_BYTES * 2) throw new Error("buffered without limit");
      }
    }).toThrow(/without a terminator/);
  });

  it("does not drop a large but well-formed event", () => {
    // The cap must sit clear of anything real, or a big-but-legitimate frame
    // would vanish and look exactly like a bug in the harness.
    const big = JSON.stringify({ kind: "bot", blob: "y".repeat(200 * 1024) });
    const out = createSseScrubber()(`data: ${big}\n\n`);
    expect(out).toBe(`data: ${big}\n\n`);
  });

  it("handles several events arriving in one chunk", () => {
    const out = createSseScrubber()(
      'id: a:1\ndata: {"a":1,"resumeCursors":{}}\n\nid: a:2\ndata: {"b":2}\n\n',
    );
    expect(out).toBe('id: a:1\ndata: {"a":1}\n\nid: a:2\ndata: {"b":2}\n\n');
  });

  // A CRLF producer is legal SSE, and an LF-only scrubber does not fail
  // loudly against one — it buffers the whole stream waiting for a boundary
  // that will never arrive, while both ends report a healthy connection.
  it("terminates events that arrive with CRLF, and keeps them CRLF", () => {
    const out = createSseScrubber()(
      'id: a:1\r\ndata: {"a":1,"resumeCursors":{"g":"s"}}\r\n\r\n',
    );
    expect(out).toBe('id: a:1\r\ndata: {"a":1}\r\n\r\n');
    expect(out).not.toContain("resumeCursors");
  });

  it("splits a CRLF stream across chunks without cutting an event short", () => {
    const scrubStream = createSseScrubber();
    // the chunk ends inside the terminator itself, which is the boundary a
    // naive indexOf gets wrong
    expect(scrubStream('id: a:1\r\ndata: {"a":1}\r\n\r')).toBe("");
    expect(scrubStream('\nid: a:2\r\ndata: {"b":2}\r\n\r\n')).toBe(
      'id: a:1\r\ndata: {"a":1}\r\n\r\nid: a:2\r\ndata: {"b":2}\r\n\r\n',
    );
  });

  it("still handles a bare CR, which the spec also allows", () => {
    expect(createSseScrubber()('data: {"a":1,"resumeCursors":{}}\r\r')).toBe('data: {"a":1}\r\r');
  });
});
