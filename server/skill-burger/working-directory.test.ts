import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { draftWorkflow } from "../../shared/skill-burger/draft.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { createExecutors } from "./executors.ts";
import { startRun } from "./runner.ts";

const oldFolder = "/Users/ana/omb/task-workspaces/ae3a6bd7-afb4-4ad1-909b-5a7b6d887ac9/a48d8ea2-161f-4ca1-a80c-0591f3082283";
const shell = (id: string, command: string, cwd?: string): RunMessage => ({
  id, role: "bot", kind: "activity",
  tool: { name: "shell", ok: true, input: JSON.stringify({ command, ...(cwd ? { cwd } : {}) }) },
});
const recorded = (cwd: string): RunMessage[] => [
  { id: "ask", role: "user", kind: "text", text: "Prepare the report" },
  shell("mkdir", "mkdir -p project"),
  shell("write", "printf report > report.txt", cwd),
];

it.each([
  [`${oldFolder}/project`, "./project"],
  [`C:${oldFolder.replaceAll("/", "\\")}\\project`, ".\\project"],
])("preserves the subfolder in a recorded conversation cwd %s", (cwd, relative) => {
  expect(draftWorkflow(recorded(cwd!))!.workflow.steps[1]).toMatchObject({ kind: "shell", cwd: relative });
});

it.skipIf(process.platform === "win32").each(["relative", "relative-dot", "conversation", "absolute"])("replays a %s working directory in the intended folder", async (kind) => {
  const cwd = mkdtempSync(join(tmpdir(), "burger-cwd-"));
  try {
    const recordedCwd = kind === "relative" ? "project"
      : kind === "relative-dot" ? "./project"
      : kind === "conversation" ? `${oldFolder}/project`
      : join(cwd, "project");
    const workflow = draftWorkflow(recorded(recordedCwd))!.workflow;
    const result = await startRun({ name: "report", botId: "b", threadId: "t", sha256: "test", workflow }, {
      exec: createExecutors({ botId: "b", cwd, internal: async () => ({ ok: false, body: {} }) }),
      events: { started() {}, ended() {} }, save() {},
    });
    expect(result).toMatchObject({ ok: true, status: "ok" });
    expect(readFileSync(join(cwd, "project/report.txt"), "utf8")).toBe("report");
    expect(existsSync(join(cwd, "report.txt"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
