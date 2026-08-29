import { describe, expect, it } from "vitest";

import { queuedPromptStack } from "./queued-prompts";

describe("queued prompt presentation", () => {
  it("keeps independent queued prompts as ordered rows", () => {
    expect(queuedPromptStack(undefined, [
      { queueId: "q-1", text: "first prompt" },
      { queueId: "q-2", text: "second prompt" },
    ])).toEqual([
      { id: "q-1", text: "first prompt", discardable: false },
      { id: "q-2", text: "second prompt", discardable: false },
    ]);
  });

  it("keeps a room's local queued prompt discardable", () => {
    expect(queuedPromptStack({ text: "room prompt" }, [])).toEqual([
      { id: "room", text: "room prompt", discardable: true },
    ]);
  });
});
