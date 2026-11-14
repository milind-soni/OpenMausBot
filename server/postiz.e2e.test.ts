// A real server with two stand-in Postiz backends (Postiz Cloud, and a person's own Postiz) and the fake Claude engine:
// both ways of connecting end to end, the bot's turn gets the postiz tools and calls one, the token and the key reach
// Postiz and nothing else (no answer, transcript, prompt, log or data file), a refused key or address is said plainly,
// a revoked credential shows as such, and disconnecting takes the tools away.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { FAKE_POSTIZ_KEY, startFakePostiz, type FakePostiz } from "./testing/fake-postiz.ts";

type Dump = { prompt?: string; systemPrompt: string | null; mcpConfig: { mcpServers: Record<string, { url?: string; alwaysLoad?: boolean }> } };

let cloud: FakePostiz;
let own: FakePostiz;
let fixture: VerificationServer;
let scratch: string;
const answers: string[] = [];

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { "content-type": "application/json" }, redirect: "manual",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(40_000),
  });
  const text = await response.text();
  answers.push(text);
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
const toolCalls = () => join(scratch, "tool-calls.json");
const newBot = async (name: string): Promise<{ id: string; threadId: string }> => {
  const created = await api("POST", "/api/bots", { name });
  expect(created.status).toBe(201);
  return created.body.bot;
};

/** One turn of the bot with these scripted tool calls, and what the engine was given for it. */
async function turn(botId: string, calls: unknown[]): Promise<Dump> {
  writeFileSync(toolCalls(), JSON.stringify(calls));
  rmSync(fixture.fixtureDumpPath, { force: true });
  await control(["send", "--bot", botId, "--text", "Draft a post about our launch."]);
  await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 20_000 }).toBe(true);
  const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as Dump;
  expect(await control(["wait", "--bot", botId, "--timeout", "40"])).toMatchObject({ status: "settled" });
  return dump;
}

/** Files under the data folder that hold this text, the fake engine's own capture of its launch files aside. */
function filesHolding(secret: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && stat.size < 20_000_000 && path !== fixture.fixtureDumpPath && readFileSync(path).includes(secret)) found.push(relative(fixture.info.dataDir, path));
    }
  };
  walk(fixture.info.dataDir);
  return found.sort();
}

const draft = { socialPost: [{ integrationId: "int_linkedin", date: "2026-11-02T09:00:00.000Z", type: "draft", shortLink: false, isPremium: false, settings: [],
  postsAndComments: [{ content: "<p>We launched.</p>" }] }] };

beforeAll(async () => {
  cloud = await startFakePostiz();
  own = await startFakePostiz();
  scratch = mkdtempSync(join(tmpdir(), "omb-postiz-e2e-"));
  writeFileSync(join(scratch, "tool-calls.json"), "[]");
  fixture = await launchVerificationServer({ ...process.env, OMB_POSTIZ_CLOUD_URL: cloud.url, FAKE_CLAUDE_TOOL_CALLS_FILE: join(scratch, "tool-calls.json") });
}, 60_000);

afterAll(async () => {
  await fixture?.close();
  await cloud?.close();
  await own?.close();
  rmSync(scratch, { recursive: true, force: true });
});

