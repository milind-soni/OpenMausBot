import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { activePath, mergeStagedChats, mergeThread, planChatMerge, type ChatsSide, type ThreadRows } from "./cloud-chat-merge.ts";
import { DATA_DIR } from "./config.ts";
import { Store, type Message, type TaskRecord } from "./store.ts";

const line = (id: string, at: number, parentId: string | null, role: "user" | "bot" = "user", extra: Partial<Message> = {}): Message =>
  ({ id, at, parentId, role, kind: "text", text: `${id} says hi`, ...extra });
/** A chain in order: each row follows the one before it. */
const chain = (...rows: Array<[string, number, ("user" | "bot")?]>): Message[] =>
  rows.map(([id, at, role], index) => line(id, at, index ? rows[index - 1]![0] : null, role ?? (index % 2 ? "bot" : "user")));
const thread = (rows: Message[], leaf = rows.at(-1)?.id ?? null): ThreadRows => ({ rows, leaf });
const order = (rows: Message[], leaf: string | null) => activePath(rows, leaf).map((row) => row.id);
const task = (threadId: string, extra: Partial<TaskRecord> = {}): TaskRecord => ({ threadId, title: threadId, createdAt: 1, resumeCursors: {}, ...extra });
function side(bots: ChatsSide["bots"], groups: ChatsSide["groups"], threads: Record<string, Message[]>, leaves: Record<string, string> = {}): ChatsSide {
  return { bots, groups, thread: (id) => thread(threads[id] ?? [], leaves[id] ?? threads[id]?.at(-1)?.id ?? null) };
}
/** What the Cloud holds after a plan's rows land, as the store would read it back. */
function landed(before: Message[], merge: ReturnType<typeof mergeThread>): Message[] {
  const links = new Map(merge.relinked.map((row) => [row.id, row.parentId]));
  return [...before.map((row) => links.has(row.id) ? { ...row, parentId: links.get(row.id)! } : row), ...merge.added];
}

describe("one conversation both have", () => {
  const shared = chain(["m1", 1], ["m2", 2]);
  it("places this computer's newer turns among My Cloud's by time, a turn at a time, and moves only the link of the row that now follows one", () => {
    const desktop = [...shared, line("d1", 10, "m2"), line("d2", 11, "d1", "bot"), line("d3", 30, "d2"), line("d4", 31, "d3", "bot")];
    const cloud = [...shared, line("c1", 20, "m2"), line("c2", 21, "c1", "bot")];
    const merged = mergeThread(thread(desktop), thread(cloud));
    expect(merged.added.map((row) => [row.id, row.parentId])).toEqual([["d1", "m2"], ["d2", "d1"], ["d3", "c2"], ["d4", "d3"]]);
    expect(merged.relinked).toEqual([{ id: "c1", parentId: "d2" }]);
    expect(merged.leaf).toBe("d4");
    expect(merged.synced).toBe(2);
    expect(order(landed(cloud, merged), merged.leaf)).toEqual(["m1", "m2", "d1", "d2", "c1", "c2", "d3", "d4"]);
    // Nothing but those rows' links: no row My Cloud has is in `added`.
    expect(merged.added.some((row) => cloud.some((existing) => existing.id === row.id))).toBe(false);
  });

  it("continues where My Cloud stopped when only this computer went on, without touching a row My Cloud has", () => {
    const merged = mergeThread(thread([...shared, line("d1", 10, "m2"), line("d2", 11, "d1", "bot")]), thread(shared));
    expect(merged).toMatchObject({ relinked: [], leaf: "d2" });
    expect(merged.added.map((row) => row.parentId)).toEqual(["m2", "d1"]);
  });

  it("puts this computer's older turns before My Cloud's newer ones, and keeps My Cloud's last line last", () => {
    const cloud = [...shared, line("c1", 50, "m2"), line("c2", 51, "c1", "bot")];
    const merged = mergeThread(thread([...shared, line("d1", 10, "m2"), line("d2", 11, "d1", "bot")]), thread(cloud));
    expect(merged.relinked).toEqual([{ id: "c1", parentId: "d2" }]);
    expect(merged.leaf).toBe("c2");
    expect(order(landed(cloud, merged), merged.leaf)).toEqual(["m1", "m2", "d1", "d2", "c1", "c2"]);
  });

  it("adds nothing the second time", () => {
    const desktop = [...shared, line("d1", 10, "m2"), line("d2", 11, "d1", "bot")];
    const cloud = [...shared, line("c1", 20, "m2")];
    const first = mergeThread(thread(desktop), thread(cloud));
    const after = landed(cloud, first);
    expect(mergeThread(thread(desktop), thread(after, first.leaf))).toMatchObject({ added: [], relinked: [], leaf: first.leaf });
  });

  it("keeps an edit branch this computer made as a branch, and its context summary stays behind with its children re-linked", () => {
    const desktop = [...shared, line("d1", 10, "m2"), line("summary", 11, "d1", "bot", { kind: "compaction" }), line("d2", 12, "summary", "bot"),
      line("edit", 13, "m2")];
    const merged = mergeThread(thread(desktop, "d2"), thread(shared));
    expect(merged.added.map((row) => [row.id, row.parentId])).toEqual([["d1", "m2"], ["d2", "d1"], ["edit", "m2"]]);
    expect(merged.leaf).toBe("d2");
  });

  it("a desktop path that forks from a row My Cloud is not showing stays that branch, and My Cloud's own view is unchanged", () => {
    const cloud = [...shared, line("c-edit", 5, "m1")];
    const merged = mergeThread(thread([...shared, line("d1", 10, "m2")]), thread(cloud, "c-edit"));
    expect(merged).toMatchObject({ relinked: [], leaf: "c-edit" });
    expect(merged.added.map((row) => row.parentId)).toEqual(["m2"]);
  });
});

