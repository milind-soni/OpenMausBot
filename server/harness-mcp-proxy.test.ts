import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harnessMcpRequest } from "./harness-mcp-proxy.ts";

let server: Server;
let url = "";
let status = 200;
let payload: unknown = { result: { tools: [{ name: "agent_browser_snapshot" }] } };
const requests: Array<{ path: string | undefined; auth: string | undefined; body: unknown }> = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
const connection = (kind: "browser" | "computer" | "data" = "browser") => ({ url, token: "scoped-capability", kind });
const frame = (method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method, params });

describe("harness MCP capability proxy", () => {
  it("answers initialize/ping locally and ignores notifications", async () => {
    const count = requests.length;
    await expect(harnessMcpRequest(frame("initialize"), connection())).resolves.toMatchObject({ result: { capabilities: { tools: {} } } });
    await expect(harnessMcpRequest(frame("ping"), connection())).resolves.toMatchObject({ result: {} });
    await expect(harnessMcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, connection())).resolves.toBeUndefined();
    expect(requests.length).toBe(count);
  });

  it("relays only the RPC result and scoped capability, not a session/engine command", async () => {
    status = 200;
    payload = { result: { tools: [{ name: "agent_browser_snapshot" }] } };
    await expect(harnessMcpRequest(frame("tools/list"), connection())).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "agent_browser_snapshot" }] } });
    expect(requests.at(-1)).toEqual({ path: "/api/internal/browser/mcp", auth: "Bearer scoped-capability", body: { method: "tools/list", params: {} } });
    payload = { result: { content: [{ type: "image", data: "jpeg", mimeType: "image/jpeg" }] } };
    await expect(harnessMcpRequest(frame("tools/call", { name: "agent_browser_snapshot" }), connection())).resolves.toMatchObject({ result: { content: [{ type: "image", data: "jpeg" }] } });
  });

  it("sends the cloud computer's calls to its own harness route", async () => {
    status = 200;
    payload = { result: { tools: [{ name: "screenshot" }] } };
    await expect(harnessMcpRequest(frame("initialize"), connection("computer"))).resolves.toMatchObject({ result: { serverInfo: { name: "openmausbot-computer" } } });
    await expect(harnessMcpRequest(frame("tools/list"), connection("computer"))).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "screenshot" }] } });
    expect(requests.at(-1)).toEqual({ path: "/api/internal/computer/mcp", auth: "Bearer scoped-capability", body: { method: "tools/list", params: {} } });
    status = 401;
    payload = { error: "the internal turn capability has expired" };
    const refused = await harnessMcpRequest(frame("tools/call", { name: "exec", arguments: { command: "true" } }), connection("computer")) as any;
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("expired");
    expect(refused.result.content[0].text).toContain("cloud computer");
    expect(refused.result.content[0].text).not.toContain("select_computer");
  });

  it("sends the Data tools' calls to their own harness route, with the dialect instructions at initialize", async () => {
    status = 200;
    payload = { result: { tools: [{ name: "data_sql" }], instructions: "DuckDB" } };
    const initialized = await harnessMcpRequest(frame("initialize"), connection("data")) as { result: { serverInfo: { name: string }; instructions?: string } };
    expect(initialized.result.serverInfo.name).toBe("openmausbot-data");
    expect(initialized.result.instructions).toContain("GROUP BY ALL");
    // the browser and the computer carry no instructions
    expect(((await harnessMcpRequest(frame("initialize"), connection("browser"))) as { result: Record<string, unknown> }).result.instructions).toBeUndefined();
    await expect(harnessMcpRequest(frame("tools/list"), connection("data"))).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "data_sql" }], instructions: "DuckDB" } });
    expect(requests.at(-1)).toEqual({ path: "/api/internal/data/mcp", auth: "Bearer scoped-capability", body: { method: "tools/list", params: {} } });
    status = 503;
    payload = { error: "Data tools are unavailable: the DuckDB binding did not load" };
    const refused = await harnessMcpRequest(frame("tools/call", { name: "data_sql", arguments: { sql: "SELECT 1" } }), connection("data")) as any;
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("DuckDB binding");
    expect(refused.result.content[0].text).toContain("data_describe");
  });

  it("fails closed with an MCP tool refusal, but tools/list uses an RPC error", async () => {
    status = 403;
    payload = { error: "Browser tools are paused while a person controls this browser." };
    await expect(harnessMcpRequest(frame("tools/call"), connection())).resolves.toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("paused") }] } });
    await expect(harnessMcpRequest(frame("tools/list"), connection())).resolves.toMatchObject({ error: { code: -32603, message: expect.stringContaining("paused") } });
  });

  it.each(["https://example.com", "http://127.0.0.1.evil.test", "http://user:pass@127.0.0.1", "http://127.0.0.1/path", "http://127.0.0.1/#secret"])("never sends its capability to invalid harness URL %s", async (badUrl) => {
    const count = requests.length;
    await expect(harnessMcpRequest(frame("tools/call"), { url: badUrl, token: "private", kind: "browser" })).resolves.toMatchObject({ result: { isError: true } });
    expect(requests.length).toBe(count);
  });

  it("rejects arbitrary RPC methods, missing capabilities, and oversized payloads without reaching the server", async () => {
    const count = requests.length;
    await expect(harnessMcpRequest(frame("resources/read"), connection())).resolves.toMatchObject({ error: { code: -32601 } });
    await expect(harnessMcpRequest(frame("tools/call"), { url, token: "", kind: "computer" })).resolves.toMatchObject({ result: { isError: true } });
    await expect(harnessMcpRequest(frame("tools/call", { text: "x".repeat(1_048_577) }), connection())).resolves.toMatchObject({ result: { isError: true } });
    expect(requests.length).toBe(count);
  });

  it("runs as the actual stdin/stdout MCP entry point with no engine credentials", async () => {
    status = 200;
    payload = { result: { tools: [{ name: "agent_browser_snapshot" }] } };
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./harness-mcp-proxy.ts", import.meta.url)), "computer"], {
      env: { OMB_HARNESS_URL: url, OMB_MCP_TOKEN: "entrypoint-capability" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Proxy did not respond")), 3_000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.split("\n")[0])); }
      });
      child.on("error", reject);
    });
    try {
      child.stdin.write(`${JSON.stringify(frame("tools/list"))}\n`);
      await expect(result).resolves.toMatchObject({ result: { tools: [{ name: "agent_browser_snapshot" }] } });
      expect(requests.at(-1)).toMatchObject({ path: "/api/internal/computer/mcp", auth: "Bearer entrypoint-capability" });
    } finally {
      child.kill();
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  });

  it("refuses to start without a known tool family", async () => {
    const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./harness-mcp-proxy.ts", import.meta.url)), "shell"], {
      env: { OMB_HARNESS_URL: url, OMB_MCP_TOKEN: "entrypoint-capability" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code).toBe(2);
  });
});
