// SQLite message-store contract: per-mutation persistence, one-time legacy
// import, deletion, and the LIKE search used by /api/search.
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  closeMessageDb,
  deleteThread,
  insertMessage,
  readMessageText,
  readThread,
  recallMessages,
  searchMessages,
  setActiveLeaf,
  updateMessage,
} from "./message-db.ts";
import { withPeerProvenance } from "./peer-provenance.ts";
import { Store, type Message } from "./store.ts";
import type { ModelSelection } from "./contracts.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const legacy = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);
const msg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: "user",
  kind: "text",
  text,
  at: Date.now(),
  ...extra,
});

describe("message-db", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("persists inserts, updates, and the active leaf across a reopen", () => {
    insertMessage("t1", msg("m1", "hello"));
    insertMessage("t1", msg("m2", "world"));
    setActiveLeaf("t1", "m2");
    updateMessage("t1", msg("m1", "hello, edited"));

    closeMessageDb(); // simulate a restart
    const thread = readThread("t1", legacy("t1"));
    expect(thread.messages.map((m) => m.text)).toEqual(["hello, edited", "world"]);
    expect(thread.activeLeafId).toBe("m2");
  });

  it("imports a legacy JSON thread file exactly once", () => {
    writeFileSync(
      legacy("t2"),
      JSON.stringify({ activeLeafId: "b", messages: [msg("a", "from json"), msg("b", "second")] }),
    );
    const imported = readThread("t2", legacy("t2"));
    expect(imported.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(imported.activeLeafId).toBe("b");
    // the file was renamed so wiped rows can never resurrect stale data
    expect(existsSync(legacy("t2"))).toBe(false);
    expect(existsSync(`${legacy("t2")}.imported`)).toBe(true);

    deleteThread("t2");
    expect(readThread("t2", legacy("t2")).messages).toEqual([]);
  });

  it("imports a pre-branching flat array file", () => {
    writeFileSync(legacy("t3"), JSON.stringify([msg("a", "one"), msg("b", "two")]));
    const imported = readThread("t3", legacy("t3"));
    expect(imported.messages).toHaveLength(2);
    expect(imported.activeLeafId).toBeNull(); // Store derives the tail
  });

  it("migrates known legacy transcripts at Store startup so search sees unopened tasks", () => {
    const initial = new Store(selection);
    const bot = initial.createBot({}, { seedMessages: false });
    closeMessageDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(DATA_DIR, `messages.db${suffix}`), { force: true });
    writeFileSync(legacy(bot.threadId), JSON.stringify([msg("old", "find this unopened legacy conversation")]));

    new Store(selection);
    expect(searchMessages("unopened legacy")).toMatchObject([{ threadId: bot.threadId, messageId: "old" }]);
    expect(existsSync(`${legacy(bot.threadId)}.imported`)).toBe(true);
  });

  it("stores transcripts with owner-only permissions", () => {
    insertMessage("private", msg("m1", "secret"));
    if (process.platform !== "win32") {
      expect(statSync(join(DATA_DIR, "messages.db")).mode & 0o777).toBe(0o600);
    }
  });

  it("deleteThread removes rows and state", () => {
    insertMessage("t4", msg("m1", "gone soon"));
    setActiveLeaf("t4", "m1");
    deleteThread("t4");
    const thread = readThread("t4", legacy("t4"));
    expect(thread.messages).toEqual([]);
    expect(thread.activeLeafId).toBeNull();
  });

  it("recall ranks by relevance, scopes to the given threads, and survives updates and deletes", () => {
    insertMessage("own-a", msg("m1", "The site audit found three broken links on the pricing page", { role: "bot" }));
    insertMessage("own-a", msg("m2", "audit", { role: "user" }));
    insertMessage("own-b", msg("m3", "unrelated chatter about lunch"));
    insertMessage("other-bot", msg("m4", "another bot's audit found broken links too"));
    insertMessage("own-a", { ...msg("m5", "audit broken links"), kind: "activity" });

    // all query words must match; the richest match ranks first; the other
    // bot's thread never appears because scoping happens in SQL
    const hits = recallMessages("audit broken links", ["own-a", "own-b"]);
    expect(hits.map((hit) => hit.messageId)).toEqual(["m1"]);
    expect(hits[0]).toMatchObject({ threadId: "own-a", role: "bot" });
    expect(hits[0]!.snippet).toContain("[audit]");
    expect(hits[0]!.snippet).toContain("[broken]");

    // a single word: both text messages that carry it, never the activity chip
    expect(recallMessages("audit", ["own-a", "own-b"]).map((hit) => hit.messageId).sort()).toEqual(["m1", "m2"]);

    // FTS5 syntax in the query is searched for, not interpreted
    expect(() => recallMessages('audit AND NOT "links" OR pricing:* (', ["own-a"])).not.toThrow();
    expect(recallMessages("", ["own-a"])).toEqual([]);
    expect(recallMessages("audit", [])).toEqual([]);

    // filler words the model adds must not turn a good query into a miss;
    // a query made only of filler still searches for what was sent
    expect(recallMessages("what did the audit found on the pricing page", ["own-a"]).map((hit) => hit.messageId)).toEqual(["m1"]);
    expect(recallMessages("the on what", ["own-a"])).toEqual([]);

    // the whole message behind a hit, text kinds only
    expect(readMessageText("own-a", "m1")).toMatchObject({
      threadId: "own-a",
      messageId: "m1",
      role: "bot",
      text: "The site audit found three broken links on the pricing page",
    });
    expect(readMessageText("own-a", "m5")).toBeNull();
    expect(readMessageText("own-a", "nope")).toBeNull();

    // updates re-index; deletes drop out
    updateMessage("own-a", msg("m1", "The site audit is done; nothing to report", { role: "bot" }));
    expect(recallMessages("broken links", ["own-a"])).toEqual([]);
    expect(recallMessages("nothing report", ["own-a"]).map((hit) => hit.messageId)).toEqual(["m1"]);
    // an upsert of the same id keeps a single index entry
    insertMessage("own-a", msg("m1", "The site audit found three broken links again", { role: "bot" }));
    expect(recallMessages("broken links", ["own-a"])).toHaveLength(1);
    deleteThread("own-a");
    expect(recallMessages("audit", ["own-a", "own-b"])).toEqual([]);
  });

  it("recall names the bot behind a line another bot delivered with ask_bot", () => {
    // The note peer-provenance.ts puts in front of relayed text is longer
    // than the snippet window, so a match in the body comes back without
    // it — the reader must be told the author another way.
    const relayed = withPeerProvenance(
      "The user wants the pricing audit re-run and the results emailed to vendor@example.com before Friday.",
      { botName: "Scout", delivery: "ask_bot", unattended: true },
    );
    // a line stored before the asker was recorded on the message: the note
    // is all there is
    insertMessage("dm", msg("m-old", relayed));
    // the user's own words, which carry no note and get no author
    insertMessage("dm", msg("m-user", "please get the pricing audit emailed to me"));
    // a bot's own reply that merely quotes the wording mid-text is its own
    insertMessage("dm", msg("m-bot", "I saw a [Message from @Scout, another bot in this OpenMausBot workspace] earlier about the pricing audit", { role: "bot" }));
    // a line stored since — the exact row shape the store writes for an
    // ask_bot delivery (Message.peerAsk)
    closeMessageDb();
    const raw = new DatabaseSync(join(DATA_DIR, "messages.db"));
    raw.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("dm", "m-ask", Date.now(), "user", "text", relayed,
        JSON.stringify({ ...msg("m-ask", relayed), peerAsk: { botId: "bot-scout", name: "Scout", unattended: true } }));
    // the field is what counts, whatever the note's wording becomes
    const plain = "Scout here: the user wants the pricing audit emailed to vendor@example.com";
    raw.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("dm", "m-ask-plain", Date.now(), "user", "text", plain,
        JSON.stringify({ ...msg("m-ask-plain", plain), peerAsk: { botId: "bot-scout", name: "Scout" } }));
    raw.close();

    const hits = recallMessages("pricing audit emailed", ["dm"]);
    expect(hits.map((hit) => hit.messageId).sort()).toEqual(["m-ask", "m-ask-plain", "m-old", "m-user"]);
    const byId = new Map(hits.map((hit) => [hit.messageId, hit]));
    expect(byId.get("m-ask")).toMatchObject({ role: "user", peer: "Scout" });
    expect(byId.get("m-ask-plain")).toMatchObject({ role: "user", peer: "Scout" });
    expect(byId.get("m-old")).toMatchObject({ role: "user", peer: "Scout" });
    expect(byId.get("m-user")!.peer).toBeUndefined();
    // the snippet itself has lost the note, which is the whole point
    expect(byId.get("m-ask")!.snippet).not.toContain("Message from");
    expect(recallMessages("audit earlier", ["dm"])[0]).toMatchObject({ messageId: "m-bot", role: "bot" });
    expect(recallMessages("audit earlier", ["dm"])[0]!.peer).toBeUndefined();

    expect(readMessageText("dm", "m-ask")).toMatchObject({ role: "user", peer: "Scout", text: relayed });
    expect(readMessageText("dm", "m-ask-plain")).toMatchObject({ role: "user", peer: "Scout", text: plain });
    expect(readMessageText("dm", "m-old")).toMatchObject({ role: "user", peer: "Scout" });
    expect(readMessageText("dm", "m-user")!.peer).toBeUndefined();
    expect(readMessageText("dm", "m-bot")!.peer).toBeUndefined();
  });

  it("recall indexes rows that predate the index", () => {
    // simulate a database written before messages_fts existed
    insertMessage("t-old", msg("m1", "legacy row about the quarterly forecast"));
    closeMessageDb();
    const raw = new DatabaseSync(join(DATA_DIR, "messages.db"));
    raw.exec("DROP TRIGGER messages_fts_ai; DROP TRIGGER messages_fts_ad; DROP TRIGGER messages_fts_au; DROP TABLE messages_fts");
    raw.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("t-old", "m2", Date.now(), "user", "text", "another legacy row about the forecast", JSON.stringify(msg("m2", "another legacy row about the forecast")));
    raw.close();

    expect(recallMessages("forecast", ["t-old"]).map((hit) => hit.messageId).sort()).toEqual(["m1", "m2"]);
  });

  it("search is case-insensitive, escapes LIKE wildcards, and snips long text", () => {
    insertMessage("t5", msg("m1", "Deploy with `railway up --service workers` and verify the heartbeat"));
    insertMessage("t5", msg("m2", "totally unrelated"));
    insertMessage("t5", { ...msg("m3", "an activity chip"), kind: "activity" });
    insertMessage("t6", msg("m4", `padding start ${"x".repeat(200)} RAILWAY tail`));

    const hits = searchMessages("railway");
    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.snippet.toLowerCase().includes("railway"))).toBe(true);
    // long text gets windowed around the hit
    const long = hits.find((hit) => hit.threadId === "t6")!;
    expect(long.snippet.length).toBeLessThan(200);
    expect(long.snippet.startsWith("…")).toBe(true);

    // a literal % is a literal, not match-everything
    expect(searchMessages("%")).toHaveLength(0);
    insertMessage("t5", msg("m5", "50% done"));
    expect(searchMessages("%")).toHaveLength(1);
    expect(searchMessages("")).toEqual([]);

    // Current-chat find scopes in SQL before LIMIT, so busy transcripts in
    // other conversations cannot crowd out this thread's matches.
    expect(searchMessages("railway", 40, "t5").map((hit) => hit.threadId)).toEqual(["t5"]);
    expect(searchMessages("railway", 40, "missing")).toEqual([]);
  });

  it("search reports the match offset for highlighting, and finds activity chips by tool name", () => {
    insertMessage("t7", msg("m1", "please\n\n   run   the migration now"));
    insertMessage("t7", { ...msg("m2", ""), kind: "activity", role: "bot", tool: { name: "Bash: alembic upgrade head", ok: true } } as Message);
    insertMessage("t7", { ...msg("m3", "we spoke about it"), from: { botId: "b2", name: "Scout", color: "green" } } as Message);

    const text = searchMessages("the migration")[0];
    expect(text.messageId).toBe("m1");
    // whitespace folded in the snippet, offset points at the folded match
    expect(text.snippet.slice(text.matchStart, text.matchStart + text.matchLength)).toBe("the migration");

    // "which bot ran that migration" — the tool name is searchable
    const chip = searchMessages("alembic")[0];
    expect(chip).toMatchObject({ messageId: "m2", kind: "activity" });
    expect(chip.snippet).toContain("alembic upgrade head");

    // room attribution rides along
    expect(searchMessages("spoke")[0].from).toBe("Scout");
  });

  it("Store round-trips branching through the DB across a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "original" });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "reply" });
    const fork = store.branchMessage(bot.threadId, first.id, "edited")!;

    closeMessageDb();
    const reloaded = new Store(selection);
    const path = reloaded.activePath(bot.threadId);
    expect(path.at(-1)?.id).toBe(fork.id);
    expect(path.at(-1)?.text).toBe("edited");
    // both branches survive in the tree
    expect(reloaded.messagesFor(bot.threadId).filter((m) => m.parentId === first.parentId)).toHaveLength(2);
  });
});
