import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { APP_EXTENSION_KEY } from "../shared/app.ts";
import { CSP_META_PREFIX } from "../shared/app-frame/document.ts";
import { APP_ONLY_REFUSAL } from "./mcp-app-observer.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const FAKE_APP = fileURLToPath(new URL("./testing/fake-stdio-app-server.ts", import.meta.url));
const BOARD_URI = "ui://fake-app/board.html";

it("learns a server's apps, observes its tool call into an app row, and runs its frame's calls under the bot's rules", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-chat-apps-mcp-"));
  const gate = join(scratch, "finish");
  const frames = join(scratch, "frames.jsonl");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate, FAKE_CLAUDE_VERSION: "2.1.270" });
  const evidence: unknown[] = [];
  let engineSide: ChildProcessWithoutNullStreams | undefined;
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    evidence.push({ method, path, status: response.status, result: path.endsWith("/app") ? { ...result, srcdoc: `${String(result.srcdoc).slice(0, 200)}…` } : result });
    expect(response.status, JSON.stringify(result).slice(0, 400)).toBe(expected);
    return result;
  };
  const dump = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  const logged = () => existsSync(frames) ? readFileSync(frames, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  try {
    await api("POST", "/api/mcp/servers", { name: "board", command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", FAKE_APP], env: { FAKE_APP_LOG: frames } }, 201);
    await api("PATCH", "/api/mcp/servers/board", { enabled: true });
    expect(await api("POST", "/api/mcp/servers/board/test")).toMatchObject({ ok: true });
    expect(logged().find((frame) => frame.method === "initialize").params.capabilities.extensions).toHaveProperty(APP_EXTENSION_KEY);
    const catalog = JSON.parse(readFileSync(join(fixture.info.dataDir, "mcp-app-catalog.json"), "utf8"));
    expect(catalog.servers.board).toMatchObject({ apps: true, uiExtension: "ok", tools: { show_board: { resourceUri: BOARD_URI } } });
    expect((await api("GET", "/api/mcp/servers")).servers.find((server: any) => server.name === "board")).toMatchObject({ enabled: true, apps: true });

    const bot = (await api("POST", "/api/bots", { name: "Scout" }, 201)).bot;
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Show me the board", sendId: "apps-mcp-e2e-send-0001" }, 202);
    let mounts: any;
    await expect.poll(() => {
      try { mounts = dump().mcpConfig.mcpServers; } catch { return false; }
      return Boolean(mounts?.agents && mounts?.board);
    }, { timeout: 15_000 }).toBe(true);
    const token: string = mounts.agents.env.OMB_COMMS_TOKEN;
    expect(mounts.board.args[0]).toContain("mcp-gate");
    expect(JSON.parse(mounts.board.env.OMB_GATE_APPS)).toEqual({ server: "board", harnessUrl: fixture.info.url, token, extension: true });

    engineSide = spawn(mounts.board.command, ["--experimental-strip-types", "--no-warnings", ...mounts.board.args], { stdio: "pipe", env: { ...process.env, ...mounts.board.env } });
    const lines = createInterface({ input: engineSide.stdout })[Symbol.asyncIterator]();
    const ask = async (id: number, method: string, params?: unknown) => {
      engineSide!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      return JSON.parse((await lines.next()).value as string);
    };
    await ask(1, "initialize", { protocolVersion: "2025-11-25", capabilities: { roots: {} }, clientInfo: { name: "claude-code", version: "2.1.270" } });
    expect((await ask(2, "tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["show_board", "paint_board", "peek_board", "plain_echo", "query_result"]);
    expect((await ask(3, "tools/call", { name: "save_board", arguments: {} })).error.message).toBe(APP_ONLY_REFUSAL);
    const called = await ask(4, "tools/call", { name: "show_board", arguments: { cards: 4 }, _meta: { "claudecode/toolUseId": "toolu_e2e" } });
    expect(called.result.content[0].text).toBe("Board with 4 cards");

    const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${bot.threadId}/messages`)).messages;
    let row: any;
    await expect.poll(async () => { row = (await transcript()).find((message) => message.kind === "app"); return Boolean(row); }, { timeout: 15_000 }).toBe(true);
    expect(row).toMatchObject({
      role: "bot", text: "Fake App · Show board\nBoard with 4 cards",
      app: { v: 1, source: "mcp", title: "Show board", mcp: { server: "board", serverTitle: "Fake App", tool: "show_board", resourceUri: BOARD_URI },
        network: { connect: ["https://api.fake-app.example"], resources: ["https://cdn.fake-app.example"], refused: ["https://bad.example/path"] } },
    });

    const report = { tool: "mcp_app", server: "board", definition: { name: "show_board", _meta: { ui: { resourceUri: BOARD_URI } } }, call: { arguments: {} }, result: { content: [] } };
    await api("POST", "/api/internal/options-card", report, 401, "not-a-capability");

    const doc = await api("GET", `/api/threads/${bot.threadId}/messages/${row.id}/app`);
    expect(String(doc.srcdoc).startsWith(CSP_META_PREFIX)).toBe(true);
    expect(doc.srcdoc).toContain("<h1>Fake board</h1>");
    expect(doc).toMatchObject({
      tool: { name: "show_board" }, toolInput: { cards: 4 },
      toolResult: { content: [{ type: "text", text: "Board with 4 cards" }], structuredContent: { cards: 4 }, _meta: { "fake-app/at": "2026-10-14T00:00:00Z" } },
      can: { serverTools: true, serverResources: true },
    });

    const rpc = (body: Record<string, unknown>, expected = 200) => api("POST", `/api/bots/${bot.id}/apps/${row.id}/rpc`, { threadId: bot.threadId, ...body }, expected);
    expect(await rpc({ method: "tools/call", params: { name: "save_board", arguments: { state: "s1" } } })).toMatchObject({ content: [{ type: "text", text: "Saved" }] });
    expect(logged().filter((frame) => frame.method === "tools/call").map((frame) => frame.params)).toContainEqual({ name: "save_board", arguments: { state: "s1" } });
    // A new bot starts at Full access: its app's change runs with no card.
    expect(await rpc({ method: "tools/call", params: { name: "paint_board", arguments: { color: "red" } } })).toMatchObject({ content: [{ type: "text", text: "Painted red" }] });
    expect(await rpc({ method: "tools/call", params: { name: "peek_board", arguments: {} } }, 403)).toEqual({ error: { code: -32602, message: "That tool is not available to apps." } });
    expect((await rpc({ method: "resources/read", params: { uri: BOARD_URI } })).contents[0].uri).toBe(BOARD_URI);

    writeFileSync(gate, "finish");
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === bot.id).busy, { timeout: 15_000 }).toBe(false);
    await api("POST", "/api/internal/options-card", report, 401, token);

    await api("PATCH", "/api/mcp/servers/board", { apps: false });
    expect((await api("GET", "/api/mcp/servers")).servers.find((server: any) => server.name === "board")).toMatchObject({ apps: false });
    expect(await rpc({ method: "tools/list" }, 410)).toMatchObject({ blocked: { reason: "apps-off", text: "Apps from Fake App are switched off in Settings" } });
    expect(await api("GET", `/api/threads/${bot.threadId}/messages/${row.id}/app`)).toMatchObject({ can: { serverTools: false }, blocked: { reason: "apps-off" } });
  } finally {
    if (engineSide && engineSide.exitCode === null) { const closed = once(engineSide, "close"); engineSide.kill(); await closed; }
    const evidencePath = `${fixture.info.logPath}.chat-apps-mcp.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath, logPath: fixture.info.logPath }));
    await fixture.close();
    await removeTempDir(scratch);
  }
}, 120_000);
