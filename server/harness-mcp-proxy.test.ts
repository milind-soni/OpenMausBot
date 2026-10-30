import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEVICE_PROXY_TIMEOUT_MS, HARNESS_PROXY_TIMEOUT_MS } from "./harness-budget.ts";
import { OUTBOUND_HOLD_MS } from "./outbound-hold.ts";
import { PHONE_RECOVERY } from "./phones/instructions.ts";
import { PHONE_RECONNECT_WAIT_MS, PHONE_SEND_TIMEOUT_MS } from "./phones/jobs.ts";
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
const connection = (kind: "browser" | "computer" | "data" | "highlevel" | "device" = "browser") => ({ url, token: "scoped-capability", kind });
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

  it("sends HighLevel calls to their own harness route with the CRM instructions", async () => {
    status = 200;
    payload = { result: { tools: [{ name: "HIGHLEVEL_GET_CONTACT" }], instructions: "crm" } };
    await expect(harnessMcpRequest(frame("initialize"), connection("highlevel"))).resolves.toMatchObject({ result: { serverInfo: { name: "openmausbot-highlevel" }, instructions: expect.stringContaining("never send SMS") } });
    await expect(harnessMcpRequest(frame("tools/list"), connection("highlevel"))).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "HIGHLEVEL_GET_CONTACT" }], instructions: "crm" } });
    expect(requests.at(-1)).toEqual({ path: "/api/internal/highlevel/mcp", auth: "Bearer scoped-capability", body: { method: "tools/list", params: {} } });
    status = 401;
    payload = { error: "the internal turn capability has expired" };
    const refused = await harnessMcpRequest(frame("tools/call", { name: "HIGHLEVEL_ADD_NOTE", arguments: {} }), connection("highlevel")) as any;
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("never message anyone through the CRM");
  });

  it("forwards device calls to /api/internal/device/mcp with the phone recovery text", async () => {
    status = 200;
    payload = { result: { tools: [{ name: "phone_send" }] } };
    await harnessMcpRequest(frame("tools/list"), connection("device"));
    expect(requests.at(-1)).toEqual({ path: "/api/internal/device/mcp", auth: "Bearer scoped-capability", body: { method: "tools/list", params: {} } });
    await expect(harnessMcpRequest(frame("initialize"), connection("device"))).resolves.toMatchObject({ result: { instructions: expect.stringContaining("phone") } });
    status = 503;
    payload = { error: "no phone is connected" };
    const refused = await harnessMcpRequest(frame("tools/call", { name: "phone_send", arguments: {} }), connection("device")) as any;
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain(PHONE_RECOVERY.trim());
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

  it("tells a restarting server, a restart during the call and a timeout apart", async () => {
    const textOf = (answer: unknown) => (answer as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    const click = frame("tools/call", { name: "agent_browser_click", arguments: { selector: "@e1" } });
    const listening = async (handler?: (req: IncomingMessage) => void) => {
      const peer = createServer((req) => handler?.(req));
      await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
      return { peer, url: `http://127.0.0.1:${(peer.address() as { port: number }).port}` };
    };
    const gone = await listening();
    await new Promise<void>((resolve) => gone.peer.close(() => resolve()));
    expect(textOf(await harnessMcpRequest(click, { url: gone.url, token: "t", kind: "browser" })))
      .toMatch(/^OpenMausBot is restarting, so this browser call did not reach it and did not run\. Wait a few seconds/);
    const resetting = await listening((req) => req.socket.destroy());
    try {
      expect(textOf(await harnessMcpRequest(click, { url: resetting.url, token: "t", kind: "computer" })))
        .toMatch(/^OpenMausBot restarted while this cloud computer call was running, so it may or may not have taken effect\./);
    } finally { await new Promise<void>((resolve) => resetting.peer.close(() => resolve())); }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }));
    try {
      const late = textOf(await harnessMcpRequest(click, connection()));
      expect(late).toMatch(new RegExp(`^OpenMausBot did not answer this browser call within ${HARNESS_PROXY_TIMEOUT_MS / 1_000} seconds\\. It may still be running`));
      expect(late).not.toMatch(/restart/i);
    } finally { vi.unstubAllGlobals(); }
  });

  it("reports the device call's own timeout, not the default: the send hold, the send's phone job, the reconnect window and a margin", async () => {
    expect(DEVICE_PROXY_TIMEOUT_MS).toBe(OUTBOUND_HOLD_MS + PHONE_SEND_TIMEOUT_MS + PHONE_RECONNECT_WAIT_MS + 30_000);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }));
    try {
      const answer = await harnessMcpRequest(frame("tools/call", { name: "phone_send", arguments: {} }), connection("device")) as { result: { content: Array<{ text: string }> } };
      expect(answer.result.content[0]!.text).toContain("within 705 seconds");
    } finally { vi.unstubAllGlobals(); }
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
      // Codex hands every server the same environment: each reads only its own family's token.
      env: { OMB_HARNESS_URL: url, OMB_MCP_TOKEN_COMPUTER: "entrypoint-capability", OMB_MCP_TOKEN_DATA: "data-capability" }, stdio: ["pipe", "pipe", "pipe"],
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
      env: { OMB_HARNESS_URL: url, OMB_MCP_TOKEN_BROWSER: "entrypoint-capability" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code).toBe(2);
  });
});
