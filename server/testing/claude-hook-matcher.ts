/** Whether a settings hook's `matcher` selects an event, as the Claude Code hooks reference describes it: "", "*" or none
 * match all; a matcher of only letters, digits, `_`, `-`, spaces, `,` and `|` is an exact name or a list of them; any other
 * is an unanchored JavaScript regular expression. */
export function hookMatches(matcher: string | undefined, value: unknown): boolean {
  if (!matcher || matcher === "*") return true;
  const text = String(value ?? "");
  if (/^[\w\s,|-]+$/.test(matcher)) return matcher.split(/[|,]/).some((name) => name.trim() === text);
  return new RegExp(matcher).test(text);
}
