import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { workflowSchema } from "../../shared/skill-burger/format.ts";
import { RUN_STEP_MARK } from "../../shared/skill-burger/layers.ts";
import { runText } from "../drivers/agents-workflow-tool.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { createSkillBurgerRuns, type BurgerTurn, type StepEvent } from "./runs.ts";
import { saveWorkflowSkill } from "./store.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve() {
  const root = mkdtempSync(join(tmpdir(), "burger-runs-"));
  const bot = `run-burger-${Math.random().toString(36).slice(2, 10)}`;
  const events: StepEvent[] = [];
  const calls: string[] = [];
  const workflow = workflowSchema.parse({
    version: 1, summary: "Email the sheet", args: { to: { default: "a@example.com" } },
    steps: [
      { id: "s1", kind: "app", app: "googlesheets", tool: "GOOGLESHEETS_BATCH_GET", label: "Read the sheet", args: {} },
      { id: "s2", kind: "ai", deterministic: false, label: "Write the body", prompt: "Summarise it.", input: { $step: "s1" } },
      { id: "s3", kind: "app", app: "gmail", tool: "GMAIL_SEND_EMAIL", label: "Send email", args: { to: { $arg: "to" }, body: { $step: "s2" } } },
    ],
  });
  saveWorkflowSkill({ workflow, place: { botId: bot }, botIds: [bot], root });
  const runs = createSkillBurgerRuns({
    dataDir: root, root,
    executors: () => ({
      app: async (input) => { calls.push(`${input.tool} ${JSON.stringify(input.args)}`); return { ok: true, output: { rows: [[1]] } }; },
      shell: async () => ({ ok: true, output: "" }), browser: async () => ({ ok: true, output: "" }), file: async () => ({ ok: true, output: "" }),
    }),
  });
  const turnFor = (botId: string): BurgerTurn => ({ botId, threadId: "t1", cwd: root, mayEditEveryChat: false, internal: async () => ({ ok: false, body: {} }), publish: (event) => events.push(event) });
  let as = bot;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!await dispatchRoutes([runs.internalRoutes(turnFor(as))], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: {} as RequestAuth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => (await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<Record<string, any>>;
  return { post, events, calls, bot, actAs: (id: string) => { as = id; } };
}

it("runs a bot's Skill Burger, hands its AI step back, and goes on once the bot resumes it", async () => {
  const h = await serve();
  const paused = await h.post("/api/internal/skill-burgers/run", { name: "email-the-sheet", args: { to: "priya@example.com" } });
  expect(paused).toMatchObject({ ok: true, status: "needs_input", requiresInput: { type: "ai_step", step: "s2" } });
  expect(runText(paused)).toContain(`call run_workflow with resume "${paused.requiresInput.resumeToken}"`);
  expect(h.events.map((event) => [event.type, event.title])).toEqual([
    ["item.started", "Read the sheet"], ["item.completed", undefined], ["item.started", "Write the body"],
  ]);
  expect(JSON.parse(h.events[0]!.input!)).toEqual({ [RUN_STEP_MARK]: paused.run, name: "email-the-sheet", step: "s1" });

  h.actAs("another-bot");
  expect(await h.post("/api/internal/skill-burgers/resume", { run: paused.run, response: "x" })).toHaveProperty("error");
  h.actAs(h.bot);
  const done = await h.post("/api/internal/skill-burgers/resume", { run: paused.run, response: "One row." });
  expect(done).toMatchObject({ ok: true, status: "ok" });
  expect(h.calls.at(-1)).toBe('GMAIL_SEND_EMAIL {"to":"priya@example.com","body":"One row."}');
  expect(h.events.filter((event) => event.type === "item.started").map((event) => event.title)).toEqual(["Read the sheet", "Write the body", "Send email"]);
  expect(await h.post("/api/internal/skill-burgers/resume", { run: paused.run, response: "again" })).toHaveProperty("error");
});

it("changes the steps when asked, with an undo, and refuses a burger that isn't there", async () => {
  const h = await serve();
  const changed = await h.post("/api/internal/skill-burgers/edit", { name: "email-the-sheet", action: "set_when", step: "s3", when: { $step: "s1", path: "rows.0", op: "exists" } });
  expect(changed.skill.layers).toHaveLength(3);
  const undone = await h.post("/api/internal/skill-burgers/undo", { undo: changed.undo });
  expect(undone).toHaveProperty("skill");
  expect(await h.post("/api/internal/skill-burgers/undo", { undo: changed.undo })).toHaveProperty("error");
  expect(await h.post("/api/internal/skill-burgers/run", { name: "nope" })).toHaveProperty("error");
});
