// The draft card's Save in an isolated server (docs/verification/README.md): a disposable data folder, the fake engine, and
// a loopback stand-in for Composio that holds Gmail's drafts. Nothing reaches a real Gmail or the person's own app.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import type { EmailDraftEdit } from "../shared/email-draft.ts";
import { SessionRegistry } from "./sessions.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { readRegistry, writeRegistry } from "./testing/registry.ts";

const key = "isolated-email-draft-capability";
type Draft = EmailDraftEdit;
let fixture: VerificationServer;
let child: ChildProcess;
let broker: Server;
let brokerOrigin = "";
let admin = "";
let botId = "";
let threadId = "";
/** Gmail's drafts, as the stand-in holds them. */
const gmail = new Map<string, Draft>();
/** Every Gmail tool call that reached the stand-in, in order. */
const reached: string[] = [];
const evidence: unknown[] = [];
let holdSession: Promise<void> | undefined;
let sessionEntered: (() => void) | undefined;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  });
  const result = { status: response.status, body: await response.json() as any };
  evidence.push({ method, path, body, result });
  return result;
};
const mint = async () => {
  const response = await fetch(fixture.info.url + "/api/testing/internal-capability", {
    method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": key },
    body: JSON.stringify({ botId, threadId, kind: "connectors" }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as any).token as string;
};
/** The bot's own Gmail call, through the server's connector relay. */
const botCall = async (slug: string, args: Record<string, unknown>) => {
  const response = await fetch(fixture.info.url + "/api/internal/connectors/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await mint()}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: slug, arguments: args }] } } }),
  });
  const body = await response.json() as any;
  evidence.push({ botCall: slug, args, status: response.status, isError: body.result?.isError === true });
  expect(response.status).toBe(200);
  expect(body.result?.isError).not.toBe(true);
};
const draftCard = async () => {
  const rows = (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
  return rows.findLast((row) => row.emailDraft);
};
const fieldsOf = (card: any): Draft => ({ to: card.emailDraft.to, cc: card.emailDraft.cc, bcc: card.emailDraft.bcc, subject: card.emailDraft.subject, body: card.emailDraft.body });
const save = (card: any, base: Draft, draft: Draft) => api("POST", "/api/email-draft", { threadId, messageId: card.id, action: "save", base, draft });

beforeAll(async () => {
  broker = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/connectors/connected") return res.end(JSON.stringify({ services: { gmail: { connected: true } } }));
    if (req.url === "/api/tool_router/session/fixture-session") {
      if (holdSession) { sessionEntered?.(); await holdSession; }
      return res.end(JSON.stringify({ session_id: "fixture-session", mcp: { type: "http", url: brokerOrigin + "/mcp" },
        config: { user_id: "fixture-user", multi_account: { enable: true, max_accounts_per_toolkit: 10, require_explicit_selection: true } } }));
    }
    if (req.url === "/mcp") {
      const tools = body.params?.arguments?.tools;
      if (!Array.isArray(tools)) return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "relay-ok" }] } }));
      const results = tools.map((tool: any) => {
        reached.push(tool.tool_slug);
        const args = tool.arguments ?? {};
        const respond = (response: unknown) => ({ tool_slug: tool.tool_slug, response });
        if (tool.tool_slug === "GMAIL_CREATE_EMAIL_DRAFT" || tool.tool_slug === "GMAIL_UPDATE_DRAFT") {
          const id = tool.tool_slug === "GMAIL_CREATE_EMAIL_DRAFT" ? `draft-${gmail.size + 1}` : args.draft_id;
          const was = gmail.get(id);
          if (tool.tool_slug === "GMAIL_UPDATE_DRAFT" && !was) return respond({ successful: false, error: "Draft not found" });
          // An update leaves in Gmail what it omits.
          const kept = (name: string, value: () => unknown, before: unknown) => (args[name] === undefined ? before : value());
          const to = [...kept("recipient_email", () => [args.recipient_email].filter(Boolean), was?.to.slice(0, 1) ?? []) as string[],
            ...kept("extra_recipients", () => args.extra_recipients, was?.to.slice(1) ?? []) as string[]];
          gmail.set(id, { to, cc: kept("cc", () => args.cc, was?.cc ?? []) as string[], bcc: kept("bcc", () => args.bcc, was?.bcc ?? []) as string[],
            subject: kept("subject", () => args.subject, was?.subject ?? "") as string, body: kept("body", () => args.body, was?.body ?? "") as string });
          return respond({ successful: true, data: { id, message: { id: `msg-${id}`, threadId: args.thread_id ?? "gmail-thread" } } });
        }
        if (tool.tool_slug === "GMAIL_GET_DRAFT") {
          const draft = gmail.get(args.draft_id);
          if (!draft) return respond({ successful: false, error: "Draft not found" });
          const headers = [["To", draft.to], ["Cc", draft.cc], ["Bcc", draft.bcc], ["Subject", [draft.subject]]]
            .filter(([, values]) => (values as string[]).some(Boolean)).map(([name, values]) => ({ name, value: (values as string[]).join(", ") }));
          return respond({ successful: true, data: { id: args.draft_id, message: { to: draft.to.join(", "), subject: draft.subject, messageText: draft.body, payload: { headers } } } });
        }
        return respond({ successful: false, error: "not in this fixture" });
      });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results } }) }] } }));
    }
    return res.end(JSON.stringify({ items: [{ slug: "gmail", connected_account: { id: "fixture-account", status: "ACTIVE" } }] }));
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  brokerOrigin = `http://127.0.0.1:${(broker.address() as { port: number }).port}`;
  fixture = await launchVerificationServer();
  const created = await fetch(fixture.info.url + "/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Draft card fixture" }) });
  expect(created.status).toBe(201);
  ({ id: botId, threadId } = (await created.json() as any).bot);
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const bots = readRegistry(fixture.info.dataDir).bots;
  const saved = bots.find((row: any) => row.id === botId);
  saved.approvalMode = "full";
  for (const task of saved.tasks) task.approvalMode = "full";
  writeRegistry(fixture.info.dataDir, { bots });
  const configFile = join(fixture.info.dataDir, "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.signIn = { admins: ["admin@fixture.test"] };
  config.composio = { apiKey: "ak_isolated_fixture", userId: "fixture-user", sessionId: "fixture-session" };
  writeFileSync(configFile, JSON.stringify(config));
  const sessions = new SessionRegistry({ file: join(fixture.info.dataDir, "sessions.json"), emailScopes: () => ["admin", "client"] });
  admin = sessions.issue({ label: "isolated admin", email: "admin@fixture.test", scopes: ["admin", "client"] }).token;
  sessions.close();
  const log = openSync(fixture.info.logPath, "a", 0o600);
  const env = { ...verificationServerEnvironment({}, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
    OMB_TEST_INTERNAL_CAPABILITY_KEY: key, OMB_COMPOSIO_API: brokerOrigin + "/api", OMB_COMPOSIO_TOOLKITS_API: brokerOrigin + "/api" };
  child = spawn(process.execPath, verificationServerArgs(env), {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(fixture.info.url + "/api/health")).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("isolated email draft server did not start");
}, 40_000);

afterAll(async () => {
  const evidencePath = fixture.info.logPath + ".email-draft-card.json";
  writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence, reached, gmail: Object.fromEntries(gmail) }, null, 2));
  await waitForExit(child, { signal: "SIGTERM" });
  await fixture.close();
  await new Promise<void>((resolve) => broker.close(() => resolve()));
  console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath, fixtureRemoved: !existsSync(fixture.info.dataDir) }));
});

