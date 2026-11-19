import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorkTaskError, WorkTaskStore } from "./work-tasks.ts";
import {
  syncTaskOnCoordinateDispatch,
  syncTaskOnRuntimePark,
  syncTaskOnRuntimeReport,
  syncTaskOnRuntimeStart,
} from "./work-tasks-runtime.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "looma-wt-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("WorkTaskStore workflow, RBAC, runtime sync & reload persistence", () => {
  it("runs the full Coordinator -> Worker -> QA -> Rework/Done lifecycle and survives reload", () => {
    const dir = tempDir();
    const file = join(dir, "work-tasks.json");
    let now = 1_700_000_000_000;
    const emitted: unknown[] = [];

    const store1 = new WorkTaskStore({ file, now: () => ++now, emit: (f) => emitted.push(f) });

    // 1. User creates task on Board
    const { task: created } = store1.create(
      {
        roomId: "room-1",
        title: "Build checkout API",
        priority: "high",
        coordinatorBotId: "coord",
        qaBotId: "qa",
        acceptanceCriteria: ["POST /checkout returns 201", "Unit tests pass"],
      },
      { actorType: "user", actorId: "u1", actorName: "Alice" },
    );
    expect(created.key).toBe("LOOMA-101");
    expect(created.status).toBe("backlog");

    // 2. Coordinator assigns to Backend-Agent
    const coordActor = {
      actorType: "agent" as const,
      actorId: "backend",
      actorName: "Backend-Agent",
      actorRole: "Backend Engineer",
    };
    const assigned = store1.assign(
      created.id,
      {
        assigneeBotId: "backend",
        assigneeName: "Backend-Agent",
        assigneeRole: "Backend Engineer",
        threadId: "thread-backend-1",
        assignmentId: "asgn-1",
      },
      { actorType: "agent", actorId: "coord", actorName: "Coordinator", actorRole: "Coordinator", isCoordinator: true },
    );
    expect(assigned.status).toBe("todo");

    // 3. Worker starts -> In Progress
    const inProgress = store1.transition(assigned.id, "in-progress", coordActor, {
      message: "Starting checkout API implementation",
    });
    expect(inProgress.status).toBe("in-progress");
    expect(inProgress.startedAt).toBeTypeOf("number");

    // 4. Worker CANNOT mark Done directly
    expect(() => store1.transition(inProgress.id, "done", coordActor)).toThrowError(WorkTaskError);
    try {
      store1.transition(inProgress.id, "done", coordActor);
    } catch (err) {
      expect((err as WorkTaskError).status).toBe(403);
    }

    // 5. Worker adds progress + test evidence, moves to In Review
    store1.addActivity(inProgress.id, { type: "progress", message: "Running backend checkout tests" }, coordActor);
    store1.addEvidence(
      inProgress.id,
      { type: "test", label: "vitest checkout", value: "12 passed, 0 failed" },
      coordActor,
    );
    const inReview = store1.transition(inProgress.id, "in-review", coordActor);
    expect(inReview.status).toBe("in-review");

    // 6. QA requests Rework -> Worker picks up -> In Progress -> In Review -> QA marks Done
    const qaActor = {
      actorType: "agent" as const,
      actorId: "qa",
      actorName: "QA-Agent",
      actorRole: "QA Engineer",
      isQa: true,
    };
    const rework = store1.transition(inReview.id, "rework", qaActor, {
      message: "Missing idempotency check",
    });
    expect(rework.status).toBe("rework");

    const retry = store1.transition(rework.id, "in-progress", coordActor);
    const backToReview = store1.transition(retry.id, "in-review", coordActor);
    const done = store1.transition(backToReview.id, "done", qaActor, {
      message: "All checks verified",
    });
    expect(done.status).toBe("done");
    expect(done.completedAt).toBeTypeOf("number");

    // 7. Reload persistence & activity trail verification
    const store2 = new WorkTaskStore({ file });
    const reloaded = store2.get("LOOMA-101");
    expect(reloaded?.status).toBe("done");
    expect(reloaded?.evidence?.length).toBe(1);
    expect(reloaded?.threadId).toBe("thread-backend-1");

    const acts = store2.activities(reloaded!.id);
    expect(acts.some((a) => a.actorName === "Coordinator" && a.type === "assigned")).toBe(true);
    expect(acts.some((a) => a.actorName === "Backend-Agent" && a.actorRole === "Backend Engineer")).toBe(true);
    expect(acts.some((a) => a.actorName === "QA-Agent" && a.toStatus === "rework")).toBe(true);
    expect(acts.some((a) => a.actorName === "QA-Agent" && a.toStatus === "done")).toBe(true);
    expect(emitted.length).toBeGreaterThan(0);
  });

  it("synchronizes coordinate_bots dispatch -> runtime start -> child wait -> completion/failure", () => {
    const dir = tempDir();
    const workTasks = new WorkTaskStore({ file: join(dir, "work-tasks.json") });

    const fakeBots = new Map<string, any>([
      ["coord", { id: "coord", name: "Coordinator", title: "Lead", chiefOfStaff: true }],
      ["be", { id: "be", name: "Backend-Agent", title: "Backend" }],
      ["qa", { id: "qa", name: "QA-Agent", title: "QA" }],
    ]);
    const fakeRoom = {
      id: "room-proj",
      name: "ProjectHub",
      threadId: "room-thread",
      memberIds: ["coord", "be", "qa"],
      defaultResponder: { kind: "member" as const, botId: "coord" },
    };
    const fakeStore = {
      bot: (id: string) => fakeBots.get(id),
      group: (id: string) => (id === fakeRoom.id ? fakeRoom : undefined),
      groupByThread: (t: string) => (t === fakeRoom.threadId ? fakeRoom : undefined),
    } as any;

    const parentNode: any = {
      id: "asgn-parent",
      rootId: "asgn-root",
      parentId: "asgn-root",
      groupId: fakeRoom.id,
      threadId: "thread-be",
      botId: "be",
      text: "Implement API",
      status: "queued",
      result: "",
    };

    const parentTask = syncTaskOnCoordinateDispatch({
      workTasks,
      store: fakeStore,
      sender: fakeBots.get("coord"),
      recipient: fakeBots.get("be"),
      senderThreadId: fakeRoom.threadId,
      node: parentNode,
      call: {
        botIds: ["be"],
        message: "Implement API",
        rework: false,
        thread: "new",
        reply: "resume",
        consult: false,
        title: "Implement API",
        doneWhen: "Tests pass",
      },
    });
    expect(parentTask?.key).toBe("LOOMA-101");
    expect(parentTask?.status).toBe("todo");

    syncTaskOnRuntimeStart({
      workTasks,
      store: fakeStore,
      node: { ...parentNode, status: "running" },
      bot: fakeBots.get("be"),
    });
    expect(workTasks.get("LOOMA-101")?.status).toBe("in-progress");

    // If child subtasks exist and are still active, finishing parent turn does not auto-move to in-review
    workTasks.create(
      {
        roomId: fakeRoom.id,
        parentTaskId: parentTask!.id,
        type: "subtask",
        title: "Subtask running",
        assigneeBotId: "qa",
        assigneeName: "QA-Agent",
      },
      { actorType: "user", actorName: "User" },
    );

    syncTaskOnRuntimeReport({
      workTasks,
      store: fakeStore,
      child: { ...parentNode, status: "completed" },
      hasActiveChildren: true,
    });
    expect(workTasks.get("LOOMA-101")?.status).toBe("in-progress");

    // Once children are finished, parent moves to in-review (NOT done)
    const sub = workTasks.get("LOOMA-102")!;
    workTasks.transition(sub.id, "in-progress", { actorType: "agent", actorId: "qa", actorName: "QA-Agent", isQa: true });
    workTasks.transition(sub.id, "in-review", { actorType: "agent", actorId: "qa", actorName: "QA-Agent", isQa: true });

    syncTaskOnRuntimeReport({
      workTasks,
      store: fakeStore,
      child: { ...parentNode, status: "completed" },
      hasActiveChildren: false,
    });
    expect(workTasks.get("LOOMA-101")?.status).toBe("in-review");

    // Failure & park test on a fresh task
    const { task: task2 } = workTasks.create(
      { roomId: fakeRoom.id, title: "Frontend task", assigneeBotId: "be", assigneeName: "Backend-Agent" },
      { actorType: "user" },
    );
    workTasks.bindRuntime(task2.id, { assignmentId: "asgn-2" });
    syncTaskOnRuntimePark({
      workTasks,
      store: fakeStore,
      node: { ...parentNode, id: "asgn-2", botId: "be" },
      question: "Waiting on API contract",
    });
    expect(workTasks.get(task2.id)?.status).toBe("blocked");
    expect(workTasks.get(task2.id)?.needsUserAction).toBe(true);

    // Telegram /status output
    const tgStatus = workTasks.formatTelegramCommand("/status", [{ id: fakeRoom.id, name: "ProjectHub" }], fakeRoom.id);
    expect(tgStatus.ok).toBe(true);
    expect(tgStatus.text).toContain("ProjectHub");
    expect(tgStatus.text).toContain("LOOMA-101: In Review");
    expect(tgStatus.text).toContain("Waiting on API contract");

    const tgBlocked = workTasks.formatTelegramCommand("/blocked", [{ id: fakeRoom.id, name: "ProjectHub" }], fakeRoom.id);
    expect(tgBlocked.text).toContain(task2.key);
  });
});

