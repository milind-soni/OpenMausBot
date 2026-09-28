import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  TighteningRequestService,
  tighteningCardCopy,
  type TighteningRequestStore,
} from "./tightening-requests.ts";
import type { OptionCardLike } from "./profile-requests.ts";
import { botFolder } from "./bot-folder.ts";
import { flushProfileHistory, readHistory, recordProfileChange } from "./profile-versions.ts";
import type { BotRecord } from "./store.ts";

interface StoredMessage {
  id: string;
  card?: OptionCardLike;
}

class MemoryStore implements TighteningRequestStore {
  readonly bots = new Map<string, BotRecord>();
  readonly threads = new Map<string, StoredMessage[]>();
  private sequence = 0;

  bot(id: string): BotRecord | undefined {
    return this.bots.get(id);
  }

  messagesFor(threadId: string): StoredMessage[] {
    return this.threads.get(threadId) ?? [];
  }

  appendMessage(
    threadId: string,
    message: { role: "bot"; kind: "options"; card: OptionCardLike; from?: { botId: string; name: string; color: string } },
  ): StoredMessage {
    const stored: StoredMessage = { id: `message-${++this.sequence}`, card: message.card };
    const messages = this.threads.get(threadId) ?? [];
    messages.push(stored);
    this.threads.set(threadId, messages);
    return stored;
  }