describe("planning across bots and rooms", () => {
  const bots = [{ id: "ava", threadId: "main", tasks: [task("main")], projects: [{ id: "p1", name: "One" }] }];
  const cloudSide = (threads: Record<string, Message[]>, extraTasks: TaskRecord[] = []) =>
    side([{ ...bots[0]!, tasks: [task("main"), ...extraTasks] }], [{ id: "room", threadId: "r1", tasks: [{ threadId: "r1", title: "Room", createdAt: 1 }] }], threads);

  it("adds a conversation My Cloud never had with only what a conversation is, and skips chats of bots and rooms it lacks", () => {
    const carried = task("new", { title: "Plan", createdAt: 100, projectId: "p1", approvalMode: "full", autoApprove: true, alwaysAllow: ["Bash"], cwd: "/Users/me/work",
      modelSelection: { instanceId: "local-llm", model: "m" }, resumeCursors: { claude: "session" }, lastInstanceId: "claude", unread: true, pinned: true,
      surface: { kind: "this-computer" } as never, handedMessages: {}, appliedCompactionId: "x", notificationsMuted: true, notificationsMutedBy: "person" });
    const desktop = side(
      [{ ...bots[0]!, tasks: [task("main"), carried, task("in-gone-project", { createdAt: 100, projectId: "gone" })] }, { id: "only-here", threadId: "solo", tasks: [task("solo")] }],
      [{ id: "room", threadId: "r1", tasks: [{ threadId: "r1", title: "Room", createdAt: 1 }, { threadId: "r2", title: "Second", createdAt: 100 }] },
        { id: "room-here", threadId: "r9", tasks: [{ threadId: "r9", title: "Here", createdAt: 1 }] }, { id: "dm-here", threadId: "dm", dm: true }],
      { main: chain(["m1", 1]), new: chain(["n1", 100], ["n2", 101]), "in-gone-project": chain(["g1", 100]), solo: chain(["s1", 5]), r2: chain(["q1", 100]),
        r9: chain(["h1", 5]), dm: chain(["dm1", 5]), r1: chain(["x1", 1]) });
    const plan = planChatMerge(desktop, cloudSide({ main: chain(["m1", 1]), r1: chain(["x1", 1]) }));
    expect(plan).toMatchObject({ conversations: 3, messages: 4, intoExisting: 0, skippedBots: 1, skippedRooms: 1, deleted: 0 });
    const added = plan.threads.find((entry) => entry.threadId === "new")!;
    expect(added.task).toEqual({ threadId: "new", title: "Plan", createdAt: 100, projectId: "p1", pinned: true, notificationsMuted: true, notificationsMutedBy: "person",
      updatedAt: 101, lastThreadOrderAt: 101, resumeCursors: {}, unread: false });
    expect(plan.threads.find((entry) => entry.threadId === "in-gone-project")!.task).not.toHaveProperty("projectId");
    expect(plan.threads.find((entry) => entry.threadId === "r2")).toMatchObject({ owner: { kind: "group", id: "room" }, task: { threadId: "r2", title: "Second", updatedAt: 100 } });
    expect(plan.threads.map((entry) => entry.threadId).sort()).toEqual(["in-gone-project", "new", "r2"]);
  });

  it("leaves out a conversation My Cloud deleted: it has a message from before the two were last in step", () => {
    const desktop = side([{ ...bots[0]!, tasks: [task("main"), task("deleted-there", { createdAt: 1 }), task("since", { createdAt: 50 })] }], [],
      { main: chain(["m1", 1], ["m2", 40]), "deleted-there": chain(["old", 3], ["later", 60]), since: chain(["s1", 50]) });
    const plan = planChatMerge(desktop, cloudSide({ main: chain(["m1", 1], ["m2", 40]) }));
    expect(plan).toMatchObject({ conversations: 1, deleted: 1 });
    expect(plan.threads.map((entry) => entry.threadId)).toEqual(["since"]);
    // The newest conversation at the copy, deleted there: only the copy's own time says it was there.
    const newest = side([{ ...bots[0]!, tasks: [task("main"), task("last-before-copy", { createdAt: 45 }), task("after-copy", { createdAt: 70 })] }], [],
      { main: chain(["m1", 1], ["m2", 40]), "last-before-copy": chain(["l1", 45]), "after-copy": chain(["a1", 70]) });
    expect(planChatMerge(newest, cloudSide({ main: chain(["m1", 1], ["m2", 40]) })).deleted).toBe(0);
    const known = planChatMerge(newest, cloudSide({ main: chain(["m1", 1], ["m2", 40]) }), 60);
    expect(known).toMatchObject({ conversations: 1, deleted: 1 });
    expect(known.threads.map((entry) => entry.threadId)).toEqual(["after-copy"]);
  });

  it("never adds a conversation My Cloud files under another bot, or over rows it already has", () => {
    const desktop = side([{ ...bots[0]!, tasks: [task("main"), task("elsewhere", { createdAt: 50 }), task("orphan", { createdAt: 50 })] }], [],
      { main: chain(["m1", 1]), elsewhere: chain(["e1", 50]), orphan: chain(["o1", 50]) });
    const cloud = side([{ ...bots[0]!, tasks: [task("main")] }, { id: "ben", threadId: "ben-main", tasks: [task("ben-main"), task("elsewhere")] }], [],
      { main: chain(["m1", 1]), elsewhere: chain(["theirs", 5]), orphan: chain(["stray", 5]) });
    expect(planChatMerge(desktop, cloud)).toMatchObject({ threads: [], conversations: 0, messages: 0 });
  });
});

