import { expect, it } from "vitest";

import { draftWorkflow } from "../../shared/skill-burger/draft.ts";
import { applyChoices } from "../../shared/skill-burger/draft-view.ts";
import { workflowSchema, type Workflow } from "../../shared/skill-burger/format.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { startRun, type RunDeps } from "./runner.ts";

const run = (workflow: Workflow, args?: Record<string, unknown>) => {
  const unexpected = async () => { throw new Error("unexpected executor"); };
  const deps: RunDeps = {
    exec: { app: async () => ({ ok: true, output: { findings: "Check navigation" } }), shell: unexpected, file: unexpected, browser: unexpected },
    events: { started() {}, ended() {} }, save() {},
  };
  return startRun({ name: "review", botId: "b", threadId: "t", sha256: "test", workflow, args }, deps);
};

it.each([undefined, "https://override.example"])("replays a renamed input in a drafted prompt with override %s", async (override) => {
  const call = (id: string, slug: string, args: unknown): RunMessage => ({
    id, role: "bot", kind: "activity",
    tool: { name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", ok: true, input: JSON.stringify({ tools: [{ tool_slug: slug, arguments: args }] }), output: '{"findings":"Check navigation"}' },
  });
  const messages: RunMessage[] = [
    { id: "ask", role: "user", kind: "text", text: "Summarise the findings for https://old.example in Slack" },
    call("read", "GOOGLESHEETS_BATCH_GET", { spreadsheet_id: "audit-sheet" }),
    call("post", "SLACK_SEND_MESSAGE", { channel: "C123456", text: "Navigation and accessibility findings for the team. ".repeat(8) }),
  ];
  const drafted = draftWorkflow(messages)!.workflow;
  expect(drafted.args.site).toMatchObject({ default: "https://old.example" });
  const chosen = applyChoices(drafted, { inputs: { site: { name: "website", value: "https://new.example" } } });
  if ("error" in chosen) throw new Error(chosen.error);
  const result = await run(workflowSchema.parse(chosen), override ? { website: override } : undefined);
  expect(result).toMatchObject({ status: "needs_input", requiresInput: { type: "ai_step" } });
  expect(result.requiresInput!.prompt).toContain(override ?? "https://new.example");
  expect(result.requiresInput!.prompt).not.toContain("{site}");
  expect(chosen.args.website).toMatchObject({ default: "https://new.example" });
});

it.each([
  { type: "ai_step", step: { kind: "ai", deterministic: false, prompt: "Review {site} with {site_name}; confirm {site}." } },
  { type: "decide", step: { kind: "decide", cases: ["pass", "fail"], prompt: "Does {site} pass {site_name}? Recheck {site}." } },
  { type: "check", step: { kind: "app", app: "sheets", tool: "GOOGLESHEETS_BATCH_GET", args: {}, check: { says: "The report for {site} includes {site_name} and {site}." } } },
])("renames only complete input placeholders in a $type handoff", async ({ type, step }) => {
  const workflow = workflowSchema.parse({
    version: 1, summary: "Review a site", args: { site: { default: "old" }, site_name: { default: "navigation" } },
    steps: [{ id: "s1", label: "Review", ...step }],
  });
  const chosen = applyChoices(workflow, { inputs: { site: { name: "website", value: "new" } } });
  if ("error" in chosen) throw new Error(chosen.error);
  const result = await run(chosen, { website: "current" });
  expect(result).toMatchObject({ status: "needs_input", requiresInput: { type } });
  expect(result.requiresInput!.prompt.match(/current/g)).toHaveLength(2);
  expect(result.requiresInput!.prompt).toContain("navigation");
  expect(result.requiresInput!.prompt).not.toContain("{site}");
  expect(chosen.args).toEqual({ website: { default: "new" }, site_name: { default: "navigation" } });
});

it("keeps literal app text while renaming references and prompt placeholders", () => {
  const workflow = workflowSchema.parse({
    version: 1, summary: "Send a template", args: { site: { default: "old" } },
    steps: [{ id: "s1", kind: "app", label: "Send", app: "slack", tool: "SLACK_SEND_MESSAGE", args: { text: "Use {site} in your template", channel: { $arg: "site" } } }],
  });
  const chosen = applyChoices(workflow, { inputs: { site: { name: "channel" } } });
  if ("error" in chosen) throw new Error(chosen.error);
  expect(chosen.steps[0]).toMatchObject({ args: { text: "Use {site} in your template", channel: { $arg: "channel" } } });
  expect(workflow.steps[0]).toMatchObject({ args: { channel: { $arg: "site" } } });
});
