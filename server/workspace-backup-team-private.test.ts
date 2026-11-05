import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { CLOUD_OUTSIDE_KEY } from "./cloud-sharing.ts";
import { openRuntimeStore } from "./runtime/store.ts";
import type { Assignment } from "./runtime/types.ts";
import { createWorkspaceBackupSnapshot, stagedWorkspaceData, stageWorkspaceBackup } from "./workspace-backup.ts";
import { ensureMemoryIndex } from "./message-db-memory-index.ts";
import { omittedAsTeamPrivate, stripTeamPrivate, TEAM_PRIVATE_NOTE, teamPrivateAttachments, teamPrivateThreads, withoutTeamPrivate } from "./workspace-backup-team-private.ts";

const BOB = "p_bobbobbobbobbobbobbob1";
const PASSWORD = "correct horse battery staple";
const scratch: string[] = [];
const envBefore = process.env.OMB_CLOUD_ROLE;
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  if (envBefore === undefined) delete process.env.OMB_CLOUD_ROLE; else process.env.OMB_CLOUD_ROLE = envBefore;
});
const directory = () => { const path = mkdtempSync(join(tmpdir(), "omb-team-export-")); scratch.push(path); return path; };
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const file = (path: string, text = "x") => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };

const assignment = (id: string, threadId: string): Assignment => ({
  id, rootId: id, depth: 0, origin: { kind: "person", source: "chat", quote: "Ship it" }, requester: { kind: "person", threadId },
  assignee: { botId: "bot", destination: { kind: "standing_thread", threadId: `${threadId}-work` } }, mode: "work", reply: "resume", brief: "Ship it",
  status: "completed", outcome: "done", level: "ask", levelSource: "own", executions: 1, restarts: 0, createdAt: 1_000, lastActivityAt: 2_000, finishedAt: 2_000, result: "Built", rework: false, version: 1,
});

/** A Team Cloud's data folder: Bob's private chat with the bot, the bot's main chat, a room, and what each leaves behind. */
function teamData(root: string): void {
  json(join(root, "thread-starters.json"), { "bob-chat": BOB, "room-thread": BOB, "outside-thread": CLOUD_OUTSIDE_KEY });
  json(join(root, "groups.json"), [{ id: "room", threadId: "room-thread", memberIds: ["bot"], tasks: [{ threadId: "room-thread" }] }]);
  json(join(root, "bots.json"), [{ id: "bot", name: "Scout", threadId: "main", avatarUrl: "/api/attachments/avatar.png", tasks: [{ threadId: "main", title: "Scout" }, { threadId: "bob-chat", title: "Bob's" }, { threadId: "outside-thread", title: "Webhook" }] },
    { id: "bobs-own", name: "MausBot", threadId: "bobs-own-main", defaultBot: { person: "bob@acme.test" }, tasks: [{ threadId: "bobs-own-main", title: "MausBot" }, { threadId: "bobs-inbox", title: "Inbox" }] }]);
  json(join(root, "person-inbox.json"), { items: [{ text: "Bob's inbox line" }] });
  file(join(root, "workspaces", "bobs-own", "MEMORY.md"), "Bob's own bot's notes");
  json(join(root, "config.json"), { language: "en" });
  for (const name of ["bobs.png", "both.png", "unsent.png", "avatar.png"]) file(join(root, "attachments", name));
  file(join(root, "people", BOB, "uploads.json"), JSON.stringify(["unsent.png", "avatar.png"]));
  file(join(root, "workspaces", "bot", "MEMORY.md"), "team notes");
  file(join(root, "workspaces", `bot--member-${BOB}`, "MEMORY.md"), "Bob's notes");
  file(join(root, "workspaces", "bot--room-room", "MEMORY.md"), "room notes");
  file(join(root, "task-workspaces", "bot", "main", "plan.md"), "shared plan");
  file(join(root, "task-workspaces", "bot", "bob-chat", "draft.md"), "Bob's draft");
  file(join(root, "people", BOB, "about.json"), "{\"aboutMe\":\"interviewing elsewhere\"}");
  const db = new DatabaseSync(join(root, "messages.db"));
  db.exec("CREATE TABLE messages(thread_id TEXT, id TEXT, at INTEGER, role TEXT, kind TEXT, text TEXT, json TEXT, PRIMARY KEY(thread_id,id)); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY, active_leaf_id TEXT);"
    + " CREATE TABLE chat_followups(id TEXT PRIMARY KEY, kind TEXT, owner_id TEXT, thread_id TEXT, send_id TEXT, status TEXT, payload TEXT);"
    + " CREATE TABLE notification_log(id TEXT PRIMARY KEY, at INTEGER, kind TEXT, bot_id TEXT, bot_name TEXT, thread_id TEXT, group_id TEXT, title TEXT, body TEXT, avatar_url TEXT, for_person TEXT, read INTEGER);");
  ensureMemoryIndex(db);
  db.exec("CREATE TABLE command_receipts(kind TEXT, key TEXT, at INTEGER, result TEXT, PRIMARY KEY (kind, key))");
  db.prepare("INSERT INTO command_receipts VALUES ('memory', 'k', 1, ?)").run("Bob's receipted secret");
  for (const [bot, text] of [["bot", "team notes"], [`bot--member-${BOB}`, "Bob's noted secret"], ["bobs-own", "Bob's own noted secret"]]) {
    db.prepare("INSERT INTO memory_files(bot_id, path, text, mtime_ms, bytes) VALUES (?, 'MEMORY.md', ?, 1, 1)").run(bot!, text!);
  }
  for (const [thread, text] of [["main", "team question"], ["bob-chat", "Bob's secret"], ["bobs-inbox", "Bob's inbox secret"], ["room-thread", "room talk"], ["outside-thread", "webhook event"]]) {
    const attached = thread === "bob-chat" ? ["attachments/bobs.png", "attachments/both.png"] : thread === "main" ? ["attachments/both.png"] : [];
    db.prepare("INSERT INTO messages VALUES (?, ?, 1, 'user', 'text', ?, ?)").run(thread!, `${thread}-m1`, text!, JSON.stringify({ id: `${thread}-m1`, text, attachments: attached.map((path) => ({ path })) }));
    db.prepare("INSERT INTO thread_state VALUES (?, ?)").run(thread, `${thread}-m1`);
    db.prepare("INSERT INTO chat_followups VALUES (?, 'bot', 'bot', ?, 's', 'pending', ?)").run(`${thread}-f`, thread, JSON.stringify({ text }));
    db.prepare("INSERT INTO notification_log VALUES (?, 1, 'mention', 'bot', 'Scout', ?, NULL, ?, ?, NULL, ?, 0)").run(`${thread}-n`, thread, text, text, BOB);
  }
  db.close();
  const runtime = openRuntimeStore(join(root, "runtime.db"));
  try {
    runtime.insert(assignment("as-team", "main"), { kind: "enqueued", at: 1_000 });
    runtime.insert(assignment("as-bob", "bob-chat"), { kind: "enqueued", at: 1_000 });
  } finally { runtime.close(); }
}

