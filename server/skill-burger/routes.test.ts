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
import { createSkillBurgerRoutes } from "./routes.ts";

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

async function serve() {
  const root = mkdtempSync(join(tmpdir(), "burger-routes-"));
  const routes = [createSkillBurgerRoutes({
    messages: (threadId) => (threadId === "t1" ? thread : []),
    owns: (botId, threadId) => botId === "scout" && ["t1", "t2", "t4"].includes(threadId),
    sees: (_auth, threadId) => threadId !== "t2",
    root,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/skill-burgers`;
  return async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
}

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

it("saves a conversation's run, lists it, reads it, undoes it and puts a removal back", async () => {
  const api = await serve();
  const saved = await api("", post({ botId: "scout", threadId: "t1", summary: "Send the invoice" }));
  expect(saved.status).toBe(201);
  expect(saved.body.skill).toMatchObject({ name: "send-the-invoice", summary: "Send the invoice", args: ["query", "recipient", "subject"] });
  expect((await api("")).body.skills.map((skill: { name: string }) => skill.name)).toEqual(["send-the-invoice"]);
  const read = await api("/send-the-invoice");
  expect(read.body.text).toContain("tags: workflow");
  expect(read.body.workflow.steps).toHaveLength(2);

  expect((await api("", post({ botId: "scout", threadId: "t1", name: "send-the-invoice" }))).status).toBe(409);
  expect((await api(`/send-the-invoice?sha256=${"0".repeat(64)}`, { method: "DELETE" })).status).toBe(409);
  expect((await api(`/send-the-invoice?sha256=${saved.body.skill.sha256}`, { method: "DELETE" })).body).toEqual({ removed: true });
  expect((await api("")).body.skills).toEqual([]);

  expect((await api("", post({ name: "send-the-invoice", workflow: read.body.workflow }))).status).toBe(201);
  expect((await api("")).body.skills).toHaveLength(1);
});

it("refuses a conversation the person can't see or that isn't the bot's, and a run with nothing to save", async () => {
  const api = await serve();
  expect((await api("", post({ botId: "scout", threadId: "t2" }))).status).toBe(404);
  expect((await api("", post({ botId: "other", threadId: "t1" }))).status).toBe(404);
  expect((await api("", post({ botId: "scout", threadId: "t3" }))).status).toBe(404);
  expect((await api("", post({ botId: "scout", threadId: "t4" }))).status).toBe(422);
  expect((await api("", post({ name: "x", workflow: { version: 1 } }))).status).toBe(422);
});

it("names a finished run with the bot's small text model, and says nothing when there is none", async () => {
  const root = mkdtempSync(join(tmpdir(), "burger-summary-"));
  const prompts: string[] = [];
  const routes = [createSkillBurgerRoutes({
    messages: () => thread, owns: () => true, sees: () => true, root,
    summarize: async (_botId, prompt) => { prompts.push(prompt); return "\"Sends the invoice to Priya.\""; },
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: {} as RequestAuth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/skill-burger-summary`, post({ botId: "scout", threadId: "t1" }));
  expect(await res.json()).toEqual({ summary: "Sends the invoice to Priya" });
  expect(prompts[0]).toContain("Request: Send the invoice to priya@example.com");
  const port = (server.address() as AddressInfo).port;
  routes[0] = createSkillBurgerRoutes({ messages: () => thread, owns: () => true, sees: () => true, root });
  expect(await (await fetch(`http://127.0.0.1:${port}/api/skill-burger-summary`, post({ botId: "scout", threadId: "t1" }))).json()).toEqual({ summary: null });
});
