import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDriver } from "./drivers/codex.ts";
import { bindJobUsageTurn, completeJobUsageTurn, readJobUsage, tokenObservation, type JobUsageTurnBinding } from "./job-usage.ts";
import { OfficeControl } from "./office-control.ts";
import { withOfficeExecution } from "./office-execution.ts";
import { openRuntimeStore } from "./runtime/store.ts";
import type { Assignment } from "./runtime/types.ts";
import { appendUsage } from "./usage-ledger.ts";
import { recordEvents } from "./testing/events.ts";
import { removeTempDir } from "./testing/cleanup.ts";

vi.mock("./drivers/codex-release.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./drivers/codex-release.ts")>(),
  readLatestCodexRelease: async () => "0.163.0",
}));

const fakeCli = fileURLToPath(new URL("./testing/fake-codex-app-server.ts", import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-job-codex-usage-"));
  const codexHome = join(dataDir, "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic-fixture-only" } }));
  chmodSync(fakeCli, 0o755);
  const now = Date.now();
  const store = openRuntimeStore(join(dataDir, "runtime.db"));
  const root: Assignment = {
    id: "root", rootId: "root", depth: 0, origin: { kind: "person", source: "chat" }, requester: { kind: "person", threadId: "office" },
    assignee: { botId: "chief", destination: { kind: "standing_thread", threadId: "office" } }, mode: "work", reply: "resume",
    brief: "synthetic fixture", status: "running", level: "ask", levelSource: "own", executions: 1, restarts: 0,
    createdAt: now, lastActivityAt: now, result: "", rework: false, version: 1,
    office: { rootDeadline: now + 60_000, attempts: [] },
  };
  store.insert(root, { kind: "enqueued" });
  let control!: OfficeControl;
  control = new OfficeControl({
    store, workerId: "hel1", controllerHost: "orch-hel1",
    resolve: () => ({ assignmentId: "root", generation: "native-generation", profileDigest: "a".repeat(64) }),
    requestDirective: async request => {
      const attempt = control.readAttempt(request.attemptId, request.capability)!;
      expect(control.commitDirective(request.attemptId, request.capability, {
        version: 1, attemptId: attempt.attemptId, generation: attempt.generation, digest: attempt.digest,
        workerId: attempt.workerId, profileDigest: attempt.profileDigest, cwd: attempt.cwd,
        rootDeadline: attempt.rootDeadline, startBefore: attempt.startBefore, kind: attempt.kind,
        decision: "allow", controllerHost: "orch-hel1", controllerDecisionId: randomUUID(), policyVersion: "office-control-v1",
      })).toBe(true);
    },
    cancelAssignment: () => {}, cancelNative: () => {},
  });
  const dump = join(dataDir, "codex-launch.json");
  const instance = await CodexDriver.create({
    instanceId: "codex-fixture", displayName: "Codex fixture", enabled: true, officeExecution: true,
    config: { cli: fakeCli, fullAuto: false },
    environment: { HOME: dataDir, USERPROFILE: dataDir, CODEX_HOME: codexHome, FAKE_CODEX_MCP_OVERRIDES: "1", FAKE_CODEX_DUMP: dump },
  });
  const wrapped = withOfficeExecution(instance, () => control);
  let binding: JobUsageTurnBinding | undefined;
  const startReceipts: Array<{ state?: string; consumed: boolean; bound: boolean }> = [];
  const writes: Promise<boolean>[] = [];
  wrapped.adapter.onEvent(event => {
    if (event.type === "turn.started") {
      const node = store.get("root")!;
      binding = bindJobUsageTurn(node, { generation: "native-generation", turnId: event.turnId });
      const attempt = node.office?.attempts.at(-1);
      startReceipts.push({ state: attempt?.state, consumed: attempt?.consumedAt !== undefined, bound: binding !== undefined });
    }
    if (event.type === "turn.completed") {
      const node = store.get("root")!;
      const job = completeJobUsageTurn(binding, node);
      if (job) writes.push(appendUsage(dataDir, {
        botId: "chief", botName: "Chief", threadId: "office", instanceId: instance.instanceId, driverKind: "codex", model: instance.models.default,
        input: event.usage?.input ?? 0, output: event.usage?.output ?? 0, cachedInput: event.usage?.cachedInput,
        costUsd: event.cost ?? null, trigger: { kind: "owner" }, job, tokenObservation: tokenObservation(event.usage),
      }));
    }
  });
  const recorder = recordEvents(wrapped.adapter);
  cleanup.push(async () => { recorder.stop(); await wrapped.dispose(); control.close(); store.close(); await removeTempDir(dataDir); });
  return { wrapped, store, dataDir, recorder, writes, startReceipts, dump,
    input: { botId: "chief", threadId: "office", cwd: dataDir, text: "synthetic usage fixture" } };
}

describe("actual Codex app-server with native OfficeControl usage binding", () => {
  it("binds the sole pre-consumption started event and books the consumed attempt at completion", async () => {
    const f = await fixture();
    await f.wrapped.adapter.sendTurn(f.input);
    const completed = await f.recorder.until(event => event.type === "turn.completed", 15_000);
    await Promise.all(f.writes);
    expect(f.startReceipts).toEqual([{ state: "issued", consumed: false, bound: true }]);
    expect(completed).toMatchObject({ ok: true, usage: { input: 7, output: 3, cachedInput: 4 } });
    const node = f.store.get("root")!;
    expect(node.office?.attempts[0]?.consumedAt).toBeTypeOf("number");
    const summary = readJobUsage(f.dataDir, [node], node.id);
    expect(summary.total).toMatchObject({ turns: 1, input: 7, output: 3, cachedInput: 4, totalTokens: 10, unknownInputTurns: 0, unknownOutputTurns: 0 });
    expect(summary.coverage).toMatchObject({ expectedAttempts: 1, observedAttempts: 1, missingAttempts: 0, tokens: "complete", costs: "partial" });
    expect(summary.observations[0]).toMatchObject({ rootId: "root", assignmentId: "root", attemptId: node.office!.attempts[0]!.attemptId, turnId: completed.turnId });
  }, 20_000);

  it("does not book an issued attempt cancelled before native process admission", async () => {
    const f = await fixture();
    let release!: () => void;
    const admission = new Promise<void>(resolve => { release = resolve; });
    const started = await f.wrapped.adapter.sendTurn({ ...f.input, engineAdmission: () => admission });
    expect(f.startReceipts).toEqual([{ state: "issued", consumed: false, bound: true }]);
    await f.wrapped.adapter.interruptTurn("office", started.turnId);
    release();
    await f.recorder.until(event => event.type === "turn.completed", 15_000);
    await Promise.all(f.writes);
    const node = f.store.get("root")!;
    expect(node.office?.attempts[0]?.consumedAt).toBeUndefined();
    expect(existsSync(f.dump)).toBe(false);
    const summary = readJobUsage(f.dataDir, [node], node.id);
    expect(summary.total.turns).toBe(0);
    expect(summary.observations).toEqual([]);
    expect(summary.coverage.expectedAttempts).toBe(0);
    expect(summary.attempts[0]?.state).toBe("not_started");
  }, 20_000);
});
