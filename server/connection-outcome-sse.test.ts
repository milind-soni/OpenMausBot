import { describe, expect, it } from "vitest";

import { appCallOutcome } from "./connection-outcome.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const frame = (text: string, isError = true) => ({
  jsonrpc: "2.0", id: 1, result: { isError, content: [{ type: "text", text }] },
});

describe("connection health from complete SSE events", () => {
  it.each(["\n", "\r\n", "\r"])("reads multiline errors with %j line endings", (newline) => {
    const lines = JSON.stringify(frame("Token expired; reconnect"), null, 2).split("\n");
    const wire = [": keepalive", "event: message", "data", ...lines.map((line) => `data: ${line}`), "data:", "", ""].join(newline);
    expect(appCallOutcome(200, encode(wire), "text/event-stream"))
      .toEqual({ ok: false, error: "sign-in" });
  });

  it("recognizes an event-stream media type regardless of letter case", () => {
    const wire = `data:${JSON.stringify(frame("403 Forbidden"))}\n\n`;
    expect(appCallOutcome(200, encode(wire), "Text/Event-Stream; charset=utf-8"))
      .toEqual({ ok: false, error: "refused" });
  });

  it("uses the last response while ignoring comments, notifications and malformed events", () => {
    const wire = [
      `data: ${JSON.stringify(frame("Token expired; reconnect"))}`, "",
      ...JSON.stringify(frame("Message not found"), null, 2).split("\n").map((line) => `data:${line}`), "",
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}`, "",
      "data: not JSON", "", ": heartbeat", "", "",
    ].join("\n");
    expect(appCallOutcome(200, encode(wire), "text/event-stream")).toEqual({ ok: true });
  });

  it("does not mistake individual lines inside malformed event data for a response", () => {
    const wire = `data: not JSON\ndata: ${JSON.stringify(frame("Token expired; reconnect"))}\n\n`;
    expect(appCallOutcome(200, encode(wire), "text/event-stream")).toBeNull();
  });

  it("keeps the final stateless response without a trailing blank line", () => {
    const wire = `data:${JSON.stringify(frame("Message not found"))}`;
    expect(appCallOutcome(200, encode(wire), "text/event-stream")).toEqual({ ok: true });
  });

  it("does not classify successful record text as a connection failure", () => {
    const lines = JSON.stringify(frame("A history of 401 Unauthorized errors", false), null, 2).split("\n");
    expect(appCallOutcome(200, encode(`${lines.map((line) => `data:${line}`).join("\n")}\n\n`), "text/event-stream"))
      .toEqual({ ok: true });
  });
});
