// The aside lane, end to end. A context_only peer ask that lands while its
// target is mid-turn on a seam-capable engine folds into the RUNNING turn:
// the envelope physically enters the live session through Adapter.steer,
// the transcript records it as peer context (never steering, never a
// delegation), the asker gets an honest receipt, and the turn settles with
// the aside folded into its reply — once, not replayed at the settle
// boundary. The lane is opt-in: the same busy ask WITHOUT context_only
// keeps the reply-preserving delegation fallback (pinned here against a
// seam-capable target; the no-seam leg stays pinned in comms.test.ts).
//
// Lifecycle coverage: Stop withdraws a queued aside instead of degrading
// it into a new turn; a sender deleted before delivery retires at the
// drain boundary; a crash-restart revalidates restored rows the same way
// (a deleted sender's row retires cancelled, never replays as a turn).
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

const ENVELOPE_OPEN = "[aside from @Asker — peer context, not steering; continue your current plan unless this directly changes a fact you are using]";
const ASIDE_TEXT = "ping from fake";
// Bigger than the machine's pipe buffer, so the parked ask's steer write
// cannot acknowledge until the test opens the fake's steer gate (the same
// trick steer-e2e uses, including its 900KB sizing: this macOS grows pipe
// buffers dynamically, so a 128KB write flushed straight through and the
// "parked" aside folded instantly instead of holding the lane).
const PARK_PAD_BYTES = 900_000;

