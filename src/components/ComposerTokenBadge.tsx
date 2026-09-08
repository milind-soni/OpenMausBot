import { cn } from "@/lib/cn";
import {
  formatTokenCount,
  formatWordCount,
  type TextMetrics,
} from "@/lib/token-estimator";

/** Props for the {@link ComposerTokenBadge} component. */
export interface ComposerTokenBadgeProps {
  /** Text metrics for the current composed draft. */
  metrics: TextMetrics;
}

/**
 * Live token and word count indicator for the chat composer.
 * Displays approximate token and word metrics with accessible aria attributes and tooltips.
 *
 * @param props - Component props containing text metrics.
 * @returns Rendered token badge element or null if token count is 0.
 */
export function ComposerTokenBadge({ metrics }: ComposerTokenBadgeProps) {
  if (metrics.estimatedTokens <= 0) {
    return null;
  }

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`${formatWordCount(metrics.words)}, approximately ${metrics.estimatedTokens} tokens`}
      title={`Prompt estimate: ${formatWordCount(metrics.words)}, ~${metrics.estimatedTokens.toLocaleString()} tokens (${metrics.characters.toLocaleString()} characters)`}
      className={cn(
        "hidden sm:inline-flex select-none items-center px-1 text-[11px] font-medium tabular-nums transition-colors",
        metrics.estimatedTokens >= 100_000
          ? "text-danger"
          : metrics.estimatedTokens >= 32_000
            ? "text-warning"
            : "text-ink-secondary/70 hover:text-ink",
      )}
    >
      {formatTokenCount(metrics.estimatedTokens)}
    </span>
  );
}
