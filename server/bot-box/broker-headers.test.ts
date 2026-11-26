import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { parseConfigPatch } from "../config.ts";
import { parseMcpServerMutation, parseStoredMcpServer } from "../mcp-registry.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "../testing/fake-http-mcp-server.ts";
import { openCredentialBroker, type CredentialBroker } from "./broker.ts";
import { brokerRewrite } from "./broker-env.ts";
import { guardedHandler, trimmedHeaderValues, unsendableHeader, UNUSABLE_CREDENTIAL } from "./broker-headers.ts";

const KEY = "sk-real-key-0123456789abcdef";
/** As an earlier version saved them: a paste's trailing newline, a control character, a curly quote (beyond Latin-1). */
const NEWLINE = `Bearer ${KEY}\n`, CONTROL = `Bearer ${KEY}\u0001`, CURLY = `Bearer “${KEY}”`;

function call(socketPath: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string; port?: number } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ ...(init.port ? { host: "127.0.0.1", port: init.port } : { socketPath }), path, method: init.method ?? "GET", headers: init.headers ?? {} }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

describe("header values the box's gates send", () => {
  it("trims a key's surrounding whitespace and names the header Node would refuse, never its value", () => {
    expect(trimmedHeaderValues({ authorization: NEWLINE, "x-api-key": "  k  " })).toEqual({ authorization: `Bearer ${KEY}`, "x-api-key": "k" });
    expect(unsendableHeader({ authorization: `Bearer ${KEY}` })).toBeNull();
    expect(unsendableHeader({ "x-ok": "café", authorization: CONTROL })).toBe("authorization");
    expect(unsendableHeader({ authorization: CURLY })).toBe("authorization");
    expect(unsendableHeader({ "bad name": "x" })).toBe("bad name");
  });

  it("a provider key saved with a trailing newline becomes a clean header", () => {
    const rewrite = brokerRewrite({ OPENAI_API_KEY: `${KEY}\n` }, "omb_t0_token", 18080);
    expect(rewrite.grants.openai!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("a saved key is trimmed on save; an MCP header that still cannot be sent is refused on save and read as it is", () => {
    expect(parseConfigPatch({ openai: { key: `${KEY}\n` }, tts: { key: `  ${KEY}` } })).toMatchObject({ openai: { key: KEY }, tts: { key: KEY } });
    const remote = (authorization: string) => ({ type: "http", url: "https://mcp.example.com/mcp", headers: { authorization } });
    expect(parseMcpServerMutation("docs", remote(NEWLINE))).toMatchObject({ ok: true, server: { headers: { authorization: `Bearer ${KEY}` } } });
    const refused = parseMcpServerMutation("docs", remote(CURLY));
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("not allowed") });
    expect(JSON.stringify(refused)).not.toContain(KEY);
    expect(parseStoredMcpServer("docs", { ...remote(NEWLINE), enabled: true })).toMatchObject({ ok: true, server: { headers: { authorization: `Bearer ${KEY}` } } });
    expect(parseStoredMcpServer("docs", { ...remote(CURLY), enabled: true })).toMatchObject({ ok: true });
  });

  it("a handler that throws fails that request (502) and the server keeps answering", async () => {
    const lines: string[] = [];
    const server = createServer(guardedHandler("test gate", (req, res) => {
      if (req.url === "/throw") throw Object.assign(new TypeError(`Invalid character in header content ["authorization"] ${KEY}`), { code: "ERR_INVALID_CHAR" });
      if (req.url === "/reject") return Promise.reject(new Error("later"));
      res.writeHead(200).end("ok");
    }, (line) => lines.push(line)));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await call("", "/throw", { port })).toMatchObject({ status: 502 });
      expect(await call("", "/reject", { port })).toMatchObject({ status: 502 });
      expect(await call("", "/", { port })).toEqual({ status: 200, body: "ok" });
      expect(lines.join("\n")).toContain("ERR_INVALID_CHAR");
      expect(lines.join("\n"), "the log never quotes the message, which may hold the value").not.toContain(KEY);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// The broker listens on a unix socket, which Windows refuses at a file path; the box runs only on a Linux Cloud home.
describe.skipIf(process.platform === "win32")("the credential broker with a saved key it cannot send", () => {
  let upstream: Server | undefined, broker: CredentialBroker | undefined, dir = "", child: ChildProcess | undefined, mcp: FakeHttpMcp | undefined;
  const seen: string[] = [];
  afterEach(async () => {
    child?.kill("SIGKILL");
    child = undefined;
    await broker?.close();
    await mcp?.close();
    if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    broker = undefined; upstream = undefined; mcp = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    seen.length = 0;
  });

  async function start(): Promise<number> {
    // A real upstream and node's own request function: the throw happens where node builds the request.
    upstream = createServer((req, res) => {
      seen.push(String(req.headers.authorization));
      res.writeHead(req.headers.authorization === `Bearer ${KEY}` ? 200 : 401, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    dir = mkdtempSync(join(tmpdir(), "omb-broker-headers-"));
    broker = await openCredentialBroker({ socketPath: join(dir, "b.sock") });
    return (upstream.address() as { port: number }).port;
  }

  it("sends a key saved with a trailing newline, trimmed", async () => {
    const port = await start();
    const { token } = broker!.mintForProcess({ grants: { openai: { upstream: `http://127.0.0.1:${port}/v1`, headers: { authorization: NEWLINE } } } });
    expect(await call(broker!.socketPath, `/b/${token}/openai/models`)).toMatchObject({ status: 200 });
    expect(seen).toEqual([`Bearer ${KEY}`]);
  });

  for (const [what, value] of [["a control character", CONTROL], ["a character beyond Latin-1", CURLY]] as const) {
    it(`fails only the request carrying a key with ${what}, ten times over, and keeps forwarding the others`, async () => {
      const port = await start();
      const { token } = broker!.mintForProcess({ grants: {
        openai: { upstream: `http://127.0.0.1:${port}/v1`, headers: { authorization: value } },
        anthropic: { upstream: `http://127.0.0.1:${port}/v1`, headers: { authorization: `Bearer ${KEY}` } },
      } });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const answer = await call(broker!.socketPath, `/b/${token}/openai/models`, { method: "POST", body: "{}" });
        expect(answer.status).toBe(502);
        expect(JSON.parse(answer.body)).toMatchObject({ error: UNUSABLE_CREDENTIAL, credential: "openai", header: "authorization" });
        expect(answer.body, "the answer never carries the value").not.toContain(KEY);
      }
      expect(seen, "nothing went upstream for the bad key").toEqual([]);
      expect(await call(broker!.socketPath, `/b/${token}/anthropic/models`)).toMatchObject({ status: 200 });
      expect(broker!.stats()).toMatchObject({ forwarded: 1, refused: 10 });
    });
  }

  it("names the MCP server whose saved header cannot be sent", async () => {
    const port = await start();
    const { token } = broker!.mintForThread({ threadId: "t1", grants: { "mcp-docs": { upstream: `http://127.0.0.1:${port}/mcp`, headers: { authorization: CURLY }, mcpServer: "docs" } } });
    const answer = await call(broker!.socketPath, `/b/${token}/mcp-docs`, { method: "POST", body: "{}" });
    expect(answer.status).toBe(502);
    expect(JSON.parse(answer.body)).toMatchObject({ error: UNUSABLE_CREDENTIAL, credential: "the MCP server docs", header: "authorization" });
  });

  it("a home started with bad keys already saved on disk checks its servers at start without crashing, and keeps answering", async () => {
    mcp = await startFakeHttpMcp({ requireHeaders: { authorization: `Bearer ${KEY}` } });
    dir = mkdtempSync(join(tmpdir(), "omb-saved-keys-"));
    // config.json exactly as an earlier version left it: the values were never trimmed or checked beyond CR/LF.
    const server = (authorization: string) => ({ type: "http", url: mcp!.url, headers: { authorization }, enabled: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ mcpServers: { pasted: server(NEWLINE), control: server(CONTROL), curly: server(CURLY) } }));
    const host = fileURLToPath(new URL("../testing/saved-key-broker-host.ts", import.meta.url));
    const proc = spawn(process.execPath, ["--experimental-strip-types", host, dir], { env: { ...process.env, OMB_DATA_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
    child = proc;
    let stderr = "";
    proc.stderr!.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
    const ready = await Promise.race([
      new Promise<{ port: number; answers: Record<string, boolean> }>((resolve) => {
        let out = "";
        proc.stdout!.on("data", (chunk) => { out += chunk; const line = out.split("\n").find((entry) => entry.startsWith("{")); if (line) resolve(JSON.parse(line)); });
      }),
      exited.then((code) => { throw new Error(`the home exited (${code}) at start:\n${stderr.slice(-2000)}`); }),
    ]);
    expect(ready.answers).toEqual({ pasted: true, control: false, curly: false });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const again = await call("", "/check", { port: ready.port, method: "POST" });
      expect(JSON.parse(again.body)).toEqual({ pasted: true, control: false, curly: false });
      expect(await call("", "/health", { port: ready.port })).toEqual({ status: 200, body: "ok" });
    }
    expect(proc.exitCode, "the home is still running").toBeNull();
    expect(stderr).not.toContain("ERR_INVALID_CHAR");
    expect(stderr).not.toContain(KEY);
  }, 60_000);
});
