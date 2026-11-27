import { describe, expect, it } from "vitest";

import type { ModelCatalog, SendTurnInput } from "../../contracts.ts";
import { modelRefused, startupRefresh } from "./startup-refresh.ts";

const catalog: ModelCatalog = { default: "gemini-3.8-flash", options: [{ id: "gemini-3.8-flash", label: "Flash" }] };
const turn = (model?: string) => ({ threadId: "t", text: "hello", ...(model ? { model } : {}) }) as SendTurnInput;

describe("whether a saved model list stands in for the startup read", () => {
  const make = (over: Partial<Parameters<typeof startupRefresh>[0]> = {}) => startupRefresh({
    enabled: true, room: () => true, pending: new Promise<void>(() => {}), saved: () => true, catalog: () => catalog, ...over,
  });

  it("only for an engine that opts in, with a saved list, while the read runs, and with room for the read's own process", () => {
    expect(make().standsIn(turn("gemini-3.8-flash"))).toBe(true);
    expect(make().standsIn(turn())).toBe(true);
    expect(make({ enabled: false }).standsIn(turn("gemini-3.8-flash"))).toBe(false);
    expect(make({ saved: () => false }).standsIn(turn("gemini-3.8-flash"))).toBe(false);
    expect(make({ pending: null }).standsIn(turn("gemini-3.8-flash"))).toBe(false);
    // A small Cloud short of room keeps the old order: the read first, then the turn's own process.
    expect(make({ room: () => false }).standsIn(turn("gemini-3.8-flash"))).toBe(false);
  });

  it("not for a model the saved list lacks, unless the driver maps it onto one it has", () => {
    expect(make().standsIn(turn("gemini-4-neon"))).toBe(false);
    const normalize = (input: SendTurnInput) => (input.model === "gemini-3.8-flash-high" ? { ...input, model: "gemini-3.8-flash", variant: "high" } : input);
    expect(make({ normalize }).standsIn(turn("gemini-3.8-flash-high"))).toBe(true);
  });

  it("stops standing in once the read is over, whatever its outcome", async () => {
    let fail!: (error: Error) => void;
    const refresh = make({ pending: new Promise<void>((_resolve, reject) => { fail = reject; }) });
    expect(refresh.pending).toBe(true);
    fail(new Error("offline"));
    await refresh.done();
    expect(refresh.pending).toBe(false);
    expect(refresh.standsIn(turn("gemini-3.8-flash"))).toBe(false);
  });

  it("reads a refusal of the model a turn asked for", () => {
    expect(modelRefused({ code: -32602, message: "Invalid params: model not found: gemini-old" })).toBe(true);
    expect(modelRefused(new Error("Google Gemini (Antigravity) did not switch to gemini-old (still gemini-3.8-flash)"))).toBe(true);
    expect(modelRefused({ code: -32602, message: "Invalid params: sessionId" })).toBe(false);
    expect(modelRefused(new Error("session/new timed out"))).toBe(false);
  });
});
