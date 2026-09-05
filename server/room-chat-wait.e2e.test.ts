import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

// An ordinary room round never skips a member who is busy in another
// conversation: the round parks on them with one neutral note and they take
// their turn when they free — whether they were a direct responder, a
// teammate summoned by a chained @mention, or the peer in a bot⇄bot channel
// the user chipped into. The member's own 1:1 turn is never touched by the
// wait. The bounded end of the wait (the cap) lives in the short-cap server
// of group-goal-wait-cap.e2e.test.ts.

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const TEST_CAPABILITY_KEY = "room-chat-wait-fixture-capability";

const WAIT_CHIP = (name: string) => `${name} is finishing another conversation — will reply here when free`;

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let penDump = "";

type StateMessage = {
  id: string;
  kind: string;
  role?: string;
  text?: string;
  from?: { botId?: string; name?: string };
  tool?: { name?: string; ok?: boolean; spoken?: string };
};

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
  return { status: response.status, body: await response.json() };
};

const fixture = (displayName: string, environment: Record<string, string>) => ({
  driver: "claudeAgent",
  displayName,
  environment,
  config: { cli: FAKE_CLAUDE },
});

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-room-chat-wait-"));
  const data = join(home, ".openmausbot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Room chat wait test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  penDump = join(home, "pen-dump.json");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      // `slow` leaves a gap before the closing reply, which is how a bot is
      // held busy in a 1:1 long enough for a room round to park on it; the
      // closing reply echoes the prompt, so a room reply carries the room's
      // own @mentions back out
      patient: fixture("Patient fixture", { FAKE_CLAUDE_MODE: "slow" }),
      quick: fixture("Quick fixture", { FAKE_CLAUDE_MODE: "happy" }),
      summoner: fixture("Summoning fixture", {
        FAKE_CLAUDE_MODE: "happy",
        FAKE_CLAUDE_REPLIES: JSON.stringify(["Let me pull in @Bee for this."]),
        FAKE_CLAUDE_REPLY_STATE: join(home, "summoner-replies.txt"),
      }),
      // The dump proves the real per-turn token is mounted. An exact synthetic
      // capability below drives ask_bot after this quick fake turn settles.
      pen: fixture("Dumping fixture", { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: penDump }),
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
      OMB_STATIC_DIR: staticDir,
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
      // Still starting.
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const createBot = async (name: string, instanceId: string) =>
  (await api("POST", "/api/bots", {
    name,
    modelSelection: { instanceId, model: "claude-sonnet-5" },
    requireAvailableModel: true,
  })).body.bot;

const snapshot = async (groupId: string) => {
  const state = (await api("GET", "/api/bots?messages=40")).body;
  const room = state.groups.find((group: { id: string }) => group.id === groupId);
  const messages: StateMessage[] = room?.messages ?? [];
  return { state, room, messages };
};

const botBusy = async (botId: string) => {
  const state = (await api("GET", "/api/bots?messages=0")).body;
  return state.bots.find((bot: { id: string }) => bot.id === botId)?.busy;
};

const holdBusy = async (botId: string, text: string) => {
  expect((await api("POST", `/api/bots/${botId}/messages`, { text })).status).toBe(202);
  await expect.poll(() => botBusy(botId)).toBe(true);
};

const roundSummary = (messages: StateMessage[], waitedBotId: string) => {
  const waitChip = messages.find((message) =>
    message.kind === "activity" && message.from?.botId === waitedBotId && /another conversation/i.test(message.tool?.name ?? "")
  );
  return {
    waitChip: waitChip?.tool?.name,
    waitChipOk: waitChip?.tool?.ok,
    waitChips: messages.filter((message) =>
      message.kind === "activity" && message.from?.botId === waitedBotId && /another conversation/i.test(message.tool?.name ?? "")
    ).length,
    skipped: messages.some((message) => /skipped this round/i.test(message.tool?.name ?? "")),
    // who spoke, in order; the slow fixture splits one turn into two text
    // items, so consecutive repeats collapse to the speaker
    speakers: messages
      .filter((message) => message.kind === "text" && message.role === "bot")
      .map((message) => message.from?.name)
      .filter((name, index, names) => index === 0 || name !== names[index - 1]),
  };
};

const directReply = async (botId: string, needle: string) => {
  const state = (await api("GET", "/api/bots?messages=20")).body;
  const messages: StateMessage[] = state.bots.find((bot: { id: string }) => bot.id === botId)?.messages ?? [];
  return messages.some((message) => message.kind === "text" && message.role === "bot" && (message.text ?? "").includes(needle));
};

const cleanup = async (roomId: string | undefined, botIds: string[]) => {
  if (roomId) await api("POST", `/api/groups/${roomId}/interrupt`, {}).catch(() => undefined);
  for (const botId of botIds) await api("POST", `/api/bots/${botId}/interrupt`, {}).catch(() => undefined);
  if (roomId) await api("DELETE", `/api/groups/${roomId}`).catch(() => undefined);
  for (const botId of botIds) await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
};

/** These cases are deliberately slow: each one holds a real turn open on one
 * bot and waits for a second bot to take its turn only once the first settles,
 * through a real server and the fake CLI. The inner polls already allow 15s,
 * which leaves nothing inside vitest's 20s default for process start-up — so on
 * the slowest runner they time out for lack of headroom rather than because
 * anything regressed. The wait itself is what is under test; the clock is not.
 */
describe("chat rooms wait for a member busy elsewhere", { timeout: 45_000 }, () => {
  it("parks on a responder busy in a 1:1, then lets them reply once that turn settles, in order", async () => {
    const busy = await createBot("Busy", "patient");
    const quick = await createBot("Quick", "quick");
    const room = (await api("POST", "/api/groups", {
      name: "Wait chat",
      memberIds: [busy.id, quick.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    })).body.group;

    try {
      await holdBusy(busy.id, "Finish this first");
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Hello team" })).status).toBe(202);

      await expect.poll(async () => {
        const { room: current, messages } = await snapshot(room.id);
        return { working: current?.working, ...roundSummary(messages, busy.id) };
      }, { timeout: 15_000 }).toEqual({
        working: false,
        waitChip: WAIT_CHIP("Busy"),
        // settled, not failed: the promise was kept
        waitChipOk: true,
        waitChips: 1,
        skipped: false,
        // the round kept its order — the waited-on member still went first
        speakers: ["Busy", "Quick"],
      });

      // the 1:1 turn the room waited on was left alone to finish on its own
      expect(await directReply(busy.id, "Finish this first")).toBe(true);
      expect(await botBusy(busy.id)).toBe(false);
    } finally {
      await cleanup(room?.id, [busy.id, quick.id]);
    }
  });

  it("waits for a teammate summoned by a chained @mention who is busy elsewhere", async () => {
    const ace = await createBot("Ace", "summoner");
    const bee = await createBot("Bee", "patient");
    const room = (await api("POST", "/api/groups", {
      name: "Chained chat",
      memberIds: [ace.id, bee.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: ace.id } },
    })).body.group;

    try {
      await holdBusy(bee.id, "Bee, finish this first");
      // only Ace is addressed; Bee arrives through Ace's reply
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@Ace please bring Bee in" })).status).toBe(202);

      await expect.poll(async () => {
        const { room: current, messages } = await snapshot(room.id);
        return { working: current?.working, ...roundSummary(messages, bee.id) };
      }, { timeout: 15_000 }).toEqual({
        working: false,
        waitChip: WAIT_CHIP("Bee"),
        waitChipOk: true,
        waitChips: 1,
        skipped: false,
        speakers: ["Ace", "Bee"],
      });

      expect(await directReply(bee.id, "Bee, finish this first")).toBe(true);
    } finally {
      await cleanup(room?.id, [ace.id, bee.id]);
    }
  });

  it("waits for the peer of a bot⇄bot channel when the user chips in while that peer is busy", async () => {
    const pen = await createBot("Pen", "pen");
    const ink = await createBot("Ink", "patient");
    let channelId: string | undefined;

    try {
      // one direct turn hands the fake CLI its MCP config, which carries the
      // comms token every internal endpoint is sealed behind
      expect((await api("POST", `/api/bots/${pen.id}/messages`, { text: "Warm up" })).status).toBe(202);
      const readToken = (): string | undefined => {
        try {
          const dump = JSON.parse(readFileSync(penDump, "utf8"));
          const value: unknown = dump?.mcpConfig?.mcpServers?.agents?.env?.OMB_COMMS_TOKEN;
          return typeof value === "string" && value ? value : undefined;
        } catch {
          // not written yet, or mid-write
          return undefined;
        }
      };
      await expect.poll(readToken, { timeout: 10_000 }).toBeTruthy();
      expect(readToken()).toMatch(/^[a-f0-9]{48}$/);
      await expect.poll(() => botBusy(pen.id)).toBe(false);
      const minted = await api(
        "POST",
        "/api/testing/internal-capability",
        { botId: pen.id, threadId: pen.threadId, kind: "agents" },
        { "x-openmausbot-test-capability": TEST_CAPABILITY_KEY },
      );
      expect(minted.status).toBe(201);
      const token = String(minted.body.token);

      // ask_bot is what births the channel; the peer answers at once here
      const asked = await api(
        "POST",
        "/api/internal/ask-bot",
        { fromBotId: pen.id, toBotId: ink.id, message: "Ink, quick question" },
        { authorization: `Bearer ${token}` },
      );
      expect(asked.status).toBe(200);
      expect(asked.body.botName).toBe("Ink");
      const channel = (await api("GET", "/api/bots?messages=0")).body.groups.find((group: {
        dm?: boolean;
        memberIds: string[];
      }) => group.dm === true && group.memberIds.includes(pen.id) && group.memberIds.includes(ink.id));
      expect(channel).toBeTruthy();
      channelId = channel.id;
      await expect.poll(() => botBusy(ink.id)).toBe(false);
      await holdBusy(ink.id, "Ink, finish this first");
      expect((await api("POST", `/api/groups/${channel.id}/messages`, { text: "@Ink one more thing" })).status).toBe(202);

      await expect.poll(async () => {
        const { room: current, messages } = await snapshot(channel.id);
        const { speakers: _speakers, ...summary } = roundSummary(messages, ink.id);
        // Ink's earlier answer to Pen is already in the channel; the chip-in
        // must have produced a fresh Ink reply AFTER the wait note
        const waitAt = messages.findIndex((message) => message.tool?.name === WAIT_CHIP("Ink"));
        const inkRepliedAfterWait = waitAt !== -1 && messages.slice(waitAt + 1).some((message) =>
          message.kind === "text" && message.role === "bot" && message.from?.botId === ink.id
        );
        return { working: current?.working, ...summary, inkRepliedAfterWait };
      }, { timeout: 15_000 }).toEqual({
        working: false,
        waitChip: WAIT_CHIP("Ink"),
        waitChipOk: true,
        waitChips: 1,
        skipped: false,
        inkRepliedAfterWait: true,
      });

      expect(await directReply(ink.id, "Ink, finish this first")).toBe(true);
    } finally {
      await cleanup(channelId, [pen.id, ink.id]);
    }
  });
});
