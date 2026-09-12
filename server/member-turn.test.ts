import { describe, expect, it } from "vitest";

import { memberTurnSelection, roomSpeakerSelection } from "./member-turn.ts";

describe("memberTurnSelection", () => {
  it("carries the picker model so a room turn injects the same host as 1:1", () => {
    expect(
      memberTurnSelection({ instanceId: "hermes", model: "omlx::gemma-4-31b-it-bf16" }),
    ).toEqual({ model: "omlx::gemma-4-31b-it-bf16" });
  });

  it("keeps a configured effort", () => {
    expect(
      memberTurnSelection({ instanceId: "qwen", model: "omlx::gemma-4-31b-it-bf16", effort: "high" }),
    ).toEqual({ model: "omlx::gemma-4-31b-it-bf16", effort: "high" });
  });
});

describe("roomSpeakerSelection", () => {
  const bot = {
    id: "kiwi",
    threadId: "direct",
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
  };

  it("uses the visible 1:1 picker, not the bot default for new threads", () => {
    expect(
      roomSpeakerSelection(bot, (id, threadId) =>
        id === "kiwi" && threadId === "direct"
          ? { modelSelection: { instanceId: "grok", model: "grok-4.6", effort: "high" } }
          : null,
      ),
    ).toEqual({ instanceId: "grok", model: "grok-4.6", effort: "high" });
  });

  it("falls back to the bot default when the 1:1 thread has no snapshot", () => {
    expect(roomSpeakerSelection(bot, () => null)).toEqual(bot.modelSelection);
  });
});
