// Contract test for the dweb MCP proxy: launch the real stdio entrypoint
// against a scripted daemon and exercise its HTTP-to-MCP translation.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "dweb-proxy.ts");

let stub: Server;
let stubPort = 0;
let child: ChildProcess;
let repoStatus = 200;
let runBody: unknown;
let runResponse: unknown = { status: "ok", output: "model output" };
const pending = new Map<number, (message: any) => void>();
let nextId = 1;

function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10_000).unref?.();
  });
}

const callTool = (name: string, args: unknown = {}) => rpc("tools/call", { name, arguments: args });

beforeAll(async () => {
  stub = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/ping") {
      return res.end(JSON.stringify({ status: "ok", server: "dweb-test", peers: 2 }));
    }
    if (req.method === "GET" && req.url === "/api/repo/status") {
      res.statusCode = repoStatus;
      return res.end(
        JSON.stringify(repoStatus === 200 ? { repo: "Astra", branch: "main", commit: "abc123" } : { error: "offline" }),
      );
    }
    if (req.method === "GET" && req.url === "/api/opencode/models") {
      return res.end(JSON.stringify({ models: [{ id: "openai/gpt-test" }] }));
    }
    if (req.method === "POST" && req.url === "/api/opencode/run") {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        runBody = JSON.parse(data);
        res.end(JSON.stringify(runResponse));
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubPort = (stub.address() as { port: number }).port;

  child = spawn(process.execPath, [PROXY], {
    env: { ...process.env, DWEB_URL: `http://127.0.0.1:${stubPort}` },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffer = "";
  child.stdout!.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
});

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

describe("dweb-proxy MCP surface", () => {
  it("answers the handshake and lists all dweb tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.result.serverInfo.name).toBe("dweb-proxy");
    const list = await rpc("tools/list");
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "dweb_status",
      "dweb_repo_status",
      "dweb_opencode_models",
      "dweb_opencode_run",
    ]);
  });

  it("renders daemon status and model data", async () => {
    const status = await callTool("dweb_status");
    expect(status.result.content[0].text).toContain("server: dweb-test");
    const models = await callTool("dweb_opencode_models");
    expect(models.result.content[0].text).toContain("openai/gpt-test");
  });

  it("forwards opencode runs with the selected model", async () => {
    runResponse = { status: "ok", output: "model output" };
    const result = await callTool("dweb_opencode_run", { command: "inspect", model: "openai/gpt-test" });
    expect(result.result.content[0].text).toBe("model output");
    expect(runBody).toEqual({ command: "inspect", model: "openai/gpt-test" });
  });

  it("rejects malformed opencode arguments before calling the daemon", async () => {
    const command = await callTool("dweb_opencode_run", { command: { nested: true } });
    expect(command.result.isError).toBe(true);
    expect(command.result.content[0].text).toContain("string command");

    const model = await callTool("dweb_opencode_run", { command: "inspect", model: 42 });
    expect(model.result.isError).toBe(true);
    expect(model.result.content[0].text).toContain("model must be a string");
  });

  it("adds the daemon URL to errors from every tool", async () => {
    repoStatus = 503;
    const result = await callTool("dweb_repo_status");
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain(`http://127.0.0.1:${stubPort}`);
    expect(result.result.content[0].text).toContain("offline");

    runResponse = { status: "error", error: "model unavailable" };
    const run = await callTool("dweb_opencode_run", { command: "inspect" });
    expect(run.result.isError).toBe(true);
    expect(run.result.content[0].text).toContain(`http://127.0.0.1:${stubPort}`);
    expect(run.result.content[0].text).toContain("model unavailable");
  });
});
