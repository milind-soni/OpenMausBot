import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  TaskConflictError,
  TaskStore,
  TaskValidationError,
  filterTasks,
  mentionedTasks,
  resolveTaskContext,
  type TaskActor,
  type TaskRecord,
} from "./tasks.ts";

const roots: string[] = [];
const user: TaskActor = { kind: "user" };
const scout: Extract<TaskActor, { kind: "bot" }> = { kind: "bot", botId: "bot-scout", name: "Scout" };
const builder: Extract<TaskActor, { kind: "bot" }> = { kind: "bot", botId: "bot-builder", name: "Builder" };

function fixture(): { root: string; store: TaskStore } {
  const root = mkdtempSync(join(tmpdir(), "omb-tasks-"));
  roots.push(root);
  return { root, store: new TaskStore(root) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TaskStore", () => {
  it("normalizes, persists, and reloads structured tasks", () => {
    const { root, store } = fixture();
    const task = store.create({
      title: "  Ship the board  ",
      description: " Keep state live. ",
      acceptanceCriteria: [" Works after restart "],
      status: "todo",
      type: "feature",
      priority: "high",
      tags: ["UI", "ui", " Agents "],
      projectId: "project-one",
      dueAt: "2026-09-01",
    }, user);

    expect(task).toMatchObject({
      title: "Ship the board",
      description: "Keep state live.",
      acceptanceCriteria: ["Works after restart"],
      tags: ["ui", "agents"],
      revision: 1,
      createdBy: user,
    });
    expect(new TaskStore(root).get(task.id)).toEqual(task);
    expect(JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"))).toHaveLength(1);
  });

  it("supports all task types including task, bug, feature, research, documentation, and maintenance", () => {
    const { root, store } = fixture();
    const task = store.create({
      title: "Update PySide6 app.exec_() to app.exec()",
      type: "task",
    }, user);

    expect(task.type).toBe("task");
    const reloaded = new TaskStore(root).get(task.id);
    expect(reloaded?.type).toBe("task");
  });

  it("rejects malformed persistence without overwriting it", () => {
    const { root } = fixture();
    const file = join(root, "tasks.json");
    writeFileSync(file, JSON.stringify([{ id: "broken" }]));
    expect(() => new TaskStore(root)).toThrow(TaskValidationError);
    expect(readFileSync(file, "utf8")).toContain("broken");
  });

  it("reloads tasks when another process replaces the persistence file", () => {
    const { root, store } = fixture();
    const original = store.create({ title: "Original" }, user);
    const imported = { ...original, id: "external-task", title: "Imported externally" };

    writeFileSync(join(root, "tasks.json"), JSON.stringify([original, imported], null, 2));

    expect(store.list().map((task) => task.title)).toEqual(["Original", "Imported externally"]);
  });

  it("preserves externally imported tasks when creating more work", () => {
    const { root, store } = fixture();
    const original = store.create({ title: "Original" }, user);
    const imported = { ...original, id: "external-task", title: "Imported externally" };
    const file = join(root, "tasks.json");
    writeFileSync(file, JSON.stringify([imported], null, 2));

    store.create({ title: "Created after import" }, user);

    expect(JSON.parse(readFileSync(file, "utf8")).map((task: { title: string }) => task.title).sort()).toEqual([
      "Created after import",
      "Imported externally",
    ]);
  });

  it("rejects a malformed external replacement without overwriting it", () => {
    const { root, store } = fixture();
    store.create({ title: "Original" }, user);
    const file = join(root, "tasks.json");
    writeFileSync(file, JSON.stringify([{ id: "broken-import" }]));

    expect(() => store.list()).toThrow(TaskValidationError);
    expect(readFileSync(file, "utf8")).toContain("broken-import");
  });

  it("validates bounded input", () => {
    const { store } = fixture();
    expect(() => store.create({ title: " " }, user)).toThrow("Title is required");
    expect(() => store.create({ title: "x", type: "other" as any }, user)).toThrow("type is invalid");
    expect(() => store.create({ title: "x", tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, user)).toThrow("20 items");
  });

  it("requires the latest revision and returns current state on conflicts", () => {
    const { store } = fixture();
    const created = store.create({ title: "Original" }, user);
    const updated = store.update(created.id, created.revision, { title: "New title" }, scout);
    expect(updated.revision).toBe(2);
    expect(updated.updatedBy).toEqual(scout);
    try {
      store.update(created.id, created.revision, { priority: "urgent" }, user);
      throw new Error("expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskConflictError);
      expect((error as TaskConflictError).latest.title).toBe("New title");
    }
  });

  it("allows exactly one agent to claim unassigned work", () => {
    const { store } = fixture();
    const created = store.create({ title: "Claim me" }, user);
    const claimed = store.claim(created.id, created.revision, scout);
    expect(claimed).toMatchObject({ assigneeBotId: scout.botId, status: "doing", revision: 2 });
    expect(store.claim(created.id, claimed.revision, scout)).toEqual(claimed);
    expect(() => store.claim(created.id, claimed.revision, builder)).toThrow(TaskConflictError);
  });

  it("delegates, moves, records activity, and deletes by revision", () => {
    const { store } = fixture();
    const created = store.create({ title: "Coordinate" }, scout);
    const delegated = store.delegate(created.id, created.revision, builder.botId, builder.name, scout);
    const moved = store.update(delegated.id, delegated.revision, { status: "review" }, builder);
    expect(moved.activity.map((entry) => entry.action)).toEqual(["created", "delegated", "moved"]);
    expect(moved.activity[1].detail).toContain("Builder");
    expect(() => store.delete(moved.id, delegated.revision)).toThrow(TaskConflictError);
    expect(store.delete(moved.id, moved.revision).id).toBe(moved.id);
    expect(store.list()).toEqual([]);
  });

  it("drops card fields from saves made before Trello was removed, keeping their history", () => {
    const { root, store } = fixture();
    const created = store.create({ title: "Mirror me" }, user);
    const legacySync: TaskActor = { kind: "sync", source: "trello" };
    const legacy = { ...created, trelloCardId: "card-1", trelloCardUrl: "https://trello.com/c/abc123", updatedBy: legacySync };
    writeFileSync(join(root, "tasks.json"), JSON.stringify([legacy]));
    const reloaded = new TaskStore(root).get(created.id)!;
    expect(reloaded).not.toHaveProperty("trelloCardId");
    expect(reloaded).not.toHaveProperty("trelloCardUrl");
    expect(reloaded.updatedBy).toEqual(legacySync);
  });

  it("composes task filters and keeps board ordering", () => {
    const { store } = fixture();
    const overdue = store.create({
      title: "Fix login race",
      description: "Reproduce authentication timeout",
      type: "bug",
      priority: "urgent",
      tags: ["auth"],
      projectId: "p1",
      dueAt: 1,
    }, user);
    store.create({ title: "Write guide", type: "documentation", tags: ["docs"], projectId: "p2" }, user);
    const claimed = store.claim(overdue.id, overdue.revision, scout);

    expect(filterTasks(store.tasks, {
      text: "authentication",
      projectId: "p1",
      assigneeBotId: scout.botId,
      status: "doing",
      type: "bug",
      priority: "urgent",
      tag: "AUTH",
      overdue: true,
    }, Date.now())).toEqual([claimed]);
    expect(store.list({ assigneeBotId: null })).toHaveLength(1);
  });

  it("generates a stable %mention slug from the title and dedupes collisions", () => {
    const { store } = fixture();
    const a = store.create({ title: "Fix Qt6 QML styling!" }, user);
    const b = store.create({ title: "Fix Qt6 QML styling!" }, user);
    const c = store.create({ title: "Fix Qt6 QML styling!" }, user);
    expect(a.mention).toBe("fix-qt6-qml-styling");
    expect(b.mention).toBe("fix-qt6-qml-styling-2");
    expect(c.mention).toBe("fix-qt6-qml-styling-3");

    const empty = store.create({ title: "!!!" }, user);
    expect(empty.mention).toBe("task");
  });

  it("does not regenerate a mention when the title is edited later", () => {
    const { store } = fixture();
    const task = store.create({ title: "Original title" }, user);
    const updated = store.update(task.id, task.revision, { title: "Renamed" }, user);
    expect(updated.mention).toBe(task.mention);
  });

  it("backfills mentions for legacy tasks that predate the field, and persists it", () => {
    const { root } = fixture();
    const legacy = {
      id: "legacy-one",
      title: "Legacy task",
      description: "",
      acceptanceCriteria: [],
      status: "todo",
      type: "feature",
      priority: "normal",
      tags: [],
      dueAt: null,
      projectId: null,
      assigneeBotId: null,
      position: 1024,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      createdBy: user,
      updatedBy: user,
      activity: [],
      // no `mention` field — simulates a save from before this feature
    };
    writeFileSync(join(root, "tasks.json"), JSON.stringify([legacy]));

    const reloaded = new TaskStore(root).get("legacy-one");
    expect(reloaded?.mention).toBe("legacy-task");

    const onDisk = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
    expect(onDisk[0].mention).toBe("legacy-task");
  });
});

function task(patch: Partial<TaskRecord>): TaskRecord {
  return {
    id: "id", mention: "task", title: "Task", description: "", acceptanceCriteria: [],
    status: "todo", type: "feature", priority: "normal", tags: [], dueAt: null,
    projectId: null, assigneeBotId: null, position: 1024, revision: 1,
    createdAt: 1, updatedAt: 1, createdBy: user, updatedBy: user, activity: [],
    ...patch,
  };
}

describe("mentionedTasks", () => {
  it("uses exact, case-insensitive boundaries and deduplicates", () => {
    const tasks = [task({ id: "one", mention: "fix-login" }), task({ id: "two", mention: "ship-docs" })];
    expect(mentionedTasks("%Fix-Login, %ship-docs %fix-login", tasks).map((t) => t.id)).toEqual(["one", "two"]);
    expect(mentionedTasks("50%fix-login %general %fix-login-extra", tasks)).toEqual([]);
  });
});

describe("resolveTaskContext", () => {
  it("uses the first source with known references", () => {
    const tasks = [task({ id: "one", mention: "fix-login", title: "Fix login", status: "doing" })];
    const context = resolveTaskContext(["latest %fix-login", "default %missing"], tasks);
    expect(context.tasks.map((t) => t.id)).toEqual(["one"]);
    expect(context.system).toContain("%fix-login");
    expect(context.system).toContain("status: doing");
  });

  it("returns empty context when nothing matches", () => {
    const tasks = [task({ mention: "fix-login" })];
    expect(resolveTaskContext(["no mentions here"], tasks)).toEqual({ tasks: [], system: "" });
  });
});
