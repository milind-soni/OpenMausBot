import { describe, expect, it } from "vitest";
import type { AppState } from "@/state/store";
import { firstChatQuiet, firstReplyPending } from "./corner-popup";
import { EMPTY_ONBOARDING, MET_CHIEF_HINT } from "./onboarding";

const state = (bots: unknown[], groups: unknown[] = [], hydrated = true) =>
  ({ bots, groups, ...(hydrated ? { hydrated: true } : {}) }) as unknown as Pick<AppState, "bots" | "groups" | "hydrated">;

describe("firstReplyPending", () => {
  it("holds while no bot or room has finished a turn", () => {
    expect(firstReplyPending(state([]))).toBe(true);
    expect(firstReplyPending(state([{ tasks: [] }, { tasks: [{ threadId: "t", usage: { turns: 0 } }] }], [{ usage: null }]))).toBe(true);
  });

  it("does not know before the first snapshot, when no bot is loaded yet", () => {
    expect(firstReplyPending(state([], [], false))).toBeNull();
    expect(firstReplyPending(state([{ tasks: [{ threadId: "a", usage: { turns: 3 } }] }], [], false))).toBeNull();
  });

  it("lets go once a bot or a room has answered", () => {
    expect(firstReplyPending(state([{ tasks: [{ threadId: "a" }, { threadId: "b", usage: { turns: 1 } }] }]))).toBe(false);
    expect(firstReplyPending(state([{ tasks: [] }], [{ usage: { turns: 2 } }]))).toBe(false);
  });
});

describe("firstChatQuiet", () => {
  const met = { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-10-27T00:00:00.000Z", version: 1, hintsSeen: [MET_CHIEF_HINT] } };
  const withConfig = (config: unknown, bots: unknown[], hydrated = true) =>
    ({ ...state(bots, [], hydrated), config }) as unknown as Parameters<typeof firstChatQuiet>[0];

  it("keeps the first conversation after meeting the Chief quiet until the person has had a reply", () => {
    expect(firstChatQuiet(withConfig(met, [{ tasks: [{ threadId: "t", usage: { turns: 0 } }] }]))).toBe(true);
    expect(firstChatQuiet(withConfig(met, [], false)), "before the bots load").toBe(true);
    expect(firstChatQuiet(withConfig(met, [{ tasks: [{ threadId: "t", usage: { turns: 1 } }] }]))).toBe(false);
  });

  it("changes nothing for an install that never met the Chief this way", () => {
    expect(firstChatQuiet(withConfig({ onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1 } }, []))).toBe(false);
    expect(firstChatQuiet(withConfig(null, []))).toBe(false);
  });
});
