import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { workflowSchema } from "../../shared/skill-burger/format.ts";
import { peerDeliveryReceipt, withTargetsHere } from "../peer-delivery.ts";
import { RuntimeCoordinator } from "../runtime-coordinator.ts";
import { createExecutors } from "./executors.ts";
import { createRunStates } from "./run-state.ts";
import { resumeRun, startRun, type RunDeps, type RunEnvelope, type RunState } from "./runner.ts";

const roots: string[] = [];
const coordinators: RuntimeCoordinator[] = [];
afterEach(() => {
  coordinators.splice(0).forEach((coordinator) => coordinator.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

async function team(phase: "initial" | "review", batched: boolean) {
  const root = mkdtempSync(join(tmpdir(), "burger-partial-delegation-"));
  roots.push(root);
  const stateDir = join(root, "states");
  const roster = [{ id: "kiwi", name: "Kiwi" }, { id: "rio", name: "Rio" }];
  const calls: Array<{ botIds: string[]; message: string; rework?: boolean }> = [];
  const accepted: Array<{ botId: string; requestId: string; rework: boolean }> = [];
  const completed = new Map<string, () => void>();
  let refuse = true;
  let reviewing = false;
  const coordinator = new RuntimeCoordinator({
    dataDir: ":memory:", log() {},
    handoffLimit: { refusal: (botId) => refuse && botId === "rio" && (phase === "initial" || reviewing) ? "Rio is at its hand-off limit" : null },
    host: {
      validate: () => undefined, busy: () => false, changed() {}, park() {},
      names: (node) => ({ requester: "Lead", assignee: node.botId }),
      levelOf: () => ({ level: "ask" }), chiefOf: () => false,
      run: async (node) => ({ ok: true, text: `${roster.find((bot) => bot.id === node.botId)!.name}: ${accepted.find((one) => one.requestId === node.id)!.rework ? "corrected" : "initial"} report (${node.id})` }),
      report: (child) => completed.get(child.id)?.(),
    },
  });
  coordinators.push(coordinator);
  const source = { botId: "lead", threadId: "t" };
  coordinator.beginTurn({ id: "gen-1", address: source, brief: "Collect reports", level: "ask", origin: { kind: "user", request: "Collect reports" } });
  const exec = createExecutors({
    botId: "lead", cwd: root,
    async internal(kind, path, body) {
      expect(kind).toBe("agents");
      if (path.startsWith("/api/internal/agents?")) return { ok: true, body: { bots: roster } };
      if (path.startsWith("/api/internal/assignment-status?")) {
        const id = new URL(path, "http://localhost").searchParams.get("id")!;
        const node = coordinator.node(id);
        expect(node).toBeDefined();
        return { ok: true, body: { assignment: { status: node!.status, result: node!.result } } };
      }
      expect(path).toBe("/api/internal/coordinate-bots");
      const call = body as { botIds: string[]; message: string; rework?: boolean };
      calls.push(call);
      reviewing ||= call.rework === true;
      const settling: Promise<void>[] = [];
      const receipts = call.botIds.map((botId) => {
        const bot = roster.find((one) => one.id === botId)!;
        try {
          const { node, duplicate } = coordinator.enqueue(source, "gen-1", undefined, { botId, threadId: `${botId}-work` }, call.message, { rework: call.rework });
          if (!duplicate) {
            accepted.push({ botId, requestId: node.id, rework: call.rework === true });
            settling.push(new Promise<void>((resolve) => completed.set(node.id, resolve)));
          }
          return peerDeliveryReceipt({
            botId, botName: bot.name, requestId: node.id,
            outcome: duplicate && node.status === "completed" ? "failed" : "queued",
            detail: duplicate && node.status === "completed" ? "not sent again: it already finished and its result stands; send it with rework=true to run it again" : "sent",
          });
        } catch (error) {
          return peerDeliveryReceipt({ botId, botName: bot.name, outcome: "failed", detail: (error as Error).message });
        }
      });
      coordinator.tick();
      await Promise.all(settling);
      const reply = await withTargetsHere(call, [], {
        receipts, refused: receipts.filter((one) => one.outcome === "failed").map((one) => one.detail), message: "Work sent",
      }, async () => { throw new Error("all target replies are already supplied"); });
      return { ok: reply.status === 200, status: reply.status, body: reply.body };
    },
  });
  const deps: RunDeps = { exec, events: { started() {}, ended() {} }, save: (state) => createRunStates(stateDir).save(state) };
  const workflow = workflowSchema.parse({
    version: 1, summary: "Collect reports", args: {}, steps: [
      {
        id: "s1", kind: "delegate", label: "Ask teammates", ...(phase === "review" ? { review: { rounds: 1 } } : {}),
        tasks: roster.map((bot) => ({ bot, message: batched ? "Inspect the report" : `Inspect ${bot.name}'s part` })),
      },
      { id: "s2", kind: "file", label: "Write final report", path: "report.txt", content: { $step: "s1", path: "text" } },
    ],
  });
  const resume = async (envelope: RunEnvelope, response: string) => {
    const token = envelope.error?.resumeToken ?? envelope.requiresInput?.resumeToken;
    expect(token).toBeTruthy();
    const state = createRunStates(stateDir).take(token!, "lead");
    expect(state).not.toBeNull();
    return resumeRun(state!, response, deps);
  };
  let stopped = await startRun({ name: "reports", botId: "lead", threadId: "t", sha256: "x", workflow }, deps);
  if (phase === "review") {
    const review = await resume(stopped, "back");
    expect(review).toMatchObject({ requiresInput: { type: "review" } });
    stopped = await resume(review, '{"redo":{"Kiwi":"Check the source","Rio":"Check the source"}}');
  }
  const saved = JSON.parse(readFileSync(join(stateDir, `${stopped.run}.json`), "utf8")) as RunState;
  return { stopped, saved, resume, exec, calls, accepted, allow: () => { refuse = false; }, report: join(root, "report.txt") };
}

it.each([
  ["initial", false], ["initial", true], ["review", false], ["review", true],
] as const)("resumes a partially accepted %s round without resending accepted requests (batched: %s)", async (phase, batched) => {
  const h = await team(phase, batched);
  const acceptedKiwi = h.accepted.filter((one) => one.botId === "kiwi").at(-1)!;
  expect(existsSync(h.report)).toBe(false);
  const acceptedBefore = h.accepted.length;
  const stillRefused = await h.resume(h.stopped, "try again");
  expect(existsSync(h.report)).toBe(false);
  expect(h.accepted).toHaveLength(acceptedBefore);
  expect(stillRefused).toMatchObject({ ok: false, error: { step: "s1" } });
  const callsBefore = h.calls.length;
  h.allow();
  const resumed = await h.resume(stillRefused, "go on");
  const done = resumed.requiresInput?.type === "teammates" ? await h.resume(resumed, "back") : resumed;
  const rounds = phase === "review" ? 2 : 1;
  expect(h.accepted.filter((one) => one.botId === "kiwi")).toHaveLength(rounds);
  expect(h.accepted.filter((one) => one.botId === "rio")).toHaveLength(rounds);
  expect(h.calls.slice(callsBefore)).toEqual([expect.objectContaining({ botIds: ["rio"], ...(phase === "review" ? { rework: true } : {}) })]);
  if (phase === "review") expect(h.calls.at(-1)!.message).toContain("Check the source");
  expect(h.stopped).toMatchObject({ ok: false, error: { step: "s1", message: expect.stringContaining("Rio is at its hand-off limit") } });
  expect(h.saved.delegation).toMatchObject({ round: rounds, requests: [{ part: "Kiwi", requestId: acceptedKiwi.requestId }] });
  expect(done).toMatchObject({ ok: true, status: "ok" });
  const report = readFileSync(h.report, "utf8");
  expect(report).toContain(`Kiwi: ${phase === "review" ? "corrected" : "initial"} report (${acceptedKiwi.requestId})`);
  expect(report).toContain(`Rio: ${phase === "review" ? "corrected" : "initial"} report`);
});

it("does not accept a refused completed-duplicate receipt carrying an old request id", async () => {
  const h = await team("initial", true);
  h.allow();
  const result = await h.exec.delegate!({ botIds: ["kiwi", "rio"], message: "Inspect the report", signal: new AbortController().signal });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("not sent again: it already finished") });
  expect(result).toHaveProperty("receipts", [{ botId: "rio", name: "Rio", requestId: h.accepted.find((one) => one.botId === "rio")!.requestId }]);
  expect(h.accepted.filter((one) => one.botId === "kiwi")).toHaveLength(1);
});
