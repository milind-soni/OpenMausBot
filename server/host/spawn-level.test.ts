import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { Store, type BotRecord } from "../store.ts";
import { createOwnThreads } from "./own-threads.ts";

const claude = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const codex: ModelSelection = { instanceId: "codex", model: "gpt-5" };
const drivers: Record<string, string> = { claude: "claudeAgent", codex: "codex" };
const REQUEST = "123e4567-e89b-42d3-a456-426614174000";

/** The host's wiring (index.ts): a turn's level has its floors applied, and only the owner may raise one. */
function host(options: { floored?: Set<string>; owner?: boolean } = {}) {
  const store = new Store(claude);
  const own = createOwnThreads({
    store, registry: { instances: () => [], cliTarget: (id) => ({ driverKind: drivers[id]! }) }, node: () => undefined,
    current: () => undefined, proposalRefusal: () => null, givesWay: () => null, modelName: (one) => one.model,
    // sourceApprovalMode: a guest's or a fenced turn (`floored`) and a Bot API thread run at Ask, whatever the thread says.
    sourceLevel: (botId, threadId) => options.floored?.has(threadId) || store.taskByThread(botId, threadId)?.botApi
      ? "ask" : approvalModeFor(store.projectBotForTask(botId, threadId)!),
    mayRaise: () => options.owner ?? true,
  });
  return { store, own };
}

type Host = ReturnType<typeof host>;
const levelOf = (store: Store, botId: string, threadId: string) => approvalModeFor(store.projectBotForTask(botId, threadId)!);

function botAt(store: Store, mode: ApprovalMode, name = "Opener"): BotRecord {
  const bot = store.createBot();
  store.patchBot(bot.id, { name, approvalMode: mode, autoApprove: mode === "auto", alwaysAllow: ["mcp__docs__read"] });
  return store.bot(bot.id)!;
}

/** A conversation of the bot's with its own level, picked in its composer. */
function chatAt(store: Store, bot: BotRecord, mode: ApprovalMode): string {
  const chat = store.createTask(bot.id, "Chat", false)!.threadId;
  store.patchTask(bot.id, chat, { approvalMode: mode, autoApprove: mode === "auto" });
  return chat;
}

/** Every thread the bot opens from `chat`, the way index.ts and burst-host.ts open them. */
function spawnAll({ store, own }: Host, opener: BotRecord, chat: string, teammate: BotRecord) {
  const at = Date.now();
  const inherited = own.inherited(opener.id, chat);
  const startThread = store.createTask(opener.id, "Research", false, undefined, { botId: opener.id, name: opener.name, at }, inherited.approvalMode, inherited.modelSelection)!;
  const reportBack = own.inherited(opener.id, chat);
  const reported = store.createTask(opener.id, "Report back", false, undefined, { botId: opener.id, name: opener.name, threadId: chat, at }, reportBack.approvalMode, reportBack.modelSelection)!;
  const burstChild = store.createTask(opener.id, "Part 1", false, undefined, { botId: opener.id, name: opener.name, threadId: chat, burstId: "b1", at },
    own.approvalFor(store.bot(opener.id)!, claude(), chat), claude())!;
  const handedNew = store.createTask(teammate.id, "Handed on", false, undefined, { botId: opener.id, name: opener.name, threadId: chat, at },
    own.levelFor(store.bot(teammate.id)!, undefined, { botId: opener.id, threadId: chat }))!;
  const handedWork = store.createTask(teammate.id, `@${opener.name} · work`, false, undefined, { botId: opener.id, name: opener.name, threadId: chat, kind: "work", at },
    own.levelFor(store.bot(teammate.id)!, undefined, { botId: opener.id, threadId: chat }))!;
  return {
    own: [startThread, reported, burstChild].map((task) => levelOf(store, opener.id, task.threadId)),
    teammate: [handedNew, handedWork].map((task) => levelOf(store, teammate.id, task.threadId)),
    threads: { startThread, handedNew },
  };
}

