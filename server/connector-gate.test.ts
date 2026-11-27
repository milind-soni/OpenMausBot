// The gate a connector call made outside a turn goes through, with a fake connected-apps installation and a fake MCP
// server: no call leaves this process.
import { describe, expect, it } from "vitest";

import { APP_LIMITS, type AppConnectorUse } from "../shared/app.ts";
import { bindConnectorGate, createConnectorGate, fitResult, type AppInstallation, type ConnectorCaller, type GateBot, type GateServers, type OpenedServer } from "./connector-gate.ts";
import type { DecisionRow } from "./decision-log.ts";

type Json = Record<string, unknown>;

/** Composio's multi-execute answer for one tool. */
function executed(slug: string, data: unknown, successful = true, error?: string): Json {
  const body = { successful: true, data: { results: [{ tool_slug: slug, response: { successful, ...(successful ? { data } : { error }) } }] } };
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

function installation(id: string, options: { connected?: boolean; accounts?: Array<{ id: string; status: string }>; readOnly?: string[]; answer?: (frame: Json) => Json | Promise<Json>; hang?: boolean; status?: number } = {}) {
  const frames: Array<{ frame: Json; session: string | undefined }> = [];
  const value: AppInstallation = {
    id,
    connected: async () => ({ gmail: { connected: options.connected !== false, accounts: options.accounts ?? [{ id: "ca_1", status: "ACTIVE" }] } }),
    serviceSlugs: async () => ["gmail", "notion"],
    readOnlyTools: async () => new Set(options.readOnly ?? ["GMAIL_FETCH_EMAILS"]),
    async relay(frame, session, signal) {
      frames.push({ frame, session });
      if (frame.method === "initialize") return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} })), transportSessionId: `${id}-session` };
      if (frame.method !== "tools/call") return { status: 202, bytes: new Uint8Array() };
      if (options.hang) await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      if (options.status) return { status: options.status, bytes: new Uint8Array() };
      const params = frame.params as { arguments: { tools: Array<{ tool_slug: string }> } };
      const result = options.answer ? await options.answer(frame) : executed(params.arguments.tools[0]!.tool_slug, { messages: [{ id: "m1", subject: "Hi" }] });
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })) };
    },
  };
  return { value, frames, calls: () => frames.filter((one) => one.frame.method === "tools/call").map((one) => one.frame) };
}

function fakeServer(tools: Json[], answer: (tool: string, args: Json) => Json = (tool) => ({ content: [{ type: "text", text: `ran ${tool}` }] })) {
  const calls: Array<{ tool: string; args: Json }> = [];
  const server: OpenedServer = {
    label: "notes",
    tools: async () => tools,
    async call(tool, args) { calls.push({ tool, args }); return { ok: true, body: answer(tool, args) }; },
  };
  return { server, calls };
}

function fixture(options: { bot?: Partial<GateBot>; shared?: ReturnType<typeof installation>; own?: ReturnType<typeof installation> | null; personApps?: string[]; policy?: string; servers?: GateServers; callMs?: number } = {}) {
  const bot: GateBot = { id: "b1", name: "Scout", ...options.bot };
  const bots = new Map([[bot.id, bot]]);
  const rows: Array<Omit<DecisionRow, "at">> = [];
  const lines: string[] = [];
  const shared = options.shared ?? installation("shared");
  const asked: Array<{ person: string | null; toolkit: string }> = [];
  const gate = createConnectorGate({
    bot: (id) => bots.get(id),
    apps: {
      configured: () => true,
      installation: (person, toolkit) => {
        asked.push({ person, toolkit });
        if (!(options.personApps ?? []).includes(toolkit)) return shared.value;
        return person && options.own ? options.own.value : null;
      },
      policyRefusal: () => options.policy,
    },
    ...(options.servers ? { servers: options.servers } : {}),
    decide: (row) => rows.push(row),
    log: (line) => lines.push(line),
    ...(options.callMs ? { callMs: options.callMs } : {}),
  });
  return { gate, bot, bots, rows, lines, shared, asked };
}

const GMAIL: AppConnectorUse = { connector: "gmail", tools: ["GMAIL_FETCH_EMAILS", "GMAIL_ADD_LABEL_TO_EMAIL", "GMAIL_SEND_EMAIL", "GMAIL_TRASH_MESSAGE"] };
let pages = 0;
function caller(over: Partial<ConnectorCaller> = {}): ConnectorCaller {
  pages += 1;
  return {
    botId: "b1", person: null, declared: [GMAIL], fullAccess: () => true, engaged: false,
    audit: { label: `page p${pages}`, key: `t1:p${pages}`, threadId: "t1" }, ...over,
  };
}

