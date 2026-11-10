import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createWorkflowStore } from "./store.ts";
import { browserWorkflowCatalog } from "./browser-workflow.ts";
import { workflowSchemaDigest } from "./binding.ts";

const context = { owner: "owner", botId: "bot", prompt: "Check mail", connectionIds: ["mail-account"] };
const folders: string[] = [];
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("saves a completed recorded browser run for explicit approval without repeating its actions", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-recorded-plan-")); folders.push(dir);
  const store = createWorkflowStore(join(dir, "plans.json"));
  const bound = { ...context, schemaDigest: workflowSchemaDigest(browserWorkflowCatalog) };
  const draft = store.saveRecordedBrowserDraft("routine-1", "owner", bound, [{ kind: "open", url: "https://example.test/" }, { origin: "https://example.test", url: "https://example.test/", role: "button", name: "Run", observedNames: ["Run", "Unrelated private sample"] }]);
  expect(draft).toMatchObject({ verified: true, approved: false });
  expect(readFileSync(join(dir, "plans.json"), "utf8")).not.toContain("Unrelated private sample");
  expect(store.approve("routine-1", "owner", bound, draft.fingerprint).approved).toBe(true);
  expect(() => store.get("routine-1", "owner", { ...bound, prompt: "Changed" })).toThrow(/changed/i);
  expect(() => store.saveRecordedBrowserDraft("routine-1", "owner", bound, [{ kind: "open", url: "https://example.test/?token=secret" }])).toThrow();
});
it("persists a draft and requires the same owner and revision for approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-minimum-ai-")); folders.push(dir);
  const file = join(dir, "plans.json");
  const plans = createWorkflowStore(file);
  const allowed = new Set(["MAIL_LIST"]);
  const plan = { version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] };
  const draft = plans.saveDraft("routine-1", "owner", context, plan, allowed);
  expect(draft.approved).toBe(false);
  expect(() => plans.approve("routine-1", "stranger", context, draft.fingerprint)).toThrow();
  expect(() => plans.approve("routine-1", "owner", context, "stale")).toThrow();
  await plans.verify("routine-1", "owner", context, draft.fingerprint, allowed, async () => ({}));
  expect(plans.approve("routine-1", "owner", context, draft.fingerprint).approved).toBe(true);
  const restored = createWorkflowStore(file).get("routine-1", "owner", context);
  expect(restored?.approved).toBe(true);
  expect(() => createWorkflowStore(file).get("routine-1", "stranger", context)).toThrow();
  expect(() => plans.get("routine-1", "owner", { ...context, prompt: "Delete mail" })).toThrow(/changed/i);
  expect(() => plans.get("routine-1", "owner", { ...context, botId: "other-bot" })).toThrow(/changed/i);
  expect(() => plans.get("routine-1", "owner", { ...context, connectionIds: ["other-account"] })).toThrow(/changed/i);
  const changed = plans.saveDraft("routine-1", "owner", context, { ...plan, steps: [{ ...plan.steps[0], input: { folder: "other" } }] }, allowed);
  expect(changed.approved).toBe(false);
});

it("prevents a replacement plan from being saved during testing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-stale-")); folders.push(dir);
  const store = createWorkflowStore(join(dir, "plans.json"));
  const allowed = new Set(["MAIL_LIST"]);
  const plan = { version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] };
  const draft = store.saveDraft("routine-1", "owner", context, plan, allowed);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const testing = store.verify("routine-1", "owner", context, draft.fingerprint, allowed, async () => { await gate; return {}; });
  expect(() => store.saveDraft("routine-1", "owner", context, { ...plan, steps: [{ ...plan.steps[0], input: { folder: "archive" } }] }, allowed)).toThrow(/already running/i);
  release();
  await expect(testing).resolves.toMatchObject({ status: "completed" });
  store.saveDraft("routine-1", "owner", context, { ...plan, steps: [{ ...plan.steps[0], input: { folder: "archive" } }] }, allowed);
  expect(store.get("routine-1", "owner", context)?.verified).toBe(false);
});

it("does not apply an old test to an identical replacement draft", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-replaced-")); folders.push(dir);
  const store = createWorkflowStore(join(dir, "plans.json"));
  const allowed = new Set(["MAIL_LIST"]);
  const plan = { version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] };
  const draft = store.saveDraft("routine-1", "owner", context, plan, allowed);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const testing = store.verify("routine-1", "owner", context, draft.fingerprint, allowed, async () => { await gate; return {}; });
  await expect(store.verify("routine-1", "owner", context, draft.fingerprint, allowed, async () => ({}))).rejects.toThrow(/already running/i);
  expect(() => store.saveDraft("routine-1", "owner", context, plan, allowed)).toThrow(/already running/i);
  release();
  await expect(testing).resolves.toMatchObject({ status: "completed" });
  store.saveDraft("routine-1", "owner", context, plan, allowed);
  expect(store.get("routine-1", "owner", context)?.verified).toBe(false);
});

