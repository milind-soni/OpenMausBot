import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { attachBoardTask } from "./attach.ts";
import { BoardStore } from "./store.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const admin: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const member: RequestAuth = { kind: "session", scopes: ["client"], via: "cookie", session: { id: "s1" } as never };

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "omb-board-attach-"));
  folders.push(folder);
  const board = new BoardStore({ file: join(folder, "board.json") });
  return { board, deps: { board, canManage: (auth: RequestAuth) => auth.scopes.includes("admin") } };
}

describe("attachBoardTask", () => {
  it("attributes a just-created conversation and returns the new state", () => {
    const { board, deps } = fixture();
    const project = board.createProject({ name: "创意板" });
    const result = attachBoardTask(deps, admin, { botId: "b1", threadId: "t1", knownThread: true, value: { projectId: project.id, phase: "build", owner: "Pixel" } });
    expect(result).toMatchObject({ ok: true, task: { threadId: "t1", botId: "b1", projectId: project.id, phase: "build" }, state: { version: 2 } });
  });

  it("refuses a member, a missing conversation, an unsupported field, and a done without evidence", () => {
    const { deps } = fixture();
    expect(attachBoardTask(deps, member, { botId: "b1", threadId: "t1", knownThread: true, value: {} })).toMatchObject({
      ok: false, status: 403, code: "BOARD_FORBIDDEN",
    });
    expect(attachBoardTask(deps, admin, { botId: "b1", threadId: "t1", knownThread: false, value: {} })).toMatchObject({
      ok: false, status: 400, code: "BOARD_INVALID",
    });
    expect(attachBoardTask(deps, admin, { botId: "b1", threadId: "t1", knownThread: true, value: { color: "red" } })).toMatchObject({
      ok: false, status: 400, code: "BOARD_INVALID",
    });
    expect(attachBoardTask(deps, admin, { botId: "b1", threadId: "t1", knownThread: true, value: { phase: "done" } })).toMatchObject({
      ok: false, status: 422, code: "BOARD_NEEDS_EVIDENCE",
    });
  });
});
