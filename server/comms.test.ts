// Agent-to-agent comms, end to end: boots the real harness server with the
// grokAgent driver pointed at the fake ACP CLI in ask-peer mode, then has
// bot A's "agent" reach bot B through the injected agents proxy (list_bots →
// ask_bot → B runs a real depth-1 turn → reply folds back into A's answer).
// This exercises the whole chain the packaged app uses: startTurn →
// session/new mcpServers → agents-proxy → /api/internal/ask-bot →
// askBotAndWait → bus fold. The internal endpoints' auth is pinned too.
//
// The fake CLI is a shebang script — POSIX-only until resolveCliSpawn
// turned it into `node <script>` on Windows too, so the e2e half now runs
// everywhere alongside the mention-resolution units.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";


import { mentionedBots, normalizeGroupDefaultResponder, roomResponders } from "./store.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

describe("mentionedBots", () => {
  const peers = [
    { id: "1", name: "New Bot" },
    { id: "2", name: "New Bot 2" },
    { id: "3", name: "Milind" },
    { id: "4", name: "Ghost", hidden: true },
  ];
  it("matches a tag at a word start, case-insensitively", () => {
    expect(mentionedBots("hey @milind, look", peers).map((b) => b.id)).toEqual(["3"]);
    expect(mentionedBots("@Milind first thing", peers).map((b) => b.id)).toEqual(["3"]);
  });
  it("prefers the longest name so prefixes never half-match", () => {
    expect(mentionedBots("ask @New Bot 2 about it", peers).map((b) => b.id)).toEqual(["2"]);
  });
  it("dedupes repeats and collects multiple bots", () => {
    expect(mentionedBots("@Milind and @New Bot and @Milind", peers).map((b) => b.id)).toEqual(["3", "1"]);
  });
  it("ignores emails, hidden bots, and mid-word @", () => {
    expect(mentionedBots("mail milind@milind.dev please", peers)).toEqual([]);
    expect(mentionedBots("@Ghost around?", peers)).toEqual([]);
  });
  it("requires a word boundary at the end of the name", () => {
    expect(mentionedBots("ask @New Bottle about it", peers)).toEqual([]);
    expect(mentionedBots("@Milindo is someone else", peers)).toEqual([]);
  });
});

describe("roomResponders", () => {
  const members = [
    { id: "atlas", name: "Atlas" },
    { id: "milind", name: "Milind" },
  ];

  it("routes an unmentioned message to the configured lead", () => {
    expect(roomResponders("hello there", members, { kind: "member", botId: "atlas" })).toEqual([members[0]]);
  });

  it("lets explicit mentions override the configured lead", () => {
    expect(roomResponders("@Milind take this", members, { kind: "member", botId: "atlas" })).toEqual([members[1]]);
  });

  it("supports everyone and mentions-only room policies", () => {
    expect(roomResponders("hello", members, { kind: "everyone" })).toEqual(members);
    expect(roomResponders("hello", members, { kind: "mentions" })).toEqual([]);
    expect(roomResponders("@everyone hello", members, { kind: "mentions" })).toEqual(members);
  });

  it("keeps bot-to-bot channels on their last-speaker routing", () => {
    expect(normalizeGroupDefaultResponder({ kind: "everyone" }, members.map((member) => member.id), true)).toEqual({
      kind: "mentions",
    });
  });
});

