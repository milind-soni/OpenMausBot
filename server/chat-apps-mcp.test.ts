import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { APP_LIMITS, APP_MIME, type AppPayload } from "../shared/app.ts";
import { createChatApps, type ChatApps } from "./chat-apps.ts";
import { APP_WRITE_DECLINED, createChatAppsMcp, type ChatAppsMcp, type ChatAppsMcpOAuth, type ChatAppsMcpStore } from "./chat-apps-mcp.ts";
import { createAgentCard } from "./chat-widgets.ts";
import type { McpServerSpec } from "./contracts.ts";
import { McpOAuthManager, withMcpSignIn } from "./mcp-oauth.ts";
import { probeMcpServer, SIGN_IN_CHECK_TOOL } from "./mcp-probe.ts";
import type { McpRpcRequest } from "./routes/chat-apps.ts";
import type { BotRecord, Message } from "./store.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
import { startFakeOAuth } from "./testing/fake-oauth-server.ts";

const FAKE_APP = fileURLToPath(new URL("./testing/fake-stdio-app-server.ts", import.meta.url));
const THREAD = "thread-scout";
const ROOM = "thread-room";
const BOARD_URI = "ui://fake-app/board.html";
const board = (env: Record<string, string> = {}) => ({ command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", FAKE_APP], env });

const REPORT = {
  tool: "mcp_app",
  server: "board",
  serverInfo: { name: "fake-app", title: "Fake App", version: "1" },
  definition: { name: "show_board", title: "Show board", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: BOARD_URI } } },
  call: { arguments: { cards: 3 }, toolUseId: "toolu_1" },
  result: { content: [{ type: "text", text: "Board with 3 cards" }], structuredContent: { cards: 3 }, _meta: { "fake-app/at": "now" } },
};

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

function setup(options: { servers?: Record<string, Record<string, unknown>>; scope?: BotRecord["toolScope"]; approval?: "ask" | "full"; needsSignIn?: string[]; probe?: typeof probeMcpServer; oauth?: ChatAppsMcpOAuth; startupProbes?: boolean; probeAs?: (server: { bot?: string }) => { id?: string; cwd?: string } } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-chat-apps-mcp-"));
  cleanup.push(() => removeTempDir(dataDir));
  const threads = new Map<string, Message[]>();
  const rows = (threadId: string) => threads.get(threadId) ?? threads.set(threadId, []).get(threadId)!;
  let next = 1;
  const bot = { id: "bot-scout", name: "Scout", color: "blue", threadId: THREAD, approvalMode: options.approval ?? "ask", ...(options.scope ? { toolScope: options.scope } : {}) } as unknown as BotRecord;
  const store: ChatAppsMcpStore = {
    bot: (id: string) => (id === bot.id ? bot : undefined),
    botByThread: (threadId: string) => (threadId === THREAD ? bot : undefined),
    groupByThread: (threadId: string) => (threadId === ROOM ? { id: "room-1" } : undefined),
    messagesFor: rows,
    appendMessage: vi.fn((threadId: string, message: Omit<Message, "id" | "at">): Message => {
      const full = { ...message, id: `m${next++}`, at: 1 } as Message;
      rows(threadId).push(full);
      return full;
    }),
    patchMessage: (threadId: string, messageId: string, patch: Partial<Message>) => {
      const list = rows(threadId);
      const index = list.findIndex((message) => message.id === messageId);
      if (index === -1) return null;
      list[index] = { ...list[index]!, ...patch };
      return list[index]!;
    },
    projectBotForTask: (botId: string) => (botId === bot.id ? bot : null),
  } as unknown as ChatAppsMcpStore;
  const servers: Record<string, Record<string, unknown>> = options.servers ?? { board: { ...board(), enabled: true } };
  const apps: ChatApps = createChatApps({ store: store as never, dataDir, sweeps: false, references: () => [] });
  const lines: string[] = [];
  const mcp: ChatAppsMcp = createChatAppsMcp({
    store, apps,
    storedServers: () => servers,
    mountedServers: () => Object.fromEntries(Object.entries(servers).filter(([, server]) => server.enabled !== false).map(([name, server]) => {
      const { enabled: _enabled, apps: _apps, ...spec } = server;
      return [name, ("url" in spec ? { headers: {}, ...spec } : { args: [], env: {}, ...spec }) as McpServerSpec];
    })),
    oauth: options.oauth ?? { authState: (name) => (options.needsSignIn?.includes(name) ? "needs-sign-in" : "none"), accessToken: async () => null, requireSignIn: () => {} },
    startupProbes: options.startupProbes ?? false,
    ...(options.probe ? { probe: options.probe } : {}),
    ...(options.probeAs ? { probeAs: options.probeAs } : {}),
    log: (line) => lines.push(line),
  });
  cleanup.push(() => { mcp.close(); apps.close(); });
  const record = (input: Record<string, unknown> = REPORT, threadId = THREAD, authored?: (id: string) => void) =>
    mcp.recordMcpAppCall({ bot, threadId, input, ...(authored ? { authored } : {}) });
  const row = (id: string, threadId = THREAD) => rows(threadId).find((message) => message.id === id) as Message & { app: AppPayload };
  const rpc = (messageId: string, method: McpRpcRequest["method"], params: Record<string, unknown> = {}) =>
    mcp.rpc({ auth: { kind: "loopback" } as never, bot, threadId: THREAD, row: row(messageId), method, params });
  return { store, apps, mcp, bot, servers, rows, row, record, rpc, lines };
}

