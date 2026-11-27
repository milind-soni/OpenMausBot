import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { draftWorkflow } from "../../shared/skill-burger/draft.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { peerDeliveryReceipt } from "../peer-delivery.ts";
import { RuntimeCoordinator } from "../runtime-coordinator.ts";
import { createExecutors } from "./executors.ts";
import { createRunStates } from "./run-state.ts";
import { resumeRun, startRun, type RunDeps, type RunEnvelope } from "./runner.ts";
import { readWorkflowSkill, saveWorkflowSkill } from "./store.ts";

const roots: string[] = [];
const coordinators: RuntimeCoordinator[] = [];
afterEach(() => {
  coordinators.splice(0).forEach((coordinator) => coordinator.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

async function recordedRun(bot: { id: string; name: string; title?: string }, review = false) {
  const root = mkdtempSync(join(tmpdir(), "burger-delegation-output-"));
  roots.push(root);
  const oldReply = "The recorded inspection is complete.";
  const messages: RunMessage[] = [
    { id: "ask", role: "user", kind: "text", text: "Ask Kiwi to inspect the report and save the answer" },
    { id: "delegate", role: "bot", kind: "activity", tool: {
      name: "mcp__agents__coordinate_bots", ok: true,
      input: JSON.stringify({ bot_ids: ["kiwi"], message: "Inspect the current report." }),
      output: JSON.stringify({ receipts: [{ botId: "kiwi", botName: "Kiwi", requestId: "recorded-request" }] }),
    } },
    { id: "reply", role: "bot", kind: "activity", from: { botId: "kiwi", name: "Kiwi" },
      roomRequest: { id: "recorded-request", phase: "result" }, tool: { name: "Kiwi replied", ok: true, output: oldReply } },
    { id: "write", role: "bot", kind: "activity", tool: {
      name: "Write", ok: true, input: JSON.stringify({ file_path: "report.txt", content: oldReply }),
    } },
  ];
  const draft = draftWorkflow(messages, { teammate: () => ({ id: "kiwi", name: "Kiwi", role: "Inspector" }) })!;
  expect(draft.workflow.steps[1]).toMatchObject({ kind: "file", content: { $step: "s1", path: "replies.Kiwi" } });
  if (review && draft.workflow.steps[0]?.kind === "delegate") draft.workflow.steps[0].review = { rounds: 1 };
  const saved = saveWorkflowSkill({ root, name: "inspection", origin: "lead", botIds: ["lead"], workflow: draft.workflow });
  if ("error" in saved) throw new Error(saved.error);
  const found = readWorkflowSkill("inspection", root)!;
  const stateDir = join(root, "states");
  const sent: Array<{ botIds: string[]; message: string; rework?: boolean }> = [];
  const completed = new Map<string, () => void>();
  const replies = new Map<string, string>();
  const coordinator = new RuntimeCoordinator({
    dataDir: ":memory:", log() {},
    host: {
      validate: () => undefined, busy: () => false, changed() {}, park() {},
      names: () => ({ requester: "Lead", assignee: bot.name }),
      levelOf: () => ({ level: "ask" }), chiefOf: () => false,
      run: async (node) => ({ ok: true, text: replies.get(node.id)! }),
      report: (child) => completed.get(child.id)?.(),
    },
  });
  coordinators.push(coordinator);
  const source = { botId: "lead", threadId: "inspection-thread" };
  coordinator.beginTurn({ id: "generation", address: source, brief: "Inspect the report", level: "ask", origin: { kind: "user", request: "Inspect the report" } });
  const deps: RunDeps = {
    exec: createExecutors({ botId: "lead", cwd: root, async internal(kind, path, body) {
      expect(kind).toBe("agents");
      if (path.startsWith("/api/internal/agents?")) return { ok: true, body: { bots: [bot] } };
      if (path.startsWith("/api/internal/assignment-status?")) {
        const node = coordinator.node(new URL(path, "http://localhost").searchParams.get("id")!);
        expect(node).toBeDefined();
        return { ok: true, body: { assignment: { status: node!.status, result: node!.result } } };
      }
      expect(path).toBe("/api/internal/coordinate-bots");
      const call = body as { botIds: string[]; message: string; rework?: boolean };
      sent.push(call);
      expect(call.botIds).toEqual([bot.id]);
      const { node, duplicate } = coordinator.enqueue(source, "generation", undefined, { botId: bot.id, threadId: `${bot.id}-work` }, call.message, { rework: call.rework });
      expect(duplicate).toBe(false);
      replies.set(node.id, `${bot.name}: ${call.rework ? "corrected" : "current"} inspection (${node.id})`);
      const done = new Promise<void>((resolve) => completed.set(node.id, resolve));
      coordinator.tick();
      await done;
      return { ok: true, body: { receipts: [peerDeliveryReceipt({ botId: bot.id, botName: bot.name, requestId: node.id, outcome: "queued", detail: "sent" })] } };
    } }),
    events: { started() {}, ended() {} },
    save: (state) => createRunStates(stateDir).save(state),
  };
  const first = await startRun({ name: "inspection", ...source, sha256: saved.sha256, workflow: found.workflow }, deps);
  return {
    first, sent,
    resume: (envelope: RunEnvelope, response: string) => {
      const state = createRunStates(stateDir).take(envelope.run, "lead");
      expect(state).not.toBeNull();
      return resumeRun(state!, response, deps);
    },
    noted: () => existsSync(join(root, "report.txt")),
    note: () => readFileSync(join(root, "report.txt"), "utf8"),
  };
}

it.each([
  ["renamed by the same id", { id: "kiwi", name: "Ada" }, false],
  ["replaced by role", { id: "ada", name: "Ada", title: "Inspector" }, false],
  ["picked after the saved bot is gone", { id: "ada", name: "Ada" }, true],
  ["unchanged", { id: "kiwi", name: "Kiwi" }, false],
] as const)("pipes the saved part's reply into the file when its teammate is %s", async (_case, bot, pick) => {
  const h = await recordedRun(bot);
  let paused = h.first;
  if (pick) {
    expect(paused.requiresInput?.type).toBe("missing_bot");
    expect(h.sent).toHaveLength(0);
    paused = await h.resume(paused, "Ada");
  }
  expect(paused.requiresInput?.type).toBe("teammates");
  expect(h.noted()).toBe(false);
  expect(await h.resume(paused, "back")).toMatchObject({ ok: true, status: "ok" });
  expect(h.note()).toMatch(new RegExp(`^${bot.name}: current inspection \\(`));
  expect(h.note()).not.toContain("recorded inspection");
  expect(h.sent).toHaveLength(1);
});

it("keeps the original output reference after reviewing the replacement's reply", async () => {
  const h = await recordedRun({ id: "ada", name: "Ada", title: "Inspector" }, true);
  const review = await h.resume(h.first, "back");
  expect(review.requiresInput).toMatchObject({ type: "review", input: expect.stringContaining("## Ada (for Kiwi)") });
  const retry = await h.resume(review, '{"redo":{"Ada":"Inspect the source once more"}}');
  expect(retry.requiresInput?.type).toBe("teammates");
  expect(h.sent).toHaveLength(2);
  expect(h.sent[1]).toMatchObject({ botIds: ["ada"], rework: true });
  expect(h.noted()).toBe(false);
  expect(await h.resume(retry, "back")).toMatchObject({ ok: true, status: "ok" });
  expect(h.note()).toMatch(/^Ada: corrected inspection \(/);
});