const first: Draft = { to: ["ana@example.test", "ben@example.test"], cc: ["cy@example.test"], bcc: [], subject: "Launch", body: "Hi both,\nready." };

it("shows the bot's draft as a card, and Save writes the edit to the same Gmail draft", async () => {
  await botCall("GMAIL_CREATE_EMAIL_DRAFT", { user_id: "me", recipient_email: "ana@example.test", extra_recipients: ["ben@example.test"], cc: ["cy@example.test"], subject: "Launch", body: "Hi both,\nready." });
  const card = await draftCard();
  expect(fieldsOf(card)).toEqual(first);
  const before = reached.length;
  const edit = { ...first, subject: "Launch (final)" };
  expect((await save(card, first, edit)).status).toBe(200);
  expect(reached.slice(before)).toEqual(["GMAIL_GET_DRAFT", "GMAIL_UPDATE_DRAFT"]);
  expect(gmail.get(card.emailDraft.draftId)).toEqual(edit);
  expect(fieldsOf(await draftCard())).toEqual(edit);
});

it("saves nothing over a bot's partial update made after the edit started, and the card shows Gmail's version", async () => {
  const card = await draftCard();
  const base = fieldsOf(card);
  // The person opens Edit; the bot then changes only the recipients.
  await botCall("GMAIL_UPDATE_DRAFT", { user_id: "me", draft_id: card.emailDraft.draftId, recipient_email: "ana@example.test", extra_recipients: ["dan@example.test"] });
  const before = reached.length;
  const refused = await save(card, base, { ...base, subject: "Launch (typo fixed)" });
  expect(refused.status).toBe(409);
  expect(refused.body.errorKey).toBe("serverError.emailDraft.changed");
  expect(reached.slice(before)).toEqual(["GMAIL_GET_DRAFT"]);
  expect(gmail.get(card.emailDraft.draftId)).toMatchObject({ to: ["ana@example.test", "dan@example.test"], subject: "Launch (final)" });
  expect(fieldsOf(await draftCard())).toEqual(gmail.get(card.emailDraft.draftId));
});

