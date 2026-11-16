import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CostCaveats } from "./UsageSection";
import { capsToSave, capTone, limitsOf, UsageCapsCard, type CapState, type UsageCapView } from "./UsageCaps";

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: [{ id: "b1", name: "Ada" }, { id: "b2", name: "Bo" }, { id: "b3", name: "Hidden", hidden: true }] }, dispatch: () => {} }),
}));

const cap = (more: Partial<CapState>): CapState => ({ id: "server:day:usd", scope: "server", period: "day", unit: "usd", limit: 10, used: 2, percent: 20, warn: false, reached: false, resetsAt: Date.parse("2026-09-16T00:00:00Z"), ...more });
const view = (more: Partial<UsageCapView> = {}): UsageCapView => ({ stops: "unattended", server: {}, bots: {}, env: { stops: false, server: [] }, caps: [], ...more });
const render = (value: UsageCapView | null | undefined) => renderToStaticMarkup(createElement(UsageCapsCard, { view: value }));

describe("the usage caps card", () => {
  it("is shown to the owner only: without the owner's view there is nothing", () => {
    expect(render(null)).toBe("");
    expect(render(undefined)).toBe("");
  });

  it("says no cap is set, and offers the two choices with unattended work first", () => {
    const markup = render(view());
    expect(markup).toContain("Usage caps");
    expect(markup).toContain("No cap is set, so nothing is stopped.");
    expect(markup).toContain("Unattended work only: routines, webhooks, app events, Bot API calls and hand-offs nobody is waiting on");
    expect(markup).toContain("Everything, including your own messages");
    for (const label of ["Per day (USD)", "Per day (tokens)", "Per month (USD)", "Per month (tokens)"]) expect(markup).toContain(`All bots together: ${label}`);
    expect(markup).toContain("Add a cap for a bot");
    expect(markup).toContain(">Ada</option>");
    expect(markup).not.toContain("Hidden");
    expect(markup).not.toContain("set in this installation’s environment");
  });

  it("shows the use against each cap, quiet below 80%, a line from 80%, and when work starts again once reached", () => {
    const markup = render(view({
      server: { dailyUsd: 10 }, bots: { b1: { monthlyTokens: 2_000_000 } },
      caps: [
        cap({}),
        cap({ id: "server:month:usd", period: "month", limit: 100, used: 81, percent: 81, warn: true }),
        cap({ id: "bot:b1:month:tokens", scope: "bot", botId: "b1", period: "month", unit: "tokens", limit: 2_000_000, used: 2_500_000, percent: 125, warn: true, reached: true }),
      ],
    }));
    expect(markup).toContain("All bots together, today");
    expect(markup).toContain("$2.00 of $10.00 (20%)");
    expect(markup).toContain("All bots together, this month");
    expect(markup).toContain("At 81% of the cap");
    expect(markup).toContain("Ada, this month");
    expect(markup).toContain("2.5M tokens of 2M tokens (125%)");
    expect(markup).toContain("Reached: the work it covers is skipped and starts again");
    expect(markup).toContain('aria-valuenow="100"');
    expect(markup.match(/At \d+% of the cap/g)).toHaveLength(1);
    expect(markup).toContain('value="10"');
    expect(markup).toContain('value="2000000"');
    expect([capTone(cap({})), capTone(cap({ warn: true })), capTone(cap({ warn: true, reached: true }))]).toEqual(["quiet", "warning", "danger"]);
  });

  it("locks what the environment sets and says where it is changed", () => {
    const markup = render(view({ stops: "everything", env: { stops: true, server: ["dailyUsd"] } }));
    expect(markup).toContain("<option value=\"everything\" selected=\"\">");
    expect(markup).toContain("The greyed-out values are set in this installation’s environment and are changed there.");
    expect(markup).toMatch(/<input[^>]*aria-label="All bots together: Per day \(USD\)"[^>]*disabled=""/);
    expect(markup).not.toMatch(/<input[^>]*aria-label="All bots together: Per day \(tokens\)"[^>]*disabled=""/);
  });

  it("shows the value in force in a greyed input, and a save keeps config.json's own values, never the environment's", () => {
    const locked = view({ stops: "everything", savedStops: "unattended", server: { dailyUsd: 4, monthlyUsd: 30 },
      env: { stops: true, server: ["dailyUsd", "dailyTokens"], values: { server: { dailyUsd: 2, dailyTokens: 500 } } } });
    const markup = render(locked);
    expect(markup).toMatch(/<input[^>]*aria-label="All bots together: Per day \(USD\)" disabled=""[^>]*value="2"\/>/);
    expect(markup).toMatch(/<input[^>]*aria-label="All bots together: Per day \(tokens\)" disabled=""[^>]*value="500"\/>/);
    expect(markup).toMatch(/<input[^>]*aria-label="All bots together: Per month \(USD\)" class[^>]*value="30"\/>/);
    // The form holds 2 and 500 from the environment and the owner typed 40 per month: only 40 is theirs to save.
    expect(capsToSave(locked, "everything", { dailyUsd: 2, dailyTokens: 500, monthlyUsd: 40 }, { b1: { dailyUsd: 1 } }))
      .toEqual({ stops: "unattended", server: { dailyUsd: 4, monthlyUsd: 40 }, bots: { b1: { dailyUsd: 1 } } });
    expect(capsToSave(view(), "everything", { dailyUsd: 2 }, {})).toEqual({ stops: "everything", server: { dailyUsd: 2 }, bots: {} });
  });

  it("reads a row of inputs as caps: empty and 0 are no cap, dollars may be fractions, tokens are whole", () => {
    expect(limitsOf({ dailyUsd: "2.5", monthlyUsd: "", dailyTokens: "1,000,000", monthlyTokens: "0" })).toEqual({ dailyUsd: 2.5, dailyTokens: 1_000_000 });
    expect(limitsOf({ dailyUsd: "", monthlyUsd: "", dailyTokens: "", monthlyTokens: "" })).toEqual({});
    for (const bad of [{ dailyUsd: "-1" }, { dailyUsd: "lots" }, { dailyTokens: "1.5" }]) {
      expect(limitsOf({ dailyUsd: "", monthlyUsd: "", dailyTokens: "", monthlyTokens: "", ...bad })).toBeNull();
    }
  });
});

describe("what the period's dollars leave out", () => {
  const render = (summary: Parameters<typeof CostCaveats>[0]["summary"]) => renderToStaticMarkup(createElement(CostCaveats, { summary }));
  it("says nothing when every turn is priced and billed", () => {
    expect(render(null)).toBe("");
    expect(render({ total: { turns: 4, unpriced: 0 }, notBilled: { usd: 0, turns: 0 } })).toBe("");
  });
  it("labels subscription dollars as estimated, not billed, and counts the turns that have no price", () => {
    const markup = render({ total: { turns: 9, unpriced: 3 }, notBilled: { usd: 1.25, turns: 5 } });
    expect(markup).toContain("$1.25 of this is estimated, not billed: it ran on an AI signed in with a subscription.");
    expect(markup).toContain("Turns counted at $0 because their model has no price: 3. The total leaves them out.");
    expect(render({ total: { turns: 9, unpriced: 3 } })).not.toContain("not billed");
  });
});
