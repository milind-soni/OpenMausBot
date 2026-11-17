import { classifyTurn, type TurnTier } from "../../server/turn-route.ts";

export interface RoutingCase {
  id: string;
  lang: string;
  text: string;
  attachments?: number;
  priorTurnUsedTools?: boolean;
  /** The tier a person would pick: simple when a quick model answers as well as the full one. */
  want: TurnTier;
  why: string;
}

/** `cautious`: the full model for a simple turn, which only costs money. `eager`: the quick model for a turn that needed the full one, which costs the answer. */
export type Verdict = "right" | "cautious" | "eager";

export interface RoutingRow {
  id: string;
  lang: string;
  want: TurnTier;
  got: TurnTier;
  verdict: Verdict;
}

export function routeCase(testCase: RoutingCase, classify: typeof classifyTurn = classifyTurn): RoutingRow {
  const got = classify({ text: testCase.text, attachments: testCase.attachments ?? 0, priorTurnUsedTools: testCase.priorTurnUsedTools ?? false });
  const verdict: Verdict = got === testCase.want ? "right" : got === "complex" ? "cautious" : "eager";
  return { id: testCase.id, lang: testCase.lang, want: testCase.want, got, verdict };
}

export function summarize(rows: readonly RoutingRow[]) {
  const count = (verdict: Verdict, of: readonly RoutingRow[] = rows) => of.filter((row) => row.verdict === verdict).length;
  const langs = [...new Set(rows.map((row) => row.lang))].sort();
  return {
    cases: rows.length,
    right: count("right"),
    cautious: count("cautious"),
    eager: count("eager"),
    byLang: Object.fromEntries(langs.map((lang) => {
      const of = rows.filter((row) => row.lang === lang);
      return [lang, { cases: of.length, right: count("right", of), cautious: count("cautious", of), eager: count("eager", of) }];
    })),
  };
}
