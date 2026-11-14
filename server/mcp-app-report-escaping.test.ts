import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { APP_REPORT_MAX_BYTES, AppObserver, type McpAppReport } from "./mcp-app-observer.ts";

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

  it("still refuses a report whose arguments alone exceed the budget", async () => {
    const { reports, logs } = await observe("small", { document: "a".repeat(APP_REPORT_MAX_BYTES) });
    expect(reports).toEqual([]);
    expect(logs).toEqual(["show: the call is too large to show as an app"]);
  });
});
