// Quota-switch card lifecycle, mirroring peer-approval.test.ts: a real
// Store (so message/task/bot writes go through the genuine code paths) with
// a fake instance registry and a spy dispatch standing in for
// server/index.ts's startTurn.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection, ProviderSnapshot } from "./contracts.ts";
import { closeMessageDb } from "./message-db.ts";
import {
  maybeRaiseQuotaCard,
  resolveQuotaSwitch,
  type QuotaSwitchDeps,
  type QuotaSwitchInstance,
} from "./quota-switch.ts";
import { Store, type BotRecord } from "./store.ts";

const defaultSelection = (): ModelSelection => ({ instanceId: "claude", model: "claude-default" });

function fakeInstance(
  instanceId: string,
  driverKind: string,
  displayName: string,
  overrides: Partial<QuotaSwitchInstance> = {},
): QuotaSwitchInstance {
  return {
    instanceId,
    driverKind,
    displayName,
    models: { default: `${instanceId}-default`, options: [{ id: `${instanceId}-default`, label: "Default" }] },
    adapter: { capabilities: {} },
    snapshot: async () => ({ state: "available", authenticated: true }) satisfies ProviderSnapshot,
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function pendingQuotaCard(store: Store, threadId: string) {
  return store
    .messagesFor(threadId)
    .find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed);
}

describe("quota-switch card lifecycle", () => {
  let store: Store;
  let bot: BotRecord;
  let dispatch: ReturnType<typeof vi.fn<(botId: string, threadId: string, text: string) => void>>;
  let deps: QuotaSwitchDeps;
  let instances: QuotaSwitchInstance[];

  beforeEach(() => {
    store = new Store(defaultSelection);
    bot = store.patchBot(store.createBot().id, { name: "Wren", modelSelection: { instanceId: "claude", model: "claude-default" } })!;
    store.patchTask(bot.id, bot.threadId, { modelSelection: { instanceId: "claude", model: "claude-default" } });
    instances = [
      fakeInstance("claude", "claudeAgent", "Claude"),
      fakeInstance("codex", "codex", "Codex"),
      fakeInstance("grok", "grok", "Grok"),
    ];
    dispatch = vi.fn<(botId: string, threadId: string, text: string) => void>();
    deps = { store, instances: () => instances, dispatch };
  });

  afterEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  /** appends the user message a failing turn was answering to, and returns
   * its id — the raise-time capture quota-switch relies on. */
  function appendFailingUserMessage(text: string): string {
    return store.appendMessage(bot.threadId, { role: "user", kind: "text", text }).id;
  }

  it("raises a card offering the other configured engines, and not the current one", async () => {
    const card = await maybeRaiseQuotaCard(deps, bot, bot.threadId, "402 quota exceeded, upgrade your billing plan", undefined);
    expect(card).toBeTruthy();
    expect(card!.card!.title).toContain("Claude");
    expect(card!.card!.options).toEqual(["Codex", "Grok", "Not now"]);
    expect(card!.card!.fixedOptions).toBe(true);
    expect(pendingQuotaCard(store, bot.threadId)?.id).toBe(card!.id);
  });

  it("caps the offered engines at three plus Not now", async () => {
    instances.push(fakeInstance("pi", "pi", "Pi"), fakeInstance("antigravity", "antigravity", "Antigravity"));
    const card = await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", undefined);
    expect(card!.card!.options).toEqual(["Codex", "Grok", "Pi", "Not now"]);
  });

  it("raises no second card on the same thread while one is already pending", async () => {
    const first = await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", undefined);
    const second = await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", undefined);
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(
      store.messagesFor(bot.threadId).filter((m) => m.kind === "options" && m.card?.requestId).length,
    ).toBe(1);
  });

  it("raises no card for a non-quota runtime error", async () => {
    const card = await maybeRaiseQuotaCard(deps, bot, bot.threadId, "500 internal server error", undefined);
    expect(card).toBeNull();
    expect(pendingQuotaCard(store, bot.threadId)).toBeUndefined();
  });

  it("raises no card when no alternatives are configured", async () => {
    instances = [fakeInstance("claude", "claudeAgent", "Claude")];
    const card = await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", undefined);
    expect(card).toBeNull();
  });

  // Finding 1: availability must gate what is OFFERED, not only what
  // happens when it is picked.
  it("never offers an engine that is unavailable when the card is built", async () => {
    instances[1] = fakeInstance("codex", "codex", "Codex", {
      snapshot: async () => ({ state: "unavailable", reason: "signed out" }) satisfies ProviderSnapshot,
    });
    const card = await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", undefined);
    expect(card!.card!.options).toEqual(["Grok", "Not now"]);
  });

  it("raises no card when every alternative is unavailable", async () => {
    instances[1] = fakeInstance("codex", "codex", "Codex", { snapshot: async () => ({ state: "unavailable" }) });
    instances[2] = fakeInstance("grok", "grok", "Grok", { snapshot: async () => ({ state: "unavailable" }) });
    const card = await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", undefined);
    expect(card).toBeNull();
  });

  it("choosing an engine switches the bot's modelSelection and re-dispatches the exact message that failed", async () => {
    const failedId = appendFailingUserMessage("how's the weather");
    const card = (await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", failedId))!;

    expect(resolveQuotaSwitch(deps, card.card!.requestId!, "Codex")).toBe(true);
    await flush();

    expect(store.bot(bot.id)?.modelSelection).toEqual({ instanceId: "codex", model: "codex-default" });
    expect(dispatch).toHaveBeenCalledWith(bot.id, bot.threadId, "how's the weather");

    const settled = store.messagesFor(bot.threadId).find((m) => m.id === card.id);
    expect(settled?.card?.answered).toBeTruthy();
    expect(settled?.card?.answeredText).toBe("Codex");

    const chip = store.messagesFor(bot.threadId).find((m) => m.kind === "activity" && m.tool?.name.includes("Codex"));
    expect(chip).toBeTruthy();
  });

  // Finding 3: an image-only original (its caption-less text still carries
  // the <attached-image> transport tag) must resend, tag and all.
  it("re-dispatches an image-only original message, tag and all", async () => {
    const failedId = appendFailingUserMessage('<attached-image path="/tmp/x.png" name="x.png"/>');
    const card = (await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", failedId))!;

    resolveQuotaSwitch(deps, card.card!.requestId!, "Codex");
    await flush();

    expect(dispatch).toHaveBeenCalledWith(bot.id, bot.threadId, '<attached-image path="/tmp/x.png" name="x.png"/>');
  });

  // Finding 3: a newer message sent while the card sat open (the composer
  // stays unblocked) must never be the one that gets resent.
  it("resends the message captured at raise time, not a newer one sent while the card was open", async () => {
    const failedId = appendFailingUserMessage("original question");
    const card = (await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", failedId))!;
    appendFailingUserMessage("a completely different, later message");

    resolveQuotaSwitch(deps, card.card!.requestId!, "Codex");
    await flush();

    expect(dispatch).toHaveBeenCalledWith(bot.id, bot.threadId, "original question");
  });

  // Finding 3: the message is gone by the time the person answers — settle
  // quietly, but say so instead of resending nothing.
  it("when the original message can no longer be found, posts no 'continuing' chip and says so instead", async () => {
    const failedId = appendFailingUserMessage("will be deleted");
    const card = (await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", failedId))!;
    store.patchMessage(bot.threadId, failedId, { text: "" }); // stand-in for "gone"

    resolveQuotaSwitch(deps, card.card!.requestId!, "Codex");
    await flush();

    expect(dispatch).not.toHaveBeenCalled();
    const continuing = store.messagesFor(bot.threadId).find((m) => m.kind === "activity" && m.tool?.name.startsWith("continuing on"));
    expect(continuing).toBeUndefined();
    const notice = store.messagesFor(bot.threadId).find((m) => m.kind === "activity" && m.tool?.name.includes("could not be found to resend"));
    expect(notice).toBeTruthy();
    expect(notice?.tool?.ok).toBe(false);
  });

  it("raises no chip and dispatches nothing when there was no user message to capture", async () => {
    const card = (await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", undefined))!;

    resolveQuotaSwitch(deps, card.card!.requestId!, "Codex");
    await flush();

    expect(dispatch).not.toHaveBeenCalled();
    expect(store.bot(bot.id)?.modelSelection).toEqual({ instanceId: "codex", model: "codex-default" });
  });

  // Finding 1's second line of defence: state can change while the card
  // sits open. Its failure must be visible (a chip), not silent.
  it("does not switch when the chosen engine goes unavailable between raise and answer, and says so", async () => {
    const failedId = appendFailingUserMessage("hi");
    const card = (await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", failedId))!;
    // Codex was available when the card was built; it drops offline before
    // the person answers.
    instances[1] = fakeInstance("codex", "codex", "Codex", {
      snapshot: async () => ({ state: "unavailable", reason: "signed out" }) satisfies ProviderSnapshot,
    });

    resolveQuotaSwitch(deps, card.card!.requestId!, "Codex");
    await flush();

    expect(store.bot(bot.id)?.modelSelection).toEqual({ instanceId: "claude", model: "claude-default" });
    expect(dispatch).not.toHaveBeenCalled();
    const notice = store.messagesFor(bot.threadId).find((m) => m.kind === "activity" && m.tool?.name.includes("no longer available"));
    expect(notice).toBeTruthy();
    expect(notice?.tool?.ok).toBe(false);
  });

  it("'Not now' settles the card, leaves modelSelection untouched, and dispatches nothing", async () => {
    const failedId = appendFailingUserMessage("hi");
    const card = (await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", failedId))!;

    expect(resolveQuotaSwitch(deps, card.card!.requestId!, "Not now")).toBe(true);
    await flush();

    const settled = store.messagesFor(bot.threadId).find((m) => m.id === card.id);
    expect(settled?.card?.answered).toBeTruthy();
    expect(settled?.card?.answeredText).toBe("Not now");
    expect(store.bot(bot.id)?.modelSelection).toEqual({ instanceId: "claude", model: "claude-default" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  // Finding 2 (server side): an answer naming none of the offered engines
  // — including free text reaching the endpoint directly — is exactly
  // "Not now", never a switch.
  it("treats an answer that names none of the offered engines exactly like 'Not now'", async () => {
    const failedId = appendFailingUserMessage("hi");
    const card = (await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", failedId))!;

    expect(resolveQuotaSwitch(deps, card.card!.requestId!, "some free text")).toBe(true);
    await flush();

    expect(store.bot(bot.id)?.modelSelection).toEqual({ instanceId: "claude", model: "claude-default" });
    expect(dispatch).not.toHaveBeenCalled();
    const settled = store.messagesFor(bot.threadId).find((m) => m.id === card.id);
    expect(settled?.card?.answeredText).toBe("Not now");
  });

  it("frees the thread for a new card once the pending one is resolved", async () => {
    const first = (await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", undefined))!;
    resolveQuotaSwitch(deps, first.card!.requestId!, "Not now");
    const second = await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", undefined);
    expect(second).toBeTruthy();
  });

  it("answers an unknown requestId as not-ours, so provider and peer cards still route", () => {
    expect(resolveQuotaSwitch(deps, "not-a-quota-request", "Codex")).toBe(false);
  });

  // Small fix: a deleted bot's patchBot returns null — must not orphan a
  // chip into a thread nobody owns any more.
  it("writes no chip when the bot was deleted before the switch could land", async () => {
    const failedId = appendFailingUserMessage("hi");
    const card = (await maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded", failedId))!;
    const threadId = bot.threadId;
    store.deleteBot(bot.id);

    resolveQuotaSwitch(deps, card.card!.requestId!, "Codex");
    await flush();

    expect(dispatch).not.toHaveBeenCalled();
    expect(store.messagesFor(threadId)).toEqual([]);
  });
});