const table = (path: string, sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
const textOf = (path: string) => readFileSync(path, "utf8");

async function exported(root: string): Promise<{ data: string; warnings: string[] }> {
  const made = await createWorkspaceBackupSnapshot(root, { password: PASSWORD, appVersion: "test" });
  const destination = directory();
  const staged = await stageWorkspaceBackup(destination, made.path, { password: PASSWORD, currentAppVersion: "test" });
  return { data: stagedWorkspaceData(destination, staged.id).data, warnings: made.summary.warnings };
}

describe("what a Team Cloud's export leaves out (the private sentence: not the Owner, not an admin)", () => {
  it("knows the private conversations from who opened them: a member's own chats, never the team's, a room's or an outside marker's", () => {
    const root = directory();
    teamData(root);
    const files = { starters: join(root, "thread-starters.json"), groups: join(root, "groups.json"), bots: join(root, "bots.json") };
    expect(teamPrivateThreads(files, { OMB_CLOUD_ROLE: "home" })).toBeNull();
    const privacy = teamPrivateThreads(files, { OMB_CLOUD_ROLE: "team" })!;
    expect([...privacy.threads].sort()).toEqual(["bob-chat", "bobs-inbox", "bobs-own-main"]);
    expect([...privacy.bots]).toEqual(["bobs-own"]);
    expect(omittedAsTeamPrivate("workspaces/bobs-own/MEMORY.md", privacy)).toBe(true);
    expect(omittedAsTeamPrivate("person-inbox.json", privacy)).toBe(true);
    const attachments = teamPrivateAttachments(root, join(root, "messages.db"), privacy);
    expect([...attachments].sort()).toEqual(["bobs.png", "unsent.png"]);
    expect(omittedAsTeamPrivate("attachments/bobs.png", { ...privacy, attachments })).toBe(true);
    expect(omittedAsTeamPrivate("attachments/both.png", { ...privacy, attachments })).toBe(false);
    expect(omittedAsTeamPrivate(`workspaces/bot--member-${BOB}/MEMORY.md`, privacy)).toBe(true);
    expect(omittedAsTeamPrivate("workspaces/bot--room-room/MEMORY.md", privacy)).toBe(false);
    expect(omittedAsTeamPrivate("workspaces/bot/MEMORY.md", privacy)).toBe(false);
    expect(omittedAsTeamPrivate("task-workspaces/bot/bob-chat/draft.md", privacy)).toBe(true);
    expect(omittedAsTeamPrivate("task-workspaces/bot/main/plan.md", privacy)).toBe(false);
    expect(omittedAsTeamPrivate(`people/${BOB}/about.json`, privacy)).toBe(true);
    expect(omittedAsTeamPrivate("peoplesoft/x", privacy)).toBe(false);
    for (const kept of ["events/bob-chat.ndjson", "native/bob-chat.ndjson", `memory-journal/bot--member-${BOB}.ndjson`]) expect(omittedAsTeamPrivate(kept, privacy), kept).toBe(true);
    for (const shared of ["events/main.ndjson", "native/main.ndjson", "memory-journal/bot.ndjson", "memory-journal/bot--room-room.ndjson"]) expect(omittedAsTeamPrivate(shared, privacy), shared).toBe(false);
    expect(withoutTeamPrivate([{ id: "bot", tasks: [{ threadId: "main" }, { threadId: "bob-chat" }] }, { id: "bobs-own", tasks: [] }], privacy)).toEqual([{ id: "bot", tasks: [{ threadId: "main" }] }]);
  });

  it("strips the private conversations' rows from the snapshot databases and rebuilds them, so no freed page keeps their words", () => {
    const root = directory();
    teamData(root);
    const messages = join(root, "messages.db"), runtime = join(root, "runtime.db");
    stripTeamPrivate({ messages, runtime }, { threads: new Set(["bob-chat", "bobs-inbox"]), bots: new Set(["bobs-own"]), attachments: new Set() });
    for (const sql of ["SELECT thread_id AS id FROM messages", "SELECT thread_id AS id FROM thread_state", "SELECT thread_id AS id FROM chat_followups", "SELECT thread_id AS id FROM notification_log"]) {
      expect(table(messages, sql).map((row) => row.id).sort()).toEqual(["main", "outside-thread", "room-thread"]);
    }
    expect(table(runtime, "SELECT id FROM assignments").map((row) => row.id)).toEqual(["as-team"]);
    expect(table(runtime, "SELECT assignment_id AS id FROM assignment_events").map((row) => row.id)).toEqual(["as-team"]);
    expect(table(messages, "SELECT bot_id AS id FROM memory_files").map((row) => row.id)).toEqual(["bot"]);
    expect(textOf(messages).toLowerCase()).not.toContain("secret");
    expect(textOf(messages)).toContain("team question");
  });

  it("on a Team Cloud the export carries the team's things and nothing of Bob's alone; off a team everything stays", async () => {
    process.env.OMB_CLOUD_ROLE = "team";
    const root = directory();
    teamData(root);
    const team = await exported(root);
    expect(team.warnings).toContain(TEAM_PRIVATE_NOTE);
    expect(existsSync(join(team.data, "workspaces", "bot", "MEMORY.md"))).toBe(true);
    expect(existsSync(join(team.data, "workspaces", "bot--room-room", "MEMORY.md"))).toBe(true);
    expect(existsSync(join(team.data, "task-workspaces", "bot", "main", "plan.md"))).toBe(true);
    expect(existsSync(join(team.data, "workspaces", `bot--member-${BOB}`))).toBe(false);
    expect(existsSync(join(team.data, "task-workspaces", "bot", "bob-chat"))).toBe(false);
    expect(existsSync(join(team.data, "people"))).toBe(false);
    const bots = JSON.parse(textOf(join(team.data, "bots.json"))) as Array<{ tasks: Array<{ threadId: string }> }>;
    expect(bots).toHaveLength(1);
    expect(bots[0]!.tasks.map((task) => task.threadId)).toEqual(["main", "outside-thread"]);
    expect(existsSync(join(team.data, "person-inbox.json"))).toBe(false);
    expect(existsSync(join(team.data, "attachments", "bobs.png"))).toBe(false);
    expect(existsSync(join(team.data, "attachments", "unsent.png"))).toBe(false);
    expect(existsSync(join(team.data, "attachments", "both.png"))).toBe(true);
    expect(existsSync(join(team.data, "attachments", "avatar.png"))).toBe(true);
    expect(existsSync(join(team.data, "workspaces", "bobs-own"))).toBe(false);
    expect(table(join(team.data, "messages.db"), "SELECT thread_id AS id FROM messages").map((row) => row.id).sort()).toEqual(["main", "outside-thread", "room-thread"]);
    expect(table(join(team.data, "runtime.db"), "SELECT id FROM assignments").map((row) => row.id)).toEqual(["as-team"]);
    expect(textOf(join(team.data, "messages.db")).toLowerCase()).not.toContain("secret");

    process.env.OMB_CLOUD_ROLE = "home";
    const own = directory();
    teamData(own);
    const home = await exported(own);
    expect(home.warnings).not.toContain(TEAM_PRIVATE_NOTE);
    expect(existsSync(join(home.data, "workspaces", `bot--member-${BOB}`, "MEMORY.md"))).toBe(true);
    expect(table(join(home.data, "messages.db"), "SELECT thread_id AS id FROM messages").map((row) => row.id).sort()).toEqual(["bob-chat", "bobs-inbox", "main", "outside-thread", "room-thread"]);
  }, 60_000);
});
