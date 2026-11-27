import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { workflowSchema } from "../../shared/skill-burger/format.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import type { RunEnvelope } from "./runner.ts";
import { createSkillBurgerRuns, EDIT_PATH, RESUME_PATH, RUN_PATH, UNDO_PATH } from "./runs.ts";
import { readWorkflowSkill, saveWorkflowSkill } from "./store.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

async function fixture(sales: boolean) {
  const root = mkdtempSync(join(tmpdir(), "burger-nested-cases-"));
  roots.push(root);
  const workflow = workflowSchema.parse({ version: 1, summary: "Route the request", args: {}, steps: [
    { id: "s1", kind: "file", label: "Start", path: "started.txt", content: "started" },
    { id: "shared", kind: "file", label: "Keep the shared result", path: "shared.txt", content: { $step: "s1" } },
    { id: "quiet", kind: "file", label: "Only for another result", path: "quiet.txt", content: "must not run", when: { $step: "s1", op: "eq", value: "another result" } },
    { id: "s2", kind: "file", label: "Finish", path: "finished.txt", content: "finished" },
  ] });
  const saved = saveWorkflowSkill({ root, name: "route-request", origin: "lead", botIds: ["lead"], workflow });
  if ("error" in saved) throw new Error(saved.error);
  const runs = createSkillBurgerRuns({ root, dataDir: root });
  const route = runs.internalRoutes({ botId: "lead", threadId: "requests", cwd: root, mayEditBurgers: true, publish() {}, internal: async () => { throw new Error("unexpected internal call"); } });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: {} as RequestAuth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async <T>(path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as T };
  };
  const read = () => readWorkflowSkill(saved.name, root)!.workflow;
  const edit = async (change: object) => {
    const response = await post<{ undo: string; error?: string }>(EDIT_PATH, { name: saved.name, ...change });
    expect(response.status, response.body.error).toBe(200);
    return response.body;
  };
  await edit({ action: "add_case", decide: { after: "s1", label: "Routing", prompt: "Support or sales?" }, case: "support", steps: [
    { kind: "decide", label: "Request kind", cases: ["bug", "question"], prompt: "Bug or question?" },
  ] });
  const outer = read().steps.find((step) => step.label === "Routing")!.id;
  const kind = read().steps.find((step) => step.label === "Request kind")!.id;
  await edit({ action: "add_case", decide: { id: kind }, case: "bug", steps: [
    { kind: "decide", label: "Severity", cases: ["urgent", "normal"], prompt: "Urgent or normal?" },
  ] });
  const severity = read().steps.find((step) => step.label === "Severity")!.id;
  const file = (path: string, content: string) => ({ kind: "file", label: `Write ${content}`, path, content });
  await edit({ action: "add_case", decide: { id: severity }, case: "urgent", steps: [file("urgent.txt", "urgent")] });
  await edit({ action: "add_case", decide: { id: kind }, case: "question", steps: [file("question.txt", "question")] });
  if (sales) await edit({ action: "add_case", decide: { id: outer }, case: "sales", steps: [file("sales.txt", "sales")] });
  const run = async (answers: string[]) => {
    let response = await post<RunEnvelope>(RUN_PATH, { name: saved.name });
    expect(response.status).toBe(200);
    for (const answer of answers) {
      expect(response.body).toMatchObject({ ok: true, status: "needs_input", requiresInput: { type: "decide" } });
      response = await post<RunEnvelope>(RESUME_PATH, { run: response.body.run, response: answer });
      expect(response.status).toBe(200);
    }
    expect(response.body).toMatchObject({ ok: true, status: "ok" });
  };
  return { root, outer, kind, severity, read, edit, post, run };
}

it.each([
  { name: "an outer case", remove: "outer", answers: ["sales"], expected: "sales", gone: ["Request kind", "Severity", "Write urgent", "Write question"] },
  { name: "an inner case", remove: "inner", answers: ["support", "question"], expected: "question", gone: ["Severity", "Write urgent"] },
  { name: "the final outer case", remove: "last", answers: [], expected: undefined, gone: ["Routing", "Request kind", "Severity", "Write urgent", "Write question"] },
  { name: "a leaf case", remove: "leaf", answers: ["support", "question"], expected: "question", gone: ["Write urgent"] },
])("removes $name with its nested steps, preserves the remaining run and supports Undo", async ({ remove, answers, expected, gone }) => {
  const h = await fixture(remove !== "last");
  const before = h.read();
  const decide = remove === "inner" ? h.kind : remove === "leaf" ? h.severity : h.outer;
  const changed = await h.edit({ action: "remove_case", decide, case: remove === "inner" ? "bug" : remove === "leaf" ? "urgent" : "support" });
  const after = h.read();
  expect(after.steps.some((step) => gone.includes(step.label))).toBe(false);
  const outside = new Set(["s1", "s2", "shared", "quiet"]);
  expect(after.steps.filter((step) => outside.has(step.id))).toEqual(before.steps.filter((step) => outside.has(step.id)));
  await h.run(answers);
  expect(readFileSync(join(h.root, "finished.txt"), "utf8")).toBe("finished");
  expect(readFileSync(join(h.root, "shared.txt"), "utf8")).toBe("started.txt");
  expect(existsSync(join(h.root, "quiet.txt"))).toBe(false);
  expect(existsSync(join(h.root, "urgent.txt"))).toBe(false);
  for (const branch of ["sales", "question"]) {
    expect(existsSync(join(h.root, `${branch}.txt`))).toBe(expected === branch);
    if (expected === branch) expect(readFileSync(join(h.root, `${branch}.txt`), "utf8")).toBe(branch);
  }
  expect((await h.post(UNDO_PATH, { undo: changed.undo })).status).toBe(200);
  expect(h.read()).toEqual(before);
  await h.run(["support", "bug", "urgent"]);
  expect(readFileSync(join(h.root, "urgent.txt"), "utf8")).toBe("urgent");
});
