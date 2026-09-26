import { expect, it } from "vitest";
import { promptDifference, promptInput } from "./prompt-inspector";
import type { PromptCapture } from "../../shared/prompt-inspector";
const record = (kind: PromptCapture["kind"], body: unknown) => ({ kind, body }) as PromptCapture;
it("keeps model input separate from request metadata", () => {
  expect(promptInput(record("api-request", { model: "fixture", messages: [{ role: "user", content: "hello" }], tools: [], temperature: 1 }))).toEqual({ messages: [{ role: "user", content: "hello" }], tools: [] });
  expect(promptInput(record("agent-input", { system: "instructions", text: "hello", threadId: "id", effort: "low" }))).toEqual({ system: "instructions", text: "hello" });
});
it("shows the earliest changed line without claiming a cache breakpoint", () => {
  expect(promptDifference("one\ntwo\nend", "one\nthree\nend")).toBe("First changed line: 2\n- two\n+ three");
  expect(promptDifference("same", "same")).toBe("No changes in this view.");
});
