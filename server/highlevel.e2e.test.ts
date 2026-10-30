// A real server with a fake relay and a fake HighLevel: the owner connects from the card, a bot gets exactly the tools
// its scope allows, a write lands in the activity, an expired token refreshes through the relay, a revoked one signs
// out with the plain note, and Disconnect removes the tokens.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { HIGHLEVEL_TOOL_NAMES } from "../shared/highlevel.ts";
import { HIGHLEVEL_NOT_CONNECTED_TEXT, HIGHLEVEL_SIGNED_OUT_TEXT } from "./highlevel/instructions.ts";
import { isHighLevelWrite } from "./highlevel/tools.ts";
import { SessionRegistry } from "./sessions.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { FAKE_LOCATION_ID, startFakeHighLevel, startFakeRelay, type FakeHighLevel, type FakeRelay } from "./testing/fake-highlevel.ts";

const key = "isolated-highlevel-capability";
let fixture: VerificationServer;
let child: ChildProcess;
let hl: FakeHighLevel;
let relay: FakeRelay;
let admin: string;
let member: string;

const api = async (method: string, path: string, body?: unknown, token = admin) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: await response.json() as any };
};
const mint = async (botId: string, threadId: string, kind = "highlevel") => {
  const response = await fetch(fixture.info.url + "/api/testing/internal-capability", {
    method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": key },
    body: JSON.stringify({ botId, threadId, kind }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as any).token as string;
};
const rpc = (token: string, method: string, params: unknown = {}) => api("POST", "/api/internal/highlevel/mcp", { method, params }, token);
const call = (token: string, name: string, args: unknown = {}) => rpc(token, "tools/call", { name, arguments: args });

beforeAll(async () => {
  hl = await startFakeHighLevel();
  relay = await startFakeRelay({ onAccessToken: (token) => hl.tokens.add(token) });
  fixture = await launchVerificationServer();
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const configFile = join(fixture.info.dataDir, "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.signIn = { admins: ["admin@fixture.test"], members: ["member@fixture.test"] };
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
      OMB_TEST_INTERNAL_CAPABILITY_KEY: key, OMB_HIGHLEVEL_RELAY_URL: relay.url, OMB_HIGHLEVEL_API_URL: hl.url },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(fixture.info.url + "/api/health")).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("isolated HighLevel server did not start");
}, 40_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await fixture.close();
  await hl.close();
  await relay.close();
});

