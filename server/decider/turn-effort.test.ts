import { describe, expect, it, vi } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { createDecider, deciderAccount } from "./index.ts";
import type { Decider } from "./index.ts";
import {
  autoEffortEligible, decideTurnEffort, priorTurnUsedTools, resolveTurnEffort, turnEffortLevels, turnEffortMessage, TURN_EFFORT_TIMEOUT_MS,
} from "./turn-effort.ts";

const levels = ["low", "medium", "high"] as const;
const signals = { text: "arruma o login", attachments: 0, priorTurnUsedTools: false };
const config = { decider: { enabled: true, key: "tsk_test" } };
const answer = (choice = "high", pTop = 0.95) => ({ ok: true as const, provider: "jev" as const, latencyMs: 1,
  answers: { type: "choice" as const, choice, pTop, margin: 0.9, probabilities: { [choice]: pTop } } });
const mockDecider = (result: ReturnType<typeof answer> = answer()) => ({ choose: vi.fn().mockResolvedValue(result) }) as unknown as Pick<Decider, "choose">;
const instance = (effortLevels = ["low", "medium", "high", "max"]) => ({
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  adapter: { capabilities: { effortLevels } },
}) as unknown as ProviderInstance;

describe("automatic turn effort", () => {
  it("is eligible only while the bot or thread names no effort or variant, and the model offers a choice", () => {
    expect(autoEffortEligible({}, levels)).toBe(true);
    expect(autoEffortEligible({ effort: "high" }, levels)).toBe(false);
    expect(autoEffortEligible({ variant: "thinking" }, levels)).toBe(false);
    expect(autoEffortEligible({}, [])).toBe(false);
    expect(autoEffortEligible({}, undefined)).toBe(false);
  });

  it("sends the message, attachments and previous tool use, bounded, and honors the chosen level", async () => {
    const decider = mockDecider();
    const text = "x".repeat(9_000);
    expect(await decideTurnEffort(decider, { text, attachments: 2, priorTurnUsedTools: true }, levels)).toBe("high");
    expect(decider.choose).toHaveBeenCalledWith("turnEffort", {
      message: "x".repeat(8_000), attachments: 2, priorTurnUsedTools: true, effortLevels: levels,
    }, expect.any(Object), { timeoutMs: TURN_EFFORT_TIMEOUT_MS, signal: undefined });
  });

  it.each(["arruma o login", "исправь вход", "fix the login"])("passes the message through without an English classifier: %s", async (text) => {
    const decider = mockDecider();
    expect(await decideTurnEffort(decider, { ...signals, text }, levels)).toBe("high");
    expect(decider.choose).toHaveBeenCalledWith("turnEffort", expect.objectContaining({ message: text }), expect.any(Object), expect.any(Object));
  });

  it.each([answer("high", 0.79), answer("high", Number.NaN), answer("bogus")])("falls back to no effort on an uncertain or invalid choice", async (result) => {
    expect(await decideTurnEffort(mockDecider(result), signals, levels)).toBeUndefined();
  });

  it("answers a single offered level without calling the helper", async () => {
    const decider = mockDecider();
    expect(await decideTurnEffort(decider, signals, ["high"])).toBe("high");
    expect(await decideTurnEffort(decider, signals, [])).toBeUndefined();
    expect(decider.choose).not.toHaveBeenCalled();
  });

  it("falls back on an error, and never applies an answer that arrives after a stop", async () => {
    expect(await decideTurnEffort({ choose: vi.fn().mockRejectedValue(new Error("offline")) } as unknown as Decider, signals, levels)).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    const choose = mockDecider();
    expect(await decideTurnEffort(choose, signals, levels, controller.signal)).toBeUndefined();
    expect(choose.choose).not.toHaveBeenCalled();
    const late = new AbortController();
    const chosen = { choose: vi.fn(async () => { late.abort(); return answer(); }) };
    expect(await decideTurnEffort(chosen as unknown as Decider, signals, levels, late.signal)).toBeUndefined();
  });

  it("never sends an attachment's local path to the decision model", () => {
    const raw = 'Plan this <attached-file path="/Users/me/secret/client.pdf" name="client.pdf" /> and look at <attached-image path="/tmp/a b.png" name="a b.png" />';
    expect(turnEffortMessage(raw)).toEqual({ text: "Plan this and look at", attachments: 2 });
    expect(JSON.stringify(turnEffortMessage(raw))).not.toContain("/Users/");
    expect(turnEffortMessage("nothing attached")).toEqual({ text: "nothing attached", attachments: 0 });
  });

  it("reads only the previous turn's tools, ignoring the ask being answered", () => {
    const path = [
      { id: "one", role: "user" as const, kind: "text" as const },
      { id: "tool", role: "bot" as const, kind: "activity" as const },
      { id: "two", role: "user" as const, kind: "text" as const },
    ];
    expect(priorTurnUsedTools(path, "two")).toBe(true);
    expect(priorTurnUsedTools(path)).toBe(false);
    expect(priorTurnUsedTools(path.slice(0, 2), "tool")).toBe(false);
  });

  it("offers only the model's own levels and stays off for a fixed effort or no own key", () => {
    const bot = { model: "limited" };
    const limited = { models: { default: "limited", options: [{ id: "limited", label: "Limited", effortLevels: ["low", "high"] }] }, adapter: { capabilities: { effortLevels: ["low", "medium", "high", "max"] } } } as unknown as ProviderInstance;
    expect(turnEffortLevels(config, bot, limited)).toEqual(["low", "high"]);
    expect(turnEffortLevels(config, { ...bot, effort: "high" as const }, limited)).toBeUndefined();
    expect(turnEffortLevels({ decider: { enabled: true } }, bot, limited)).toBeUndefined();
    expect(turnEffortLevels(config, bot, instance())).toEqual(["low", "medium", "high", "max"]);
  });

  it("stays off for Cloud's included decisions, which the relay does not accept", () => {
    vi.stubEnv("OMB_CLOUD_DECIDER_URL", "https://cloud.example.test/api/cloud/services/decider");
    vi.stubEnv("OMB_CLOUD_DECIDER_TOKEN", "included-token");
    try {
      expect(deciderAccount({}, "turnEffort")).toBeNull();
      expect(turnEffortLevels({}, { model: "m" }, instance())).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
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

  it("resolves an eligible turn and leaves a fixed effort alone", async () => {
    const decider = mockDecider();
    expect(await resolveTurnEffort(config, decider, { model: "m" }, instance(), { text: "plan the migration", attachments: 1, priorTurnUsedTools: false })).toBe("high");
    expect(await resolveTurnEffort(config, decider, { model: "m", effort: "low" }, instance(), { text: "hi", attachments: 0, priorTurnUsedTools: false })).toBeUndefined();
  });
});
