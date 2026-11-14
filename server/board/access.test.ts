import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { VisibleSet } from "../bot-visibility.ts";
import { boardViewer, filterBoard, projectEditable, projectVisible, taskEditable } from "./access.ts";
import { BoardStore } from "./store.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function visible(threads: string[], bots: string[], all = false): VisibleSet {
  return {
    everything: all,
    thread: (id: string) => all || threads.includes(id),
    bot: (id: string) => all || bots.includes(id),
    hides: (id: string) => !all && !threads.includes(id),
  } as unknown as VisibleSet;
}

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "omb-board-access-"));
  folders.push(folder);
  const store = new BoardStore({ file: join(folder, "board.json"), now: () => new Date("2026-11-15T00:00:00.000Z") });
  const project = store.createProject({
    name: "创意板", owner: "朱明跃", ownerEmail: "owner@example.com", goal: "交付", acceptance: "上线",
    visibility: { people: ["m@example.com"] },
  });
  const hidden = store.createProject({ name: "私有项目", visibility: "admins" });
  const subproject = store.createSubproject({ projectId: project.id, name: "财税", phase: "build", phaseEvidence: "https://example.test/build" });
  store.putTask({ threadId: "t1", botId: "b1", projectId: project.id, subprojectId: subproject.id, ownerEmail: "m@example.com" });
  store.putTask({ threadId: "t2", botId: "b2", projectId: project.id, subprojectId: subproject.id });
  store.putTask({ threadId: "child", botId: "b1", projectId: project.id, subprojectId: subproject.id, parentThreadId: "t1" });
  store.putTask({ threadId: "hidden-task", botId: "b1", projectId: hidden.id });
  return { store, project, hidden };
}

const member = (email: string) => ({
  admin: false, email, visible: visible(["t1", "child", "hidden-task"], ["b1"]),
});

describe("project board access", () => {
  it("filters a member's board by project audience and then by the conversations they can see", () => {
    const { store, project, hidden } = fixture();
    const viewer = member("m@example.com");
    const emailViewer = boardViewer({ kind: "session", scopes: ["client"], via: "cookie", session: { id: "s", email: "m@example.com" } as never }, viewer.visible);
    const result = filterBoard(store.state(), emailViewer);
    expect(result.state.projects.map((value) => value.id)).toEqual([project.id]);
    expect(result.state.projects.some((value) => value.id === hidden.id)).toBe(false);
    expect(result.state.tasks.map((value) => value.threadId)).toEqual(["t1", "child"]);
    expect(result.counts).toEqual({ tasks: 2, topLevel: 1, subtasks: 1, done: 0 });
    expect(result.permissions.projects[project.id]).toBe(false);
    expect(result.permissions.tasks.t1).toBe(true);
    expect(result.permissions.tasks.child).toBe(false);
    expect(result.state.subprojects).toHaveLength(1);
  });

  it("does not widen a project's audience to every member after migration", () => {
    const { store, project } = fixture();
    const other = boardViewer({ kind: "session", scopes: ["client"], via: "cookie", session: { id: "s2", email: "other@example.com" } as never }, visible(["t1"], ["b1"]));
    expect(projectVisible(store.state().projects.find((value) => value.id === project.id)!, other)).toBe(false);
    expect(filterBoard(store.state(), other).state.projects).toEqual([]);
  });

  it("gives the project owner and the task owner their own narrow edits", () => {
    const { store, project } = fixture();
    const owner = boardViewer({ kind: "session", scopes: ["client"], via: "cookie", session: { id: "s", email: "owner@example.com" } as never }, visible([], []));
    const taskOwner = boardViewer({ kind: "session", scopes: ["client"], via: "cookie", session: { id: "s", email: "m@example.com" } as never }, visible(["t1", "child"], ["b1"]));
    const outsider = boardViewer({ kind: "session", scopes: ["client"], via: "cookie", session: { id: "s", email: "other@example.com" } as never }, visible(["t1"], ["b1"]));
    const storedProject = store.state().projects.find((value) => value.id === project.id)!;
    const first = store.state().tasks.find((value) => value.threadId === "t1")!;
    const child = store.state().tasks.find((value) => value.threadId === "child")!;
    expect(projectEditable(storedProject, owner)).toBe(true);
    expect(projectEditable(storedProject, taskOwner)).toBe(false);
    expect(taskEditable(first, storedProject, taskOwner)).toBe(true);
    expect(taskEditable(child, storedProject, taskOwner)).toBe(false);
    expect(taskEditable(first, storedProject, outsider)).toBe(false);
  });

  it("lets an admin see everything and marks every project editable", () => {
    const { store } = fixture();
    const admin = boardViewer({ kind: "loopback", scopes: ["admin", "client"] }, visible([], [], true));
    const result = filterBoard(store.state(), admin);
    expect(result.state.projects).toHaveLength(2);
    expect(result.state.tasks).toHaveLength(4);
    expect(Object.values(result.permissions.projects).every(Boolean)).toBe(true);
    expect(result.permissions.tasks["t1"]).toBe(true);
  });
});
