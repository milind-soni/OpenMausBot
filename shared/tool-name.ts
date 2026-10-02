// A tool chip's display title is not a tool identity. Codex titles a
// commandExecution chip with the whole command line (drivers/codex.ts) and
// the ACP core prefers `rawInput.command` over the call's own name
// (drivers/acp/core.ts), because in a transcript the command IS the useful
// label. Anything that counts or groups tool calls needs the identity
// instead, so both readers share one predicate rather than guessing twice.

/** The generic identity every command-titled chip counts under. */
export const SHELL_TOOL = "shell";

/** A tool name that is itself a command line rather than a bare tool name
 * such as `Bash`. Whitespace or a slash: no provider names a tool that way,
 * and every shell command has one by the time it carries an argument or a
 * path. */
export function nameIsCommand(name: string): boolean {
  return /[\s/]/.test(name);
}

/** What a tool chip should be counted as. Command-titled chips collapse to
 * one `shell` bucket: keyed on the raw command they never aggregate (a turn
 * that ran one tool twelve times reads as twelve tools), and the raw title
 * is unredacted — unlike `tool.summary`, which drivers bound and redact. */
export function toolIdentity(name: string): string {
  return nameIsCommand(name) ? SHELL_TOOL : name;
}
