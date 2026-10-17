import { describe, expect, it, vi } from "vitest";

import { tieAutomationsToBots } from "./bot-automations.ts";

function fixture(bots: string[], owners: { routines?: string[]; runs?: string[]; webhooks?: string[] }) {
  let listener: ((change: { type: string; botId?: string }) => void) | undefined;
  const store = {
    bots: bots.map((id) => ({ id })),
    bot: (id: string) => bots.includes(id) ? { id } : undefined,
    onChange: (next: typeof listener) => { listener = next; },
  };
  const automations = {
    routines: {
      removeForBot: vi.fn(), listRoutines: () => (owners.routines ?? []).map((botId) => ({ botId })), listRuns: () => (owners.runs ?? []).map((botId) => ({ botId })),
    },
    webhooks: { removeForBot: vi.fn(), list: () => (owners.webhooks ?? []).map((botId) => ({ botId })) },
  };
  tieAutomationsToBots(store, automations as never);
  return { automations, emit: (change: { type: string; botId?: string }) => listener!(change) };
}

describe("a bot's automations live and die with it", () => {
  it("removes, at start, the automations of each bot that no longer exists, once per bot", () => {
    const { automations } = fixture(["scout"], { routines: ["scout", "gone"], runs: ["gone", "older"], webhooks: ["gone"] });
    expect(automations.routines.removeForBot.mock.calls).toEqual([["gone"], ["older"]]);
    expect(automations.webhooks.removeForBot.mock.calls).toEqual([["gone"], ["older"]]);
  });

  it("removes nothing at start when no bot loaded at all, so an unreadable bot list never wipes every automation", () => {
    const { automations } = fixture([], { routines: ["scout"], webhooks: ["scout"] });
    expect(automations.routines.removeForBot).not.toHaveBeenCalled();
    expect(automations.webhooks.removeForBot).not.toHaveBeenCalled();
  });

  it("removes a bot's automations whenever the store deletes it, and one failed removal never blocks the other", () => {
    const { automations, emit } = fixture(["scout"], {});
    automations.routines.removeForBot.mockImplementation(() => { throw new Error("disk full"); });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    emit({ type: "bot", botId: "scout" });
    emit({ type: "bot.deleted", botId: "scout" });
    expect(automations.routines.removeForBot).toHaveBeenCalledWith("scout");
    expect(automations.webhooks.removeForBot).toHaveBeenCalledWith("scout");
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
