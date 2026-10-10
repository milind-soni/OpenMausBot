import { describe, expect, it, vi } from "vitest";

import { WATCHER_OPTIONS_CARD_BOT_ID } from "../shared/options-card.ts";
import { createOptionsCard, type OptionsCardStore } from "./options-card.ts";

function watcher() {
  return { id: WATCHER_OPTIONS_CARD_BOT_ID, name: "Watcher", color: "blue" as const };
}

describe("createOptionsCard", () => {
  it("persists a passive legacy options card in the current thread", () => {
    let appendedCard: Record<string, unknown> | undefined;
    const appendMessage: OptionsCardStore["appendMessage"] = vi.fn((_threadId, message) => {
      appendedCard = message.card;
      return { id: "message-1" };
    });
    const result = createOptionsCard({
      store: { appendMessage } satisfies OptionsCardStore,
      bot: watcher(),
      threadId: "thread-watcher",
      input: { title: "Possible match", subtitle: "Choose the next step", options: ["Ignore", "Draft"] },
    });

    expect(result).toEqual({ ok: true, messageId: "message-1" });
    expect(appendMessage).toHaveBeenCalledWith("thread-watcher", {
      role: "bot",
      kind: "options",
      from: { botId: WATCHER_OPTIONS_CARD_BOT_ID, name: "Watcher", color: "blue" },
      card: { title: "Possible match", subtitle: "Choose the next step", options: ["Ignore", "Draft"] },
    });
    expect(appendedCard).not.toHaveProperty("requestId");
    expect(appendedCard).not.toHaveProperty("tool");
  });

  it("refuses every bot except Watcher without writing", () => {
    const appendMessage = vi.fn(() => ({ id: "should-not-exist" }));
    expect(createOptionsCard({
      store: { appendMessage } satisfies OptionsCardStore,
      bot: { ...watcher(), id: "another-bot" },
      threadId: "thread",
      input: { title: "Title", subtitle: "Subtitle", options: ["A", "B"] },
    })).toEqual({ ok: false, status: 403, error: "create_options_card is not enabled for this bot." });
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("refuses malformed cards without writing", () => {
    const appendMessage = vi.fn(() => ({ id: "should-not-exist" }));
    expect(createOptionsCard({
      store: { appendMessage } satisfies OptionsCardStore,
      bot: watcher(),
      threadId: "thread",
      input: { title: "Title", subtitle: "Subtitle", options: ["Only one"] },
    })).toEqual({ ok: false, status: 400, error: "options must contain 2-6 items." });
    expect(appendMessage).not.toHaveBeenCalled();
  });
});
