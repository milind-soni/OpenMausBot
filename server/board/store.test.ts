import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BoardBroadcast } from "../../shared/board.ts";
import { BoardError, BoardStore } from "./store.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function store() {
  const folder = mkdtempSync(join(tmpdir(), "omb-board-store-"));
  folders.push(folder);
  const frames: BoardBroadcast[] = [];
  let clock = Date.parse("2026-11-15T00:00:00.000Z");
  const board = new BoardStore({ file: join(folder, "board.json"), broadcast: (frame) => frames.push(frame), now: () => new Date(clock += 1_000) });
  return { folder, board, frames };
}

describe("BoardStore", () => {
  it("creates projects, subprojects and milestones, and refuses an accepted milestone without evidence", () => {
    const { board, frames } = store();
    const project = board.createProject({ name: "创意板" });
    const subproject = board.createSubproject({ projectId: project.id, name: "看板 v1" });
    const milestone = board.createMilestone({ projectId: project.id, subprojectId: subproject.id, title: "前端联调" });
    expect(board.state().version).toBe(3);
    expect(frames.map((frame) => frame.kind)).toEqual(["board", "board", "board"]);

    expect(() => board.patchMilestone(milestone.id, { status: "accepted" })).toThrowError(/verdict and evidence/);
    expect(() => board.patchMilestone(milestone.id, { status: "accepted", verdict: "通过" })).toThrowError(/verdict and evidence/);
    const accepted = board.patchMilestone(milestone.id, { status: "accepted", verdict: "通过", evidence: "npm run check exit 0" });
    expect(accepted.status).toBe("accepted");
    expect(accepted.verdict).toBe("通过");
    expect(accepted.evidence).toBe("npm run check exit 0");
    expect(board.version()).toBe(4);
  });

  it("attributes a conversation once, keeps botId fixed, and makes done depend on an accepted verdict", () => {
    const { board } = store();
    const project = board.createProject({ name: "创意板" });
    const task = board.putTask({ threadId: "t1", botId: "b1", projectId: project.id, phase: "build", status: "in_progress", owner: "Pixel" });
    expect(task).toMatchObject({ threadId: "t1", botId: "b1", projectId: project.id, phase: "build", status: "in_progress" });
    expect(() => board.putTask({ threadId: "t1", botId: "b2" })).toThrowError(/another bot/);
    expect(() => board.putTask({ threadId: "t1", botId: "b1", phase: "done" })).toThrowError(/phaseEvidence/);
    const phased = board.putTask({ threadId: "t1", botId: "b1", phase: "done", phaseEvidence: "https://example.test/release" });
    expect(phased.phase).toBe("done");
    expect(phased.status).toBe("in_progress");

    const accepted = board.verdict("t1", { decision: "accepted", evidence: "真实 API 通过" });
    expect(accepted.phase).toBe("done");
    expect(accepted.status).toBe("done");
    expect(accepted.verdict).toMatchObject({ decision: "accepted", evidence: "真实 API 通过" });

    const rejected = board.verdict("t1", { decision: "rejected", evidence: "回归失败" });
    expect(rejected.phase).toBe("done");
    expect(rejected.status).toBe("review");

    const stillBuilding = board.putTask({ threadId: "t2", botId: "b1", projectId: project.id, phase: "build" });
    const acceptedWhileBuilding = board.verdict("t2", { decision: "accepted", evidence: "验收通过" });
    expect(stillBuilding.phase).toBe("build");
    expect(acceptedWhileBuilding.phase).toBe("build");
    expect(acceptedWhileBuilding.status).toBe("done");
  });

  it("rejects a stale version instead of overwriting someone else's board", () => {
    const { board } = store();
    const project = board.createProject({ name: "创意板" });
    const read = board.version();
    board.createSubproject({ projectId: project.id, name: "看板 v1" });
    expect(() => board.createSubproject({ projectId: project.id, name: "看板 v2", version: read })).toThrowError(/version/);
    try {
      board.createSubproject({ projectId: project.id, name: "看板 v2", version: read });
    } catch (error) {
      expect(error).toBeInstanceOf(BoardError);
      expect((error as BoardError).code).toBe("BOARD_VERSION_CONFLICT");
    }
  });

  it("rejects a subproject from another project and a looping parent chain", () => {
    const { board } = store();
    const one = board.createProject({ name: "一" });
    const two = board.createProject({ name: "二" });
    const sub = board.createSubproject({ projectId: one.id, name: "一/子" });
    expect(() => board.putTask({ threadId: "t1", botId: "b1", projectId: two.id, subprojectId: sub.id })).toThrowError(/subproject/);
    board.putTask({ threadId: "t1", botId: "b1", projectId: one.id });
    board.putTask({ threadId: "t2", botId: "b1", projectId: one.id, parentThreadId: "t1" });
    expect(() => board.putTask({ threadId: "t1", botId: "b1", parentThreadId: "t2" })).toThrowError(/loops back/);
  });

  it("persists across a restart and unclassifies without deleting the conversation", () => {
    const first = store();
    const project = first.board.createProject({ name: "创意板" });
    first.board.putTask({ threadId: "t1", botId: "b1", projectId: project.id });
    first.board.putTask({ threadId: "t2", botId: "b1", projectId: project.id, parentThreadId: "t1" });
    const file = join(first.folder, "board.json");
    const reopened = new BoardStore({ file });
    expect(reopened.state().tasks.map((task) => task.threadId)).toEqual(["t1", "t2"]);
    expect(reopened.removeTask("t1", {})).toBe(true);
    expect(reopened.state().tasks.map((task) => task.threadId)).toEqual(["t2"]);
    expect(reopened.state().tasks[0]!.parentThreadId).toBeUndefined();
  });

  it("keeps project, subproject, task and milestone accountability fields", () => {
    const { board } = store();
    const actor = { label: "m@example.com", email: "m@example.com" };
    const project = board.createProject({
      name: "创意板", owner: "朱明跃", ownerEmail: "owner@example.com", goal: "交付", acceptance: "上线", status: "active",
      visibility: { people: ["m@example.com"] },
    }, actor);
    expect(project).toMatchObject({ owner: "朱明跃", ownerEmail: "owner@example.com", goal: "交付", acceptance: "上线", status: "active" });
    expect(board.audit(1)[0]).toMatchObject({ action: "project.create", target: { kind: "project", id: project.id }, actor: { email: "m@example.com" } });

    const subproject = board.createSubproject({
      projectId: project.id, name: "财税", phase: "test", phaseEvidence: "前后端已联调", owner: "唐僧",
      ownerEmail: "tang@example.com", deliverable: "办理卡", acceptance: "双账号验收", status: "active",
    }, actor);
    expect(subproject).toMatchObject({ phase: "test", phaseEvidence: "前后端已联调", owner: "唐僧", deliverable: "办理卡", acceptance: "双账号验收" });

    const task = board.putTask({
      threadId: "t1", botId: "b1", projectId: project.id, subprojectId: subproject.id, ownerEmail: "m@example.com",
      blocked: true, blockedReason: "等待账号",
    }, actor);
    expect(task).toMatchObject({ blocked: true, blockedReason: "等待账号", ownerEmail: "m@example.com" });
    const accepted = board.verdict("t1", { decision: "accepted", evidence: "真实 API 通过" }, actor);
    expect(accepted.verdict).toMatchObject({ decision: "accepted", by: "m@example.com" });

    const milestone = board.createMilestone({
      projectId: project.id, subprojectId: subproject.id, title: "上线", acceptance: "生产验收", owner: "唐僧",
    }, actor);
    const achieved = board.patchMilestone(milestone.id, { status: "accepted", verdict: "通过", evidence: "回执" }, actor);
    expect(achieved).toMatchObject({ acceptedBy: "m@example.com", acceptance: "生产验收", owner: "唐僧" });
    const edited = board.patchMilestone(milestone.id, { title: "上线 v2" }, { label: "other@example.com", email: "other@example.com" });
    expect(edited.acceptedBy).toBe("m@example.com");
    expect(board.audit(10).map((entry) => entry.action)).toEqual([
      "project.create", "subproject.create", "task.update", "task.verdict", "milestone.create", "milestone.update", "milestone.update",
    ]);
  });

  it("records task status done only with an accepted verdict and anchors a dispatched child to its parent", () => {
    const { board } = store();
    const project = board.createProject({ name: "创意板" });
    const subproject = board.createSubproject({ projectId: project.id, name: "财税", phase: "build", phaseEvidence: "https://example.test/build" });
    board.putTask({ threadId: "parent", botId: "b1", projectId: project.id, subprojectId: subproject.id, phase: "build" });
    expect(() => board.putTask({ threadId: "parent", botId: "b1", status: "done" })).toThrowError(/accepted verdict/);
    const child = board.attachDispatch({ parentThreadId: "parent", botId: "b1", threadId: "child", actor: { label: "Lin" } });
    expect(child).toMatchObject({ threadId: "child", parentThreadId: "parent", projectId: project.id, subprojectId: subproject.id, phase: "build", status: "todo" });
    expect(board.state().tasks.map((task) => task.threadId)).toEqual(["parent", "child"]);
    expect(() => board.putTask({ threadId: "parent", botId: "b1", subprojectId: undefined, projectId: project.id })).not.toThrow();
  });

  it("links a batch in one commit and records a failed batch without touching tasks", () => {
    const { board } = store();
    const project = board.createProject({ name: "创意板" });
    const version = board.version();
    const result = board.batchAssign({
      projectId: project.id, version,
      links: [{ threadId: "t1", botId: "b1" }, { threadId: "t2", botId: "b1" }],
    }, { label: "Lin", email: "lin@example.com" });
    expect(result.count).toBe(2);
    expect(board.version()).toBe(version + 1);
    expect(board.state().tasks.map((task) => task.threadId)).toEqual(["t1", "t2"]);
    expect(board.audit(1)[0]).toMatchObject({ action: "task.batch", count: 2, actor: { label: "Lin", email: "lin@example.com" }, target: { kind: "project", id: project.id } });

    const before = board.version();
    expect(() => board.batchAssign({
      projectId: project.id, version: before,
      links: [{ threadId: "t3", botId: "b1" }, { threadId: "bad id", botId: "b1" }],
    }, { label: "Lin", email: "lin@example.com" })).toThrowError(/cannot be linked/);
    expect(board.version()).toBe(before);
    expect(board.state().tasks.some((task) => task.threadId === "t3")).toBe(false);
    expect(board.audit(1)[0]).toMatchObject({ action: "task.batch", count: 2, actor: { label: "Lin", email: "lin@example.com" } });
    expect(board.audit(1)[0]!.reason).toContain("not a valid id");
  });

  it("requires phase evidence on every subproject transition and names the actor", () => {
    const { board } = store();
    const project = board.createProject({ name: "创意板" });
    const subproject = board.createSubproject({
      projectId: project.id, name: "财税", owner: "唐僧", deliverable: "办理卡", acceptance: "双账号验收",
    });
    expect(() => board.patchSubproject(subproject.id, { phase: "build" })).toThrowError(/phaseEvidence/);
    const built = board.patchSubproject(subproject.id, { phase: "build", phaseEvidence: "前后端联调通过" }, { label: "Lin", email: "lin@example.com" });
    expect(built).toMatchObject({ phase: "build", phaseEvidence: "前后端联调通过" });
    expect(() => board.patchSubproject(subproject.id, { phase: "done" })).toThrowError(/phaseEvidence/);
    expect(() => board.patchSubproject(subproject.id, { phase: "done", phaseEvidence: "上线了" })).toThrowError(/online receipt|business acceptance/);
    const done = board.patchSubproject(subproject.id, { phase: "done", phaseEvidence: "https://example.test/receipt/42" }, { label: "唐僧", email: "tang@example.com" });
    expect(done).toMatchObject({ phase: "done", phaseEvidence: "https://example.test/receipt/42" });
    expect(board.audit(1)[0]).toMatchObject({ action: "subproject.update", actor: { label: "唐僧", email: "tang@example.com" } });
    expect(() => board.patchSubproject(subproject.id, { phaseEvidence: null })).toThrowError(/cannot drop/);
  });

  it("migrates a version-1 board with a backup, then refuses a newer file without touching it", () => {
    const folder = mkdtempSync(join(tmpdir(), "omb-board-v1-"));
    folders.push(folder);
    const legacy = {
      version: 1, boardVersion: 4,
      projects: [{ id: "p_1", name: "创意板", createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z" }],
      subprojects: [{ id: "sp_1", projectId: "p_1", name: "财税", phase: "done", createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z" }],
      milestones: [], tasks: [], updatedAt: "2026-11-15T00:00:00.000Z",
    };
    writeFileSync(join(folder, "board.json"), JSON.stringify(legacy));
    const board = new BoardStore({ file: join(folder, "board.json") });
    expect(board.state().projects[0]).toMatchObject({ visibility: "admins", status: "active" });
    expect(board.state().subprojects[0]).toMatchObject({ phase: "discovery", status: "active" });
    expect(board.state().subprojects[0]!.phaseEvidence).toBeUndefined();
    board.createProject({ name: "新项目" });
    const migrated = JSON.parse(readFileSync(join(folder, "board.json"), "utf8"));
    expect(migrated.version).toBe(2);
    expect(migrated.audit.at(-1)).toMatchObject({ action: "project.create" });
    expect(existsSync(join(folder, "board.json.v1.bak"))).toBe(true);
    const backup = readFileSync(join(folder, "board.json.v1.bak"), "utf8");
    expect(JSON.parse(backup).version).toBe(1);
    // Rollback: putting the version-1 bytes back is enough; the store again migrates them in memory.
    writeFileSync(join(folder, "board.json"), backup);
    expect(new BoardStore({ file: join(folder, "board.json") }).state().projects.map((project) => project.id)).toEqual(["p_1"]);

    const newer = JSON.stringify({ version: 3, boardVersion: 9, projects: [], subprojects: [], milestones: [], tasks: [], updatedAt: "x" });
    writeFileSync(join(folder, "board.json"), newer);
    const future = new BoardStore({ file: join(folder, "board.json") });
    expect(() => future.state()).toThrowError(/not supported/);
    expect(readFileSync(join(folder, "board.json"), "utf8")).toBe(newer);
  });

  it("repairs a hand-edited file instead of throwing", () => {
    const folder = mkdtempSync(join(tmpdir(), "omb-board-broken-"));
    folders.push(folder);
    writeFileSync(join(folder, "board.json"), JSON.stringify({
      version: 1, boardVersion: 7,
      projects: [{ id: "p_1", name: "创意板", createdAt: "x", updatedAt: "x" }],
      subprojects: [{ id: "sp_1", projectId: "p_missing", name: "孤儿", createdAt: "x", updatedAt: "x" }],
      milestones: [{ id: "ms_1", projectId: "p_missing", title: "孤儿", status: "planned", createdAt: "x", updatedAt: "x" }],
      tasks: [{ threadId: "t1", botId: "b1", projectId: "p_missing", phase: "build", status: "todo", createdAt: "x", updatedAt: "x" }],
      updatedAt: "x",
    }));
    const board = new BoardStore({ file: join(folder, "board.json") });
    expect(board.state()).toMatchObject({ version: 7, subprojects: [], milestones: [], tasks: [] });
    board.createProject({ name: "新项目" });
    expect(JSON.parse(readFileSync(join(folder, "board.json"), "utf8")).boardVersion).toBe(8);
  });
});