describe("recordMcpAppCall", () => {
  it("turns a report into an app row: the page read from the server, its CSP filtered, the call stored for the frame", async () => {
    const { record, row, apps, mcp } = setup();
    const authored = vi.fn();
    expect(await record(REPORT, THREAD, authored)).toEqual({ ok: true, messageId: "m1" });
    expect(authored).toHaveBeenCalledWith("m1");
    const message = row("m1");
    expect(message).toMatchObject({ role: "bot", kind: "app", text: "Fake App · Show board\nBoard with 3 cards" });
    expect(message.app).toEqual({
      v: 1, source: "mcp", title: "Show board", doc: expect.stringMatching(/^[0-9a-f]{64}$/), rev: 0, bytes: expect.any(Number), border: true,
      network: { connect: ["https://api.fake-app.example"], resources: ["https://cdn.fake-app.example"], refused: ["https://bad.example/path"] },
      mcp: { server: "board", serverTitle: "Fake App", tool: "show_board", resourceUri: BOARD_URI },
    });
    const doc = apps.appDocument(THREAD, "m1")!;
    expect(doc.srcdoc).toContain("<h1>Fake board</h1>");
    expect(doc.csp).toContain("connect-src https://api.fake-app.example");
    expect(doc.csp).not.toContain("bad.example");
    expect(doc).toMatchObject({
      tool: { name: "show_board", _meta: { ui: { resourceUri: BOARD_URI } } },
      toolInput: { cards: 3 },
      toolResult: REPORT.result,
      can: { serverTools: true, serverResources: true },
    });
    expect(doc).not.toHaveProperty("approval");
    expect(doc).not.toHaveProperty("blocked");
    expect(mcp.catalog.get("board", board())).toMatchObject({ apps: true, tools: { show_board: { resourceUri: BOARD_URI, readOnly: true } } });
  }, 30_000);

  it("arrives through the internal card route's createAgentCard", async () => {
    const { apps, bot } = setup();
    const result = await createAgentCard({ store: { groupByThread: () => undefined, messagesFor: () => [], appendMessage: () => { throw new Error("unused"); }, patchMessage: () => null },
      bot: { id: bot.id, name: bot.name, color: "blue" }, threadId: THREAD, input: { ...REPORT, tool: "mcp_app" }, apps });
    expect(result).toEqual({ ok: true, messageId: "m1" });
    expect(await createAgentCard({ store: { groupByThread: () => undefined, messagesFor: () => [], appendMessage: () => { throw new Error("unused"); }, patchMessage: () => null },
      bot: { id: bot.id, name: bot.name, color: "blue" }, threadId: THREAD, input: { tool: "mcp_app" } })).toEqual({ ok: false, status: 400, error: "MCP apps are not available on this computer." });
  }, 30_000);

  it("shows a room member's app in the room as that bot's row, view-only for everyone", async () => {
    const { record, row, apps } = setup();
    expect(await record(REPORT, ROOM)).toEqual({ ok: true, messageId: "m1" });
    expect(row("m1", ROOM)).toMatchObject({ role: "bot", kind: "app", from: { botId: "bot-scout", name: "Scout", color: "blue" }, app: { source: "mcp", title: "Show board" } });
    const doc = apps.appDocument(ROOM, "m1")!;
    expect(doc.srcdoc).toContain("<h1>Fake board</h1>");
    expect(doc).toMatchObject({ room: true, toolResult: REPORT.result, can: { serverTools: false, serverResources: false, message: false, modelContext: false, openLinks: true } });
    expect(doc).not.toHaveProperty("blocked");
  }, 30_000);

  it("writes no row for an unmounted server, one outside the bot's scope, or one whose apps are off (rule 17)", async () => {
    const base = setup();
    expect(await base.record({ ...REPORT, server: "elsewhere" })).toMatchObject({ ok: false, status: 404 });
    expect(await base.record({ ...REPORT, definition: { ...REPORT.definition, _meta: {} } })).toMatchObject({ ok: false, status: 400 });
    expect(await base.record({ ...REPORT, result: { content: "x" } })).toMatchObject({ ok: false, status: 400 });
    const scoped = setup({ scope: { deny: ["mcp:board:*"] } });
    expect(await scoped.record()).toMatchObject({ ok: false, status: 404 });
    const off = setup({ servers: { board: { ...board(), enabled: true, apps: false } } });
    expect(await off.record()).toMatchObject({ ok: false, status: 409 });
    const disabled = setup({ servers: { board: { ...board(), enabled: false } } });
    expect(await disabled.record()).toMatchObject({ ok: false, status: 404 });
    for (const { rows } of [base, scoped, off, disabled]) {
      expect(rows(THREAD)).toEqual([]);
      expect(rows(ROOM)).toEqual([]);
    }
  });

  it("still writes the row, with its text and why, when the page cannot be read", async () => {
    const { record, row, apps } = setup({ servers: { board: { ...board({ FAKE_APP_MIME: "text/html" }), enabled: true } } });
    expect(await record()).toEqual({ ok: true, messageId: "m1" });
    expect(row("m1")).toMatchObject({ text: "Fake App · Show board\nBoard with 3 cards", app: { doc: "", blocked: "unavailable", mcp: { tool: "show_board" } } });
    expect(apps.appDocument(THREAD, "m1")).toBeNull();
    const big = setup({ servers: { board: { ...board({ FAKE_APP_HTML_BYTES: String(APP_LIMITS.mcpHtmlBytes + 10) }), enabled: true } } });
    await big.record();
    expect(big.row("m1").app.blocked).toBe("too-large");
  }, 30_000);
});

