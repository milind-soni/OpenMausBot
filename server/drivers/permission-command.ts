import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Approval identity preserves every command byte, including whitespace and
 * newlines. Callers must supply native shell input, never a display preview. */
export function permissionCommand(command: unknown, cwd: unknown): { command: string; cwd: string } | undefined {
  if (typeof command !== "string" || !command.trim() || command.includes("\0")) return undefined;
  if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) return undefined;
  return { command, cwd };
}

export function permissionLaunchCwd(cwd: string): string | undefined {
  try { return realpathSync(cwd); } catch { return undefined; }
}

/** The keys an ACP agent may use for the command itself. Antigravity's shell
 * tool sends `CommandLine`/`Cwd`; every other agent seen so far sends
 * `command`. Without `CommandLine` here, an Antigravity bot reports no
 * command at all, which silently disables everything keyed on exact command
 * identity — the saved-command allowlist most of all, whose rules could never
 * match. Observed 2026-10-10 in a request.opened event whose rawInput was
 * `{"CommandLine":"ls -la …","Cwd":"…","WaitMsBeforeAsync":5000}`. */
const COMMAND_KEYS = ["command", "CommandLine"] as const;
const DIRECTORY_KEYS = ["cwd", "Cwd", "workdir", "working_directory", "directory", "dir"] as const;

/** ACP's rawInput is provider-specific. Accept a complete command string and
 * unambiguous absolute directory fields. A relative/invalid/conflicting
 * directory is not evidence of where the agent will execute it. */
export function acpPermissionCommand(rawInput: unknown, launchCwd: string | undefined): ReturnType<typeof permissionCommand> {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return undefined;
  const input = rawInput as Record<string, unknown>;
  const directories = DIRECTORY_KEYS
    .filter((key) => input[key] !== undefined)
    .map((key) => input[key]);
  if (directories.some((value) => typeof value !== "string" || !isAbsolute(value) || value.includes("\0"))) return undefined;
  if (new Set(directories).size > 1) return undefined;
  // Two different spellings of the command are a contradiction, not a choice.
  const commands = COMMAND_KEYS.filter((key) => input[key] !== undefined).map((key) => input[key]);
  if (new Set(commands).size > 1) return undefined;
  return permissionCommand(commands[0], directories[0] ?? launchCwd);
}
