import { describe, expect, it } from "vitest";

import { Store } from "../store.ts";
import { tellTurnedBackOn } from "./routines-turned-back-on.ts";

describe("routines turned back on after an earlier version switched them off", () => {
  it("are named in one quiet line per bot, in that bot's own chat: no card, nothing to answer", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const ada = store.createBot({ name: "Ada" }), ben = store.createBot({ name: "Ben" }), idle = store.createBot({ name: "Idle" });
    tellTurnedBackOn(store, [{ botId: ada.id, name: "Fix new bugs" }, { botId: ben.id, name: "Morning check" }, { botId: ada.id, name: "Triage inbox" }, { botId: "gone", name: "Orphan" }]);
    const lines = (threadId: string) => store.messagesFor(threadId).filter((row) => row.kind === "activity").map((row) => [row.kind, row.tool?.name, row.card]);
    expect(lines(ada.threadId)).toEqual([["activity", "notice: Turned back on: Fix new bugs, Triage inbox. An earlier version switched them off after their cloud desktops failed to start.", undefined]]);
    expect(lines(ben.threadId)).toEqual([["activity", "notice: Turned back on: Morning check. An earlier version switched it off after its cloud desktop failed to start.", undefined]]);
    expect(lines(idle.threadId)).toEqual([]);
  });

  it("say nothing when nothing was turned back on", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const ada = store.createBot({ name: "Ada" });
    const before = store.messagesFor(ada.threadId).length;
    tellTurnedBackOn(store, []);
    expect(store.messagesFor(ada.threadId)).toHaveLength(before);
  });
});
