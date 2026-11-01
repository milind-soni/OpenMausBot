import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";

const FAKE_MCP = fileURLToPath(new URL("./testing/fake-mcp-server.ts", import.meta.url));

// This fixture runs bots unboxed, as a desktop does, so a server a bot adds stays every bot's; where bots are boxed it is
// that bot's own (server/host/mcp-servers-host.test.ts).
it("a bot's server from a conversation folder is kept in its own folder, and a server that doesn't start rides along on no bot's turns", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-own-mcp-"));
  const gate = join(scratch, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result).slice(0, 400)}`).toBe(expected);
    return result;
  };
  let sends = 0;
  const turnOf = async (bot: { id: string; threadId: string }) => {
    sends += 1;
    const text = `Use your tools, take ${sends}`;
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId: `own-mcp-e2e-send-${String(sends).padStart(4, "0")}` }, 202);
    let dump: any;
    await expect.poll(() => {
      try { dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return false; }
      return String(dump.cwd).includes(bot.id) && JSON.stringify(dump.prompt).includes(text);
    }, { timeout: 20_000 }).toBe(true);
    return { mounts: dump.mcpConfig.mcpServers as Record<string, any>, settled: async () => {
      await expect.poll(async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).messages
        .some((message: any) => message.role === "bot" && String(message.text).startsWith("reply to:") && String(message.text).includes(text)), { timeout: 20_000 }).toBe(true);
    } };
  };
  try {
    const iris = (await api("POST", "/api/bots", { name: "Iris" }, 201)).bot;
    const paul = (await api("POST", "/api/bots", { name: "Paul" }, 201)).bot;
    const first = await turnOf(iris);
    const token: string = first.mounts.agents.env.OMB_COMMS_TOKEN;

    // Iris writes a server into this conversation's folder and adds it, as it did on the Cloud.
    const chatFolder = join(fixture.info.dataDir, "task-workspaces", iris.id, iris.threadId, "sketch");
    mkdirSync(chatFolder, { recursive: true });
    copyFileSync(FAKE_MCP, join(chatFolder, "server.ts"));
    const added = await api("POST", "/api/internal/mcp-servers", { name: "sketch", command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", join(chatFolder, "server.ts")] }, 201, token);
    expect(added).toMatchObject({ name: "sketch", keptIn: [join("tools", "sketch")], enabled: false });
    expect(added.own).toBeUndefined();
    const kept = join(fixture.info.dataDir, "workspaces", iris.id, "tools", "sketch", "server.ts");
    const stored = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).mcpServers.sketch;
    expect(stored).toMatchObject({ args: ["--experimental-strip-types", "--no-warnings", kept] });
    expect(stored.bot).toBeUndefined();
    writeFileSync(gate, "");
    await first.settled();
    await api("PATCH", "/api/mcp/servers/sketch", { enabled: true });

    // The person adds one that can't start anywhere.
    await api("POST", "/api/mcp/servers", { name: "broken", command: process.execPath, args: ["-e", "process.exit(1)"] }, 201);
    await api("PATCH", "/api/mcp/servers/broken", { enabled: true });

    let listed: any[] = [];
    await expect.poll(async () => {
      listed = (await api("GET", "/api/mcp/servers")).servers;
      return listed.find((server) => server.name === "broken")?.offFor?.length ?? 0;
    }, { timeout: 20_000 }).toBe(3);
    expect(listed.find((server) => server.name === "sketch")).toMatchObject({ enabled: true });
    expect(listed.find((server) => server.name === "sketch").offFor).toBeUndefined();

    const pauls = (await turnOf(paul)).mounts;
    expect(pauls.agents).toBeDefined();
    expect(JSON.stringify(pauls.sketch), "every bot reaches Iris's folder here").toContain(JSON.stringify(kept).slice(1, -1));
    expect(pauls.broken, "a server that doesn't start for Paul").toBeUndefined();
    const iriss = (await turnOf(iris)).mounts;
    expect(JSON.stringify(iriss.sketch), "Iris's turn starts it from its own folder").toContain(JSON.stringify(kept).slice(1, -1));
    expect(iriss.broken).toBeUndefined();

    const notices = (await api("GET", "/api/notifications")).notifications.filter((entry: any) => entry.kind === "notice");
    expect(notices.map((entry: any) => entry.body)).toEqual(["The Broken tool doesn't start, so it's off for now. It comes back on its own once it starts."]);
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 90_000);
