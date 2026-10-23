  import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { SessionRegistry } from "./sessions.ts";
import { waitForExit } from "./testing/cleanup.ts";

const key = "isolated-trust-capability";
let fixture: VerificationServer;
let child: ChildProcess;
let broker: Server;
let admin: string;
let member: string;
let fullBot: any;
let askSibling: any;
let threadFullBot: any;
let roomChief: any;
let brokerOrigin = "";
const relayed: unknown[] = [];
const evidence: unknown[] = [];
let blockRelay: (() => void) | undefined;
let relayEntered = false;
let blockSession: (() => void) | undefined;
let sessionEntered = false;
const api = async (method: string, path: string, body?: unknown, token = admin) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  });
  const result = { status: response.status, body: await response.json() as any };
  evidence.push({ method, path, result });
  return result;
};
// Below Full access, so sends reach the outbound card and the daily allowance.
const bot = async (name: string) => {
  const created = await api("POST", "/api/bots", { name, settings: { approvalMode: "ask" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await api("PATCH", `/api/bots/${created.body.bot.id}`, { approvalMode: "ask" })).status).toBe(200);
  return created.body.bot;
};
const mint = async (botId: string, threadId: string, kind = "connectors") => {
  const response = await fetch(fixture.info.url + "/api/testing/internal-capability", {
    method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": key },
    body: JSON.stringify({ botId, threadId, kind }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as any).token as string;
};
const relay = (token: string, name: string, args: unknown = {}) => api("POST", "/api/internal/connectors/mcp",
  { jsonrpc: "2.0", id: Math.random(), method: "tools/call", params: { name, arguments: args } }, token);
const cards = async (thread: string) => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).body.messages as any[];
const pending = async (thread: string) => {
  let card: any;
  await expect.poll(async () => {
    card = (await cards(thread)).findLast((row: any) => row.card?.outboundRequest && !row.card.answered);
    return Boolean(card);
  }, { timeout: 5_000 }).toBe(true);
  return card;
};

beforeAll(async () => {
  broker = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/connectors/connected") return res.end(JSON.stringify({ services: { gmail: { connected: true }, slack: { connected: true } } }));
    if (req.url === "/api/tool_router/session/fixture-session") {
      if (blockSession) {
        sessionEntered = true;
        await new Promise<void>(resolve => { blockSession = resolve; });
      }
      return res.end(JSON.stringify({ session_id: "fixture-session", mcp: { type: "http", url: brokerOrigin + "/mcp" },
        config: { user_id: "fixture-user", multi_account: { enable: true, max_accounts_per_toolkit: 5, require_explicit_selection: true } } }));
    }
    if (req.url === "/mcp") {
      relayed.push(body);
      if (blockRelay) {
        relayEntered = true;
        await new Promise<void>(resolve => { blockRelay = resolve; });
      }
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "relay-ok" }] } }));
    }
    return res.end(JSON.stringify({ items: [{ slug: "gmail", connected_account: { id: "fixture-account", status: "ACTIVE" } }] }));
  });
  await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
  const address = broker.address() as { port: number };
  brokerOrigin = `http://127.0.0.1:${address.port}`;
  fixture = await launchVerificationServer();
  const created = await fetch(fixture.info.url + "/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Existing Full grant" }) });
  expect(created.status).toBe(201);
  fullBot = (await created.json() as any).bot;
  const createThread = await fetch(fixture.info.url + `/api/bots/${fullBot.id}/tasks`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Ask sibling", approvalMode: "ask" }),
  });
  expect(createThread.status).toBe(201);
  askSibling = (await createThread.json() as any).task;
  const inverse = await fetch(fixture.info.url + "/api/bots", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Full thread, Ask default", settings: { approvalMode: "ask" } }),
  });
  expect(inverse.status).toBe(201);
  threadFullBot = (await inverse.json() as any).bot;
  const fullThread = await fetch(fixture.info.url + `/api/bots/${threadFullBot.id}/tasks`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Full thread" }),
  });
  expect(fullThread.status).toBe(201);
  threadFullBot.activeTaskId = (await fullThread.json() as any).task.threadId;
  const chiefCreated = await fetch(fixture.info.url + "/api/bots", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Room Full Chief" }) });
  expect(chiefCreated.status).toBe(201);
  roomChief = (await chiefCreated.json() as any).bot;
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const botsFile = join(fixture.info.dataDir, "bots.json");
  const bots = JSON.parse(readFileSync(botsFile, "utf8"));
  const saved = bots.find((row: any) => row.id === fullBot.id);
  saved.approvalMode = "full";
  saved.autoApprove = false;
  for (const task of saved.tasks) { task.approvalMode = task.threadId === askSibling.threadId ? "ask" : "full"; task.autoApprove = false; }
  const savedInverse = bots.find((row: any) => row.id === threadFullBot.id);
  savedInverse.tasks.find((task: any) => task.threadId === threadFullBot.activeTaskId).approvalMode = "full";
  const savedChief = bots.find((row: any) => row.id === roomChief.id);
  savedChief.chiefOfStaff = true;
  savedChief.approvalMode = "full";
  savedChief.modelSelection.instanceId = "roomTrustFixture";
  for (const task of savedChief.tasks) task.approvalMode = "full";
  writeFileSync(botsFile, JSON.stringify(bots));
  const configFile = join(fixture.info.dataDir, "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.signIn = { admins: ["admin@fixture.test"], members: ["member@fixture.test"] };
  config.composio = { apiKey: "ak_isolated_fixture", userId: "fixture-user", sessionId: "fixture-session" };
  config.instances.roomTrustFixture = { ...config.instances.claude, displayName: "Room connector fixture",
    environment: { FAKE_CLAUDE_ROOM_PLAN: join(fixture.info.dataDir, "room-plan.json") } };
  config.instances.activityFixture = { ...config.instances.claude, displayName: "Exact task activity fixture",
    environment: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RELEASE: join(fixture.info.dataDir, "activity-release") } };
  writeFileSync(configFile, JSON.stringify(config));
  const sessions = new SessionRegistry({ file: join(fixture.info.dataDir, "sessions.json"),
    emailScopes: email => email === "admin@fixture.test" ? ["admin", "client"] : ["client"] });
  admin = sessions.issue({ label: "isolated admin", email: "admin@fixture.test", scopes: ["admin", "client"] }).token;
  member = sessions.issue({ label: "isolated member", email: "member@fixture.test", scopes: ["client"] }).token;
  sessions.close();
  const log = openSync(fixture.info.logPath, "a", 0o600);
  child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...verificationServerEnvironment({}, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
      OMB_TEST_INTERNAL_CAPABILITY_KEY: key, OMB_COMPOSIO_API: brokerOrigin + "/api", OMB_COMPOSIO_TOOLKITS_API: brokerOrigin + "/api" },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(fixture.info.url + "/api/health")).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("isolated trust server did not start");
}, 40_000);

