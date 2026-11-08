import { BASH_MAX_TIMEOUT_MS } from "./system-prompt.ts";

// Claude Code 2.1.296 reports a Bash call killed at its limit as a PostToolUseFailure whose error reads "Command timed out after …".
const TIMED_OUT = /\bCommand timed out after\b/u;
const DISK_SCAN = /(?:^|[;&|(]\s*|\bsudo\s+)find\s+\/(?:\s|$)/mu;

export function shellTimeoutHint(toolName: unknown, toolInput: unknown, error: unknown): string | null {
  if (toolName !== "Bash" || typeof error !== "string" || !TIMED_OUT.test(error)) return null;
  const command = toolInput && typeof toolInput === "object" ? (toolInput as { command?: unknown }).command : undefined;
  const scan = typeof command === "string" && DISK_SCAN.test(command);
  return [
    "That command hit the shell time limit and its output was lost. Do not rerun it the same way.",
    scan
      ? "Do not search the whole disk: use `mdfind -name <name>` on macOS, or `find` in a specific folder (your workspace, home, /Applications) with -maxdepth."
      : `If it needs longer, rerun it with a larger \`timeout\` (in milliseconds, up to ${BASH_MAX_TIMEOUT_MS}) and keep it in the foreground until it exits. Split very long media jobs into shorter pieces.`,
  ].join(" ");
}

export function shellTimeoutHookResult(payload: Record<string, unknown>): { ok: true; ignored?: string; hookSpecificOutput?: unknown } {
  const hint = shellTimeoutHint(payload.tool_name, payload.tool_input, payload.error);
  return hint ? { ok: true, hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: hint } } : { ok: true, ignored: "tool failure without a hint" };
}
