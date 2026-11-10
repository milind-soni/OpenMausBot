import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
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
let draftBot: any;
let draftHelper: any;
let outboundPolicyBot: any;
let noRuleBot: any;
const gmailDrafts = new Map<string, Record<string, unknown>>();
let brokerOrigin = "";
const relayed: unknown[] = [];
const evidence: unknown[] = [];
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
const bot = async (name: string) => {
  const created = await api("POST", "/api/bots", { name });
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
      const tools = body.params?.arguments?.tools ?? [{ tool_slug: body.params?.name, arguments: body.params?.arguments }];
      if (tools.every((tool: any) => ["GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_UPDATE_DRAFT"].includes(tool.tool_slug))) {
        const results = tools.map((tool: any) => {
          const args = tool.arguments;
          const id = tool.tool_slug === "GMAIL_CREATE_EMAIL_DRAFT" ? `draft-${gmailDrafts.size + 1}` : args.draft_id;
          if (tool.tool_slug === "GMAIL_UPDATE_DRAFT" && !gmailDrafts.has(id)) return { tool_slug: tool.tool_slug, response: { successful: false, error: "Draft not found" } };
          gmailDrafts.set(id, args);
          return { tool_slug: tool.tool_slug, response: { successful: true, data: { id, message: { threadId: args.thread_id, body: args.body } } } };
        });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results } }) }] } }));
      }
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "relay-ok" }] } }));
    }
    return res.end(JSON.stringify({ items: [{ slug: "gmail", connected_account: { id: "fixture-account", status: "ACTIVE" } }] }));
  });
  await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
  const address = broker.address() as { port: number };
  brokerOrigin = `http://127.0.0.1:${address.port}`;
  fixture = await launchVerificationServer();
  // Seed an already-granted Full task here only: the public API refuses operator grants outside the desktop channel.
  const created = await fetch(fixture.info.url + "/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Existing Full grant" }) });
  expect(created.status).toBe(201);
  fullBot = (await created.json() as any).bot;
  const draftCreated = await fetch(fixture.info.url + "/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Full Gmail draft fixture" }) });
  expect(draftCreated.status).toBe(201);
  draftBot = (await draftCreated.json() as any).bot;
  const helperCreated = await fetch(fixture.info.url + "/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Full Gmail delegate fixture" }) });
  expect(helperCreated.status).toBe(201);
  draftHelper = (await helperCreated.json() as any).bot;
  const policyCreated = await fetch(fixture.info.url + "/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Full outbound policy fixture" }) });
  expect(policyCreated.status).toBe(201);
  outboundPolicyBot = (await policyCreated.json() as any).bot;
  const noRuleCreated = await fetch(fixture.info.url + "/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Full no sending rule fixture" }) });
  expect(noRuleCreated.status).toBe(201);
  noRuleBot = (await noRuleCreated.json() as any).bot;
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const botsFile = join(fixture.info.dataDir, "bots.json");
  const bots = JSON.parse(readFileSync(botsFile, "utf8"));
  const saved = bots.find((row: any) => row.id === fullBot.id);
  for (const full of [saved, ...[draftBot, draftHelper, outboundPolicyBot, noRuleBot].map(bot => bots.find((row: any) => row.id === bot.id))]) {
    full.approvalMode = "full";
    full.autoApprove = false;
    for (const task of full.tasks) { task.approvalMode = "full"; task.autoApprove = false; }
  }
  // Full access asks only for a bot someone set a sending rule on. These rules carry the daily cap older apps stored.
  for (const bot of [fullBot, draftBot, draftHelper, outboundPolicyBot]) bots.find((row: any) => row.id === bot.id).outbound = { policy: "ask", dailyCap: 100 };
  writeFileSync(botsFile, JSON.stringify(bots));
  const configFile = join(fixture.info.dataDir, "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.signIn = { admins: ["admin@fixture.test"], members: ["member@fixture.test"] };
  config.composio = { apiKey: "ak_isolated_fixture", userId: "fixture-user", sessionId: "fixture-session" };
  config.instances.activityFixture = { ...config.instances.claude, displayName: "Exact task activity fixture",
    environment: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RELEASE: join(fixture.info.dataDir, "activity-release") } };
  config.instances.gmailFixture = { ...config.instances.claude, displayName: "Gmail continuation fixture",
    environment: { FAKE_CLAUDE_ROOM_PLAN: join(fixture.info.dataDir, "gmail-plan.json") } };
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
    try { if ((await fetch(fixture.info.url + "/api/health")).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("isolated trust server did not start");
}, 40_000);

