// propose_model unit contract: same card/confirm split as profile requests,
// engine-switch capability warnings from the injected resolver, staleness
// fail-closed against the shown "before" snapshot, and applyModelDefault as
// the only commit path.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { ModelRequestService, type ModelRequestStore, type OptionCardLike } from "./model-requests.ts";
import type { ModelSelection } from "../shared/wire.ts";
import type { BotRecord } from "./store.ts";

interface StoredMessage {
  id: string;
  card?: OptionCardLike;
}

class MemoryStore implements ModelRequestStore {
  readonly bots = new Map<string, BotRecord>();
  readonly threads = new Map<string, StoredMessage[]>();
  readonly applied: Array<{ id: string; selection: ModelSelection }> = [];
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
    const stored: StoredMessage = { id: "message-" + ++this.sequence, card: message.card };
    const messages = this.threads.get(threadId) ?? [];
    messages.push(stored);
    this.threads.set(threadId, messages);
    return stored;
  }

  patchMessage(threadId: string, messageId: string, patch: { card: OptionCardLike }): StoredMessage | null {
    const message = this.messagesFor(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return null;
    message.card = patch.card;
    return message;
  }

  applyModelDefault(id: string, selection: ModelSelection): BotRecord | null {
    const bot = this.bots.get(id);
    if (!bot) return null;
    this.applied.push({ id, selection: structuredClone(selection) });
    bot.modelSelection = structuredClone(selection);
    return bot;
  }
}

function addBot(store: MemoryStore, name: string, selection: ModelSelection = { instanceId: "claude", model: "sonnet" }): BotRecord {
  const record = {
    id: randomUUID(), threadId: randomUUID(), name, title: "", description: "", soul: "",
    notifications: true, color: "blue", unread: false, resumeCursors: {},
    modelSelection: structuredClone(selection),
  } as unknown as BotRecord;
  store.bots.set(record.id, record);
  return record;
}

const CAPS: Record<string, { driverKind: string; agentsMcp: boolean }> = {
  claude: { driverKind: "claudeAgent", agentsMcp: true },
  codex: { driverKind: "codex", agentsMcp: false },
};
const caps = (instanceId: string) => CAPS[instanceId];

