export type FakeHookEvent = "PostToolUse" | "PostToolUseFailure" | "PreCompact" | "SessionStart" | "Stop";

const MATCHED_FIELD: Record<FakeHookEvent, string | null> = { PostToolUse: "tool_name", PostToolUseFailure: "tool_name", PreCompact: "trigger", SessionStart: "source", Stop: null };

/** Whether a settings hook's `matcher` selects an event, as the Claude Code hooks reference describes it: an event with no
 * matcher field ignores it; "", "*" or none match all; a matcher of only letters, digits, `_`, `-`, spaces, `,` and `|` is
 * an exact name or a list of them; any other is an unanchored JavaScript regular expression, and 2.1.325 skips a hook
 * whose expression does not compile. */
export function hookMatches(event: FakeHookEvent, matcher: string | undefined, payload: Record<string, unknown>): boolean {
  const field = MATCHED_FIELD[event];
  if (!field || !matcher || matcher === "*") return true;
  const text = String(payload[field] ?? "");
  if (/^[\w\s,|-]+$/.test(matcher)) return matcher.split(/[|,]/).some((name) => name.trim() === text);
  try {
    return new RegExp(matcher).test(text);
  } catch {
    return false;
  }
}