afterAll(async () => {
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
  for (const patch of [{ outbound: { policy: "allow" } }, { connectorScopes: null }, { fallback: [] }]) {
    expect((await api("PATCH", `/api/bots/${b.id}`, patch, member)).status).toBe(403);
  }
  expect((await api("PATCH", `/api/bots/${b.id}`, { fallback: [{ instanceId: "claude", model: " " }] })).status).toBe(400);
});

it("honors outbound approval and Send without asking at Full access, and still refuses apps outside scope", async () => {
  const b = fullBot;
  const fleet = await api("GET", "/api/bots");
  expect(fleet.body.bots.find((row: any) => row.id === b.id).approvalMode).toBe("full");
  const token = await mint(b.id, b.threadId);
  const before = relayed.length;
  const denied = relay(token, "GMAIL_SEND_EMAIL", { to: "first@fixture.test" });
  const deniedCard = await pending(b.threadId);
  expect(relayed).toHaveLength(before);
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: deniedCard.card.requestId, behavior: "deny" });
  expect((await denied).body.result.isError).toBe(true);
  const allowed = relay(token, "GMAIL_SEND_EMAIL", { to: "first@fixture.test" });
  const allowedCard = await pending(b.threadId);
  expect(relayed).toHaveLength(before);
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: allowedCard.card.requestId, behavior: "allow" });
  expect((await allowed).body.result.isError).not.toBe(true);
  expect(relayed).toHaveLength(before + 1);
  // An older app still sends the daily cap with the rule: it is accepted, dropped, and limits nothing.
  expect((await api("PATCH", `/api/bots/${b.id}`, { outbound: { policy: "allow", dailyCap: 1 } })).status).toBe(200);
  expect((await api("GET", "/api/bots")).body.bots.find((row: any) => row.id === b.id).outbound).toEqual({ policy: "allow" });
  const cardCount = (await cards(b.threadId)).filter(row => row.card?.outboundRequest).length;
  expect((await relay(token, "SLACK_SEND_MESSAGE", { channel: "fixture", text: "Sent without asking" })).body.result.isError).not.toBe(true);
  expect((await relay(token, "GMAIL_SEND_EMAIL", { to: "second@fixture.test" })).body.result.isError).not.toBe(true);
  expect((await cards(b.threadId)).filter(row => row.card?.outboundRequest)).toHaveLength(cardCount);
  // A code run goes out without a card too, as it does at Full access with no rule.
  expect((await relay(token, "COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "print(1)" })).body.result.isError).not.toBe(true);
  expect((await cards(b.threadId)).filter(row => row.card?.outboundRequest)).toHaveLength(cardCount);
  expect(relayed).toHaveLength(before + 4);
  await api("PATCH", `/api/bots/${b.id}`, { connectorScopes: { apps: { gmail: "read" } } });
  expect((await relay(token, "GMAIL_SEND_EMAIL")).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before + 4);
});

it("honors Ask every time at Full access before the first send for any prompt language", async () => {
  const b = outboundPolicyBot;
  expect((await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === b.id).outbound).toEqual({ policy: "ask" });
  expect((await api("PATCH", `/api/bots/${b.id}`, { outbound: { policy: "invalid" } })).status).toBe(400);
  expect((await api("PATCH", `/api/bots/${b.id}`, { outbound: { policy: "allow" } }, member)).status).toBe(403);
  const before = relayed.length;
  for (const text of ["Responde a Sam, no lo envíes", "Sam को जवाब लिखो, भेजना मत", "Réponds à Sam sans envoyer", "Samに返信を書いて、送信しないで", "Send the email now"]) {
    expect((await api("POST", `/api/bots/${b.id}/messages`, { text, threadId: b.threadId })).status).toBe(202);
    await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === b.id).busy, { timeout: 10_000 }).toBe(false);
    const token = await mint(b.id, b.threadId);
    const send = relay(token, "GMAIL_REPLY_TO_THREAD", { thread_id: "ask-policy", body: "Never sent without consent" });
    const card = await pending(b.threadId);
    expect(relayed).toHaveLength(before);
    await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
    expect((await send).body.result.isError).toBe(true);
  }
  const token = await mint(b.id, b.threadId);
  for (const name of ["GMAIL_SEND_EMAIL", "GMAIL_SEND_DRAFT", "GMAIL_FORWARD_MESSAGE", "SLACK_SEND_MESSAGE", "COMPOSIO_REMOTE_WORKBENCH"]) {
    const send = relay(token, name);
    const card = await pending(b.threadId);
    expect(relayed).toHaveLength(before);
    await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
    expect((await send).body.result.isError).toBe(true);
  }
  const allowed = relay(token, "GMAIL_SEND_EMAIL", { to: "sam@example.test" });
  const card = await pending(b.threadId);
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" });
  expect((await allowed).body.result.isError).not.toBe(true);
  expect(relayed).toHaveLength(before + 1);
  const repeated = relay(token, "GMAIL_SEND_EMAIL", { to: "sam@example.test" });
  const repeatedCard = await pending(b.threadId);
  expect(relayed).toHaveLength(before + 1);
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: repeatedCard.card.requestId, behavior: "deny" });
  expect((await repeated).body.result.isError).toBe(true);
});

