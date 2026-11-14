import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { APP_REPORT_MAX_BYTES, AppObserver, appReportBody, type McpAppReport } from "./mcp-app-observer.ts";

async function observe(text: string, args: Record<string, unknown> = {}) {
  const reports: Array<{ body: string; headers: IncomingHttpHeaders }> = [];
  const logs: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    reports.push({ body, headers: request.headers });
    response.writeHead(201, { "content-type": "application/json" }).end('{"messageId":"fixture"}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const observer = new AppObserver({ server: "fixture", harnessUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "fixture-token", extension: true }, { log: (message) => logs.push(message) });
    observer.listed({ tools: [{ name: "show", _meta: { ui: { resourceUri: "ui://fixture/view.html" } } }] });
    const result = { content: [{ type: "text", text }] };
    observer.returned({ name: "show", arguments: args }, result);
    await Promise.all(observer.inFlight);
    expect(result).toEqual({ content: [{ type: "text", text }] });
    return { reports, logs };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("MCP app reports with JSON-escaped text", () => {
  it.each(["\n", '"', "\\", "\u0001"])("clips rather than drops a large report containing %j", async (character) => {
    const text = character.repeat(APP_REPORT_MAX_BYTES + 1_000);
    const { reports, logs } = await observe(text, { document: "fixture" });
    expect(logs).toEqual([]);
    expect(reports).toHaveLength(1);
    const sent = reports[0]!;
    expect(Buffer.byteLength(sent.body)).toBeLessThanOrEqual(APP_REPORT_MAX_BYTES);
    expect(Number(sent.headers["content-length"])).toBe(Buffer.byteLength(sent.body));
    expect(sent.headers.authorization).toBe("Bearer fixture-token");
    const body = JSON.parse(sent.body) as McpAppReport;
    expect(body).toMatchObject({ oversized: true, call: { arguments: { document: "fixture" } }, definition: { _meta: { ui: { resourceUri: "ui://fixture/view.html" } } } });
    expect(body.result.content).toHaveLength(1);
    const clipped = body.result.content[0] as { type: string; text: string };
    expect(clipped.type).toBe("text");
    expect(clipped.text.endsWith("…")).toBe(true);
    expect(clipped.text.length).toBeGreaterThan(1);
    expect(text.startsWith(clipped.text.slice(0, -1))).toBe(true);
    expect(clipped.text.length).toBeLessThan(text.length);
  });

  it("preserves a small escaped report without marking it oversized", async () => {
    const text = 'line one\n"line two" \\ 🐭';
    const { reports, logs } = await observe(text);
    expect(logs).toEqual([]);
    expect(reports).toHaveLength(1);
    const body = JSON.parse(reports[0]!.body) as McpAppReport;
    expect(body.oversized).toBeUndefined();
    expect(body.result.content).toEqual([{ type: "text", text }]);
  });

  it("retains a fitting escape-heavy prefix below one percent of the original text", async () => {
    const text = "\u0001".repeat(154_000) + "a".repeat(14_846_000);
    const { reports, logs } = await observe(text);
    expect(logs).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(Buffer.byteLength(reports[0]!.body)).toBeLessThanOrEqual(APP_REPORT_MAX_BYTES);
    const sent = JSON.parse(reports[0]!.body) as McpAppReport;
    const clipped = sent.result.content[0] as { text: string };
    expect(clipped.text.endsWith("…")).toBe(true);
    expect(clipped.text.length).toBeGreaterThan(147_000);
    expect(text.startsWith(clipped.text.slice(0, -1))).toBe(true);
  });

  it.each([
    "\u0001".repeat(20) + "a".repeat(100),
    "a".repeat(100) + "\u0001".repeat(20),
    "🐭".repeat(30) + "z".repeat(40),
  ])("uses the available encoded budget without splitting a character (%#)", (text) => {
    const original: McpAppReport = {
      tool: "mcp_app", server: "fixture", definition: { name: "show", _meta: {} },
      call: { arguments: {} }, result: { content: [{ type: "text", text }] },
    };
    const encode = (prefix: string) => JSON.stringify({ ...original, oversized: true, result: { content: [{ type: "text", text: `${prefix}…` }] } });
    const characters = Array.from(text);
    for (const available of [0, 1, 3, 6, 17, 32]) {
      const cap = Buffer.byteLength(encode("")) + available;
      let expected = "";
      let prefix = "";
      for (const character of characters) {
        prefix += character;
        if (Buffer.byteLength(encode(prefix)) <= cap) expected = prefix;
      }
      const body = appReportBody(original, cap);
      expect(body).not.toBeNull();
      expect(Buffer.byteLength(body!)).toBeLessThanOrEqual(cap);
      expect(JSON.parse(body!).result.content).toEqual([{ type: "text", text: `${expected}…` }]);
    }
    expect(original.result.content).toEqual([{ type: "text", text }]);
  });

  it("still refuses a report whose arguments alone exceed the budget", async () => {
    const { reports, logs } = await observe("small", { document: "a".repeat(APP_REPORT_MAX_BYTES) });
    expect(reports).toEqual([]);
    expect(logs).toEqual(["show: the call is too large to show as an app"]);
  });
});
