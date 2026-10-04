// Codex's request_user_input_async, end to end: boots the real harness with
// the fake app-server in `async-question` mode (the model posts questions on
// an agent message and keeps working), and answers the card the way every
// client does, through /respond. The answer must reach the bot exactly like a
// typed reply: steered into the running turn, a new turn once it ended (also
// after a restart), queued in a working room. Closing the card sends nothing.
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUESTION_DISMISS_MESSAGE } from "../shared/ask-question.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

const QUESTION = "Which source should I use?";
const PICK = "Directly in OpenMausBot";
const OTHER_PICK = "The official server in Executor";
/** What the desktop and phone cards send for one picked option. */
const CARD_ANSWER = `The user answered your questions.\n\nQ: ${QUESTION}\nA: ${PICK}`;

posixOnly("Codex async question cards e2e", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let gate: string;

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const messages = async (threadId: string): Promise<any[]> =>
    (await api("GET", `/api/threads/${threadId}/messages`)).body.messages;
  const getBot = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === id);
  const asyncCards = async (threadId: string) => (await messages(threadId)).filter((m: any) => m.card?.asyncQuestion);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const holdTurns = () => rmSync(gate, { force: true });
  const releaseTurns = () => writeFileSync(gate, "finish");

  const start = async () => {
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
  };
  const codexBot = async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const model = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "codex").models.default;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "codex", model } });
    return created as { id: string; threadId: string; name: string };
  };

  beforeAll(async () => {
    chmodSync(FAKE_CODEX, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-codex-async-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    gate = join(home, "finish-async-turn.gate");
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          codex: {
            driver: "codex",
            environment: { FAKE_CODEX_MODE: "async-question", FAKE_CODEX_ASYNC_QUESTION_GATE: gate },
            config: { cli: FAKE_CODEX },
          },
        },
      }),
    );
    await start();
  }, 30_000);

  afterAll(async () => {
    releaseTurns();
    await stop();
    rmSync(home, { recursive: true, force: true });
  });

  it("shows one card beside the text and steers its answer into the running turn", async () => {
    holdTurns();
    const bot = await codexBot();
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "connect the tracker" })).status).toBe(202);
    await waitFor(async () => (await asyncCards(bot.threadId)).length > 0, "the async question card");

    const transcript = await messages(bot.threadId);
    const cards = transcript.filter((m: any) => m.card?.asyncQuestion);
    // item/started and item/completed both carry the questions: one card
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card).toMatchObject({
      role: "bot",
      kind: "options",
      card: {
        title: "Your bot has a question",
        subtitle: QUESTION,
        options: [PICK, OTHER_PICK],
        requestType: "question",
        requestId: expect.any(String),
        questionRequest: { version: 1, questions: [{ question: QUESTION, options: [{ label: PICK }, { label: OTHER_PICK }] }] },
      },
    });
    // the model's own text stays in the transcript, right before the card
    const textIndex = transcript.findIndex((m: any) => m.role === "bot" && m.kind === "text" && m.text?.startsWith(QUESTION));
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(transcript.findIndex((m: any) => m.id === card.id)).toBeGreaterThan(textIndex);
    expect((await getBot(bot.id)).busy).toBe(true);

    const answered = await api("POST", `/api/threads/${bot.threadId}/respond`, {
      requestId: card.card.requestId,
      behavior: "answer",
      message: CARD_ANSWER,
    });
    expect(answered).toMatchObject({ status: 200, body: { ok: true, outcome: "answered", steered: true } });

    const after = await messages(bot.threadId);
    const reply = after.filter((m: any) => m.role === "user" && m.text === PICK);
    expect(reply).toHaveLength(1);
    expect(reply[0]).toMatchObject({ kind: "text", steered: true, replyToId: card.id });
    expect(after.find((m: any) => m.id === card.id).card).toMatchObject({ answered: "answer", answeredText: PICK, dismissed: false });
    // the words reached the app-server as mid-turn input for the same turn
    const nativeRows = readFileSync(join(home, ".openmausbot", "native", `${bot.threadId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const steers = nativeRows.filter((row) => row.dir === "out" && row.msg?.method === "turn/steer");
    expect(steers).toHaveLength(1);
    expect(steers[0].msg.params).toMatchObject({ input: [{ type: "text", text: PICK }], expectedTurnId: "turn-1" });

    // a retry of the same answer resolves to the recorded message; another answer is refused
    const retried = await api("POST", `/api/threads/${bot.threadId}/respond`, {
      requestId: card.card.requestId, behavior: "answer", message: CARD_ANSWER,
    });
    expect(retried).toMatchObject({ status: 200, body: { ok: true, outcome: "answered" } });
    const changed = await api("POST", `/api/threads/${bot.threadId}/respond`, {
      requestId: card.card.requestId, behavior: "answer", message: OTHER_PICK,
    });
    expect(changed.status).toBe(409);
    expect((await messages(bot.threadId)).filter((m: any) => m.role === "user" && m.replyToId === card.id)).toHaveLength(1);

    releaseTurns();
    await waitFor(async () => (await getBot(bot.id)).busy === false, "the steered turn to settle");
  }, 40_000);

  it("starts a normal turn when the card is answered after its turn ended, also after a restart", async () => {
    releaseTurns();
    const bot = await codexBot();
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "connect the tracker" })).status).toBe(202);
    await waitFor(async () => (await asyncCards(bot.threadId)).length > 0, "the async question card");
    await waitFor(async () => (await getBot(bot.id)).busy === false, "the asking turn to settle");

    // the card lives in the message store, not in the ended turn
    await stop();
    await start();
    const [card] = await asyncCards(bot.threadId);
    expect(card.card.answered).toBeUndefined();
    const repliesBefore = (await messages(bot.threadId))
      .filter((m: any) => m.role === "bot" && m.kind === "text" && m.text === "done from fake codex").length;

    holdTurns();
    // a phone answers a single-question card with the bare option label
    const answered = await api("POST", `/api/bots/${bot.id}/respond`, {
      requestId: card.card.requestId,
      behavior: "answer",
      message: OTHER_PICK,
    });
    expect(answered).toMatchObject({ status: 200, body: { ok: true, outcome: "answered" } });
    expect(answered.body.steered).toBeUndefined();
    expect(answered.body.queued).toBeUndefined();
    await waitFor(async () => (await getBot(bot.id)).busy === true, "the answer's own turn to start");

    const reply = (await messages(bot.threadId)).find((m: any) => m.role === "user" && m.text === OTHER_PICK);
    expect(reply).toMatchObject({ kind: "text", replyToId: card.id });
    expect(reply.steered).toBeUndefined();
    expect((await messages(bot.threadId)).find((m: any) => m.id === card.id).card)
      .toMatchObject({ answered: "answer", answeredText: OTHER_PICK, dismissed: false });

    releaseTurns();
    await waitFor(async () => (await getBot(bot.id)).busy === false, "the answer's turn to settle");
    const after = await messages(bot.threadId);
    expect(after).toContainEqual(expect.objectContaining({
      role: "bot", kind: "text", text: "done from fake codex", requestMessageId: reply.id,
    }));
    expect(after.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text === "done from fake codex").length)
      .toBe(repliesBefore + 1);
  }, 60_000);

  it("closes the card without sending anything, and refuses its requestId from another thread", async () => {
    releaseTurns();
    const bot = await codexBot();
    const other = await codexBot();
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "connect the tracker" })).status).toBe(202);
    await waitFor(async () => (await asyncCards(bot.threadId)).length > 0, "the async question card");
    await waitFor(async () => (await getBot(bot.id)).busy === false, "the asking turn to settle");
    const [card] = await asyncCards(bot.threadId);
    const userLines = async (threadId: string) => (await messages(threadId)).filter((m: any) => m.role === "user").length;
    const ownBefore = await userLines(bot.threadId);
    const otherBefore = await userLines(other.threadId);

    // the requestId belongs to another conversation: nothing is delivered
    const foreign = await api("POST", `/api/threads/${other.threadId}/respond`, {
      requestId: card.card.requestId, behavior: "answer", message: PICK,
    });
    expect(foreign.body).not.toMatchObject({ outcome: "answered" });
    expect(await userLines(other.threadId)).toBe(otherBefore);
    expect(await userLines(bot.threadId)).toBe(ownBefore);
    expect((await asyncCards(bot.threadId))[0].card.answered).toBeUndefined();
    expect((await getBot(other.id)).busy).toBeFalsy();

    // the close an unanswered question card sends from every client
    const closed = await api("POST", `/api/threads/${bot.threadId}/respond`, {
      requestId: card.card.requestId, behavior: "answer", message: QUESTION_DISMISS_MESSAGE, dismiss: true,
    });
    expect(closed).toMatchObject({ status: 200, body: { ok: true, dismissed: true } });
    expect((await asyncCards(bot.threadId))[0].card).toMatchObject({ dismissed: true, answered: "deny" });
    expect(await userLines(bot.threadId)).toBe(ownBefore);
    expect((await getBot(bot.id)).busy).toBe(false);
    expect(JSON.stringify(await messages(bot.threadId))).not.toContain(QUESTION_DISMISS_MESSAGE);

    const late = await api("POST", `/api/threads/${bot.threadId}/respond`, {
      requestId: card.card.requestId, behavior: "answer", message: PICK,
    });
    expect(late.status).toBe(409);
    expect(await userLines(bot.threadId)).toBe(ownBefore);
  }, 40_000);

  it("queues a room answer behind the working room, addressed to the bot that asked", async () => {
    holdTurns();
    const bot = await codexBot();
    const room = (await api("POST", "/api/groups", {
      name: "Async question room",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;
    const getGroup = async () => (await api("GET", "/api/bots?messages=0")).body.groups.find((g: any) => g.id === room.id);

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "connect the tracker" })).status).toBe(202);
    await waitFor(async () => (await asyncCards(room.threadId)).length > 0, "the room's async question card");
    const [card] = await asyncCards(room.threadId);
    expect(card.from?.botId).toBe(bot.id);
    expect((await getGroup())?.working).toBe(true);

    const answered = await api("POST", `/api/threads/${room.threadId}/respond`, {
      requestId: card.card.requestId, behavior: "answer", message: CARD_ANSWER,
    });
    expect(answered).toMatchObject({ status: 200, body: { ok: true, outcome: "answered", queued: true } });
    expect((await messages(room.threadId)).find((m: any) => m.id === card.id).card)
      .toMatchObject({ answered: "answer", answeredText: PICK });

    releaseTurns();
    await waitFor(
      async () => (await messages(room.threadId)).some((m: any) => m.role === "user" && m.text === `@${bot.name}: ${PICK}`),
      "the queued room answer to drain",
    );
    expect((await messages(room.threadId)).find((m: any) => m.role === "user" && m.text === `@${bot.name}: ${PICK}`))
      .toMatchObject({ replyToId: card.id });
    await waitFor(async () => (await getGroup())?.working === false, "the room to settle");
  }, 60_000);
});