it("honors Send without asking for explicit draft-and-send requests without classifying their wording", async () => {
  const b = outboundPolicyBot;
  expect((await api("PATCH", `/api/bots/${b.id}`, { outbound: { policy: "allow" } })).status).toBe(200);
  const before = relayed.length;
  const cardCount = (await cards(b.threadId)).filter(row => row.card?.outboundRequest).length;
  for (const text of ["Draft a reply to Sam and send it", "Edit the draft to fix the typo and send it", "Write a draft and then send it to the team"]) {
    expect((await api("POST", `/api/bots/${b.id}/messages`, { text, threadId: b.threadId })).status).toBe(202);
    await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === b.id).busy, { timeout: 10_000 }).toBe(false);
    const token = await mint(b.id, b.threadId);
    expect((await relay(token, "GMAIL_SEND_DRAFT", { draft_id: "fixture-draft" })).body.result.isError).not.toBe(true);
  }
  expect(relayed).toHaveLength(before + 3);
  expect((await cards(b.threadId)).filter(row => row.card?.outboundRequest)).toHaveLength(cardCount);
  expect((await api("PATCH", `/api/bots/${b.id}`, { outbound: { policy: "ask" } })).status).toBe(200);
});

it("holds sends under Ask every time at Full access and revises the same Gmail draft without another creation", async () => {
  const b = draftBot;
  const begin = async (text: string) => {
    const previous = (await cards(b.threadId)).filter(row => row.role === "bot" && row.kind === "text").length;
    expect((await api("POST", `/api/bots/${b.id}/messages`, { text, threadId: b.threadId })).status).toBe(202);
    await expect.poll(async () => (await cards(b.threadId)).filter(row => row.role === "bot" && row.kind === "text").length, { timeout: 10_000 }).toBeGreaterThan(previous);
    await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.find((row: any) => row.id === b.id).busy, { timeout: 10_000 }).toBe(false);
    return mint(b.id, b.threadId);
  };
  const token = await begin("Create exactly one reply draft for MEGA. If a draft already exists, update it instead of creating another. Do not send it.");
  const before = relayed.length;
  const deny = async (request: Promise<any>) => {
    const card = await pending(b.threadId);
    expect(relayed).toHaveLength(before);
    await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
    expect((await request).body.result.isError).toBe(true);
  };
  for (const name of ["GMAIL_SEND_EMAIL", "GMAIL_SEND_DRAFT", "GMAIL_REPLY_TO_THREAD", "GMAIL_FORWARD_MESSAGE", "COMPOSIO_REMOTE_WORKBENCH"]) {
    await deny(relay(token, name));
  }
  const draft = { thread_id: "mega-thread", recipient_email: "support@example.test", subject: "Re: MEGA", body: "Original reply" };
  const batch = (tools: any[]) => relay(token, "COMPOSIO_MULTI_EXECUTE_TOOL", { tools });
  await deny(batch([{ tool_slug: "GMAIL_CREATE_EMAIL_DRAFT", arguments: draft }, { tool_slug: "GMAIL_SEND_EMAIL", arguments: draft }]));
  expect(relayed).toHaveLength(before);
  expect((await relay(token, "GMAIL_CREATE_EMAIL_DRAFT", draft)).body.result.isError).not.toBe(true);
  expect((await relay(token, "GMAIL_CREATE_EMAIL_DRAFT", draft)).body.result.isError).toBe(true);
  expect(gmailDrafts.size).toBe(1);
  const draftId = [...gmailDrafts.keys()][0];
  const revision = await begin("Update the existing MEGA reply draft. Do not create another. Do not send it.");
  expect((await relay(revision, "GMAIL_UPDATE_DRAFT", { ...draft, draft_id: draftId, body: "Revised reply" })).body.result.isError).not.toBe(true);
  expect(gmailDrafts.size).toBe(1);
  expect(gmailDrafts.get(draftId)).toMatchObject({ body: "Revised reply", thread_id: "mega-thread" });
  const reached = relayed.slice(before).flatMap((frame: any) => frame.params?.arguments?.tools ?? [{ tool_slug: frame.params?.name }]);
  expect(reached.map((tool: any) => tool.tool_slug)).toEqual(["GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_UPDATE_DRAFT"]);
  await api("PATCH", `/api/bots/${b.id}`, { outbound: { policy: "allow" } });
  const cardCount = (await cards(b.threadId)).filter(row => row.card?.outboundRequest).length;
  expect((await relay(revision, "GMAIL_SEND_DRAFT", { draft_id: draftId })).body.result.isError).not.toBe(true);
  expect(relayed).toHaveLength(before + 3);
  expect((await cards(b.threadId)).filter(row => row.card?.outboundRequest)).toHaveLength(cardCount);
});