afterAll(async () => {
  blockRelay?.();
  blockSession?.();
  const evidencePath = fixture.info.logPath + ".trust-controls.json";
  writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence, relayed }, null, 2));
  await waitForExit(child, { signal: "SIGTERM" });
  await fixture.close();
  await new Promise<void>(resolve => broker.close(() => resolve()));
  console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath, fixtureRemoved: !existsSync(fixture.info.dataDir) }));
});

it("keeps activity, shared memory and policy changes admin-only", async () => {
  const b = await bot("Trust authority");
  expect((await api("GET", `/api/bots/${b.id}/activity`)).status).toBe(200);
  expect((await api("GET", `/api/bots/${b.id}/activity`, undefined, member)).status).toBe(403);
  expect((await api("GET", "/api/team-memory?section=", undefined, member)).status).toBe(403);
  expect((await api("POST", "/api/team-memory?section=", { kind: "term", name: "Denied", detail: "not admin" }, member)).status).toBe(403);
  expect((await api("PATCH", "/api/team-memory/fixture?section=", { detail: "not admin" }, member)).status).toBe(403);
  expect((await api("DELETE", "/api/team-memory/fixture?section=", undefined, member)).status).toBe(403);
  for (const patch of [{ outbound: { policy: "allow", dailyCap: 100 } }, { connectorScopes: null }, { fallback: [] }]) {
    expect((await api("PATCH", `/api/bots/${b.id}`, patch, member)).status).toBe(403);
  }
  expect((await api("PATCH", `/api/bots/${b.id}`, { fallback: [{ instanceId: "claude", model: " " }] })).status).toBe(400);
});

