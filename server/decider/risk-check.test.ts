import { describe, expect, it, vi } from "vitest";

import type { Decider } from "./index.ts";
import { RISK_CHECK } from "./jobs.ts";
import { RELAY_MAX_STATE_BYTES, relayAccepts } from "./relay.ts";
import { RISK_HOLD_MIN_PROBABILITY, decideRiskHold, riskCheckRequest, riskCheckSkips, type RiskCheckInput } from "./risk-check.ts";
import type { DeciderResult, ScoreAnswer } from "./types.ts";

const INPUT: RiskCheckInput = {
  tool: "Bash",
  summary: "git push --force origin main",
  command: "git push --force origin main",
  input: '{"command":"git push --force origin main"}',
  task: "Tidy up the release branch",
};

type Score = Decider["score"];

function answering(result: DeciderResult<ScoreAnswer>) {
  const score = vi.fn(async () => result) as unknown as Score & ReturnType<typeof vi.fn>;
  return { score };
}

const scored = (probabilities: number[]): DeciderResult<ScoreAnswer> => ({
  ok: true, provider: "jev", latencyMs: 300,
  answers: { type: "score", score: probabilities.reduce((sum, p, i) => sum + p * i, 0), level: probabilities.indexOf(Math.max(...probabilities)), probabilities },
});

describe("risk check request", () => {
  it("asks the contract's exact question with only its state keys", () => {
    const { state, question } = riskCheckRequest(INPUT);
    expect(question).toEqual({ instructions: RISK_CHECK.instructions, levels: [...RISK_CHECK.levels!] });
    expect(state).toEqual({
      action: { tool: "Bash", summary: "git push --force origin main", command: "git push --force origin main", input: '{"command":"git push --force origin main"}' },
      task: "Tidy up the release branch",
    });
    expect(Object.keys(state).every((key) => RISK_CHECK.stateKeys.includes(key))).toBe(true);
    expect(relayAccepts("riskCheck", state, { answer: { type: "score", ...question } })).toBe(true);
  });

  it("leaves out what the request does not carry", () => {
    const { state } = riskCheckRequest({ tool: "mcp__composio__GMAIL_SEND_EMAIL", summary: "Send email to team@example.com" });
    expect(state).toEqual({ action: { tool: "mcp__composio__GMAIL_SEND_EMAIL", summary: "Send email to team@example.com" } });
  });

  it("a huge command, input and title still fit the relay's caps", () => {
    const { state, question } = riskCheckRequest({
      tool: "t".repeat(5_000),
      summary: "s".repeat(20_000),
      command: `${"curl -X POST https://example.com/api -d @payload.json\n".repeat(2_000)}`,
      input: JSON.stringify({ files: Array.from({ length: 500 }, (_, i) => ({ path: `src/${i}.ts`, content: "x".repeat(400) })) }),
      task: "é".repeat(10_000),
    });
    expect(state.action.command!.length).toBeLessThanOrEqual(2_000);
    expect(state.action.input!.length).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(RELAY_MAX_STATE_BYTES);
    expect(relayAccepts("riskCheck", state, { answer: { type: "score", ...question } })).toBe(true);
  });
});

describe("riskCheckSkips", () => {
  it("skips only reviewed read-only agent tools, by exact name or under the agents prefix", () => {
    expect(riskCheckSkips("list_bots")).toBe(true);
    expect(riskCheckSkips("mcp__agents__session_search")).toBe(true);
    for (const tool of ["Bash", "Read", "mcp__agents__ask_bot", "mcp__other__list_bots", "LIST_BOTS", "delete_bot"]) {
      expect(riskCheckSkips(tool), tool).toBe(false);
    }
  });
});

describe("decideRiskHold", () => {
  it(`holds on High at ${RISK_HOLD_MIN_PROBABILITY} or above`, async () => {
    const decider = answering(scored([0.05, 0.1, 0.85]));
    await expect(decideRiskHold(decider, INPUT)).resolves.toEqual({ hold: true, probability: 0.85 });
    expect(decider.score).toHaveBeenCalledWith("riskCheck", expect.any(Object), expect.any(Object), { timeoutMs: RISK_CHECK.timeoutMs });
    await expect(decideRiskHold(answering(scored([0.1, 0.3, 0.6])), INPUT)).resolves.toMatchObject({ hold: true });
  });

  it("approves when High is less sure, even if it is the likeliest level", async () => {
    await expect(decideRiskHold(answering(scored([0.2, 0.21, 0.59])), INPUT)).resolves.toEqual({ hold: false, reason: "low_risk" });
    await expect(decideRiskHold(answering(scored([0.9, 0.08, 0.02])), INPUT)).resolves.toEqual({ hold: false, reason: "low_risk" });
    // a confident Medium is not a hold: only High is
    await expect(decideRiskHold(answering(scored([0.05, 0.9, 0.05])), INPUT)).resolves.toEqual({ hold: false, reason: "low_risk" });
  });

  it("any decider failure approves as today", async () => {
    for (const reason of ["timeout", "overloaded", "malformed", "disabled", "rate_limited"] as const) {
      await expect(decideRiskHold(answering({ ok: false, reason }), INPUT)).resolves.toEqual({ hold: false, reason });
    }
  });

  it("an odd answer approves as today", async () => {
    await expect(decideRiskHold(answering(scored([0.5, 0.5])), INPUT)).resolves.toEqual({ hold: false, reason: "malformed" });
    await expect(decideRiskHold(answering(scored([0.1, 0.1, Number.NaN])), INPUT)).resolves.toEqual({ hold: false, reason: "malformed" });
    const odd = { ok: true, provider: "jev", latencyMs: 1, answers: { type: "score", score: 2, level: 2 } } as unknown as DeciderResult<ScoreAnswer>;
    await expect(decideRiskHold(answering(odd), INPUT)).resolves.toEqual({ hold: false, reason: "malformed" });
  });

  it("a decider that throws still approves as today", async () => {
    const score = vi.fn(async () => { throw new Error("boom"); }) as unknown as Score;
    await expect(decideRiskHold({ score }, INPUT)).resolves.toEqual({ hold: false, reason: "malformed" });
  });

  it("never asks about a reviewed read-only tool", async () => {
    const decider = answering(scored([0, 0, 1]));
    await expect(decideRiskHold(decider, { ...INPUT, tool: "mcp__agents__list_bots" })).resolves.toEqual({ hold: false, reason: "read_only" });
    expect(decider.score).not.toHaveBeenCalled();
  });
});
