import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import type { WorkflowCheck } from "../../shared/skill-burger/format.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import type { RunEnvelope, RunState } from "./runner.ts";
import { createSkillBurgerRuns, EDIT_PATH, RESUME_PATH, RUN_PATH, type StepEvent } from "./runs.ts";
import { readWorkflowSkill, saveWorkflowSkill } from "./store.ts";

const servers: Server[] = [];
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function checkedPath(check?: WorkflowCheck, manual = false) {
  const root = mkdtempSync(join(tmpdir(), "burger-handed-check-"));
  folders.push(root);
  const name = "checked-report", botId = "checked-report-bot";
  const events: StepEvent[] = [];
  const saved = saveWorkflowSkill({ root, name, origin: botId, botIds: [botId], workflow: {
    version: 1, summary: "Prepare the checked report", args: { audience: { default: "the customer" } },
    steps: [{ id: "prepare", kind: "file", label: "Prepare", path: "prepared.txt", content: "ready" }],
  } });
  expect(saved).not.toHaveProperty("error");
  const make = () => createSkillBurgerRuns({ root, dataDir: root });
  let runs = make();
  const turn = {
    botId, threadId: "report-thread", cwd: root, mayEditBurgers: true,
    internal: async () => ({ ok: false, body: {} }), publish: (event: StepEvent) => events.push(event),
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!await dispatchRoutes([runs.internalRoutes(turn)], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: {} as RequestAuth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const changed = await post(EDIT_PATH, { name, action: "add_case", decide: { after: "prepare", prompt: "Which report path?" }, case: "report", steps: [
    { id: "reviewed", label: "Write the report", ...(manual ? { kind: "shell", where: "yourComputer", run: "printf report" } : { kind: "ai", deterministic: false, prompt: "Write the report for {audience}." }), ...(check === undefined ? {} : { check }) },
    { id: "publish", kind: "file", label: "Publish", path: "report.json", content: { $step: "reviewed" } },
  ] });
  expect(changed.status).toBe(200);
  const workflow = readWorkflowSkill(name, root)!.workflow;
  expect(workflow.steps.find((step) => step.label === "Write the report")?.check).toEqual(check);
  const selected = await (await post(RUN_PATH, { name })).json() as RunEnvelope;
  expect(selected).toMatchObject({ status: "needs_input", requiresInput: { type: "decide" } });
  const run = selected.run;
  const resume = async (response: string): Promise<RunEnvelope> => (await post(RESUME_PATH, { run, response })).json() as Promise<RunEnvelope>;
  expect(await resume("report")).toMatchObject({ status: "needs_input", requiresInput: { type: "ai_step", step: "c1" } });
  return {
    resume, events, restart: () => { runs = make(); },
    published: () => existsSync(join(root, "report.json")),
    report: () => JSON.parse(readFileSync(join(root, "report.json"), "utf8")),
    pending: () => JSON.parse(readFileSync(join(root, "skill-burger-runs", `${run}.json`), "utf8")) as RunState,
  };
}

const rule: WorkflowCheck = { says: "the report is approved", rule: { path: "approved", op: "eq", value: true } };
const report = { approved: true, text: "Ready for the customer." };

it.each([false, true])("checks a resumed result before publishing (on the person's computer: %s)", async (manual) => {
  const h = await checkedPath(rule, manual);
  h.restart();
  expect(await h.resume('{"approved":false,"text":"Still a draft"}')).toMatchObject({ ok: false, error: { type: "step_failed", step: "c1", message: expect.stringContaining("the report is approved") } });
  expect(h.published()).toBe(false);
  expect(h.pending()).toMatchObject({ waiting: { step: "c1", type: "failed" }, results: { c1: { state: "failed", detail: { check: { passed: false } } } } });
  h.restart();
  expect(await h.resume("fixed")).toMatchObject({ status: "needs_input", requiresInput: { type: "ai_step", step: "c1" } });
  expect(await h.resume(JSON.stringify(report))).toMatchObject({ status: "ok" });
  expect(h.report()).toEqual(report);
  expect(h.events.filter((event) => event.title === "Prepare")).toHaveLength(1);
});

it("publishes an AI result that passes its rule, with a successful check event", async () => {
  const h = await checkedPath(rule);
  expect(await h.resume(JSON.stringify(report))).toMatchObject({ status: "ok" });
  expect(h.report()).toEqual(report);
  expect(h.events.filter((event) => event.type === "item.completed").map((event) => JSON.parse(event.output!))).toContainEqual({ state: "done", detail: { check: { passed: true, says: rule.says } } });
});

it.each(["pass", "fail: the summary omitted the total"])("waits for an AI result's verbal check, then handles %s", async (verdict) => {
  const h = await checkedPath({ says: "the report is suitable for {audience}" });
  const check = await h.resume(JSON.stringify(report));
  expect(check).toMatchObject({ status: "needs_input", requiresInput: { type: "check", step: "c1", input: JSON.stringify(report), prompt: expect.stringContaining("the report is suitable for the customer") } });
  expect(h.published()).toBe(false);
  expect(h.pending()).toMatchObject({ waiting: { type: "check" }, results: { c1: { output: report } } });
  h.restart();
  const done = await h.resume(verdict);
  if (verdict === "pass") {
    expect(done).toMatchObject({ status: "ok" });
    expect(h.report()).toEqual(report);
  } else {
    expect(done).toMatchObject({ ok: false, error: { type: "step_failed", step: "c1" } });
    expect(h.published()).toBe(false);
  }
  expect(h.events.filter((event) => event.title === "Prepare")).toHaveLength(1);
});

it("still completes a resumed AI step without a check", async () => {
  const h = await checkedPath();
  expect(await h.resume(JSON.stringify(report))).toMatchObject({ status: "ok" });
  expect(h.report()).toEqual(report);
});
