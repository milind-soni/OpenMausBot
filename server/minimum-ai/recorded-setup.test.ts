import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { workflowSchemaDigest } from "./binding.ts";
import { browserWorkflowCatalog } from "./browser-workflow.ts";
import { createRunLedger } from "./ledger.ts";
import { recordBrowserWorkflow } from "./recorded-setup.ts";
import { createWorkflowStore } from "./store.ts";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function setup() {
  const folder = mkdtempSync(join(tmpdir(), "omb-recorded-setup-")); folders.push(folder);
  const store = createWorkflowStore(join(folder, "plans.json")), ledger = createRunLedger(join(folder, "runs.sqlite"));
  const binding = { owner: "owner", botId: "bot", prompt: "Run the task", connectionIds: ["browser:sample"], schemaDigest: workflowSchemaDigest(browserWorkflowCatalog) };
  return { store, ledger, binding };
}
it("records once, saves a reviewable draft and requires approval", async () => {
  const { store, ledger, binding } = setup();
  const firstRun = vi.fn(async () => [{ kind: "open" as const, url: "https://example.test/" }, { origin: "https://example.test", url: "https://example.test/", role: "button", name: "Run" }]);
  const draft = await recordBrowserWorkflow({ routineId: "routine-1", owner: "owner", store, ledger, context: async () => binding, firstRun, signal: new AbortController().signal });
  expect(firstRun).toHaveBeenCalledOnce();
  expect(draft).toMatchObject({ verified: true, approved: false });
  expect(ledger.held("routine-1")).toBe(false);
  expect(store.approve("routine-1", "owner", binding, draft.fingerprint).approved).toBe(true);
});
it("holds the automation for review if the task or browser changes during its first run", async () => {
  const { store, ledger, binding } = setup();
  let checks = 0;
  await expect(recordBrowserWorkflow({ routineId: "routine-1", owner: "owner", store, ledger, context: async () => ++checks === 1 ? binding : { ...binding, prompt: "Changed" }, firstRun: async () => [{ kind: "open", url: "https://example.test/" }, { origin: "https://example.test", url: "https://example.test/", role: "button", name: "Run" }], signal: new AbortController().signal })).rejects.toThrow(/changed/i);
  expect(ledger.held("routine-1")).toBe(true);
  expect(store.get("routine-1", "owner", binding)).toBeNull();
});
it("holds an interrupted or failed recording and prevents another first run", async () => {
  const { store, ledger, binding } = setup();
  const firstRun = vi.fn(async () => { throw new Error("Bot stopped"); });
  const args = { routineId: "routine-1", owner: "owner", store, ledger, context: async () => binding, firstRun, signal: new AbortController().signal };
  await expect(recordBrowserWorkflow(args)).rejects.toThrow("Bot stopped");
  expect(ledger.held("routine-1")).toBe(true);
  await expect(recordBrowserWorkflow(args)).rejects.toThrow(/review|interrupted/i);
  expect(firstRun).toHaveBeenCalledOnce();
});

it("saves a learned dynamic pattern only when it reproduces the recorded actions", async () => {
  const { store, ledger, binding } = setup();
  const origin = "https://example.test", url = `${origin}/`;
  const firstRun = vi.fn(async () => [
    { kind: "open" as const, url },
    { origin, url, role: "button", name: "Trash: Alpha", observedNames: ["Trash: Alpha", "Keep Beta", "Trash: Gamma"] },
    { origin, url, role: "button", name: "Trash: Gamma", observedNames: ["Keep Beta", "Trash: Gamma"] },
  ]);
  const learn = vi.fn(async () => ({ version: 1, steps: [
    { kind: "call", id: "open", tool: "MINAI_BROWSER_OPEN", input: { url } },
    { kind: "call", id: "list", tool: "MINAI_BROWSER_LIST", input: { origin, url, role: "button", prefix: "Trash: " } },
    { kind: "each", id: "each", from: "list.items", steps: [{ kind: "call", id: "click", tool: "MINAI_BROWSER_CLICK", input: { origin: { $ref: "item.origin" }, url: { $ref: "item.url" }, role: { $ref: "item.role" }, name: { $ref: "item.name" } } }] },
  ] }));
  const proposal = await recordBrowserWorkflow({ routineId: "routine-1", owner: "owner", store, ledger, context: async () => binding, firstRun, learn, signal: new AbortController().signal });
  expect(proposal.plan.steps[2]).toMatchObject({ kind: "each", from: "list.items" });
  expect(firstRun).toHaveBeenCalledOnce(); expect(learn).toHaveBeenCalledOnce();
});

it("keeps exact recorded steps if the proposed pattern would include an unclicked item", async () => {
  const { store, ledger, binding } = setup();
  const origin = "https://example.test", url = `${origin}/`;
  const firstRun = async () => [{ kind: "open" as const, url }, { origin, url, role: "button", name: "Trash: Alpha", observedNames: ["Trash: Alpha", "Trash: Other"] }];
  const learn = async () => ({ version: 1, steps: [
    { kind: "call", id: "open", tool: "MINAI_BROWSER_OPEN", input: { url } },
    { kind: "call", id: "list", tool: "MINAI_BROWSER_LIST", input: { origin, url, role: "button", prefix: "Trash: " } },
    { kind: "each", id: "each", from: "list.items", steps: [{ kind: "call", id: "click", tool: "MINAI_BROWSER_CLICK", input: { origin: { $ref: "item.origin" }, url: { $ref: "item.url" }, role: { $ref: "item.role" }, name: { $ref: "item.name" } } }] },
  ] });
  const proposal = await recordBrowserWorkflow({ routineId: "routine-1", owner: "owner", store, ledger, context: async () => binding, firstRun, learn, signal: new AbortController().signal });
  expect(proposal.plan.steps).toHaveLength(2);
  expect(proposal.plan.steps.every((step) => step.kind === "call")).toBe(true);
});
