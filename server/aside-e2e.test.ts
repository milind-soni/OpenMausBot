// The aside lane, end to end: a second peer ask that arrives while the pair
// conversation's own turn is mid-flight on a seam-capable engine folds into
// that RUNNING turn. The envelope physically enters the live session through
// Adapter.steer, the transcript records it as peer context (never steering,
// never a delegation), the asker gets an honest receipt, and the turn
// settles with the aside folded into its reply — once, not replayed at the
// settle boundary. A peer busy in an UNRELATED thread is the other half of
// the #1684 routing: the ask never enters that thread, it queues as a
// delegation for the pair conversation and runs there. The no-seam
// degradation (busy ACP pair turn → delegation queue) stays pinned by the
// ask_bot busy-fallback e2e in comms.test.ts.
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

posixOnly("peer aside lane e2e", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let finishGate: string;

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const waitUntil = async (predicate: () => Promise<boolean>, timeout: number, what: string): Promise<void> => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error(`${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 250));
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

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-aside-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    finishGate = join(home, "finish-aside-turn.gate");
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          // the busy target: a slow fake claude turn parked in its
          // post-tool gap, held open until the test drops the gate
          claudeSteer: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          // the asker: asks the FIRST visible bot through the agents proxy
          grok: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "ask-peer" },
            config: { cli: FAKE_ACP, fullAuto: true },
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
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });


  it(
    "folds a second ask into the pair conversation's busy turn as an aside: honest receipt, enveloped transcript line, no delegation, folded reply, no replay",
    async () => {
      rmSync(finishGate, { force: true });
      // determinism: the ask-peer CLI asks the FIRST visible bot, so hide
      // the seeded profile bot before creating the pair
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, {
        name: "Helper",
        modelSelection: { instanceId: "claudeSteer", model: "claude-fake" },
      });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Asker",
        modelSelection: { instanceId: "grok", model: "fake-model" },
      });
      const pairRowId = async () =>
        (await getBot(helper.id))?.tasks?.find((task: any) => task.title === "@Asker")?.threadId as string | undefined;
      const pairMessages = async (): Promise<any[]> => {
        const threadId = await pairRowId();
        return threadId ? (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages : [];
      };

      // The first ask opens the pair conversation (#1684: classic asks run
      // there, never in the recipient's selected thread) and its turn parks
      // in the slow gap after its tool result — the running turn a second
      // ask must fold into.
      expect((await startRoutine(asker.id, "hey @Helper ping")).status).toBe(201);
      await waitUntil(async () => (await getBot(helper.id))?.busy === true, 15_000, "helper pair turn never started");
      await waitUntil(async () => Boolean(await pairRowId()), 15_000, "pair conversation never appeared");
      await waitUntil(
        async () => (await pairMessages()).some((m: any) => m.kind === "activity"),
        15_000,
        "helper tool chip never landed",
      );

      // Asker asks again while the pair conversation is mid-turn
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

      // The pair transcript already shows the folded context: user-role,
      // enveloped, marked aside (never steered), attributed to the peer
      expect((await getBot(helper.id))?.busy).toBe(true); // an aside is not an interruption
      const asideLine = (await pairMessages()).find((m: any) => m.aside === true);
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
      const settledPair = await pairMessages();
      const finalReply = settledPair.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(finalReply.text).toContain("reply to: ");
      expect(finalReply.text).toContain(` + steered: ${ENVELOPE_OPEN}`);
      expect(finalReply.text).toContain(ASIDE_TEXT);
      // one injection, no replay: the settle boundary retired the row, it
      // did not fold the same words a second time
      expect(settledPair.filter((m: any) => m.aside === true)).toHaveLength(1);
      expect(settledPair.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text?.startsWith("reply to:"))).toHaveLength(1);
    },
    60_000,
  );

  it(
    "keeps an ask out of a busy unrelated thread: it queues for the pair conversation instead",
    async () => {
      rmSync(finishGate, { force: true });
      // the same pair survives across tests in this server
      const bots = (await api("GET", "/api/bots")).body.bots;
      const helper = bots.find((b: any) => b.name === "Helper");
      const asker = bots.find((b: any) => b.name === "Asker");
      const pairRowId = async () =>
        (await getBot(helper.id))?.tasks?.find((task: any) => task.title === "@Asker")?.threadId as string | undefined;
      const pairMessages = async (): Promise<any[]> => {
        const threadId = await pairRowId();
        return threadId ? (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages : [];
      };

      // Helper's person-driven turn opens in its own thread and parks in
      // the slow gap — a conversation the ask has no business entering
      expect((await api("POST", `/api/bots/${helper.id}/messages`, { text: "second" })).status).toBe(202);
      await waitUntil(async () => (await getBot(helper.id))?.busy === true, 15_000, "helper turn never started");
      await waitUntil(
        async () => (await getBot(helper.id))?.messages.some((m: any) => m.kind === "activity"),
        15_000,
        "helper tool chip never landed",
      );

      // Asker asks while Helper is mid-turn elsewhere
      expect((await startRoutine(asker.id, "hey @Helper ping")).status).toBe(201);
      let askerBot: any;
      await waitUntil(async () => {
        askerBot = await getBot(asker.id);
        const reply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
        return Boolean(reply?.text?.includes("peer says:") && !askerBot.busy);
      }, 25_000, "asker never got its reply");

      // the receipt is the delegation fallback, aimed at the pair
      // conversation — not a fold into the unrelated running turn
      const askerReply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(askerReply.text).toContain("peer says: Helper is busy right now");
      expect(askerReply.text).toContain("queued as a delegation");
      expect(askerReply.text).toContain("Task id:");
      expect(
        askerBot.messages.some(
          (m: any) => m.kind === "activity" && m.tool?.name === "Delegated to @Helper: asked while busy",
        ),
      ).toBe(true);

      // the unrelated thread stays untouched: no folded context ever enters it
      expect(((await getBot(helper.id))?.messages ?? []).filter((m: any) => m.aside === true)).toHaveLength(0);

      // release: the person's turn settles and the queued ask runs in the
      // pair conversation, delegated prefix and all
      writeFileSync(finishGate, "finish");
      await waitUntil(async () =>
        (await pairMessages()).some((m: any) => m.role === "user" && typeof m.text === "string" && m.text.includes("Delegated by @Asker")),
      20_000, "delegated ask never reached the pair conversation");
      await waitUntil(async () => (await getBot(helper.id))?.busy === false, 20_000, "helper turns never settled");
    },
    60_000,
  );
});
