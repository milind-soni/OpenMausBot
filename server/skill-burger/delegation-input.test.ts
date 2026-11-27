import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { draftWorkflow } from "../../shared/skill-burger/draft.ts";
import { applyChoices } from "../../shared/skill-burger/draft-view.ts";
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

const OLD = "Inspect the recorded figures for Monday's warehouse report.";
const CURRENT = "Inspect the current figures for Tuesday's warehouse report.";
const LITERAL = "Write a separate introduction for the report.";
const bots = [{ id: "analyst", name: "Analyst" }, { id: "writer", name: "Writer" }, { id: "editor", name: "Editor" }];

async function recordedRun(options: { literal?: boolean; pair?: boolean; review?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "burger-delegation-input-"));
  roots.push(root);
  let n = 0;
  const call = (ids: string[], message: string, request: string, doneWhen?: string): RunMessage => ({
    id: `call-${++n}`, role: "bot", kind: "activity", tool: {
      name: "mcp__agents__coordinate_bots", ok: true,
      input: JSON.stringify({ bot_ids: ids, message, ...(doneWhen ? { done_when: doneWhen } : {}) }),
      output: JSON.stringify({ receipts: ids.map((id) => ({ botId: id, botName: bots.find((bot) => bot.id === id)!.name, requestId: `${request}-${id}` })) }),
    },
  });
  const reply = (id: string, request: string, output: string): RunMessage => ({
    id: `reply-${++n}`, role: "bot", kind: "activity", from: { botId: id, name: bots.find((bot) => bot.id === id)!.name },
    roomRequest: { id: `${request}-${id}`, phase: "result" }, tool: { name: `${id} replied`, ok: true, output },
  });
  const writers = options.pair ? ["writer", "editor"] : ["writer"];
  const messages: RunMessage[] = [
    { id: "ask", role: "user", kind: "text", text: "Ask Analyst for the current checklist, send it to Writer, then save the result." },
    call(["analyst"], "Prepare the checklist for the current report.", "first"),
    reply("analyst", "first", OLD),
    call(writers, options.literal ? LITERAL : OLD, "second", options.review ? "Every item is covered" : undefined),
    ...writers.map((id) => reply(id, "second", `${id}: the recorded deliverable`)),
    { id: "file", role: "bot", kind: "activity", tool: { name: "Write", ok: true, input: JSON.stringify({ file_path: "report.txt", content: "writer: the recorded deliverable" }) } },
  ];
  const draft = draftWorkflow(messages)!;
  expect(draft.workflow.steps.map((step) => step.kind)).toEqual(["delegate", "delegate", "file"]);
  const saved = saveWorkflowSkill({ root, name: "report-chain", origin: "lead", botIds: ["lead"], workflow: draft.workflow });
  if ("error" in saved) throw new Error(saved.error);
  const found = readWorkflowSkill(saved.name, root)!;
  const completed = new Map<string, () => void>();
  const briefs: Array<{ bot: string; message: string }> = [];
  const sent: Array<{ botIds: string[]; message: string; rework?: boolean }> = [];
  const coordinator = new RuntimeCoordinator({ dataDir: ":memory:", log() {}, host: {
    validate: () => undefined, busy: () => false, changed() {}, park() {},
    names: (node) => ({ requester: "Lead", assignee: bots.find((bot) => bot.id === node.botId)?.name ?? "Lead" }),
    levelOf: () => ({ level: "ask" }), chiefOf: () => false,
    run: async (node) => {
      const bot = node.botId;
      briefs.push({ bot, message: node.text });
      return { ok: true, text: bot === "analyst" ? CURRENT : `${bot}: ${node.text}` };
    },
    report: (child) => completed.get(child.id)?.(),
  } });
  coordinators.push(coordinator);
  const source = { botId: "lead", threadId: "report-thread" };
  coordinator.beginTurn({ id: "generation", address: source, brief: "Prepare the current report", level: "ask", origin: { kind: "user", request: "Prepare the current report" } });
  const stateDir = join(root, "states");
  const deps: RunDeps = {
    exec: createExecutors({ botId: "lead", cwd: root, async internal(kind, path, body) {
      expect(kind).toBe("agents");
      if (path.startsWith("/api/internal/agents?")) return { ok: true, body: { bots } };
      if (path.startsWith("/api/internal/assignment-status?")) {
        const node = coordinator.node(new URL(path, "http://localhost").searchParams.get("id")!);
        expect(node).toBeDefined();
        return { ok: true, body: { assignment: { status: node!.status, result: node!.result } } };
      }
      expect(path).toBe("/api/internal/coordinate-bots");
      const input = body as { botIds: string[]; message: string; rework?: boolean; done_when?: string };
      sent.push(input);
      const pending: Promise<void>[] = [];
      const receipts = input.botIds.map((id) => {
        const { node, duplicate } = coordinator.enqueue(source, "generation", undefined, { botId: id, threadId: `${id}-work` }, input.message, { rework: input.rework, doneWhen: input.done_when });
        expect(duplicate).toBe(false);
        pending.push(new Promise<void>((resolve) => completed.set(node.id, resolve)));
        return peerDeliveryReceipt({ botId: id, botName: bots.find((bot) => bot.id === id)!.name, requestId: node.id, outcome: "queued", detail: "sent" });
      });
      coordinator.tick();
      await Promise.all(pending);
      expect(receipts.map((receipt) => coordinator.node(receipt.requestId!)!.status)).toEqual(input.botIds.map(() => "completed"));
      return { ok: true, body: { receipts } };
    } }),
    events: { started() {}, ended() {} }, save: (state) => createRunStates(stateDir).save(state),
  };
  const first = await startRun({ name: saved.name, ...source, sha256: saved.sha256, workflow: found.workflow }, deps);
  return { first, briefs, sent, workflow: found.workflow,
    resume: (envelope: RunEnvelope, response: string) => {
      const state = createRunStates(stateDir).take(envelope.run, "lead");
      expect(state).not.toBeNull();
      return resumeRun(state!, response, deps);
    },
    written: () => readFileSync(join(root, "report.txt"), "utf8"),
  };
}

