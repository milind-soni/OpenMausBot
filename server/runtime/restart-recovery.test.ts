import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { CoordinatorHost } from "../coordinator.ts";
import { RuntimeCoordinator } from "../runtime-coordinator.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { Runtime } from "./runtime.ts";
import { openRuntimeStore, type RuntimeStore } from "./store.ts";
import type { Assignment, OfficeAttempt, RunInput, TurnRunner } from "./types.ts";

const probe = fileURLToPath(new URL("../testing/runtime-restart-probe.ts", import.meta.url));
const project = dirname(dirname(dirname(probe)));
const owner = { botId: "chief", threadId: "office-thread" };
const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(directory => removeTempDir(directory))); });

interface Fixture {
  directory: string;
  rootId: string;
  childId: string;
  exit: { code: number | null; signal: NodeJS.Signals | null };
}

async function crashedAt(phase: string): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "omb-runtime-restart-"));
  fixtures.push(directory);
  const child = spawn(process.execPath, ["--experimental-strip-types", probe, directory, phase], {
    cwd: project,
    env: { PATH: process.env.PATH, HOME: directory, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output = (output + String(chunk)).slice(-16_000); });
  child.stderr.on("data", chunk => { output = (output + String(chunk)).slice(-16_000); });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 5_000);
  const exit = await new Promise<Fixture["exit"]>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(deadline));
  expect(timedOut, output).toBe(false);
  expect(exit, output).toEqual(phase === "legacy-missing-wake" ? { code: 0, signal: null } : { code: null, signal: "SIGKILL" });
  const ids = JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8")) as { rootId: string; childId: string };
  return { directory, ...ids, exit };
}

