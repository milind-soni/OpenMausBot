import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { NotificationLogEntry } from "../shared/notification.ts";
import type { WireBot, WireTask } from "../shared/wire.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const NEEDS_INPUT_REPLY = "Half done.\nNEEDS INPUT: which repository should I tag?";
const TEST_CAPABILITY_KEY = "thread-mute-fixture-capability";

interface ThreadRow { threadId: string; muted: boolean; own: boolean }
interface Line { role: string; kind: string; text?: string }

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";

const api = async <T = { error?: string }>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as T };
};
const botState = async (botId: string) => (await api<{ bots: WireBot[] }>("GET", "/api/bots?messages=0")).body.bots.find((bot) => bot.id === botId);
const taskOf = async (botId: string, threadId: string | undefined) => (await botState(botId))?.tasks?.find((task) => task.threadId === threadId);
const token = async (botId: string, threadId: string): Promise<Record<string, string>> => {
  const minted = await api<{ token: string }>("POST", "/api/testing/internal-capability", { botId, threadId, kind: "agents" },
    { "x-openmausbot-test-capability": TEST_CAPABILITY_KEY });
  expect(minted.status).toBe(201);
  return { authorization: `Bearer ${minted.body.token}` };
};
const createBot = async (name: string, instanceId = "fake", model = "claude-sonnet-5") => {
  const created = (await api<{ bot: WireBot }>("POST", "/api/bots", {})).body.bot;
  const patched = await api<{ bot: WireBot }>("PATCH", `/api/bots/${created.id}`, { name, notifications: true, modelSelection: { instanceId, model } });
  expect(patched.status).toBe(200);
  return patched.body.bot;
};
const personThread = async (botId: string, title: string) => {
  const created = await api<{ task: WireTask }>("POST", `/api/bots/${botId}/tasks`, { title });
  expect(created.status).toBe(201);
  return created.body.task.threadId;
};
/** A thread the bot opened on itself, as start_thread does; its first run has settled. */
const botOpenedThread = async (botId: string, threadId: string, title: string) => {
  const opened = await api<{ threadId: string }>("POST", "/api/internal/threads", { title, message: "Check the release notes." }, await token(botId, threadId));
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  await expect.poll(async () => (await taskOf(botId, opened.body.threadId))?.busy, { timeout: 15_000 }).toBe(false);
  return opened.body.threadId;
};
const setMute = (botId: string, threadId: string, notificationsMuted: unknown) =>
  api<{ task: WireTask }>("PATCH", `/api/bots/${botId}/tasks/${threadId}`, { notificationsMuted });
