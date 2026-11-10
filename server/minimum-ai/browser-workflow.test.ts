import { expect, it, vi } from "vitest";
import { browserWorkflowCatalog, browserWorkflowFromRecording, browserWorkflowInvoker } from "./browser-workflow.ts";
import { executeWorkflow } from "./workflow.ts";
import { schemaCheckedInvoker } from "./schema-check.ts";
import type { BrowserOperation } from "./browser-workflow.ts";

it("converts a complete recording to the same workflow format used for connected apps", async () => {
  const plan = browserWorkflowFromRecording([{ kind: "open", url: "https://example.test/" }, { origin: "https://example.test", url: "https://example.test/", role: "button", name: "Run" }]);
  const perform = vi.fn(async (_step: BrowserOperation, _signal: AbortSignal) => undefined);
  const invoke = schemaCheckedInvoker(browserWorkflowCatalog, browserWorkflowInvoker(perform));
  const result = await executeWorkflow(plan, invoke);
  expect(result.status).toBe("completed");
  expect(perform.mock.calls.map(([step]) => step)).toEqual([{ kind: "open", url: "https://example.test/" }, { origin: "https://example.test", url: "https://example.test/", role: "button", name: "Run" }]);
});

it("refuses to store ambiguous or potentially secret-bearing browser addresses", () => {
  for (const url of ["https://example.test/?token=secret", "https://example.test/#secret", "https://user:password@example.test/", "file:///tmp/sample"]) {
    expect(() => browserWorkflowFromRecording([{ kind: "open", url }])).toThrow();
  }
  expect(() => browserWorkflowFromRecording([])).toThrow();
  expect(() => browserWorkflowFromRecording([{ kind: "open", url: "https://example.test/" }])).toThrow(/no.*action|click/i);
  expect(() => browserWorkflowFromRecording([{ origin: "https://other.test", url: "https://example.test/", role: "button", name: "Run" }])).toThrow();
});

it("stops immediately when the browser action fails", async () => {
  const plan = browserWorkflowFromRecording([{ kind: "open", url: "https://example.test/" }, { origin: "https://example.test", url: "https://example.test/", role: "button", name: "Run" }]);
  const perform = vi.fn(async () => { throw new Error("Browser disconnected"); });
  const result = await executeWorkflow(plan, schemaCheckedInvoker(browserWorkflowCatalog, browserWorkflowInvoker(perform)));
  expect(result.status).toBe("failed");
  expect(perform).toHaveBeenCalledOnce();
});
it("saves ordinary form fills but rejects fields that look like credentials", () => {
  const field = { kind: "fill" as const, origin: "https://example.test", url: "https://example.test/", role: "textbox", name: "Name", value: "Ada" };
  expect(browserWorkflowFromRecording([field]).steps[0]).toMatchObject({ tool: "MINAI_BROWSER_FILL" });
  expect(() => browserWorkflowFromRecording([{ ...field, name: "Password" }])).toThrow();
});
