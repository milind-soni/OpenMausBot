import { expect, it } from "vitest";
import { validateLearnedBrowserWorkflow } from "./browser-learning.ts";
import type { RecordedBrowserStep } from "./browser-replay.ts";

const url = "https://example.test/", origin = "https://example.test";
const trace: RecordedBrowserStep[] = [
  { kind: "open", url },
  { origin, url, role: "button", name: "Delete trash: Alpha", observedNames: ["Delete trash: Alpha", "Keep Beta", "Delete trash: Gamma"] },
  { origin, url, role: "button", name: "Delete trash: Gamma", observedNames: ["Keep Beta", "Delete trash: Gamma"] },
];
const candidate = { version: 1, steps: [
  { kind: "call", id: "open", tool: "MINAI_BROWSER_OPEN", input: { url } },
  { kind: "call", id: "list", tool: "MINAI_BROWSER_LIST", input: { origin, url, role: "button", prefix: "Delete trash: " } },
  { kind: "each", id: "each", from: "list.items", steps: [{ kind: "call", id: "click", tool: "MINAI_BROWSER_CLICK", input: { origin: { $ref: "item.origin" }, url: { $ref: "item.url" }, role: { $ref: "item.role" }, name: { $ref: "item.name" } } }] },
] };
it("accepts a dynamic pattern only when it reproduces the observed first run", async () => {
  const plan = await validateLearnedBrowserWorkflow(candidate, trace);
  expect(plan.steps[2]).toMatchObject({ kind: "each", from: "list.items" });
});
it("rejects a pattern that would act on an observed item the bot did not click", async () => {
  const tooBroad = structuredClone(candidate);
  tooBroad.steps[1]!.input!.prefix = "";
  await expect(validateLearnedBrowserWorkflow(tooBroad, trace)).rejects.toThrow();
  const unclicked: RecordedBrowserStep[] = [trace[0]!, { ...trace[1]!, observedNames: ["Delete trash: Alpha", "Delete trash: Other", "Delete trash: Gamma"] }, trace[2]!] as RecordedBrowserStep[];
  await expect(validateLearnedBrowserWorkflow(candidate, unclicked)).rejects.toThrow(/first run|match|incomplete/i);
});
it("does not accept a model-invented or incomplete action", async () => {
  const wrong = structuredClone(candidate);
  wrong.steps[0]!.input!.url = "https://other.test/";
  await expect(validateLearnedBrowserWorkflow(wrong, trace)).rejects.toThrow();
  await expect(validateLearnedBrowserWorkflow({ ...candidate, steps: candidate.steps.slice(0, 1) }, trace)).rejects.toThrow();
});
