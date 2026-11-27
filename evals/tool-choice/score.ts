export interface ToolChoiceCase {
  id: string;
  /** Any of these counts: picking one directly, or reaching it through use_tool. */
  tools: string[];
  text: string;
  /** The real failure this came from, in neutral words. */
  why: string;
  /** Tools this request must not reach (a page just for the person is never published). */
  never?: string[];
  /** When the turn published a page or app, its reply must match this (case-insensitive), e.g. that the link is public. */
  publishSays?: string;
}

const PUBLISH_TOOLS = new Set(["publish_page", "publish_app"]);

/** A tool name as a thread's activity row or a stream event gives it, without its server. */
export function bareToolName(name: string): string {
  return name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
}

export interface CaseScore {
  pass: boolean;
  chosen: string | undefined;
  /** It looked the tool up first. */
  searched: boolean;
}

/** The first of the turn's tool calls that isn't a lookup decides the case; a later right tool still counts, since the tool list is what's on trial.
 * A case with no tools passes on any turn that reaches none of its `never` tools; a turn that published must also say what `publishSays` asks. */
export function scoreCase(testCase: Pick<ToolChoiceCase, "tools" | "never" | "publishSays">, calls: readonly string[], reply = ""): CaseScore {
  const names = calls.map(bareToolName);
  const lookups = new Set(["find_tool", "ToolSearch"]);
  const chosen = names.find((name) => testCase.tools.includes(name));
  const forbidden = names.find((name) => testCase.never?.includes(name));
  const published = names.some((name) => PUBLISH_TOOLS.has(name));
  const said = !published || !testCase.publishSays || new RegExp(testCase.publishSays, "i").test(reply);
  const reached = testCase.tools.length === 0 || chosen !== undefined;
  return { pass: reached && !forbidden && said, chosen: forbidden ?? chosen ?? names.find((name) => !lookups.has(name)), searched: names.some((name) => lookups.has(name)) };
}

/** Pass rate, plus what a bridge or a shorter prompt has to beat. */
export function summarize(rows: ReadonlyArray<{ score: CaseScore; costUsd?: number; inputTokens?: number }>) {
  const passed = rows.filter((row) => row.score.pass).length;
  return {
    cases: rows.length,
    passed,
    searched: rows.filter((row) => row.score.searched).length,
    costUsd: Number(rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0).toFixed(4)),
    inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
  };
}
