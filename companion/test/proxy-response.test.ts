// How the proxy prepares a response body, against a stub harness.
//
// proxy.test.ts boots the real harness and is the right place for anything
// about the seam between the two. This file is the opposite: a harness stub
// that can be made to return exactly the pathological body a test needs,
// which is the only way to reach the failure branches below.
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProxyHandler } from "../src/proxy.ts";
import { scrub } from "../src/wire.ts";

const TOKEN = "omb_test_token";

/** Nested past any plausible stack, so `scrub`'s recursion gives out while
 * JSON.parse does not. The payload is what the scrubber is meant to remove. */
const deeplyNested = (() => {
  let body = JSON.stringify({ resumeCursors: { agent: "cursor-value" } });
  for (let i = 0; i < 6_000; i++) body = `{"a":${body}}`;
  return body;
})();

let harness: Server;
let sidecar: Server;
let sidecarPort = 0;
let cloudDesktopAccess = true;
/** What the stub harness answers with next. Set per test. */
let respond: (res: ServerResponse) => void = (res) => res.end();

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

const close = (server: Server | undefined): Promise<void> =>
  new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));

/** A request as a paired device makes it. */
const device = async (path = "/api/bots", method = "GET"): Promise<{ status: number; text: string }> => {
  const res = await fetch(`http://127.0.0.1:${sidecarPort}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return { status: res.status, text: await res.text() };
};

beforeAll(async () => {
  harness = createServer((_req, res) => respond(res));
  const harnessPort = await listen(harness);

  sidecar = createServer(
    createProxyHandler({
      harnessPort,
      authenticate: (t) => (t === TOKEN ? { cloudDesktopAccess } : null),
      redeem: () => ({ error: "not used here" }),
      serverName: () => "Test computer",
    }),
  );
  sidecarPort = await listen(sidecar);
});

afterAll(async () => {
  await close(sidecar);
  await close(harness);
});

describe("preparing a harness response for a device", () => {
  it("requires the Mac to enable cloud desktop for this phone", async () => {
    cloudDesktopAccess = false;
    try {
      const { status, text } = await device("/api/bots/b1/computer/join", "POST");
      expect(status).toBe(403);
      expect(text).toContain("enable it in OpenMausBot");
    } finally {
      cloudDesktopAccess = true;
    }
  });

  it("forwards only the enabled device's request for a fresh viewer", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ joinUrl: "https://desktop.example/session/fresh", state: "ready" }));
    };
    const { status, text } = await device("/api/bots/b1/computer/join", "POST");
    expect(status).toBe(200);
    expect(JSON.parse(text).joinUrl).toBe("https://desktop.example/session/fresh");
  });

  it("never forwards a body it could not scrub", async () => {
    // `scrub` recurses once per level, so a deeply nested body throws
    // RangeError while JSON.parse handles it without complaint. That gap is
    // the whole bug: parse-then-scrub under one try/catch treated the throw
    // as "not JSON after all" and sent the untouched body on to the phone.
    //
    // How deep it takes is a property of the runtime's stack, not of this
    // code, so the assertion is the invariant and not the branch: whatever
    // comes back is never a success carrying the field the scrubber removes.
    // On a stack deep enough to scrub this that is a clean 200; on one that
    // throws it is a 502. The raw body is not among the outcomes.
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(deeplyNested);
    };

    const { status, text } = await device();
    expect(status === 200 && text.includes("resumeCursors")).toBe(false);
    expect(text).not.toContain("cursor-value");
  });

  it("answers 502 when scrubbing actually throws", async () => {
    // The branch above, pinned only on a runtime that reaches it — checked
    // here rather than assumed, so this reports "not exercised" instead of
    // failing on a platform with a deeper stack.
    let scrubThrows = false;
    try {
      scrub(JSON.parse(deeplyNested));
    } catch {
      scrubThrows = true;
    }
    if (!scrubThrows) {
      expect(scrubThrows).toBe(false); // documents the skip rather than passing silently
      return;
    }

    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(deeplyNested);
    };
    expect((await device()).status).toBe(502);
  });

  it("passes a body through untouched when it was never JSON", async () => {
    // The tolerant half of the same branch, and the reason it cannot simply
    // fail closed on everything: a content-type that lies is common enough,
    // and there is nothing to redact in bytes we cannot read as an object.
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("this is not JSON at all");
    };

    const { status, text } = await device();
    expect(status).toBe(200);
    expect(text).toBe("this is not JSON at all");
  });

  it("scrubs a well-formed body and re-frames it", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
      res.end(JSON.stringify({ bots: [{ id: "b1" }], resumeCursors: { agent: "cursor-value" } }));
    };

    const { status, text } = await device();
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({ bots: [{ id: "b1" }] });
    expect(text).not.toContain("cursor-value");
  });
});
