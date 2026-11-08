// All values emitted to Origin are cumulative within this execution attempt.
export class UsageTotals {
  constructor() { this.values = {}; }
  add(delta) {
    for (const [key, value] of Object.entries(delta)) if (Number.isFinite(value) && value >= 0) this.values[key] = (this.values[key] ?? 0) + value;
    return { ...this.values };
  }
  observe(cumulative) {
    for (const [key, value] of Object.entries(cumulative)) if (Number.isFinite(value) && value >= 0) this.values[key] = Math.max(this.values[key] ?? 0, value);
    return { ...this.values };
  }
}
export function claudeUsage(totals, frame, paidApi) {
  const models = Object.values(frame.modelUsage ?? {});
  if (models.length) {
    totals.observe({ inputTokens: models.reduce((sum, value) => sum + (value.inputTokens ?? 0) + (value.cacheReadInputTokens ?? 0) + (value.cacheCreationInputTokens ?? 0), 0), outputTokens: models.reduce((sum, value) => sum + (value.outputTokens ?? 0), 0) });
  } else if (frame.usage) {
    // Streaming-input `usage` is per-turn; modelUsage and cost above are call totals.
    totals.add({ inputTokens: (frame.usage.input_tokens ?? 0) + (frame.usage.cache_read_input_tokens ?? 0) + (frame.usage.cache_creation_input_tokens ?? 0), outputTokens: frame.usage.output_tokens });
  }
  return totals.observe(paidApi ? { estimatedApiUsd: frame.total_cost_usd } : {});
}
