import { describe, expect, it } from "vitest";

import { voiceKeyDraftValue } from "./voice-key-draft";

describe("voice credential drafts", () => {
  it("hides an unsaved key when another client changes providers", () => {
    const draft = { provider: "elevenlabs" as const, value: "eleven-secret" };

    expect(voiceKeyDraftValue(draft, "elevenlabs")).toBe("eleven-secret");
    expect(voiceKeyDraftValue(draft, "fish")).toBe("");
  });
});