describe("a connected app's tool, called outside a turn", () => {
  it("runs a declared read with the account the server chooses, and answers with the tool's data alone", async () => {
    const shared = installation("shared", { accounts: [{ id: "ca_new", status: "ACTIVE" }, { id: "ca_old", status: "ACTIVE" }] });
    const { gate } = fixture({ shared });
    const answer = await gate.call(caller(), { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, { max_results: 3, account: "ca_someone_else" });
    expect(answer).toEqual({ ok: true, result: { messages: [{ id: "m1", subject: "Hi" }] } });
    // Exactly the declared tool, with the page's arguments as the tool's own, and the account the server picked.
    expect(shared.calls()).toEqual([{
      jsonrpc: "2.0", id: expect.any(Number), method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { max_results: 3, account: "ca_someone_else" }, account: "ca_new" }] } },
    }]);
    expect(shared.frames[0]!.frame.method).toBe("initialize");
    expect(shared.frames.at(-1)!.session).toBe("shared-session");
  });

  it("uses an account the bot is limited to, and the calling person's own installation where each person connects the app", async () => {
    const own = installation("person:ada", { accounts: [{ id: "ca_a", status: "ACTIVE" }, { id: "ca_b", status: "ACTIVE" }] });
    const { gate, shared, asked } = fixture({ own, personApps: ["gmail"], bot: { connectorScopes: { apps: { gmail: "write" }, accounts: { gmail: ["ca_b"] } } as GateBot["connectorScopes"] } });
    expect((await gate.call(caller({ person: "ada" }), { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, {})).ok).toBe(true);
    expect(asked).toEqual([{ person: "ada", toolkit: "gmail" }]);
    expect(own.calls()[0]).toMatchObject({ params: { arguments: { tools: [{ account: "ca_b" }] } } });
    expect(shared.frames).toEqual([]);
    const nobody = await gate.call(caller({ person: null }), { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, {});
    expect(nobody).toEqual({ ok: false, reason: "not-connected", status: 409, message: "Connect Gmail in Apps first." });
  });

  it("refuses in order: not declared, not granted, not connected, the access level, then a missing click", async () => {
    const tool = { connector: "gmail", tool: "GMAIL_ADD_LABEL_TO_EMAIL" };
    const undeclared = fixture();
    expect(await undeclared.gate.call(caller({ declared: [] }), tool, {})).toMatchObject({ ok: false, reason: "not-declared", message: 'This page did not declare GMAIL_ADD_LABEL_TO_EMAIL: list "gmail:GMAIL_ADD_LABEL_TO_EMAIL" in show_html uses to call it.' });

    const ungranted = fixture({ bot: { connectorTools: { gmail: { tools: ["GMAIL_FETCH_EMAILS"] } } } });
    expect(await ungranted.gate.call(caller(), tool, {})).toMatchObject({ ok: false, reason: "not-granted", message: "Scout is not allowed GMAIL_ADD_LABEL_TO_EMAIL in Gmail. The person can allow it in Scout's Apps settings." });
    const appsOff = fixture({ bot: { composio: false } });
    expect(await appsOff.gate.call(caller(), tool, {})).toMatchObject({ ok: false, reason: "not-granted", message: "Scout cannot use connected apps." });
    const readScope = fixture({ bot: { connectorScopes: { apps: { gmail: "read" } } } });
    expect(await readScope.gate.call(caller({ engaged: true }), tool, {})).toMatchObject({ ok: false, reason: "not-granted" });
    const policy = fixture({ policy: "Acme does not allow bots to use Gmail." });
    expect(await policy.gate.call(caller(), tool, {})).toMatchObject({ ok: false, reason: "not-granted", message: "Acme does not allow bots to use Gmail." });

    const unconnected = fixture({ shared: installation("shared", { connected: false }) });
    expect(await unconnected.gate.call(caller(), tool, {})).toEqual({ ok: false, reason: "not-connected", status: 409, message: "Connect Gmail in Apps first." });

    const asks = fixture();
    expect(await asks.gate.call(caller({ fullAccess: () => false, engaged: true }), tool, {})).toEqual({
      ok: false, reason: "needs-access", status: 403,
      message: "Scout asks before it changes anything, so this page can only read Gmail. Ask Scout in the chat to do it, or set Scout to Full access.",
    });
    expect(await asks.gate.call(caller(), tool, {})).toEqual({ ok: false, reason: "needs-click", status: 403, message: "This changes something in Gmail, so it runs only right after the person clicks in this page." });
    expect(asks.shared.calls()).toEqual([]);
    expect(await asks.gate.call(caller({ engaged: true }), tool, {})).toMatchObject({ ok: true });
  });

  it("decides read-only by the tool's own listing, never by its name, and a send also follows the bot's own sending rule", async () => {
    // A tool named like a read that its listing does not mark read-only is a change; one named like a send that it marks is a read.
    const named = fixture({ shared: installation("shared", { readOnly: ["GMAIL_SEND_EMAIL"] }) });
    expect(await named.gate.call(caller(), { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, {})).toMatchObject({ ok: false, reason: "needs-click" });
    expect(await named.gate.call(caller({ fullAccess: () => false }), { connector: "gmail", tool: "GMAIL_SEND_EMAIL" }, {})).toMatchObject({ ok: true });

    const careful = fixture({ shared: installation("shared", { readOnly: [] }), bot: { outbound: { policy: "ask" } } });
    expect(await careful.gate.call(caller({ engaged: true }), { connector: "gmail", tool: "GMAIL_SEND_EMAIL" }, {})).toEqual({
      ok: false, reason: "needs-access", status: 403,
      message: "Scout asks before it sends anything for you, so this page cannot send through Gmail. Ask Scout in the chat to send it.",
    });
    expect(await careful.gate.call(caller({ engaged: true }), { connector: "gmail", tool: "GMAIL_TRASH_MESSAGE" }, {})).toMatchObject({ ok: true });
  });

  it("reads the bot again just before the call goes out", async () => {
    let fixtureRef: ReturnType<typeof fixture> | undefined;
    const shared = installation("shared");
    const slow: AppInstallation = { ...shared.value, readOnlyTools: async () => { fixtureRef!.bots.set("b1", { ...fixtureRef!.bot, composio: false }); return new Set(["GMAIL_FETCH_EMAILS"]); } };
    fixtureRef = fixture({ shared: { ...shared, value: slow } });
    expect(await fixtureRef.gate.call(caller(), { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, {})).toMatchObject({ ok: false, reason: "not-granted" });
    expect(shared.calls()).toEqual([]);
  });

  it("passes the tool's own failure on, cleaned and capped, and a plain-text answer as text", async () => {
    const failing = fixture({ shared: installation("shared", { answer: () => executed("GMAIL_FETCH_EMAILS", null, false, `bad token sk-ant-api03-${"x".repeat(40)} ${"y".repeat(3_000)}`) }) });
    const failed = await failing.gate.call(caller(), { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, {});
    expect(failed).toMatchObject({ ok: false, reason: "tool-failed", status: 502 });
    const message = failed.ok ? "" : failed.message;
    expect(message.startsWith("Gmail said: bad token")).toBe(true);
    expect(message).not.toContain("sk-ant-api03-x");
    expect(message.length).toBeLessThanOrEqual(APP_LIMITS.pageConnectorErrorChars + "Gmail said: ".length);
    const plain = fixture({ shared: installation("shared", { answer: () => ({ content: [{ type: "text", text: "Done: 3 messages" }] }) }) });
    expect(await plain.gate.call(caller(), { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, {})).toEqual({ ok: true, result: "Done: 3 messages" });
  });

  it("cuts a large answer to the limit and says so", async () => {
    const many = Array.from({ length: 4_000 }, (_, i) => ({ id: `m${i}`, snippet: "z".repeat(200) }));
    const { gate } = fixture({ shared: installation("shared", { answer: () => executed("GMAIL_FETCH_EMAILS", { messages: many, next: "tok" }) }) });
    const answer = await gate.call(caller(), { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, {});
    expect(answer).toMatchObject({ ok: true, truncated: true, result: { next: "tok" } });
    const kept = answer.ok ? (answer.result as { messages: unknown[] }).messages : [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(many.length);
    expect(Buffer.byteLength(JSON.stringify(answer.ok ? answer.result : null))).toBeLessThanOrEqual(APP_LIMITS.pageConnectorResultBytes);
    expect(fitResult("x".repeat(100), 10)).toEqual({ value: "\"xxxxxxxxx", truncated: true });
  });

  it("refuses arguments over the limit, and a call past its time", async () => {
    const { gate } = fixture();
    expect(await gate.call(caller(), { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, { q: "x".repeat(APP_LIMITS.pageConnectorArgsBytes) })).toMatchObject({ ok: false, reason: "too-large", status: 413 });
    const slow = fixture({ shared: installation("shared", { hang: true }), callMs: 30 });
    expect(await slow.gate.call(caller(), { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, {})).toEqual({ ok: false, reason: "timeout", status: 504, message: "The call ran past 0 seconds." });
  });

  it("holds every read the checks make to the time limit too", async () => {
    const shared = installation("shared");
    const stalled = { ...shared, value: { ...shared.value, readOnlyTools: () => new Promise<ReadonlySet<string>>(() => {}) } };
    const { gate, rows } = fixture({ shared: stalled, callMs: 30 });
    expect(await gate.call(caller(), { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, {})).toMatchObject({ ok: false, reason: "timeout", status: 504 });
    expect(shared.calls()).toEqual([]);
    expect(rows[0]).toMatchObject({ decision: "auto-denied", summary: expect.stringContaining(": timeout (gmail)") });
  });

  it("sends a call that may change something once, and sends a read again on a fresh session when the first try fails", async () => {
    const down = fixture({ shared: installation("shared", { status: 502, readOnly: [] }) });
    expect(await down.gate.call(caller({ engaged: true }), { connector: "gmail", tool: "GMAIL_TRASH_MESSAGE" }, {})).toMatchObject({ ok: false, reason: "unavailable" });
    expect(down.shared.calls()).toHaveLength(1);
    // Sent, so recorded as allowed, with what came of it.
    expect(down.rows[0]).toMatchObject({ decision: "auto-approved", summary: expect.stringContaining(": ran, unavailable (gmail)") });
    const read = fixture({ shared: installation("shared", { status: 502 }) });
    expect(await read.gate.call(caller(), { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, {})).toMatchObject({ ok: false, reason: "unavailable" });
    expect(read.shared.calls()).toHaveLength(2);
    expect(read.shared.frames.filter((one) => one.frame.method === "initialize")).toHaveLength(2);
  });

  it("limits calls per page and per bot and app", async () => {
    const { gate } = fixture();
    const page = caller();
    for (let i = 0; i < APP_LIMITS.pageConnectorCallsPerMinute; i++) expect((await gate.call(page, { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, {})).ok).toBe(true);
    expect(await gate.call(page, { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, {})).toEqual({ ok: false, reason: "rate-limited", status: 429, message: "Too many calls from this page. Wait a minute." });
    const other = caller();
    for (let i = 0; i < APP_LIMITS.connectorCallsPerMinute - APP_LIMITS.pageConnectorCallsPerMinute; i++) expect((await gate.call(other, { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, {})).ok).toBe(true);
    expect(await gate.call(caller(), { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, {})).toMatchObject({ ok: false, reason: "rate-limited", message: "Too many calls to Gmail from this page's bot. Wait a minute." });
  });

  it("records every call, allowed or refused, without its arguments or answer", async () => {
    const { gate, rows, lines } = fixture();
    const page = caller({ audit: { label: "page m9", key: "t1:m9", threadId: "t1" } });
    await gate.call(page, { connector: "gmail", tool: "GMAIL_FETCH_EMAILS" }, { q: "secret words" });
    await gate.call(page, { connector: "gmail", tool: "GMAIL_ADD_LABEL_TO_EMAIL" }, { q: "secret words" });
    expect(rows).toEqual([
      { threadId: "t1", botId: "b1", botName: "Scout", tool: "GMAIL_FETCH_EMAILS", summary: "page m9: ran (gmail)", decision: "auto-approved", source: "connector-scope", rule: "outside-turn:gmail" },
      { threadId: "t1", botId: "b1", botName: "Scout", tool: "GMAIL_ADD_LABEL_TO_EMAIL", summary: "page m9: needs-click (gmail)", decision: "auto-denied", source: "connector-scope", rule: "outside-turn:gmail" },
    ]);
    expect(lines).toEqual([expect.stringMatching(/^page m9 bot=b1 gmail tool=GMAIL_FETCH_EMAILS → ok \d+ms$/), expect.stringMatching(/^page m9 bot=b1 gmail tool=GMAIL_ADD_LABEL_TO_EMAIL → needs-click \d+ms$/)]);
    expect(JSON.stringify([rows, lines])).not.toContain("secret words");
  });

  it("is callable by server code with a declaration of its own and a fixed caller", async () => {
    const { gate, shared } = fixture();
    const { declared: _declared, ...identity } = caller();
    const call = bindConnectorGate(gate, identity);
    expect(await call([GMAIL], "gmail", "GMAIL_FETCH_EMAILS", {})).toMatchObject({ ok: true });
    expect(await call([], "gmail", "GMAIL_FETCH_EMAILS", {})).toMatchObject({ ok: false, reason: "not-declared" });
    expect(await call([GMAIL], "mcp:notes", "search", {})).toMatchObject({ ok: false, reason: "not-declared" });
    expect(shared.calls()).toHaveLength(1);
  });

  it("lists the declared tools with whether each app is connected for this person", async () => {
    const { gate } = fixture({ personApps: ["notion"] });
    expect(await gate.list(caller({ declared: [GMAIL, { connector: "notion", tools: ["NOTION_SEARCH"] }] }))).toEqual([
      { connector: "gmail", label: "Gmail", connected: true, tools: GMAIL.tools },
      { connector: "notion", label: "Notion", connected: false, tools: ["NOTION_SEARCH"] },
    ]);
  });
});

describe("an MCP server's tool, called outside a turn", () => {
  const NOTES: AppConnectorUse = { server: "notes", tools: ["search", "wipe", "list_items", "app_only"] };
  const tools = [
    { name: "search", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } },
    { name: "wipe", annotations: { readOnlyHint: true } },
    { name: "list_items" },
    { name: "app_only", annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["app"] } } },
  ];
  const servers = (opened: Awaited<ReturnType<GateServers["open"]>>): GateServers & { asked: string[] } => {
    const asked: string[] = [];
    return { asked, open: async (_bot, person, name) => { asked.push(`${person ?? "-"}:${name}`); return opened; } };
  };

  it("runs a read by the tool's own annotation, whatever its name, and answers with its structured content", async () => {
    const fake = fakeServer(tools, (tool) => ({ content: [{ type: "text", text: "x" }], structuredContent: { tool } }));
    const { gate } = fixture({ servers: servers({ ok: true, server: fake.server }) });
    const page = caller({ declared: [NOTES], fullAccess: () => false });
    expect(await gate.call(page, { server: "notes", tool: "wipe" }, { all: true })).toEqual({ ok: true, result: { tool: "wipe" } });
    expect(await gate.call(page, { server: "notes", tool: "list_items" }, {})).toMatchObject({ ok: false, reason: "needs-access" });
    expect(await gate.call(caller({ declared: [NOTES] }), { server: "notes", tool: "list_items" }, {})).toMatchObject({ ok: false, reason: "needs-click" });
    expect(fake.calls).toEqual([{ tool: "wipe", args: { all: true } }]);
  });

  it("refuses a tool the bot's selection leaves out, one only the server's own app may call, and a server not connected", async () => {
    const fake = fakeServer(tools);
    const scoped = fixture({ servers: servers({ ok: true, server: fake.server }), bot: { toolScope: { allow: ["mcp:notes:list_items"] } } });
    expect(await scoped.gate.call(caller({ declared: [NOTES] }), { server: "notes", tool: "search" }, {})).toMatchObject({ ok: false, reason: "not-granted" });
    const open = fixture({ servers: servers({ ok: true, server: fake.server }) });
    expect(await open.gate.call(caller({ declared: [NOTES] }), { server: "notes", tool: "app_only" }, {})).toMatchObject({ ok: false, reason: "not-granted", message: "notes has no tool app_only for Scout." });
    const signedOut = fixture({ servers: servers({ ok: false, reason: "not-connected", label: "notes" }) });
    expect(await signedOut.gate.call(caller({ declared: [NOTES] }), { server: "notes", tool: "search" }, {})).toEqual({ ok: false, reason: "not-connected", status: 409, message: "Connect notes in Settings first." });
    expect(fake.calls).toEqual([]);
  });

  it("opens the server for the calling person", async () => {
    const fake = fakeServer(tools);
    const opener = servers({ ok: true, server: fake.server });
    const { gate } = fixture({ servers: opener });
    expect(await gate.call(caller({ declared: [NOTES], person: "ada" }), { server: "notes", tool: "search" }, { q: "x" })).toEqual({ ok: true, result: "ran search" });
    expect(opener.asked).toEqual(["ada:notes"]);
  });
});
