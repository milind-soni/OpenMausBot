import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { workflowSchema, type Workflow } from "../../shared/skill-burger/format.ts";
import type { SavedWorkflow } from "../../shared/skill-burger/saved.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { readSkillLibraryIndex } from "../skill-library.ts";
import { createSkillBurgerRoutes } from "./routes.ts";
import { createSkillBurgerRuns, type BurgerTurn } from "./runs.ts";
import { saveWorkflowSkill } from "./store.ts";

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "burger-revisions-"));
  roots.push(root);
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const workflow = workflowSchema.parse({ version: 1, summary: "Invoice report", args: {}, steps: [
    { id: "s1", kind: "app", app: "gmail", tool: "GMAIL_FETCH_EMAILS", label: "Find invoices", args: { query: "invoice" } },
    { id: "s2", kind: "file", label: "Write report", path: "report.txt", content: "Invoice summary" },
  ] });
  const saved = saveWorkflowSkill({ workflow, name: "invoice-report", origin: "lead", botIds: ["lead"], root });
  if ("error" in saved) throw new Error(saved.error);
  let fetches = 0;
  const turn: BurgerTurn = {
    botId: "lead", threadId: "t", cwd, mayEditBurgers: true, publish() {},
    async internal(kind, path, body) {
      expect(kind).toBe("connectors");
      expect(path).toBe("/api/internal/connectors/mcp");
      expect(body).toMatchObject({ params: { arguments: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "invoice" } }] } } });
      fetches += 1;
      return { ok: true, body: { result: { content: [{ type: "text", text: JSON.stringify({ data: { results: [
        { tool_slug: "GMAIL_FETCH_EMAILS", response: { successful: true, data: { messages: [{ id: "invoice-1" }] } } },
      ] } }) }] } } };
    },
  };
  const runs = createSkillBurgerRuns({ dataDir: root, root });
  const routes = [runs.internalRoutes(turn), createSkillBurgerRoutes({
    root, messages: () => [], botIds: () => ["lead"], owns: () => true, sees: () => true,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as { workflow?: Workflow; text?: string; skill?: SavedWorkflow; undo?: string; error?: unknown } };
  };
  const edit = (path: string) => api("POST", "/api/internal/skill-burgers/edit", {
    name: saved.name, action: "set_when", step: "s2", when: { $step: "s1", path, op: "exists" },
  });
  const run = () => api("POST", "/api/internal/skill-burgers/run", { name: saved.name });
  return { api, edit, run, saved, instructionSha256: readSkillLibraryIndex(root)[saved.name]!.sha256, report: join(cwd, "report.txt"), fetches: () => fetches };
}

it("refuses an older undo after another condition edit, then still allows undo of the latest edit", async () => {
  const h = await fixture();
  const before = await h.api("GET", "/api/skill-burgers/invoice-report");
  const first = await h.edit("messages.0");
  const second = await h.edit("messages.1");
  expect([first.status, second.status]).toEqual([200, 200]);
  expect((await h.api("GET", "/api/skill-burgers/invoice-report")).body.text).toBe(before.body.text);
  const stale = await h.api("POST", "/api/internal/skill-burgers/undo", { undo: first.body.undo });
  expect((await h.run()).body).toMatchObject({ ok: true, status: "ok" });
  expect(h.fetches()).toBe(1);
  expect(existsSync(h.report)).toBe(false);
  expect(stale.status).toBe(409);
  expect((await h.api("GET", "/api/skill-burgers/invoice-report")).body.workflow!.steps[1]!.when).toEqual({ $step: "s1", path: "messages.1", op: "exists" });
  expect(second.body.skill!.sha256).not.toBe(first.body.skill!.sha256);

  expect((await h.api("POST", "/api/internal/skill-burgers/undo", { undo: second.body.undo })).status).toBe(200);
  expect((await h.run()).body).toMatchObject({ ok: true, status: "ok" });
  expect(readFileSync(h.report, "utf8")).toBe("Invoice summary");
});

it.each(["remove", "rename"])("refuses a stale %s after an executable-only edit, while accepting the current revision", async (action) => {
  const h = await fixture();
  const changed = await h.edit("messages.1");
  expect(changed.status).toBe(200);
  const mutate = (sha256: string) => action === "remove"
    ? h.api("DELETE", `/api/skill-burgers/invoice-report?sha256=${sha256}`)
    : h.api("PATCH", "/api/skill-burgers/invoice-report", { rename: "renamed-report", sha256 });
  const stale = await mutate(h.saved.sha256);
  expect((await h.run()).body).toMatchObject({ ok: true, status: "ok" });
  expect(h.fetches()).toBe(1);
  expect(existsSync(h.report)).toBe(false);
  expect(stale.status).toBe(409);
  const current = await mutate(changed.body.skill!.sha256);
  expect(current.status).toBe(200);
  expect((await h.api("GET", "/api/skill-burgers/invoice-report")).status).toBe(404);
  if (action === "rename") {
    expect((await h.api("GET", "/api/skill-burgers/renamed-report")).body.workflow!.steps[1]!.when).toEqual({ $step: "s1", path: "messages.1", op: "exists" });
  }
});

it("requires a refreshed token for a client holding only the old instructions hash", async () => {
  const h = await fixture();
  const old = await h.api("DELETE", `/api/skill-burgers/invoice-report?sha256=${h.instructionSha256}`);
  expect(old.status).toBe(409);
  expect((await h.run()).body).toMatchObject({ ok: true, status: "ok" });
  expect(readFileSync(h.report, "utf8")).toBe("Invoice summary");
  const current = await h.api("DELETE", `/api/skill-burgers/invoice-report?sha256=${h.saved.sha256}`);
  expect(current.status).toBe(200);
});
