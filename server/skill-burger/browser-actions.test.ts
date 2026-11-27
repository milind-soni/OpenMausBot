import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { draftWorkflow } from "../../shared/skill-burger/draft.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { parseToolCall } from "../browser/tools.ts";
import { createExecutors } from "./executors.ts";
import { createRunStates } from "./run-state.ts";
import { resumeRun, startRun, type RunDeps } from "./runner.ts";
import { readWorkflowSkill, saveWorkflowSkill } from "./store.ts";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

const activity = (id: string, name: string, args: unknown): RunMessage => ({
  id, role: "bot", kind: "activity", tool: { name, ok: true, input: JSON.stringify(args) },
});
const browser = (id: string, name: string, args: unknown) => activity(id, `mcp__browser__${name}`, args);
const observations = [
  browser("snapshot", "agent_browser_snapshot", {}),
  browser("tabs", "agent_browser_tabs", { action: "list" }),
  browser("read", "agent_browser_read", {}),
  browser("status", "agent_browser_status", {}),
];

function savedRun(actions: RunMessage[]) {
  const root = mkdtempSync(join(tmpdir(), "burger-browser-actions-"));
  folders.push(root);
  const messages: RunMessage[] = [
    { id: "ask", role: "user", kind: "text", text: "Update the form and keep a completion note" },
    browser("open", "agent_browser_open", { url: "https://example.test/form" }),
    ...observations, ...actions,
    activity("note", "Write", { file_path: "done.txt", content: "finished" }),
  ];
  const draft = draftWorkflow(messages)!;
  const name = "browser-actions", botId = "browser-actions-bot";
  const saved = saveWorkflowSkill({ root, name, origin: botId, botIds: [botId], workflow: draft.workflow });
  if ("error" in saved) throw new Error(saved.error);
  const found = readWorkflowSkill(name, root)!;
  const opened: unknown[] = [];
  const deps: RunDeps = {
    exec: createExecutors({ botId, cwd: root, internal: async (kind, path, body) => {
      expect(kind).toBe("browser");
      expect(path).toBe("/api/internal/browser/mcp");
      opened.push(body);
      return { ok: true, body: { result: { content: [{ type: "text", text: "Opened the fixture form." }] } } };
    } }),
    save: (state) => createRunStates(join(root, "runs")).save(state),
    events: { started: () => {}, ended: () => {} },
  };
  return {
    workflow: found.workflow, opened,
    start: () => startRun({ name, botId, threadId: "form-thread", sha256: saved.sha256, workflow: found.workflow }, deps),
    resume: (id: string) => resumeRun(createRunStates(join(root, "runs")).take(id, botId)!, "Completed the requested browser action.", deps),
    noted: () => existsSync(join(root, "done.txt")),
    note: () => readFileSync(join(root, "done.txt"), "utf8"),
  };
}

it.each([
  ["agent_browser_check", { selector: "#include-tax" }],
  ["agent_browser_check", { selector: "#include-tax", checked: false }],
  ["agent_browser_tabs", { action: "new", url: "https://example.test/review" }],
  ["agent_browser_tabs", { action: "switch", tab: "t2" }],
  ["agent_browser_tabs", { action: "close", tab: "t2" }],
  ["agent_browser_close", {}],
  ["agent_browser_uncheck", { selector: "#include-tax" }],
] as const)("keeps %s %j for the bot to repeat before the run continues", async (name, args) => {
  expect(parseToolCall(name, args).ok).toBe(true);
  const h = savedRun([browser("change", name, args)]);
  const paused = await h.start();
  expect(paused).toMatchObject({ status: "needs_input", requiresInput: { type: "ai_step", prompt: expect.stringContaining(`${name} with ${JSON.stringify(args)}`) } });
  expect(h.noted()).toBe(false);
  expect(h.workflow.steps.map((step) => step.kind)).toEqual(["browser", "ai", "file"]);
  expect(await h.resume(paused.run)).toMatchObject({ status: "ok" });
  expect(h.note()).toBe("finished");
  expect(h.opened).toEqual([expect.objectContaining({ params: { name: "agent_browser_open", arguments: { url: "https://example.test/form" } } })]);
});

it("hands a checkbox change back before the recorded submit click", async () => {
  const h = savedRun([
    browser("checkbox", "agent_browser_check", { selector: "#include-tax", checked: true }),
    browser("submit", "agent_browser_click", { selector: "#save" }),
  ]);
  const checkbox = await h.start();
  expect(checkbox.requiresInput?.prompt).toContain('agent_browser_check with {"selector":"#include-tax","checked":true}');
  expect(h.noted()).toBe(false);
  const submit = await h.resume(checkbox.run);
  expect(submit.requiresInput?.prompt).toContain('agent_browser_click with {"selector":"#save"}');
  expect(h.noted()).toBe(false);
  expect(await h.resume(submit.run)).toMatchObject({ status: "ok" });
  expect(h.note()).toBe("finished");
});

it("leaves observations, including both tab-list forms, out of a replay", async () => {
  const h = savedRun([browser("old-tabs", "agent_browser_tab_list", {})]);
  expect(await h.start()).toMatchObject({ status: "ok" });
  expect(h.workflow.steps.map((step) => step.kind)).toEqual(["browser", "file"]);
  expect(h.note()).toBe("finished");
});

it.each([
  ["agent_browser_tabs", { action: "list" }],
  ["agent_browser_tab_list", {}],
] as const)("writes a fresh summary after observing only %s", async (name, args) => {
  const root = mkdtempSync(join(tmpdir(), "burger-tab-summary-"));
  folders.push(root);
  const example = "The old browser session has several documentation tabs open. ".repeat(4);
  const draft = draftWorkflow([
    { id: "ask", role: "user", kind: "text", text: "List the open tabs and save a short summary" },
    browser("tabs", name, args),
    activity("summary", "Write", { file_path: "summary.txt", content: example }),
    activity("done", "Write", { file_path: "done.txt", content: "finished" }),
  ])!;
  const saved = saveWorkflowSkill({ root, name: "tab-summary", origin: "lead", botIds: ["lead"], workflow: draft.workflow });
  if ("error" in saved) throw new Error(saved.error);
  const found = readWorkflowSkill("tab-summary", root)!;
  const states = join(root, "states");
  const deps: RunDeps = {
    exec: createExecutors({ botId: "lead", cwd: root, internal: async () => { throw new Error("the observation is repeated by the handed AI step"); } }),
    save: (state) => createRunStates(states).save(state), events: { started() {}, ended() {} },
  };
  const first = await startRun({ name: "tab-summary", botId: "lead", threadId: "tabs", sha256: saved.sha256, workflow: found.workflow }, deps);
  expect(first.requiresInput).toMatchObject({ type: "ai_step", example, prompt: expect.stringContaining("what you read or look at now") });
  expect(existsSync(join(root, "summary.txt"))).toBe(false);
  const state = createRunStates(states).take(first.run, "lead")!;
  expect(await resumeRun(state, "Only the current support tab remains open.", deps)).toMatchObject({ status: "ok" });
  expect(readFileSync(join(root, "summary.txt"), "utf8")).toBe("Only the current support tab remains open.");
  expect(readFileSync(join(root, "done.txt"), "utf8")).toBe("finished");
});
