// The boxed VPS computer's host-side stand-in: the mount a boxed engine starts, and what the engine's harness proxy
// reaches through it, against a stand-in MCP server in the child seat.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { controlRefusal } from "./control-client.ts";
import { harnessMcpTokenEnv } from "./harness-mcp-token.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { forgetVpsComputers, vpsComputerTools, vpsComputerTurn } from "./vps-computer-rpc.ts";

const BOT = "bot-vps-test";
const TOKEN = "turn-capability-token";
const HARNESS = "http://127.0.0.1:8799";
const HELD = "the person is holding the desktop right now";
const HANDED_BACK = "the person took the desktop while this call waited";

/** A stand-in for the Cua MCP server: MCP over stdio, one answer per line. `tag` marks which child answered;
 * `mode slow` answers its first call 300 ms late; `marker`, when given, takes a line for every call it receives. */
const FAKE_CHILD = [
  `import fs from "node:fs";`,
  `const tag = process.argv[2] ?? "";`,
  `const mode = process.argv[3] ?? "";`,
  `const marker = process.argv[4] ?? "";`,
  `let buf = "", answered = 0;`,
  `const reply = (m) => process.stdout.write(JSON.stringify(m) + "\\n");`,
  `process.stdin.on("data", (c) => {`,
  `  buf += c; let i;`,
  `  while ((i = buf.indexOf("\\n")) !== -1) {`,
  `    const line = buf.slice(0, i); buf = buf.slice(i + 1);`,
  `    if (!line.trim()) continue;`,
  `    let f; try { f = JSON.parse(line); } catch { continue; }`,
  `    if (f.method === "initialize") reply({ jsonrpc: "2.0", id: f.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-cua-" + tag, version: "1" } } });`,
  `    else if (f.method === "tools/list") reply({ jsonrpc: "2.0", id: f.id, result: { tools: [{ name: "screenshot-" + tag }] } });`,
  `    else if (f.method === "tools/call") {`,
  `      if (mode === "die") process.exit(1);`,
  `      answered += 1;`,
  `      if (marker) fs.appendFileSync(marker, "called\\n");`,
  `      const text = "did " + f.params.name + " #" + answered + " on " + tag;`,
  `      const wait = mode === "slow" && answered === 1 ? 300 : 0;`,
  `      setTimeout(() => reply({ jsonrpc: "2.0", id: f.id, result: { content: [{ type: "text", text }] } }), wait);`,
  `    }`,
  `  }`,
  `});`,
].join("\n");