it("does not verify a cancelled initial run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-cancel-")); folders.push(dir);
  const store = createWorkflowStore(join(dir, "plans.json"));
  const allowed = new Set(["MAIL_LIST"]);
  const draft = store.saveDraft("routine-1", "owner", context, { version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] }, allowed);
  const controller = new AbortController();
  controller.abort();
  const result = await store.verify("routine-1", "owner", context, draft.fingerprint, allowed, async () => ({}), new Set(), controller.signal);
  expect(result.status).toBe("failed");
  expect(() => store.approve("routine-1", "owner", context, draft.fingerprint)).toThrow(/successful test/i);
});

it("shares current drafts and active leases across store instances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-shared-")); folders.push(dir);
  const file = join(dir, "plans.json"), first = createWorkflowStore(file), second = createWorkflowStore(file);
  const allowed = new Set(["MAIL_LIST"]);
  const draft = first.saveDraft("routine-1", "owner", context, { version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] }, allowed);
  expect(second.get("routine-1", "owner", context)?.fingerprint).toBe(draft.fingerprint);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const testing = first.verify("routine-1", "owner", context, draft.fingerprint, allowed, async () => { await gate; return {}; });
  await expect(second.verify("routine-1", "owner", context, draft.fingerprint, allowed, async () => ({}))).rejects.toThrow(/already running/i);
  expect(() => second.saveDraft("routine-1", "owner", context, draft.plan, allowed)).toThrow(/already running/i);
  release();
  await testing;
  expect(second.get("routine-1", "owner", context)?.verified).toBe(true);
});

it("holds a dead process lease until the owner reviews the interruption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-dead-")); folders.push(dir);
  const file = join(dir, "plans.json"), store = createWorkflowStore(file), allowed = new Set(["MAIL_LIST"]);
  const draft = store.saveDraft("routine-1", "owner", context, { version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] }, allowed);
  const db = new DatabaseSync(`${file}.locks.sqlite`);
  db.prepare("INSERT INTO leases (id, token, pid) VALUES (?, ?, ?)").run("routine-1", "dead", 2_147_483_647);
  db.close();
  expect(store.get("routine-1", "owner", context)?.verified).toBe(false);
  expect(store.held("routine-1")).toBe(true);
  await expect(store.verify("routine-1", "owner", context, draft.fingerprint, allowed, async () => ({}))).rejects.toThrow(/interrupted/i);
  expect(() => store.approve("routine-1", "owner", context, draft.fingerprint)).toThrow(/successful test/i);
  expect(() => store.acknowledge("routine-1", "stranger")).toThrow(/owned/i);
  store.acknowledge("routine-1", "owner");
  expect((await store.verify("routine-1", "owner", context, draft.fingerprint, allowed, async () => ({}))).status).toBe("completed");
});

it("checks and records a failed test's hold while its cross-process lease is held", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-hold-order-")); folders.push(dir);
  const file = join(dir, "plans.json"), first = createWorkflowStore(file), second = createWorkflowStore(file);
  const allowed = new Set(["MAIL_LIST"]), draft = first.saveDraft("routine-1", "owner", context, { version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] }, allowed);
  let held = false;
  const hooks = { before: () => { if (held) throw new Error("Review required"); }, after: () => { expect(() => second.saveDraft("routine-1", "owner", context, draft.plan, allowed)).toThrow(/already running/i); held = true; } };
  const result = await first.verify("routine-1", "owner", context, draft.fingerprint, allowed, async () => { throw new Error("lost response"); }, new Set(), undefined, hooks);
  expect(result.status).toBe("failed");
  expect(held).toBe(true);
  await expect(second.verify("routine-1", "owner", context, draft.fingerprint, allowed, async () => ({}), new Set(), undefined, hooks)).rejects.toThrow(/Review required/);
});

it("records an error after a tool response before releasing the test lease", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-test-error-")); folders.push(dir);
  const file = join(dir, "plans.json"), store = createWorkflowStore(file), other = createWorkflowStore(file), allowed = new Set(["MAIL_LIST"]);
  const draft = store.saveDraft("routine-1", "owner", context, { version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] }, allowed);
  let held = false;
  await expect(store.verify("routine-1", "owner", context, draft.fingerprint, allowed, async () => ({}), new Set(), undefined, {
    after: () => { throw new Error("Could not finish recording"); },
    error: () => { expect(() => other.saveDraft("routine-1", "owner", context, draft.plan, allowed)).toThrow(/already running/i); held = true; },
  })).rejects.toThrow(/finish recording/);
  expect(held).toBe(true);
});
