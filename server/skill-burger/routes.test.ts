import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { createSkillBurgerRoutes, type SkillBurgerRouteDeps } from "./routes.ts";
import { createExecutors } from "./executors.ts";
import { startRun } from "./runner.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const call = (id: string, slug: string, args: unknown): RunMessage => ({
  id, role: "bot", kind: "activity", tool: { name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", ok: true, input: JSON.stringify({ tools: [{ tool_slug: slug, arguments: args }] }) },
});
const thread: RunMessage[] = [
  { id: "u1", role: "user", kind: "text", text: "Send the invoice to priya@example.com" },
  call("m1", "GMAIL_FETCH_EMAILS", { query: "invoice" }),
  call("m2", "GMAIL_SEND_EMAIL", { recipient_email: "priya@example.com", subject: "Invoice" }),
];

async function serve(extra: Partial<SkillBurgerRouteDeps> = {}, scopes: readonly string[] = ["admin"]) {
  const root = mkdtempSync(join(tmpdir(), "burger-routes-"));
  const bot = `route-burger-${Math.random().toString(36).slice(2, 10)}`;
  const routes = [createSkillBurgerRoutes({
    messages: (threadId) => (threadId === "t1" ? thread : []),
    owns: (botId, threadId) => botId === bot && ["t1", "t2", "t4"].includes(threadId),
    sees: (_auth, threadId) => threadId !== "t2",
    botIds: () => [bot],
    root,
    ...extra,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: scopes.includes("admin") ? "loopback" : "session", scopes } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { api, bot, root };
}

const send = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const names = async (api: Awaited<ReturnType<typeof serve>>["api"]) => (await api("/api/skill-burgers")).body.skills.map((skill: { name: string }) => skill.name);

it("saves a run for every chat, renames, undoes and puts a removal back", async () => {
  const { api, bot } = await serve();
  const saved = await api("/api/skill-burgers", send("POST", { botId: bot, threadId: "t1", summary: "Send the invoice" }));
  expect(saved.status).toBe(201);
  expect(saved.body.skill).toMatchObject({ name: "send-the-invoice", summary: "Send the invoice", botId: bot, args: ["query", "recipient", "subject"] });
  expect(saved.body.skill).not.toHaveProperty("everyChat");
  expect((await api("/api/skill-burgers")).body.skills.map((skill: { name: string; canChange: boolean }) => [skill.name, skill.canChange])).toEqual([["send-the-invoice", true]]);
  expect((await api("/api/skill-burgers/send-the-invoice")).body.text).toContain("tags: workflow");
  // The old switch for every chat is gone: every burger already is.
  expect((await api("/api/skill-burgers/send-the-invoice", send("PATCH", { everyChat: false }))).status).toBe(400);

  const renamed = await api("/api/skill-burgers/send-the-invoice", send("PATCH", { rename: "invoice-to-priya" }));
  expect(renamed.body.skill).toMatchObject({ name: "invoice-to-priya" });
  const read = await api("/api/skill-burgers/invoice-to-priya");
  expect((await api(`/api/skill-burgers/invoice-to-priya?sha256=${"0".repeat(64)}`, { method: "DELETE" })).status).toBe(409);
  expect((await api(`/api/skill-burgers/invoice-to-priya?sha256=${renamed.body.skill.sha256}`, { method: "DELETE" })).body).toEqual({ removed: true });
  expect(await names(api)).toEqual([]);
  expect((await api("/api/skill-burgers", send("POST", { name: "invoice-to-priya", workflow: read.body.workflow, botId: bot }))).status).toBe(201);
  expect(await names(api)).toEqual(["invoice-to-priya"]);
});

it("refuses a conversation the person can't see or that isn't the bot's, and a run with nothing to save", async () => {
  const { api, bot } = await serve();
  expect((await api("/api/skill-burgers", send("POST", { botId: bot, threadId: "t2" }))).status).toBe(404);
  expect((await api("/api/skill-burgers", send("POST", { botId: "other", threadId: "t1" }))).status).toBe(404);
  expect((await api("/api/skill-burgers", send("POST", { botId: bot, threadId: "t3" }))).status).toBe(404);
  expect((await api("/api/skill-burgers", send("POST", { botId: bot, threadId: "t4" }))).status).toBe(422);
  expect((await api("/api/skill-burgers", send("POST", { name: "x", workflow: { version: 1 }, botId: bot }))).status).toBe(422);
  expect((await api("/api/skill-burgers", send("POST", { name: "x", workflow: {}, botId: "gone" }))).status).toBe(422);
});

it("names a finished run with the bot's small text model, and says nothing when there is none", async () => {
  const prompts: string[] = [];
  const { api, bot } = await serve({ summarize: async (_botId, prompt) => { prompts.push(prompt); return "\"Sends the invoice to Priya.\""; } });
  expect((await api("/api/skill-burger-summary", send("POST", { botId: bot, threadId: "t1" }))).body).toEqual({ summary: "Sends the invoice to Priya" });
  expect(prompts[0]).toContain("Request: Send the invoice to priya@example.com");
  const plain = await serve();
  expect((await plain.api("/api/skill-burger-summary", send("POST", { botId: plain.bot, threadId: "t1" }))).body).toEqual({ summary: null });
});

it.each(["unavailable", "not requested"])("does not apply an earlier run's decisions when the next summary is %s", async (summary) => {
  let messages: RunMessage[] = [...thread, { id: "reply-1", role: "bot", kind: "text", text: "I sent the email only because invoices were found." }];
  let answering = true;
  const { api, bot, root } = await serve({
    messages: () => messages,
    summarize: async (_botId, prompt) => !answering ? null : prompt.startsWith("A run was saved")
      ? '{"conditions":[{"step":"s2","when":{"$step":"s1","path":"messages.0","op":"exists"}}]}'
      : "Send the invoice",
  });
  const request = { botId: bot, threadId: "t1" };
  await api("/api/skill-burger-summary", send("POST", request));
  const prior = await api("/api/skill-burgers", send("POST", { ...request, name: "conditional-invoice", summary: "A custom title" }));
  expect(prior.status).toBe(201);
  const previous = (await api("/api/skill-burgers/conditional-invoice")).body.workflow;
  expect(previous.steps[1].when).toEqual({ $step: "s1", path: "messages.0", op: "exists" });

  messages = [...messages, ...thread.map((message) => ({ ...message, id: `${message.id}-next` })),
    { id: "reply-2", role: "bot", kind: "text", text: "I sent the status email whether or not there were invoices." }];
  answering = false;
  if (summary === "unavailable") expect((await api("/api/skill-burger-summary", send("POST", request))).body).toEqual({ summary: null });
  const saved = await api("/api/skill-burgers", send("POST", { ...request, name: "unconditional-invoice" }));
  expect(saved.status).toBe(201);
  const workflow = (await api("/api/skill-burgers/unconditional-invoice")).body.workflow;
  const sent: Array<{ tool_slug: string; arguments: Record<string, unknown> }> = [];
  const exec = createExecutors({
    botId: bot, cwd: root,
    async internal(kind, path, body) {
      expect(kind).toBe("connectors");
      expect(path).toBe("/api/internal/connectors/mcp");
      const tool = (body as { params: { arguments: { tools: typeof sent } } }).params.arguments.tools[0]!;
      sent.push(tool);
      const data = tool.tool_slug === "GMAIL_FETCH_EMAILS" ? { messages: [] } : { messageId: "fixture-email" };
      return { ok: true, body: { result: { content: [{ type: "text", text: JSON.stringify({ data: { results: [{ tool_slug: tool.tool_slug, response: { successful: true, data } }] } }) }] } } };
    },
  });
  const ran = await startRun({ name: saved.body.skill.name, botId: bot, threadId: "fresh", sha256: saved.body.skill.sha256, workflow }, {
    exec, events: { started() {}, ended() {} }, save() { throw new Error("this workflow should finish without a pause"); },
  });
  expect(ran).toMatchObject({ ok: true, status: "ok" });
  expect(sent.map((tool) => tool.tool_slug)).toEqual(["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"]);
  expect(sent[1]!.arguments).toMatchObject({ recipient_email: "priya@example.com" });
  expect(workflow.steps[1]).not.toHaveProperty("when");
});


it("lets a Team member who can chat with the bot add a burger for everyone, and only them or an admin change it", async () => {
  let access: "none" | "view" | "chat" | "edit" = "chat";
  let person = "ada@acme.test";
  const { api, bot } = await serve({ levelOf: () => access, actorOf: () => person }, ["client"]);
  const saved = await api("/api/skill-burgers", send("POST", { botId: bot, threadId: "t1", summary: "Send the invoice" }));
  expect(saved.status).toBe(201);
  const name = saved.body.skill.name as string;
  // Everyone on the Cloud sees it, even someone who can't reach that bot; only Ada may change it.
  person = "cleo@acme.test";
  access = "none";
  expect((await api("/api/skill-burgers")).body.skills.map((skill: { name: string; canChange: boolean }) => [skill.name, skill.canChange])).toEqual([[name, false]]);
  expect((await api(`/api/skill-burgers/${name}`, send("PATCH", { rename: "mine-now" }))).status).toBe(403);
  expect((await api(`/api/skill-burgers/${name}`, { method: "DELETE" })).status).toBe(403);
  expect((await api("/api/skill-burgers", send("POST", { botId: bot, threadId: "t1" }))).status).toBe(403);
  person = "ada@acme.test";
  expect((await api("/api/skill-burgers")).body.skills[0].canChange).toBe(true);
  expect((await api(`/api/skill-burgers/${name}`, { method: "DELETE" })).status).toBe(200);
});
