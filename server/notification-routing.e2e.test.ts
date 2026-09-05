import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";

// Where a signal lands, end to end. Two bugs live here, and both are about a
// notification pointing at a conversation that did not change:
//
//   • a room reply also lit the speaking bot's own 1:1 badge — the sidebar
//     dot, the section count, the dock badge and the phone's Updates row all
//     opened a transcript where nothing had happened;
//   • bot-to-bot coordination raised badges and OS banners for the hop
//     behind one answer, because the peer's turn settles on its own thread.
//
// What must still break through is the other half: a card that reached a
// human, and a bot asking for hands — which now deep-links to the room it is
// stuck in. The unit halves of these rules live in notify.test.ts and
// comms-visibility.test.ts; this file pins the wiring around them.
//
// Every silence asserted below is only worth something beside the noise, so
// the ordinary turn — the one a person asked for, which must still badge and
// still buzz — is pinned first. A gate that suppressed everything would pass
// the quiet cases perfectly.

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const TEST_CAPABILITY_KEY = "notification-routing-fixture-capability";

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let dumpFile = "";

const api = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

const capability = async (
  botId: string,
  threadId: string,
  kind: "agents" | "computer" = "agents",
): Promise<Record<string, string>> => {
  const minted = await api(
    "POST",
    "/api/testing/internal-capability",
    { botId, threadId, kind },
    { "x-openmausbot-test-capability": TEST_CAPABILITY_KEY },
  );
  expect(minted.status).toBe(201);
  return { authorization: `Bearer ${minted.body.token}` };
};

const state = async (messages = 40) => (await api("GET", `/api/bots?messages=${messages}`)).body;
const botState = async (botId: string) =>
  (await state(40)).bots.find((candidate: { id: string }) => candidate.id === botId);
const groupState = async (groupId: string) =>
  (await state(40)).groups.find((candidate: { id: string }) => candidate.id === groupId);

const createBot = async (name: string, instanceId: string, model = "claude-sonnet-5") => {
  const created = (await api("POST", "/api/bots", {})).body.bot;
  // notifications on, explicitly: a silent bot would pass the "no banner"
  // assertions for the wrong reason
  const patched = await api("PATCH", `/api/bots/${created.id}`, {
    name,
    notifications: true,
    modelSelection: { instanceId, model },
  });
  expect(patched.status).toBe(200);
  return patched.body.bot;
};

const cleanup = async (groupIds: Array<string | undefined>, botIds: string[]) => {
  for (const groupId of groupIds) {
    if (groupId) await api("POST", `/api/groups/${groupId}/interrupt`, {}).catch(() => undefined);
  }
  for (const botId of botIds) await api("POST", `/api/bots/${botId}/interrupt`, {}).catch(() => undefined);
  for (const groupId of groupIds) {
    if (groupId) await api("DELETE", `/api/groups/${groupId}`).catch(() => undefined);
  }
  for (const botId of botIds) await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
};