it("sends in Full without a card, and still refuses an app outside the bot's scope", async () => {
  const b = fullBot;
  const fleet = await api("GET", "/api/bots");
  expect(fleet.body.bots.find((row: any) => row.id === b.id).approvalMode).toBe("full");
  const token = await mint(b.id, b.threadId);
  const before = relayed.length;
  expect((await relay(token, "GMAIL_SEND_EMAIL", { to: "first@fixture.test" })).body.result.isError).not.toBe(true);
  expect((await relay(token, "COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "print(1)" })).body.result.isError).not.toBe(true);
  expect(relayed).toHaveLength(before + 2);
  expect((await cards(b.threadId)).some((row: any) => row.card?.outboundRequest)).toBe(false);
  await api("PATCH", `/api/bots/${b.id}`, { connectorScopes: { apps: { gmail: "read" } } });
  expect((await relay(token, "GMAIL_SEND_EMAIL")).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before + 2);
});

it("honors Full for direct sends, batches and opaque code without cards or daily caps", async () => {
  await api("PATCH", `/api/bots/${fullBot.id}`, { connectorScopes: null, outbound: { policy: "allow", dailyCap: 1 } });
  const token = await mint(fullBot.id, fullBot.threadId);
  const fullDecisions = async () => ((await api("GET", "/api/decisions?limit=100")).body.decisions as any[])
    .filter(row => row.botId === fullBot.id && row.threadId === fullBot.threadId && row.source === "full-access" && row.decision === "auto-approved").length;
  const decisionsBefore = await fullDecisions();
  const operations = [
    ["COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "print('synthetic fixture')" }],
    ["GMAIL_SEND_EMAIL", { to: "fixture@example.invalid" }],
    ["COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }, { tool_slug: "SLACK_SEND_MESSAGE" }] }],
    ["COMPOSIO_REMOTE_BASH_TOOL", { command: "printf fixture" }],
  ] as const;
  for (const [name, args] of operations) {
    const before = relayed.length;
    const result = relay(token, name, args);
    let held: any;
    await expect.poll(async () => {
      held = (await cards(fullBot.threadId)).findLast(row => row.card?.outboundRequest && !row.card.answered);
      return relayed.length > before || Boolean(held);
    }, { timeout: 5_000 }).toBe(true);
    // Settle an unexpected card before asserting, so a broken gate cannot
    // leave an unresolved request in the disposable server.
    if (held) await api("POST", `/api/threads/${fullBot.threadId}/respond`, { requestId: held.card.requestId, behavior: "deny" });
    expect((await result).body.result.isError).not.toBe(true);
    expect(held).toBeUndefined();
    expect(relayed).toHaveLength(before + 1);
    expect((relayed.at(-1) as any).params).toEqual({ name, arguments: args });
  }
  expect((await api("GET", `/api/bots/${fullBot.id}/outbound`)).body.today).toBe(0);
  await expect.poll(fullDecisions).toBe(decisionsBefore + operations.length);
});

it("uses the calling thread's Full grant rather than the bot default or selected sibling", async () => {
  const askToken = await mint(fullBot.id, askSibling.threadId);
  const before = relayed.length;
  const held = relay(askToken, "COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "print('Ask sibling')" });
  const card = await pending(askSibling.threadId);
  await api("POST", `/api/threads/${askSibling.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  expect((await held).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
  const fullToken = await mint(threadFullBot.id, threadFullBot.activeTaskId);
  expect((await relay(fullToken, "GMAIL_SEND_EMAIL")).body.result.isError).not.toBe(true);
  expect(relayed).toHaveLength(before + 1);
  expect((await cards(threadFullBot.activeTaskId)).some(row => row.card?.outboundRequest)).toBe(false);
});

it("preserves explicit connector scopes in Full, including changes before dispatch", async () => {
  const token = await mint(fullBot.id, fullBot.threadId);
  const before = relayed.length;
  await api("PATCH", `/api/bots/${fullBot.id}`, { connectorScopes: { apps: { gmail: "read" } } });
  expect((await relay(token, "GMAIL_SEND_EMAIL")).body.result.isError).toBe(true);
  expect((await relay(token, "COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "print('restricted')" })).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
  await api("PATCH", `/api/bots/${fullBot.id}`, { connectorScopes: null });
  sessionEntered = false;
  blockSession = () => {};
  const held = relay(token, "GMAIL_SEND_EMAIL");
  try {
    await expect.poll(() => sessionEntered, { timeout: 5_000 }).toBe(true);
    await api("PATCH", `/api/bots/${fullBot.id}`, { connectorScopes: { apps: { gmail: "read" } } });
  } finally {
    blockSession();
    blockSession = undefined;
  }
  expect((await held).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
});

it("rechecks Full revocation after session metadata and before connector execution", async () => {
  const token = await mint(threadFullBot.id, threadFullBot.activeTaskId);
  const before = relayed.length;
  sessionEntered = false;
  blockSession = () => {};
  const held = relay(token, "COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "print('revoked before dispatch')" });
  try {
    await expect.poll(() => sessionEntered, { timeout: 5_000 }).toBe(true);
    expect((await api("PATCH", `/api/bots/${threadFullBot.id}/tasks/${threadFullBot.activeTaskId}`, { approvalMode: "ask" })).status).toBe(200);
  } finally {
    blockSession();
    blockSession = undefined;
  }
  expect((await held).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
});

it("shows each outbound batch recipient and amount with explicit preview truncation before consent", async () => {
  const b = await bot("Batch consent preview");
  const token = await mint(b.id, b.threadId);
  const before = relayed.length;
  const held = relay(token, "COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [
    { tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "first@fixture.test", body: "x".repeat(450) } },
    { tool_slug: "STRIPE_CREATE_REFUND", arguments: { recipient: "second@fixture.test", amount: 42 } },
  ] });
  const card = await pending(b.threadId);
  expect(card.card.subtitle).toContain("first@fixture.test");
  expect(card.card.subtitle).toContain("second@fixture.test");
  expect(card.card.subtitle).toContain('"amount":42');
  expect(card.card.subtitle).toContain("[arguments truncated]");
  expect(card.card.outboundRequest).toEqual({
    tool: "GMAIL_SEND_EMAIL",
    app: "Gmail",
    calls: [{ app: "Gmail", label: "Send email" }, { app: "Stripe", label: "Create refund" }],
  });
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  expect((await held).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
});

it.each(["scope", "turn"])("rechecks %s revocation after project-session metadata and before the actual send", async (revocation) => {
  const b = await bot("Session race " + revocation);
  const token = await mint(b.id, b.threadId);
  const before = relayed.length;
  const held = relay(token, "GMAIL_SEND_EMAIL");
  const card = await pending(b.threadId);
  sessionEntered = false;
  blockSession = () => {};
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" });
  await expect.poll(() => sessionEntered, { timeout: 5_000 }).toBe(true);
  if (revocation === "scope") await api("PATCH", `/api/bots/${b.id}`, { connectorScopes: { apps: { gmail: "read" } } });
  else await mint(b.id, b.threadId);
  blockSession();
  blockSession = undefined;
  const result = await held;
  if (revocation === "scope") expect(result.body.result.isError).toBe(true);
  else expect(result.status).toBe(401);
  expect(relayed).toHaveLength(before);
});

it("reserves a daily slot before provider await, so simultaneous calls cannot overspend", async () => {
  const b = await bot("Concurrent cap");
  await api("PATCH", `/api/bots/${b.id}`, { outbound: { policy: "allow", dailyCap: 1 } });
  const token = await mint(b.id, b.threadId);
  relayEntered = false;
  blockRelay = () => {};
  const first = relay(token, "GMAIL_SEND_EMAIL");
  await expect.poll(() => relayEntered, { timeout: 5_000 }).toBe(true);
  expect((await relay(token, "GMAIL_SEND_EMAIL")).body.result.isError).toBe(true);
  expect((await api("GET", `/api/bots/${b.id}/outbound`)).body.today).toBe(1);
  blockRelay();
  blockRelay = undefined;
  expect((await first).body.result.isError).not.toBe(true);
  expect((await api("GET", `/api/bots/${b.id}/outbound`)).body.today).toBe(1);
});

it("never treats arbitrary workbench code as a counted daily allowance", async () => {
  const b = await bot("Opaque code");
  await api("PATCH", `/api/bots/${b.id}`, { outbound: { policy: "allow", dailyCap: 1 } });
  const token = await mint(b.id, b.threadId);
  const before = relayed.length;
  const held = relay(token, "COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: 'for x in range(99): run_tool("GMAIL_" + "SEND_EMAIL", {})' });
  const card = await pending(b.threadId);
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  expect((await held).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
  await api("PATCH", `/api/bots/${b.id}`, { connectorScopes: { apps: { gmail: "write" } } });
  expect((await relay(token, "COMPOSIO_REMOTE_BASH_TOOL", { command: "curl -X POST https://fixture.test/send" })).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
});

it("tells a scoped bot its multi-execute arguments were unreadable, not that it lacks access", async () => {
  const b = await bot("Misshapen batch");
  await api("PATCH", `/api/bots/${b.id}`, { connectorScopes: { apps: { gmail: "write" } } });
  const token = await mint(b.id, b.threadId);
  const before = relayed.length;
  const refused = await relay(token, "COMPOSIO_MULTI_EXECUTE_TOOL", { tool_calls: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }] });
  expect(refused.body.result.isError).toBe(true);
  const text = refused.body.result.content[0].text;
  expect(text).not.toContain("has not been given access");
  expect(text).not.toContain("do not retry");
  expect(text).toContain("could not read");
  expect(text).toContain("tools: [{ tool_slug, arguments }]");
  expect(relayed).toHaveLength(before);
  const resent = await relay(token, "COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }] });
  expect(resent.body.result.content[0].text).toBe("relay-ok");
  expect(relayed).toHaveLength(before + 1);
});

it("applies a bot's team fact at Ask with an Undo only an admin may use, and still refuses restricted memory", async () => {
  const b = await bot("Team facts");
  const token = await mint(b.id, b.threadId, "agents");
  const propose = (detail: string) => api("POST", "/api/internal/team-memory",
    { fromBotId: b.id, fromThreadId: b.threadId, kind: "person", name: "Alex", detail }, token);
  const remembered = async () => (await api("GET", "/api/team-memory?section=")).body.entries
    .filter((entry: any) => entry.name === "Alex" && entry.status === "accepted").map((entry: any) => entry.detail);
  const first = await propose("original");
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(first.body).toMatchObject({ status: "applied", state: "applied" });
  expect(await remembered()).toEqual(["original"]);
  expect((await cards(b.threadId)).find((row: any) => row.card?.requestId === first.body.requestId).card)
    .toMatchObject({ title: "Remembered for the team", answered: "allow", autoApplied: true, options: [] });
  const replacement = await propose("replacement");
  expect(replacement.body.state).toBe("applied");
  expect(await remembered()).toEqual(["replacement"]);
  expect((await api("POST", `/api/threads/${b.threadId}/undo`, { requestId: replacement.body.requestId }, member)).status).toBe(403);
  expect((await api("POST", `/api/threads/${b.threadId}/undo`, { requestId: replacement.body.requestId })).body).toMatchObject({ ok: true, undone: true });
  expect(await remembered()).toEqual(["original"]);
  await api("PATCH", `/api/bots/${b.id}`, { visibility: "admins" });
  expect((await propose("private")).status).toBe(403);
  const publicBot = await bot("Public room participant");
  await api("PATCH", `/api/bots/${b.id}`, { visibility: null });
  const room = await api("POST", "/api/groups", { name: "Restricted room", memberIds: [publicBot.id, b.id] });
  expect(room.status, JSON.stringify(room.body)).toBe(201);
  const roomThread = room.body.group.threadId;
  await api("PATCH", `/api/bots/${b.id}`, { visibility: "admins" });
  const roomToken = await mint(publicBot.id, roomThread, "agents");
  expect((await api("POST", "/api/internal/team-memory", { fromBotId: publicBot.id, fromThreadId: roomThread,
    kind: "term", name: "Private room term", detail: "cannot share with sibling bots" }, roomToken)).status).toBe(403);
  expect((await api("POST", "/api/team-memory?section=", { kind: "term", name: "Human", detail: "approved by admin" })).status).toBe(201);
});

it("puts a bot's fact into every teammate's prompt at once, and Undo takes it back out", async () => {
  const b = await bot("Team context");
  const token = await mint(b.id, b.threadId, "agents");
  const name = "Payroll drive";
  const detail = "APPLIED_PLACE_7Q: the shared payroll folder";
  const proposed = await api("POST", "/api/internal/team-memory", { fromBotId: b.id, fromThreadId: b.threadId, kind: "place", name, detail }, token);
  expect(proposed.body).toMatchObject({ status: "applied", state: "applied" });
  expect(JSON.stringify((await api("GET", `/api/bots/${b.id}/system-prompt`)).body)).toContain(detail);
  expect((await api("POST", `/api/threads/${b.threadId}/undo`, { requestId: proposed.body.requestId })).body).toMatchObject({ ok: true, undone: true });
  expect(JSON.stringify((await api("GET", `/api/bots/${b.id}/system-prompt`)).body)).not.toContain(detail);
  expect((await api("GET", "/api/team-memory?section=")).body.entries.some((entry: any) => entry.name === name)).toBe(false);
  expect((await cards(b.threadId)).find((row: any) => row.card?.requestId === proposed.body.requestId).card).toMatchObject({ undone: true });
  expect((await api("POST", `/api/threads/${b.threadId}/undo`, { requestId: proposed.body.requestId })).body).toMatchObject({ alreadyUndone: true });
});

it("settles only the source task after approval or Stop, leaving the selected sibling unchanged", async () => {
  for (const stop of [true, false]) {
    const b = await bot("Task activity " + stop);
    await api("PATCH", `/api/bots/${b.id}/tasks/${b.threadId}`, { modelSelection: { instanceId: "activityFixture", model: "claude-sonnet-5" } });
    const sibling = await api("POST", `/api/bots/${b.id}/tasks`, { title: "Selected idle sibling" });
    const siblingId = sibling.body.task.threadId;
    expect((await api("POST", `/api/bots/${b.id}/messages`, { text: "WAIT_FOR_ACTIVITY_FIXTURE", threadId: b.threadId })).status).toBe(202);
    const state = async () => (await api("GET", "/api/bots")).body.bots.find((row: any) => row.id === b.id);
    await expect.poll(async () => (await state()).tasks.find((row: any) => row.threadId === b.threadId).busy).toBe(true);
    const token = await mint(b.id, b.threadId);
    const held = relay(token, "GMAIL_SEND_EMAIL");
    const card = await pending(b.threadId);
    expect((await state()).tasks.find((row: any) => row.threadId === b.threadId).activity).toBe("waiting-on-you");
    expect((await state()).tasks.find((row: any) => row.threadId === siblingId).busy).toBe(false);
    if (stop) await api("POST", `/api/bots/${b.id}/interrupt`, { threadId: b.threadId });
    await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" });
    const response = await held;
    if (stop) expect(response.status).toBe(401);
    else {
      expect(response.body.result.isError).not.toBe(true);
      writeFileSync(join(fixture.info.dataDir, "activity-release"), "fixture completion");
    }
    await expect.poll(async () => (await state()).activity, { timeout: 8_000 }).toBe("idle");
    expect((await state()).tasks.find((row: any) => row.threadId === siblingId)).toMatchObject({ busy: false, activity: "idle" });
  }
});

it("preserves accounts referenced by a fallback chain before delete or credential-directory change", async () => {
  const account = await api("POST", "/api/instances/claude-accounts", { displayName: "Fallback fixture account" });
  expect(account.status, JSON.stringify(account.body)).toBe(201);
  const instanceId = account.body.instanceId;
  const b = await bot("Referenced fallback");
  expect((await api("PATCH", `/api/bots/${b.id}`, { fallback: [{ instanceId, model: "claude-sonnet-5" }] })).status).toBe(200);
  expect((await api("DELETE", `/api/instances/${instanceId}`)).status).toBe(409);
  expect((await api("PATCH", `/api/instances/${instanceId}`, { configDir: join(fixture.info.dataDir, "synthetic-account-directory") })).status).toBe(409);
  await api("PATCH", `/api/bots/${b.id}`, { fallback: [] });
  expect((await api("DELETE", `/api/instances/${instanceId}`)).status).toBe(200);
});

it("uses live Chief handoff authority for connector sends and code, without leaking to later room turns", async () => {
  const memberBot = await bot("Ask room sender");
  const selection = { instanceId: "roomTrustFixture", model: roomChief.modelSelection.model };
  await api("PATCH", `/api/bots/${memberBot.id}`, { modelSelection: selection, outbound: { policy: "allow", dailyCap: 1 } });
  const source = (await api("POST", "/api/groups", { name: "Chief source", memberIds: [roomChief.id] })).body.group;
  const destination = (await api("POST", "/api/groups", { name: "Member destination", memberIds: [memberBot.id] })).body.group;
  expect((await api("PATCH", `/api/groups/${source.id}/setup`, { action: "skip" })).status).toBe(200);
  expect((await api("PATCH", `/api/groups/${destination.id}/setup`, { action: "skip" })).status).toBe(200);
  const readyFile = join(fixture.info.dataDir, "room-member-ready");
  const gateFile = join(fixture.info.dataDir, "room-member-gate");
  const nextReady = join(fixture.info.dataDir, "room-member-next-ready");
  const nextGate = join(fixture.info.dataDir, "room-member-next-gate");
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  writeFileSync(planPath, JSON.stringify({
    [roomChief.id]: { turns: [
      { steps: [{ tool: "coordinate_bots", arguments: { group_id: destination.id, bot_ids: [memberBot.id], message: "Check the connector fixture" } }], reply: "Assigned" },
      { reply: "Finished" },
    ] },
    [memberBot.id]: { turns: [
      { readyFile, gateFile, reply: "Checked" }, { readyFile: nextReady, gateFile: nextGate, reply: "Ordinary room reply" },
    ] },
  }));
  const dump = () => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  const connectorToken = () => Object.values(dump().mcpConfig.mcpServers as Record<string, any>)
    .find(mount => mount.env?.OMB_CONNECTOR_TOKEN)?.env.OMB_CONNECTOR_TOKEN as string;
  const settled = async (groupId: string) => expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.groups
    .find((group: any) => group.id === groupId)?.working, { timeout: 20_000 }).toBe(false);
  let token = "";
  try {
    expect((await api("POST", `/api/groups/${source.id}/messages`, { text: "Delegate the fixture check", threadId: source.threadId })).status).toBe(202);
    await expect.poll(() => existsSync(readyFile), { timeout: 20_000 }).toBe(true);
    token = connectorToken();
    expect(token).toBeTruthy();
    expect(dump().argv).toContain("bypassPermissions");
    expect(dump().mcpConfig.mcpServers.agents.env.OMB_BOT_ID).toBe(memberBot.id);
    const inheritedCall = async (name: string, args = {}) => {
      const before = relayed.length;
      const result = relay(token, name, args);
      let card: any;
      await expect.poll(async () => {
        card = (await cards(destination.threadId)).findLast(row => row.card?.outboundRequest && !row.card.answered);
        return Boolean(card) || relayed.length > before;
      }, { timeout: 5_000 }).toBe(true);
      if (card) await api("POST", `/api/threads/${destination.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
      expect((await result).body.result.isError).not.toBe(true);
      expect(card).toBeUndefined();
      expect(relayed).toHaveLength(before + 1);
    };
    await inheritedCall("GMAIL_SEND_EMAIL");
    await inheritedCall("GMAIL_SEND_EMAIL");
    await inheritedCall("COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "print('inherited authority')" });
    expect((await api("GET", `/api/bots/${memberBot.id}/outbound`)).body.today).toBe(0);
    expect((await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === memberBot.id).approvalMode ?? "ask").toBe("ask");
    const siblingToken = await mint(memberBot.id, memberBot.threadId);
    expect((await relay(siblingToken, "GMAIL_SEND_EMAIL")).body.result.isError).not.toBe(true);
    expect((await api("GET", `/api/bots/${memberBot.id}/outbound`)).body.today).toBe(1);
    expect((await relay(siblingToken, "GMAIL_SEND_EMAIL")).body.result.isError).toBe(true);
    await inheritedCall("GMAIL_SEND_EMAIL");
    expect((await api("GET", `/api/bots/${memberBot.id}/outbound`)).body.today).toBe(1);
    expect((await api("PATCH", `/api/bots/${memberBot.id}`, { connectorTools: { gmail: { tools: ["GMAIL_SEND_EMAIL"] } } })).status).toBe(200);
    const restrictedCodeCount = relayed.length;
    expect((await relay(token, "COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "print('restricted grant')" })).body.result.isError).toBe(true);
    expect(relayed).toHaveLength(restrictedCodeCount);
    expect((await api("PATCH", `/api/bots/${memberBot.id}`, { connectorTools: null })).status).toBe(200);
    await api("PATCH", `/api/bots/${memberBot.id}`, { connectorScopes: { apps: { gmail: "read" } } });
    const restrictedCount = relayed.length;
    expect((await relay(token, "GMAIL_SEND_EMAIL")).body.result.isError).toBe(true);
    expect(relayed).toHaveLength(restrictedCount);
    await api("PATCH", `/api/bots/${memberBot.id}`, { connectorScopes: null });
    sessionEntered = false;
    blockSession = () => {};
    const beforeRevoke = relayed.length;
    const held = relay(token, "COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "print('must not run')" });
    try {
      await expect.poll(() => sessionEntered, { timeout: 5_000 }).toBe(true);
      expect((await api("PATCH", `/api/bots/${roomChief.id}`, { approvalMode: "ask" })).status).toBe(200);
    } finally { blockSession(); blockSession = undefined; }
    expect((await held).body.result.isError).toBe(true);
    expect(relayed).toHaveLength(beforeRevoke);
    writeFileSync(gateFile, "release");
    await settled(destination.id);
    await settled(source.id);
    expect((await relay(token, "GMAIL_SEND_EMAIL")).status).toBe(401);
    await api("PATCH", `/api/bots/${memberBot.id}`, { outbound: { policy: "ask", dailyCap: 1 } });
    expect((await api("POST", `/api/groups/${destination.id}/messages`, { text: "Ordinary user turn", threadId: destination.threadId })).status).toBe(202);
    await expect.poll(() => existsSync(nextReady), { timeout: 15_000 }).toBe(true);
    expect(dump().argv).not.toContain("bypassPermissions");
    const nextToken = connectorToken();
    const nextCount = relayed.length;
    const next = relay(nextToken, "GMAIL_SEND_EMAIL");
    const card = await pending(destination.threadId);
    await api("POST", `/api/threads/${destination.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
    expect((await next).body.result.isError).toBe(true);
    expect(relayed).toHaveLength(nextCount);
  } finally {
    evidence.push({ roomDump: existsSync(fixture.fixtureDumpPath) ? dump() : null,
      handoffs: existsSync(join(fixture.info.dataDir, "room-handoffs.json")) ? JSON.parse(readFileSync(join(fixture.info.dataDir, "room-handoffs.json"), "utf8")) : null,
      providerTurns: existsSync(planPath + ".evidence.jsonl") ? readFileSync(planPath + ".evidence.jsonl", "utf8") : null });
    await cards(source.threadId); await cards(destination.threadId);
    blockSession?.(); blockSession = undefined;
    writeFileSync(gateFile, "release"); writeFileSync(nextGate, "release");
    await api("POST", `/api/groups/${destination.id}/interrupt`, { threadId: destination.threadId });
    await api("POST", `/api/groups/${source.id}/interrupt`, { threadId: source.threadId });
  }
}, 60_000);

it("does not relay if the allowance cannot be durably written", async () => {
  const b = await bot("Failed allowance");
  await api("PATCH", `/api/bots/${b.id}`, { outbound: { policy: "allow", dailyCap: 1 } });
  const token = await mint(b.id, b.threadId);
  const file = join(fixture.info.dataDir, "outbound-counts.json");
  renameSync(file, file + ".saved");
  mkdirSync(file);
  const before = relayed.length;
  expect((await relay(token, "GMAIL_SEND_EMAIL")).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
  expect((await api("GET", `/api/bots/${b.id}/outbound`)).body.today).toBe(0);
});

it("asks in Ask, refuses denied sends, and rechecks scopes after an approval", async () => {
  const b = await bot("Ask sends");
  const token = await mint(b.id, b.threadId);
  const before = relayed.length;
  const denied = relay(token, "GMAIL_SEND_DRAFT", { draft_id: "fixture" });
  let card = await pending(b.threadId);
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  expect((await denied).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
  const held = relay(token, "GMAIL_SEND_EMAIL");
  card = await pending(b.threadId);
  await api("PATCH", `/api/bots/${b.id}`, { connectorScopes: { apps: { gmail: "read" } } });
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" });
  expect((await held).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
});