it("saves nothing over a change made in Gmail itself, and the card shows it", async () => {
  const card = await draftCard();
  const base = fieldsOf(card);
  gmail.set(card.emailDraft.draftId, { ...base, body: "Edited in Gmail." });
  const before = reached.length;
  const refused = await save(card, base, { ...base, subject: "Mine" });
  expect(refused.status).toBe(409);
  expect(reached.slice(before)).toEqual(["GMAIL_GET_DRAFT"]);
  expect(gmail.get(card.emailDraft.draftId)!.subject).toBe("Launch (final)");
  expect((await draftCard()).emailDraft.body).toBe("Edited in Gmail.");
  // Edit again from what the card now shows: it saves.
  const fresh = fieldsOf(await draftCard());
  expect((await save(await draftCard(), fresh, { ...fresh, subject: "Mine" })).status).toBe(200);
  expect(gmail.get(card.emailDraft.draftId)).toEqual({ ...fresh, subject: "Mine" });
});

it("has no Send: a press to send is refused and nothing reaches Gmail", async () => {
  const card = await draftCard();
  const before = reached.length;
  const refused = await api("POST", "/api/email-draft", { threadId, messageId: card.id, action: "send", draft: fieldsOf(card) });
  expect(refused.status).toBe(400);
  expect(reached.slice(before)).toEqual([]);
});

it("saves nothing when the bot loses Gmail write access while the call is being set up", async () => {
  const card = await draftCard();
  const base = fieldsOf(card);
  const was = gmail.get(card.emailDraft.draftId);
  let release!: () => void;
  holdSession = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { sessionEntered = resolve; });
  const before = reached.length;
  const pressing = save(card, base, { ...base, subject: "Not allowed" });
  await entered;
  // Permissions change after the press was checked, while the relay waits for its session.
  expect((await api("PATCH", `/api/bots/${botId}`, { connectorScopes: { apps: { gmail: "read" } } })).status).toBe(200);
  holdSession = undefined;
  release();
  const refused = await pressing;
  expect(refused.status).toBe(403);
  expect(reached.slice(before)).toEqual([]);
  expect(gmail.get(card.emailDraft.draftId)).toEqual(was);
  expect(fieldsOf(await draftCard())).toEqual(base);
  expect((await api("PATCH", `/api/bots/${botId}`, { connectorScopes: null })).status).toBe(200);
});
