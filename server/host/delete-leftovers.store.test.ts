import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { journalFile } from "../memory-journal.ts";
import * as mdb from "../message-db.ts";
import { Store } from "../store.ts";
import { createDeleteLeftovers, engineSessionFolders, type DeleteLeftoversDeps } from "./delete-leftovers.ts";
import { memoryLayerRecords } from "./team-member-left.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const SESSION = "11111111-1111-4111-8111-111111111111";
const UPLOAD = "00000001-0000-4000-8000-000000000000.png";
const HOME = join(DATA_DIR, "fixture-engine-home");

function put(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x");
  return path;
}

function fixture(over: Partial<DeleteLeftoversDeps> = {}) {
  const store = new Store(selection);
  const warnings: string[] = [];
  const leftovers = createDeleteLeftovers({
    dataDir: DATA_DIR,
    store,
    threadsReferencing: mdb.threadsReferencing,
    keptAttachments: () => new Set(),
    deleteAttachment: (name) => rmSync(join(DATA_DIR, "attachments", name)),
    engineFolders: () => engineSessionFolders(DATA_DIR, [{ HOME }]),
    layers: memoryLayerRecords,
    defer: () => {},
    warn: (line) => { warnings.push(line); },
    ...over,
  });
  const bot = store.createBot({ name: "Scout" });
  const task = store.createTask(bot.id, "Launch post", false)!;
  store.appendMessage(task.threadId, { role: "user", kind: "text", text: `![image](/api/attachments/${UPLOAD})` });
  store.setResumeCursor(bot.id, "claude", SESSION, task.threadId);
  const files = {
    upload: put(join(DATA_DIR, "attachments", UPLOAD)),
    session: put(join(HOME, ".claude", "projects", "-work", `${SESSION}.jsonl`)),
    boxUploads: put(join(DATA_DIR, "box-uploads", bot.id, task.threadId, UPLOAD)),
  };
  return { store, bot, task, files, warnings, leftovers };
}

describe("deleting through the store", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("removes a deleted conversation's upload, engine session and box uploads", () => {
    const { store, bot, task, files, leftovers } = fixture();
    expect(store.deleteTask(bot.id, task.threadId)).not.toBeNull();
    leftovers.flush();
    expect(Object.values(files).filter(existsSync)).toEqual([]);
  });

  it("keeps an upload a conversation that stays also shows", () => {
    const { store, bot, task, files, leftovers } = fixture();
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `![image](/api/attachments/${UPLOAD})` });
    store.deleteTask(bot.id, task.threadId);
    leftovers.flush();
    expect([existsSync(files.upload), existsSync(files.session)]).toEqual([true, false]);
  });

  it("removes nothing when the delete itself fails", () => {
    const { store, bot, task, files, leftovers } = fixture();
    vi.spyOn(store as unknown as { commitBotChange: () => void }, "commitBotChange").mockImplementationOnce(() => { throw new Error("fixture write failure"); });
    expect(() => store.deleteTask(bot.id, task.threadId)).toThrow("fixture write failure");
    leftovers.flush();
    expect(store.messagesFor(task.threadId)).toHaveLength(1);
    expect(Object.values(files).filter((path) => !existsSync(path))).toEqual([]);
  });

  it("deletes the conversation even when the cleanup fails", () => {
    const { store, bot, task, files, warnings, leftovers } = fixture({
      deleteAttachment: () => { throw new Error("disk is read-only"); },
      engineFolders: () => { throw new Error("no engine folders"); },
    });
    expect(store.deleteTask(bot.id, task.threadId)).not.toBeNull();
    expect(() => leftovers.flush()).not.toThrow();
    expect(store.taskByThread(bot.id, task.threadId)).toBeFalsy();
    expect(mdb.threadsReferencing(UPLOAD)).toEqual([]);
    expect(existsSync(files.upload)).toBe(true);
    expect(warnings).toEqual([
      `delete leftovers: the upload ${UPLOAD} stayed behind: disk is read-only`,
      "delete leftovers: engine sessions stayed behind: no engine folders",
    ]);
  });

  it("removes a deleted bot's conversations' files, checkpoints, memory layers and memory journal", () => {
    const { store, bot, files, leftovers } = fixture();
    const layer = `${bot.id}--member-p_bobbobbobbobbobbobbobb`;
    const mine = [
      ...Object.values(files),
      put(join(DATA_DIR, "checkpoints", bot.id, "0123456789abcdef", ".git", "HEAD")),
      put(join(DATA_DIR, "workspaces", layer, "memory", "notes.md")),
      put(journalFile(layer)),
      put(journalFile(bot.id)),
    ];
    const other = store.createBot({ name: "Ledger" });
    const others = [put(join(DATA_DIR, "checkpoints", other.id, "0123456789abcdef", ".git", "HEAD")), put(journalFile(other.id))];
    expect(store.deleteBot(bot.id)).toBe(true);
    leftovers.flush();
    expect(mine.filter(existsSync)).toEqual([]);
    expect(others.filter((path) => !existsSync(path))).toEqual([]);
  });

  it("removes a deleted group chat's uploads", () => {
    const { store, bot, leftovers } = fixture();
    const other = store.createBot({ name: "Ledger" });
    const room = store.createGroup("Launch team", [bot.id, other.id], false);
    const name = "00000002-0000-4000-8000-000000000000.png";
    const upload = put(join(DATA_DIR, "attachments", name));
    store.appendMessage(room.threadId, { role: "user", kind: "text", text: `![image](/api/attachments/${name})` });
    expect(store.deleteGroup(room.id)).toBe(true);
    leftovers.flush();
    expect(existsSync(upload)).toBe(false);
  });
});
