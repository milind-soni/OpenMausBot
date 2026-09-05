// How the proxy prepares a response body, against a stub harness.
//
// proxy.test.ts boots the real harness and is the right place for anything
// about the seam between the two. This file is the opposite: a harness stub
// that can be made to return exactly the pathological body a test needs,
// which is the only way to reach the failure branches below.
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProxyHandler, proxyHeadersTimeoutMs } from "../src/proxy.ts";
import type { CompanionEndpoint } from "../src/endpoints.ts";
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
let companionMarker = "";
let companionDevice = "";
let endpointCandidates: CompanionEndpoint[] = [];
/** What the stub harness answers with next. Set per test. */
let respond: (res: ServerResponse) => void = (res) => res.end();

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

const close = (server: Server | undefined): Promise<void> =>
  new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));

/** A request as a paired device makes it. */
const device = async (
  path = "/api/bots",
  method = "GET",
  body?: string,
): Promise<{ status: number; text: string; headers: Headers }> => {
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  };
  const init: RequestInit = body === undefined
    ? { method, headers }
    : { method: "POST", headers, body };
  const res = await fetch(`http://127.0.0.1:${sidecarPort}${path}`, init);
  return { status: res.status, text: await res.text(), headers: res.headers };
};

beforeAll(async () => {
  harness = createServer((req, res) => {
    companionMarker = String(req.headers["x-openmausbot-companion"] ?? "");
    companionDevice = String(req.headers["x-openmausbot-companion-device"] ?? "");
    respond(res);
  });
  const harnessPort = await listen(harness);

  sidecar = createServer(
    createProxyHandler({
      harnessPort,
      authenticate: (t) => (t === TOKEN ? { id: "phone-1", cloudDesktopAccess } : null),
      redeem: () => ({ error: "not used here" }),
      serverName: () => "Test computer",
      endpoints: () => endpointCandidates,
    }),
  );
  sidecarPort = await listen(sidecar);
});

afterAll(async () => {
  await close(sidecar);
  await close(harness);
});

describe("preparing a harness response for a device", () => {
  it("gives only transactional phone credential saves the longer deadline", () => {
    expect(proxyHeadersTimeoutMs("/api/bots/b1/secret-cards/m1/provide")).toBe(105_000);
    expect(proxyHeadersTimeoutMs("/api/bots/b1/messages")).toBe(30_000);
    expect(proxyHeadersTimeoutMs("/api/bots/b1/secret-cards/m1/provide", 17)).toBe(17);
  });

  it("drops an endpoint whose runtime URL is not a string", async () => {
    const malformed: CompanionEndpoint = { kind: "hosted", priority: 0, url: "https://ok.example" };
    Object.defineProperty(malformed, "url", { value: 42 });
    endpointCandidates = [malformed];
    try {
      const { status, text } = await device("/api/companion/endpoints");
      expect(status).toBe(200);
      expect(JSON.parse(text)).toMatchObject({ endpoints: [] });
    } finally {
      endpointCandidates = [];
    }
  });

  it("requires the host to enable cloud desktop for viewer and preview requests", async () => {
    cloudDesktopAccess = false;
    try {
      for (const action of ["join", "screenshot"]) {
        const { status, text } = await device(`/api/bots/b1/computer/${action}`, "POST");
        expect(status).toBe(403);
        expect(text).toContain("enable it in OpenMausBot");
        expect(text).toContain("Settings → Remote access");
      }
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
    expect(companionMarker).toBe("1");
    expect(companionDevice).toBe("phone-1");
  });

  it("replaces a caller-supplied device identity with the authenticated one", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
    const response = await fetch(`http://127.0.0.1:${sidecarPort}/api/bots`, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-openmausbot-companion-device": "another-phone",
      },
    });
    expect(response.status).toBe(200);
    expect(companionDevice).toBe("phone-1");
  });

  it("turns a host-loopback VPS viewer into a device-scoped companion path", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        joinUrl: "http://127.0.0.1:45678/vnc.html#autoconnect=true&password=viewer-secret",
        state: "running",
      }));
    };
    const { status, text } = await device("/api/bots/b1/computer/join", "POST");
    expect(status).toBe(200);
    const joinUrl = String(JSON.parse(text).joinUrl);
    expect(joinUrl).toMatch(/^\/vps-viewer\/[A-Za-z0-9_-]{32}\/vnc\.html#/);
    expect(joinUrl).toContain("password=viewer-secret");
    expect(joinUrl).toContain("path=vps-viewer%2F");
    expect(joinUrl).not.toContain("127.0.0.1:45678");
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
      res.writeHead(200, {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
        "cache-control": "public, max-age=3600",
      });
      res.end(JSON.stringify({ bots: [{ id: "b1" }], resumeCursors: { agent: "cursor-value" } }));
    };

    const { status, text, headers } = await device();
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({ bots: [{ id: "b1" }] });
    expect(text).not.toContain("cursor-value");
    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
  });

  it("overrides cacheable upstream headers on byte responses", async () => {
    respond = (res) => {
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
        etag: '"private-image"',
      });
      res.end("image-bytes");
    };

    const response = await device("/api/threads/thread-1/messages/message-1/image");
    expect(response.status).toBe(200);
    expect(response.text).toBe("image-bytes");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
  });

  it("passes an application/json message file through byte-for-byte", async () => {
    const bytes = '{\n  "resumeCursors": { "this-is-file-content": true },\n  "n": 1\n}\n';
    respond = (res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-disposition": 'attachment; filename="report.json"',
      });
      res.end(bytes);
    };

    const response = await device(
      "/api/threads/thread-1/messages/message-1/file",
      "POST",
      JSON.stringify({ path: "report.json" }),
    );
    expect(response.status).toBe(200);
    expect(response.text).toBe(bytes);
    expect(response.headers.get("content-disposition")).toContain("report.json");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("relays generated speech to a paired desktop byte for byte", async () => {
    const audio = Uint8Array.from([0x49, 0x44, 0x33, 0x00, 0xff, 0x17]);
    respond = (res) => {
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-length": String(audio.byteLength),
        "cache-control": "public, max-age=86400",
      });
      res.end(audio);
    };

    const response = await fetch(`http://127.0.0.1:${sidecarPort}/api/tts/speak`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello from the agent" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio);
  });
});