beforeAll(async () => {
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(FAKE_ACP, 0o755);
  home = mkdtempSync(join(tmpdir(), "omb-notification-routing-"));
  const data = join(home, ".openmausbot");
  mkdirSync(data, { recursive: true });
  dumpFile = join(home, "quick-dump.json");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      // the everyday fixture: answers at once. Its dump is also the only
      // place a test can read the per-boot comms token from, and the
      // internal endpoints these tests drive are sealed behind it.
      quick: {
        driver: "claudeAgent",
        displayName: "Quick fixture",
        environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: dumpFile },
        config: { cli: FAKE_CLAUDE },
      },
      // never finishes: how a bot is held mid-room long enough to ask for
      // hands while the room still owns it
      stuck: {
        driver: "claudeAgent",
        displayName: "Stuck fixture",
        environment: { FAKE_CLAUDE_MODE: "hang" },
        config: { cli: FAKE_CLAUDE },
      },
      // stops mid-turn to ask the person a question no rule may answer —
      // the card that has to reach a human even from a peer's turn
      curious: {
        driver: "grokAgent",
        displayName: "Curious fixture",
        environment: { FAKE_ACP_MODE: "question" },
        config: { cli: FAKE_ACP, fullAuto: true },
      },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      // the question-card test leaves its peer turn open on purpose; keep the
      // synchronous ask from parking for the production four minutes
      OMB_ASK_BOT_TIMEOUT_MS: "6000",
      OMB_TEST_INTERNAL_CAPABILITY_KEY: TEST_CAPABILITY_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
      // still starting
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

}, 45_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("an ordinary turn still announces itself", () => {
  it("badges the bot and banners the person when a person asked", async () => {
    const bot = await createBot("Herald", "quick");
    const stream = await openSse(`${base}/api/events`);
    try {
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "how did it go?" })).status).toBe(202);

      // the plain case the whole feature is carved out of: nobody delegated
      // this, so the answer is news, and news gets a badge and a banner
      const frame = await stream.until(
        (candidate) =>
          candidate.kind === "notify" &&
          candidate.notification?.kind === "done" &&
          candidate.notification?.botId === bot.id,
        20_000,
      );
      expect(frame.notification).toMatchObject({ threadId: bot.threadId, title: "Herald finished" });
      expect(frame.notification.body).toContain("hello from fake claude");
      // no room in the picture, so nothing to group it under
      expect(frame.notification.groupId).toBeUndefined();
      await expect.poll(async () => (await botState(bot.id))?.unread, { timeout: 20_000 }).toBe(true);
    } finally {
      stream.close();
      await cleanup([], [bot.id]);
    }
  }, 40_000);
});

describe("a room turn belongs to the room", () => {
  it("leaves the speaking bot's own thread unread-free while the room lights up", async () => {
    const bot = await createBot("Roomie", "quick");
    let roomId: string | undefined;
    try {
      const room = (await api("POST", "/api/groups", {
        name: "Standup",
        memberIds: [bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
      })).body.group;
      roomId = room.id;
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "status?" })).status).toBe(202);

      await expect.poll(async () => {
        const current = await groupState(room.id);
        const replied = (current?.messages ?? []).some(
          (message: { kind: string; role?: string }) => message.kind === "text" && message.role === "bot",
        );
        return { working: current?.working, replied };
      }, { timeout: 20_000 }).toEqual({ working: false, replied: true });

      // the room is where the reply is, so the room is what is unread. The
      // bot's 1:1 transcript never changed and must not claim otherwise.
      expect((await groupState(room.id))?.unread).toBe(true);
      expect((await botState(bot.id))?.unread).toBeFalsy();
    } finally {
      await cleanup([roomId], [bot.id]);
    }
  }, 40_000);

  it("sends a takeover raised mid-room to the room, not to the bot's DM", async () => {
    const bot = await createBot("Handsy", "stuck");
    let roomId: string | undefined;
    let requestId: string | undefined;
    try {
      const room = (await api("POST", "/api/groups", {
        name: "War Room",
        memberIds: [bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
      })).body.group;
      roomId = room.id;
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "take the wheel" })).status).toBe(202);
      // the room must actually own the bot before it asks for hands
      await expect.poll(async () => (await groupState(room.id))?.busyBotId, { timeout: 20_000 }).toBe(bot.id);

      const stream = await openSse(`${base}/api/events`);
      try {
        const asked = await api(
          "POST",
          `/api/internal/computer-control?botId=${bot.id}`,
          { reason: "the login page wants a code" },
          await capability(bot.id, room.threadId, "computer"),
        );
        expect(asked.status).toBe(200);
        requestId = asked.body.requestId;

        const frame = await stream.until(
          (candidate) => candidate.kind === "notify" && candidate.notification?.kind === "takeover",
          15_000,
        );
        expect(frame.notification).toMatchObject({
          botId: bot.id,
          threadId: room.threadId,
          groupId: room.id,
          title: "Handsy in War Room needs your hands",
          body: "the login page wants a code",
        });
        // the DM is exactly where the person must NOT be sent: the screen
        // that needs hands is attached to the room's turn
        expect(frame.notification.threadId).not.toBe(bot.threadId);
      } finally {
        stream.close();
      }
    } finally {
      if (requestId) {
        await api(
          "DELETE",
          `/api/internal/computer-control?botId=${bot.id}`,
          { requestId },
          await capability(bot.id, roomId ? (await groupState(roomId)).threadId : bot.threadId, "computer"),
        ).catch(() => undefined);
      }
      await cleanup([roomId], [bot.id]);
    }
  }, 45_000);
});

