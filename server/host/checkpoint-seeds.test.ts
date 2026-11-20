import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createCheckpointSeeds, STARTUP_FOLDERS, type SeedBot, type SeedChange } from "./checkpoint-seeds.ts";
import { refusalReason } from "../checkpoints.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await removeTempDir(dir);
});

function folder(kind: "project" | "plain"): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-seed-"));
  scratch.push(dir);
  if (kind === "project") mkdirSync(join(dir, ".git"));
  return dir;
}

type Read = { botId: string; cwd: string; signal: AbortSignal; end: () => void };

function setup(options: { bots?: SeedBot[]; chatOnly?: string[]; ownRoots?: string[] } = {}) {
  const bots = new Map((options.bots ?? []).map((bot) => [bot.id, bot]));
  const reads: Read[] = [];
  const clock = 1_000_000_000_000;
  let listener: (change: SeedChange) => void = () => {};
  let startUp: (() => void) | null = null;
  const seeds = createCheckpointSeeds({
    bots: () => [...bots.values()],
    bot: (id) => bots.get(id),
    worksInFolders: (bot) => !(options.chatOnly ?? []).includes(bot.id),
    refusal: refusalReason,
    prime: (botId, cwd, signal) => new Promise<void>((end) => {
      const read = { botId, cwd, signal, end };
      reads.push(read);
      signal.addEventListener("abort", () => end(), { once: true });
    }),
    onChange: (given) => { listener = given; },
    ownRoots: options.ownRoots ?? [],
    now: () => clock,
    later: (run) => { startUp = run; },
  });
  return {
    seeds,
    reads,
    bots,
    set(bot: SeedBot, threadId?: string) {
      bots.set(bot.id, bot);
      listener({ type: "bot", botId: bot.id, ...(threadId ? { threadId } : {}) });
    },
    remove(botId: string) {
      bots.delete(botId);
      listener({ type: "bot.deleted", botId });
    },
    now: () => clock,
    runStartUp() { startUp?.(); },
    started: () => startUp !== null,
  };
}

const read = (reads: Read[]) => reads.map((one) => `${one.botId}:${one.cwd}`);

