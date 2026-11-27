import { describe, expect, it } from "vitest";

import { parseMcpResponse, withToolsListFallback } from "./connector-tools-list.ts";

const response = (id: string | number) => ({ jsonrpc: "2.0", id, result: { tools: [{ name: "read_notes" }] } });
const events = (...frames: unknown[]) => frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");

describe("connector response correlation", () => {
  it("accepts a JSON response only for the requested ID", () => {
    const answer = response("list-1");
    expect(parseMcpResponse(JSON.stringify(answer), "list-1")).toEqual(answer);
    expect(parseMcpResponse(JSON.stringify(answer), "list-2")).toBeNull();
  });

  it("does not confuse a numeric ID with a string ID", () => {
    expect(parseMcpResponse(JSON.stringify(response(1)), "1")).toBeNull();
    expect(parseMcpResponse(events(response("1")), 1)).toBeNull();
  });

  it.each([
    { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
    { jsonrpc: "2.0", id: "list-1", method: "ping" },
  ])("ignores notifications and server requests", (frame) => {
    expect(parseMcpResponse(JSON.stringify(frame), "list-1")).toBeNull();
    expect(parseMcpResponse(events(frame), "list-1")).toBeNull();
  });

  it("finds the matching SSE reply among unrelated responses and notifications", () => {
    const answer = response("list-1");
    const notification = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
    expect(parseMcpResponse(events(response("earlier"), notification, answer, notification), "list-1")).toEqual(answer);
    expect(parseMcpResponse(events(response("earlier"), notification), "list-1")).toBeNull();
    expect(parseMcpResponse(events(response("earlier")), "list-1")).toBeNull();
  });

  it("retains a correlated JSON-RPC error", () => {
    const error = { jsonrpc: "2.0", id: "list-1", error: { code: -32601, message: "Method not found" } };
    expect(parseMcpResponse(JSON.stringify(error), "list-1")).toEqual(error);
    expect(parseMcpResponse(events(error), "list-1")).toEqual(error);
    expect(parseMcpResponse(events(error), "list-2")).toBeNull();
  });

  it.each(["json", "sse"] as const)("keeps null-ID %s errors as diagnostics without claiming correlation", (format) => {
    const error = { code: -32700, message: "The request body could not be parsed" };
    const frame = { jsonrpc: "2.0", id: null, error, result: { tools: [{ name: "must_not_be_used" }] } };
    const answer = parseMcpResponse(format === "json" ? JSON.stringify(frame) : events(frame), "list-1");
    expect(answer).toEqual({ error });
    expect(answer).not.toHaveProperty("id");
    expect(answer).not.toHaveProperty("result");
  });

  it("prefers a correlated response over null-ID diagnostics in either SSE order", () => {
    const answer = response("list-1");
    const diagnostic = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    expect(parseMcpResponse(events(diagnostic, answer), "list-1")).toEqual(answer);
    expect(parseMcpResponse(events(answer, diagnostic), "list-1")).toEqual(answer);
  });

  it.each([
    { jsonrpc: "2.0", id: null, result: { tools: [] } },
    { jsonrpc: "2.0", id: null, method: "ping", error: { message: "not a reply" } },
    { jsonrpc: "2.0", error: { message: "missing id" } },
    { jsonrpc: "2.0", id: null, error: "invalid error shape" },
  ])("does not promote invalid null-ID frames to replies", (frame) => {
    expect(parseMcpResponse(JSON.stringify(frame), "list-1")).toBeNull();
    expect(parseMcpResponse(events(frame), "list-1")).toBeNull();
  });

});

describe("tools/list fallback cache", () => {
  it.each(["json", "sse"] as const)("does not cache an unrelated %s result", async (format) => {
    const backend = `uncorrelated-${format}`;
    const payload = { jsonrpc: "2.0", id: "list-1", method: "tools/list" };
    const answer = response("another-request");
    await withToolsListFallback(backend, payload, async () => new Response(format === "json" ? JSON.stringify(answer) : events(answer)));

    const failed = await withToolsListFallback(backend, { ...payload, id: "list-2" }, async () => new Response("unavailable", { status: 503 }));

    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe("unavailable");
  });

  it("replays a correlated cached list with the new request's ID", async () => {
    const payload = { jsonrpc: "2.0", id: "list-1", method: "tools/list" };
    await withToolsListFallback("correlated", payload, async () => Response.json(response("list-1")));

    const fallback = await withToolsListFallback("correlated", { ...payload, id: "list-2" }, async () => new Response(null, { status: 429 }));

    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toEqual(response("list-2"));
  });

  it.each(["json", "sse"] as const)("never caches a null-ID %s error even if it also carries result data", async (format) => {
    const backend = `null-error-${format}`;
    const payload = { jsonrpc: "2.0", id: "list-1", method: "tools/list" };
    const error = { code: -32700, message: "Invalid JSON from this client" };
    const frame = { jsonrpc: "2.0", id: null, error, result: { tools: [{ name: "untrusted" }] } };
    const failed = await withToolsListFallback(backend, payload, async () => new Response(format === "json" ? JSON.stringify(frame) : events(frame)));
    expect(parseMcpResponse(await failed.text(), payload.id)).toEqual({ error });
    const later = await withToolsListFallback(backend, { ...payload, id: "list-2" }, async () => new Response("unavailable", { status: 503 }));
    expect(later.status).toBe(503);
    expect(await later.text()).toBe("unavailable");
  });

  it("does not cache a correlated frame that contains an RPC error", async () => {
    const payload = { jsonrpc: "2.0", id: "list-1", method: "tools/list" };
    await withToolsListFallback("correlated-error", payload, async () => Response.json({
      ...response("list-1"), error: { code: -32603, message: "Internal error" },
    }));
    const later = await withToolsListFallback("correlated-error", payload, async () => new Response(null, { status: 503 }));
    expect(later.status).toBe(503);
  });

});


describe("paginated tools/list fallback", () => {
  const page = (id: string, cursor?: string) => ({ jsonrpc: "2.0", id, method: "tools/list", params: cursor === undefined ? {} : { cursor } });
  const reply = (id: string, name: string, nextCursor?: string) => Response.json({ jsonrpc: "2.0", id, result: { tools: [{ name }], ...(nextCursor === undefined ? {} : { nextCursor }) } });
  const deferredResponse = () => {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((done) => { resolve = done; });
    return { promise, resolve };
  };

  it("keeps first and continuation pages separate during a backend outage", async () => {
    const backend = "pages-outage";
    await withToolsListFallback(backend, page("seed-first"), async () => reply("seed-first", "read", "second"));
    await withToolsListFallback(backend, page("seed-second", "second"), async () => reply("seed-second", "write"));
    const first = await withToolsListFallback(backend, page("retry-first"), async () => new Response(null, { status: 503 }));
    expect(await first.json()).toEqual({ jsonrpc: "2.0", id: "retry-first", result: { tools: [{ name: "read" }], nextCursor: "second" } });
    const second = await withToolsListFallback(backend, page("retry-second", "second"), async () => new Response(null, { status: 429 }));
    expect(await second.json()).toEqual({ jsonrpc: "2.0", id: "retry-second", result: { tools: [{ name: "write" }] } });
  });

  it("does not substitute a cached first page for a never-seen cursor", async () => {
    const backend = "unseen-page";
    await withToolsListFallback(backend, page("seed"), async () => reply("seed", "read", "missing"));
    const response = await withToolsListFallback(backend, page("missing", "missing"), async () => new Response("unavailable", { status: 503 }));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("unavailable");
  });

  it("does not suppress a network failure using another page", async () => {
    const backend = "unseen-network-page";
    await withToolsListFallback(backend, page("seed"), async () => reply("seed", "read", "missing"));
    const error = new Error("network disconnected");
    await expect(withToolsListFallback(backend, page("missing", "missing"), async () => { throw error; })).rejects.toBe(error);
  });

  it("replays the matching continuation page after a transport failure", async () => {
    const backend = "matching-network-page";
    await withToolsListFallback(backend, page("seed", "second"), async () => reply("seed", "write"));
    const response = await withToolsListFallback(backend, page("retry", "second"), async () => { throw new Error("offline"); });
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: "retry", result: { tools: [{ name: "write" }] } });
  });

  it("treats an empty cursor as a distinct opaque continuation token", async () => {
    const backend = "empty-page-cursor";
    await withToolsListFallback(backend, page("first"), async () => reply("first", "read", ""));
    await withToolsListFallback(backend, page("empty", ""), async () => reply("empty", "write"));
    const response = await withToolsListFallback(backend, page("first-again"), async () => new Response(null, { status: 503 }));
    expect(await response.json()).toMatchObject({ result: { tools: [{ name: "read" }], nextCursor: "" } });
  });

  it("does not serve fallback pages for invalid cursor values", async () => {
    const backend = "invalid-page-cursor";
    await withToolsListFallback(backend, page("seed"), async () => reply("seed", "read"));
    for (const cursor of [null, 1, {}, []]) {
      const response = await withToolsListFallback(backend, { ...page("invalid"), params: { cursor } }, async () => new Response("bad cursor", { status: 503 }));
      expect(response.status).toBe(503);
    }
  });

  it("never shares cached pages between backend identities", async () => {
    await withToolsListFallback("page-owner-A", page("seed", "second"), async () => reply("seed", "private_tool"));
    const response = await withToolsListFallback("page-owner-B", page("read", "second"), async () => new Response(null, { status: 503 }));
    expect(response.status).toBe(503);
  });

  it("retires old continuation pages when a fresh discovery succeeds", async () => {
    const backend = "rotating-page-cursors";
    for (let round = 0; round < 20; round++) {
      const cursor = `page-${round}`;
      const firstId = `first-${round}`;
      const secondId = `second-${round}`;
      await withToolsListFallback(backend, page(firstId), async () => reply(firstId, "read", cursor));
      await withToolsListFallback(backend, page(secondId, cursor), async () => reply(secondId, "write"));
      const current = await withToolsListFallback(backend, page("current", cursor), async () => new Response(null, { status: 503 }));
      expect(await current.json()).toMatchObject({ result: { tools: [{ name: "write" }] } });
      if (round > 0) {
        const previous = await withToolsListFallback(backend, page("old", `page-${round - 1}`), async () => new Response(null, { status: 503 }));
        expect(previous.status).toBe(503);
      }
    }
  });

  it("does not restore an old cursor when its in-flight response arrives after a fresh discovery", async () => {
    const backend = "late-old-page";
    await withToolsListFallback(backend, page("old-first"), async () => reply("old-first", "old_read", "old"));
    const held = deferredResponse();
    const oldPage = withToolsListFallback(backend, page("old-page", "old"), () => held.promise);

    await withToolsListFallback(backend, page("new-first"), async () => reply("new-first", "read", "new"));
    await withToolsListFallback(backend, page("new-page", "new"), async () => reply("new-page", "write"));
    held.resolve(reply("old-page", "old_write"));
    expect(await (await oldPage).json()).toMatchObject({ result: { tools: [{ name: "old_write" }] } });

    const oldFallback = await withToolsListFallback(backend, page("retry-old", "old"), async () => new Response(null, { status: 503 }));
    expect(oldFallback.status).toBe(503);
    const currentFallback = await withToolsListFallback(backend, page("retry-new", "new"), async () => new Response(null, { status: 503 }));
    expect(await currentFallback.json()).toMatchObject({ result: { tools: [{ name: "write" }] } });
  });

  it("retains concurrent continuation pages when clients resume against an empty cache", async () => {
    const backend = "cold-concurrent-pages";
    const heldA = deferredResponse();
    const heldB = deferredResponse();
    const pageA = withToolsListFallback(backend, page("page-a", "a"), () => heldA.promise);
    const pageB = withToolsListFallback(backend, page("page-b", "b"), () => heldB.promise);
    heldA.resolve(reply("page-a", "read"));
    await pageA;
    heldB.resolve(reply("page-b", "write"));
    await pageB;

    for (const [cursor, name] of [["a", "read"], ["b", "write"]]) {
      const fallback = await withToolsListFallback(backend, page(`retry-${cursor}`, cursor), async () => new Response(null, { status: 503 }));
      expect(await fallback.json()).toMatchObject({ result: { tools: [{ name }] } });
    }
  });
});