it("signs in with Postiz Cloud, gives the bot the postiz tools behind a hidden token, and Disconnect takes them away", async () => {
  expect((await api("GET", "/api/postiz")).body).toMatchObject({ state: "not-connected", how: null, host: new URL(cloud.url).host, selfHosted: false, keySaved: false, team: false });
  expect((await api("POST", "/api/postiz/sign-in")).body).toMatchObject({ state: "not-connected", how: "sign-in" });
  const signInUrl = `${cloud.url}/mcp-oauth-dynamic`;
  expect((await api("GET", "/api/mcp/servers")).body.servers).toEqual([expect.objectContaining({ name: "postiz", url: signInUrl, enabled: false, headerKeys: [] })]);

  const started = (await api("POST", "/api/mcp/servers/postiz/sign-in")).body.auth;
  expect(started).toMatchObject({ phase: "waiting", flowId: expect.any(String) });
  const authorize = new URL(started.authorizationUrl);
  expect(authorize.origin + authorize.pathname).toBe(`${cloud.url}/oauth/authorize`);
  expect(cloud.counts.register).toBe(1);
  // The person approves on Postiz's page; Postiz sends the browser back to this computer's sign-in listener.
  const back = (await fetch(authorize, { redirect: "manual" })).headers.get("location")!;
  expect(new URL(back).hostname).toBe("127.0.0.1");
  expect(await (await fetch(back)).text()).toContain("Signed in");
  await expect.poll(async () => (await api("GET", `/api/mcp/servers/postiz/sign-in/${started.flowId}`)).body.auth?.phase).toBe("succeeded");
  const tested = (await api("POST", "/api/mcp/servers/postiz/test")).body;
  expect(tested).toMatchObject({ ok: true });
  expect(tested.tools.map((tool: { name: string }) => tool.name)).toEqual(["integrationList", "integrationSchema", "schedulePostTool", "postsListTool"]);
  expect((await api("PATCH", "/api/mcp/servers/postiz", { enabled: true })).status).toBe(200);
  expect((await api("GET", "/api/postiz")).body).toMatchObject({ state: "connected", how: "sign-in" });
  const token = cloud.issued[0]!;
  expect(token).toMatch(/^pos_/u);

  const bot = await newBot("Buzz");
  const mounted = await turn(bot.id, [{ server: "postiz", name: "schedulePostTool", input: draft }]);
  expect(mounted.mcpConfig.mcpServers.postiz).toMatchObject({ url: signInUrl });
  // A third-party server: Claude Code loads its tools on demand through tool search.
  expect(mounted.mcpConfig.mcpServers.postiz?.alwaysLoad).toBeUndefined();
  expect(cloud.calls).toEqual([{ name: "schedulePostTool", arguments: draft, authorization: `Bearer ${token}` }]);
  const messages = JSON.stringify((await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body);
  expect(messages).toContain("post_1");
  expect(messages).not.toContain(token);
  expect(`${mounted.prompt ?? ""}${mounted.systemPrompt ?? ""}`).not.toContain(token);
  expect(filesHolding(token)).toEqual(["mcp-oauth.json"]);

  // Postiz revokes the app: the next check says to sign in again.
  cloud.revoke(token);
  expect((await api("POST", "/api/postiz/check")).body).toMatchObject({ state: "needs-sign-in", how: "sign-in" });

  expect((await api("DELETE", "/api/postiz")).body).toMatchObject({ state: "not-connected", how: null });
  expect((await api("GET", "/api/mcp/servers")).body.servers).toEqual([]);
  const after = await turn(bot.id, []);
  expect(Object.keys(after.mcpConfig.mcpServers)).not.toContain("postiz");
  expect(filesHolding(token)).toEqual([]);
  expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain(token);
  for (const answer of answers) expect(answer).not.toContain(token);
}, 120_000);

it("connects a person's own Postiz with an API key, refuses a wrong key or address plainly, and never shows the key", async () => {
  expect((await api("DELETE", "/api/postiz")).status).toBe(200);
  answers.length = 0;
  const check = async (body: unknown) => (await api("POST", "/api/postiz/key-check", body));
  expect(await check({ key: "not-the-key", address: own.url })).toMatchObject({ status: 400, body: { ok: false, code: "key_rejected", error: expect.stringContaining("didn't accept this API key") } });
  expect(await check({ key: FAKE_POSTIZ_KEY, address: "http://postiz.example.com" })).toMatchObject({ status: 400, body: { code: "address" } });
  expect(await check({ key: FAKE_POSTIZ_KEY, address: "https://mcp.postiz.com/mcp/abc123" })).toMatchObject({ status: 400, body: { code: "address", error: expect.stringContaining("has a key in it") } });
  expect(await check({ key: FAKE_POSTIZ_KEY, address: "http://127.0.0.1:9" })).toMatchObject({ status: 400, body: { code: "unreachable" } });
  expect(await check({ key: FAKE_POSTIZ_KEY, address: `${own.url}/nothing-here` })).toMatchObject({ status: 400, body: { code: "not_postiz" } });
  expect(await check({ key: FAKE_POSTIZ_KEY, address: own.url })).toMatchObject({ status: 200, body: { ok: true, tools: 4 } });
  expect(own.calls).toEqual([]);

  // The save checks the key again at its address; a refused one is never stored.
  expect(await api("PUT", "/api/config", { postiz: { url: own.url, key: "not-the-key" } })).toMatchObject({ status: 400, body: { code: "key_rejected" } });
  expect(await api("PUT", "/api/config", { postiz: { url: "https://user:secret@postiz.example.com" } })).toMatchObject({ status: 400, body: { code: "address" } });
  expect((await api("GET", "/api/config")).body.postiz).toEqual({ configured: false });
  expect((await api("GET", "/api/mcp/servers")).body.servers).toEqual([]);

  const saved = await api("PUT", "/api/config", { postiz: { url: `${own.url}/`, key: FAKE_POSTIZ_KEY } });
  expect(saved.status).toBe(200);
  expect(saved.body.postiz).toEqual({ configured: true, last4: FAKE_POSTIZ_KEY.slice(-4), url: own.url });
  expect((await api("GET", "/api/mcp/servers")).body.servers).toEqual([expect.objectContaining({ name: "postiz", url: `${own.url}/mcp`, enabled: true, headerKeys: [] })]);
  expect((await api("GET", "/api/postiz")).body).toMatchObject({ state: "connected", how: "key", host: new URL(own.url).host, selfHosted: true, keySaved: true });
  expect((await api("POST", "/api/mcp/servers/postiz/test")).body).toMatchObject({ ok: true });

  const bot = await newBot("Buzz with a key");
  const mounted = await turn(bot.id, [{ server: "postiz", name: "schedulePostTool", input: draft }]);
  expect(mounted.mcpConfig.mcpServers.postiz).toMatchObject({ url: `${own.url}/mcp` });
  expect(own.calls).toEqual([{ name: "schedulePostTool", arguments: draft, authorization: `Bearer ${FAKE_POSTIZ_KEY}` }]);
  expect(cloud.calls.length).toBe(1);
  const messages = JSON.stringify((await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body);
  expect(messages).toContain("post_1");
  expect(messages).not.toContain(FAKE_POSTIZ_KEY);
  expect(`${mounted.prompt ?? ""}${mounted.systemPrompt ?? ""}`).not.toContain(FAKE_POSTIZ_KEY);
  // Off the desktop the key is the server's own config; nothing else keeps it.
  expect(filesHolding(FAKE_POSTIZ_KEY)).toEqual(["config.json"]);

  own.revoke(FAKE_POSTIZ_KEY);
  expect((await api("POST", "/api/postiz/check")).body).toMatchObject({ state: "key-refused", how: "key" });
  own.grant(FAKE_POSTIZ_KEY);

  expect((await api("PUT", "/api/config", { postiz: { key: "" } })).body.postiz).toMatchObject({ configured: false });
  expect((await api("GET", "/api/mcp/servers")).body.servers).toEqual([]);
  const after = await turn(bot.id, []);
  expect(Object.keys(after.mcpConfig.mcpServers)).not.toContain("postiz");
  expect(filesHolding(FAKE_POSTIZ_KEY)).toEqual([]);
  expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain(FAKE_POSTIZ_KEY);
  for (const answer of answers) expect(answer).not.toContain(FAKE_POSTIZ_KEY);
}, 120_000);
