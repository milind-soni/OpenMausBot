import { describe, expect, it } from "vitest";

import { applyDecisions, parseDecisions } from "../../shared/skill-burger/decisions.ts";
import { caseOf, workflowSchema, type Workflow } from "../../shared/skill-burger/format.ts";
import { applyEdit, editSchema } from "./edit.ts";

const base: Workflow = workflowSchema.parse({
  version: 1, summary: "Sort new email", args: {},
  steps: [
    { id: "s1", kind: "app", app: "gmail", tool: "GMAIL_FETCH_EMAILS", label: "Fetch emails", args: {} },
    { id: "s2", kind: "app", app: "slack", tool: "SLACK_SEND_MESSAGE", label: "Send message", args: {} },
  ],
});
const edit = (value: unknown) => editSchema.parse(value);

describe("changing a saved Skill Burger's steps", () => {
  it("adds a case in words: a new fork after a step, with its steps tagged for the case and their refs renumbered", () => {
    const next = applyEdit(base, edit({
      action: "add_case", decide: { after: "s1", label: "Is it support?", prompt: "Is this email a support request?", input: { $step: "s1" } }, case: "support",
      steps: [
        { id: "x", kind: "app", app: "linear", tool: "LINEAR_CREATE_ISSUE", label: "Create issue", args: { title: { $step: "s1", path: "subject" } } },
        { id: "y", kind: "app", app: "slack", tool: "SLACK_SEND_MESSAGE", label: "Tell support", args: { text: { $step: "x", path: "url" } } },
      ],
    }));
    if ("error" in next) throw new Error(next.error);
    expect(next.steps.map((step) => [step.id, step.kind, caseOf(step)?.case ?? null])).toEqual([
      ["s1", "app", null], ["d1", "decide", null], ["c1", "app", "support"], ["c2", "app", "support"], ["s2", "app", null],
    ]);
    expect(next.steps[3]).toMatchObject({ args: { text: { $step: "c1", path: "url" } } });
    expect(workflowSchema.safeParse(next).success).toBe(true);

    const more = applyEdit(next, edit({ action: "add_case", decide: { id: "d1" }, case: "sales", steps: [{ kind: "app", app: "hubspot", tool: "HUBSPOT_CREATE_DEAL", label: "Create deal", args: {} }] }));
    if ("error" in more) throw new Error(more.error);
    expect(more.steps.find((step) => step.id === "d1")).toMatchObject({ cases: ["support", "sales"] });
    expect(more.steps.map((step) => step.id)).toEqual(["s1", "d1", "c1", "c2", "c3", "s2"]);

    const fewer = applyEdit(more, edit({ action: "remove_case", decide: "d1", case: "support" }));
    if ("error" in fewer) throw new Error(fewer.error);
    expect(fewer.steps.map((step) => step.id)).toEqual(["s1", "d1", "c3", "s2"]);
    const none = applyEdit(fewer, edit({ action: "remove_case", decide: "d1", case: "sales" }));
    if ("error" in none) throw new Error(none.error);
    expect(none.steps.map((step) => step.id)).toEqual(["s1", "s2"]);
  });

  it("puts a condition on a step and takes it off, and refuses a step that can't run", () => {
    const when = { $step: "s1", path: "messages.0", op: "exists" };
    const guarded = applyEdit(base, edit({ action: "set_when", step: "s2", when }));
    expect(guarded).toMatchObject({ steps: [{ id: "s1" }, { id: "s2", when }] });
    const open = applyEdit(guarded as Workflow, edit({ action: "set_when", step: "s2", when: null }));
    expect((open as Workflow).steps[1]).not.toHaveProperty("when");
    expect(applyEdit(base, edit({ action: "add_case", decide: { after: "s1" }, case: "x", steps: [{ kind: "teleport" }] }))).toHaveProperty("error");
  });
});

describe("decisions the bot stated, made part of the saved burger", () => {
  it("turns a stated condition into a when, and a stated case into a fork with this run's steps under it", () => {
    const decisions = parseDecisions('```json\n{"conditions":[{"step":"s2","when":{"$step":"s1","path":"messages.0","op":"exists"}}],"fork":{"after":"s1","question":"Support or sales?","cases":["support","sales"],"taken":"support","steps":["s2"]}}\n```');
    const next = applyDecisions(base, decisions);
    expect(next.steps.map((step) => [step.id, step.kind])).toEqual([["s1", "app"], ["d1", "decide"], ["s2", "app"]]);
    expect(next.steps[1]).toMatchObject({ cases: ["support", "sales"], prompt: "Support or sales?" });
  });

  it("changes nothing for {} or for decisions that don't fit the steps", () => {
    expect(applyDecisions(base, parseDecisions("{}"))).toEqual(base);
    expect(applyDecisions(base, parseDecisions("not json"))).toEqual(base);
    expect(applyDecisions(base, parseDecisions('{"conditions":[{"step":"s1","when":{"$step":"s2","op":"exists"}}]}'))).toEqual(base);
    expect(applyDecisions(base, parseDecisions('{"fork":{"after":"s2","question":"?","cases":["a","b"],"taken":"a","steps":["s1"]}}'))).toEqual(base);
  });
});
