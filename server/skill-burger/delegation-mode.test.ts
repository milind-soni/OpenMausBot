import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { draftWorkflow } from "../../shared/skill-burger/draft.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { peerDeliveryReceipt } from "../peer-delivery.ts";
import { RuntimeCoordinator } from "../runtime-coordinator.ts";
import { createExecutors } from "./executors.ts";
import { createRunStates } from "./run-state.ts";
import { resumeRun, startRun, type RunDeps } from "./runner.ts";
import { readWorkflowSkill, saveWorkflowSkill } from "./store.ts";

const roots: string[] = [];
const coordinators: RuntimeCoordinator[] = [];
afterEach(() => {
  coordinators.splice(0).forEach((coordinator) => coordinator.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

it.each([
  { name: "advice followed by work on the same teammate", modes: [true, false], parallel: false, same: true },
  { name: "work followed by advice on the same teammate", modes: [false, true], parallel: false, same: true },
  { name: "advice and work sent before either reply", modes: [true, false], parallel: true, same: false },
  { name: "two work requests sent together", modes: [false, false], parallel: true, same: false },
  { name: "two advice requests sent together", modes: [true, true], parallel: true, same: false },
])("preserves the recorded mode for $name", async ({ modes, parallel, same }) => {
  const root = mkdtempSync(join(tmpdir(), "burger-delegation-mode-"));
  roots.push(root);
  const bots = [{ id: "kiwi", name: "Kiwi" }, { id: "rio", name: "Rio" }];
  const requests = modes.map((consult, index) => ({
    bot: bots[same ? 0 : index]!, consult, id: `request-${index}`,
    message: consult ? "Review the report's outline and offer advice." : "Write the report's artifact.",
  }));
  const call = (index: number): RunMessage => {
    const { bot, consult, id, message } = requests[index]!;
    return { id: `call-${index}`, role: "bot", kind: "activity", tool: {
      name: "mcp__agents__coordinate_bots", ok: true,
      input: JSON.stringify({ bot_ids: [bot.id], message, ...(consult ? { consult: true } : {}) }),
      output: JSON.stringify({ receipts: [{ botId: bot.id, botName: bot.name, requestId: id }] }),
    } };
  };
  const reply = (index: number): RunMessage => {
    const { bot, consult, id, message } = requests[index]!;
    return { id: `reply-${index}`, role: "bot", kind: "activity", from: { botId: bot.id, name: bot.name },
      roomRequest: { id, phase: "result" }, tool: { name: `${bot.name} replied`, ok: true, output: `${consult ? "consult" : "work"}: recorded ${message}` },
    };
  };
  const last = requests[1]!;
  const messages: RunMessage[] = [
    { id: "ask", role: "user", kind: "text", text: "Keep the requested work and advice, then save the final answer." },
    ...(parallel ? [call(0), call(1), reply(0), reply(1)] : [call(0), reply(0), call(1), reply(1)]),
    { id: "file", role: "bot", kind: "activity", tool: { name: "Write", ok: true, input: JSON.stringify({ file_path: "answer.txt", content: `${last.consult ? "consult" : "work"}: recorded ${last.message}` }) } },
  ];
  const drafted = draftWorkflow(messages)!;
  const saved = saveWorkflowSkill({ root, name: "work-and-advice", origin: "lead", botIds: ["lead"], workflow: drafted.workflow });
  if ("error" in saved) throw new Error(saved.error);
  const workflow = readWorkflowSkill(saved.name, root)!.workflow;
  const completed = new Map<string, () => void>();
  const received: Array<{ bot: string; mode: string; message: string; envelope: string }> = [];
  const coordinator = new RuntimeCoordinator({ dataDir: ":memory:", log() {}, host: {
    validate: () => undefined, busy: () => false, changed() {}, park() {},
    names: (node) => ({ requester: "Lead", assignee: bots.find((bot) => bot.id === node.botId)?.name ?? "Lead" }),
    levelOf: () => ({ level: "ask" }), chiefOf: () => false,
    run: async (node, _resumed, _signal, composed) => {
      received.push({ bot: node.botId, mode: node.mode, message: node.text, envelope: composed.text });
      if (node.mode === "work") writeFileSync(join(root, `${node.botId}.artifact`), node.text);
      return { ok: true, text: `${node.mode}: current ${node.text}` };
    },
    report: (child) => completed.get(child.id)?.(),
  } });
  coordinators.push(coordinator);
  const source = { botId: "lead", threadId: "report-thread" };
  coordinator.beginTurn({ id: "generation", address: source, brief: "Get work and advice", level: "ask", origin: { kind: "user", request: "Get work and advice" } });
  const stateDir = join(root, "states");
  const deps: RunDeps = {
    exec: createExecutors({ botId: "lead", cwd: root, async internal(kind, path, body) {
      expect(kind).toBe("agents");
      if (path.startsWith("/api/internal/agents?")) return { ok: true, body: { bots } };
      if (path.startsWith("/api/internal/assignment-status?")) {
        const node = coordinator.node(new URL(path, "http://localhost").searchParams.get("id")!);
        return { ok: true, body: { assignment: { status: node!.status, result: node!.result } } };
      }
      expect(path).toBe("/api/internal/coordinate-bots");
      const input = body as { botIds: string[]; message: string; rework?: boolean; consult?: boolean };
      const pending: Promise<void>[] = [];
      const receipts = input.botIds.map((id) => {
        const { node, duplicate } = coordinator.enqueue(source, "generation", undefined, { botId: id, threadId: `${id}-work` }, input.message, { rework: input.rework, mode: input.consult ? "consult" : "work" });
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
  let envelope = await startRun({ name: saved.name, ...source, sha256: saved.sha256, workflow }, deps);
  for (let resumes = 0; envelope.status === "needs_input" && resumes < 6; resumes += 1) {
    const state = createRunStates(stateDir).take(envelope.run, "lead");
    expect(state).not.toBeNull();
    envelope = await resumeRun(state!, envelope.requiresInput?.type === "review" ? '{"redo":{}}' : "back", deps);
  }
  expect(envelope).toMatchObject({ ok: true, status: "ok" });
  expect(readFileSync(join(root, "answer.txt"), "utf8")).toBe(`${last.consult ? "consult" : "work"}: current ${last.message}`);
  expect(received.map(({ bot, mode, message }) => ({ bot, mode, message }))).toEqual(requests.map((request) => ({ bot: request.bot.id, mode: request.consult ? "consult" : "work", message: request.message })));
  expect(received.map(({ envelope }) => envelope.includes("asks a question; nobody is handing you work."))).toEqual(modes);
  for (const bot of bots) {
    const work = requests.find((request) => request.bot.id === bot.id && !request.consult);
    expect(existsSync(join(root, `${bot.id}.artifact`))).toBe(Boolean(work));
    if (work) expect(readFileSync(join(root, `${bot.id}.artifact`), "utf8")).toBe(work.message);
  }
  expect(workflow.steps.filter((step) => step.kind === "delegate")).toHaveLength(modes[0] === modes[1] ? 1 : 2);
});
