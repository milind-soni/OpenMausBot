import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { draftWorkflow } from "../../shared/skill-burger/draft.ts";
import { applyChoices, draftView } from "../../shared/skill-burger/draft-view.ts";
import { workflowSchema } from "../../shared/skill-burger/format.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { resumeRun, startRun, type RunDeps, type RunState } from "./runner.ts";
import { readWorkflowSkill, saveWorkflowSkill } from "./store.ts";

const call = (id: string, slug: string, args: unknown, output?: unknown): RunMessage => ({
  id, role: "bot", kind: "activity",
  tool: {
    name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", ok: true,
    input: JSON.stringify({ tools: [{ tool_slug: slug, arguments: args }] }),
    ...(output === undefined ? {} : { output: JSON.stringify(output) }),
  },
});

const messages: RunMessage[] = [
  { id: "ask", role: "user", kind: "text", text: "Summarise the results in Slack" },
  call("read", "GOOGLESHEETS_BATCH_GET", { spreadsheet_id: "sales-sheet" }, { data: { values: [["North", 1000]] } }),
  call("post", "SLACK_SEND_MESSAGE", {
    channel: "C123456",
    text: "Quarterly sales summary for the team. ".repeat(8),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "Detailed regional performance and next steps. ".repeat(8) } }],
  }),
];

it("saves a run with separate composed fields in one app call", () => {
  const root = mkdtempSync(join(tmpdir(), "burger-composed-"));
  try {
    const draft = draftWorkflow(messages)!;
    expect(workflowSchema.safeParse(draft.workflow).success).toBe(true);
    const writers = draft.workflow.steps.filter((step) => step.kind === "ai");
    expect(writers).toHaveLength(2);
    expect(new Set(writers.map((step) => step.id)).size).toBe(2);
    expect(writers[0]!.id).toBe("s2_write");
    const post = draft.workflow.steps.at(-1)!;
    expect(post.kind === "app" && post.args).toMatchObject({
      text: { $step: writers[0]!.id },
      blocks: [{ text: { text: { $step: writers[1]!.id } } }],
    });
    const saved = saveWorkflowSkill({ workflow: draft.workflow, root, botIds: [] });
    expect(saved).not.toHaveProperty("error");
    if ("error" in saved) throw new Error(saved.error);
    expect(readWorkflowSkill(saved.name, root)?.workflow).toEqual(draft.workflow);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("resumes each composed field separately and delivers both results to the app", async () => {
  const workflow = draftWorkflow(messages)!.workflow;
  const saved: RunState[] = [];
  const posts: Record<string, unknown>[] = [];
  const unexpected = async () => { throw new Error("unexpected executor"); };
  const deps: RunDeps = {
    exec: {
      app: async ({ tool, args }) => {
        if (tool === "SLACK_SEND_MESSAGE") posts.push(args);
        return { ok: true, output: tool === "GOOGLESHEETS_BATCH_GET" ? { rows: [["North", 2000]] } : { sent: true } };
      },
      shell: unexpected, file: unexpected, browser: unexpected,
    },
    events: { started() {}, ended() {} },
    save: (state) => saved.push(structuredClone(state)),
  };
  const first = await startRun({ name: "sales", botId: "b", threadId: "t", sha256: "test", workflow }, deps);
  expect(first).toMatchObject({ status: "needs_input", requiresInput: { type: "ai_step", step: "s2_write" } });
  const second = await resumeRun(saved.shift()!, "New plain-text summary", deps);
  expect(second).toMatchObject({ status: "needs_input", requiresInput: { type: "ai_step" } });
  expect(second.requiresInput!.step).not.toBe(first.requiresInput!.step);
  expect(posts).toEqual([]);
  const done = await resumeRun(saved.shift()!, "New block summary", deps);
  expect(done).toMatchObject({ ok: true, status: "ok" });
  expect(posts).toEqual([{
    channel: "C123456", text: "New plain-text summary",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "New block summary" } }],
  }]);
});

it("leaves out every composed field when its app step is removed", () => {
  const chosen = applyChoices(draftWorkflow(messages)!.workflow, { skip: ["s2"] });
  expect(chosen).not.toHaveProperty("error");
  if ("error" in chosen) throw new Error(chosen.error);
  expect(chosen.steps.map((step) => step.id)).toEqual(["s1"]);
  expect(workflowSchema.safeParse(chosen).success).toBe(true);
});

it("counts a retried app call once instead of on each composed field", () => {
  const post = messages.at(-1)!;
  const retried = [...messages.slice(0, -1), { ...post, id: "failed", tool: { ...post.tool!, ok: false } }, post];
  const draft = draftWorkflow(retried)!;
  const view = draftView(draft.workflow, draft.layers, retried);
  expect(view.steps.at(-1)).toMatchObject({ id: "s2", tries: 1 });
  for (const step of view.steps.filter((step) => step.kind === "ai")) expect(step.tries).toBeUndefined();
});
