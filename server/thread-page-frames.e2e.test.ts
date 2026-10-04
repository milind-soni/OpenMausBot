// Which bot and room frames carry a transcript, through the real server.
// A frame carries the newest page only when the bot's or room's open thread
// changes from the one last sent: other windows must swap transcripts then
// (a window whose open thread was deleted keeps its composer locked until a
// page arrives), and at no other time. A rename, pin or background delete
// used to send the whole open transcript next to its slim frame.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
/** Longer than one default page (50), so a page and the whole thread differ. */
const LONG = 60;

describe("transcript pages on bot and room frames", () => {
  let home = "";
  let base = "";
  let output = "";
  let child: ChildProcess | null = null;
  let stream: SseRecorder;
  let fenceBot = "";
  let fences = 0;

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  /** The frames one request sent for one bot or room. Frames arrive in
   * order, so once a later frame for another bot shows up, everything the
   * request sent has arrived too. */
  async function framesFor(kind: "bot" | "group", id: string, act: () => Promise<unknown>): Promise<any[]> {
    return (await framesDuring(act)).filter((frame) => frame.kind === kind && frame[kind]?.id === id).map((frame) => frame[kind]);
  }
  async function framesDuring(act: () => Promise<unknown>): Promise<any[]> {
    const start = stream.frames.length;
    await act();
    const name = `Fence ${++fences}`;
    expect((await api("PATCH", `/api/bots/${fenceBot}`, { name })).status).toBe(200);
    await stream.until((frame) => frame.kind === "bot" && frame.bot?.id === fenceBot && frame.bot.name === name);
    return stream.frames.slice(start);
  }

  /** A bot whose open thread holds LONG messages, restored from a backup. */
  async function longBot(): Promise<{ id: string; threadId: string }> {
    const source = (await api("POST", "/api/bots", { name: "Long Source" })).body.bot;
    const backup = (await api("POST", "/api/teams/export", { format: "backup", name: "Fixture" })).body;
    const bot = backup.bots.find((candidate: { name: string }) => candidate.name === source.name);
    const messages = Array.from({ length: LONG }, (_, i) => ({
      id: `m${i}`, role: i % 2 ? "bot" : "user", text: `message ${i}`, at: 1_700_000_000_000 + i, parentId: i ? `m${i - 1}` : null,
    }));
    bot.tasks = [{ key: "long", title: "Long thread", createdAt: 1_700_000_000_000, activeLeafId: `m${LONG - 1}`, messages }];
    bot.activeTask = "long";
    const imported = await api("POST", "/api/teams/import", { ...backup, bots: [bot], groups: [], routines: [] });
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    expect((await api("DELETE", `/api/bots/${source.id}`)).status).toBe(200);
    return imported.body.bots[0];
  }

  const texts = (messages: Array<{ text?: string }>) => messages.map((message) => message.text);
  const newestPage = Array.from({ length: 50 }, (_, i) => `message ${LONG - 50 + i}`);

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-thread-page-frames-"));
    const data = join(home, ".openmausbot");
    mkdirSync(data, { recursive: true });
    // one deliberately unknown driver: no engine CLI runs, nothing answers
    writeFileSync(join(data, "config.json"), JSON.stringify({
      features: { browser: false },
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } },
    }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    const proc = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", (chunk) => { output += chunk; });
    proc.stderr!.on("data", (chunk) => { output += chunk; });
    for (let deadline = Date.now() + 20_000; ;) {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { if ((await fetch(base + "/api/health")).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    fenceBot = (await api("POST", "/api/bots", { name: "Fence" })).body.bot.id;
    stream = await openSse(`${base}/api/events`);
    await stream.until((frame) => frame.kind === "hello");
  }, 40_000);

  afterAll(async () => {
    stream?.close();
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  });

  it("sends a bot's page only when its open thread changes", async () => {
    const bot = await longBot();
    for (const patch of [{ title: "Renamed" }, { pinned: true }]) {
      const frames = await framesFor("bot", bot.id, () => api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, patch));
      expect(frames).toHaveLength(1);
      expect(frames[0]).not.toHaveProperty("messages");
    }

    let created: { threadId: string } | undefined;
    const opened = await framesFor("bot", bot.id, async () => {
      created = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Short" })).body.task;
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ threadId: created!.threadId, messages: [], hasMore: false });

    // The switch route no longer sends a page of its own on top of this one.
    const back = await framesFor("bot", bot.id, () => api("POST", `/api/bots/${bot.id}/tasks/${bot.threadId}?messages=5`));
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ threadId: bot.threadId, hasMore: true });
    expect(texts(back[0].messages)).toEqual(newestPage);

    const background = await framesFor("bot", bot.id, () => api("DELETE", `/api/bots/${bot.id}/tasks/${created!.threadId}`));
    expect(background).toHaveLength(1);
    expect(background[0]).not.toHaveProperty("messages");
    expect(background[0].tasks).toHaveLength(1);
  });

  it("unlocks another window whose open thread is deleted, with the newest page", async () => {
    // The server suite cannot type-import the desktop app (separate
    // tsconfig), so window B's reducer is loaded at run time.
    const desktop = await import(pathToFileURL(join(ROOT, "src", "state", "store.tsx")).href);
    const bot = await longBot();
    const open = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Open in window B" })).body.task;
    const hydrated = (await api("GET", "/api/bots?messages=50")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    let windowB = { ...desktop.initialState, bots: [hydrated], selectedId: bot.id };
    expect(windowB.bots[0].threadId).toBe(open.threadId);

    // Window A deletes the thread window B is showing.
    const frames = await framesFor("bot", bot.id, () => api("DELETE", `/api/bots/${bot.id}/tasks/${open.threadId}`));
    for (const frame of frames) windowB = desktop.reducer(windowB, { type: "botPatched", bot: frame });
    expect(frames).toHaveLength(1);
    expect(windowB.bots[0].threadId).toBe(bot.threadId);
    // The composer is locked while this is set (Composer.tsx).
    expect(windowB.bots[0].awaitingThreadSnapshot).toBeFalsy();
    expect(texts(windowB.bots[0].messages)).toEqual(newestPage);
    expect(windowB.bots[0].hasMore).toBe(true);
  });

  it("leaves another window's scrollback alone when someone else opens a thread", async () => {
    const desktop = await import(pathToFileURL(join(ROOT, "src", "state", "store.tsx")).href);
    const bot = await longBot();
    const hydrated = (await api("GET", "/api/bots?messages=50")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    let windowB = { ...desktop.initialState, bots: [hydrated], selectedId: bot.id };
    expect(windowB.bots[0].hasMore).toBe(true);

    // A phone opens a new thread; its frame carries that thread's empty page.
    const frames = await framesFor("bot", bot.id, () => api("POST", `/api/bots/${bot.id}/tasks`, { title: "From the phone" }));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ messages: [], hasMore: false });
    for (const frame of frames) windowB = desktop.reducer(windowB, { type: "botPatched", bot: frame });
    // Window B stays on its thread, and "Load earlier" still reaches the rest.
    expect(windowB.bots[0].threadId).toBe(bot.threadId);
    expect(texts(windowB.bots[0].messages)).toEqual(newestPage);
    expect(windowB.bots[0].hasMore).toBe(true);
  });

  it("sends an imported team's bots and room one page each, from the store alone", async () => {
    let imported: any;
    const frames = await framesDuring(async () => {
      const reply = await api("POST", "/api/teams/import?mode=project", {
        format: "openmaus.team", version: 2, team: { name: "Imported", members: [
          { key: "first", name: "Imported One", appearance: { color: "purple" } },
          { key: "second", name: "Imported Two", appearance: { color: "blue" } },
        ] },
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      imported = reply.body;
    });
    const paged = (kind: "bot" | "group", id: string) =>
      frames.filter((frame) => frame.kind === kind && frame[kind]?.id === id && "messages" in frame[kind]);
    expect(imported.bots).toHaveLength(2);
    for (const bot of imported.bots) expect(paged("bot", bot.id)).toHaveLength(1);
    const roomFrames = frames.filter((frame) => frame.kind === "group" && frame.group?.id === imported.group.id);
    expect(roomFrames).toHaveLength(1);
    expect(roomFrames[0].group).toHaveProperty("messages");
  });

  it("sends a room's page only when its open thread changes", async () => {
    const member = (await api("POST", "/api/bots", { name: "Room Member" })).body.bot;
    const created = await api("POST", "/api/groups", { name: "Paging", memberIds: [member.id] });
    expect(created.status).toBe(201);
    const room = created.body.group;
    // mentions only, so no member answers the posts below
    expect((await api("PATCH", `/api/groups/${room.id}/setup`, { action: "complete", defaultResponder: { kind: "mentions" }, bulletin: "" })).status).toBe(200);
    for (let i = 0; i < LONG; i++) {
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: `message ${i}` })).status).toBe(202);
    }

    let task: { threadId: string } | undefined;
    const opened = await framesFor("group", room.id, async () => {
      task = (await api("POST", `/api/groups/${room.id}/tasks`, { title: "Side" })).body.task;
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ threadId: task!.threadId, messages: [], hasMore: false });

    const renamed = await framesFor("group", room.id, () => api("PATCH", `/api/groups/${room.id}/tasks/${task!.threadId}`, { title: "Renamed" }));
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).not.toHaveProperty("messages");

    const deleted = await framesFor("group", room.id, () => api("DELETE", `/api/groups/${room.id}/tasks/${task!.threadId}`));
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ threadId: room.threadId, hasMore: true });
    expect(texts(deleted[0].messages)).toEqual(newestPage);
  });

  it("answers thread and folder routes with the newest page, and a switch without ?messages with the whole thread", async () => {
    const bot = await longBot();
    const renamed = await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { title: "Again" });
    expect(renamed.status).toBe(200);
    expect(texts(renamed.body.bot.messages)).toEqual(newestPage);
    expect(renamed.body.bot.hasMore).toBe(true);

    const folder = await api("POST", `/api/bots/${bot.id}/projects`, { name: "Folder" });
    expect(folder.status).toBe(201);
    expect(texts(folder.body.bot.messages)).toEqual(newestPage);

    // Search results land through this switch (src/lib/focus-message.ts) and
    // need the hit's row, which can be older than one page.
    expect((await api("POST", `/api/bots/${bot.id}/tasks`, {})).status).toBe(201);
    const whole = await api("POST", `/api/bots/${bot.id}/tasks/${bot.threadId}`);
    expect(whole.body.bot.messages).toHaveLength(LONG);
    expect(whole.body.bot).not.toHaveProperty("hasMore");
  });
});
