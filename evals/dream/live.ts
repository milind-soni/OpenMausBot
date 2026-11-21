import { dreamPrompt } from "../../server/memory-dream.ts";
import { dreamConversationsOf, notebookOf, scoreDream, summarize, type DreamCase, type DreamScore } from "./score.ts";

export interface Generated {
  text: string;
  costUsd?: number;
}

export interface LiveRow {
  id: string;
  score: DreamScore;
  answer: string;
  ms: number;
  costUsd?: number;
  /** The model call failed or timed out; the case is scored on an empty answer. */
  error?: string;
}

/** One call per case, one at a time, with the dream's real prompt; a failed call is scored, never skipped. */
export async function runCases(cases: readonly DreamCase[], generate: (prompt: string) => Promise<Generated>, clock: () => number = Date.now): Promise<LiveRow[]> {
  const rows: LiveRow[] = [];
  for (const testCase of cases) {
    const prompt = dreamPrompt({ botName: "Scout", today: testCase.today, conversations: dreamConversationsOf(testCase), notebook: notebookOf(testCase) });
    const started = clock();
    let generated: Generated = { text: "" };
    let error: string | undefined;
    try {
      generated = await generate(prompt);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const ms = clock() - started;
    rows.push({ id: testCase.id, score: scoreDream(testCase, generated.text), answer: generated.text, ms, ...(generated.costUsd === undefined ? {} : { costUsd: generated.costUsd }), ...(error ? { error } : {}) });
  }
  return rows;
}

export function reportLines(rows: readonly LiveRow[], model: string): string[] {
  const lines = rows.map((row) => {
    const s = row.score;
    const mark = row.error ? "ERROR" : s.pass ? "pass " : "FAIL ";
    const notes = [
      !s.json && !row.error ? "not JSON" : "",
      s.violations.length ? `forbidden: ${s.violations.join(" | ")}` : "",
      s.dropped ? `${s.dropped} dropped by the fact checks` : "",
      s.unexpected.length ? `unexpected: ${s.unexpected.join(" | ")}` : "",
      row.error ?? "",
    ].filter(Boolean).join("; ");
    return `${mark} ${row.id.padEnd(40)} found ${s.found}/${s.expected}  ${(row.ms / 1000).toFixed(1)}s${row.costUsd === undefined ? "" : `  $${row.costUsd.toFixed(4)}`}${notes ? `  ${notes}` : ""}`;
  });
  const total = summarize(rows);
  return [
    `dream eval on ${model}`,
    ...lines,
    `${total.passed}/${total.cases} passed, ${total.found}/${total.expected} expected lines found, ${total.violations} forbidden, ${total.dropped} dropped, ${total.invalidJson} not JSON, $${total.costUsd.toFixed(4)}, ${(total.ms / 1000).toFixed(1)}s`,
  ];
}