describe("access", () => {
  it("opens server calls while the server is configured, enabled, signed in and has apps on; otherwise says why", async () => {
    const live = setup();
    await live.record();
    const access = () => live.mcp.access(live.row("m1"), THREAD);
    expect(access()).toEqual({ can: { serverTools: true, serverResources: true, message: true, openLinks: true, modelContext: true } });
    live.servers.board = { ...board(), enabled: true, apps: false };
    expect(access()).toMatchObject({ can: { serverTools: false, serverResources: false, message: true }, blocked: { reason: "apps-off", text: "Apps from Fake App are switched off in Settings" } });
    live.servers.board = { ...board(), enabled: false };
    expect(access().blocked?.reason).toBe("server-disabled");
    delete live.servers.board;
    expect(access().blocked?.reason).toBe("server-removed");
    expect(live.apps.appDocument(THREAD, "m1")).toMatchObject({ can: { serverTools: false }, blocked: { reason: "server-removed" } });

    const signedOut = setup({ servers: { draw: { type: "http", url: "https://draw.example/mcp", enabled: true } }, needsSignIn: ["draw"] });
    const message = signedOut.store.appendMessage(THREAD, { role: "bot", kind: "app", text: "x",
      app: { v: 1, source: "mcp", title: "View", doc: "", rev: 0, bytes: 0, border: true, network: { connect: [], resources: [] }, mcp: { server: "draw", tool: "create_view", resourceUri: "ui://draw/v.html" } } });
    expect(signedOut.mcp.access(signedOut.row(message.id), THREAD).blocked).toEqual({ reason: "signed-out", text: "Sign in to draw again" });
  }, 30_000);
});

