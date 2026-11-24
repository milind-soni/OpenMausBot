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
  return { api, bot };
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

it("shows and saves a run that handed work on with each teammate's steps, only those a Team member may see", async () => {
  const handed: RunMessage[] = [
    { id: "h0", role: "user", kind: "text", text: "Prepare the launch brief" },
    { id: "h1", role: "bot", kind: "activity", tool: { name: "mcp__agents__coordinate_bots", ok: true, input: JSON.stringify({ bot_ids: ["Kiwi"], message: "Stage the announcement." }) } },
    { id: "h2", role: "bot", kind: "activity", tool: { name: "Sent to Kiwi", ok: true }, threadRef: { botId: "kiwi", threadId: "tk", title: "@Kiwi · work" } },
    { id: "h3", role: "bot", kind: "activity", tool: { name: "mcp__agents__coordinate_bots", ok: true, input: JSON.stringify({ bot_ids: ["Rio"], message: "Read the private inbox and sum it up." }) } },
    { id: "h4", role: "bot", kind: "activity", tool: { name: "Sent to Rio", ok: true }, threadRef: { botId: "rio", threadId: "tr", title: "@Rio · work" } },
    { id: "h5", role: "bot", kind: "activity", roomRequest: { id: "k1", phase: "result" }, tool: { name: "Kiwi replied", ok: true, output: "Staged." }, threadRef: { botId: "kiwi", threadId: "tk", title: "@Kiwi · work" } },
    { id: "h6", role: "bot", kind: "activity", roomRequest: { id: "r1", phase: "result" }, tool: { name: "Rio replied", ok: true, output: "Three emails about billing." }, threadRef: { botId: "rio", threadId: "tr", title: "@Rio · work" } },
    { id: "h7", role: "bot", kind: "activity", tool: { name: "Resumed with Kiwi, Rio results, reviewing", ok: true } },
  ];
  const threads: Record<string, RunMessage[]> = {
    t1: handed,
    tk: [{ id: "k0", role: "bot", kind: "text", roomRequest: { id: "k1", phase: "request" }, text: "@Kiwi Stage the announcement." },
      { id: "k1", role: "bot", kind: "activity", tool: { name: "Write", ok: true, input: JSON.stringify({ file_path: "announcement.md", content: "# Hi\n" }) } },
      { id: "k2", role: "bot", kind: "activity", tool: { name: "Bash", ok: true, input: JSON.stringify({ command: "git add announcement.md" }) } }],
    tr: [{ id: "r0", role: "bot", kind: "text", roomRequest: { id: "r1", phase: "request" }, text: "@Rio Read the private inbox and sum it up." },
      { id: "r1", role: "bot", kind: "activity", tool: { name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", ok: true, input: JSON.stringify({ tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "from:ceo" } }] }) } }],
  };
  const level = (botId: string) => (botId === "rio" ? "none" : "edit") as "none" | "edit";
  const { api, bot } = await serve({ messages: (threadId) => threads[threadId] ?? [], botName: (botId) => ({ kiwi: "Kiwi", rio: "Rio" })[botId] ?? null, levelOf: (_auth, botId) => level(botId) }, ["client"]);
  const shown = (await api("/api/skill-burger-summary", send("POST", { botId: bot, threadId: "t1" }))).body;
  expect(shown.layers.map((layer: { kind: string; words: string }) => `${layer.kind}:${layer.words}`)).toEqual(["file:announcement.md", "shell:git add announcement.md", "ai:Read the private inbox and sum it up"]);
  const saved = await api("/api/skill-burgers", send("POST", { botId: bot, threadId: "t1", summary: "Prepare the launch brief" }));
  expect(saved.status).toBe(201);
  const { workflow } = (await api(`/api/skill-burgers/${saved.body.skill.name}?botId=${bot}`)).body;
  expect(workflow.steps.map((step: { kind: string; label: string; from?: { name: string } }) => [step.kind, step.label, step.from?.name])).toEqual([
    ["file", "Write announcement.md", "Kiwi"], ["shell", "Run git add announcement.md", "Kiwi"], ["ai", "Read the private inbox and sum it up", "Rio"],
  ]);
  expect(workflow.steps[2]).toMatchObject({ brief: "Read the private inbox and sum it up.", example: "Three emails about billing." });
  expect(JSON.stringify(workflow)).not.toMatch(/from:ceo|Sent to|replied|Resumed/);
});