it.each([false, true])("passes the current upstream reply to the next delegation and its file consumer (multiple recipients: %s)", async (pair) => {
  const h = await recordedRun({ pair });
  const second = await h.resume(h.first, "back");
  expect(second.requiresInput).toMatchObject({ type: "teammates", step: "s2" });
  expect(await h.resume(second, "back")).toMatchObject({ ok: true, status: "ok" });
  expect(h.written()).toBe(`writer: ${CURRENT}`);
  expect(h.briefs.filter((call) => call.bot !== "analyst").map((call) => call.message)).toEqual(pair ? [CURRENT, CURRENT] : [CURRENT]);
  expect(applyChoices(h.workflow, { skip: ["s1"] })).toMatchObject({ error: expect.stringContaining("uses what") });
});

it("keeps a distinct literal delegation message", async () => {
  const h = await recordedRun({ literal: true });
  const second = await h.resume(h.first, "back");
  expect(h.briefs[1]).toMatchObject({ bot: "writer", message: LITERAL });
  expect(await h.resume(second, "back")).toMatchObject({ ok: true, status: "ok" });
  expect(h.written()).toBe(`writer: ${LITERAL}`);
});

it("uses the current upstream reply again when the downstream teammate is sent a review fix", async () => {
  const h = await recordedRun({ review: true });
  const second = await h.resume(h.first, "back");
  const review = await h.resume(second, "back");
  expect(review.requiresInput?.type).toBe("review");
  const rework = await h.resume(review, '{"redo":{"Writer":"Make the result shorter"}}');
  expect(await h.resume(rework, "back")).toMatchObject({ ok: true, status: "ok" });
  expect(h.written()).toContain(CURRENT);
  expect(h.written()).not.toContain(OLD);
  expect(h.briefs[2]).toEqual({ bot: "writer", message: `Make the result shorter\n\nThe work, as first asked:\n${CURRENT}` });
  expect(h.sent[2]).toMatchObject({ botIds: ["writer"], rework: true });
});
