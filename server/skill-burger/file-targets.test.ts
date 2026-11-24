import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { applyChoices, draftView } from "../../shared/skill-burger/draft-view.ts";
import { draftWorkflow } from "../../shared/skill-burger/draft.ts";
import { workflowSchema, type Workflow } from "../../shared/skill-burger/format.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { createExecutors } from "./executors.ts";
import { createSkillBurgerRoutes } from "./routes.ts";
import { startRun, type RunDeps } from "./runner.ts";
import { readWorkflowSkill, saveWorkflowSkill } from "./store.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const content = "First, collect the findings. Then publish the finished report.";
const conversation = "/Users/ana/task-workspaces/ae3a6bd7-afb4-4ad1-909b-5a7b6d887ac9/a48d8ea2-161f-4ca1-a80c-0591f3082283";

const recorded = (path: string): RunMessage[] => [
  { id: "ask", role: "user", kind: "text", text: "Write report.txt and copy it to the archive." },
  { id: "write", role: "bot", kind: "activity", tool: { name: "Write", ok: true, input: JSON.stringify({ file_path: path, content }) } },
  { id: "copy", role: "bot", kind: "activity", tool: { name: "Bash", ok: true, input: JSON.stringify({ command: `cp "${path}" archive.txt` }) } },
];

const depsIn = (cwd: string): RunDeps => ({
  exec: createExecutors({ botId: "lead", cwd, internal: async () => { throw new Error("unexpected internal call"); } }),
  events: { started() {}, ended() {} }, save() {},
});

it.skipIf(process.platform === "win32").each([
  { name: "a plain filename", source: "report.txt", prefix: "", override: true },
  { name: "a filename under a fixed folder", source: "reports/report.txt", prefix: "reports/", override: true },
  { name: "the recorded conversation's folder", source: `${conversation}/reports/report.txt`, prefix: "./reports/", override: true },
  { name: "the saved default", source: "report.txt", prefix: "", override: false },
])("writes and consumes the same selected target for $name", async ({ source, prefix, override }) => {
  const root = mkdtempSync(join(tmpdir(), "burger-file-targets-"));
  roots.push(root);
  const messages = recorded(source);
  const draft = draftWorkflow(messages)!;
  const chosen = applyChoices(draft.workflow, { inputs: { file: { name: "report" } } });
  if ("error" in chosen) throw new Error(chosen.error);
  const saved = saveWorkflowSkill({ root, name: "archive-report", origin: "lead", botIds: ["lead"], workflow: chosen });
  if ("error" in saved) throw new Error(saved.error);
  const workflow = readWorkflowSkill(saved.name, root)!.workflow;
  const filename = override ? "current report.txt" : "report.txt";
  const result = await startRun({ name: saved.name, botId: "lead", threadId: "current", sha256: saved.sha256, workflow, ...(override ? { args: { report: filename } } : {}) }, depsIn(root));
  expect(result).toMatchObject({ ok: true, status: "ok" });
  expect(readFileSync(join(root, prefix, filename), "utf8")).toBe(content);
  expect(readFileSync(join(root, "archive.txt"), "utf8")).toBe(content);
  if (override) expect(existsSync(join(root, prefix, "report.txt"))).toBe(false);
  expect(workflow.args).toEqual({ report: { default: "report.txt", label: "file" } });
  const detail = draftView(workflow, draft.layers, messages).steps[0]!.detail;
  expect(typeof detail).toBe("string");
  if (override) expect(detail).toBe(`${prefix}{report}`);
});

it("still rejects a selected file target outside the conversation before writing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "burger-file-target-boundary-"));
  roots.push(root);
  const cwd = join(root, "conversation");
  mkdirSync(cwd);
  const workflow = draftWorkflow(recorded("report.txt"))!.workflow;
  const result = await startRun({ name: "archive-report", botId: "lead", threadId: "current", sha256: "test", workflow, args: { file: "../outside.txt" } }, depsIn(cwd));
  expect(result).toMatchObject({ ok: false, error: { type: "step_failed", step: "s1", message: expect.stringContaining("only inside this conversation's folder") } });
  expect(existsSync(join(root, "outside.txt"))).toBe(false);
  expect(existsSync(join(cwd, "report.txt"))).toBe(false);
  expect(existsSync(join(cwd, "archive.txt"))).toBe(false);
});

