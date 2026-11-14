import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(() => board.putTask({ threadId: "t1", botId: "b1", phase: "done" })).toThrowError(/accepted verdict/);

    const accepted = board.verdict("t1", { decision: "accepted", evidence: "真实 API 通过" });
    expect(accepted.phase).toBe("done");
    expect(accepted.status).toBe("done");
    expect(accepted.verdict).toMatchObject({ decision: "accepted", evidence: "真实 API 通过" });

    const rejected = board.verdict("t1", { decision: "rejected", evidence: "回归失败" });
    expect(rejected.phase).toBe("release_ready");
    expect(rejected.status).toBe("review");
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
