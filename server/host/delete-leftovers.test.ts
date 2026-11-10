import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDeleteLeftovers, engineSessionFolders, instanceEnvironment, plainlyUnder, removeMemoryLayer, removeUnder, type DeleteLeftoversDeps } from "./delete-leftovers.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const LOGGED = "22222222-2222-4222-8222-222222222222";
const SHARED = "33333333-3333-4333-8333-333333333333";
const upload = (n: number) => `0000000${n}-0000-4000-8000-000000000000.png`;
const MEMBER = "p_bobbobbobbobbobbobbobb";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function put(path: string, text = "x"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

type Task = { threadId: string; resumeCursors?: Record<string, unknown> };
type Bot = { id: string; threadId?: string; resumeCursors?: Record<string, unknown>; tasks?: Task[] };

function fixture(over: Partial<DeleteLeftoversDeps> = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), "omb-delete-leftovers-"));
  made.push(sandbox);
  const dataDir = join(sandbox, "data");
  const home = join(sandbox, "home");
  const outside = join(sandbox, "outside");
  for (const dir of [join(dataDir, "attachments"), home, outside]) mkdirSync(dir, { recursive: true });
  const messages = new Map<string, unknown[]>();
  const bots: Bot[] = [];
  const kept = new Set<string>();
  const warnings: string[] = [];
  const forgotten: string[] = [];
  let listener: (change: { type: string; threadId?: string; botId?: string }) => void = () => {};
  const store: DeleteLeftoversDeps["store"] = { get bots() { return bots; }, messagesFor: (threadId) => messages.get(threadId) ?? [], onChange: (added) => { listener = added; }, threadsGoing: () => {} };
  const leftovers = createDeleteLeftovers({
    dataDir,
    store,
    threadsReferencing: (fragment) => [...messages].filter(([, list]) => JSON.stringify(list).includes(fragment)).map(([threadId]) => threadId),
    keptAttachments: () => kept,
    deleteAttachment: (name) => rmSync(join(dataDir, "attachments", name)),
    engineFolders: () => engineSessionFolders(dataDir, [{ HOME: home }]),
    layers: { journalFile: (layer) => join(dataDir, "memory-journal", `${layer}.ndjson`), forget: (layer) => { forgotten.push(layer); } },
    defer: () => {},
    warn: (line) => { warnings.push(line); },
    ...over,
  });
  const say = (threadId: string, ...names: string[]) => {
    messages.set(threadId, names.map((name) => ({ role: "user", kind: "text", text: `![image](/api/attachments/${name})` })));
    for (const name of names) put(join(dataDir, "attachments", name));
  };
  /** The store's own order: told before, the transcript and the record go, told after. */
  const deleteThreads = (...threadIds: string[]) => {
    store.threadsGoing(threadIds);
    for (const threadId of threadIds) {
      messages.delete(threadId);
      for (const bot of bots) bot.tasks = bot.tasks?.filter((task) => task.threadId !== threadId);
      listener({ type: "thread.deleted", threadId });
    }
    leftovers.flush();
  };
  const deleteBot = (botId: string) => {
    const bot = bots.find((one) => one.id === botId)!;
    const threadIds = (bot.tasks ?? []).map((task) => task.threadId);
    store.threadsGoing(threadIds);
    bots.splice(bots.indexOf(bot), 1);
    for (const threadId of threadIds) {
      messages.delete(threadId);
      listener({ type: "thread.deleted", threadId });
    }
    listener({ type: "bot.deleted", botId });
    leftovers.flush();
  };
  const stored = (name: string) => existsSync(join(dataDir, "attachments", name));
  const logSession = (threadId: string, sessionId: string) =>
    put(join(dataDir, "events", `${threadId}.ndjson`), `${JSON.stringify({ type: "session.started", threadId, sessionId })}\n`);
  return { sandbox, dataDir, home, outside, messages, bots, kept, warnings, forgotten, say, deleteThreads, deleteBot, stored, logSession, store, leftovers };
}

