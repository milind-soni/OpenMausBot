import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Runtime } from "../runtime/runtime.ts";
import { openRuntimeStore, type RuntimeStore } from "../runtime/store.ts";
import type { OfficeAttempt, TurnRunner } from "../runtime/types.ts";

const [directory, phase] = process.argv.slice(2);
if (!directory || !["host-result", "reported", "legacy-missing-wake", "consumed", "consumed-finished", "queued"].includes(phase ?? "")) {
  throw new Error("Expected an isolated fixture directory and a restart checkpoint");
}

const inner = openRuntimeStore(join(directory, "runtime.db"));
const host = new DatabaseSync(join(directory, "host.db"));
host.exec("CREATE TABLE messages (assignment_id TEXT PRIMARY KEY, result TEXT NOT NULL)");
const record = host.prepare("INSERT OR IGNORE INTO messages (assignment_id, result) VALUES (?, ?)");
const die = (): never => { process.kill(process.pid, "SIGKILL"); throw new Error("SIGKILL returned"); };
const store: RuntimeStore = {
  ...inner,
  update(assignment, event) {
    inner.update(assignment, event);
    if (phase === "reported" && assignment.parentId && event?.kind === "reported") die();
  },
};

const runner: TurnRunner = {
  validate: () => undefined,
  canStart: () => true,
  run(assignment) {
    appendFileSync(join(directory, "executions.jsonl"), JSON.stringify({ id: assignment.id, botId: assignment.assignee.botId }) + "\n");
    if (phase === "consumed" || phase === "consumed-finished") {
      const current = store.get(assignment.id)!;
      const now = Date.now();
      const attempt: OfficeAttempt = {
        version: 1, attemptId: "consumed-fixture-attempt", assignmentId: current.id, rootId: current.rootId,
        botId: current.assignee.botId, threadId: current.assignee.destination.threadId, generation: "fixture-generation",
        workerId: "isolated-worker", instanceId: "fixture-engine", driverKind: "codexAgent", profileId: "fixture-profile",
        assignmentDigest: "fixture-assignment", profileDigest: "fixture-profile", cwd: directory,
        rootDeadline: current.office!.rootDeadline, startBefore: now + 60_000, kind: "work", digest: "fixture-digest",
        capabilityHash: "fixture-capability", state: "consumed", preparedAt: now - 2, issuedAt: now - 1, consumedAt: now,
        ...(phase === "consumed-finished" ? { finishedAt: now } : {}),
      };
      current.office!.attempts.push(attempt);
      current.result = "Retained checkpoint before interrupted execution";
      store.update(current);
      die();
    }
    return Promise.resolve({ kind: "completed", text: "Durable child coding result" });
  },
  park: () => {},
  report(assignment) {
    if (!assignment.parentId) return;
    record.run(assignment.id, assignment.result);
    if (phase === "host-result") die();
  },
  changed: () => {},
  names: () => ({ requester: "Chief", assignee: "Builder", person: "Fixture operator" }),
};

const runtime = new Runtime(store, runner);
runtime.enableOfficeControl();
runtime.open();
const root = runtime.begin({
  id: "restart-root", origin: { kind: "person", source: "chat", quote: "Complete the isolated coding fixture" },
  requester: { kind: "person", threadId: "office-thread", chief: true },
  assignee: { botId: "chief", destination: { kind: "standing_thread", threadId: "office-thread" } },
  brief: "Complete the isolated coding fixture", level: "auto",
});
const admitted = runtime.enqueue({
  parentId: root.id, origin: root.origin,
  requester: { kind: "bot_turn", botId: "chief", threadId: "office-thread", chief: true },
  assignee: { botId: "builder", destination: { kind: "work_thread", threadId: "builder-thread" } },
  brief: "Produce one durable coding result", levels: { own: "auto", chief: "auto" }, driverKind: "codexAgent",
});
if (!admitted.ok) throw new Error(admitted.reason);
writeFileSync(join(directory, "fixture.json"), JSON.stringify({ rootId: root.id, childId: admitted.assignment.id, phase }));
runtime.end(root.id, { ok: true, text: "Waiting for the builder" });
if (phase === "queued") die();
runtime.tick();
await new Promise<void>(resolve => setImmediate(resolve));
if (phase !== "legacy-missing-wake") throw new Error("The restart checkpoint did not kill this child process");
const legacy = new DatabaseSync(join(directory, "runtime.db"));
legacy.prepare("DELETE FROM inbox WHERE assignment_id = ?").run(admitted.assignment.id);
legacy.prepare("DELETE FROM assignment_events WHERE assignment_id = ? AND kind = 'woken'").run(admitted.assignment.id);
legacy.close();
inner.close();
host.close();