describe("rpc", () => {
  it("runs read-only and app-only tools at any level, and declines the rest outside Full access with no card (rule 15)", async () => {
    const { record, rpc, lines } = setup();
    await record();
    expect(await rpc("m1", "tools/call", { name: "show_board", arguments: { cards: 5 } })).toEqual({
      status: 200, body: { content: [{ type: "text", text: "Board with 5 cards" }], structuredContent: { cards: 5 }, _meta: { "fake-app/at": "2026-10-14T00:00:00Z" } },
    });
    // the app's own plumbing: app-only, not destructive
    expect(await rpc("m1", "tools/call", { name: "save_board", arguments: { state: "s" } })).toMatchObject({ status: 200, body: { content: [{ type: "text", text: "Saved" }] } });
    // app-only but destructive, and model-visible without readOnlyHint: the bot asks first, so the app may not
    expect(await rpc("m1", "tools/call", { name: "wipe_board", arguments: {} })).toEqual({
      status: 403, body: { error: { code: -32000, message: APP_WRITE_DECLINED } },
    });
    expect(await rpc("m1", "tools/call", { name: "paint_board", arguments: { color: "red" } })).toEqual({
      status: 403, body: { error: { code: -32000, message: APP_WRITE_DECLINED } },
    });
    // every call is logged, never its arguments
    expect(lines.filter((line) => line.startsWith("rpc "))).toEqual([
      "rpc bot=bot-scout server=board method=tools/call tool=show_board → 200",
      "rpc bot=bot-scout server=board method=tools/call tool=save_board → 200",
      "rpc bot=bot-scout server=board method=tools/call tool=wipe_board → 403",
      "rpc bot=bot-scout server=board method=tools/call tool=paint_board → 403",
    ]);
  }, 30_000);

  it("runs a write in Full access without asking", async () => {
    const { record, rpc } = setup({ approval: "full" });
    await record();
    expect(await rpc("m1", "tools/call", { name: "paint_board", arguments: { color: "blue" } })).toMatchObject({ status: 200, body: { content: [{ type: "text", text: "Painted blue" }] } });
    expect(await rpc("m1", "tools/call", { name: "wipe_board", arguments: {} })).toMatchObject({ status: 200 });
  }, 30_000);

  it("keeps a change the card made itself on its row, so a reopened conversation shows it done (#4532)", async () => {
    const { record, rpc, row } = setup({ approval: "full" });
    await record();
    // looking and the app's own plumbing are not changes
    await rpc("m1", "tools/call", { name: "show_board", arguments: { cards: 5 } });
    await rpc("m1", "tools/call", { name: "save_board", arguments: { state: "s" } });
    expect(row("m1").app.done).toBeUndefined();
    expect(await rpc("m1", "tools/call", { name: "paint_board", arguments: { color: "blue" } })).toMatchObject({ status: 200 });
    expect(row("m1").app.done).toEqual({ tool: "Paint board", text: "Painted blue", at: expect.any(Number) });
    // the row keeps everything else it had
    expect(row("m1").app).toMatchObject({ source: "mcp", mcp: { server: "board", tool: "show_board" } });
  }, 30_000);

  it("keeps no secret from the result in the note", async () => {
    const { record, rpc, row } = setup({ approval: "full" });
    await record();
    await rpc("m1", "tools/call", { name: "paint_board", arguments: { color: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } });
    expect(JSON.stringify(row("m1").app.done)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  }, 30_000);

  it("records nothing when the change is declined", async () => {
    const { record, rpc, row } = setup();
    await record();
    expect(await rpc("m1", "tools/call", { name: "paint_board", arguments: { color: "red" } })).toMatchObject({ status: 403 });
    expect(row("m1").app.done).toBeUndefined();
  }, 30_000);

  it("refuses a tool the server lacks, one its view may not call, one outside the selection, and bad arguments", async () => {
    const { record, rpc } = setup({ scope: { allow: ["mcp:board:show_board", "mcp:board:peek_board"] } });
    await record();
    expect(await rpc("m1", "tools/call", { name: "nope", arguments: {} })).toEqual({ status: 403, body: { error: { code: -32602, message: "This app's server has no tool by that name." } } });
    expect(await rpc("m1", "tools/call", { name: "peek_board", arguments: {} })).toEqual({ status: 403, body: { error: { code: -32602, message: "That tool is not available to apps." } } });
    expect(await rpc("m1", "tools/call", { name: "paint_board", arguments: { color: "red" } })).toEqual({ status: 403, body: { error: { code: -32602, message: "The bot's tool selection does not include that tool." } } });
    // app-only tools need only the server
    expect((await rpc("m1", "tools/call", { name: "save_board", arguments: {} })).status).toBe(200);
    expect((await rpc("m1", "tools/call", { name: "show_board", arguments: { cards: "three" } })).body).toMatchObject({ error: { code: -32602, message: expect.stringMatching(/^Invalid arguments: /) } });
    expect((await rpc("m1", "tools/call", { name: "show_board", arguments: { pad: "x".repeat(APP_LIMITS.rpcArgumentsBytes) } })).body).toEqual({ error: { code: -32602, message: "Those arguments are too large." } });
    expect((await rpc("m1", "tools/call", { arguments: {} })).status).toBe(400);
    // tools/list: what the app may call, after the selection
    expect(((await rpc("m1", "tools/list")).body.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["show_board", "save_board", "wipe_board"]);
    const read = await rpc("m1", "resources/read", { uri: BOARD_URI });
    expect(read).toMatchObject({ status: 200, body: { contents: [{ uri: BOARD_URI, mimeType: APP_MIME }] } });
    expect((await rpc("m1", "resources/list")).body).toMatchObject({ resources: [{ uri: BOARD_URI }] });
    expect(await rpc("m1", "resources/read", { uri: "ui://fake-app/missing.html" })).toEqual({ status: 502, body: { error: { code: -32002, message: "Resource not found" } } });
  }, 30_000);

  it("answers 410 once the server is removed or switched off, and 404 for a row with no server", async () => {
    const { record, rpc, servers, store, row, mcp, bot } = setup();
    await record();
    servers.board = { ...board(), enabled: true, apps: false };
    expect(await rpc("m1", "tools/list")).toEqual({ status: 410, body: { error: { code: -32000, message: "Apps from Fake App are switched off in Settings" }, blocked: { reason: "apps-off", text: "Apps from Fake App are switched off in Settings" } } });
    delete servers.board;
    expect((await rpc("m1", "tools/list")).body).toMatchObject({ blocked: { reason: "server-removed" } });
    const page = store.appendMessage(THREAD, { role: "bot", kind: "app", text: "x", app: { v: 1, source: "html", title: "p", doc: "", rev: 0, bytes: 0, border: true, network: { connect: [], resources: [] } } });
    expect((await mcp.rpc({ auth: {} as never, bot, threadId: THREAD, row: row(page.id), method: "tools/list", params: {} })).status).toBe(404);
  }, 30_000);

  it("answers 401 with the server to sign in to, when sign-in is due or the server refuses the credentials", async () => {
    let fake: FakeHttpMcp | undefined = await startFakeHttpMcp({ requireHeader: { name: "x-key", value: "right" }, tools: [] });
    cleanup.push(async () => { await fake?.close(); fake = undefined; });
    const draw = { type: "http", url: fake.url, enabled: true };
    const { rpc, store } = setup({ servers: { draw } });
    const app = { v: 1 as const, source: "mcp" as const, title: "View", doc: "", rev: 0, bytes: 0, border: true, network: { connect: [], resources: [] }, mcp: { server: "draw", tool: "create_view", resourceUri: "ui://draw/v.html" } };
    const message = store.appendMessage(THREAD, { role: "bot", kind: "app", text: "x", app });
    expect(await rpc(message.id, "tools/list")).toEqual({ status: 401, body: { error: { code: -32000, message: "Sign-in needed" }, signIn: { server: "draw" } } });
    const due = setup({ servers: { draw }, needsSignIn: ["draw"] });
    const other = due.store.appendMessage(THREAD, { role: "bot", kind: "app", text: "x", app });
    expect(await due.rpc(other.id, "tools/list")).toMatchObject({ status: 401, body: { signIn: { server: "draw" } } });
  }, 30_000);

  it("takes at most 60 calls a minute from one app row", async () => {
    const { record, rpc } = setup();
    await record();
    for (let index = 0; index < APP_LIMITS.rpcPerMinute; index += 1) expect((await rpc("m1", "tools/list")).status).toBe(200);
    expect(await rpc("m1", "tools/list")).toEqual({ status: 429, body: { error: { code: -32000, message: "Too many calls from this app. Wait a minute." } } });
  }, 30_000);
});

describe("mounts and probes", () => {
  it("mounts a server through an observer only once its catalog says it has apps and its switch is on", async () => {
    const probe = vi.fn(async () => ({ ok: false as const, error: "offline" }));
    const { mcp, servers } = setup({ probe });
    expect(mcp.turnMounts({ board: board() })).toEqual({});
    // a turn that found it unknown asks for one background probe
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    mcp.catalog.recordList("board", board(), [{ name: "show_board", _meta: { ui: { resourceUri: BOARD_URI } } }], "ok");
    expect(mcp.turnMounts({ board: board(), plain: { command: "x", args: [], env: {} } })).toEqual({ mcpApps: { board: { extension: true } } });
    mcp.catalog.recordList("board", board(), [{ name: "show_board", _meta: { ui: { resourceUri: BOARD_URI } } }], "refused");
    expect(mcp.turnMounts({ board: board() })).toEqual({ mcpApps: { board: { extension: false } } });
    servers.board = { ...board(), enabled: true, apps: false };
    expect(mcp.turnMounts({ board: board() })).toEqual({});
    // a turn that finds it unknown again within ten minutes asks for none
    servers.board = { ...board(), enabled: true };
    mcp.catalog.forget("board");
    expect(mcp.turnMounts({ board: board() })).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("starts a command server for its background probe the way the bots' turns start it, never beside the server", async () => {
    const probe = vi.fn(async () => ({ ok: false as const, error: "offline" }));
    const probeAs = vi.fn((server: { bot?: string }) => (server.bot ? { id: server.bot, cwd: `/data/workspaces/${server.bot}` } : {}));
    const { mcp, servers } = setup({ probe, probeAs, servers: { board: { ...board(), enabled: true }, own: { ...board(), enabled: true, bot: "bot-scout" } } });
    expect(mcp.turnMounts({ board: board(), own: board() })).toEqual({});
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    // `asBot` is what makes the probe ask for the bot box (server/mcp-probe.ts); without it the command runs unboxed.
    expect(probe.mock.calls.map((call) => (call as unknown as [unknown, unknown, unknown, { asBot?: unknown }])[3].asBot)).toEqual([{}, { id: "bot-scout", cwd: "/data/workspaces/bot-scout" }]);
    expect(Object.keys(servers)).toEqual(["board", "own"]);
  });

  it("tells Settings which stored servers have been seen to offer an app", () => {
    const { mcp, servers } = setup({ probe: vi.fn(async () => ({ ok: false as const, error: "offline" })) });
    servers.board = { ...board(), enabled: true };
    expect(mcp.hasApps("board")).toBeUndefined();
    mcp.catalog.recordList("board", board(), [{ name: "show_board", _meta: { ui: { resourceUri: BOARD_URI } } }], "ok");
    expect(mcp.hasApps("board")).toBe(true);
    mcp.catalog.recordList("board", board(), [{ name: "plain_tool" }], "ok");
    expect(mcp.hasApps("board")).toBe(false);
    expect(mcp.hasApps("nowhere")).toBeUndefined();
  });

  it("learns a server's apps from Settings → Test, and records a refused extension", async () => {
    const { mcp } = setup();
    const stored = { ...board(), enabled: true };
    expect(await probeMcpServer(stored, 15_000, undefined, mcp.probeOptions("board", stored))).toMatchObject({ ok: true });
    expect(mcp.catalog.get("board", stored)).toMatchObject({ apps: true, uiExtension: "ok", tools: { show_board: { readOnly: true }, save_board: { visibility: ["app"] }, peek_board: { visibility: ["model"] } } });
    const strict = { ...board({ FAKE_APP_STRICT: "1" }), enabled: true };
    expect(await probeMcpServer(strict, 15_000, undefined, mcp.probeOptions("strict", strict))).toMatchObject({ ok: true });
    expect(mcp.catalog.get("strict", strict)).toMatchObject({ apps: true, uiExtension: "refused" });
    // a server that shows its UI only to a client that asks
    const adapting = { ...board({ FAKE_APP_ADAPT: "1" }), enabled: true };
    await probeMcpServer(adapting, 15_000, undefined, mcp.probeOptions("adapting", adapting));
    expect(mcp.catalog.get("adapting", adapting)?.apps).toBe(true);
    // apps off: no extension, nothing recorded
    expect(mcp.probeOptions("off", { ...adapting, apps: false })).toEqual({});
  }, 60_000);

  it("probes a server a turn finds unknown in the background, at most every ten minutes", async () => {
    const { mcp } = setup();
    expect(mcp.turnMounts({ board: board() })).toEqual({});
    await vi.waitFor(() => expect(mcp.catalog.get("board", board())?.apps).toBe(true), { timeout: 20_000 });
    expect(mcp.turnMounts({ board: board() })).toEqual({ mcpApps: { board: { extension: true } } });
    mcp.forgetServer("board");
    expect(mcp.turnMounts({ board: board() })).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(mcp.catalog.get("board", board())).toBeUndefined();
  }, 30_000);

  it("probes a saved URL server in the background, never starts a command server no turn would, and forgets a removed one", async () => {
    const fake = await startFakeHttpMcp({ tools: [{ name: "create_view", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://draw/v.html" } } }] });
    cleanup.push(() => fake.close());
    const probe = vi.fn(probeMcpServer);
    const draw = { type: "http", url: fake.url, enabled: true };
    const { mcp } = setup({ servers: { board: { ...board(), enabled: true }, draw }, probe });
    mcp.serverChanged("board");
    // a bot whose selection excludes the server does not start it either
    mcp.turnMounts({ board: board() }, { allow: ["mcp:draw:*"] });
    mcp.serverChanged("draw");
    await vi.waitFor(() => expect(mcp.catalog.get("draw", draw)?.apps).toBe(true), { timeout: 20_000 });
    expect(probe.mock.calls.map(([server]) => "url" in server ? "draw" : "board")).toEqual(["draw"]);
    mcp.forgetServer("draw");
    expect(mcp.catalog.get("draw", draw)).toBeUndefined();
  }, 30_000);
});

describe("a server that lists tools before anyone signs in", () => {
  const buy = { name: "buy", description: "Buy something" };

  async function agentcardShaped() {
    const issuer = await startFakeOAuth();
    const fake = await startFakeHttpMcp({ guard: "tools/call", acceptBearer: issuer.isValid, wwwAuthenticate: issuer.challenge, tools: [buy] });
    cleanup.push(() => fake.close(), () => issuer.close());
    return fake;
  }

  /** Starts the app with the saved servers, lets the 20 second startup probe fire, and returns the sign-in book it used. */
  async function startupProbe(servers: Record<string, Record<string, unknown>>) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanup.push(() => { vi.useRealTimers(); });
    const dataDir = mkdtempSync(join(tmpdir(), "omb-mcp-oauth-"));
    cleanup.push(() => removeTempDir(dataDir));
    const oauth = new McpOAuthManager({ file: join(dataDir, "mcp-oauth.json") });
    cleanup.push(() => oauth.dispose());
    const probe = vi.fn(probeMcpServer);
    setup({ servers, oauth, probe, startupProbes: true });
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.waitFor(() => expect(probe).toHaveBeenCalled(), { timeout: 10_000 });
    await vi.waitFor(() => expect(probe.mock.results.length).toBeGreaterThan(0));
    const result = await probe.mock.results[0]!.value;
    await new Promise((resolve) => setImmediate(resolve));
    return { oauth, result };
  }

  it("marks an installed server that was never signed in, and drops it from bots' turns", async () => {
    const fake = await agentcardShaped();
    const agentcard = { type: "http", url: fake.url, enabled: true };
    const { oauth, result } = await startupProbe({ agentcard });
    expect(result).toMatchObject({ ok: false, auth: "required" });
    expect(oauth.authState("agentcard", fake.url)).toBe("needs-sign-in");
    expect(await withMcpSignIn({ agentcard: { type: "http", url: fake.url, headers: {} } }, oauth)).toEqual({});
    expect(fake.calls).toEqual([]);
  });

  it("never signs a signed-in server out when its Bearer is refused in the background", async () => {
    const issuer = await startFakeOAuth();
    const fake = await startFakeHttpMcp({ guard: "every-request", acceptBearer: () => false, wwwAuthenticate: issuer.challenge, tools: [buy] });
    cleanup.push(() => fake.close(), () => issuer.close());
    const dataDir = mkdtempSync(join(tmpdir(), "omb-mcp-oauth-"));
    cleanup.push(() => removeTempDir(dataDir));
    const oauth = new McpOAuthManager({ file: join(dataDir, "mcp-oauth.json") });
    cleanup.push(() => oauth.dispose());
    oauth.adopt("agentcard", fake.url, { url: fake.url, state: "signed-in", tokens: { access: "at_refused", expiresAt: Date.now() + 3_600_000 } });
    const probe = vi.fn(probeMcpServer);
    const { mcp } = setup({ servers: { agentcard: { type: "http", url: fake.url, enabled: true } }, oauth, probe });
    mcp.serverChanged("agentcard");
    await vi.waitFor(() => expect(probe).toHaveBeenCalled());
    expect(await probe.mock.results[0]!.value).toMatchObject({ ok: false, auth: "required" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(oauth.authState("agentcard", fake.url)).toBe("signed-in");
    expect(await oauth.accessToken("agentcard", fake.url)).toBe("at_refused");
  });

  it("leaves a server that carries a key alone", async () => {
    const issuer = await startFakeOAuth();
    const fake = await startFakeHttpMcp({ requireHeader: { name: "x-api-key", value: "right" }, wwwAuthenticate: issuer.challenge, tools: [buy] });
    cleanup.push(() => fake.close(), () => issuer.close());
    const keyed = { type: "http", url: fake.url, headers: { "X-Api-Key": "wrong" }, enabled: true };
    const { oauth, result } = await startupProbe({ keyed });
    expect(result).toMatchObject({ ok: false, auth: "required" });
    expect(oauth.authState("keyed", fake.url)).toBe("none");
  });

  it("leaves an anonymous server alone when it answers the check with a JSON-RPC error", async () => {
    const fake = await startFakeHttpMcp({ tools: [buy], callError: () => ({ code: -32602, message: `Tool ${SIGN_IN_CHECK_TOOL} not found` }) });
    cleanup.push(() => fake.close());
    const { oauth, result } = await startupProbe({ open: { type: "http", url: fake.url, enabled: true } });
    expect(result).toMatchObject({ ok: true });
    expect(oauth.authState("open", fake.url)).toBe("none");
  });
});