it("retains Gmail draft limits through delegated work and the requester's resumed turn", async () => {
  const b = draftBot;
  const helper = draftHelper;
  for (const bot of [b, helper]) {
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "gmailFixture", model: "claude-sonnet-5" }, threadId: bot.threadId, outbound: { policy: "ask" } })).status).toBe(200);
  }
  const draft = { thread_id: "continued-thread", recipient_email: "sam@example.test", subject: "Re: Continuation", body: "Draft response" };
  const write = { server: "composio", tool: "GMAIL_CREATE_EMAIL_DRAFT", arguments: draft };
  const send = { server: "composio", tool: "GMAIL_REPLY_TO_THREAD", arguments: { thread_id: draft.thread_id }, expectError: true };
  writeFileSync(join(fixture.info.dataDir, "gmail-plan.json"), JSON.stringify({
    [b.id]: {
      timeoutMs: 60_000,
      steps: [write, { arguments: { bot_ids: [helper.id], message: "Check the proposed response", thread: "new" } }],
      reply: "Waiting for a check", resumeSteps: [{ ...write, expectError: true }, send], resumeReply: "Draft remains unsent",
    },
    [helper.id]: { timeoutMs: 60_000, steps: [send], reply: "Checked the response" },
  }));
  const before = relayed.length;
  expect((await api("POST", `/api/bots/${b.id}/messages`, { text: "Draft a reply. Do not send it. Ask your teammate to check it.", threadId: b.threadId })).status).toBe(202);
  let delegatedThread = "";
  await expect.poll(async () => {
    const fresh = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === helper.id);
    delegatedThread = fresh.tasks.find((task: any) => task.busy)?.threadId ?? "";
    return Boolean(delegatedThread);
  }, { timeout: 15_000 }).toBe(true);
  for (const threadId of [delegatedThread, b.threadId]) {
    const card = await pending(threadId);
    const tools = relayed.slice(before).filter((frame: any) => frame.method === "tools/call")
      .flatMap((frame: any) => frame.params?.arguments?.tools ?? [{ tool_slug: frame.params?.name }]);
    expect(tools.map((tool: any) => tool.tool_slug)).toEqual(["GMAIL_CREATE_EMAIL_DRAFT"]);
    await api("POST", `/api/threads/${threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  }
  await expect.poll(async () => (await cards(b.threadId)).some(row => row.text === "Draft remains unsent"), { timeout: 15_000 }).toBe(true);
  const planEvidence = readFileSync(join(fixture.info.dataDir, "gmail-plan.json.evidence.jsonl"), "utf8");
  evidence.push({ gmailContinuation: planEvidence });
  expect(planEvidence).toContain("already attempted");
  expect(gmailDrafts.size).toBe(2);
}, 90_000);

it("honors Ask every time on Full-access delegated and resumed turns without relying on wording or a draft write", async () => {
  const b = outboundPolicyBot;
  const helper = draftHelper;
  for (const bot of [b, helper]) {
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "gmailFixture", model: "claude-sonnet-5" }, threadId: bot.threadId, outbound: { policy: "ask" } })).status).toBe(200);
  }
  const send = { server: "composio", tool: "GMAIL_REPLY_TO_THREAD", arguments: { thread_id: "ask-delegation" }, expectError: true };
  writeFileSync(join(fixture.info.dataDir, "gmail-plan.json"), JSON.stringify({
    [b.id]: { timeoutMs: 60_000, steps: [{ arguments: { bot_ids: [helper.id], message: "Check the response", thread: "new" } }],
      reply: "Waiting for review", resumeSteps: [send], resumeReply: "Outbound policy retained" },
    [helper.id]: { timeoutMs: 60_000, steps: [send], reply: "Reviewed" },
  }));
  const before = relayed.length;
  expect((await api("POST", `/api/bots/${b.id}/messages`, { text: "Responde a Sam, no lo envíes", threadId: b.threadId })).status).toBe(202);
  let delegatedThread = "";
  await expect.poll(async () => {
    const fresh = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === helper.id);
    delegatedThread = fresh.tasks.find((task: any) => task.busy)?.threadId ?? "";
    return Boolean(delegatedThread);
  }, { timeout: 15_000 }).toBe(true);
  for (const threadId of [delegatedThread, b.threadId]) {
    const card = await pending(threadId);
    expect(relayed.slice(before).filter((frame: any) => frame.method === "tools/call")).toEqual([]);
    await api("POST", `/api/threads/${threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  }
  await expect.poll(async () => (await cards(b.threadId)).some(row => row.text === "Outbound policy retained"), { timeout: 15_000 }).toBe(true);
  evidence.push({ outboundPolicyDelegation: readFileSync(join(fixture.info.dataDir, "gmail-plan.json.evidence.jsonl"), "utf8") });
}, 90_000);