  patchMessage(
    threadId: string,
    messageId: string,
    patch: { card: OptionCardLike },
  ): StoredMessage | null {
    const message = this.messagesFor(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return null;
    message.card = patch.card;
    return message;
  }

  patchBot(id: string, patch: Parameters<TighteningRequestStore["patchBot"]>[1]): BotRecord | null {
    const bot = this.bots.get(id);
    if (!bot) return null;
    Object.assign(bot, patch);
    return bot;
  }
}

function harness(options: {
  mode?: BotRecord["approvalMode"];
  alwaysAllow?: string[];
  mcpServers?: string[];
  skills?: string[];
  composio?: boolean;
  browser?: boolean;
  approvePeerComms?: boolean;
}) {
  const store = new MemoryStore();
  const disabledSkills: Array<[string, string]> = [];
  const service = new TighteningRequestService({
    store,
    mountedMcpServers: (bot) => [...(bot.mcpServers ?? [])],
    enabledSkills: (botId) => (store.bot(botId)?.id === bot.id ? [...(options.skills ?? [])] : []),
    disableSkill: (botId, name) => {
      disabledSkills.push([botId, name]);
      return { ok: true as const };
    },
  });
  const bot: BotRecord = {
    id: randomUUID(),
    threadId: randomUUID(),
    name: "Scout",
    approvalMode: options.mode,
    alwaysAllow: options.alwaysAllow ? [...options.alwaysAllow] : undefined,
    mcpServers: options.mcpServers ? [...options.mcpServers] : undefined,
    composio: options.composio,
    browser: options.browser,
    approvePeerComms: options.approvePeerComms,
  } as unknown as BotRecord;
  store.bots.set(bot.id, bot);
  return {
    store, service, bot, disabledSkills,
    propose: (intents: unknown, reason = "incident lockdown") =>
      service.propose({ botId: bot.id, threadId: bot.threadId, intents, reason }),
  };
}

describe("tightening direction (schema-level)", () => {
  it("rejects escalation targets at the schema with copy naming the field and its allowed direction", () => {
    const { propose } = harness({ mode: "ask" });
    const cases: Array<[unknown, string, RegExp]> = [
      [{ approvalMode: "full" }, "approvalMode", /may only be proposed as "ask", "edits", or "auto"/],
      [{ approvalMode: "custom" }, "approvalMode", /may only be proposed as "ask", "edits", or "auto"/],
      [{ composio: true }, "composio", /composio may only be turned off/],
      [{ browser: true }, "browser", /browser may only be turned off/],
      [{ approvePeerComms: false }, "approvePeerComms", /approvePeerComms may only be turned on/],
      [{ notifications: true }, "notifications", /unsupported tightening field: notifications/],
    ];
    for (const [intents, field, pattern] of cases) {
      expect(() => propose(intents)).toThrow(pattern);
      expect(() => propose(intents)).toThrow(new RegExp(field));
    }
  });

  it("requires at least one intent and a reason", () => {
    const { propose } = harness({ mode: "full" });
    expect(() => propose({})).toThrow(/Choose at least one tightening intent/);
    expect(() => propose({ alwaysAllow: [] })).toThrow(/alwaysAllow must name at least one grant to remove/);
    expect(() => propose({ approvalMode: "ask" }, "   ")).toThrow(/reason is required/);
  });
});

describe("tightening direction (state-level)", () => {
  const upward: Array<[BotRecord["approvalMode"], "ask" | "edits" | "auto"]> = [
    ["ask", "edits"],
    ["ask", "auto"],
    ["edits", "auto"],
    ["custom", "edits"],
    ["custom", "auto"],
  ];
  for (const [from, to] of upward) {
    it(`rejects approvalMode ${from} → ${to} with copy naming the allowed direction`, () => {
      const { propose } = harness({ mode: from });
      expect(() => propose({ approvalMode: to })).toThrow(
        new RegExp(`approvalMode can only tighten.*"${to}" does not reduce "${from}"`),
      );
    });
  }
  it("rejects a same-level approvalMode move", () => {
    const { propose } = harness({ mode: "edits" });
    expect(() => propose({ approvalMode: "edits" })).toThrow(/approvalMode can only tighten/);
  });

  it("rejects booleans already in the tightened state", () => {
    const { propose } = harness({ composio: false, browser: false, approvePeerComms: true });
    expect(() => propose({ composio: false })).toThrow(/composio is already off; it may only be turned off/);
    expect(() => propose({ browser: false })).toThrow(/browser is already off; it may only be turned off/);
    expect(() => propose({ approvePeerComms: true })).toThrow(/approvePeerComms is already on; it may only be turned on/);
  });

  it("rejects list removals that would add or touch unknown entries", () => {
    const { propose } = harness({ alwaysAllow: ["Bash", "Read"], mcpServers: ["notes"], skills: ["pdf"] });
    expect(() => propose({ alwaysAllow: ["WebSearch"] })).toThrow(
      /alwaysAllow entries may only be removed, never added; not currently granted: WebSearch/,
    );
    expect(() => propose({ mcpServers: ["linear"] })).toThrow(
      /mcpServers may only unmount servers this bot currently mounts; not mounted: linear/,
    );
    expect(() => propose({ skills: ["imagegen"] })).toThrow(
      /skills may only be disabled, never enabled; not currently enabled: imagegen/,
    );
  });
});

describe("allowed transitions", () => {
  const downward: Array<[BotRecord["approvalMode"], "ask" | "edits" | "auto"]> = [
    ["full", "auto"],
    ["full", "edits"],
    ["full", "ask"],
    ["auto", "edits"],
    ["auto", "ask"],
    ["edits", "ask"],
    ["custom", "ask"],
  ];
  for (const [from, to] of downward) {
    it(`proposes and confirms approvalMode ${from} → ${to}`, () => {
      const { service, bot, propose } = harness({ mode: from });
      const card = propose({ approvalMode: to });
      expect(card.title).toBe("Tighten Scout's permissions?");
      const applied = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
      expect(applied).toMatchObject({ claimed: true, state: "applied", fields: ["approvalMode"] });
      expect(bot.approvalMode).toBe(to);
      expect(bot.autoApprove).toBe(to === "auto");
      expect(bot.approvalGrant).toBeUndefined();
    });
  }

  it("proposes and confirms every boolean and list reduction", () => {
    const { service, bot, propose, disabledSkills } = harness({
      mode: "full",
      alwaysAllow: ["Bash", "Read", "Edit"],
      mcpServers: ["notes", "linear"],
      skills: ["pdf", "imagegen"],
      approvePeerComms: false,
    });
    const card = propose({
      composio: false,
      browser: false,
      approvePeerComms: true,
      alwaysAllow: ["Bash", "Edit"],
      mcpServers: ["linear"],
      skills: ["pdf"],
    });
    const applied = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
    expect(applied).toMatchObject({
      claimed: true, state: "applied",
      fields: ["composio", "browser", "approvePeerComms", "alwaysAllow", "mcpServers", "skills"],
    });
    expect(bot.composio).toBe(false);
    expect(bot.browser).toBe(false);
    expect(bot.approvePeerComms).toBe(true);
    expect(bot.alwaysAllow).toEqual(["Read"]);
    expect(bot.mcpServers).toEqual(["notes"]);
    expect(disabledSkills).toEqual([[bot.id, "pdf"]]);
    expect(bot.lastTighteningRequestId).toBe(card.requestId);
  });

  it("treats undefined composio/browser as on and undefined approvePeerComms as off", () => {
    const { service, bot, propose } = harness({});
    const card = propose({ composio: false, browser: false, approvePeerComms: true });
    service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
    expect(bot.composio).toBe(false);
    expect(bot.browser).toBe(false);
    expect(bot.approvePeerComms).toBe(true);
  });

  it("resolves the legacy autoApprove bit as the current level", () => {
    const { service, bot, propose } = harness({});
    delete bot.approvalMode;
    bot.autoApprove = true;
    const card = propose({ approvalMode: "ask" });
    const applied = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
    expect(applied).toMatchObject({ state: "applied" });
    expect(bot.approvalMode).toBe("ask");
    expect(bot.autoApprove).toBe(false);
  });
});

describe("confirm-time re-validation", () => {
  it("fails closed when the bot loosened after the card was prepared", () => {
    const { service, bot, propose } = harness({ alwaysAllow: ["Bash", "Read"] });
    const card = propose({ alwaysAllow: ["Bash"] });
    // The owner grants a new always-allow key while the card sits open.
    bot.alwaysAllow = ["Bash", "Read", "WebSearch"];
    const result = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
    expect(result).toMatchObject({ claimed: true, state: "invalid", status: 409 });
    if (result.claimed && result.state === "invalid") {
      expect(result.error).toMatch(/authority changed after this card was prepared/i);
    }
    expect(bot.alwaysAllow).toEqual(["Bash", "Read", "WebSearch"]);
  });

  it("fails closed when the approval level rose after the card was prepared", () => {
    const { service, bot, propose } = harness({ mode: "auto" });
    const card = propose({ approvalMode: "ask" });
    bot.approvalMode = "full";
    const result = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
    expect(result).toMatchObject({ state: "invalid", status: 409 });
    expect(bot.approvalMode).toBe("full");
  });

  it("re-validates direction against live state even when the revision still matches", () => {
    const { service, bot, propose } = harness({ mode: "edits" });
    const card = propose({ approvalMode: "ask" });
    // Same state, same revision: the direction check must still be the gate.
    const result = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
    expect(result).toMatchObject({ state: "applied" });
    expect(bot.approvalMode).toBe("ask");
  });

  it("denies without applying and settles duplicate clicks as already settled", () => {
    const { service, bot, propose } = harness({ mode: "full" });
    const card = propose({ approvalMode: "ask" });
    expect(service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "deny" }))
      .toMatchObject({ state: "denied" });
    expect(bot.approvalMode).toBe("full");
    expect(service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" }))
      .toMatchObject({ state: "already_settled", behavior: "deny" });
    expect(bot.approvalMode).toBe("full");
  });

  it("claims replays after an applied card instead of re-applying", () => {
    const { service, bot, propose } = harness({ alwaysAllow: ["Bash", "Read"] });
    const card = propose({ alwaysAllow: ["Bash"] });
    expect(service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" }))
      .toMatchObject({ state: "applied" });
    expect(bot.alwaysAllow).toEqual(["Read"]);
    expect(service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" }))
      .toMatchObject({ state: "already_settled", behavior: "allow" });
    expect(bot.alwaysAllow).toEqual(["Read"]);
  });
});

describe("card plumbing", () => {
  it("auto-applies under the source conversation's Full access and hides the card", () => {
    const { store, bot } = harness({ mode: "full" });
    const autoApply = vi.fn((_botId: string, threadId: string) => threadId === "full-thread");
    const service = new TighteningRequestService({ store, autoApply });
    const submitted = service.submit({ botId: bot.id, threadId: "full-thread", intents: { approvalMode: "ask" }, reason: "granted" });
    expect(submitted.state).toBe("applied");
    expect(bot.approvalMode).toBe("ask");
    expect(store.messagesFor("full-thread")[0]?.card).toMatchObject({ options: [], dismissed: true, answered: "allow" });
  });

  it("keeps cross-bot proposals behind validateTarget at propose and confirm", () => {
    const { store, service, bot } = harness({ mode: "full" });
    const peer: BotRecord = { ...structuredClone(bot), id: randomUUID(), name: "Peer" } as BotRecord;
    store.bots.set(peer.id, peer);
    const refusal = () => "only a section's Chief of Staff can change another bot's permissions";
    service.validateTarget = () => refusal();
    expect(() => service.propose({ botId: bot.id, threadId: bot.threadId, targetBotId: peer.id, intents: { approvalMode: "ask" }, reason: "r" }))
      .toThrow(/only a section's Chief/);
    service.validateTarget = () => null;
    const card = service.propose({ botId: bot.id, threadId: bot.threadId, targetBotId: peer.id, intents: { approvalMode: "ask" }, reason: "r" });
    service.validateTarget = () => refusal();
    const result = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
    expect(result).toMatchObject({ state: "invalid", status: 404 });
    expect(peer.approvalMode).toBe("full");
  });

  it("holds approval-mode and MCP changes while the target is busy, except an emergency downgrade", () => {
    const { store, service, bot } = harness({ mode: "full", mcpServers: ["notes"] });
    const targetBusy = (botId: string) => botId === bot.id;
    const busy = new TighteningRequestService({ store, targetBusy, mountedMcpServers: (b) => [...(b.mcpServers ?? [])] });
    const mode = busy.propose({ botId: bot.id, threadId: bot.threadId, intents: { approvalMode: "ask" }, reason: "r" });
    expect(busy.resolve({ botId: bot.id, threadId: bot.threadId, requestId: mode.requestId, behavior: "allow" }))
      .toMatchObject({ state: "applied", emergencyStop: true });
    expect(bot.approvalMode).toBe("ask");

    bot.approvalMode = "auto";
    const held = service.propose({ botId: bot.id, threadId: bot.threadId, intents: { approvalMode: "ask" }, reason: "r" });
    expect(busy.resolve({ botId: bot.id, threadId: bot.threadId, requestId: held.requestId, behavior: "allow" }))
      .toMatchObject({ state: "invalid", status: 409, error: "Stop this bot's turn before changing its approval level" });
    const mcp = service.propose({ botId: bot.id, threadId: bot.threadId, intents: { mcpServers: ["notes"] }, reason: "r" });
    expect(busy.resolve({ botId: bot.id, threadId: bot.threadId, requestId: mcp.requestId, behavior: "allow" }))
      .toMatchObject({ state: "invalid", status: 409, error: "Stop this bot's turns before changing its MCP servers" });
    // A busy bot still accepts reductions its owner's routes allow mid-turn.
    const flags = service.propose({ botId: bot.id, threadId: bot.threadId, intents: { composio: false }, reason: "r" });
    expect(busy.resolve({ botId: bot.id, threadId: bot.threadId, requestId: flags.requestId, behavior: "allow" }))
      .toMatchObject({ state: "applied" });
    expect(bot.composio).toBe(false);
  });

  it("writes the receipt before skills, so a failed disable retries instead of stranding the card", () => {
    const { store, bot } = harness({ skills: ["pdf"], mode: "full" });
    const failing = new TighteningRequestService({
      store,
      enabledSkills: () => ["pdf"],
      disableSkill: () => ({ ok: false as const, error: 'no imported skill named "pdf"' }),
    });
    const card = failing.propose({ botId: bot.id, threadId: bot.threadId, intents: { approvalMode: "ask", skills: ["pdf"] }, reason: "r" });
    const first = failing.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
    // The authority change and receipt are durable; the skill failure is
    // surfaced on the card for a retry, not silently dropped.
    expect(first).toMatchObject({ state: "applied" });
    expect(bot.approvalMode).toBe("ask");
    expect(bot.lastTighteningRequestId).toBe(card.requestId);
    const held = store.messagesFor(bot.threadId).find((m) => m.card?.requestId === card.requestId)?.card?.held;
    expect(held).toContain("finish disabling: pdf");

    const disabled: string[] = [];
    const healed = new TighteningRequestService({
      store,
      enabledSkills: () => (disabled.length ? [] : ["pdf"]),
      disableSkill: (_botId, name) => {
        disabled.push(name);
        return { ok: true as const };
      },
    });
    const second = healed.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
    expect(second).toMatchObject({ state: "already_settled" });
    expect(disabled).toEqual(["pdf"]);
    const settled = store.messagesFor(bot.threadId).find((m) => m.card?.requestId === card.requestId)?.card;
    expect(settled?.answered).toBe("allow");
  });

  it("finishes only the skills a failed attempt left enabled", () => {
    const { store, bot } = harness({ skills: ["a", "b"], mode: "full" });
    const done = new Set<string>();
    let failNext = true;
    const service = new TighteningRequestService({
      store,
      enabledSkills: () => ["a", "b"].filter((name) => !done.has(name)),
      disableSkill: (_botId, name) => {
        if (name === "b" && failNext) return { ok: false as const, error: "store busy" };
        done.add(name);
        return { ok: true as const };
      },
    });
    const card = service.propose({ botId: bot.id, threadId: bot.threadId, intents: { skills: ["a", "b"] }, reason: "r" });
    const first = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
    expect(first).toMatchObject({ state: "applied" });
    expect([...done]).toEqual(["a"]);
    const held = store.messagesFor(bot.threadId).find((m) => m.card?.requestId === card.requestId)?.card?.held;
    expect(held).toContain("finish disabling: b");

    failNext = false;
    const second = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
    expect(second).toMatchObject({ state: "already_settled" });
    expect([...done]).toEqual(["a", "b"]);
  });

  it("carries emergencyStop through the committed-change fallback", () => {
    const { bot } = harness({ mode: "full" });
    class BrittleMessages extends MemoryStore {
      patchMessage(): never {
        throw new Error("disk full");
      }
    }
    const brittleStore = new BrittleMessages();
    brittleStore.bots.set(bot.id, bot);
    const brittle = new TighteningRequestService({
      store: brittleStore,
      mountedMcpServers: (record) => [...(record.mcpServers ?? [])],
    });
    const card = brittle.propose({ botId: bot.id, threadId: bot.threadId, intents: { approvalMode: "ask" }, reason: "r" });
    // patchBot commits the downgrade; recording the decision on the card
    // then fails. The fallback must still stop the running turn.
    const result = brittle.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
    expect(result).toMatchObject({ state: "applied", emergencyStop: true });
    expect(bot.approvalMode).toBe("ask");
  });

  it("carries intents and the before snapshot on the card, without new wire fields", () => {
    const { store, bot, propose } = harness({ mode: "full", alwaysAllow: ["Bash", "Read"] });
    const card = propose({ approvalMode: "ask", alwaysAllow: ["Bash"] });
    const payload = store.messagesFor(bot.threadId)[0]?.card?.tighteningRequest;
    expect(payload).toMatchObject({
      botId: bot.id,
      targetBotId: bot.id,
      intents: { approvalMode: "ask", alwaysAllow: ["Bash"] },
      before: { approvalMode: "full", alwaysAllow: ["Bash", "Read"] },
    });
    expect(store.messagesFor(bot.threadId)[0]?.card).toMatchObject({ tool: "tighten_permissions", options: ["Confirm", "Cancel"] });
    expect(card.detail).toContain("Approvals: full → ask");
    expect(card.detail).toContain("Always-allow grants: 2 → 1 — removed: Bash");
    expect(card.detail).toContain("This reduces Scout's authority, and the reverse cannot be proposed back.");
  });
});

describe("tightening card copy", () => {
  it("renders one line per field with before and after, so a multi-field card reads in one pass", () => {
    const before = {
      approvalMode: "full" as const,
      composio: true,
      browser: true,
      approvePeerComms: false,
      alwaysAllow: ["Bash", "Read", "WebSearch"],
      mcpServers: ["fs", "github"],
      skills: ["pdf"],
    };
    const copy = tighteningCardCopy(
      { name: "Scout", crossBot: false },
      before,
      { approvalMode: "ask", composio: false, browser: false, approvePeerComms: true, alwaysAllow: ["Bash", "WebSearch"], mcpServers: ["fs"], skills: ["pdf"] },
      "incident lockdown",
    );
    expect(copy.detail).toBe([
      "Why: incident lockdown",
      "Approvals: full → ask",
      "Connected apps: on → off",
      "Browser: on → off",
      "Peer contact: no approval → ask first",
      "Always-allow grants: 3 → 1 — removed: Bash, WebSearch",
      "MCP servers: 2 → 1 — unmounted: fs",
      "Skills: 1 → 0 — disabled: pdf",
      "This reduces Scout's authority, and the reverse cannot be proposed back.",
    ].join("\n"));
  });

  it("caps removed-entry names with a count so a wide card stays readable", () => {
    const grants = ["a", "b", "c", "d", "e", "f", "g"];
    const copy = tighteningCardCopy(
      { name: "Scout", crossBot: true },
      { approvalMode: "auto" as const, composio: false, browser: false, approvePeerComms: false, alwaysAllow: grants, mcpServers: [], skills: [] },
      { alwaysAllow: grants },
      "r",
    );
    expect(copy.detail).toContain("Always-allow grants: 7 → 0 — removed: a, b, c, d, e (+2 more)");
    expect(copy.detail).not.toContain("f, g");
  });
});

describe("tightening history", () => {
  it("records the proposing bot as actor and the card id as via, beside manual profile rows", async () => {
    const { store, service, bot, propose } = harness({ mode: "full", alwaysAllow: ["Bash", "Read"], mcpServers: ["fs"], skills: ["pdf"] });
    // A real bot gets its folder at creation; a synthetic one needs it so
    // the history write has somewhere to land (profile-requests does the same).
    mkdirSync(botFolder(bot.id), { recursive: true, mode: 0o700 });
    recordProfileChange(bot.id, "user", "ui", { name: "Scout" }, { name: "Ranger" });
    const card = propose({ approvalMode: "ask", alwaysAllow: ["Bash"], mcpServers: ["fs"], skills: ["pdf"] });
    const result = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
    expect(result).toMatchObject({ state: "applied" });
    await flushProfileHistory(bot.id);
    const rows = readHistory(bot.id);
    const messageId = store.messagesFor(bot.threadId).find((message) => message.card?.requestId === card.requestId)!.id;
    expect(rows.map((row) => [row.field, row.actor, row.via, row.before, row.after])).toEqual([
      ["skills", "bot", `card:${messageId}`, "pdf", ""],
      ["mcpServers", "bot", `card:${messageId}`, "fs", ""],
      ["alwaysAllow", "bot", `card:${messageId}`, "Bash, Read", "Read"],
      ["approvalMode", "bot", `card:${messageId}`, "full", "ask"],
      ["name", "user", "ui", "Scout", "Ranger"],
    ]);
  });

  it("records the card's committed change when a retry settles the receipt, even if the owner edited the mode meanwhile", async () => {
    // A live snapshot at retry time would misattribute owner edits made
    // between the failed attempt and the retry: re-flipping the mode to
    // full would erase the row entirely, and any other value would be
    // recorded as the card's doing. The row must derive from the card's
    // frozen inputs, never the live bot.
    const runLeg = async (ownerEdit?: BotRecord["approvalMode"]) => {
      const { bot } = harness({ mode: "full" });
      mkdirSync(botFolder(bot.id), { recursive: true, mode: 0o700 });
      let failPatchMessage = true;
      class BrittleMessages extends MemoryStore {
        patchMessage(...args: Parameters<MemoryStore["patchMessage"]>): ReturnType<MemoryStore["patchMessage"]> {
          if (failPatchMessage) throw new Error("disk full");
          return super.patchMessage(...args);
        }
      }
      const brittleStore = new BrittleMessages();
      brittleStore.bots.set(bot.id, bot);
      const brittle = new TighteningRequestService({
        store: brittleStore,
        mountedMcpServers: (record) => [...(record.mcpServers ?? [])],
      });
      const card = brittle.propose({ botId: bot.id, threadId: bot.threadId, intents: { approvalMode: "ask" }, reason: "r" });

      // patchBot commits the downgrade; recording the decision on the card
      // fails, so the applied change leaves no history row yet.
      const first = brittle.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
      expect(first).toMatchObject({ state: "applied" });
      expect(bot.approvalMode).toBe("ask");
      await flushProfileHistory(bot.id);
      expect(readHistory(bot.id)).toEqual([]);

      // The owner edits the mode directly while the card is still unsettled.
      // The durable receipt keeps the retry on the settle-only path.
      if (ownerEdit !== undefined) bot.approvalMode = ownerEdit;

      // The write heals; the retry settles the card and records the
      // committed change from the card's own frozen inputs.
      failPatchMessage = false;
      const second = brittle.resolve({ botId: bot.id, threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
      expect(second).toMatchObject({ state: "already_settled" });
      await flushProfileHistory(bot.id);
      const messageId = brittleStore.messagesFor(bot.threadId).find((message) => message.card?.requestId === card.requestId)!.id;
      expect(readHistory(bot.id).map((row) => [row.field, row.actor, row.via, row.before, row.after])).toEqual([
        ["approvalMode", "bot", `card:${messageId}`, "full", "ask"],
      ]);
    };
    await runLeg();
    await runLeg("full");
    await runLeg("auto");
  });
});
