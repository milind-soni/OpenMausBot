import { appendFileSync, chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { engineSessionFolders } from "./delete-leftovers.ts";
import {
  CLAUDE_TRANSCRIPT_DAYS, IDLE_MS, TRASH_DIR, claudeCliCacheRoots, createLoggedSessions, emptyTrash, engineSessionSweepMode, liveSessions,
  engineSessionPass, pinClaudeRetention, sweepEngineSessions, sweepLine, type EngineSessionPassDeps,
  type EngineSessionSweepDeps,
} from "./engine-session-sweep.ts";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LIVE = id(1), ENDED = id(2), ENDED_RECENT = id(3), UNLOGGED = id(4), HANDED = id(5);

let root: string, dataDir: string, home: string, claude: string, codex: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "engine-session-sweep-"));
  home = join(root, "home");
  dataDir = join(home, ".openmausbot");
  claude = join(home, ".claude");
  codex = join(dataDir, "providers", "codex-own", "h1", "codex");
  mkdirSync(join(dataDir, "events"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(path: string, text = "x".repeat(100), ageMs = 10 * DAY): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  utimesSync(path, new Date(NOW - ageMs), new Date(NOW - ageMs));
  return path;
}

const started = (threadId: string, sessionId: string) => `${JSON.stringify({ eventId: sessionId, provider: "claudeAgent", threadId, createdAt: new Date(NOW).toISOString(), type: "session.started", sessionId, model: "m" })}\n`;

/** A Claude session as Claude Code 2.1 keeps it, in a project folder, with its side folders. */
function claudeSession(session: string, ageMs = 10 * DAY): string[] {
  const project = join(claude, "projects", "-home-work");
  const files = [
    put(join(project, `${session}.jsonl`), "{}\n".repeat(50), ageMs),
    put(join(project, session, "subagents", "agent-a.jsonl"), "{}\n", ageMs),
    put(join(project, session, "tool-results", "r.txt"), "y".repeat(5_000), ageMs),
    put(join(claude, "file-history", session, "a@v1"), "old", ageMs),
    put(join(claude, "session-env", session, "env"), "", ageMs),
    put(join(claude, "todos", `${session}-agent-${session}.json`), "[]", ageMs),
    put(join(claude, "debug", `${session}.txt`), "debug", ageMs),
  ];
  // A session's folders last changed when it last wrote into them.
  for (const dir of [join(project, session, "subagents"), join(project, session, "tool-results"), join(project, session), join(claude, "file-history", session), join(claude, "session-env", session)]) {
    utimesSync(dir, new Date(NOW - ageMs), new Date(NOW - ageMs));
  }
  return files;
}

function seed() {
  writeFileSync(join(dataDir, "events", "t1.ndjson"), [LIVE, ENDED, ENDED_RECENT, HANDED].map((s) => started("t1", s)).join(""));
  const files = {
    live: claudeSession(LIVE),
    ended: claudeSession(ENDED),
    recent: claudeSession(ENDED_RECENT, DAY),
    unlogged: claudeSession(UNLOGGED),
    handed: claudeSession(HANDED),
    codexEnded: [put(join(codex, "sessions", "2026", "11", "01", `rollout-2026-11-01T00-00-00-${ENDED}.jsonl`))],
    codexLive: [put(join(codex, "sessions", "2026", "11", "01", `rollout-2026-11-01T00-00-00-${LIVE}.jsonl`))],
    kept: [
      put(join(claude, ".credentials.json"), "{}"), put(join(claude, "settings.json"), "{}"),
      put(join(claude, "projects", "-home-work", "memory", "MEMORY.md"), "notes"),
      put(join(codex, "auth.json"), "{}"), put(join(codex, "config.toml"), ""), put(join(codex, "state_5.sqlite"), ""),
    ],
    cacheOld: put(join(home, ".cache", "claude-cli-nodejs", "-home-work", "mcp-logs-x", "2026-11-01.jsonl"), "z".repeat(1_000)),
    cacheNew: put(join(home, ".cache", "claude-cli-nodejs", "-home-work", "mcp-logs-y", "2026-11-23.jsonl"), "z", 60_000),
  };
  // An old folder of only old logs goes once empty; its parent keeps the newer one.
  utimesSync(dirname(files.cacheOld), new Date(NOW - 10 * DAY), new Date(NOW - 10 * DAY));
  return files;
}

/** Every entry under `dir` with its size and change time, links as links. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    const stats = lstatSync(at);
    out.push(`${at} ${stats.size} ${stats.mtimeMs}`);
    if (stats.isDirectory()) for (const name of readdirSync(at).sort()) walk(join(at, name));
  };
  walk(dir);
  return out;
}

const bots = [{ id: "b1", resumeCursors: { claude: LIVE }, tasks: [{ threadId: "t1", resumeCursors: { claude: LIVE, codex: LIVE }, handedMessages: { claude: { session: HANDED } } }] }];

async function deps(mode: "on" | "report", extra: Partial<EngineSessionSweepDeps> = {}): Promise<EngineSessionSweepDeps> {
  return {
    dataDir, mode, folders: engineSessionFolders(dataDir, [{ HOME: home }]), cacheRoots: claudeCliCacheRoots([{ HOME: home }]),
    live: () => liveSessions(bots), logged: await createLoggedSessions(join(dataDir, "events"))(), now: () => NOW, ...extra,
  };
}

describe("the engine sessions' switch and inputs", () => {
  it("is off unless set", () => {
    expect(engineSessionSweepMode({})).toBe("off");
    expect(engineSessionSweepMode({ OMB_ENGINE_SESSION_SWEEP: "yes please" })).toBe("off");
    expect(engineSessionSweepMode({ OMB_ENGINE_SESSION_SWEEP: "report" })).toBe("report");
    expect(engineSessionSweepMode({ OMB_ENGINE_SESSION_SWEEP: "on" })).toBe("on");
  });

  it("counts every cursor and handed session as live", () => {
    expect([...liveSessions(bots)].sort()).toEqual([LIVE, HANDED].sort());
    expect(liveSessions([{ resumeCursors: { pi: "/abs/path.jsonl", x: 3 } }])).toEqual(new Set(["/abs/path.jsonl"]));
  });

  it("finds the CLI's log folder through XDG_CACHE_HOME or HOME, never a relative one", () => {
    expect(claudeCliCacheRoots([{ HOME: "/data" }, { HOME: "/data", XDG_CACHE_HOME: "/data/x" }, { HOME: "rel" }, {}])).toEqual([join(resolve("/data"), ".cache", "claude-cli-nodejs"), join(resolve("/data/x"), "claude-cli-nodejs")]);
  });

  it("reads the logs' session lines on from where it stopped, and again from the start after a rewrite", async () => {
    const log = join(dataDir, "events", "t2.ndjson");
    const logged = createLoggedSessions(join(dataDir, "events"));
    const whole = started("t2", id(7));
    writeFileSync(log, started("t2", id(6)) + whole.slice(0, 40));
    expect([...(await logged())]).toEqual([id(6)]);
    appendFileSync(log, whole.slice(40));
    expect([...(await logged())].sort()).toEqual([id(6), id(7)]);
    writeFileSync(log, started("t2", id(8)));
    expect([...(await logged())]).toEqual([id(8)]);
    writeFileSync(join(dataDir, "events", "bad.ndjson"), `${JSON.stringify({ type: "session.started", sessionId: "../../etc" })}\nnot json "session.started"\n`);
    expect([...(await logged())]).toEqual([id(8)]);
  });
});

describe("sweepEngineSessions", () => {
  it("removes MausBot's ended sessions a week idle and the CLI's old logs, and nothing else", async () => {
    const files = seed();
    const result = await sweepEngineSessions(await deps("on"));
    expect(result.sessions).toBe(1);
    expect(result.kept).toBe(1);
    expect(result.cacheFiles).toBe(1);
    for (const file of [...files.ended, ...files.codexEnded, files.cacheOld]) expect(existsSync(file), file).toBe(false);
    expect(existsSync(join(claude, "projects", "-home-work", ENDED))).toBe(false);
    expect(existsSync(dirname(files.cacheOld))).toBe(false);
    for (const file of [...files.live, ...files.recent, ...files.unlogged, ...files.handed, ...files.codexLive, ...files.kept, files.cacheNew]) {
      expect(existsSync(file), file).toBe(true);
    }
    expect(sweepLine(result)).toContain("freed");
    // Removed by a rename into the app's trash, which the pass empties.
    expect(readdirSync(join(dataDir, TRASH_DIR))).toEqual([]);
    expect(JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"))).toEqual({ cleanupPeriodDays: CLAUDE_TRANSCRIPT_DAYS });
    expect(result.retentionSet).toBe(1);
  });

  it("removes nothing while a turn runs, and goes on once none does", async () => {
    const files = seed();
    const busy = await sweepEngineSessions(await deps("on", { turnsRunning: () => true, turnWaitMs: 0 }));
    expect(busy.stopped).toBe(true);
    for (const file of [...files.ended, files.cacheOld]) expect(existsSync(file)).toBe(true);
    let checks = 0;
    const later = await sweepEngineSessions(await deps("on", { turnsRunning: () => checks++ < 1, turnWaitMs: 60_000 }));
    expect([later.sessions, later.cacheFiles]).toEqual([1, 1]);
  }, 30_000);

  it("empties a trash an interrupted pass left, and nothing outside it", async () => {
    const left = put(join(dataDir, TRASH_DIR, "1700000000000", "0", "x.jsonl"));
    const beside = put(join(dataDir, "cache", "trash", "other", "keep.txt"));
    await emptyTrash(dataDir);
    expect(existsSync(left)).toBe(false);
    expect(existsSync(join(dataDir, TRASH_DIR))).toBe(true);
    expect(existsSync(beside)).toBe(true);
  });

  it("a report frees nothing and counts what removing would", async () => {
    seed();
    const before = tree(home);
    const report = await sweepEngineSessions(await deps("report"));
    expect(tree(home)).toEqual(before);
    const result = await sweepEngineSessions(await deps("on"));
    expect([report.sessions, report.sessionBytes, report.cacheFiles, report.cacheBytes]).toEqual([result.sessions, result.sessionBytes, result.cacheFiles, result.cacheBytes]);
    expect(report.sessionBytes).toBeGreaterThan(5_000);
    expect(sweepLine(report)).toContain("would free");
  });

  it("keeps a session whose folder looks old but has a file written to lately", async () => {
    const files = seed();
    const deep = join(claude, "projects", "-home-work", ENDED, "tool-results", "r.txt");
    writeFileSync(deep, "rewritten");
    utimesSync(join(claude, "projects", "-home-work", ENDED, "tool-results"), new Date(NOW - 10 * DAY), new Date(NOW - 10 * DAY));
    utimesSync(join(claude, "projects", "-home-work", ENDED), new Date(NOW - 10 * DAY), new Date(NOW - 10 * DAY));
    const result = await sweepEngineSessions(await deps("on", { now: () => Date.now() + 60_000 }));
    expect(result.sessions).toBe(0);
    for (const file of files.ended) expect(existsSync(file)).toBe(true);
  });

  it("keeps a session that became a conversation's again while the pass ran", async () => {
    const files = seed();
    let reads = 0;
    const result = await sweepEngineSessions(await deps("on", { live: () => (reads++ ? new Set([LIVE, HANDED, ENDED]) : liveSessions(bots)) }));
    expect(result.sessions).toBe(0);
    for (const file of files.ended) expect(existsSync(file)).toBe(true);
  });

  it("refuses when no conversation has a session, or none of theirs is where it looks", async () => {
    const files = seed();
    expect((await sweepEngineSessions(await deps("on", { live: () => new Set() }))).refused).toContain("may not have loaded");
    expect((await sweepEngineSessions(await deps("on", { live: () => new Set([id(99)]) }))).refused).toContain("removed nothing");
    for (const file of files.ended) expect(existsSync(file)).toBe(true);
  });

  it("stops for a move or backup", async () => {
    const files = seed();
    const result = await sweepEngineSessions(await deps("on", { paused: () => true }));
    expect(result.stopped).toBe(true);
    for (const file of files.ended) expect(existsSync(file)).toBe(true);
  });
});

describe("Claude Code's own transcript age", () => {
  it("is added where the person has not set it, kept where they have, and left alone where it cannot be read", async () => {
    mkdirSync(claude, { recursive: true });
    // No file: Claude Code's default is the same 30 days, so none is made.
    expect(await pinClaudeRetention(claude, true)).toBe("absent");
    expect(existsSync(join(claude, "settings.json"))).toBe(false);
    writeFileSync(join(claude, "settings.json"), "{}");
    expect(await pinClaudeRetention(claude, false)).toBe("set");
    expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe("{}");
    expect(await pinClaudeRetention(claude, true)).toBe("set");
    expect(JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"))).toEqual({ cleanupPeriodDays: 30 });
    writeFileSync(join(claude, "settings.json"), JSON.stringify({ cleanupPeriodDays: 365, model: "x" }));
    expect(await pinClaudeRetention(claude, true)).toBe("kept");
    expect(JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"))).toEqual({ cleanupPeriodDays: 365, model: "x" });
    writeFileSync(join(claude, "settings.json"), "{ not json");
    expect(await pinClaudeRetention(claude, true)).toBe("skipped");
    expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe("{ not json");
    if (process.platform === "win32") return;
    rmSync(join(claude, "settings.json"));
    const elsewhere = put(join(root, "theirs.json"), "{}");
    symlinkSync(elsewhere, join(claude, "settings.json"));
    expect(await pinClaudeRetention(claude, true)).toBe("skipped");
    expect(readFileSync(elsewhere, "utf8")).toBe("{}");
  });

  it("keeps the file's mode, indentation and line endings", async () => {
    mkdirSync(claude, { recursive: true });
    const file = join(claude, "settings.json");
    for (const [before, after] of [
      ['{\n    "theme": "dark"\n}\n', '{\n    "theme": "dark",\n    "cleanupPeriodDays": 30\n}\n'],
      ['{\n\t"theme": "dark"\n}', '{\n\t"theme": "dark",\n\t"cleanupPeriodDays": 30\n}'],
      ['{\r\n  "theme": "dark"\r\n}\r\n', '{\r\n  "theme": "dark",\r\n  "cleanupPeriodDays": 30\r\n}\r\n'],
      ['{"theme":"dark"}\n', '{"theme":"dark","cleanupPeriodDays":30}\n'],
    ] as const) {
      writeFileSync(file, before);
      if (process.platform !== "win32") chmodSync(file, 0o644);
      expect(await pinClaudeRetention(claude, true)).toBe("set");
      expect(readFileSync(file, "utf8")).toBe(after);
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o644);
    }
  });
});

describe("a pass", () => {
  const passDeps = async (mode: "on" | "report", extra: Partial<EngineSessionPassDeps> = {}): Promise<EngineSessionPassDeps> => {
    const base = await deps(mode);
    return {
      dataDir, mode, folders: () => base.folders, cacheRoots: () => base.cacheRoots, live: base.live,
      logged: () => createLoggedSessions(join(dataDir, "events"))(), now: () => NOW, ...extra,
    };
  };
  const leftover = () => put(join(dataDir, TRASH_DIR, "1700000000000", "0", "x.jsonl"));

  it("during a move or backup, or while a turn runs, reads and writes nothing: not the trash, not settings.json", async () => {
    const files = seed();
    const trash = leftover();
    const settings = readFileSync(join(claude, "settings.json"), "utf8");
    let logsRead = 0;
    for (const extra of [{ paused: () => true }, { turnsRunning: () => true, turnWaitMs: 0 }]) {
      const result = await engineSessionPass(await passDeps("on", { ...extra, logged: async () => (logsRead++, new Set()) }));
      expect(result).toBeNull();
    }
    expect(logsRead).toBe(0);
    expect(existsSync(trash)).toBe(true);
    expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe(settings);
    for (const file of files.ended) expect(existsSync(file)).toBe(true);
  });

  it("a report changes nothing at all, an earlier pass's trash included", async () => {
    seed();
    leftover();
    const before = tree(home);
    const result = await engineSessionPass(await passDeps("report"));
    expect(result?.sessions).toBe(1);
    expect(result?.retentionSet).toBe(1);
    expect(tree(home)).toEqual(before);
  });

  it("in on mode empties an interrupted pass's trash, then sweeps", async () => {
    const files = seed();
    const trash = leftover();
    const result = await engineSessionPass(await passDeps("on"));
    expect(existsSync(trash)).toBe(false);
    expect(result?.sessions).toBe(1);
    for (const file of files.ended) expect(existsSync(file)).toBe(false);
  });
});

describe("what the engine sessions' sweep never reaches", () => {
  // Windows makes a link only with a privilege CI's runners lack; Cloud homes, where this runs, are Linux.
  it.skipIf(process.platform === "win32")("follows no link: a linked project folder, a linked session, a linked engine folder", async () => {
    seed();
    const outside = join(root, "outside");
    const target = put(join(outside, "project", `${ENDED}.jsonl`));
    const linkedFile = put(join(outside, "single.jsonl"));
    symlinkSync(join(outside, "project"), join(claude, "projects", "-linked"));
    rmSync(join(claude, "debug", `${ENDED}.txt`));
    symlinkSync(linkedFile, join(claude, "debug", `${ENDED}.txt`));
    lutimesSync(join(claude, "debug", `${ENDED}.txt`), new Date(NOW - 10 * DAY), new Date(NOW - 10 * DAY));
    const otherHome = join(root, "other");
    mkdirSync(otherHome);
    symlinkSync(outside, join(otherHome, ".claude"));
    const result = await sweepEngineSessions(await deps("on", { folders: engineSessionFolders(dataDir, [{ HOME: home }, { HOME: otherHome }]) }));
    expect(result.sessions).toBe(1);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(linkedFile)).toBe(true);
    expect(lstatSync(join(claude, "projects", "-linked")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(claude, "debug", `${ENDED}.txt`))).toBe(false);
  });

  it("never names a file by anything but a whole session id from a log", async () => {
    seed();
    writeFileSync(join(dataDir, "events", "t9.ndjson"), started("t9", "projects") + started("t9", "../.credentials.json"));
    const result = await sweepEngineSessions(await deps("on"));
    expect(result.sessions).toBe(1);
    expect(existsSync(join(claude, ".credentials.json"))).toBe(true);
    expect(existsSync(join(claude, "projects"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("an engine folder inside the data folder reached through a link is skipped", async () => {
    seed();
    const real = join(root, "elsewhere");
    mkdirSync(join(dataDir, "providers", "codex-own", "h2"), { recursive: true });
    put(join(real, "sessions", "2026", "11", "01", `rollout-x-${ENDED}.jsonl`));
    symlinkSync(real, join(dataDir, "providers", "codex-own", "h2", "codex"));
    await sweepEngineSessions(await deps("on"));
    expect(existsSync(join(real, "sessions", "2026", "11", "01", `rollout-x-${ENDED}.jsonl`))).toBe(true);
  });

  it("IDLE_MS is a week", () => expect(IDLE_MS).toBe(7 * DAY));
});