it("sends 35 in a day at Full access with no sending rule, with no refusal and no card, and a routine sends too", async () => {
  const b = noRuleBot;
  const email = (to: string) => ({ recipient_email: to, subject: "Reminder", body: "See you at nine." });
  const token = await mint(b.id, b.threadId);
  const before = relayed.length;
  const sent = () => relayed.slice(before).filter((frame: any) => frame.method === "tools/call").length;
  for (let count = 0; count < 35; count++) expect((await relay(token, "GMAIL_SEND_EMAIL", email(`person${count}@example.test`))).body.result.isError).not.toBe(true);
  expect(sent()).toBe(35);

  expect((await api("PATCH", `/api/bots/${b.id}`, { modelSelection: { instanceId: "gmailFixture", model: "claude-sonnet-5" }, threadId: b.threadId })).status).toBe(200);
  writeFileSync(join(fixture.info.dataDir, "gmail-plan.json"), JSON.stringify({ [b.id]: { timeoutMs: 60_000,
    steps: [{ server: "composio", tool: "GMAIL_SEND_EMAIL", arguments: email("team@example.test") }],
    reply: "Report: the reminder was sent." } }));
  const created = await api("POST", "/api/routines", { name: "Morning reminder", prompt: "Send the morning reminder email to the team.", botId: b.id, schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const { run } = (await api("POST", `/api/routines/${created.body.routine.id}/run`)).body;
  let finished: any;
  await expect.poll(async () => (finished = (await api("GET", "/api/routines")).body.runs.find((item: any) => item.id === run.id))?.status, { timeout: 45_000 }).toBe("completed");
  expect(finished.output).toContain("Report: the reminder was sent.");
  expect(sent()).toBe(36);
  const threads = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === b.id).tasks.map((task: any) => task.threadId);
  for (const thread of threads) expect((await cards(thread)).filter((row: any) => row.card?.outboundRequest), "no card waits on anyone").toEqual([]);
}, 90_000);

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

it("does not consume a Gmail draft reservation when the fresh scope check refuses dispatch", async () => {
  const b = await bot("Draft scope race");
  const token = await mint(b.id, b.threadId);
  const before = relayed.length;
  sessionEntered = false;
  blockSession = () => {};
  const args = { thread_id: "scope-race", body: "Only a draft" };
  const held = relay(token, "GMAIL_CREATE_EMAIL_DRAFT", args);
  try {
    await expect.poll(() => sessionEntered, { timeout: 5_000 }).toBe(true);
    await api("PATCH", `/api/bots/${b.id}`, { connectorScopes: { apps: { gmail: "read" } } });
  } finally {
    blockSession?.();
    blockSession = undefined;
  }
  expect((await held).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
  await api("PATCH", `/api/bots/${b.id}`, { connectorScopes: { apps: { gmail: "write" } } });
  expect((await relay(token, "GMAIL_CREATE_EMAIL_DRAFT", args)).body.result.isError).not.toBe(true);
  expect(relayed).toHaveLength(before + 1);
});

it("honors Ask every time enabled while a Full-access send is waiting for dispatch", async () => {
  const b = fullBot;
  await api("PATCH", `/api/bots/${b.id}`, { outbound: { policy: "allow" }, connectorScopes: { apps: { gmail: "write" } } });
  const token = await mint(b.id, b.threadId);
  const before = relayed.length;
  sessionEntered = false;
  blockSession = () => {};
  const send = relay(token, "GMAIL_SEND_EMAIL", { to: "sam@example.test" });
  try {
    await expect.poll(() => sessionEntered, { timeout: 5_000 }).toBe(true);
    expect((await api("PATCH", `/api/bots/${b.id}`, { outbound: { policy: "ask" } })).status).toBe(200);
    await expect.poll(() => JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8"))
      .find((bot: any) => bot.id === b.id).outbound?.policy).toBe("ask");
  } finally {
    blockSession?.();
    blockSession = undefined;
  }
  expect((await send).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
  const nextSend = relay(token, "GMAIL_SEND_EMAIL", { to: "sam@example.test" });
  const card = await pending(b.threadId);
  expect(relayed).toHaveLength(before);
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  expect((await nextSend).body.result.isError).toBe(true);
  expect((await api("PATCH", `/api/bots/${b.id}`, { outbound: { policy: "allow" } })).status).toBe(200);
  expect((await relay(token, "GMAIL_SEND_EMAIL", { to: "sam@example.test" })).body.result.isError).not.toBe(true);
  expect(relayed).toHaveLength(before + 1);
});

it("sends nothing when a duplicate draft refuses a mixed batch", async () => {
  const b = fullBot;
  const token = await mint(b.id, b.threadId);
  const draft = { thread_id: "duplicate-in-batch", body: "Review this" };
  const before = relayed.length;
  expect((await relay(token, "GMAIL_CREATE_EMAIL_DRAFT", draft)).body.result.isError).not.toBe(true);
  const duplicate = await relay(token, "COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [
    { tool_slug: "GMAIL_CREATE_EMAIL_DRAFT", arguments: draft },
    { tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "sam@example.test" } },
  ] });
  expect(duplicate.body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before + 1);
});

