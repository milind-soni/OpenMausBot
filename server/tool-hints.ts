// A hint only appends a line to a result that already failed: it never changes ok/error status.
// An entry's `match` avoids numbers, paths and quoted names, so it also matches errors with those replaced.

export type HintOrigin = "harness" | "external" | "shell";

export interface FixHint {
  id: string;
  origin: HintOrigin;
  /** limit to these tool names (case-insensitive, without any mcp__ prefix) */
  tools?: readonly string[];
  match: RegExp;
  hint: string;
  example: string;
}

const AWK_BUILTINS = "sin|cos|atan2|exp|log|sqrt|int|rand|srand|length|substr|index|split|sub|gsub|match|sprintf|tolower|toupper|system|close|getline|fflush";

export const FIX_HINTS: readonly FixHint[] = [
  {
    id: "shell-timeout",
    origin: "shell",
    match: /\bcommand timed out after\b/i,
    hint: "Run long jobs (media encoding, transcription, big searches) in the background or with a longer timeout, and scope searches to a specific folder (or mdfind on macOS) instead of `find /`.",
    example: "Exit code 143\nCommand timed out after 2m 0s",
  },
  {
    id: "awk-builtin-name",
    origin: "shell",
    match: new RegExp(`\\bawk\\b[\\s\\S]*\\bsyntax error\\b[\\s\\S]*\\b(?:${AWK_BUILTINS})\\s*=`, "i"),
    hint: "`sin`, `cos`, `log`, `int`, `index` and similar are awk built-in functions and cannot be variable names: rename the variable, or do the math in python3.",
    example: "awk: syntax error at source line 1\n context is\n\t{ >>>  sin= <<< $1/254016000000",
  },
  {
    id: "read-missing-file",
    origin: "external",
    tools: ["read"],
    match: /\bfile does not exist\b/i,
    hint: "List the folder first (`ls`) to see the actual file names, then read one that is there; don't guess names.",
    example: "File does not exist. Note: your current working directory is <path>.",
  },
  {
    id: "assign-to-ancestor",
    origin: "harness",
    match: /\bcannot assign work back to an ancestor\b|\bcannot return to an ancestor room\b/i,
    hint: "Your requester gets your final reply automatically: finish your turn with the result, or with your question if you are blocked.",
    example: "Cannot assign work back to an ancestor; results return automatically",
  },
  {
    id: "already-completed",
    origin: "harness",
    match: /\balready completed your assignment\b/i,
    hint: "Nothing was sent, and retrying will be refused again: don't acknowledge, write your final answer now.",
    example: "This agent already completed your assignment. Do not send acknowledgements or approvals as new work.",
  },
  {
    id: "unknown-bot",
    origin: "harness",
    match: /\bno bot with id\b/i,
    hint: "In a room, the ids you can reach come from list_room_targets; copy one exactly instead of guessing a name.",
    example: "No bot with id or name <q> — call list_bots to see who you can reach.",
  },
];

const HARNESS_SERVERS = new Set([
  "ogb", "computer", "agents", "composio", "data", "browser", "phone", "dweb",
  "openmausbot", "openmausbot_connectors", "openmausbot_phone",
]);
const SHELL_TOOLS = new Set(["bash", "shell", "exec", "exec_command", "local_shell", "run_command", "terminal"]);

export function hintOrigin(tool: string): HintOrigin {
  const mcp = /^mcp__(.+?)__/.exec(tool);
  if (mcp) return HARNESS_SERVERS.has(mcp[1]!) ? "harness" : "external";
  return SHELL_TOOLS.has(tool.toLowerCase()) ? "shell" : "external";
}

const MAX_SCAN = 8_000;

/** The hint for a failed call, if one fits. Only the start and end of a long
 * error are scanned: that is where engines put the reason. */
export function fixHintFor(failure: { tool: string; text: string; origin?: HintOrigin; table?: readonly FixHint[] }): FixHint | undefined {
  const origin = failure.origin ?? hintOrigin(failure.tool);
  const bare = failure.tool.replace(/^mcp__.+?__/, "").toLowerCase();
  const text = failure.text.length > MAX_SCAN ? `${failure.text.slice(0, MAX_SCAN / 2)}\n${failure.text.slice(-MAX_SCAN / 2)}` : failure.text;
  return (failure.table ?? FIX_HINTS).find((entry) =>
    entry.origin === origin && (!entry.tools || entry.tools.includes(bare)) && entry.match.test(text));
}

export const HINT_PREFIX = "Hint: ";

export function withFixHint(failure: { tool: string; text: string; origin?: HintOrigin }): string {
  const entry = fixHintFor(failure);
  if (!entry || failure.text.includes(entry.hint)) return failure.text;
  return `${failure.text}\n\n${HINT_PREFIX}${entry.hint}`;
}

/** The hook answer for a failed native tool; the harness's own tools already carry their hint in the error. */
export function toolFailureHookAnswer(payload: Record<string, unknown>): { ok: true; ignored?: string; hookSpecificOutput?: unknown } {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const error = typeof payload.error === "string" ? payload.error : "";
  if (!tool || !error || payload.is_interrupt === true) return { ok: true, ignored: "failure without a tool error" };
  const hint = fixHintFor({ tool, text: error });
  if (!hint || error.includes(hint.hint)) return { ok: true };
  return { ok: true, hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: `${HINT_PREFIX}${hint.hint}` } };
}
