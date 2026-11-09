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