it("still asks before arbitrary workbench code under Send without asking", async () => {
  const b = await bot("Opaque code");
  await api("PATCH", `/api/bots/${b.id}`, { outbound: { policy: "allow" } });
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

it("runs sandbox code for a bot with app grants only after its sandbox switch is on, never inside a batch, and still asks", async () => {
  const b = await bot("Sandbox switch");
  expect((await api("PATCH", `/api/bots/${b.id}`, { connectorTools: { gmail: { tools: "*" } } })).status).toBe(200);
  const token = await mint(b.id, b.threadId);
  const before = relayed.length;
  const code = { code_to_execute: "print(1)" };
  const wrapped = () => relay(token, "COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "COMPOSIO_REMOTE_WORKBENCH", arguments: code }] });
  const off = await relay(token, "COMPOSIO_REMOTE_WORKBENCH", code);
  expect(off.body.result.isError).toBe(true);
  expect(JSON.stringify(off.body.result)).toContain("Run code in the apps' sandbox");
  expect((await wrapped()).body.result.isError).toBe(true);
  expect((await api("PATCH", `/api/bots/${b.id}`, { appSandbox: "yes" })).status).toBe(400);
  expect((await api("PATCH", `/api/bots/${b.id}`, { appSandbox: true }, member)).status).toBe(403);
  expect((await api("PATCH", `/api/bots/${b.id}`, { appSandbox: true })).status).toBe(200);
  const held = relay(token, "COMPOSIO_REMOTE_WORKBENCH", code);
  const card = await pending(b.threadId);
  expect(relayed).toHaveLength(before);
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" });
  expect((await held).body.result.isError).not.toBe(true);
  expect(relayed).toHaveLength(before + 1);
  expect((await wrapped()).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before + 1);
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

it("keeps two backups on one account with different models, and drops an exact repeat", async () => {
  const b = await bot("Same-account backups");
  const sonnet = { instanceId: "claude", model: "claude-sonnet-5" }, opus = { instanceId: "claude", model: "claude-opus-5" };
  const saved = await api("PATCH", `/api/bots/${b.id}`, { fallback: [sonnet, opus, { ...sonnet, model: " claude-sonnet-5 " }] });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const fleet = await api("GET", "/api/bots");
  expect(fleet.body.bots.find((row: any) => row.id === b.id).fallback).toEqual([sonnet, opus]);
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
