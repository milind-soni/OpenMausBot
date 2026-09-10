import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserProxyRequest } from "./browser-proxy.ts";

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
const connection = () => ({ url, token: "scoped-capability" });
const frame = (method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method, params });

describe("browser capability proxy", () => {
  it("answers initialize/ping locally and ignores notifications", async () => {
    const count = requests.length;
    await expect(browserProxyRequest(frame("initialize"), connection())).resolves.toMatchObject({ result: { capabilities: { tools: {} } } });
    await expect(browserProxyRequest(frame("ping"), connection())).resolves.toMatchObject({ result: {} });
    await expect(browserProxyRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, connection())).resolves.toBeUndefined();
    expect(requests.length).toBe(count);
  });

  it("relays only the RPC result and scoped capability, not a session/engine command", async () => {
    status = 200;
    payload = { result: { tools: [{ name: "agent_browser_snapshot" }] } };
    await expect(browserProxyRequest(frame("tools/list"), connection())).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "agent_browser_snapshot" }] } });
    expect(requests.at(-1)).toEqual({ path: "/api/internal/browser/mcp", auth: "Bearer scoped-capability", body: { method: "tools/list", params: {} } });
    payload = { result: { content: [{ type: "image", data: "jpeg", mimeType: "image/jpeg" }] } };
    await expect(browserProxyRequest(frame("tools/call", { name: "agent_browser_snapshot" }), connection())).resolves.toMatchObject({ result: { content: [{ type: "image", data: "jpeg" }] } });
  });

  it("fails closed with an MCP tool refusal, but tools/list uses an RPC error", async () => {
    status = 403;
    payload = { error: "Browser tools are paused while a person controls this browser." };
    await expect(browserProxyRequest(frame("tools/call"), connection())).resolves.toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("paused") }] } });
    await expect(browserProxyRequest(frame("tools/list"), connection())).resolves.toMatchObject({ error: { code: -32603, message: expect.stringContaining("paused") } });
  });

  it.each(["https://example.com", "http://127.0.0.1.evil.test", "http://user:pass@127.0.0.1", "http://127.0.0.1/path", "http://127.0.0.1/#secret"])("never sends its capability to invalid harness URL %s", async (badUrl) => {
    const count = requests.length;
    await expect(browserProxyRequest(frame("tools/call"), { url: badUrl, token: "private" })).resolves.toMatchObject({ result: { isError: true } });
    expect(requests.length).toBe(count);
  });

  it("rejects arbitrary RPC methods, missing capabilities, and oversized payloads without reaching the server", async () => {
    const count = requests.length;
    await expect(browserProxyRequest(frame("resources/read"), connection())).resolves.toMatchObject({ error: { code: -32601 } });
    await expect(browserProxyRequest(frame("tools/call"), { url, token: "" })).resolves.toMatchObject({ result: { isError: true } });
    await expect(browserProxyRequest(frame("tools/call", { text: "x".repeat(1_048_577) }), connection())).resolves.toMatchObject({ result: { isError: true } });
    expect(requests.length).toBe(count);
  });

  it("runs as the actual stdin/stdout MCP entry point with no engine credentials", async () => {
    status = 200;
    payload = { result: { tools: [{ name: "agent_browser_snapshot" }] } };
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./browser-proxy.ts", import.meta.url))], {
      env: { OMB_HARNESS_URL: url, OMB_BROWSER_TOKEN: "entrypoint-capability" }, stdio: ["pipe", "pipe", "pipe"],
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
      expect(requests.at(-1)?.auth).toBe("Bearer entrypoint-capability");
    } finally {
      child.kill();
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  });
});