describe("a deleted conversation's uploads", () => {
  it("go with it", () => {
    const { bots, say, deleteThreads, stored } = fixture();
    bots.push({ id: "scout", tasks: [{ threadId: "t1" }, { threadId: "t2" }] });
    say("t1", upload(1));
    deleteThreads("t1");
    expect(stored(upload(1))).toBe(false);
  });

  it("stay while another conversation, a picture or a routine still names them", () => {
    const { bots, kept, say, deleteThreads, stored } = fixture();
    bots.push({ id: "scout", tasks: [{ threadId: "t1" }, { threadId: "t2" }] });
    say("t2", upload(1));
    say("t1", upload(1), upload(2), upload(3));
    kept.add(upload(2));
    deleteThreads("t1");
    expect([stored(upload(1)), stored(upload(2)), stored(upload(3))]).toEqual([true, true, false]);
  });

  it("go once every conversation that named them is deleted together", () => {
    const { bots, say, deleteThreads, stored } = fixture();
    bots.push({ id: "scout", tasks: [{ threadId: "t1" }, { threadId: "t2" }, { threadId: "t3" }] });
    say("t1", upload(1));
    say("t2", upload(1));
    deleteThreads("t1", "t2");
    expect(stored(upload(1))).toBe(false);
  });

  it("stay when the delete did not happen", () => {
    const { bots, say, store, leftovers, stored } = fixture();
    bots.push({ id: "scout", tasks: [{ threadId: "t1" }] });
    say("t1", upload(1));
    store.threadsGoing(["t1"]);
    leftovers.flush();
    expect(stored(upload(1))).toBe(true);
  });

  it("stay, with a warning, while what still uses uploads cannot be read", () => {
    const { bots, say, deleteThreads, stored, warnings } = fixture({ keptAttachments: () => null });
    bots.push({ id: "scout", tasks: [{ threadId: "t1" }] });
    say("t1", upload(1));
    deleteThreads("t1");
    expect(stored(upload(1))).toBe(true);
    expect(warnings.join("\n")).toContain("uploads stayed behind");
  });

  it("never reach a file outside attachments/ a message names", () => {
    const { dataDir, bots, messages, deleteThreads } = fixture();
    bots.push({ id: "scout", tasks: [{ threadId: "t1" }] });
    const config = put(join(dataDir, "config.json"));
    messages.set("t1", [{ text: "attachments/../config.json and attachments/..\\config.json" }]);
    deleteThreads("t1");
    expect(existsSync(config)).toBe(true);
  });

  it("take the conversation's box uploads folder too", () => {
    const { dataDir, bots, deleteThreads } = fixture();
    bots.push({ id: "scout", tasks: [{ threadId: "t1" }, { threadId: "t2" }] });
    const mine = put(join(dataDir, "box-uploads", "scout", "t1", upload(1)));
    const others = put(join(dataDir, "box-uploads", "scout", "t2", upload(2)));
    deleteThreads("t1");
    expect([existsSync(dirname(mine)), existsSync(others)]).toEqual([false, true]);
  });
});