describe("a thread a bot opens from a conversation takes that conversation's level", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("opens Full access threads from a chat at Full access, though the bot and its teammate are saved at Ask", () => {
    const h = host();
    const opener = botAt(h.store, "ask");
    const teammate = botAt(h.store, "ask", "Helper");
    const chat = chatAt(h.store, opener, "full");

    const spawned = spawnAll(h, opener, chat, teammate);

    expect(spawned.own).toEqual(["full", "full", "full"]);
    expect(spawned.teammate).toEqual(["full", "full"]);
    // Saved on the thread, so it outlives a restart, and the teammate's own default does not move.
    expect(levelOf(new Store(claude), teammate.id, spawned.threads.handedNew.threadId)).toBe("full");
    expect(approvalModeFor(h.store.bot(teammate.id)!)).toBe("ask");
    expect(approvalModeFor(h.store.bot(opener.id)!)).toBe("ask");
  });

  it("opens Ask threads from a chat at Ask, though the bot and its teammate are at Full access, keeping each bot's own grants", () => {
    const h = host();
    const opener = botAt(h.store, "full");
    const teammate = botAt(h.store, "full", "Helper");
    const chat = chatAt(h.store, opener, "ask");

    const spawned = spawnAll(h, opener, chat, teammate);

    expect(spawned.own).toEqual(["ask", "ask", "ask"]);
    expect(spawned.teammate).toEqual(["ask", "ask"]);
    expect(h.store.taskByThread(teammate.id, spawned.threads.handedNew.threadId)).toMatchObject({ approvalMode: "ask", autoApprove: false, alwaysAllow: ["mcp__docs__read"] });
  });

  it("carries Approve for me and Auto-accept edits, and caps a level at what the thread's engine runs", () => {
    const h = host();
    const opener = botAt(h.store, "ask");
    const onCodex = h.store.createBot();
    h.store.patchBot(onCodex.id, { name: "Coder", modelSelection: codex, approvalMode: "full" });
    const auto = chatAt(h.store, opener, "auto");
    expect(h.store.taskByThread(opener.id, h.store.createTask(opener.id, "Auto", false, undefined, undefined, h.own.inherited(opener.id, auto).approvalMode)!.threadId))
      .toMatchObject({ approvalMode: "auto", autoApprove: true });

    // Auto-accept edits does not exist on Codex: the teammate's new thread there starts at Ask, as an engine switch would.
    const edits = chatAt(h.store, opener, "edits");
    expect(h.own.levelFor(h.store.bot(onCodex.id)!, undefined, { botId: opener.id, threadId: edits })).toBe("ask");
    expect(h.own.approvalFor(h.store.bot(opener.id)!, codex, edits)).toBe("ask");
    expect(h.own.approvalFor(h.store.bot(opener.id)!, claude(), edits)).toEqual({ from: "edits" });
  });

  it("keeps the bot's level when the chat has none of its own, the same, a routine run's, or one still being confirmed", () => {
    const h = host();
    const opener = botAt(h.store, "ask");
    const teammate = botAt(h.store, "edits", "Helper");
    const chat = h.store.createTask(opener.id, "No level", false)!.threadId;
    const record = h.store.taskByThread(opener.id, chat)!;
    delete record.approvalMode;
    delete record.autoApprove;
    const from = { botId: opener.id, threadId: chat };
    expect(h.own.levelFor(h.store.bot(teammate.id)!, undefined, from)).toBeUndefined();
    expect(h.own.inherited(opener.id, chat)).toEqual({});

    const same = chatAt(h.store, opener, "ask");
    expect(h.own.inherited(opener.id, same)).toEqual({});

    // A routine run's conversation saves its bot's level when the run opens it: nobody chose it there.
    const run = chatAt(h.store, opener, "full");
    h.store.patchTask(opener.id, run, { routineRunId: "run-1" });
    expect(h.own.levelFor(h.store.bot(teammate.id)!, undefined, { botId: opener.id, threadId: run })).toBeUndefined();

    // The person picks Full access in that chat; the desktop is still confirming it: no Ask mask, no unconfirmed Full.
    const confirming = chatAt(h.store, opener, "full");
    h.store.patchBot(opener.id, { approvalGrant: { requestId: REQUEST, mode: "full", phase: "prepared", threadId: confirming, threadOnly: true } });
    expect(h.own.levelFor(h.store.bot(teammate.id)!, undefined, { botId: opener.id, threadId: confirming })).toBeUndefined();
  });

  it("never copies Custom, and never replaces it: a Custom chat opens Ask threads, a Custom bot's threads keep Custom", () => {
    const h = host();
    const opener = h.store.createBot();
    h.store.patchBot(opener.id, { name: "Codex bot", modelSelection: codex, approvalMode: "full" });
    const custom = chatAt(h.store, h.store.bot(opener.id)!, "custom");
    expect(h.own.inherited(opener.id, custom).approvalMode).toEqual({ from: "ask" });
    h.store.patchBot(opener.id, { approvalMode: "custom" });
    expect(h.own.inherited(opener.id, custom).approvalMode).toBeUndefined();

    // A teammate on Custom keeps its own configuration whatever the chat handing it work is set to.
    const sender = botAt(h.store, "ask", "Sender");
    for (const mode of ["full", "auto", "ask"] as const) {
      expect(h.own.levelFor(h.store.bot(opener.id)!, undefined, { botId: sender.id, threadId: chatAt(h.store, sender, mode) })).toBeUndefined();
    }
  });

  it("lets no guest or non-owner raise a level: a guest-driven chat opens Ask threads, and anyone else's at most the bot's", () => {
    const floored = new Set<string>();
    const guest = host({ floored, owner: false });
    const opener = botAt(guest.store, "full");
    const teammate = botAt(guest.store, "full", "Helper");
    const chat = chatAt(guest.store, opener, "full");
    // A guest drives this chat: its turn runs at Ask whatever the chat says, and so does everything it opens.
    floored.add(chat);
    const spawned = spawnAll(guest, opener, chat, teammate);
    expect(spawned.own).toEqual(["ask", "ask", "ask"]);
    expect(spawned.teammate).toEqual(["ask", "ask"]);
    expect(guest.store.taskByThread(opener.id, spawned.threads.startThread.threadId)?.alwaysAllow).toEqual([]);

    // Someone who may not set a level (a member, work from outside): a Full chat does not lift a bot saved at Ask...
    const member = host({ owner: false });
    const askBot = botAt(member.store, "ask");
    const askMate = botAt(member.store, "ask", "Helper");
    expect(spawnAll(member, askBot, chatAt(member.store, askBot, "full"), askMate)).toMatchObject({ own: ["ask", "ask", "ask"], teammate: ["ask", "ask"] });
    // ...while an Ask chat still lowers what it opens.
    const fullBot = botAt(member.store, "full", "Full");
    const fullMate = botAt(member.store, "full", "Full helper");
    expect(spawnAll(member, fullBot, chatAt(member.store, fullBot, "ask"), fullMate)).toMatchObject({ own: ["ask", "ask", "ask"], teammate: ["ask", "ask"] });
  });

  it("keeps Bot API threads at Ask, and what one opens at Ask too", () => {
    const h = host();
    const bot = botAt(h.store, "full");
    const teammate = botAt(h.store, "full", "Helper");
    // bot-api-host.ts: a key that does not act as the owner opens its thread at an explicit Ask.
    const api = h.store.createTask(bot.id, "From the API", false, undefined, undefined, "ask")!;
    h.store.patchTask(bot.id, api.threadId, { botApi: true });
    expect(h.store.taskByThread(bot.id, api.threadId)).toMatchObject({ approvalMode: "ask", autoApprove: false, alwaysAllow: [] });

    const spawned = spawnAll(h, bot, api.threadId, teammate);
    expect(spawned.own).toEqual(["ask", "ask", "ask"]);
    expect(spawned.teammate).toEqual(["ask", "ask"]);
  });
});