/** Sends one message and returns once its turn has settled with a reply. */
const chat = async (botId: string, threadId: string, text: string) => {
  expect((await api("POST", `/api/bots/${botId}/messages`, { text, threadId })).status).toBe(202);
  await expect.poll(async () => {
    const lines = (await api<{ messages: Line[] }>("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages;
    const asked = lines.findLastIndex((line) => line.role === "user" && line.text === text);
    const replied = asked >= 0 && lines.slice(asked + 1).some((line) => line.role === "bot" && line.kind === "text");
    return replied && (await taskOf(botId, threadId))?.busy === false;
  }, { timeout: 15_000 }).toBe(true);
};
const cleanup = async (botIds: string[]) => {
  for (const botId of botIds) await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
};

beforeAll(async () => {
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(FAKE_ACP, 0o755);
  home = mkdtempSync(join(tmpdir(), "omb-thread-mute-"));
  const data = join(home, ".openmausbot");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      fake: { driver: "claudeAgent", displayName: "Fake Claude", environment: { FAKE_CLAUDE_TOOL_CALLS: "[]" }, config: { cli: FAKE_CLAUDE } },
      // Every turn asks to run `echo hi`: on Ask, a tool approval card.
      asking: { driver: "grokAgent", displayName: "Asking fixture", environment: { FAKE_ACP_MODE: "permission" }, config: { cli: FAKE_ACP, fullAuto: false } },
      // Every turn stops to ask the person a question no rule may answer.
      curious: { driver: "grokAgent", displayName: "Curious fixture", environment: { FAKE_ACP_MODE: "question" }, config: { cli: FAKE_ACP, fullAuto: true } },
      needy: {
        driver: "claudeAgent", displayName: "Needy fixture", config: { cli: FAKE_CLAUDE },
        environment: { FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_REPLIES: JSON.stringify(Array.from({ length: 8 }, () => NEEDS_INPUT_REPLY)) },
      },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_TEST_INTERNAL_CAPABILITY_KEY: TEST_CAPABILITY_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  await vi.waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  }, { timeout: 20_000, interval: 100 });
}, 45_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("a thread's mute over HTTP", () => {
  it("is read on the thread and set, cleared or refused through the thread PATCH", async () => {
    const bot = await createBot("Iris");
    try {
      const side = await personThread(bot.id, "Side notes");
      expect(await taskOf(bot.id, side)).toMatchObject({ notificationsMuted: false, followsMuteDefault: true });

      const muted = await setMute(bot.id, side, true);
      expect(muted.status).toBe(200);
      expect(muted.body.task).toMatchObject({ notificationsMuted: true, followsMuteDefault: false });
      expect(await taskOf(bot.id, side)).toMatchObject({ notificationsMuted: true, followsMuteDefault: false });
      expect(await taskOf(bot.id, bot.threadId)).toMatchObject({ notificationsMuted: false });

      expect((await setMute(bot.id, side, null)).body.task).toMatchObject({ notificationsMuted: false, followsMuteDefault: true });
      expect((await setMute(bot.id, side, "yes")).status).toBe(400);
      expect((await setMute(bot.id, "no-such-thread", true)).status).toBe(404);
    } finally {
      await cleanup([bot.id]);
    }
  }, 30_000);
});

describe("notifications from a muted thread", () => {
  it("are dropped while the main chat still notifies, and a bot with notifications off stays quiet even unmuted", async () => {
    const bot = await createBot("Mona");
    const beacon = await createBot("Beacon");
    const stream = await openSse(`${base}/api/events`);
    const notices = (): NotificationLogEntry[] => stream.frames.flatMap((frame) => frame.kind === "notify" ? [frame.notification as NotificationLogEntry] : []);
    const noticeFor = (threadId: string, kind: NotificationLogEntry["kind"]) =>
      stream.until((frame) => frame.kind === "notify" && frame.notification?.threadId === threadId && frame.notification.kind === kind, 15_000);
    try {
      const side = await personThread(bot.id, "Side job");
      expect((await setMute(bot.id, side, true)).status).toBe(200);
      await chat(bot.id, side, "Summarise the side job.");
      // The muted thread settled first, so its frame, had there been one, precedes the main chat's.
      await chat(bot.id, bot.threadId, "Summarise the main chat.");
      await noticeFor(bot.threadId, "done");
      expect(notices().filter((notice) => notice.threadId === side)).toEqual([]);
      const feed = (await api<{ notifications: NotificationLogEntry[] }>("GET", "/api/notifications")).body.notifications;
      expect(feed.some((entry) => entry.threadId === side)).toBe(false);

      expect((await setMute(bot.id, side, false)).status).toBe(200);
      await chat(bot.id, side, "Summarise it again.");
      await noticeFor(side, "done");

      expect((await api("PATCH", `/api/bots/${bot.id}`, { notifications: false })).status).toBe(200);
      const before = notices().filter((notice) => notice.threadId === side).length;
      await chat(bot.id, side, "And once more, quietly.");
      await chat(beacon.id, beacon.threadId, "Ping.");
      await noticeFor(beacon.threadId, "done");
      expect(notices().filter((notice) => notice.threadId === side)).toHaveLength(before);
    } finally {
      stream.close();
      await cleanup([bot.id, beacon.id]);
    }
  }, 60_000);
});

describe("a muted thread waiting on the person", () => {
  const withChief = async (withOne: boolean, botIds: string[]) => {
    if (!withOne) return [];
    const chief = await createBot("Charlie");
    expect((await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, peers: botIds })).status).toBe(200);
    return [chief.id];
  };

  it.each([false, true])("still asks for a tool approval, an answer and a sign-in (with a Chief of Staff: %s)", async (chiefInReach) => {
    const asker = await createBot("Ash", "asking", "fake-model");
    const curious = await createBot("Cleo", "curious", "fake-model");
    const signer = await createBot("Sid");
    const chiefs = await withChief(chiefInReach, [asker.id, curious.id, signer.id]);
    const stream = await openSse(`${base}/api/events`);
    try {
      expect((await api("PATCH", `/api/bots/${asker.id}`, { approvalMode: "ask" })).status).toBe(200);
      // A sign-in needs a place to sign in on: this bot works in its built-in browser.
      expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${signer.id}`, { computer: "browser" })).status).toBe(200);
      const threads = {
        approval: await personThread(asker.id, "Deploy"),
        question: await personThread(curious.id, "Palette"),
        "sign-in": await personThread(signer.id, "Vendor portal"),
      };
      for (const [botId, threadId] of [[asker.id, threads.approval], [curious.id, threads.question], [signer.id, threads["sign-in"]]] as const) {
        expect((await setMute(botId, threadId, true)).body.task).toMatchObject({ notificationsMuted: true });
      }
      expect((await api("POST", `/api/bots/${asker.id}/messages`, { text: "Deploy it.", threadId: threads.approval })).status).toBe(202);
      expect((await api("POST", `/api/bots/${curious.id}/messages`, { text: "Pick a colour.", threadId: threads.question })).status).toBe(202);
      const signIn = await api("POST", "/api/internal/request-sign-in", { site: "example.com", reason: "the portal wants a code" },
        await token(signer.id, threads["sign-in"]));
      expect(signIn.status, JSON.stringify(signIn.body)).toBe(201);
      for (const [kind, threadId] of Object.entries(threads)) {
        const frame = await stream.until((candidate) => candidate.kind === "notify" && candidate.notification?.kind === kind
          && candidate.notification.threadId === threadId, 20_000);
        expect(frame.notification.threadId).toBe(threadId);
      }
    } finally {
      stream.close();
      for (const botId of [asker.id, curious.id]) await api("POST", `/api/bots/${botId}/interrupt`, {}).catch(() => undefined);
      await api("PATCH", "/api/config", { features: { browser: false } }).catch(() => undefined);
      await cleanup([asker.id, curious.id, signer.id, ...chiefs]);
    }
  }, 90_000);

  it.each([false, true])("tells the person once that a turn ended needing them, with escalations off (with a Chief of Staff: %s)", async (chiefInReach) => {
    const needy = await createBot("Nell", "needy");
    const beacon = await createBot("Beacon");
    const chiefs = await withChief(chiefInReach, [needy.id]);
    const stream = await openSse(`${base}/api/events`);
    try {
      const side = await personThread(needy.id, "Release");
      expect((await setMute(needy.id, side, true)).status).toBe(200);
      await chat(needy.id, side, "Tag the release.");
      // The muted thread settled first, so every frame it sent precedes the beacon's.
      await chat(beacon.id, beacon.threadId, "Ping.");
      await stream.until((frame) => frame.kind === "notify" && frame.notification?.threadId === beacon.threadId && frame.notification.kind === "done", 15_000);
      const told = stream.frames.flatMap((frame) => frame.kind === "notify" && frame.notification?.botId !== beacon.id ? [frame.notification as NotificationLogEntry] : []);
      expect(told).toEqual([expect.objectContaining({ kind: "question", botId: needy.id, threadId: side, body: "which repository should I tag?" })]);
    } finally {
      stream.close();
      await cleanup([needy.id, beacon.id, ...chiefs]);
    }
  }, 60_000);
});

describe("a muted thread a teammate assigned, ending on NEEDS INPUT", () => {
  const dataDir = () => join(home, ".openmausbot");
  const woken = (assignmentId: string) => {
    const db = new DatabaseSync(join(dataDir(), "runtime.db"), { readOnly: true });
    try {
      return (db.prepare("SELECT detail FROM assignment_events WHERE assignment_id = ? AND kind = 'woken'").all(assignmentId) as Array<{ detail: string }>)
        .map((row) => row.detail);
    } finally { db.close(); }
  };
  /** Ava hands Nell work that ends on NEEDS INPUT, through the real coordinator; returns every notice about Nell. */
  const assign = async (opts: { muted: boolean; reply: "resume" | "none" }) => {
    const ava = await createBot("Ava");
    const nell = await createBot("Nell", "needy");
    const beacon = await createBot("Beacon");
    const stream = await openSse(`${base}/api/events`);
    try {
      expect((await api("PATCH", "/api/config", { features: { muteBotOpenedThreads: opts.muted } })).status).toBe(200);
      const asked = await api<{ receipts: Array<{ threadId: string }> }>("POST", "/api/internal/coordinate-bots",
        { botIds: [nell.id], message: "Tag the release.", reply: opts.reply }, await token(ava.id, ava.threadId));
      expect(asked.status, JSON.stringify(asked.body)).toBe(200);
      const work = asked.body.receipts[0]!.threadId;
      expect((await taskOf(nell.id, work))?.notificationsMuted).toBe(opts.muted);
      // Parked: the runtime's needs_input, which the coordinator's view shows as a question.
      await expect.poll(() => readHandoffs(dataDir()).find((node) => node.threadId === work)?.question, { timeout: 20_000 })
        .toBe("which repository should I tag?");
      const node = readHandoffs(dataDir()).find((candidate) => candidate.threadId === work)!;
      await expect.poll(async () => (await taskOf(nell.id, work))?.busy, { timeout: 15_000 }).toBe(false);
      // Nell's thread has parked, so every frame it sent precedes the beacon's.
      await chat(beacon.id, beacon.threadId, "Ping.");
      await stream.until((frame) => frame.kind === "notify" && frame.notification?.threadId === beacon.threadId && frame.notification.kind === "done", 15_000);
      const told = stream.frames.flatMap((frame) => frame.kind === "notify" && frame.notification?.botId === nell.id ? [frame.notification as NotificationLogEntry] : []);
      return { told, work, wakes: woken(node.id) };
    } finally {
      stream.close();
      await api("PATCH", "/api/config", { features: { muteBotOpenedThreads: false } });
      await cleanup([ava.id, nell.id, beacon.id]);
    }
  };
  const question = (threadId: string) => expect.objectContaining({ kind: "question", threadId, body: "which repository should I tag?" });

  it("stays silent when the assigner is woken with the question in its live thread", async () => {
    const { told, wakes } = await assign({ muted: true, reply: "resume" });
    expect(wakes).toEqual(["needs_input"]);
    expect(told).toEqual([]);
  }, 60_000);

  it("tells the person once when the assignment wants no reply", async () => {
    const { told, work, wakes } = await assign({ muted: true, reply: "none" });
    expect(wakes).toEqual([]);
    expect(told).toEqual([question(work)]);
  }, 60_000);

  it("is unchanged when the thread is not muted", async () => {
    const { told, work } = await assign({ muted: false, reply: "resume" });
    expect(told).toEqual([expect.objectContaining({ kind: "delegation-settled", threadId: work, body: "which repository should I tag?" })]);
  }, 60_000);
});

describe("muting threads a bot opened by default", () => {
  it("is off until opted in, then mutes bot-opened threads but never the person's or the main chat", async () => {
    const bot = await createBot("Opal");
    try {
      const opened = await botOpenedThread(bot.id, bot.threadId, "Release notes");
      const own = await personThread(bot.id, "My notes");
      expect(await taskOf(bot.id, opened)).toMatchObject({ notificationsMuted: false, followsMuteDefault: true });

      expect((await api("PATCH", "/api/config", { features: { muteBotOpenedThreads: true } })).status).toBe(200);
      expect(await taskOf(bot.id, opened)).toMatchObject({ notificationsMuted: true, followsMuteDefault: true });
      expect(await taskOf(bot.id, own)).toMatchObject({ notificationsMuted: false });
      expect(await taskOf(bot.id, (await botState(bot.id))?.mainThreadId)).toMatchObject({ notificationsMuted: false });
      expect((await setMute(bot.id, opened, false)).body.task).toMatchObject({ notificationsMuted: false, followsMuteDefault: false });
    } finally {
      await api("PATCH", "/api/config", { features: { muteBotOpenedThreads: false } });
      await cleanup([bot.id]);
    }
  }, 30_000);
});

describe("mute_thread for a Chief of Staff", () => {
  it("mutes threads bots opened in its reach, and refuses non-Chiefs, the person's threads, main chats and bots out of reach", async () => {
    const chief = await createBot("Charlie");
    const qa = await createBot("Quinn");
    const outsider = await createBot("Olive");
    try {
      expect((await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, peers: [qa.id] })).status).toBe(200);
      const work = await botOpenedThread(qa.id, qa.threadId, "QA: PR #9");
      const theirs = await personThread(qa.id, "Quinn's own audit");
      const away = await botOpenedThread(outsider.id, outsider.threadId, "Elsewhere");
      const mute = async (threadId: string, headers: Record<string, string>, muted: unknown = true) =>
        api<{ threadId: string; botName: string; muted: boolean; error?: string }>("POST", `/api/internal/threads/${threadId}/mute`, { muted }, headers);

      expect((await mute(work, await token(qa.id, qa.threadId))).status).toBe(403);
      const asChief = await token(chief.id, chief.threadId);
      expect((await mute(theirs, asChief)).status).toBe(403);
      expect((await mute(qa.threadId, asChief)).status).toBe(403);
      expect((await mute(away, asChief)).status).toBe(404);
      expect((await mute(work, asChief, "yes")).status).toBe(400);
      for (const threadId of [theirs, qa.threadId]) expect((await taskOf(qa.id, threadId))?.notificationsMuted).toBe(false);
      expect((await taskOf(outsider.id, away))?.notificationsMuted).toBe(false);

      const muted = await mute(work, asChief);
      expect(muted.status, JSON.stringify(muted.body)).toBe(200);
      expect(muted.body).toMatchObject({ threadId: work, botName: "Quinn", muted: true });
      expect(await taskOf(qa.id, work)).toMatchObject({ notificationsMuted: true, notificationsMutedBy: "chief", followsMuteDefault: false });
      const rows = (await api<{ threads: ThreadRow[] }>("GET", "/api/internal/threads", undefined, asChief)).body.threads;
      expect(rows.find((row) => row.threadId === work)).toMatchObject({ muted: true, own: false });

      expect((await mute(work, asChief, false)).status, "the Chief may change its own choice").toBe(200);
      expect(await taskOf(qa.id, work)).toMatchObject({ notificationsMuted: false, notificationsMutedBy: "chief" });

      expect((await mute(work, asChief)).status).toBe(200);
      expect((await setMute(qa.id, work, false)).body.task, "the person may undo the Chief's").toMatchObject({ notificationsMuted: false, notificationsMutedBy: "person" });
      expect((await setMute(qa.id, work, true)).body.task).toMatchObject({ notificationsMuted: true, notificationsMutedBy: "person" });
      const kept = await mute(work, asChief, false);
      expect(kept.status, "the Chief may not undo the person's").toBe(403);
      expect(kept.body.error).toMatch(/only they can change it/);
      expect(await taskOf(qa.id, work)).toMatchObject({ notificationsMuted: true, notificationsMutedBy: "person" });
      expect((await setMute(qa.id, work, null)).body.task, "back to the default, nobody's choice").not.toHaveProperty("notificationsMutedBy");
      expect((await mute(work, asChief, false)).status).toBe(200);
    } finally {
      await cleanup([chief.id, qa.id, outsider.id]);
    }
  }, 60_000);
});
