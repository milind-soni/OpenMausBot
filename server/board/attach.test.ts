import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { VisibleSet } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import { attachBoardTask } from "./attach.ts";
import { BoardStore } from "./store.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const admin: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const member: RequestAuth = { kind: "session", scopes: ["client"], via: "cookie", session: { id: "s1", email: "m@example.com" } as never };

function visible(): VisibleSet {
  return { everything: false, thread: (id: string) => id === "t1", bot: (id: string) => id === "b1", hides: (id: string) => id !== "t1" } as unknown as VisibleSet;
}

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

  it("lets a member attach their own visible conversation and forces the owner to themselves", () => {
    const { board } = fixture();
    const project = board.createProject({ name: "创意板", visibility: { people: ["m@example.com"] } });
    const deps = { board, canManage: (auth: RequestAuth) => auth.scopes.includes("admin"), visibleFor: () => visible() };
    const result = attachBoardTask(deps, member, {
      botId: "b1", threadId: "t1", knownThread: true, value: { projectId: project.id, phase: "build", ownerEmail: "other@example.com" },
    });
    expect(result).toMatchObject({ ok: false, status: 403, code: "BOARD_FORBIDDEN" });
    const own = attachBoardTask(deps, member, {
      botId: "b1", threadId: "t1", knownThread: true, value: { projectId: project.id, phase: "build" },
    });
    expect(own).toMatchObject({ ok: true, task: { threadId: "t1", ownerEmail: "m@example.com" }, state: { tasks: [{ threadId: "t1" }] } });
    const hidden = board.createProject({ name: "私有", visibility: "admins" });
    expect(attachBoardTask(deps, member, {
      botId: "b1", threadId: "t1", knownThread: true, value: { projectId: hidden.id },
    })).toMatchObject({ ok: false, status: 403, code: "BOARD_FORBIDDEN" });
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