describe("a deleted conversation's engine sessions", () => {
  it("go from Claude's and Codex's folders, by the session it resumes and the ones its log says it started", () => {
    const { home, bots, deleteThreads, logSession } = fixture();
    bots.push({ id: "scout", tasks: [{ threadId: "t1", resumeCursors: { claude: SESSION } }, { threadId: "t2", resumeCursors: { claude: SHARED } }] });
    logSession("t1", LOGGED);
    const claude = join(home, ".claude");
    const mine = [
      put(join(claude, "projects", "-work-site", `${SESSION}.jsonl`)),
      put(join(claude, "projects", "-work-site", SESSION, "subagents", "agent-1.jsonl")),
      put(join(claude, "projects", "-work-other", `${LOGGED}.jsonl`)),
      put(join(claude, "file-history", SESSION, "a@v1")),
      put(join(claude, "session-env", SESSION, "env")),
      put(join(claude, "todos", `${SESSION}-agent-${SESSION}.json`)),
      put(join(claude, "debug", `${SESSION}.txt`)),
      put(join(home, ".codex", "sessions", "2026", "11", "10", `rollout-2026-11-10T10-00-00-${SESSION}.jsonl`)),
      put(join(home, ".codex", "archived_sessions", `rollout-2026-11-09T10-00-00-${LOGGED}.jsonl`)),
    ];
    const others = [
      put(join(claude, "projects", "-work-site", `${SHARED}.jsonl`)),
      put(join(claude, ".credentials.json")),
      put(join(claude, "history.jsonl")),
      put(join(home, ".codex", "sessions", "2026", "11", "10", `rollout-2026-11-10T11-00-00-${SHARED}.jsonl`)),
      put(join(home, ".codex", "auth.json")),
    ];
    deleteThreads("t1");
    expect(mine.filter(existsSync)).toEqual([]);
    expect(others.filter((path) => !existsSync(path))).toEqual([]);
  });

  it("stay while a remaining conversation resumes the same session", () => {
    const { home, bots, deleteThreads, logSession } = fixture();
    bots.push({ id: "scout", tasks: [{ threadId: "t1", resumeCursors: { claude: SHARED } }, { threadId: "fork", resumeCursors: { claude: SHARED } }] });
    logSession("t1", SHARED);
    const session = put(join(home, ".claude", "projects", "-work", `${SHARED}.jsonl`));
    deleteThreads("t1");
    expect(existsSync(session)).toBe(true);
    deleteThreads("fork");
    expect(existsSync(session)).toBe(false);
  });

  it("go from every audience's engine home on a Team Cloud", () => {
    const sessions = (dataDir: string) => engineSessionFolders(dataDir, ["team", "member-0123456789abcdef"].map((key) => ({ HOME: join(dataDir, "engine-homes", key) })));
    let dataDirOf = "";
    const { dataDir, bots, deleteThreads } = fixture({ engineFolders: () => sessions(dataDirOf) });
    dataDirOf = dataDir;
    bots.push({ id: "scout", tasks: [{ threadId: "t1", resumeCursors: { claude: SESSION, codex: LOGGED } }, { threadId: "t2" }] });
    const team = put(join(dataDir, "engine-homes", "team", ".claude", "projects", "-work", `${SESSION}.jsonl`));
    const member = put(join(dataDir, "engine-homes", "member-0123456789abcdef", ".codex", "sessions", "2026", "11", "10", `rollout-x-${LOGGED}.jsonl`));
    deleteThreads("t1");
    expect([existsSync(team), existsSync(member)]).toEqual([false, false]);
  });

  it("removes a Pi session, which is named by its file, only inside Pi's own folder", () => {
    const { home, outside, bots, deleteThreads } = fixture();
    const mine = put(join(home, ".pi", "agent", "sessions", "--work--", "2026-11-10_a.jsonl"));
    const elsewhere = put(join(outside, "notes.jsonl"));
    bots.push({ id: "scout", tasks: [{ threadId: "t1", resumeCursors: { pi: mine } }, { threadId: "t2", resumeCursors: { pi: elsewhere } }, { threadId: "t3" }] });
    deleteThreads("t1", "t2");
    expect([existsSync(mine), existsSync(elsewhere)]).toEqual([false, true]);
  });

  it("never follows a link out of an engine's folder", () => {
    const { home, outside, bots, deleteThreads } = fixture();
    bots.push({ id: "scout", tasks: [{ threadId: "t1", resumeCursors: { claude: SESSION } }, { threadId: "t2" }] });
    const elsewhere = put(join(outside, "projects", "-work", `${SESSION}.jsonl`));
    const history = put(join(outside, "history", SESSION, "a@v1"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    symlinkSync(join(outside, "projects"), join(home, ".claude", "projects"));
    mkdirSync(join(home, ".claude", "file-history"));
    symlinkSync(join(outside, "history", SESSION), join(home, ".claude", "file-history", SESSION));
    mkdirSync(join(home, ".codex"), { recursive: true });
    symlinkSync(join(outside, "projects"), join(home, ".codex", "sessions"));
    deleteThreads("t1");
    expect([existsSync(elsewhere), existsSync(history)]).toEqual([true, true]);
    expect(existsSync(join(home, ".claude", "file-history", SESSION))).toBe(false);
  });

  it("never follows a link out of the data folder to an engine home", () => {
    const sessions = (dataDir: string) => engineSessionFolders(dataDir, [{ HOME: join(dataDir, "engine-homes", "team") }]);
    let dataDirOf = "";
    const { dataDir, outside, bots, deleteThreads } = fixture({ engineFolders: () => sessions(dataDirOf) });
    dataDirOf = dataDir;
    bots.push({ id: "scout", tasks: [{ threadId: "t1", resumeCursors: { claude: SESSION } }, { threadId: "t2" }] });
    const elsewhere = put(join(outside, "claude", "projects", "-work", `${SESSION}.jsonl`));
    mkdirSync(join(dataDir, "engine-homes", "team"), { recursive: true });
    symlinkSync(join(outside, "claude"), join(dataDir, "engine-homes", "team", ".claude"));
    deleteThreads("t1");
    expect(existsSync(elsewhere)).toBe(true);
  });
});

describe("a deleted bot", () => {
  it("takes its checkpoints, its box uploads, its conversations' folders and the memory layers kept beside its own folder", () => {
    const { dataDir, bots, deleteBot, forgotten } = fixture();
    bots.push({ id: "scout", tasks: [{ threadId: "t1" }] }, { id: "scout-two", tasks: [{ threadId: "t9" }] });
    const layers = [`scout--member-${MEMBER}`, "scout--room-r1"];
    const mine = [
      put(join(dataDir, "checkpoints", "scout", "0123456789abcdef", ".git", "HEAD")),
      put(join(dataDir, "box-uploads", "scout", "t1", upload(1))),
      put(join(dataDir, "task-workspaces", "scout", "t1", "report.md")),
      ...layers.flatMap((layer) => [put(join(dataDir, "workspaces", layer, "memory", "notes.md")), put(join(dataDir, "memory-journal", `${layer}.ndjson`))]),
    ];
    const others = [
      put(join(dataDir, "checkpoints", "scout-two", "0123456789abcdef", ".git", "HEAD")),
      put(join(dataDir, "task-workspaces", "scout-two", "t9", "report.md")),
      put(join(dataDir, "workspaces", `scout-two--member-${MEMBER}`, "memory", "notes.md")),
      put(join(dataDir, "workspaces", "scout-two", "memory", "notes.md")),
      put(join(dataDir, "memory-journal", "scout-two.ndjson")),
    ];
    deleteBot("scout");
    expect(mine.filter(existsSync)).toEqual([]);
    expect(others.filter((path) => !existsSync(path))).toEqual([]);
    expect(forgotten.sort()).toEqual([...layers].sort());
  });

  it("never follows a link out of the data folder", () => {
    const { dataDir, outside, bots, deleteBot } = fixture();
    bots.push({ id: "scout", tasks: [{ threadId: "t1" }] });
    const checkpoint = put(join(outside, "checkpoints", "scout", "repo", "HEAD"));
    const layer = put(join(outside, "layer", "memory", "notes.md"));
    symlinkSync(join(outside, "checkpoints"), join(dataDir, "checkpoints"));
    mkdirSync(join(dataDir, "workspaces"), { recursive: true });
    symlinkSync(join(outside, "layer"), join(dataDir, "workspaces", `scout--member-${MEMBER}`));
    deleteBot("scout");
    expect([existsSync(checkpoint), existsSync(layer)]).toEqual([true, true]);
    expect(existsSync(join(dataDir, "workspaces", `scout--member-${MEMBER}`))).toBe(false);
  });
});

describe("a cleanup that fails", () => {
  it("is logged, never thrown into the delete, and the rest still goes", () => {
    const { dataDir, home, bots, say, deleteThreads, warnings } = fixture({ deleteAttachment: () => { throw new Error("disk is read-only"); } });
    bots.push({ id: "scout", tasks: [{ threadId: "t1", resumeCursors: { claude: SESSION } }, { threadId: "t2" }] });
    say("t1", upload(1));
    const session = put(join(home, ".claude", "projects", "-work", `${SESSION}.jsonl`));
    const box = put(join(dataDir, "box-uploads", "scout", "t1", upload(1)));
    expect(() => deleteThreads("t1")).not.toThrow();
    expect(warnings).toEqual([`delete leftovers: the upload ${upload(1)} stayed behind: disk is read-only`]);
    expect([existsSync(session), existsSync(box)]).toEqual([false, false]);
  });

  it("is logged when the conversation cannot be read before it goes", () => {
    const { messages, store, warnings } = fixture();
    messages.set("t1", [{ toJSON() { throw new Error("unreadable"); } }]);
    expect(() => store.threadsGoing(["t1"])).not.toThrow();
    expect(warnings).toEqual(["delete leftovers: leftovers of t1 stayed behind: unreadable"]);
  });
});

describe("the helpers", () => {
  it("removes only what is plainly under its root", () => {
    const { dataDir, outside } = fixture();
    const inside = put(join(dataDir, "a", "b", "file"));
    const out = put(join(outside, "file"));
    symlinkSync(outside, join(dataDir, "link"));
    expect(plainlyUnder(dataDir, inside)).toBe(true);
    expect(plainlyUnder(dataDir, dataDir)).toBe(false);
    expect(plainlyUnder(dataDir, out)).toBe(false);
    expect(plainlyUnder(dataDir, join(dataDir, "a", "..", "..", "outside", "file"))).toBe(false);
    expect(removeUnder(dataDir, join(dataDir, "link", "file"))).toBe(false);
    expect(existsSync(out)).toBe(true);
    expect(removeUnder(dataDir, join(dataDir, "link"))).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(removeUnder(dataDir, inside)).toBe(true);
    expect(removeUnder(dataDir, inside)).toBe(false);
  });

  it("removes a memory layer and nothing that is not one", () => {
    const { dataDir } = fixture();
    const records = { journalFile: (layer: string) => join(dataDir, "memory-journal", `${layer}.ndjson`), forget: () => {} };
    const own = put(join(dataDir, "workspaces", "scout", "memory", "notes.md"));
    const layer = put(join(dataDir, "workspaces", "scout--room-r1", "memory", "notes.md"));
    removeMemoryLayer(dataDir, "scout", records);
    removeMemoryLayer(dataDir, "scout--room-r1", records);
    expect([existsSync(own), existsSync(layer)]).toEqual([true, false]);
  });

  it("finds each engine's folder from the environment its instance runs with", () => {
    const { dataDir, home } = fixture();
    mkdirSync(join(dataDir, "providers", "chatgpt-plan", "abc", "codex"), { recursive: true });
    const work = instanceEnvironment({ HOME: home }, { config: { configDir: "~/.claude-work" } });
    const endpoint = instanceEnvironment({ HOME: home }, { environment: { CODEX_HOME: join(dataDir, "providers", "relay") } });
    expect(instanceEnvironment({ HOME: home }, { config: { configDir: "relative" } }).CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(engineSessionFolders(dataDir, [{ HOME: home }, work, endpoint, {}])).toEqual({
      claude: [join(home, ".claude"), join(home, ".claude-work")],
      codex: [join(home, ".codex"), join(dataDir, "providers", "relay"), join(dataDir, "providers", "chatgpt-plan", "abc", "codex")],
      pi: [join(home, ".pi", "agent")],
    });
  });
});