it("connects from the card through the relay, keeps the tokens out of every answer, and lists the tools for grants", async () => {
  expect(await api("GET", "/api/highlevel")).toEqual({ status: 200, body: { state: "signed-out" } });
  expect((await api("GET", "/api/highlevel", undefined, member)).status).toBe(403);
  expect((await api("POST", "/api/highlevel/sign-in", undefined, member)).status).toBe(403);
  const started = await api("POST", "/api/highlevel/sign-in");
  expect(started.status).toBe(200);
  expect(started.body).toEqual({ flowId: expect.stringMatching(/^[0-9a-f-]{36}$/u), authorizationUrl: expect.stringMatching(/^https:\/\/marketplace\.leadconnectorhq\.com\//u), expiresAt: expect.any(Number) });
  expect(await api("GET", "/api/highlevel")).toMatchObject({ status: 200, body: { state: "connecting", flow: started.body } });
  expect(await api("GET", `/api/highlevel/sign-in/${started.body.flowId}`)).toEqual({ status: 200, body: { phase: "waiting" } });
  relay.complete([...relay.states.keys()].at(-1)!);
  await expect.poll(async () => (await api("GET", `/api/highlevel/sign-in/${started.body.flowId}`)).body.phase, { timeout: 8_000, interval: 200 }).toBe("connected");
  const status = await api("GET", "/api/highlevel");
  expect(status.body).toMatchObject({ state: "connected", kind: "oauth", location: { id: FAKE_LOCATION_ID, name: "Example Profiles" }, connectedAt: expect.any(Number) });
  expect(JSON.stringify(status.body)).not.toMatch(/hl_access|hl_refresh/u);
  const tools = await api("GET", "/api/connectors/tools");
  expect(tools.status).toBe(200);
  expect(tools.body.services.highlevel.map((tool: { name: string }) => tool.name)).toEqual([...HIGHLEVEL_TOOL_NAMES]);
}, 30_000);

it("gives a bot its scoped tools, records writes without contact data, refreshes once, signs out on revocation and disconnects", async () => {
  const created = await api("POST", "/api/bots", { name: "CRM scout" });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { connectorScopes: { apps: { highlevel: "read" } } })).status).toBe(200);
  // Another kind's capability never reaches the CRM route. (A later mint on the same thread replaces this turn.)
  expect((await rpc(await mint(bot.id, bot.threadId, "connectors"), "tools/list")).status).toBe(403);
  const token = await mint(bot.id, bot.threadId);

  const listed = await rpc(token, "tools/list");
  expect(listed.status).toBe(200);
  expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(HIGHLEVEL_TOOL_NAMES.filter((name) => !isHighLevelWrite(name)));
  expect(listed.body.result.instructions).toContain("never send SMS");

  hl.calls.length = 0;
  const read = await call(token, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" });
  expect(read.body.result.isError).toBeUndefined();
  expect(read.body.result.structuredContent).toMatchObject({ id: "contact_1", email: "ada@fixture.test", customFields: { "Lead Source": "Referral" } });
  const contactCall = hl.calls.find((row) => row.path === "/contacts/contact_1")!;
  expect(contactCall.headers.version).toBe("2021-07-28");
  expect(contactCall.headers.authorization).toBe(`Bearer ${relay.issued[0]}`);

  const refused = await call(token, "HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "Called back" });
  expect(refused.body.result.isError).toBe(true);
  expect(refused.body.result.content[0].text).toBe("OpenMausBot did not run this: HighLevel is read-only for CRM scout, and Add note would write to it. Ask the user before trying again.");
  expect(hl.calls.some((row) => row.path.endsWith("/notes"))).toBe(false);

  expect((await api("PATCH", `/api/bots/${bot.id}`, { connectorScopes: { apps: { highlevel: "write" } } })).status).toBe(200);
  const written = await call(token, "HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "Called back, wants the quote by Friday" });
  expect(written.body.result.isError).toBeUndefined();
  expect(written.body.result.structuredContent).toMatchObject({ contactId: "contact_1", note: { id: "note_new" } });
  const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  const row = messages.find((message) => message.kind === "activity" && message.tool?.name === "mcp__highlevel__HIGHLEVEL_ADD_NOTE");
  expect(row).toMatchObject({ role: "bot", tool: { name: "mcp__highlevel__HIGHLEVEL_ADD_NOTE", ok: true, summary: "note note_new: body" } });
  expect(JSON.stringify(row)).not.toContain("wants the quote");

  // The access token expires: one refresh through the relay, the call retried with the new token, the pair rotated.
  hl.tokens.delete(relay.issued[0]!);
  expect(relay.refreshes).toBe(0);
  const afterExpiry = await call(token, "HIGHLEVEL_LIST_PIPELINES");
  expect(afterExpiry.body.result.isError).toBeUndefined();
  expect(relay.refreshes).toBe(1);
  expect(hl.calls.filter((row) => row.path === "/opportunities/pipelines").map((row) => row.headers.authorization)).toEqual([`Bearer ${relay.issued[0]}`, `Bearer ${relay.issued[1]}`]);
  expect(await api("GET", "/api/highlevel")).toMatchObject({ body: { state: "connected" } });

  // Revoked: the relay rejects the refresh, the bot gets the plain note, the card says reconnect.
  hl.tokens.clear();
  relay.refreshTokens.clear();
  const revoked = await call(token, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" });
  expect(revoked.body.result.isError).toBe(true);
  expect(revoked.body.result.content[0].text).toBe(HIGHLEVEL_SIGNED_OUT_TEXT);
  expect(relay.refreshes).toBe(2);
  expect(await api("GET", "/api/highlevel")).toMatchObject({ body: { state: "needs-sign-in", kind: "oauth", location: { name: "Example Profiles" }, problem: expect.stringMatching(/rejected the saved sign-in/u) } });
  const again = await call(token, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" });
  expect(again.body.result.content[0].text).toBe(HIGHLEVEL_SIGNED_OUT_TEXT);
  expect(relay.refreshes).toBe(2);

  // Disconnect removes the tokens; a Private Integration token connects without the relay.
  expect(await api("DELETE", "/api/highlevel")).toEqual({ status: 200, body: { state: "signed-out" } });
  expect((await call(token, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" })).body.result.content[0].text).toBe(HIGHLEVEL_NOT_CONNECTED_TEXT);
  expect(await api("POST", "/api/highlevel/token", { token: "pit-e2e-rejected-1", locationId: FAKE_LOCATION_ID })).toMatchObject({ status: 401, body: { error: expect.stringMatching(/did not accept this token/u) } });
  hl.tokens.add("pit-e2e-token-12345");
  expect(await api("POST", "/api/highlevel/token", { token: "pit-e2e-token-12345", locationId: FAKE_LOCATION_ID })).toMatchObject({ status: 200, body: { state: "connected", kind: "token", location: { id: FAKE_LOCATION_ID, name: "Example Profiles" } } });
  const viaToken = await call(token, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" });
  expect(viaToken.body.result.isError).toBeUndefined();
  expect(hl.calls.at(-1)?.headers.authorization).toBe("Bearer pit-e2e-token-12345");
  expect(relay.refreshes).toBe(2);
}, 40_000);

it("does not create a note after Stop during a rate-limit wait, and allows the next turn", async () => {
  const bot = (await api("POST", "/api/bots", { name: "Stopped CRM writer" })).body.bot;
  hl.tokens.add("pit-stop-fixture-12345");
  expect((await api("POST", "/api/highlevel/token", { token: "pit-stop-fixture-12345", locationId: FAKE_LOCATION_ID })).status).toBe(200);
  const token = await mint(bot.id, bot.threadId);
  hl.calls.length = 0;
  hl.overrides.push({ status: 429, headers: { "retry-after": "3" } });
  const pending = call(token, "HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "Stopped fixture note" });
  await expect.poll(() => hl.calls.length, { timeout: 2_000, interval: 10 }).toBe(1);
  expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
  expect((await pending).status).toBe(401);
  expect(hl.calls.filter((row) => row.method === "POST" && row.path.endsWith("/notes"))).toHaveLength(1);
  const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  expect(messages.filter((row) => row.tool?.name === "mcp__highlevel__HIGHLEVEL_ADD_NOTE")).toEqual([]);
  const next = await call(await mint(bot.id, bot.threadId), "HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "Next fixture note" });
  expect(next.body.result.structuredContent).toMatchObject({ note: { id: "note_new" } });
}, 20_000);