describe("ModelRequestService", () => {
  it("renders engine-switch capability warnings and applies the reviewed change", () => {
    const store = new MemoryStore();
    const bot = addBot(store, "Scout");
    const service = new ModelRequestService({ store, driverCapabilities: caps });
    const proposal = service.propose({
      botId: bot.id, threadId: bot.threadId,
      selection: { instanceId: "codex", model: "gpt-fixture" }, reason: "asked",
    });
    expect(proposal.detail).toContain("Default engine/model:");
    expect(proposal.detail).toContain("Loses peer coordination and every team tool");
    expect(proposal.detail).toContain("coordinate_bots");
    expect(proposal.detail).toContain("Loses approval levels: edits.");
    expect(proposal.detail).toContain("Gains approval levels: custom.");
    const result = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: proposal.requestId, behavior: "allow" });
    expect(result).toMatchObject({ claimed: true, state: "applied", targetBotId: bot.id });
    expect(bot.modelSelection).toEqual({ instanceId: "codex", model: "gpt-fixture" });
    expect(store.applied).toHaveLength(1);
    expect(store.messagesFor(bot.threadId)[0].card).toMatchObject({ answered: "allow", tool: "update_model" });
  });

  it("keeps a same-engine model change plain: no capability lines", () => {
    const store = new MemoryStore();
    const bot = addBot(store, "Scout");
    const service = new ModelRequestService({ store, driverCapabilities: caps });
    const proposal = service.propose({
      botId: bot.id, threadId: bot.threadId,
      selection: { instanceId: "claude", model: "opus" }, reason: "asked",
    });
    expect(proposal.detail).toContain("Default engine/model:");
    expect(proposal.detail).not.toContain("peer coordination");
    expect(proposal.detail).not.toContain("approval levels");
  });

  it("fails closed when the default moved after the card was prepared", () => {
    const store = new MemoryStore();
    const bot = addBot(store, "Scout");
    const service = new ModelRequestService({ store, driverCapabilities: caps });
    const proposal = service.propose({
      botId: bot.id, threadId: bot.threadId,
      selection: { instanceId: "codex", model: "gpt-fixture" }, reason: "asked",
    });
    bot.modelSelection = { instanceId: "claude", model: "opus" };
    const result = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: proposal.requestId, behavior: "allow" });
    expect(result).toMatchObject({ claimed: true, state: "invalid", status: 409 });
    if (result.state === "invalid") expect(result.error).toContain("changed after this card was prepared");
    expect(store.applied).toHaveLength(0);
    expect(store.messagesFor(bot.threadId)[0].card?.held).toBeTruthy();
  });

  it("refuses cross-bot proposals at propose and re-checks authority at confirm", () => {
    const store = new MemoryStore();
    const chief = addBot(store, "Clive");
    const peer = addBot(store, "Ada");
    let refuse: string | null = null;
    const validateTarget = vi.fn(() => refuse);
    const service = new ModelRequestService({ store, validateTarget });
    const proposal = service.propose({
      botId: chief.id, threadId: chief.threadId, targetBotId: peer.id,
      selection: { instanceId: "codex", model: "gpt-fixture" }, reason: "asked",
    });
    expect(validateTarget).toHaveBeenCalledTimes(1);
    expect(proposal.detail).toContain("Whose default model: @Ada");
    refuse = "that bot is not in a team this Chief is allowed to manage";
    const result = service.resolve({ botId: chief.id, threadId: chief.threadId, requestId: proposal.requestId, behavior: "allow" });
    expect(result).toMatchObject({ claimed: true, state: "invalid", status: 404 });
    if (result.state === "invalid") expect(result.error).toContain("not in a team");
    expect(store.applied).toHaveLength(0);
    // A Chief proposing for itself never consults the cross-bot rule.
    refuse = "self proposals never consult the cross-bot rule";
    const self = new ModelRequestService({ store, validateTarget });
    self.propose({ botId: chief.id, threadId: chief.threadId, selection: { instanceId: "codex", model: "gpt-fixture" }, reason: "asked" });
    expect(validateTarget).toHaveBeenCalledTimes(2);
  });

  it("auto-applies under Full Access without exposing an unanswered card", () => {
    const store = new MemoryStore();
    const bot = addBot(store, "Scout");
    const service = new ModelRequestService({ store, autoApply: () => true, driverCapabilities: caps });
    const submitted = service.submit({
      botId: bot.id, threadId: bot.threadId,
      selection: { instanceId: "codex", model: "gpt-fixture" }, reason: "asked",
    });
    expect(submitted.state).toBe("applied");
    expect(bot.modelSelection).toEqual({ instanceId: "codex", model: "gpt-fixture" });
    const card = store.messagesFor(bot.threadId)[0].card!;
    expect(card.options).toEqual([]);
    expect(card.dismissed).toBe(true);
    expect(card.answered).toBe("allow");
  });

  it("settles idempotently when the requested selection is already live", () => {
    const store = new MemoryStore();
    const bot = addBot(store, "Scout");
    const service = new ModelRequestService({ store });
    const proposal = service.propose({
      botId: bot.id, threadId: bot.threadId,
      selection: { instanceId: "codex", model: "gpt-fixture" }, reason: "asked",
    });
    bot.modelSelection = { instanceId: "codex", model: "gpt-fixture" };
    const result = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: proposal.requestId, behavior: "allow" });
    expect(result).toMatchObject({ claimed: true, state: "already_settled", behavior: "allow" });
    expect(store.applied).toHaveLength(0);
  });

  it("re-checks cross-bot authority before the idempotent close", () => {
    const store = new MemoryStore();
    const chief = addBot(store, "Clive");
    const peer = addBot(store, "Ada");
    let refuse: string | null = null;
    const validateTarget = vi.fn(() => refuse);
    const service = new ModelRequestService({ store, validateTarget });
    const proposal = service.propose({
      botId: chief.id, threadId: chief.threadId, targetBotId: peer.id,
      selection: { instanceId: "codex", model: "gpt-fixture" }, reason: "asked",
    });
    peer.modelSelection = { instanceId: "codex", model: "gpt-fixture" };
    refuse = "that bot is not in a team this Chief is allowed to manage";
    const result = service.resolve({ botId: chief.id, threadId: chief.threadId, requestId: proposal.requestId, behavior: "allow" });
    expect(validateTarget).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ claimed: true, state: "invalid", status: 404 });
    expect(store.messagesFor(chief.threadId)[0].card?.answered).toBeFalsy();
    expect(store.applied).toHaveLength(0);
  });

  it("records a cancel even when the requested selection is already live", () => {
    const store = new MemoryStore();
    const bot = addBot(store, "Scout");
    const service = new ModelRequestService({ store });
    const proposal = service.propose({
      botId: bot.id, threadId: bot.threadId,
      selection: { instanceId: "codex", model: "gpt-fixture" }, reason: "asked",
    });
    bot.modelSelection = { instanceId: "codex", model: "gpt-fixture" };
    const result = service.resolve({ botId: bot.id, threadId: bot.threadId, requestId: proposal.requestId, behavior: "deny" });
    expect(result).toMatchObject({ claimed: true, state: "denied" });
    expect(store.messagesFor(bot.threadId)[0].card?.answered).toBe("deny");
    expect(store.applied).toHaveLength(0);
  });

  it("rejects no-op, malformed and unattributable proposals", () => {
    const store = new MemoryStore();
    const bot = addBot(store, "Scout");
    const service = new ModelRequestService({ store });
    expect(() => service.propose({ botId: bot.id, threadId: bot.threadId, selection: { instanceId: "claude", model: "sonnet" }, reason: "asked" }))
      .toThrow("Nothing would change");
    expect(() => service.propose({ botId: bot.id, threadId: bot.threadId, selection: { instanceId: "claude" }, reason: "asked" }))
      .toThrow("model_selection.model is required");
    expect(() => service.propose({ botId: bot.id, threadId: bot.threadId, selection: { instanceId: "claude", model: "opus" }, reason: "   " }))
      .toThrow("reason is required");
    expect(() => service.propose({ botId: "ghost", threadId: bot.threadId, selection: { instanceId: "claude", model: "opus" }, reason: "asked" }))
      .toThrow("That bot no longer exists");
    expect(store.threads.size).toBe(0);
  });
});