describe("comms e2e (fake ACP fleet)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-comms-test-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          // the ask-peer fleet: both bots run "ask-peer" so A can ask B
          // synchronously (existing ask_bot e2e + the approval-gate e2e,
          // which uses the same sync path under a human card).
          grok: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "ask-peer" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // a separate asker instance for the async-handoff e2e. B can stay
          // on `grok` because its depth-1 turn runs without the agents
          // integration either way (the depth guard), so it just plays
          // plain happy text.
          askerDelegate: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "delegate-peer" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          chiefCreator: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "create-peer" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // a peer whose agent crashes at initialize — the delegated turn
          // ends with ok=false, so the channel must show a failed terminal
          // chip, not silence.
          helperCrash: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "exit-early" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // a successful peer turn that deliberately emits no assistant
          // text — the channel still needs a positive terminal record.
          helperEmpty: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "empty-reply" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // a turn that remains busy until provider reload disposes it.
          helperHang: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "hang" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
        },
      }),
    );

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    // Without SystemRoot, winsock fails to initialize in the child.
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
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

  it("seals the internal comms endpoints behind the boot token", async () => {
    const agents = await api("GET", "/api/internal/agents?self=x");
    expect(agents.status).toBe(401);
    const ask = await api("POST", "/api/internal/ask-bot", { toBotId: "x", message: "hi" });
    expect(ask.status).toBe(401);
  });

  it(
    "carries a question from bot A through the agents proxy to bot B and back",
    async () => {
      // deterministic roster: hide the seeded bot, add Asker + Helper
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const selection = { instanceId: "grok", model: "fake-model" };
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper", modelSelection: selection });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, { name: "Asker", modelSelection: selection });

      const send = await api("POST", `/api/bots/${asker.id}/messages`, { text: "hey @Helper ping" });
      expect(send.status).toBe(202);

      // wait for A's turn to settle with the peer's reply folded in
      const deadline = Date.now() + 25_000;
      let askerBot: any;
      for (;;) {
        askerBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        const settled = askerBot.messages.some(
          (m: any) => m.kind === "text" && m.role === "bot" && m.text?.includes("peer says:"),
        );
        if (settled && !askerBot.busy) break;
        if (Date.now() > deadline) {
          throw new Error(
            `A never got the peer reply. messages: ${JSON.stringify(askerBot.messages.slice(-6))}\nstderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      // A's answer contains B's actual reply, via the proxy's wrapper
      const reply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(reply.text).toContain("Helper replied:");
      expect(reply.text).toContain("hello from fake acp"); // B's happy-path turn text

      // visibility: A's thread shows a clickable "Messaged @Helper" chip
      // that links to the auto-created bot⇄bot channel
      const note = askerBot.messages.find((m: any) => m.kind === "activity" && m.tool?.name === "Messaged @Helper");
      expect(note).toBeTruthy();
      expect(note.comm?.groupId).toBeTruthy();
      expect(note.comm?.withName).toBe("Helper");

      // the exchange is mirrored into that channel, attributed to each bot
      const state = (await api("GET", "/api/bots")).body;
      const channel = state.groups.find((g: any) => g.id === note.comm.groupId);
      expect(channel?.dm).toBe(true);
      expect(channel.memberIds).toContain(asker.id);
      expect(channel.memberIds).toContain(helper.id);
      expect(channel.messages.some((m: any) => m.from?.botId === asker.id)).toBe(true);
      expect(channel.messages.some((m: any) => m.from?.botId === helper.id && m.text?.includes("hello from fake acp"))).toBe(true);

      // B's thread received the attributed message and ran a real turn,
      // plus a receive-side chip pointing at the same channel
      const helperBot = state.bots.find((b: any) => b.id === helper.id);
      const inbound = helperBot.messages.find((m: any) => m.role === "user" && m.kind === "text");
      expect(inbound.text).toContain("[Message from @Asker");
      expect(inbound.text).toContain("ping from fake");
      const rnote = helperBot.messages.find((m: any) => m.kind === "activity" && m.tool?.name === "Message from @Asker");
      expect(rnote?.comm?.groupId).toBe(note.comm.groupId);
      expect(helperBot.busy).toBeFalsy();
    },
    40_000,
  );

  it(
    "lets a section Chief create a safe operator and delegate work to it",
    async () => {
      const chief = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${chief.id}`, {
        name: "Atlas",
        section: "Launch",
        chiefOfStaff: true,
        modelSelection: { instanceId: "chiefCreator", model: "fake-model" },
      });

      const send = await api("POST", `/api/bots/${chief.id}/messages`, {
        text: "Create the specialist team and start the design review.",
      });
      expect(send.status).toBe(202);

      const deadline = Date.now() + 30_000;
      let operator: any;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        operator = state.bots.find((bot: any) => bot.name === "Pixel" && bot.section === "Launch");
        const replied = operator?.messages.some(
          (message: any) => message.role === "bot" && message.text?.includes("hello from fake acp"),
        );
        if (operator && replied && !operator.busy) break;
        if (Date.now() > deadline) {
          throw new Error(`Chief never created and delegated to Pixel. stderr: ${stderr.slice(-2000)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      expect(operator).toMatchObject({
        title: "Product designer",
        description: "Design and review the user experience.",
        section: "Launch",
        composio: false,
        autoApprove: false,
        approvePeerComms: false,
        modelSelection: { instanceId: "chiefCreator", model: "fake-model" },
      });
      expect(operator.chiefOfStaff).toBeFalsy();
      expect(operator.messages.some((message: any) => message.text?.includes("Review the new onboarding flow."))).toBe(true);
    },
    45_000,
  );

  // ── async peer handoff (delegate_bot) ───────────────────────────────
  // A's fake CLI uses FAKE_ACP_MODE=delegate-peer, which calls delegate_bot
  // (returns immediately with "Delegation queued"). After A's turn
  // settles, the harness fires B's depth-1 turn — B runs plain happy text
  // because the depth guard refuses to inject the agents integration at
  // depth >= MAX_COMMS_DEPTH. The exchange mirrors into a bot⇄bot channel
  // and shows up as chips on both 1:1 threads, just like ask_bot.
  it(
    "hands the task off async via delegate_bot and lets B run after A's turn settles",
    async () => {
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const helperSelection = { instanceId: "grok", model: "fake-model" };
      const askerSelection = { instanceId: "askerDelegate", model: "fake-model" };
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper", modelSelection: helperSelection });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, { name: "Asker", modelSelection: askerSelection });

      const send = await api("POST", `/api/bots/${asker.id}/messages`, { text: "hey @Helper please pick this up" });
      expect(send.status).toBe(202);

      // wait for A's turn to settle: it should NOT have a "peer says:" line
      // (delegate_bot doesn't return the peer's reply to A) and the channel
      // chip should be the "Messaged @Helper" kind, not the ask_bot one.
      const deadline = Date.now() + 30_000;
      let askerBot: any;
      let helperBot: any;
      let note: any;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        askerBot = state.bots.find((b: any) => b.id === asker.id);
        helperBot = state.bots.find((b: any) => b.id === helper.id);
        // A's "Delegated to @Helper: followup" chip proves the queue ran.
        // We also want B to have actually run (its busy flag is false and
        // it has a bot text reply).
        const askerDelegated = askerBot.messages.some(
          (m: any) => m.kind === "activity" && m.tool?.name === "Delegated to @Helper: followup",
        );
        note = askerBot.messages.find(
          (m: any) => m.kind === "activity" && m.tool?.name === "Messaged @Helper",
        );
        const helperReplied = helperBot.messages.some(
          (m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("hello from fake acp"),
        );
        if (askerDelegated && note && helperReplied && !helperBot.busy) break;
        if (Date.now() > deadline) {
          throw new Error(
            `delegate handoff never settled. asker busy=${askerBot.busy} helper busy=${helperBot.busy}\n` +
              `asker tail: ${JSON.stringify(askerBot.messages.slice(-8))}\n` +
              `helper tail: ${JSON.stringify(helperBot.messages.slice(-6))}\n` +
              `stderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      // A's reply is the queue-ack text the proxy returns, NOT a peer reply
      const askerFinal = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(askerFinal.text).toContain("delegated:");
      expect(askerFinal.text).not.toContain("hello from fake acp");

      // A's comm chip links to the channel, attributed to @Helper
      expect(note).toBeTruthy();
      expect(note.comm?.groupId).toBeTruthy();
      expect(note.comm?.withName).toBe("Helper");

      // B ran a depth-1 turn: the inbound user text carries the delegation
      // prefix, B's reply is the happy-mode line (no agents integration).
      const helperInbound = helperBot.messages.find(
        (m: any) => m.role === "user" && m.kind === "text",
      );
      expect(helperInbound.text).toContain("[Delegated by @Asker");
      expect(helperInbound.text).toContain("delegated task");
      expect(helperInbound.text).toContain("[Reason: followup]");
      const helperReply = helperBot.messages.findLast(
        (m: any) => m.kind === "text" && m.role === "bot",
      );
      expect(helperReply.text).toContain("hello from fake acp");

      // channel mirrors both sides, attributed by bot
      const state = (await api("GET", "/api/bots")).body;
      const channel = state.groups.find((g: any) => g.id === note.comm.groupId);
      expect(channel?.dm).toBe(true);
      expect(channel.memberIds).toContain(asker.id);
      expect(channel.memberIds).toContain(helper.id);
      // A's outgoing task is mirrored into the channel attributed to A.
      expect(
        channel.messages.some((m: any) => m.from?.botId === asker.id && m.text?.includes("delegated task")),
      ).toBe(true);
      // B's reply IS mirrored too: the channel is the full record of the
      // handoff — every terminal state of an async delegation is visible
      // where the human is looking, not just the request.
      expect(
        channel.messages.some((m: any) => m.from?.botId === helper.id && m.text?.includes("hello from fake acp")),
      ).toBe(true);

      // B's receive-side chip points at the same channel
      const helperNote = helperBot.messages.find(
        (m: any) => m.kind === "activity" && m.tool?.name === "Message from @Asker",
      );
      expect(helperNote?.comm?.groupId).toBe(note.comm.groupId);
      expect(helperBot.busy).toBeFalsy();
      expect(askerBot.busy).toBeFalsy();
    },
    45_000,
  );

  // ── delegation terminal-state mirroring ─────────────────────────────
  // A delegated turn is fire-and-forget: nobody waits for B, so the ONLY
  // place a human would ever see how it ended is the A⇄B channel. These
  // tests pin a successful empty reply plus both non-happy terminal states:
  // the delegated turn crashed, and the delegated turn never started.
  it(
    "mirrors a successful delegated turn with no reply as a completed terminal chip",
    async () => {
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, {
        name: "Helper",
        modelSelection: { instanceId: "helperEmpty", model: "fake-model" },
      });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Asker",
        modelSelection: { instanceId: "askerDelegate", model: "fake-model" },
      });

      const send = await api("POST", `/api/bots/${asker.id}/messages`, { text: "hey @Helper please pick this up" });
      expect(send.status).toBe(202);

      const deadline = Date.now() + 30_000;
      let channel: any;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        const askerBot = state.bots.find((b: any) => b.id === asker.id);
        const note = askerBot.messages.find(
          (m: any) => m.kind === "activity" && m.tool?.name === "Messaged @Helper",
        );
        channel = note?.comm?.groupId
          ? state.groups.find((g: any) => g.id === note.comm.groupId)
          : undefined;
        const terminal = channel?.messages.some(
          (m: any) =>
            m.from?.botId === helper.id
            && m.kind === "activity"
            && m.tool?.ok === true
            && m.tool?.name === "Delegated turn completed",
        );
        if (terminal) break;
        if (Date.now() > deadline) {
          throw new Error(
            `no completed terminal chip in channel. channel tail: ${JSON.stringify(channel?.messages?.slice(-6))}\n` +
              `stderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    45_000,
  );

  it(
    "finalizes a delegated turn interrupted by provider reload",
    async () => {
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, {
        name: "Helper",
        modelSelection: { instanceId: "helperHang", model: "fake-model" },
      });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Asker",
        modelSelection: { instanceId: "askerDelegate", model: "fake-model" },
      });

      const send = await api("POST", `/api/bots/${asker.id}/messages`, { text: "hey @Helper please pick this up" });
      expect(send.status).toBe(202);

      let channelId: string | undefined;
      const busyDeadline = Date.now() + 30_000;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        const askerBot = state.bots.find((b: any) => b.id === asker.id);
        const helperBot = state.bots.find((b: any) => b.id === helper.id);
        channelId = askerBot.messages.find(
          (m: any) => m.kind === "activity" && m.tool?.name === "Messaged @Helper",
        )?.comm?.groupId;
        if (channelId && helperBot.busy) break;
        if (Date.now() > busyDeadline) {
          throw new Error(`delegated hanging turn never started. stderr: ${stderr.slice(-2000)}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      // Any provider credential change rebuilds the fleet and settles busy
      // turns without relying on a provider turn.completed event.
      const reload = await api("PUT", "/api/config", { xai: { key: "xai_reload_test" } });
      expect(reload.status).toBe(200);

      const terminalDeadline = Date.now() + 30_000;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        const channel = state.groups.find((g: any) => g.id === channelId);
        const terminal = channel?.messages.filter(
          (m: any) =>
            m.from?.botId === helper.id
            && m.kind === "activity"
            && m.tool?.ok === false
            && m.tool?.name === "Delegated turn did not finish — provider settings changed",
        );
        if (terminal?.length === 1) break;
        if (Date.now() > terminalDeadline) {
          throw new Error(
            `provider reload did not finalize delegation. channel tail: ${JSON.stringify(channel?.messages?.slice(-6))}\n` +
              `stderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    60_000,
  );

  it(
    "mirrors a crashed delegated turn into the channel as a failed terminal chip",
    async () => {
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, {
        name: "Helper",
        modelSelection: { instanceId: "helperCrash", model: "fake-model" },
      });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Asker",
        modelSelection: { instanceId: "askerDelegate", model: "fake-model" },
      });

      const send = await api("POST", `/api/bots/${asker.id}/messages`, { text: "hey @Helper please pick this up" });
      expect(send.status).toBe(202);

      // settle = the channel exists (request mirrored) and carries the
      // failed terminal chip (B's turn started and crashed at initialize)
      const deadline = Date.now() + 30_000;
      let channel: any;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        const askerBot = state.bots.find((b: any) => b.id === asker.id);
        const note = askerBot.messages.find(
          (m: any) => m.kind === "activity" && m.tool?.name === "Messaged @Helper",
        );
        channel = note?.comm?.groupId
          ? state.groups.find((g: any) => g.id === note.comm.groupId)
          : undefined;
        const terminal = channel?.messages.some(
          (m: any) => m.kind === "activity" && m.tool?.ok === false && m.tool?.name?.includes("did not finish"),
        );
        if (terminal) break;
        if (Date.now() > deadline) {
          throw new Error(
            `no failed terminal chip in channel. channel tail: ${JSON.stringify(channel?.messages?.slice(-6))}\n` +
              `stderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      // the request side of the exchange is still there, attributed to A —
      // the channel reads as a complete (if unsuccessful) handoff
      expect(
        channel.messages.some((m: any) => m.from?.botId === asker.id && m.text?.includes("delegated task")),
      ).toBe(true);
    },
    45_000,
  );

  it(
    "mirrors a delegation that could not start into the channel",
    async () => {
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const helper = (await api("POST", "/api/bots")).body.bot;
      // no such instance — startTurn rejects, so B's turn never starts
      await api("PATCH", `/api/bots/${helper.id}`, {
        name: "Helper",
        modelSelection: { instanceId: "missing-instance", model: "fake-model" },
      });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Asker",
        modelSelection: { instanceId: "askerDelegate", model: "fake-model" },
      });

      const send = await api("POST", `/api/bots/${asker.id}/messages`, { text: "hey @Helper please pick this up" });
      expect(send.status).toBe(202);

      const deadline = Date.now() + 30_000;
      let channel: any;
      let sourceChip: any;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        const askerBot = state.bots.find((b: any) => b.id === asker.id);
        const note = askerBot.messages.find(
          (m: any) => m.kind === "activity" && m.tool?.name === "Messaged @Helper",
        );
        sourceChip = askerBot.messages.find(
          (m: any) => m.kind === "activity" && m.tool?.ok === false && m.tool?.name?.includes("could not start"),
        );
        channel = note?.comm?.groupId
          ? state.groups.find((g: any) => g.id === note.comm.groupId)
          : undefined;
        const terminal = channel?.messages.some(
          (m: any) => m.kind === "activity" && m.tool?.ok === false && m.tool?.name?.includes("could not start"),
        );
        if (sourceChip && terminal) break;
        if (Date.now() > deadline) {
          throw new Error(
            `could-not-start not mirrored. sourceChip=${JSON.stringify(sourceChip)}\n` +
              `channel tail: ${JSON.stringify(channel?.messages?.slice(-6))}\nstderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    45_000,
  );

  // ── approval gate (approvePeerComms) ─────────────────────────────────
  // When the SOURCE bot has approvePeerComms = true, an ask_bot call must
  // not run the peer turn until the user clicks Allow on a card pushed to
  // the source's thread. The card carries a requestId that
  // /api/bots/:id/respond resolves BEFORE forwarding to the provider
  // adapter, so the provider never sees the request.
  it(
    "blocks ask_bot behind a card and only runs B after the user allows",
    async () => {
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const selection = { instanceId: "grok", model: "fake-model" };
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper", modelSelection: selection });
      const asker = (await api("POST", "/api/bots")).body.bot;
      // approvePeerComms on the SOURCE bot — the test's whole point
      const approval = await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Asker",
        modelSelection: selection,
        approvePeerComms: true,
      });
      expect(approval.status).toBe(200);
      expect(approval.body.bot.approvePeerComms).toBe(true);

      const send = await api("POST", `/api/bots/${asker.id}/messages`, { text: "hey @Helper needs approval" });
      expect(send.status).toBe(202);

      // Wait for the options card to appear on A's thread. While the card
      // is open, B MUST NOT have started: no inbound user message, not busy,
      // no reply text.
      let askerBot: any;
      let helperBot: any;
      let card: any;
      const cardDeadline = Date.now() + 20_000;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        askerBot = state.bots.find((b: any) => b.id === asker.id);
        helperBot = state.bots.find((b: any) => b.id === helper.id);
        card = askerBot.messages.find(
          (m: any) => m.kind === "options" && m.card?.requestId && m.card?.tool === "ask_bot",
        );
        const helperStarted =
          helperBot.messages.some((m: any) => m.role === "user" && m.kind === "text") ||
          helperBot.busy;
        if (card && !helperStarted) break;
        if (Date.now() > cardDeadline) {
          throw new Error(
            `approval card never appeared or B started anyway\n` +
              `asker tail: ${JSON.stringify(askerBot.messages.slice(-8))}\n` +
              `helper tail: ${JSON.stringify(helperBot.messages.slice(-6))}\n` +
              `stderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      // The card carries the allowKey the Always-allow flow mirrors back
      // into bot.alwaysAllow, and offers Allow / Deny / Always allow.
      expect(card.card.allowKey).toBe(`ask_bot:${helper.id}`);
      expect(card.card.options).toEqual(["Allow", "Deny", "Always allow"]);
      expect(card.card.title).toContain("@Asker");
      expect(card.card.title).toContain("@Helper");

      // Allow → B runs, A's reply folds the peer reply, channel mirrors both
      const allow = await api(
        "POST",
        `/api/bots/${asker.id}/respond`,
        { requestId: card.card.requestId, behavior: "allow" },
      );
      expect(allow.status).toBe(200);

      const settledDeadline = Date.now() + 25_000;
      let finalAsker: any;
      let finalHelper: any;
      for (;;) {
        const state = (await api("GET", "/api/bots")).body;
        finalAsker = state.bots.find((b: any) => b.id === asker.id);
        finalHelper = state.bots.find((b: any) => b.id === helper.id);
        const peerFolded = finalAsker.messages.findLast(
          (m: any) => m.kind === "text" && m.role === "bot",
        )?.text?.includes("peer says:");
        const helperReplied = finalHelper.messages.some(
          (m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("hello from fake acp"),
        );
        if (peerFolded && helperReplied && !finalHelper.busy && !finalAsker.busy) break;
        if (Date.now() > settledDeadline) {
          throw new Error(
            `B never ran after allow\n` +
              `asker tail: ${JSON.stringify(finalAsker.messages.slice(-8))}\n` +
              `helper tail: ${JSON.stringify(finalHelper.messages.slice(-6))}\n` +
              `stderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    60_000,
  );

  it("refuses ask_bot with a denial chip and never starts B when the user denies", async () => {
    const seeded = (await api("GET", "/api/bots")).body.bots[0];
    await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
    const selection = { instanceId: "grok", model: "fake-model" };
    const helper = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper", modelSelection: selection });
    const asker = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${asker.id}`, {
      name: "Asker",
      modelSelection: selection,
      approvePeerComms: true,
    });

    const send = await api("POST", `/api/bots/${asker.id}/messages`, { text: "hey @Helper do not allow" });
    expect(send.status).toBe(202);

    let askerBot: any;
    let helperBot: any;
    let card: any;
    const cardDeadline = Date.now() + 20_000;
    for (;;) {
      const state = (await api("GET", "/api/bots")).body;
      askerBot = state.bots.find((b: any) => b.id === asker.id);
      helperBot = state.bots.find((b: any) => b.id === helper.id);
      card = askerBot.messages.find(
        (m: any) => m.kind === "options" && m.card?.requestId && m.card?.tool === "ask_bot",
      );
      if (card) break;
      if (Date.now() > cardDeadline) {
        throw new Error(
          `deny test: card never appeared\nasker tail: ${JSON.stringify(askerBot.messages.slice(-6))}\nstderr: ${stderr.slice(-2000)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const deny = await api(
      "POST",
      `/api/bots/${asker.id}/respond`,
      { requestId: card.card.requestId, behavior: "deny" },
    );
    expect(deny.status).toBe(200);

    // The harness returns {error:"denied by user"} to the agents proxy,
    // which wraps it as "Couldn't reach that bot: denied by user" and
    // returns it to A's agent. A's final assistant text carries that
    // signal — wait for A's turn to settle with it.
    const settledDeadline = Date.now() + 20_000;
    for (;;) {
      const state = (await api("GET", "/api/bots")).body;
      askerBot = state.bots.find((b: any) => b.id === asker.id);
      helperBot = state.bots.find((b: any) => b.id === helper.id);
      const finalText = askerBot.messages.findLast(
        (m: any) => m.role === "bot" && m.kind === "text" && m.text,
      );
      if (finalText?.text?.includes("denied by user") && !askerBot.busy) break;
      if (Date.now() > settledDeadline) {
        throw new Error(
          `deny test: denial didn't reach A\nasker tail: ${JSON.stringify(askerBot.messages.slice(-8))}\nstderr: ${stderr.slice(-2000)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // B must not have started: no inbound user message, no depth-1 reply.
    // (Every bot's thread has a seeded greeting of role:"bot" kind:"text",
    // so a generic text search would always match — check for the actual
    // happy-turn reply text and the inbound user text from A's exchange.)
    expect(helperBot.busy).toBeFalsy();
    expect(
      helperBot.messages.some((m: any) => m.role === "user" && m.kind === "text"),
    ).toBe(false);
    expect(
      helperBot.messages.some(
        (m: any) =>
          m.role === "bot" && m.kind === "text" && m.text?.includes("hello from fake acp"),
      ),
    ).toBe(false);
  }, 50_000);

  // ── depth guard regression ───────────────────────────────────────────
  // A bot invoked via ask_bot or delegate_bot runs at depth=1, which equals
  // MAX_COMMS_DEPTH. The depth guard in startTurn must refuse to inject
  // the agents integration, so B's CLI sees no agents mcpServer and falls
  // through to its plain happy text — NOT a "one hop" error from a depth-1
  // ask_bot. If the guard were removed, B's fake (also in ask-peer mode)
  // would call ask_bot, the harness would refuse recursion, and B's reply
  // would contain "peer error: ... one hop". The absence of that error is
  // the regression signal.
  it("does not inject the agents integration into a depth-1 turn", async () => {
    const seeded = (await api("GET", "/api/bots")).body.bots[0];
    await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
    // A runs delegate-peer and hands off to B, which runs ask-peer. If the
    // depth guard broke, B's depth-1 turn would call ask_bot and its reply
    // would carry the "one hop" refusal — the regression signal.
    const selection = { instanceId: "grok", model: "fake-model" };
    const askerSelection = { instanceId: "askerDelegate", model: "fake-model" };
    const helper = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper", modelSelection: selection });
    const asker = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${asker.id}`, { name: "Asker", modelSelection: askerSelection });

    const send = await api("POST", `/api/bots/${asker.id}/messages`, { text: "delegate this to @Helper please" });
    expect(send.status).toBe(202);

    // Wait for B's depth-1 turn to settle and write its reply
    const deadline = Date.now() + 30_000;
    let helperBot: any;
    for (;;) {
      const state = (await api("GET", "/api/bots")).body;
      helperBot = state.bots.find((b: any) => b.id === helper.id);
      // Match the actual reply text — the greeting on the seeded bot
      // matches `role:"bot" kind:"text"` too, so a generic text search
      // would break before B even runs.
      const reply = helperBot.messages.find(
        (m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("hello from fake acp"),
      );
      if (reply && !helperBot.busy) break;
      if (Date.now() > deadline) {
        throw new Error(
          `B never replied. helper tail: ${JSON.stringify(helperBot.messages.slice(-6))}\nstderr: ${stderr.slice(-2000)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    const reply = helperBot.messages.findLast(
      (m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("hello from fake acp"),
    );
    // If the guard were broken, B would have called ask_bot at depth=1 and
    // received "message chains are limited to one hop" back from the
    // harness. That error text would surface here as `peer error: ... one hop`.
    expect(reply.text).toContain("hello from fake acp");
    expect(reply.text).not.toContain("one hop");
    expect(reply.text).not.toContain("peer error");
  }, 45_000);
});
