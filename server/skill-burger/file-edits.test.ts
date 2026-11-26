import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

import { workflowSchema } from "../../shared/skill-burger/format.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { CodexDriver } from "../drivers/codex.ts";
import type { Json } from "../drivers/agents-client.ts";
import { runText } from "../drivers/agents-workflow-tool.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { recordEvents } from "../testing/events.ts";
import { toolDetailPreview } from "../tool-summary.ts";
import { createSkillBurgerRoutes } from "./routes.ts";
import type { RunEnvelope } from "./runner.ts";
import { createSkillBurgerRuns, RESUME_PATH, RUN_PATH } from "./runs.ts";

vi.mock("../drivers/codex-release.ts", async (original) => ({
  ...await original<typeof import("../drivers/codex-release.ts")>(),
  readLatestCodexRelease: async () => "0.156.1",
}));

const roots: string[] = [];
const servers: Server[] = [];
const folder = () => {
  const root = mkdtempSync(join(tmpdir(), "burger-file-edits-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const message = (name: string, input: unknown, output: unknown = "Edit applied"): RunMessage => ({
  id: "edit", role: "bot", kind: "activity",
  tool: { name, itemId: "edit-item", ok: true, input: toolDetailPreview(input), output: toolDetailPreview(output) },
});

async function replay(edit: RunMessage) {
  const root = folder();
  const messages: RunMessage[] = [
    { id: "ask", role: "user", kind: "text", text: "Apply the requested edits and mark completion" }, edit,
    message("Bash", { command: "printf complete > complete.txt" }),
  ];
  messages[2]!.id = "finish";
  const routes = createSkillBurgerRoutes({ root, messages: () => messages, owns: () => true, sees: () => true, botIds: () => ["lead"] });
  let runs = createSkillBurgerRuns({ root, dataDir: root });
  const turn = { botId: "lead", threadId: "edits", cwd: root, mayEditBurgers: true, publish() {}, internal: async () => { throw new Error("unexpected external call"); } };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    if (!await dispatchRoutes([routes, runs.internalRoutes(turn)], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async <T>(path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.ok).toBe(true);
    return await response.json() as T;
  };
  const saved = await api<{ skill: { name: string } }>("/api/skill-burgers", { botId: "lead", threadId: "edits", summary: "Apply file edits" });
  const read = await api<{ workflow: unknown }>(`/api/skill-burgers/${saved.skill.name}`);
  const workflow = workflowSchema.parse(read.workflow);
  const result = await api<RunEnvelope & Json>(RUN_PATH, { name: saved.skill.name });
  const resume = async () => {
    runs = createSkillBurgerRuns({ root, dataDir: root });
    expect(await api<RunEnvelope>(RESUME_PATH, { run: result.run, response: "The requested edits are complete." })).toMatchObject({ ok: true, status: "ok" });
    expect(readFileSync(join(root, "complete.txt"), "utf8")).toBe("complete");
  };
  return { root, workflow, result, resume };
}

it.each([
  { tool: "Edit", input: { file_path: "settings.toml", old_string: "max_retries = 2", new_string: "max_retries = 4", replace_all: false }, text: ["settings.toml", "max_retries = 2", "max_retries = 4", "replace_all"] },
  { tool: "MultiEdit", input: { file_path: "settings.toml", edits: [{ old_string: "max_retries = 2", new_string: "max_retries = 4" }, { old_string: "timeout = 5", new_string: "timeout = 10" }] }, text: ["max_retries = 4", "timeout = 5", "timeout = 10"] },
  { tool: "NotebookEdit", input: { notebook_path: "analysis.ipynb", cell_id: "cell-7", edit_mode: "replace", new_source: "print(42)" }, text: ["analysis.ipynb", "cell-7", "replace", "print(42)"] },
])("keeps the $tool instructions through saving, handoff and a disk-backed resume", async ({ tool, input, text }) => {
  const h = await replay(message(tool, input));
  expect(h.workflow.steps[0]).toMatchObject({ kind: "ai", deterministic: false });
  expect(h.result).toMatchObject({ ok: true, status: "needs_input", requiresInput: { type: "ai_step" } });
  const handed = runText(h.result);
  for (const value of text) expect(handed).toContain(value);
  expect(existsSync(join(h.root, "complete.txt"))).toBe(false);
  await h.resume();
});

it.each([80, 6_144])("hands a completed %i-byte Codex patch to AI, retaining its context when the preview is complete", async (bytes) => {
  const root = folder();
  const cli = fileURLToPath(new URL("../testing/fake-codex-app-server.ts", import.meta.url));
  chmodSync(cli, 0o755);
  const instance = await CodexDriver.create({
    instanceId: "file-edit-context", displayName: "Fixture", enabled: true, config: { cli, fullAuto: false },
    environment: { HOME: root, CODEX_HOME: join(root, ".codex"), FAKE_CODEX_PATCH_BYTES: String(bytes) },
  });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "file-edit-context", text: "build the page", cwd: root });
    await recorder.until((event) => event.type === "turn.completed");
    const start = recorder.events.find((event) => event.type === "item.started" && event.itemId === "p1");
    const end = recorder.events.find((event) => event.type === "item.completed" && event.itemId === "p1");
    if (start?.type !== "item.started" || end?.type !== "item.completed" || end.itemType !== "tool") throw new Error("missing patch events");
    expect(start.title).toBe("edit");
    expect(start.input).toBeUndefined();
    expect(end.ok).toBe(true);
    const h = await replay({ id: "patch", role: "bot", kind: "activity", tool: { name: start.title!, itemId: start.itemId, input: start.input, output: end.output, ok: end.ok } });
    expect(h.result).toMatchObject({ status: "needs_input", requiresInput: { type: "ai_step" } });
    if (bytes === 80) {
      expect(runText(h.result)).toContain("web/index.html");
      expect(runText(h.result)).toContain("+".repeat(bytes));
    } else {
      expect(end.output).toContain("[… preview shortened]");
      expect(h.workflow.steps[0]).toMatchObject({ kind: "ai", prompt: "Do this step again: Edit files." });
    }
    expect(existsSync(join(h.root, "complete.txt"))).toBe(false);
    await h.resume();
  } finally {
    recorder.stop();
    await instance.dispose();
  }
});

it("keeps secrets out of saved edit instructions", async () => {
  const h = await replay(message("Edit", { file_path: "settings.env", old_string: "API_KEY=old-fixture-secret", new_string: "API_KEY=new-fixture-secret" }));
  expect(JSON.stringify(h.workflow)).not.toContain("fixture-secret");
  expect(runText(h.result)).not.toContain("fixture-secret");
  expect(h.result).toMatchObject({ status: "needs_input", requiresInput: { type: "ai_step" } });
});

it("keeps a complete Write deterministic and does not hand it to AI", async () => {
  const h = await replay(message("Write", { file_path: "notes.txt", content: "saved contents" }));
  expect(h.workflow.steps[0]).toMatchObject({ kind: "file", path: "notes.txt", content: "saved contents" });
  expect(h.result).toMatchObject({ ok: true, status: "ok" });
  expect(readFileSync(join(h.root, "notes.txt"), "utf8")).toBe("saved contents");
  expect(readFileSync(join(h.root, "complete.txt"), "utf8")).toBe("complete");
});
