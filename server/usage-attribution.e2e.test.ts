// Who a turn is booked to, end to end: boots the real harness against the
// fake engines in a disposable home, sends as this machine (loopback) and as
// a paired person, and reads the usage ledger file back. A turn belongs to
// the sender of the message that started it: a second person's queued or
// steered words, or pressing Steer, never re-book it; a queued message's own
// turn is booked to its sender; a guarded relay (the Slack worker) names the
// person it acts for.
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("usage attribution e2e", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let finishGate: string;
  let codexSteerGate: string;

  type Reply = { status: number; body: any };
  const request = async (headers: Record<string, string>, method: string, path: string, body?: unknown): Promise<Reply> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const api = (method: string, path: string, body?: unknown) => request({}, method, path, body);
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const PERSON = "Safari on Mac";
  const asPerson = async (scopes?: string[]) => {
    const opened = await api("POST", "/api/auth/pairing", scopes ? { scopes } : {});
    expect(opened.status).toBe(200);
    const paired = await fetch(`${BASE}/api/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1" },
      body: JSON.stringify({ code: opened.body.code }),
    });
    const session = (await paired.json()) as any;
    expect(session.session.label).toBe(PERSON);
    return (method: string, path: string, body?: unknown) => request({ authorization: `Bearer ${session.token}` }, method, path, body);
  };
  const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  /** The ledger rows for one bot (or one room's speakers), oldest first. */
  const ledger = (botId: string) => {
    const file = join(home, ".openmausbot", "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.botId === botId);
  };
  const newBot = async (instanceId: string, model: string) => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId, model } });
    return created as { id: string; threadId: string };
  };
  const owner = { kind: "owner" };
  const person = { kind: "user", label: PERSON };

  beforeAll(async () => {
    for (const fake of [FAKE_CLAUDE, FAKE_ACP, FAKE_CODEX]) chmodSync(fake, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-attribution-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    finishGate = join(home, "finish-steered-turn.gate");
    codexSteerGate = join(home, "codex-steer-refused.gate");
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          claude: { driver: "claudeAgent", config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" } },
          claudeSlow: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          // no live session: a message while busy waits in the server-side queue
          acp: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "hang" }, config: { cli: FAKE_ACP, fullAuto: true } },
          // reports tokens (10 in, 5 out) but no price, like every engine but Claude
          acpHappy: { driver: "grokAgent", config: { cli: FAKE_ACP, fullAuto: true } },
          codexRace: {
            driver: "codex",
            environment: { FAKE_CODEX_MODE: "question", FAKE_CODEX_ASK_HOLD: "1", FAKE_CODEX_STEER_ERROR_FILE: codexSteerGate },
            config: { cli: FAKE_CODEX },
          },
        },
      }),
    );
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
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("books an engine that reports tokens but no price at an estimate, and an unlisted model as unpriced", async () => {
    const listed = await newBot("acpHappy", "grok-4.7");
    expect((await api("POST", `/api/bots/${listed.id}/messages`, { text: "priced from the list" })).status).toBe(202);
    await waitFor(() => ledger(listed.id).length === 1, "the listed model's turn to be booked");
    const row = ledger(listed.id)[0];
    expect(row).toMatchObject({ driverKind: "grokAgent", model: "grok-4.7", input: 10, output: 5, costSource: "estimated" });
    // xAI's list price for grok-4.7: $2 in, $6 out per million tokens
    expect(row.costUsd).toBeCloseTo((10 * 2 + 5 * 6) / 1_000_000, 12);

    const unlisted = await newBot("acpHappy", "fake-model");
    expect((await api("POST", `/api/bots/${unlisted.id}/messages`, { text: "no known price" })).status).toBe(202);
    await waitFor(() => ledger(unlisted.id).length === 1, "the unlisted model's turn to be booked");
    expect(ledger(unlisted.id)[0].costUsd).toBeNull();
    expect(ledger(unlisted.id)[0]).not.toHaveProperty("costSource");

    const usage = (await api("GET", "/api/usage?groupBy=bot")).body;
    const byBot = (id: string) => usage.groups.find((g: any) => g.key === `bot:${id}`);
    expect(byBot(listed.id)).toMatchObject({ unpriced: 0 });
    expect(byBot(listed.id).estimatedUsd).toBeCloseTo(row.costUsd, 12);
    expect(byBot(unlisted.id)).toMatchObject({ costUsd: null, estimatedUsd: null, unpriced: 1 });
    await waitFor(async () => (await getBot(unlisted.id)).busy === false, "the bots to go idle");
  }, 40_000);

  it("a queued message leaves the running turn with its starter, and its own turn is booked to its sender", async () => {
    const bot = await newBot("acp", "fake-model");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "owner's work" })).status).toBe(202);
    await waitFor(async () => (await getBot(bot.id)).busy === true, "the owner's turn to start");
    const asPaired = await asPerson();
    const queued = await asPaired("POST", `/api/bots/${bot.id}/messages`, { text: "person's follow-up" });
    expect(queued.body.queued).toBe(true);

    await api("POST", `/api/bots/${bot.id}/interrupt`);
    await waitFor(() => ledger(bot.id).length === 1, "the owner's turn to be booked");
    expect(ledger(bot.id)[0].trigger).toEqual(owner);

    await waitFor(async () => (await getBot(bot.id)).messages.some((m: any) => m.text === "person's follow-up"), "the queued turn to start");
    await api("POST", `/api/bots/${bot.id}/interrupt`);
    await waitFor(() => ledger(bot.id).length === 2, "the queued turn to be booked");
    expect(ledger(bot.id)[1].trigger).toEqual(person);
    await waitFor(async () => (await getBot(bot.id)).busy === false, "the bot to go idle");
  }, 40_000);

  it("words steered into a running turn do not re-book it", async () => {
    rmSync(finishGate, { force: true });
    const bot = await newBot("claudeSlow", "claude-fake");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getBot(bot.id)).messages.some((m: any) => m.kind === "activity"), "the tool chip");
    const asPaired = await asPerson();
    let steered: Reply;
    try {
      steered = await asPaired("POST", `/api/bots/${bot.id}/messages`, { text: "and also this" });
    } finally {
      writeFileSync(finishGate, "finish");
    }
    expect(steered.body.steered).toBe(true);
    await waitFor(() => ledger(bot.id).length === 1, "the steered turn to be booked");
    expect(ledger(bot.id)[0]).toMatchObject({ trigger: owner, costUsd: 0.01, costSource: "reported" });
  }, 40_000);

  it("pressing Steer on a queued message does not re-book the running turn", async () => {
    writeFileSync(codexSteerGate, "refuse live steers until the test clears this gate");
    const model = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "codexRace").models.default;
    const bot = await newBot("codexRace", model);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "owner's codex turn" })).status).toBe(202);
    await waitFor(async () => (await getBot(bot.id)).messages.some((m: any) => m.card), "the question card");
    const asPaired = await asPerson();
    const queued = await asPaired("POST", `/api/bots/${bot.id}/messages`, { text: "steer these words" });
    expect(queued.body.queued).toBe(true);
    rmSync(codexSteerGate, { force: true });
    const steered = await asPaired("POST", `/api/bots/${bot.id}/queue/${queued.body.queueId}/steer`, { threadId: bot.threadId });
    expect(steered.body.steered).toBe(true);

    await api("POST", `/api/bots/${bot.id}/interrupt`);
    await waitFor(() => ledger(bot.id).length === 1, "the steered codex turn to be booked");
    expect(ledger(bot.id)[0].trigger).toEqual(owner);
  }, 40_000);

  it("a room's queued message leaves the running room turn with its starter", async () => {
    const bot = await newBot("acp", "fake-model");
    const room = (await api("POST", "/api/groups", {
      name: "Attribution room",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;
    const working = async () => (await api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === room.id);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "owner's room turn" })).status).toBe(202);
    await waitFor(async () => (await working())?.busyBotId === bot.id, "the room turn to start");
    const asPaired = await asPerson();
    expect((await asPaired("POST", `/api/groups/${room.id}/messages`, { text: "person's room follow-up" })).body.queued).toBe(true);

    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(() => ledger(bot.id).length >= 1, "the owner's room turn to be booked");
    expect(ledger(bot.id)[0].trigger).toEqual(owner);
    await waitFor(async () => (await working())?.messages.some((m: any) => m.text === "person's room follow-up"), "the queued room turn to start");
    await waitFor(async () => (await working())?.busyBotId === bot.id, "the queued room turn to run");
    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(() => ledger(bot.id).length >= 2, "the queued room turn to be booked");
    expect(ledger(bot.id)[1].trigger).toEqual(person);
  }, 40_000);

  it("a guarded relay books the turn to the person it names; without one it is this machine's", async () => {
    const health = await api("GET", "/api/health");
    expect(health.body.capabilities.guardedOnBehalfOf).toBe(1);
    const bot = await newBot("claude", "claude-fake");
    const send = async (sendId: string, extra: Record<string, unknown> = {}) => {
      const page = await api("GET", `/api/threads/${bot.threadId}/messages?limit=0`);
      return api("POST", `/api/bots/${bot.id}/messages/guarded`, {
        threadId: bot.threadId, sendId, text: `guarded ${sendId}`, expectedActiveLeafId: page.body.activeLeafId, ...extra,
      });
    };
    const refused = await send("guarded-send-invalid-0001", { onBehalfOf: {} });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("onBehalfOf must name the person with an email address, a name, or both");

    expect((await send("guarded-send-relayed-0001", { onBehalfOf: { email: " Ada@Example.test ", name: "Ada Lovelace" } })).status).toBe(202);
    await waitFor(() => ledger(bot.id).length === 1, "the relayed turn to be booked");
    expect(ledger(bot.id)[0].trigger).toEqual({ kind: "user", email: "ada@example.test", label: "Ada Lovelace" });
    await waitFor(async () => (await getBot(bot.id)).busy === false, "the relayed turn to settle");

    expect((await send("guarded-send-owner-00001")).status).toBe(202);
    await waitFor(() => ledger(bot.id).length === 2, "the plain guarded turn to be booked");
    expect(ledger(bot.id)[1].trigger).toEqual(owner);
    await waitFor(async () => (await getBot(bot.id)).busy === false, "the plain guarded turn to settle");

    // The route stays admin-only: a member's session cannot name someone else.
    const member = await asPerson(["client"]);
    const page = await api("GET", `/api/threads/${bot.threadId}/messages?limit=0`);
    const memberTry = await member("POST", `/api/bots/${bot.id}/messages/guarded`, {
      threadId: bot.threadId, sendId: "guarded-send-member-0001", text: "as someone else", expectedActiveLeafId: page.body.activeLeafId,
      onBehalfOf: { email: "boss@example.test" },
    });
    expect(memberTry.status).toBe(403);
    expect(ledger(bot.id)).toHaveLength(2);
  }, 40_000);
});