describe("bot-to-bot coordination is recorded, not announced", () => {
  it("runs an ask_bot round trip with no badge and no banner anywhere", async () => {
    const asker = await createBot("Pen", "quick");
    const peer = await createBot("Ink", "quick");
    let channelId: string | undefined;
    const stream = await openSse(`${base}/api/events`);
    try {
      // Ink already answered the person earlier and they have not looked yet.
      // A hop runs on Ink's own 1:1 thread, so this badge is the one it could
      // spend by mistake — seeded true, or the "no badge" checks below would
      // pass for a hop that had just cleared it.
      expect((await api("PATCH", `/api/bots/${peer.id}`, { unread: true })).status).toBe(200);
      expect((await botState(peer.id))?.unread).toBe(true);
      const asked = await api(
        "POST",
        "/api/internal/ask-bot",
        { fromBotId: asker.id, toBotId: peer.id, message: "Ink, can you take the deploy?" },
        await capability(asker.id, asker.threadId),
      );
      expect(asked.status).toBe(200);
      expect(asked.body.botName).toBe("Ink");
      expect(asked.body.text).toContain("hello from fake claude");

      const current = await state(40);
      const channel = current.groups.find(
        (group: { dm?: boolean; memberIds: string[] }) =>
          group.dm === true && group.memberIds.includes(asker.id) && group.memberIds.includes(peer.id),
      );
      channelId = channel?.id;
      expect(channel).toBeTruthy();

      // the record is whole: the channel holds both sides of the exchange...
      expect(channel.messages.some((message: { text?: string }) => message.text === "Ink, can you take the deploy?")).toBe(true);
      expect(channel.messages.some(
        (message: { from?: { botId?: string }; text?: string }) =>
          message.from?.botId === peer.id && (message.text ?? "").includes("hello from fake claude"),
      )).toBe(true);
      // ...and both 1:1 threads keep their clickable chip into it
      const chip = (botId: string, name: string) =>
        (current.bots.find((candidate: { id: string }) => candidate.id === botId)?.messages ?? []).some(
          (message: { kind: string; tool?: { name?: string }; comm?: { groupId?: string } }) =>
            message.kind === "activity" && message.tool?.name === name && message.comm?.groupId === channel.id,
        );
      expect(chip(asker.id, "Messaged @Ink")).toBe(true);
      expect(chip(peer.id, "Message from @Pen")).toBe(true);

      // nothing about it is worth interrupting anyone: no channel badge, and
      // the asker — whose thread only carries a chip — gets no dot
      expect(channel.unread).toBeFalsy();
      expect(current.bots.find((candidate: { id: string }) => candidate.id === asker.id)?.unread).toBeFalsy();
      // ...while the badge Ink already earned is neither spent by the hop
      // nor re-raised by it: still exactly the one signal the person had
      expect(current.bots.find((candidate: { id: string }) => candidate.id === peer.id)?.unread).toBe(true);

      // A unique bot patch is an SSE ordering barrier: by the time it is
      // observed, every notification this exchange raised is already in
      // `frames` — including one the fold should never have sent.
      expect((await api("PATCH", `/api/bots/${asker.id}`, { name: "Pen observed" })).status).toBe(200);
      await stream.until(
        (candidate) => candidate.kind === "bot" && candidate.bot?.id === asker.id && candidate.bot?.name === "Pen observed",
      );
      expect(stream.frames.filter((candidate) => candidate.kind === "notify")).toEqual([]);
    } finally {
      stream.close();
      await cleanup([channelId], [asker.id, peer.id]);
    }
  }, 45_000);

  // A hop runs on the PEER'S OWN 1:1 thread (askBotAndWait dispatches to
  // target.threadId) — the very thread the person types into. So the
  // classification must not outlive the turn that earned it: leak it once,
  // in either of the two ways a hop can end, and that bot's DM is mute from
  // then on, with nothing anywhere to say why.
  const pairChannelId = async (a: string, b: string) =>
    (await state(0)).groups.find(
      (group: { dm?: boolean; memberIds: string[] }) =>
        group.dm === true && group.memberIds.includes(a) && group.memberIds.includes(b),
    )?.id;

  it("still announces the person's own next message after a hop that finished", async () => {
    const asker = await createBot("Nib", "quick");
    const peer = await createBot("Vellum", "quick");
    let channelId: string | undefined;
    const stream = await openSse(`${base}/api/events`);
    try {
      const asked = await api(
        "POST",
        "/api/internal/ask-bot",
        { fromBotId: asker.id, toBotId: peer.id, message: "Vellum, is the branch green?" },
        await capability(asker.id, asker.threadId),
      );
      expect(asked.status).toBe(200);
      expect((await botState(peer.id))?.unread).toBeFalsy();

      // same bot, same thread, but a person is asking this time
      expect((await api("POST", `/api/bots/${peer.id}/messages`, { text: "and for me?" })).status).toBe(202);
      const frame = await stream.until(
        (candidate) =>
          candidate.kind === "notify" &&
          candidate.notification?.kind === "done" &&
          candidate.notification?.botId === peer.id,
        20_000,
      );
      expect(frame.notification.threadId).toBe(peer.threadId);
      await expect.poll(async () => (await botState(peer.id))?.unread, { timeout: 20_000 }).toBe(true);
      channelId = await pairChannelId(asker.id, peer.id);
    } finally {
      stream.close();
      await cleanup([channelId], [asker.id, peer.id]);
    }
  }, 45_000);

  it("still announces the person's own next message after a hop that never started", async () => {
    const asker = await createBot("Quire", "quick");
    const peer = await createBot("Folio", "quick");
    let channelId: string | undefined;
    const stream = await openSse(`${base}/api/events`);
    try {
      // Park the peer on an engine that is not there. startTurn classifies the
      // turn and THEN refuses to run it, so this hop marks the thread and dies
      // without ever reaching the completion fold — the one release the fold
      // cannot perform for it.
      expect((await api("PATCH", `/api/bots/${peer.id}`, {
        modelSelection: { instanceId: "ghost", model: "ghost-1" },
      })).status).toBe(200);
      const asked = await api(
        "POST",
        "/api/internal/ask-bot",
        { fromBotId: asker.id, toBotId: peer.id, message: "Folio, still there?" },
        await capability(asker.id, asker.threadId),
      );
      expect(asked.status).toBe(200);
      expect(asked.body.text).toContain("couldn't start");

      expect((await api("PATCH", `/api/bots/${peer.id}`, {
        modelSelection: { instanceId: "quick", model: "claude-sonnet-5" },
      })).status).toBe(200);
      expect((await api("POST", `/api/bots/${peer.id}/messages`, { text: "back? tell me when" })).status).toBe(202);
      const frame = await stream.until(
        (candidate) =>
          candidate.kind === "notify" &&
          candidate.notification?.kind === "done" &&
          candidate.notification?.botId === peer.id,
        20_000,
      );
      expect(frame.notification.threadId).toBe(peer.threadId);
      await expect.poll(async () => (await botState(peer.id))?.unread, { timeout: 20_000 }).toBe(true);
      channelId = await pairChannelId(asker.id, peer.id);
    } finally {
      stream.close();
      await cleanup([channelId], [asker.id, peer.id]);
    }
  }, 45_000);

  it("buzzes when a bot stops to ask whether it may contact a teammate", async () => {
    const asker = await createBot("Nib", "quick");
    const peer = await createBot("Dot", "quick");
    // the one gate a person switches on for a bot's peer comms — the card it
    // raises is the one bot-to-bot event that genuinely blocks on them
    expect((await api("PATCH", `/api/bots/${asker.id}`, { approvePeerComms: true })).status).toBe(200);
    const stream = await openSse(`${base}/api/events`);
    const asking = api(
      "POST",
      "/api/internal/ask-bot",
      { fromBotId: asker.id, toBotId: peer.id, message: "Dot, can you take the deploy?" },
      await capability(asker.id, asker.threadId),
    );
    try {
      const frame = await stream.until(
        (candidate) => candidate.kind === "notify" && candidate.notification?.botId === asker.id,
        20_000,
      );
      expect(frame.notification).toMatchObject({
        kind: "approval",
        botId: asker.id,
        threadId: asker.threadId,
        title: "Nib needs approval",
      });
      expect(frame.notification.body).toContain("wants to contact @Dot");
      // the card is really open where the banner points
      const card = (await botState(asker.id))?.messages.findLast(
        (message: { kind: string; card?: { requestId?: string; tool?: string } }) => message.kind === "options" && Boolean(message.card?.requestId),
      );
      expect(card?.card?.tool).toBe("ask_bot");
      const denied = await api("POST", `/api/bots/${asker.id}/respond`, { requestId: card.card.requestId, behavior: "deny" });
      expect(denied.status).toBe(200);
      expect((await asking).body).toMatchObject({ error: "denied by user" });
    } finally {
      stream.close();
      await asking.catch(() => undefined);
      await cleanup([], [asker.id, peer.id]);
    }
  }, 45_000);

  it("still buzzes when a peer's turn stops to ask the person a question", async () => {
    const asker = await createBot("Quill", "quick");
    const peer = await createBot("Sage", "curious", "fake-model");
    let channelId: string | undefined;
    const stream = await openSse(`${base}/api/events`);
    // the peer's turn parks on its card, so the ask cannot be awaited yet
    const asking = api(
      "POST",
      "/api/internal/ask-bot",
      { fromBotId: asker.id, toBotId: peer.id, message: "Sage, which colour?" },
      await capability(asker.id, asker.threadId),
    );
    try {
      const frame = await stream.until(
        (candidate) => candidate.kind === "notify" && candidate.notification?.botId === peer.id,
        20_000,
      );
      // silencing the peer's completion must never silence the peer asking a
      // person for something only a person can give
      expect(frame.notification).toMatchObject({
        kind: "question",
        botId: peer.id,
        threadId: peer.threadId,
        title: "Sage has a question",
      });
      // the card is really open in the peer's thread — the banner is not
      // announcing something the person cannot act on (a new bot's onboarding
      // card sits above it, so take the turn's own)
      const card = (await botState(peer.id))?.messages.findLast(
        (message: { kind: string; card?: { title?: string } }) => message.kind === "options" && Boolean(message.card),
      );
      expect(card?.card).toMatchObject({ title: "Your bot has a question", subtitle: "Which color?" });

      const current = await state(0);
      channelId = current.groups.find(
        (group: { dm?: boolean; memberIds: string[] }) =>
          group.dm === true && group.memberIds.includes(asker.id) && group.memberIds.includes(peer.id),
      )?.id;
    } finally {
      stream.close();
      await api("POST", `/api/bots/${peer.id}/interrupt`, {}).catch(() => undefined);
      await asking.catch(() => undefined);
      await cleanup([channelId], [asker.id, peer.id]);
    }
  }, 45_000);
});
