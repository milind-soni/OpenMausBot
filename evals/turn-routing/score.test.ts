import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { routeCase, summarize, type RoutingCase } from "./score.ts";

const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as RoutingCase[];

describe("turn-routing scoring", () => {
  const item: RoutingCase = { id: "x", lang: "en", text: "hi", want: "simple", why: "w" };

  it("names which way a miss goes", () => {
    expect(routeCase(item, () => "simple").verdict).toBe("right");
    expect(routeCase(item, () => "complex").verdict).toBe("cautious");
    expect(routeCase({ ...item, want: "complex" }, () => "simple").verdict).toBe("eager");
  });

  it("passes the case's signals to the classifier, with plain defaults", () => {
    const seen: unknown[] = [];
    routeCase(item, (signals) => (seen.push(signals), "simple"));
    routeCase({ ...item, attachments: 2, priorTurnUsedTools: true }, (signals) => (seen.push(signals), "simple"));
    expect(seen).toEqual([
      { text: "hi", attachments: 0, priorTurnUsedTools: false },
      { text: "hi", attachments: 2, priorTurnUsedTools: true },
    ]);
  });

  it("adds up a run, in total and per language", () => {
    const rows = [routeCase(item, () => "simple"), routeCase({ ...item, lang: "es" }, () => "complex")];
    expect(summarize(rows)).toEqual({
      cases: 2, right: 1, cautious: 1, eager: 0,
      byLang: { en: { cases: 1, right: 1, cautious: 0, eager: 0 }, es: { cases: 1, right: 0, cautious: 1, eager: 0 } },
    });
  });
});

describe("turn-routing cases", () => {
  it("each case is well formed", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      expect(["simple", "complex"], c.id).toContain(c.want);
      expect(c.text.trim().length, c.id).toBeGreaterThan(0);
      expect(c.why.length, c.id).toBeGreaterThan(0);
    }
  });

  it("pins today's classifyTurn on these cases, so a router change shows what it moved", () => {
    const rows = cases.map((c) => routeCase(c));
    const misses = (verdict: string) => rows.filter((row) => row.verdict === verdict).map((row) => row.id);
    expect(summarize(rows)).toMatchObject({ cases: 38, right: 16, cautious: 7, eager: 15 });
    expect(misses("eager")).toEqual([
      "remind-me", "calendar", "check-inbox", "tell-team", "order-food",
      "job-offer", "offers-after-tax", "mole", "lease-clause", "fire-cofounder",
      "es-search-flights", "de-write-email", "hi-reminder", "ja-summarise", "ja-decision",
    ]);
    expect(misses("cautious")).toEqual(["thanks-after-tools", "haiku", "translate-phrase", "synonym", "stuck-jar", "run-in-rain", "word-test"]);
  });
});