function executions(fixture: Fixture): Array<{ id: string; botId: string }> {
  const path = join(fixture.directory, "executions.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}

function attemptFor(assignment: Assignment, fixture: Fixture, state: OfficeAttempt["state"]): OfficeAttempt {
  const now = Date.now();
  return {
    version: 1, attemptId: `fixture-${state}`, assignmentId: assignment.id, rootId: assignment.rootId,
    botId: assignment.assignee.botId, threadId: assignment.assignee.destination.threadId, generation: "fixture-generation",
    workerId: "isolated-worker", instanceId: "fixture-engine", driverKind: "codexAgent", profileId: "fixture-profile",
    assignmentDigest: "fixture-assignment", profileDigest: "fixture-profile", cwd: fixture.directory,
    rootDeadline: assignment.office!.rootDeadline, startBefore: now + 60_000, kind: "work", digest: "fixture-digest",
    capabilityHash: "fixture-capability", state, preparedAt: now - 2,
    ...(state === "issued" || state === "consumed" ? { issuedAt: now - 1 } : {}),
    ...(state === "consumed" ? { consumedAt: now, finishedAt: now } : {}),
  };
}

function amendFixture(fixture: Fixture, id: string, change: (assignment: Assignment) => void): void {
  const store = openRuntimeStore(join(fixture.directory, "runtime.db"));
  try {
    const assignment = store.get(id)!;
    change(assignment);
    store.update(assignment);
  } finally { store.close(); }
}

function recovered(fixture: Fixture): {
  store: RuntimeStore;
  runtime: Runtime;
  runs: Array<{ assignment: Assignment; input: RunInput }>;
  messages(): Array<{ assignment_id: string; result: string }>;
  close(): void;
} {
  const store = openRuntimeStore(join(fixture.directory, "runtime.db"));
  const host = new DatabaseSync(join(fixture.directory, "host.db"));
  const record = host.prepare("INSERT OR IGNORE INTO messages (assignment_id, result) VALUES (?, ?)");
  const runs: Array<{ assignment: Assignment; input: RunInput }> = [];
  const runner: TurnRunner = {
    validate: () => undefined, canStart: () => true,
    run(assignment, input) {
      runs.push({ assignment, input });
      return Promise.resolve({ kind: "completed", text: assignment.parentId ? "Newly started queued child" : "Chief returned the recovered child result" });
    },
    park: () => {},
    report(assignment) { if (assignment.parentId) record.run(assignment.id, assignment.result); },
    changed: () => {}, names: () => ({ requester: "Chief", assignee: "Builder", person: "Fixture operator" }),
  };
  const runtime = new Runtime(store, runner);
  runtime.enableOfficeControl();
  runtime.open();
  return {
    store, runtime, runs,
    messages: () => host.prepare("SELECT assignment_id, result FROM messages ORDER BY rowid").all() as Array<{ assignment_id: string; result: string }>,
    close() { host.close(); store.close(); },
  };
}

async function drain(runtime: Runtime): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    runtime.tick();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

describe("Runtime disk-backed restart recovery", () => {
  it.each(["host-result", "reported"])("recovers one result and one parent completion signal after SIGKILL at %s", async phase => {
    const fixture = await crashedAt(phase);
    expect(executions(fixture).filter(row => row.id === fixture.childId)).toHaveLength(1);
    const next = recovered(fixture);
    try {
      await drain(next.runtime);
      next.runtime.open();
      await drain(next.runtime);
      expect(next.messages()).toEqual([{ assignment_id: fixture.childId, result: "Durable child coding result" }]);
      expect(next.store.get(fixture.childId)).toMatchObject({ status: "completed", result: "Durable child coding result", executions: 1, reportedAt: expect.any(Number) });
      expect(next.store.inbox(owner).filter(item => item.assignmentId === fixture.childId && item.kind === "settled")).toHaveLength(1);
      expect(next.store.events(fixture.childId).filter(event => event.kind === "reported")).toHaveLength(1);
      expect(next.store.events(fixture.childId).filter(event => event.kind === "woken")).toHaveLength(1);
      expect(next.runs.filter(run => run.assignment.id === fixture.rootId)).toHaveLength(1);
      expect(next.runs.find(run => run.assignment.id === fixture.rootId)?.input.settled?.map(child => child.id)).toEqual([fixture.childId]);
      expect(next.store.get(fixture.rootId)).toMatchObject({ status: "completed", result: "Chief returned the recovered child result" });
      expect(next.runs.filter(run => run.assignment.id === fixture.childId)).toEqual([]);
      expect(executions(fixture).filter(row => row.id === fixture.childId)).toHaveLength(1);
    } finally { next.close(); }
  });

  it("repairs a legacy reported child with no completion inbox without duplicating its transcript", async () => {
    const fixture = await crashedAt("legacy-missing-wake");
    const next = recovered(fixture);
    try {
      await drain(next.runtime);
      expect(next.messages()).toEqual([{ assignment_id: fixture.childId, result: "Durable child coding result" }]);
      expect(next.store.inbox(owner).filter(item => item.assignmentId === fixture.childId && item.kind === "settled")).toHaveLength(1);
      expect(next.store.events(fixture.childId).filter(event => event.kind === "reported")).toHaveLength(1);
      expect(next.store.events(fixture.childId).filter(event => event.kind === "woken")).toHaveLength(1);
      expect(next.runs.find(run => run.assignment.id === fixture.rootId)?.input.settled?.map(child => child.id)).toEqual([fixture.childId]);
      expect(next.runs.filter(run => run.assignment.id === fixture.childId)).toEqual([]);
    } finally { next.close(); }
  });

  it.each(["consumed", "consumed-finished"])("retains a %s office attempt result without rerunning its side effect", async phase => {
    const fixture = await crashedAt(phase);
    const next = recovered(fixture);
    try {
      await drain(next.runtime);
      expect(next.store.get(fixture.childId)).toMatchObject({
        status: "failed", outcome: "interrupted", result: "Retained checkpoint before interrupted execution", executions: 1,
        office: { attempts: [{ attemptId: "consumed-fixture-attempt", state: phase === "consumed" ? "uncertain" : "consumed", consumedAt: expect.any(Number) }] },
      });
      expect(next.runs.filter(run => run.assignment.id === fixture.childId)).toEqual([]);
      expect(executions(fixture).filter(row => row.id === fixture.childId)).toHaveLength(1);
      expect(next.messages()).toEqual([{ assignment_id: fixture.childId, result: "Retained checkpoint before interrupted execution" }]);
      expect(next.store.inbox(owner).filter(item => item.assignmentId === fixture.childId)).toHaveLength(1);
    } finally { next.close(); }
  });

  it("starts queued work after SIGKILL when no execution was consumed", async () => {
    const fixture = await crashedAt("queued");
    expect(executions(fixture)).toEqual([]);
    const next = recovered(fixture);
    try {
      await drain(next.runtime);
      expect(next.runs.filter(run => run.assignment.id === fixture.childId)).toHaveLength(1);
      expect(next.store.get(fixture.childId)).toMatchObject({ status: "completed", executions: 1, result: "Newly started queued child" });
      expect(next.store.inbox(owner).filter(item => item.assignmentId === fixture.childId)).toHaveLength(1);
    } finally { next.close(); }
  });

  it.each(["prepared", "issued"] as const)("keeps latest %s work eligible despite an older consumed execution", async state => {
    const fixture = await crashedAt("queued");
    amendFixture(fixture, fixture.childId, assignment => {
      assignment.executions = 1;
      assignment.office!.attempts = [attemptFor(assignment, fixture, "consumed"), attemptFor(assignment, fixture, state)];
    });
    const next = recovered(fixture);
    try {
      await drain(next.runtime);
      expect(next.runs.filter(run => run.assignment.id === fixture.childId)).toHaveLength(1);
      expect(next.store.get(fixture.childId)).toMatchObject({ status: "completed", executions: 2, result: "Newly started queued child" });
      expect(next.store.get(fixture.childId)?.office?.attempts[0]?.state).toBe("consumed");
      expect(next.store.get(fixture.childId)?.office?.attempts[1]?.state).toBe("cancelled");
    } finally { next.close(); }
  });

  it("recovers a waiting parent's existing children after its own consumed turn finished", async () => {
    const fixture = await crashedAt("queued");
    amendFixture(fixture, fixture.rootId, assignment => {
      assignment.office!.attempts = [attemptFor(assignment, fixture, "consumed")];
    });
    const next = recovered(fixture);
    try {
      await drain(next.runtime);
      expect(next.runs.filter(run => run.assignment.id === fixture.childId)).toHaveLength(1);
      expect(next.runs.filter(run => run.assignment.id === fixture.rootId)).toHaveLength(1);
      expect(next.runs.find(run => run.assignment.id === fixture.rootId)?.input).toMatchObject({ resumed: true, settled: [{ id: fixture.childId }] });
      expect(next.store.get(fixture.rootId)).toMatchObject({ status: "completed", result: "Chief returned the recovered child result", executions: 2 });
    } finally { next.close(); }
  });

  it("closes runtime admission before native shutdown callbacks return an interrupted turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-runtime-shutdown-"));
    fixtures.push(directory);
    const host: CoordinatorHost = {
      validate: () => undefined, busy: () => false, run: async () => ({ ok: true, text: "Unused" }),
      report: () => {}, changed: () => {}, park: () => {},
      names: () => ({ requester: "Chief", assignee: "Builder", person: "Fixture operator" }),
      levelOf: () => ({ level: "auto", driverKind: "codex" }), chiefOf: () => true,
    };
    const coordinator = new RuntimeCoordinator({ dataDir: directory, host });
    let stopped = 0;
    const control = coordinator.configureOfficeControl({
      workerId: "isolated-worker",
      resolve: () => ({ assignmentId: "shutdown-root", generation: "shutdown-generation", profileDigest: "a".repeat(64) }),
      requestDirective: async request => {
        const attempt = control.readAttempt(request.attemptId, request.capability)!;
        const committed = control.commitDirective(request.attemptId, request.capability, {
          version: 1, attemptId: attempt.attemptId, generation: attempt.generation, digest: attempt.digest,
          workerId: attempt.workerId, profileDigest: attempt.profileDigest, cwd: attempt.cwd,
          rootDeadline: attempt.rootDeadline, startBefore: attempt.startBefore, kind: attempt.kind, decision: "allow",
          controllerHost: "orch-hel1", controllerDecisionId: "12345678-1234-4234-8234-123456789abc", policyVersion: "office-control-v1",
        });
        if (!committed) throw new Error("Fixture directive was refused");
      },
      cancelNative: () => {
        stopped += 1;
        coordinator.endTurn("shutdown-root", { ok: false, text: "Native process ended during shutdown" });
      },
    });
    coordinator.beginTurn({ id: "shutdown-root", address: { botId: "chief", threadId: "office-thread" }, brief: "Work survives restart", level: "auto" });
    const lease = await control.prepare({ botId: "chief", threadId: "office-thread", cwd: directory, instanceId: "fixture-engine", driverKind: "codex", signal: new AbortController().signal });
    lease.assert("process");
    try {
      coordinator.close();
      expect(lease.signal.aborted).toBe(true);
      expect(stopped).toBe(1);
      const disk = openRuntimeStore(join(directory, "runtime.db"));
      try {
        expect(disk.get("shutdown-root")).toMatchObject({ status: "running", executions: 1 });
        expect(disk.get("shutdown-root")?.outcome).toBeUndefined();
        expect(disk.get("shutdown-root")?.finishedAt).toBeUndefined();
        expect(disk.events("shutdown-root").filter(event => event.kind === "cancelled" || event.kind === "settled")).toEqual([]);
      } finally { disk.close(); }
    } finally { coordinator.close(); }
  });
});
