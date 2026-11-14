// Real server and connected-apps bridge, a fake Claude CLI that starts the connection as a model does, and a loopback connection service.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("/setup connects an app through a Connect card, against the real server", () => {
  let home = "";
  let data = "";
  let dump = "";
  let output = "";
  let child: ChildProcess | null = null;
  let base = "";
  let broker: Server;
  let brokerUrl = "";

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: NoInfer<T>) => boolean, what: string): Promise<T> {
    const end = Date.now() + 30_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`${what} wait expired: ${JSON.stringify(value)}\n${output.slice(-3_000)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=50`)).messages as any[];
  const idle = (botId: string) => until(
    async () => (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === botId),
    (bot: any) => bot && !bot.busy, "idle bot");
  const setupTurn = async (bot: { id: string; threadId: string }) => {
    rmSync(dump, { force: true });
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "/setup set up my Gmail", threadId: bot.threadId });
    await until(() => existsSync(dump), Boolean, "engine launch");
    await idle(bot.id);
    const seen = JSON.parse(readFileSync(dump, "utf8")) as { systemPrompt: string; mcpConfig: { mcpServers: Record<string, unknown> } };
    return { seen, messages: await messages(bot.threadId) };
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-setup-connect-"));
    data = join(home, "data");
    dump = join(home, "fake-claude-dump.json");
    mkdirSync(data);
    // The managed connection service is present but knows no accounts, so Gmail is not connected.
    broker = createServer((req, res) => {
      req.resume();
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "fixture knows no accounts" }));
    });
    await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
    brokerUrl = `http://127.0.0.1:${(broker.address() as { port: number }).port}/broker`;
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: { claude: {
        driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
        // Every turn with the connected-apps tools starts a Gmail connection through them, as a model told to would.
        environment: { FAKE_CLAUDE_CONNECT_APPS: "gmail", FAKE_CLAUDE_DUMP: dump },
      } },
    }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    const proc = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home, OMB_TEST_SEALED_PATH: "1",
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_USER_DATA: join(home, "user-data"),
        OMB_COMPOSIO_BROKER_URL: brokerUrl, OMB_COMPOSIO_BROKER_TOKEN: "c".repeat(64),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean, "boot");
  }, 60_000);
  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (broker) await new Promise<void>(resolve => broker.close(() => resolve()));
    if (home) await removeTempDir(home);
  });

  it("shows a Connect card for Gmail in the chat when the bot's connected apps are on", async () => {
    const { bot } = await api("POST", "/api/bots", { name: "Inbox" });
    const { seen, messages: chat } = await setupTurn(bot);
    expect(seen.mcpConfig.mcpServers.composio).toBeDefined();
    expect(seen.systemPrompt).toContain("make COMPOSIO_MANAGE_CONNECTIONS for its toolkit (for example gmail) your last tool call");
    expect(seen.systemPrompt).not.toContain("point them to the Access section");
    const call = chat.find(message => message.tool?.name === "mcp__composio__COMPOSIO_MANAGE_CONNECTIONS");
    expect(call?.tool).toMatchObject({ ok: true, output: expect.stringContaining("showed the user a secure connection card for gmail") });
    const card = chat.find(message => message.kind === "connector");
    expect(card, JSON.stringify(chat.map(message => [message.kind, message.text]))).toBeDefined();
    expect(card.connector).toMatchObject({ slug: "gmail", status: "required" });
    expect(card.text).toBe(`Connect ${card.connector.label} to continue.`);
  }, 90_000);

  it("names the switch, and mounts nothing to call, when the bot's connected apps are off", async () => {
    const { bot } = await api("POST", "/api/bots", { name: "Quiet inbox" });
    await api("PATCH", `/api/bots/${bot.id}`, { composio: false });
    const { seen, messages: chat } = await setupTurn(bot);
    expect(seen.mcpConfig.mcpServers.composio).toBeUndefined();
    expect(seen.systemPrompt).toContain("ask the user to turn on Connected apps in your settings under Access");
    expect(seen.systemPrompt).not.toContain("COMPOSIO_MANAGE_CONNECTIONS");
    expect(chat.some(message => message.kind === "connector")).toBe(false);
  }, 90_000);
});
