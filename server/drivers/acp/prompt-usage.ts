export interface PromptTokenUsage {
  input: number;
  output: number;
  cachedInput?: number;
}

/** The token usage a prompt reply reports: opencode 1.18.18 at the result root, grok and gemini under `_meta`. */
export function promptTokenUsage(result: any): PromptTokenUsage | null {
  const usage = result?.usage ?? result?._meta ?? {};
  if (typeof usage.inputTokens !== "number" && typeof usage.outputTokens !== "number") return null;
  // opencode 1.18.25 keeps only the uncached share in inputTokens and reports cache reads beside it (omitted when 0); other agents count them inside. Absent is not zero.
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cachedRead = typeof usage.cachedReadTokens === "number" && usage.cachedReadTokens > 0 ? usage.cachedReadTokens : null;
  const exclusive = cachedRead !== null && (typeof usage.totalTokens !== "number" || usage.totalTokens >= input + output + cachedRead);
  return {
    input: cachedRead !== null && exclusive ? input + cachedRead : input,
    output,
    ...(cachedRead !== null ? { cachedInput: exclusive ? cachedRead : Math.min(cachedRead, input) } : {}),
  };
}
