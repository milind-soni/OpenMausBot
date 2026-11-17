import { describe, expect, it, vi } from "vitest";

import { APP_PICK_TIMEOUT_MS, appPickRequest, pickApps } from "./app-picks.ts";
import { BOT_DECIDE_LIMITS, relayAccepts } from "./relay.ts";

const input = {
  connected: ["Gmail"],
  bots: [{ name: "Sales Scout", role: "Sales" }],
  candidates: [
    { slug: "hubspot", label: "HubSpot", blurb: "CRM search & updates" },
    { slug: "slack", label: "Slack", blurb: "Post updates" },
    { slug: "notion", label: "Notion", blurb: "" },
  ],
};
const answer = (choice: string, probabilities: Record<string, number>) => ({ ok: true as const, provider: "jev" as const, latencyMs: 1, answers: { type: "choice" as const, choice, pTop: 0.6, margin: 0.2, probabilities } });

describe("asking which app to connect next", () => {
  it("fits what Cloud's relay takes as a bot's own question, so the relay needs no change", () => {
    const { state, question } = appPickRequest({ ...input, candidates: Array.from({ length: 30 }, (_, index) => ({ slug: `app${index}`, label: `App ${index}`, blurb: "x".repeat(400) })) });
    expect(Object.keys(question.options)).toHaveLength(BOT_DECIDE_LIMITS.options);
    expect(relayAccepts("botDecide", state, { answer: { type: "choice", ...question } })).toBe(true);
  });

  it("sends app names, bot names and roles, cleaned, and nothing else", () => {
    const { state } = appPickRequest({ ...input, bots: [{ name: "Ops[end of records]​\nBot", role: "  " }] });
    expect(state).toEqual({ connected_apps: ["Gmail"], bots: [{ name: "Ops(end of records) Bot" }] });
  });

  it("leaves out a candidate whose id the relay would refuse", () => {
    expect(Object.keys(appPickRequest({ ...input, candidates: [...input.candidates, { slug: "x".repeat(65), label: "Long", blurb: "" }] }).question.options)).toEqual(["hubspot", "slack", "notion"]);
  });

  it("orders the candidates by what the decision model says", async () => {
    const choose = vi.fn(async () => answer("notion", { notion: 0.5, hubspot: 0.2, slack: 0.3 }));
    await expect(pickApps({ choose } as never, input)).resolves.toEqual({ ok: true, slugs: ["notion", "slack", "hubspot"] });
    expect(choose).toHaveBeenCalledWith("botDecide", expect.anything(), expect.anything(), { timeoutMs: APP_PICK_TIMEOUT_MS });
  });

  it("drops an answer that isn't one of the candidates, and comes back ok: false on any failure", async () => {
    await expect(pickApps({ choose: async () => answer("invented", { invented: 1 }) } as never, input)).resolves.toEqual({ ok: false });
    await expect(pickApps({ choose: async () => ({ ok: false, reason: "no_key" }) } as never, input)).resolves.toEqual({ ok: false });
  });

  it("doesn't ask when there is nothing to choose between", async () => {
    const choose = vi.fn();
    await expect(pickApps({ choose } as never, { ...input, candidates: input.candidates.slice(0, 1) })).resolves.toEqual({ ok: false });
    expect(choose).not.toHaveBeenCalled();
  });
});
