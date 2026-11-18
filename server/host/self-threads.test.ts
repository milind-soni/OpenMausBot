import { describe, expect, it } from "vitest";
import { SELF_THREAD_REFUSAL, selfThreadRefusal } from "./self-threads.ts";

describe("selfThreadRefusal", () => {
  it("lets a person's own request, or a routine's, open threads on the bot", () => {
    expect(selfThreadRefusal({ handoff: false, requestLine: {} })).toBeUndefined();
    expect(selfThreadRefusal({ handoff: false, requestLine: undefined })).toBeUndefined();
  });

  it("refuses a teammate's hand-off, and a thread the bot opened on itself", () => {
    expect(selfThreadRefusal({ handoff: true, requestLine: {} })).toBe(SELF_THREAD_REFUSAL);
    expect(selfThreadRefusal({ handoff: false, requestLine: { peerAsk: { botId: "post" } } })).toBe(SELF_THREAD_REFUSAL);
  });
});
