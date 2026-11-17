const MATCHED_FIELD: Record<string, string> = { PostToolUse: "tool_name", PostToolUseFailure: "tool_name", PreToolUse: "tool_name", SessionStart: "source", PreCompact: "trigger" };

/** Whether a settings hook's `matcher` selects an event, as the Claude Code hooks reference describes it: an event with no
 * matcher field ignores it; "", "*" or none match all; a matcher of only letters, digits, `_`, `-`, spaces, `,` and `|` is
 * an exact name or a list of them; any other is an unanchored JavaScript regular expression. */
export function hookMatches(event: string, matcher: string | undefined, payload: Record<string, unknown>): boolean {
  const field = MATCHED_FIELD[event];
  if (!field || !matcher || matcher === "*") return true;
  const text = String(payload[field] ?? "");
  if (/^[\w\s,|-]+$/.test(matcher)) return matcher.split(/[|,]/).some((name) => name.trim() === text);
  return new RegExp(matcher).test(text);
}