describe("checkpoint seeds", () => {
  it("reads a project folder once when a bot is set to it, however often the bot changes afterwards", async () => {
    const project = folder("project");
    const host = setup();
    host.set({ id: "bob", cwd: project });
    host.set({ id: "bob", cwd: project });
    host.set({ id: "bob", cwd: project }, "thread-1");
    expect(read(host.reads)).toEqual([`bob:${project}`]);
    host.reads[0]!.end();
    await host.seeds.settled();
    host.set({ id: "bob", cwd: project });
    expect(host.reads).toHaveLength(1);
  });

  it("reads the folder one conversation was moved to", () => {
    const project = folder("project");
    const host = setup();
    host.set({ id: "bob", tasks: [{ threadId: "thread-1", cwd: project }, { threadId: "thread-2", cwd: null }] }, "thread-1");
    expect(read(host.reads)).toEqual([`bob:${project}`]);
  });

  it("never reads a folder without a repository, a refused folder, one of the app's own, or for a bot whose engine has no folder", () => {
    const plain = folder("plain");
    const project = folder("project");
    const own = folder("project");
    const host = setup({ chatOnly: ["chatty"], ownRoots: [own] });
    host.set({ id: "bob", cwd: plain });
    host.set({ id: "home", cwd: homedir() });
    host.set({ id: "docs", cwd: join(homedir(), "Documents") });
    host.set({ id: "relative", cwd: "some/project" });
    host.set({ id: "missing", cwd: join(plain, "gone") });
    host.set({ id: "chatty", cwd: project });
    host.set({ id: "private", cwd: own });
    host.set({ id: "nested", cwd: join(own, ".git") });
    host.set({ id: "none" });
    expect(host.reads).toEqual([]);
  });

  it("reads nothing because something else about a bot changed: not for bots already on their folders at start-up, not for a conversation pinned to its bot's folder", async () => {
    const project = folder("project");
    const other = folder("project");
    const onProject: SeedBot = { id: "bob", cwd: project, tasks: [{ threadId: "thread-1", cwd: other }, { threadId: "thread-2" }] };
    const host = setup({ bots: [onProject, { id: "amy", cwd: other }] });
    host.set(onProject);
    host.set(onProject, "thread-1");
    host.set({ id: "amy", cwd: other }, "main");
    host.set({ ...onProject, tasks: [{ threadId: "thread-1", cwd: other }, { threadId: "thread-2", cwd: project }] }, "thread-2");
    expect(host.reads).toEqual([]);
    // A folder being set is what reads one: on a conversation, then on a bot.
    host.set({ ...onProject, tasks: [{ threadId: "thread-1", cwd: other }, { threadId: "thread-2", cwd: other }] }, "thread-2");
    host.set({ id: "amy", cwd: project });
    expect(read(host.reads)).toEqual([`bob:${other}`]);
    host.reads[0]!.end();
    await Promise.resolve();
    await Promise.resolve();
    expect(read(host.reads)).toEqual([`bob:${other}`, `amy:${project}`]);
    host.reads[1]!.end();
    await host.seeds.settled();
  });

  it("reads one folder at a time, in the order they were set", async () => {
    const first = folder("project");
    const second = folder("project");
    const third = folder("project");
    const host = setup();
    host.set({ id: "a", cwd: first });
    host.set({ id: "b", cwd: second });
    host.set({ id: "c", cwd: third });
    expect(read(host.reads)).toEqual([`a:${first}`]);
    host.reads[0]!.end();
    await Promise.resolve();
    await Promise.resolve();
    expect(read(host.reads)).toEqual([`a:${first}`, `b:${second}`]);
    host.reads[1]!.end();
    await Promise.resolve();
    await Promise.resolve();
    host.reads[2]!.end();
    await host.seeds.settled();
    expect(read(host.reads)).toEqual([`a:${first}`, `b:${second}`, `c:${third}`]);
  });

  it("stops reading a folder its bot was moved off, and reads it again when the bot comes back", async () => {
    const old = folder("project");
    const next = folder("project");
    const host = setup();
    host.set({ id: "bob", cwd: old });
    host.set({ id: "bob", cwd: next });
    expect(host.reads[0]!.signal.aborted).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(read(host.reads)).toEqual([`bob:${old}`, `bob:${next}`]);
    expect(host.reads[1]!.signal.aborted).toBe(false);
    host.reads[1]!.end();
    await host.seeds.settled();
    host.set({ id: "bob", cwd: old });
    expect(read(host.reads)).toEqual([`bob:${old}`, `bob:${next}`, `bob:${old}`]);
  });

  it("stops and forgets a deleted bot's folders, running or waiting", async () => {
    const first = folder("project");
    const second = folder("project");
    const host = setup();
    host.set({ id: "a", cwd: first });
    host.set({ id: "b", cwd: second });
    host.remove("b");
    host.remove("a");
    expect(host.reads[0]!.signal.aborted).toBe(true);
    await host.seeds.settled();
    expect(host.reads).toHaveLength(1);
  });

  it("reads nothing at start-up until it is told the start-up is over, then the folders used in the last week, newest first", async () => {
    const day = 24 * 60 * 60 * 1000;
    const projects = Array.from({ length: STARTUP_FOLDERS + 2 }, () => folder("project"));
    const stale = folder("project");
    const plain = folder("plain");
    const host = setup();
    const at = host.now();
    for (const [index, project] of projects.entries()) host.bots.set(`bot-${index}`, { id: `bot-${index}`, cwd: project, tasks: [{ threadId: `t-${index}`, updatedAt: at - index * 1000 }] });
    host.bots.set("stale", { id: "stale", cwd: stale, tasks: [{ threadId: "t-stale", updatedAt: at - 8 * day, askedAt: at - 9 * day }] });
    host.bots.set("plain", { id: "plain", cwd: plain, tasks: [{ threadId: "t-plain", askedAt: at }] });
    host.bots.set("moved", { id: "moved", cwd: stale, tasks: [{ threadId: "t-private", cwd: null, updatedAt: at }] });
    host.bots.set("unused", { id: "unused", cwd: stale });
    host.seeds.start();
    expect(host.started()).toBe(true);
    expect(host.reads).toEqual([]);
    host.runStartUp();
    for (let n = 0; n < STARTUP_FOLDERS + 4; n += 1) {
      host.reads[n]?.end();
      await Promise.resolve();
      await Promise.resolve();
    }
    await host.seeds.settled();
    // "plain" took one of the places and was turned away for having no repository.
    expect(read(host.reads)).toEqual(projects.slice(0, STARTUP_FOLDERS - 1).map((project, index) => `bot-${index}:${project}`));
  });

  it("reads nothing more once the server is shutting down, and stops the read under way", () => {
    const first = folder("project");
    const second = folder("project");
    const host = setup();
    host.set({ id: "a", cwd: first });
    host.seeds.stop();
    expect(host.reads[0]!.signal.aborted).toBe(true);
    host.set({ id: "b", cwd: second });
    host.seeds.start();
    host.runStartUp();
    expect(host.reads).toHaveLength(1);
  });
});
