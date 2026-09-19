// Pure wire shaping for the codex app-server protocol: token-usage
// normalization and the per-turn usage arithmetic, item titles, completion
// stop reasons, and exit attribution. Mirrors acp/wire.ts: everything here
// is pure with explicit inputs; the notification switch and the process
// lifecycle stay in the driver.
import { classifyError } from "../retry.ts";

export interface CodexTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export interface CodexTurnUsage {
  input: number;
  output: number;
  cachedInput?: number;
}

export function normalizeTokenUsage(u: CodexTokenUsage): { input: number; output: number; cachedInput: number } {
  return { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cachedInput: u.cachedInputTokens ?? 0 };
}

/** This turn's usage: the process-wide total minus whatever the process
 *  already carried before turn/start (a resumed thread may restore earlier
 *  usage), never counting only the final call of a multi-step turn. */
export function turnUsageDelta(
  t: CodexTokenUsage,
  baseline: { input: number; output: number; cachedInput: number } | undefined,
): CodexTurnUsage {
  const b = baseline ?? { input: 0, output: 0, cachedInput: 0 };
  const now = normalizeTokenUsage(t);
  return {
    input: Math.max(0, now.input - b.input),
    output: Math.max(0, now.output - b.output),
    ...(typeof t.cachedInputTokens === "number" ? { cachedInput: Math.max(0, now.cachedInput - b.cachedInput) } : {}),
  };
}

/** Fields for the harness's thread.token-usage.updated event: the
 *  process-wide totals, plus the last call's prompt size and the model's
 *  context window when reported. */
export function usageUpdateFields(
  t: CodexTokenUsage,
  last: CodexTokenUsage | undefined,
  window: unknown,
): { input: number; output: number; cachedInput?: number; contextTokens?: number; contextWindow?: number } {
  return {
    input: t.inputTokens ?? 0,
    output: t.outputTokens ?? 0,
    ...(typeof t.cachedInputTokens === "number" ? { cachedInput: t.cachedInputTokens } : {}),
    // the last call's prompt is what fills the window
    ...(last && typeof last.inputTokens === "number" ? { contextTokens: last.inputTokens } : {}),
    ...(typeof window === "number" && window > 0 ? { contextWindow: window } : {}),
  };
}

export function itemStartedTitle(item: any): string | null {
  return (
    item.type === "commandExecution"
      ? String(item.command ?? "shell")
      : item.type === "fileChange"
        ? "edit"
        : item.type === "mcpToolCall"
          ? (item.tool ?? item.name ?? "mcp")
          : item.type === "webSearch"
            ? "web_search"
            : null
  );
}

export function completedStopReason(t: any, message: string, lastError: string): string | null {
  return (
    t.status === "completed"
      ? null
      : classifyError({ text: message || lastError }).reason === "provider_safety"
        ? "provider_safety"
        : message || t.status || "failed"
  );
}

export function exitBeforeCompletedMessage(
  code: number | null,
  signal: NodeJS.Signals | null,
  recentStderr: string,
  hadStreamedOutput: boolean,
  stderr: string,
): string {
  return `codex exited ${code}${signal ? ` (signal ${signal})` : ""} before turn/completed${
    recentStderr ? `: ${recentStderr.slice(-300)}` : hadStreamedOutput && stderr.trim() ? "; no stderr after the last app-server output" : ""
  }`;
}
