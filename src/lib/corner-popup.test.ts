import { describe, expect, it } from "vitest";
import type { AppState } from "@/state/store";
import { firstReplyPending } from "./corner-popup";

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