const until = async <T>(read: () => T | Promise<T>, accept: (value: T) => boolean, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= end) throw new Error(`fixture wait expired: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** How many calls the stand-in child wrote to its marker. */
const callsReceived = (marker: string): number =>
  existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter((line) => line === "called").length : 0;

describe("the boxed VPS computer's host-side proxy", () => {
  let home = "";
  let harness: Server;
  let harnessUrl = "";
  let shim: ChildProcess | null = null;
  /** What the stub answered at POST /api/internal/computer/mcp, as harness-mcp-proxy sent it. */
  const relayed: Array<{ auth: string | null; body: { method?: string; params?: { name?: string } } }> = [];
  /** The desktop's takes as the host counts them: a gate refuses a call that arrived before the latest take, as the
   * host's gate refuses one that waited through a person's hold. */
  const takes = { now: 100, lastTake: 0 };
  const gate = { held: false, blockedReason: HELD };
  let mountedBot = BOT;
  /** Each call's turn, as the host ends it when the caller goes away. */
  const turns: AbortController[] = [];
  /** One waiter per JSON-RPC id of the engine side of the shim. */
  const waiting = new Map<number, (message: unknown) => void>();

  const call = (method: string, params: unknown = {}, id = 1): Promise<any> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`no answer to ${method} #${id}`)); }, 20_000);
    timer.unref?.();
    waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
    shim!.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  /** Mounts the stand-in for the bot: `args` are the child's after its tag. */
  const serve = (tag: string, args: string[] = [], command = process.execPath) =>
    vpsComputerTools(BOT, { token: TOKEN }, HARNESS, { sshAlias: "prod-vps", container: `omb-cua-${tag}`, command,
      args: command === process.execPath ? [join(home, "fake-cua.mjs"), tag, ...args] : args });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-vps-rpc-"));
    writeFileSync(join(home, "fake-cua.mjs"), FAKE_CHILD);
    harness = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        const parsed = JSON.parse(body) as { method?: string; params?: { name?: string } };
        relayed.push({ auth: req.headers.authorization ?? null, body: parsed });
        const turn = new AbortController();
        turns.push(turn);
        // As the host's route does: the VPS path ends the response itself, with 403 when the bot has no VPS computer.
        await vpsComputerTurn({
          body: parsed, res,
          json: (_r, status, payload) => {
            if (res.writableEnded) throw new Error("the response was already ended");
            res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload));
          },
          botId: mountedBot,
          assertActive: () => {},
          takeSequence: () => takes.now,
          gate: async (since) => {
            const handedBack = takes.lastTake > since;
            return { held: handedBack || gate.held, helpOpen: false, ...(handedBack ? { blockedReason: HANDED_BACK } : gate.held ? { blockedReason: gate.blockedReason } : {}) };
          },
          signal: turn.signal,
        });
      });
    });
    await new Promise<void>((resolve) => harness.listen(0, "127.0.0.1", resolve));
    harnessUrl = `http://127.0.0.1:${(harness.address() as { port: number }).port}`;
    shim = spawn(process.execPath, ["--experimental-strip-types", SPAWNED_PROXIES.harnessMcp, "computer"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OMB_HARNESS_URL: harnessUrl, [harnessMcpTokenEnv("computer")]: TOKEN },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    shim.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: { id?: unknown } | null = null;
        try { message = JSON.parse(line); } catch { continue; }
        if (message && typeof message.id === "number" && waiting.has(message.id)) waiting.get(message.id)!(message);
      }
    });
    shim.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`harness proxy: ${chunk}`));
  });

  afterAll(async () => {
    await waitForExit(shim ?? undefined, { signal: "SIGKILL" });
    forgetVpsComputers();
    harness.closeAllConnections();
    await new Promise<void>((resolve) => harness.close(() => resolve()));
    removeTempDir(home);
  });

  beforeEach(() => {
    forgetVpsComputers();
    gate.held = false;
    takes.now += 10; takes.lastTake = 0;
    turns.length = 0;
    mountedBot = BOT;
    serve("a", ["a"]);
  });

  it("the boxed mount is the cloud computer's shim with the turn's capability, and registers the VPS target", () => {
    const mount = serve("a", ["a"]);
    expect(mount.command).toBe(process.execPath);
    expect(mount.args).toEqual([expect.stringMatching(/harness-mcp-proxy\.(?:ts|js)$/), "computer"]);
    expect(mount.env.OMB_HARNESS_URL).toBe(HARNESS);
    expect(mount.env[harnessMcpTokenEnv("computer")]).toBe(TOKEN);
    expect(mount.platform).toBe("linux");
  });

  it("the engine's shim reaches the VPS proxy's tools with the turn's capability", async () => {
    await expect(call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "engine", version: "1" } })).resolves.toMatchObject({ result: { serverInfo: { name: "openmausbot-computer" } } });
    await expect(call("tools/list", {}, 2)).resolves.toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "screenshot-a" }] } });
    await expect(call("tools/call", { name: "screenshot", arguments: {} }, 3)).resolves.toEqual({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "did screenshot #1 on a" }] } });
    expect(relayed.at(-2)).toMatchObject({ auth: `Bearer ${TOKEN}`, body: { method: "tools/list" } });
    expect(relayed.at(-1)).toMatchObject({ auth: `Bearer ${TOKEN}`, body: { method: "tools/call", params: { name: "screenshot" } } });
  });

  it("calls act in order on the one desktop", async () => {
    serve("slow", ["slow"]);
    const first = call("tools/call", { name: "screenshot" }, 10);
    const second = call("tools/call", { name: "get_screen_size" }, 11);
    await expect(first).resolves.toMatchObject({ result: { content: [{ text: "did screenshot #1 on slow" }] } });
    await expect(second).resolves.toMatchObject({ result: { content: [{ text: "did get_screen_size #2 on slow" }] } });
  });

  it("a person holding the desktop refuses the call without it reaching the VPS", async () => {
    const marker = join(home, "held.txt");
    serve("held", ["", marker]);
    gate.held = true;
    await expect(call("tools/call", { name: "screenshot" }, 12)).resolves.toEqual({
      jsonrpc: "2.0", id: 12, result: { content: [{ type: "text", text: controlRefusal({ blockedReason: HELD }) }], isError: true },
    });
    expect(callsReceived(marker)).toBe(0);
  });

  it("a person who takes the desktop while a call waits for an earlier one refuses that call", async () => {
    const marker = join(home, "taken.txt");
    serve("slow", ["slow", marker]);
    const first = call("tools/call", { name: "screenshot" }, 20);
    const second = call("tools/call", { name: "click" }, 21);
    await until(() => turns.length, (arrived: number) => arrived >= 2);
    await until(() => callsReceived(marker), count => count === 1);
    takes.lastTake = ++takes.now;
    await expect(first).resolves.toMatchObject({ result: { content: [{ text: "did screenshot #1 on slow" }] } });
    expect((await second).result).toEqual({ content: [{ type: "text", text: HANDED_BACK }], isError: true });
    // The desktop never saw the refused call: a later one, arrived after the take, is the same child's second.
    await expect(call("tools/call", { name: "get_screen_size" }, 22)).resolves.toMatchObject({ result: { content: [{ text: "did get_screen_size #2 on slow" }] } });
  });

  it("a call whose turn ended while it waited for an earlier one is never sent to the desktop", async () => {
    const marker = join(home, "waiting.txt");
    serve("slow", ["slow", marker]);
    const first = call("tools/call", { name: "screenshot" }, 30);
    const second = call("tools/call", { name: "click" }, 31);
    await until(() => turns.length, (arrived: number) => arrived >= 2);
    await until(() => callsReceived(marker), count => count === 1);
    turns[1]!.abort();
    await expect(first).resolves.toMatchObject({ result: { content: [{ text: "did screenshot #1 on slow" }] } });
    expect((await second).result).toMatchObject({ isError: true, content: [{ text: "The turn ended before this call reached the VPS computer, so nothing was run." }] });
    expect(callsReceived(marker)).toBe(1);
    await expect(call("tools/call", { name: "get_screen_size" }, 32)).resolves.toMatchObject({ result: { content: [{ text: "did get_screen_size #2 on slow" }] } });
  });

  it("an aborted call reports uncertainty and keeps its queue slot until the desktop answers", async () => {
    const marker = join(home, "unconfirmed.txt");
    serve("slow", ["slow", marker]);
    const first = call("tools/call", { name: "type_text" }, 40);
    await until(() => callsReceived(marker), (count: number) => count >= 1);
    turns.at(-1)!.abort();
    expect((await first).result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("the result was not confirmed") }] });
    await expect(call("tools/call", { name: "screenshot" }, 41)).resolves.toMatchObject({ result: { content: [{ text: "did screenshot #2 on slow" }] } });
  });

  it("a proxy that cannot start answers the failure instead of letting its start error escape", async () => {
    serve("x", [], join(home, "no-such-proxy"));
    const answer = await call("tools/call", { name: "screenshot" }, 50);
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0].text).toContain("stopped before it connected");
  });

  it("a turn of a bot with no VPS computer answers 403", async () => {
    mountedBot = "other-bot";
    const response = await fetch(harnessUrl + "/api/internal/computer/mcp", { method: "POST", body: JSON.stringify({ method: "tools/list" }) });
    expect(response.status).toBe(403);
    await response.text();
    const answer = await call("tools/list", {}, 13);
    expect(answer.error?.code).toBe(-32603);
    expect(answer.error?.message).toContain("no cloud computer");
  });

  it("a re-provisioned container drops the child that pointed at the old one", async () => {
    await expect(call("tools/list")).resolves.toMatchObject({ result: { tools: [{ name: "screenshot-a" }] } });
    serve("b", ["b"]);
    await expect(call("tools/call", { name: "screenshot" }, 14)).resolves.toMatchObject({ result: { content: [{ text: "did screenshot #1 on b" }] } });
    await expect(call("tools/list", {}, 15)).resolves.toMatchObject({ result: { tools: [{ name: "screenshot-b" }] } });
  });

  it("a child that dies mid-call answers the failure, and a later call starts a new one", async () => {
    serve("die", ["die"]);
    const answer = await call("tools/call", { name: "screenshot" }, 16);
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0].text).toContain("connection was interrupted");
    serve("b", ["b"]);
    await until(async () => (await call("tools/call", { name: "screenshot" }, 17)).result.content[0].text, (text: string) => text.includes("on b"));
  });
});
