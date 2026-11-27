// Payloads built to contain what the scrubber removes: whether a real harness
// leaks depends on which version is checked out.
import { describe, expect, it } from "vitest";

import { createSseScrubber, isJson, MAX_SSE_EVENT_BYTES, scrub } from "../src/wire.ts";

describe("scrub", () => {
  it("removes resumeCursors wherever it is nested", () => {
    const bot = {
      id: "b1",
      name: "Rio",
      resumeCursors: { ghost: "session-abc" },
      mainThreadId: "t2",
      tasks: [
        { threadId: "t1", title: "One", resumeCursors: { ghost: "session-def" } },
        { threadId: "t2", title: "Two" },
      ],
    };
    const cleaned = scrub({ bots: [bot], groups: [] });

    expect(JSON.stringify(cleaned)).not.toContain("resumeCursors");
    expect(JSON.stringify(cleaned)).not.toContain("session-abc");
    expect(JSON.stringify(cleaned)).not.toContain("session-def");
    expect(cleaned).toEqual({
      bots: [{ id: "b1", name: "Rio", mainThreadId: "t2", tasks: [{ threadId: "t1", title: "One" }, { threadId: "t2", title: "Two" }] }],
      groups: [],
    });
  });

  it("withholds the VPS host label but keeps the configured signal", () => {
    const status = {
      box: { configured: false },
      vps: { configured: true, sshAlias: "prod-vps" },
    };
    const cleaned = scrub(status);

    expect(JSON.stringify(cleaned)).not.toContain("sshAlias");
    expect(JSON.stringify(cleaned)).not.toContain("prod-vps");
    expect(cleaned).toEqual({ box: { configured: false }, vps: { configured: true } });
  });

  it("withholds per-bot and inventory alias tags but keeps ordinary fields", () => {
    const payload = {
      configured: true,
      available: true,
      vpsAliases: ["production-vps", "alpha-vps"],
      problem: null,
      instances: [
        { name: "openmausbot-vps-one", state: "running", vpsAlias: "production-vps", ownerBotId: "b1", ownerName: "Rio", orphaned: false, inUse: false },
        { name: "openmausbot-vps-two", state: "exited", vpsAlias: "alpha-vps", ownerBotId: null, ownerName: null, orphaned: true, inUse: false },
      ],
      bot: { id: "b1", name: "Rio", vpsAlias: "alpha-vps" },
    };
    const cleaned = scrub(payload);

    expect(JSON.stringify(cleaned)).not.toContain("vpsAliases");
    expect(JSON.stringify(cleaned)).not.toContain("vpsAlias");
    expect(JSON.stringify(cleaned)).not.toContain("production-vps");
    expect(JSON.stringify(cleaned)).not.toContain("alpha-vps");
    expect(cleaned).toEqual({
      configured: true,
      available: true,
      problem: null,
      instances: [
        { name: "openmausbot-vps-one", state: "running", ownerBotId: "b1", ownerName: "Rio", orphaned: false, inUse: false },
        { name: "openmausbot-vps-two", state: "exited", ownerBotId: null, ownerName: null, orphaned: true, inUse: false },
      ],
      bot: { id: "b1", name: "Rio" },
    });
  });

  it("leaves values it does not own alone", () => {
    expect(scrub(null)).toBe(null);
    expect(scrub(42)).toBe(42);
    expect(scrub("resumeCursors")).toBe("resumeCursors"); // a string, not a key
    expect(scrub([1, [2, [3]]])).toEqual([1, [2, [3]]]);
  });

  it("leaves the alias's text alone wherever it is not a withheld key", () => {
    // "vps" is a natural SSH alias; the bot's backend, a container name and a message say "vps" too.
    const payload = {
      bot: { id: "b1", cloudBackend: "vps", vpsAlias: "vps", computers: [{ name: "openmausbot-vps-one" }] },
      messages: [{ text: "Is the vps up?" }],
    };
    expect(scrub(payload)).toEqual({
      bot: { id: "b1", cloudBackend: "vps", computers: [{ name: "openmausbot-vps-one" }] },
      messages: [{ text: "Is the vps up?" }],
    });
  });

  it("ignores empty and absent withheld values", () => {
    const cleaned = scrub({ vpsAlias: "", vpsAliases: [], problem: "plain words", nested: { list: ["", "kept"] } });

    expect(cleaned).toEqual({ problem: "plain words", nested: { list: ["", "kept"] } });
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

  it("matches structured JSON suffixes too", () => {
    expect(isJson("application/problem+json")).toBe(true);
    expect(isJson("application/vnd.openmausbot.bot+json; charset=utf-8")).toBe(true);
    expect(isJson("APPLICATION/PROBLEM+JSON")).toBe(true);
    expect(isJson("text/notjson")).toBe(false);
  });
});

describe("createSseScrubber", () => {
  it("keeps the blank-line terminator that ends an event", () => {
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

  it("strips per-bot alias tags from a bot frame but never the id: line", () => {
    const frame = 'id: abc123:7\ndata: {"kind":"bot","bot":{"id":"b1","vpsAlias":"alpha-vps","vpsAliases":["alpha-vps"],"computers":[{"name":"n1","vpsAlias":"alpha-vps"}]}}\n\n';
    const out = createSseScrubber()(frame);

    expect(out).toContain("id: abc123:7\n");
    expect(out).not.toContain("vpsAlias");
    expect(out).not.toContain("alpha-vps");
    const data = JSON.parse(out.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    expect(data).toEqual({ kind: "bot", bot: { id: "b1", computers: [{ name: "n1" }] } });
  });

  it("emits an event as soon as it is complete, not when the chunk ends", () => {
    const scrubStream = createSseScrubber();
    expect(scrubStream('id: a:1\nda')).toBe("");
    expect(scrubStream('ta: {"kind":"bot"}')).toBe("");
    expect(scrubStream("\n\nid: a:2\n")).toBe('id: a:1\ndata: {"kind":"bot"}\n\n');
    expect(scrubStream('data: {"kind":"message"}\n\n')).toBe('id: a:2\ndata: {"kind":"message"}\n\n');
  });

  it("passes keepalive comments and unparseable data through untouched", () => {
    const scrubStream = createSseScrubber();
    expect(scrubStream(": keepalive\n\n")).toBe(": keepalive\n\n");
    expect(scrubStream("data: not json at all\n\n")).toBe("data: not json at all\n\n");
  });

  it("refuses to buffer an event that never terminates", () => {
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
    // The cap must sit clear of anything real.
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

  it("terminates events that arrive with CRLF, and keeps them CRLF", () => {
    const out = createSseScrubber()(
      'id: a:1\r\ndata: {"a":1,"resumeCursors":{"g":"s"}}\r\n\r\n',
    );
    expect(out).toBe('id: a:1\r\ndata: {"a":1}\r\n\r\n');
    expect(out).not.toContain("resumeCursors");
  });

  it("splits a CRLF stream across chunks without cutting an event short", () => {
    const scrubStream = createSseScrubber();
    // The chunk ends inside the terminator, the boundary a naive indexOf gets wrong.
    expect(scrubStream('id: a:1\r\ndata: {"a":1}\r\n\r')).toBe("");
    expect(scrubStream('\nid: a:2\r\ndata: {"b":2}\r\n\r\n')).toBe(
      'id: a:1\r\ndata: {"a":1}\r\n\r\nid: a:2\r\ndata: {"b":2}\r\n\r\n',
    );
  });

  it("still handles a bare CR, which the spec also allows", () => {
    expect(createSseScrubber()('data: {"a":1,"resumeCursors":{}}\r\r')).toBe('data: {"a":1}\r\r');
  });
});

describe("the SSE event ceiling", () => {
  it("bounds complete events and counts multibyte text as bytes", () => {
    const payload = "é".repeat(MAX_SSE_EVENT_BYTES / 2 + 1);
    expect(() => createSseScrubber()(`data: ${payload}\n\n`)).toThrow(/exceeded/);
    expect(() => createSseScrubber()(`data: ${payload}`)).toThrow(/exceeded/);
  });
  it("clears the largest frame the harness will emit", () => {
    expect(MAX_SSE_EVENT_BYTES).toBeGreaterThan(3 * 1024 * 1024);
  });

  it("forwards an event larger than the old 1 MiB limit", () => {
    const scrub = createSseScrubber();
    const payload = "a".repeat(1_500_000);

    const out = scrub(`event: frame\ndata: {"data":"${payload}"}\n\n`);

    expect(out).toContain(payload);
  });
});