it.skipIf(process.platform === "win32")("keeps a filename that only contains the named file as a substring", async () => {
  const root = mkdtempSync(join(tmpdir(), "burger-file-target-literal-"));
  roots.push(root);
  const workflow = draftWorkflow(recorded("report.txt.bak"))!.workflow;
  expect(workflow.args).toEqual({});
  expect(await startRun({ name: "archive-report", botId: "lead", threadId: "current", sha256: "test", workflow, args: { file: "another.txt" } }, depsIn(root))).toMatchObject({ ok: true, status: "ok" });
  expect(readFileSync(join(root, "report.txt.bak"), "utf8")).toBe(content);
  expect(readFileSync(join(root, "archive.txt"), "utf8")).toBe(content);
});

it.each(["", "a".repeat(1_001)])("validates the target length after filling its input (%#. case)", async (filename) => {
  const root = mkdtempSync(join(tmpdir(), "burger-file-target-length-"));
  roots.push(root);
  const workflow = draftWorkflow(recorded("report.txt"))!.workflow;
  const result = await startRun({ name: "archive-report", botId: "lead", threadId: "current", sha256: "test", workflow, args: { file: filename } }, depsIn(root));
  expect(result).toMatchObject({ ok: false, error: { type: "step_failed", step: "s1", message: expect.stringContaining("between 1 and 1000 characters") } });
  expect(existsSync(join(root, "report.txt"))).toBe(false);
});

it.skipIf(process.platform === "win32").each(["literal", "input"])("reads, restores, copies and runs a version-1 workflow with a %s file target", async (kind) => {
  const root = mkdtempSync(join(tmpdir(), "burger-file-target-copy-"));
  roots.push(root);
  const legacy = workflowSchema.parse({ version: 1, summary: "Archive a report", args: {}, steps: [
    { id: "s1", kind: "file", label: "Write report.txt", path: "report.txt", content },
    { id: "s2", kind: "shell", label: "Copy the report", run: "cp report.txt archive.txt" },
  ] });
  const routes = [createSkillBurgerRoutes({ root, messages: () => recorded("report.txt"), owns: () => true, sees: () => true, botIds: () => ["lead"] })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const saved = await api("/api/skill-burgers", "POST", kind === "literal" ? { botId: "lead", name: "report", workflow: legacy } : { botId: "lead", threadId: "recorded", name: "report" });
  expect(saved.status).toBe(201);
  const meta = await saved.json() as { skill: { sha256: string } };
  const read = await (await api("/api/skill-burgers/report")).json() as { workflow: Workflow; text: string };
  expect(read.workflow.version).toBe(1);
  if (kind === "literal") expect(read.workflow).toEqual(legacy);
  else expect(read.text).toContain("`{file}`");
  expect(read.text).not.toContain("[object Object]");
  expect((await api(`/api/skill-burgers/report?sha256=${meta.skill.sha256}`, "DELETE")).status).toBe(200);
  expect((await api("/api/skill-burgers/report")).status).toBe(404);
  expect((await api("/api/skill-burgers", "POST", { botId: "lead", name: "report", workflow: read.workflow })).status).toBe(201);
  expect((await api("/api/skill-burgers", "POST", { botId: "lead", name: "report-copy", workflow: read.workflow })).status).toBe(201);
  const copy = await (await api("/api/skill-burgers/report-copy")).json() as { workflow: Workflow; text: string };
  expect(copy.workflow).toEqual(read.workflow);
  const filename = kind === "literal" ? "report.txt" : "copied report.txt";
  const result = await startRun({ name: "report-copy", botId: "lead", threadId: "copy", sha256: "test", workflow: copy.workflow, args: { file: filename } }, depsIn(root));
  expect(result).toMatchObject({ ok: true, status: "ok" });
  expect(readFileSync(join(root, filename), "utf8")).toBe(content);
  expect(readFileSync(join(root, "archive.txt"), "utf8")).toBe(content);
});
