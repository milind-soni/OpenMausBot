import { describe, expect, it, vi } from "vitest";
import { autoEffortSchema } from "../auto-effort.ts";
import { createDecider, deciderAccount, deciderJobOn, deciderSavePatch, describeDecider } from "./index.ts";
import type { Decider } from "./index.ts";
import type { ProviderInstance } from "../contracts.ts";
import type { Message } from "../store.ts";
import { autoEffortEligible, decideTurnEffort, priorTurnUsedTools, resolveTurnEffort, turnEffortLevels, turnEffortRequest, TURN_EFFORT_TIMEOUT_MS } from "./turn-effort.ts";

const levels = ["low", "medium", "high"] as const;
const signals = { text: "arruma o login", attachments: 0, priorTurnUsedTools: false };
const config = { decider: { enabled: true, key: "tsk_test", jobs: { turnEffort: true } } };
const answer = (choice = "high", pTop = 0.95) => ({ ok: true as const, provider: "jev" as const, latencyMs: 1,
  answers: { type: "choice" as const, choice, pTop, margin: 0.9, probabilities: { [choice]: pTop } } });
const mockDecider = (result = answer()) => ({ choose: vi.fn().mockResolvedValue(result) }) as unknown as Pick<Decider, "choose">;

describe("turn effort", () => {
  it("dispatch resolution respects model restrictions, fixed effort and automation opt-in", async () => {
    const decider = mockDecider();
    const bot = { id: "a", modelSelection: { instanceId: "test", model: "limited" }, autoEffort: { automated: false } };
    const instance = { instanceId: "test", models: { default: "limited", options: [{ id: "limited", label: "Limited", effortLevels: ["low", "high"] }] }, adapter: { capabilities: { effortLevels: ["low", "medium", "high", "max"] } } } as unknown as ProviderInstance;
    const message = { id: "ask", text: "arruma o login" } as Message;
    expect(await resolveTurnEffort(config, decider, bot, instance, [], message, true)).toBeUndefined();
    expect(decider.choose).not.toHaveBeenCalled();
    bot.autoEffort.automated = true;
    expect(await resolveTurnEffort(config, decider, bot, instance, [], message, true)).toBe("high");
    expect(decider.choose).toHaveBeenCalledWith("turnEffort", expect.objectContaining({ effortLevels: ["low", "high"] }), expect.any(Object), expect.any(Object));
    vi.mocked(decider.choose).mockClear();
    expect(await resolveTurnEffort(config, decider, { ...bot, modelSelection: { ...bot.modelSelection, effort: "high" } }, instance, [], message, false)).toBeUndefined();
    instance.models.options[0].effortLevels = [];
    expect(await resolveTurnEffort(config, decider, bot, instance, [], message, false)).toBeUndefined();
    expect(decider.choose).not.toHaveBeenCalled();
  });

  it("applies only to a bot the decider will choose for, so other bots keep quick-model routing", () => {
    const bot = { id: "a", modelSelection: { instanceId: "test", model: "m" }, autoEffort: null };
    const instance = { instanceId: "test", models: { default: "m", options: [{ id: "m", label: "M" }] }, adapter: { capabilities: { effortLevels: ["low", "high"] } } } as unknown as ProviderInstance;
    expect(turnEffortLevels(config, bot, instance, false)).toEqual(["low", "high"]);
    expect(turnEffortLevels(config, { ...bot, modelSelection: { ...bot.modelSelection, effort: "high" } }, instance, false)).toBeUndefined();
    expect(turnEffortLevels({ decider: { ...config.decider, jobs: { turnEffort: false } } }, bot, instance, false)).toBeUndefined();
  });
  it("reads only the previous turn's tools, including when the current ask is already stored", () => {
    const path = [{ id: "one", role: "user", kind: "text" }, { id: "tool", role: "bot", kind: "activity", from: { botId: "a" } }, { id: "two", role: "user", kind: "text" }];
    expect(priorTurnUsedTools(path, "two", "a")).toBe(true);
    expect(priorTurnUsedTools(path, "two", "b")).toBe(false);
    expect(priorTurnUsedTools(path)).toBe(false);
  });

  it("discards a response that arrives after cancellation", async () => {
    const controller = new AbortController();
    const choose = vi.fn(async () => { controller.abort(); return answer(); });
    expect(await decideTurnEffort({ choose } as unknown as Decider, signals, levels, undefined, controller.signal)).toBeUndefined();
  });
  it("starts off and stays off when a key is saved", () => {
    expect(deciderJobOn({}, "turnEffort")).toBe(false);
    expect(deciderSavePatch({ key: "tsk_new" }, undefined)).toMatchObject({ ok: true, patch: { jobs: { roomRouting: true } } });
    expect(describeDecider(config)).toMatchObject({ jobs: { turnEffort: true }, turnEffortConfigured: true });
  });

  it("validates bounds and clearing at the write boundary", () => {
    for (const value of [null, {}, { min: "low", max: "high", automated: true }]) expect(autoEffortSchema.safeParse(value).success).toBe(true);
    for (const value of [{ min: "high", max: "low" }, { max: "bogus" }, { automated: "yes" }, { extra: true }]) expect(autoEffortSchema.safeParse(value).success).toBe(false);
  });

  it("uses Auto only, with separate automation opt-in", () => {
    const selection = { instanceId: "claude", model: "opus" };
    expect(autoEffortEligible(selection, levels, false, null)).toBe(true);
    expect(autoEffortEligible({ ...selection, effort: "high" }, levels, false, null)).toBe(false);
    expect(autoEffortEligible({ ...selection, variant: "thinking" }, levels, false, null)).toBe(false);
    expect(autoEffortEligible(selection, [], false, null)).toBe(false);
    expect(autoEffortEligible(selection, levels, true, null)).toBe(false);
    expect(autoEffortEligible(selection, levels, true, { automated: true })).toBe(true);
  });

  it("bounds the input and intersects limits with supported levels", () => {
    const request = turnEffortRequest({ ...signals, text: "x".repeat(9_000), attachments: 2, priorTurnUsedTools: true }, levels, { min: "medium", max: "xhigh" });
    expect(request.allowed).toEqual(["medium", "high"]);
    expect(request.state).toEqual({ message: "x".repeat(8_000), attachments: 2, priorTurnUsedTools: true, effortLevels: ["medium", "high"] });
  });

  it.each(["arruma o login", "исправь вход", "fix the login"])("passes the message to the model without English classification: %s", async (text) => {
    const decider = mockDecider();
    expect(await decideTurnEffort(decider, { ...signals, text }, levels)).toBe("high");
    expect(decider.choose).toHaveBeenCalledWith("turnEffort", expect.objectContaining({ message: text }), expect.any(Object), { timeoutMs: TURN_EFFORT_TIMEOUT_MS, signal: undefined });
  });

  it.each([answer("high", 0.79), answer("high", NaN), answer("bogus"), answer("max")])("falls back on uncertain or invalid choices", async (result) => {
    expect(await decideTurnEffort(mockDecider(result), signals, levels)).toBeUndefined();
  });

  it("does not call the helper for a singleton or empty range", async () => {
    const decider = mockDecider();
    expect(await decideTurnEffort(decider, signals, levels, { min: "high" })).toBe("high");
    expect(await decideTurnEffort(decider, signals, levels, { min: "max" })).toBeUndefined();
    expect(decider.choose).not.toHaveBeenCalled();
  });

  it("fails safely on errors and cancellation", async () => {
    const choose = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await decideTurnEffort({ choose } as unknown as Decider, signals, levels)).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    choose.mockClear();
    expect(await decideTurnEffort({ choose } as unknown as Decider, signals, levels, undefined, controller.signal)).toBeUndefined();
    expect(choose).not.toHaveBeenCalled();
  });

  it("uses the real provider parser and fails safely on timeout", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ answers: { answer: { type: "choice", choice: "high", probabilities: { low: 0.02, medium: 0.03, high: 0.95 } } } })));
    const decider = createDecider({ config: () => config, fetch });
    expect(await decideTurnEffort(decider, signals, levels)).toBe("high");
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(fetch.mock.calls)).toContain("arruma o login");
    const slow = createDecider({ config: () => config, fetch: (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout")))) });
    expect(await decideTurnEffort(slow, signals, levels)).toBeUndefined();
  });

  it("never uses included Cloud credentials for this new job", () => {
    vi.stubEnv("OMB_CLOUD_DECIDER_URL", "https://cloud.example.test/api/cloud/services/decider");
    vi.stubEnv("OMB_CLOUD_DECIDER_TOKEN", "included-token");
    try {
      expect(deciderAccount({}, "turnEffort")).toBeNull();
      expect(deciderAccount(config, "turnEffort")).toMatchObject({ included: false, provider: "jev" });
    } finally { vi.unstubAllEnvs(); }
  });
});