posixOnly("peer aside lane e2e", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let finishGate: string;
  let parkSteerGate: string;
  let parkFinishGate: string;
  let parkTextFile: string;

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const threadLines = async (threadId: string) =>
    (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
  const waitUntil = async (predicate: () => Promise<boolean>, timeout: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error(`${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  // The durable lane itself, read straight from the followups table the
  // way chat-followups-restart does: statuses are the proof of withdrawal.
  const journal = () => {
    const db = new DatabaseSync(join(home, ".openmausbot", "messages.db"), { readOnly: true });
    try {
      return db.prepare("SELECT id, thread_id, status FROM chat_followups WHERE kind = 'aside' ORDER BY rowid").all() as Array<{
        id: string; thread_id: string; status: string;
      }>;
    } finally {
      db.close();
    }
  };
  // Enter through a routine the way the legacy comms e2es do: the asker's
  // turn reaches the peer through the injected agents proxy (list_bots →
  // ask_bot), which is the chain the packaged app uses.
  const startRoutine = async (botId: string, text: string) => {
    const created = await api("POST", "/api/routines", {
      name: "Aside lane fixture",
      prompt: text,
      botId,
      enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    let run: any;
    await waitUntil(async () => {
      run = (await api("GET", "/api/routines")).body.runs.find((candidate: any) => candidate.id === started.body.run.id);
      return Boolean(run?.threadId);
    }, 15_000, "routine execution thread was not created");
    expect((await api("POST", `/api/bots/${botId}/tasks/${run.threadId}`)).status).toBe(200);
    return started;
  };
  const makeBot = async (name: string, instanceId: string) => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: { instanceId, model: "fake-model" } });
    return bot;
  };
  // Determinism: the ask-peer fakes ask the teammate the test names — the
  // roster is newest-first, so "first visible" stops meaning Helper once a
  // third bot exists.
  const hideOtherBots = async () => {
    for (const existing of (await api("GET", "/api/bots")).body.bots) {
      await api("PATCH", `/api/bots/${existing.id}`, { hidden: true });
    }
  };
  const busyTurn = async (botId: string, text: string) => {
    expect((await api("POST", `/api/bots/${botId}/messages`, { text })).status).toBe(202);
    await waitUntil(async () => (await getBot(botId))?.busy === true, 15_000, "helper turn never started");
    await waitUntil(
      async () => (await getBot(botId))?.messages.some((m: any) => m.kind === "activity"),
      15_000,
      "helper tool chip never landed",
    );
  };

  const startServer = () => {
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
  };
  const waitUntilUp = async () => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  // Park one oversized ask behind the fake's steer gate (its steer write
  // cannot acknowledge), then send a second small ask: the first holds the
  // lane in flight, so the second parks QUEUED with a durable pending row —
  // the exact state Stop, sender deletion and a crash all have to answer
  // for. Returns once the second asker holds its "queued" receipt.
  const parkQueuedAside = async (helper: any, parker: any, queuer: any) => {
    rmSync(parkSteerGate, { force: true });
    rmSync(parkFinishGate, { force: true });
    await busyTurn(helper.id, "first");
    await startRoutine(parker.id, "hey @Helper park");
    await waitUntil(
      async () => journal().some((row) => row.thread_id === helper.threadId && row.status === "dispatching"),
      15_000,
      "parked aside never went in flight",
    );
    await startRoutine(queuer.id, "hey @Helper queued");
    await waitUntil(async () => {
      const current = await getBot(queuer.id);
      const reply = current.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      return Boolean(reply?.text?.includes("aside is queued") && !current.busy);
    }, 25_000, "second asker never got its queued-aside receipt");
    // The parked words are provably not delivered yet, and the queued
    // words hold a pending durable row.
    const lines = await threadLines(helper.threadId);
    expect(lines.some((m) => m.aside === true)).toBe(false);
    expect(journal().some((row) => row.thread_id === helper.threadId && row.status === "pending")).toBe(true);
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-aside-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    finishGate = join(home, "finish-aside-turn.gate");
    parkSteerGate = join(home, "park-steer.gate");
    parkFinishGate = join(home, "park-finish.gate");
    parkTextFile = join(home, "park-text.txt");
    writeFileSync(parkTextFile, `PARKPAD ${"x".repeat(PARK_PAD_BYTES)}`);
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          // the busy target with a mid-turn seam and no gates: tests 1-2
          claudeSteer: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          // the busy target that parks an oversized steer behind a gate
          claudePark: {
            driver: "claudeAgent",
            environment: {
              FAKE_CLAUDE_MODE: "slow",
              FAKE_CLAUDE_SLOW_FINISH_GATE: parkFinishGate,
              FAKE_CLAUDE_STEER_GATE: parkSteerGate,
            },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          // askers: context_only (aside lane), context_only with the
          // oversized parked text, and the default (no context_only)
          grokAside: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "ask-peer", FAKE_ACP_ASK_CONTEXT_ONLY: "1", FAKE_ACP_ASK_TARGET_NAME: "Helper" },
            config: { cli: FAKE_ACP, fullAuto: true },
          },
          grokPark: {
            driver: "grokAgent",
            environment: {
              FAKE_ACP_MODE: "ask-peer",
              FAKE_ACP_ASK_CONTEXT_ONLY: "1",
              FAKE_ACP_ASK_TEXT_FILE: parkTextFile,
              FAKE_ACP_ASK_TARGET_NAME: "Helper",
            },
            config: { cli: FAKE_ACP, fullAuto: true },
          },
          grokPlain: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "ask-peer", FAKE_ACP_ASK_TARGET_NAME: "Helper" },
            config: { cli: FAKE_ACP, fullAuto: true },
          },
        },
      }),
    );
    startServer();
    await waitUntilUp();
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it(
    "folds a context_only peer ask into a busy Claude turn as an aside: honest receipt, enveloped transcript line, no delegation, folded reply, no replay",
    async () => {
      rmSync(finishGate, { force: true });
      await hideOtherBots();
      const helper = await makeBot("Helper", "claudeSteer");
      const asker = await makeBot("Asker", "grokAside");

      // Helper's turn opens and parks in the slow gap after its tool result
      await busyTurn(helper.id, "first");

      // Asker asks while Helper is mid-turn
      expect((await startRoutine(asker.id, "hey @Helper ping")).status).toBe(201);
      let askerBot: any;
      await waitUntil(async () => {
        askerBot = await getBot(asker.id);
        const reply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
        return Boolean(reply?.text?.includes("peer says:") && !askerBot.busy);
      }, 25_000, "asker never got its reply");

      // the receipt says ASIDE, and it is not the delegation fallback
      const askerReply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(askerReply.text).toContain("peer says: Helper is mid-turn");
      expect(askerReply.text).toContain("aside");
      expect(askerReply.text).not.toContain("Task id:");
      expect(askerReply.text).not.toContain("queued as a delegation");
      expect(
        askerBot.messages.some(
          (m: any) => m.kind === "activity" && m.tool?.name === "Delegated to @Helper: asked while busy",
        ),
      ).toBe(false);

      // Helper's transcript already shows the folded context: user-role,
      // enveloped, marked aside (never steered), attributed to the peer
      const midTurn = await getBot(helper.id);
      expect(midTurn.busy).toBe(true); // an aside is not an interruption
      const asideLine = midTurn.messages.find((m: any) => m.aside === true);
      expect(asideLine).toBeTruthy();
      expect(asideLine.role).toBe("user");
      expect(asideLine.kind).toBe("text");
      expect(asideLine.text).toBe(`${ENVELOPE_OPEN}\n${ASIDE_TEXT}\n[end aside]`);
      expect(asideLine.queueId).toBeTruthy();
      expect(asideLine.peerAsk).toEqual({ botId: asker.id, name: "Asker" });
      expect(asideLine.steered).toBeUndefined();

      // release the turn: its reply physically carries the envelope, which
      // is the proof the words entered the live session
      writeFileSync(finishGate, "finish");
      await waitUntil(async () => (await getBot(helper.id))?.busy === false, 20_000, "helper turn never settled");
      const settled = await getBot(helper.id);
      const finalReply = settled.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(finalReply.text).toContain(`reply to: first + steered: ${ENVELOPE_OPEN}`);
      expect(finalReply.text).toContain(ASIDE_TEXT);
      // one injection, no replay: the settle boundary retired the row, it
      // did not fold the same words a second time
      expect(settled.messages.filter((m: any) => m.aside === true)).toHaveLength(1);
      expect(settled.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text?.startsWith("reply to:"))).toHaveLength(1);
    },
    60_000,
  );

  it(
    "keeps a busy ask without context_only on the delegation path, even against a seam-capable target",
    async () => {
      rmSync(finishGate, { force: true });
      await hideOtherBots();
      const helper = await makeBot("Helper", "claudeSteer");
      const asker = await makeBot("Asker", "grokPlain");
      await busyTurn(helper.id, "first");

      expect((await startRoutine(asker.id, "hey @Helper ping")).status).toBe(201);
      let askerBot: any;
      await waitUntil(async () => {
        askerBot = await getBot(asker.id);
        const reply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
        return Boolean(reply?.text?.includes("queued as a delegation") && !askerBot.busy);
      }, 25_000, "asker never got the delegation fallback reply");
      const askerReply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(askerReply.text).toContain("Task id:");
      expect(askerReply.text).not.toContain("aside");
      expect(
        askerBot.messages.some(
          (m: any) => m.kind === "activity" && m.tool?.name === "Delegated to @Helper: asked while busy",
        ),
      ).toBe(true);

      // The seam existed and the target was mid-turn: without the explicit
      // context_only choice nothing may fold in — the asker keeps its
      // reply-preserving claim ticket instead.
      const lines = await threadLines(helper.threadId);
      expect(lines.some((m) => m.aside === true)).toBe(false);
      expect(journal().some((row) => row.thread_id === helper.threadId)).toBe(false);

      // release the helper so later tests start from a quiet fleet
      writeFileSync(finishGate, "finish");
      await waitUntil(async () => (await getBot(helper.id))?.busy === false, 20_000, "helper turn never settled");
    },
    60_000,
  );

  it(
    "Stop withdraws a queued aside instead of degrading it into a new turn",
    async () => {
      await hideOtherBots();
      const helper = await makeBot("Helper", "claudePark");
      const parker = await makeBot("Parker", "grokPark");
      const queuer = await makeBot("Queuer", "grokAside");
      await parkQueuedAside(helper, parker, queuer);

      // Stop the helper's conversation while the seam is still blocked and
      // Queuer's words still wait in the lane: the queued aside must be
      // withdrawn with the conversation, not degraded into a follow-up turn
      // at the settle boundary. (Once the gate opens, the next boundary
      // would legitimately fold Queuer's words into the still-running turn —
      // the lane is allowed to deliver early — so the withdrawal has to be
      // observed against the blocked seam, which is also the state a person
      // pressing Stop mid-exchange actually meets.)
      const stop = await api("POST", `/api/bots/${helper.id}/interrupt`, { threadId: helper.threadId });
      expect([200, 202]).toContain(stop.status);
      await waitUntil(async () => (await getBot(helper.id))?.busy === false, 20_000, "helper never settled after Stop");

      const lines = await threadLines(helper.threadId);
      expect(lines.some((m) => m.aside === true)).toBe(false); // nobody's aside words arrived
      expect(lines.some((m) => m.text?.includes(ASIDE_TEXT))).toBe(false); // Queuer's words never arrived
      const rows = journal().filter((row) => row.thread_id === helper.threadId);
      expect(rows.some((row) => row.status === "cancelled")).toBe(true);
      expect(rows.some((row) => row.status === "pending")).toBe(false);

      // No degrade turn fires after the settle boundary.
      await new Promise((r) => setTimeout(r, 1_500));
      expect((await getBot(helper.id))?.busy).toBe(false);
      expect((await threadLines(helper.threadId)).some((m) => m.aside === true)).toBe(false);
    },
    60_000,
  );

  it(
    "retires a queued aside at the drain boundary when its sender was deleted before delivery",
    async () => {
      await hideOtherBots();
      const helper = await makeBot("Helper", "claudePark");
      const parker = await makeBot("Parker", "grokPark");
      const queuer = await makeBot("Vanishing", "grokAside");
      await parkQueuedAside(helper, parker, queuer);

      // The sender disappears while its words still wait in the lane.
      expect((await api("DELETE", `/api/bots/${queuer.id}`)).status).toBe(200);
      writeFileSync(parkSteerGate, "open");
      await waitUntil(
        async () => (await threadLines(helper.threadId)).some((m) => m.aside === true),
        20_000,
        "parked aside never folded in",
      );
      // The turn settles; the drain must revalidate the queued item and
      // retire it instead of starting a turn for a deleted sender.
      writeFileSync(parkFinishGate, "finish");
      await waitUntil(async () => (await getBot(helper.id))?.busy === false, 20_000, "helper turn never settled");

      const lines = await threadLines(helper.threadId);
      expect(lines.filter((m) => m.aside === true)).toHaveLength(1); // Parker's only
      expect(lines.some((m) => m.text?.includes(ASIDE_TEXT))).toBe(false);
      const rows = journal().filter((row) => row.thread_id === helper.threadId);
      expect(rows.some((row) => row.status === "cancelled")).toBe(true);
      expect(rows.some((row) => row.status === "pending")).toBe(false);
      const finalReply = lines.findLast((m: any) => m.role === "bot" && m.kind === "text");
      expect(finalReply?.text).toContain("reply to: first + steered:");
      // and no follow-up turn started afterwards either
      await new Promise((r) => setTimeout(r, 1_500));
      expect((await getBot(helper.id))?.busy).toBe(false);
      expect((await threadLines(helper.threadId)).filter((m) => m.aside === true)).toHaveLength(1);
    },
    60_000,
  );

  it(
    "retires a queued aside at the drain boundary when its sender was archived before delivery",
    async () => {
      await hideOtherBots();
      const helper = await makeBot("Helper", "claudePark");
      const parker = await makeBot("Parker", "grokPark");
      const queuer = await makeBot("Archiving", "grokAside");
      await parkQueuedAside(helper, parker, queuer);

      // The sender is archived while its words still wait in the lane: an
      // archived bot no longer reaches anyone, so its queued peer context
      // must retire at the next boundary instead of delivering.
      expect((await api("PATCH", `/api/bots/${queuer.id}`, { hidden: true })).status).toBe(200);
      writeFileSync(parkSteerGate, "open");
      await waitUntil(
        async () => (await threadLines(helper.threadId)).some((m) => m.aside === true),
        20_000,
        "parked aside never folded in",
      );
      writeFileSync(parkFinishGate, "finish");
      await waitUntil(async () => (await getBot(helper.id))?.busy === false, 20_000, "helper turn never settled");

      const lines = await threadLines(helper.threadId);
      expect(lines.filter((m) => m.aside === true)).toHaveLength(1); // Parker's only
      expect(lines.some((m) => m.text?.includes(ASIDE_TEXT))).toBe(false);
      const rows = journal().filter((row) => row.thread_id === helper.threadId);
      expect(rows.some((row) => row.status === "cancelled")).toBe(true);
      expect(rows.some((row) => row.status === "pending")).toBe(false);
      // and no follow-up turn started afterwards either
      await new Promise((r) => setTimeout(r, 1_500));
      expect((await getBot(helper.id))?.busy).toBe(false);
      expect((await threadLines(helper.threadId)).filter((m) => m.aside === true)).toHaveLength(1);
    },
    60_000,
  );

  it(
    "revalidates restored asides after a crash: a deleted sender's row retires instead of replaying",
    async () => {
      await hideOtherBots();
      const helper = await makeBot("Helper", "claudePark");
      const parker = await makeBot("Parker", "grokPark");
      const queuer = await makeBot("Ghost", "grokAside");
      await parkQueuedAside(helper, parker, queuer);

      expect((await api("DELETE", `/api/bots/${queuer.id}`)).status).toBe(200);
      // The queued words hold a durable pending row: this is what a crash
      // would otherwise replay on restore. The blocked seam keeps the lane
      // in flight, so no boundary can retire the row before the crash —
      // only the restart's revalidation answers for it.
      expect(journal().some((row) => row.thread_id === helper.threadId && row.status === "pending")).toBe(true);

      await waitForExit(child, { signal: "SIGKILL" });
      // Let the orphaned fake CLI finish and exit now its server is gone.
      writeFileSync(parkFinishGate, "release the orphaned fake");
      stderr = "";
      startServer();
      await waitUntilUp();

      // Restore revalidated the pending row against the world as it is
      // now: the sender is gone, so the row retires cancelled.
      await waitUntil(
        async () => journal().some((row) => row.thread_id === helper.threadId && row.status === "cancelled"),
        15_000,
        "restored aside row was not retired",
      );
      expect(journal().some((row) => row.thread_id === helper.threadId && row.status === "pending")).toBe(false);
      const lines = await threadLines(helper.threadId);
      // Parker's mid-seam row crashed at "dispatching": those words may
      // already have run, so the restart recovers them to the transcript
      // enveloped — with a review notice — and never re-executes them.
      expect(lines.filter((m) => m.aside === true)).toHaveLength(1);
      expect(
        lines.some((m) => m.kind === "activity" && m.tool?.name?.includes("interrupted by restart")),
      ).toBe(true);
      expect((await getBot(helper.id))?.busy).toBe(false);
      expect(lines.some((m) => m.text?.includes(ASIDE_TEXT))).toBe(false); // Ghost's words never arrived
    },
    90_000,
  );
});