describe("applied to a live store", () => {
  /** This computer's copy as a backup stages it: rosters, its message database and its uploads. */
  function staged(bots: unknown[], groups: unknown[], threads: Record<string, Message[]>, files: Record<string, string> = {}) {
    const data = mkdtempSync(join(tmpdir(), "omb-staged-chats-"));
    writeFileSync(join(data, "bots.json"), JSON.stringify(bots));
    writeFileSync(join(data, "groups.json"), JSON.stringify(groups));
    const db = new DatabaseSync(join(data, "messages.db"));
    db.exec("CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id)); CREATE TABLE thread_state (thread_id TEXT PRIMARY KEY, active_leaf_id TEXT);");
    const insert = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const [threadId, rows] of Object.entries(threads)) for (const row of rows) insert.run(threadId, row.id, row.at, row.role, row.kind, row.text ?? null, JSON.stringify(row));
    db.close();
    mkdirSync(join(data, "attachments"), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(data, "attachments", name), body);
    return data;
  }

  it("adds the union, copies the attachments it needs to this server's own folder, and a second run changes nothing", () => {
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture-model" }));
    const bot = store.createBot({ name: "Ava" }, { seedMessages: false });
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Before the copy", at: 1 });
    const cloudLine = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Said on My Cloud", at: 5000 });
    store.patchBot(bot.id, { approvalMode: "ask", description: "Cloud's own words" });
    const settings = JSON.stringify({ ...store.bot(bot.id)!, tasks: undefined });
    const source = "/Users/someone/.openmausbot", image = "0f1e2d3c-4b5a-4968-8776-655443322110.png";
    const desktopBot = { ...JSON.parse(JSON.stringify(store.bot(bot.id))), description: "Desktop's words", approvalMode: "full",
      tasks: [...store.bot(bot.id)!.tasks!.map((entry) => ({ ...entry })), { threadId: "desk-new", title: "From the desk", createdAt: 3000, resumeCursors: { claude: "s" } }] };
    const data = staged([desktopBot], [], {
      [bot.threadId]: [{ ...first }, line("d1", 4000, first.id), line("d2", 4001, "d1", "bot")],
      "desk-new": [line("n1", 3000, null, "user", { text: `Look\n\n<attached-image path="${source}/attachments/${image}" name="a.png" />` }),
        line("n2", 3001, "n1", "bot", { attachments: [{ kind: "image", path: `${source}/attachments/${image}`, mime: "image/png" }] })],
    }, { [image]: "picture bytes" });

    const result = mergeStagedChats(store, DATA_DIR, { data, sourceDataDir: source });
    expect(result).toEqual({ conversations: 1, messages: 4, intoExisting: 2, skippedBots: 0, skippedRooms: 0, deleted: 0 });
    expect(order(store.messagesFor(bot.threadId), store.activeLeaf(bot.threadId))).toEqual([first.id, "d1", "d2", cloudLine.id]);
    expect(store.messagesFor(bot.threadId).find((row) => row.id === cloudLine.id)).toEqual({ ...cloudLine, parentId: "d2" });
    const added = store.bot(bot.id)!.tasks!.find((entry) => entry.threadId === "desk-new")!;
    expect(added).toMatchObject({ title: "From the desk", resumeCursors: {}, updatedAt: 3001 });
    expect(JSON.stringify({ ...store.bot(bot.id)!, tasks: undefined })).toBe(settings);
    const rows = store.messagesFor("desk-new");
    expect(rows.map((row) => row.id)).toEqual(["n1", "n2"]);
    expect(rows[0]!.text).toContain(`path="${join(DATA_DIR, "attachments", image)}"`);
    expect(rows[1]!.attachments![0]!.path).toBe(join(DATA_DIR, "attachments", image));
    expect(readFileSync(join(DATA_DIR, "attachments", image), "utf8")).toBe("picture bytes");

    // Read back from disk, as after a restart.
    const reopened = new Store(() => ({ instanceId: "fixture", model: "fixture-model" }));
    expect(order(reopened.messagesFor(bot.threadId), reopened.activeLeaf(bot.threadId))).toEqual([first.id, "d1", "d2", cloudLine.id]);
    writeFileSync(join(data, "attachments", image), "changed on the desk");
    expect(mergeStagedChats(reopened, DATA_DIR, { data, sourceDataDir: source })).toEqual({ conversations: 0, messages: 0, intoExisting: 0, skippedBots: 0, skippedRooms: 0, deleted: 0 });
    expect(readFileSync(join(DATA_DIR, "attachments", image), "utf8")).toBe("picture bytes");
    expect(reopened.messagesFor("desk-new")).toHaveLength(2);
    expect(existsSync(join(DATA_DIR, "routines.json"))).toBe(false);
  });
});
