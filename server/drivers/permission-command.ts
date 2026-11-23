import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { safetyFloorClears } from "../safety-floor-gate.ts";

/** Approval identity preserves every command byte, including whitespace and
 * newlines. Callers must supply native shell input, never a display preview. */
export function permissionCommand(command: unknown, cwd: unknown): { command: string; cwd: string } | undefined {
  if (typeof command !== "string" || !command.trim() || command.includes("\0")) return undefined;
  if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) return undefined;
  return { command, cwd };
}

const BARE_WORD = /^[\w@%+=:,./-]+$/;

/** Codex's legacy execCommandApproval sends argv, not a line: it is quoted for POSIX sh so the floor reads what runs. */
function floorCommandLine(command: unknown): string | undefined {
  if (typeof command === "string") return command.trim() ? command : undefined;
  if (!Array.isArray(command) || !command.length || !command.every((word) => typeof word === "string")) return undefined;
  return command.map((word: string) => BARE_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

/** A shell request's event fields: the exact-command descriptor, which needs a known cwd, and the raw command line
 * the safety floor reads, which does not. */
export function shellRequest(command: unknown, cwd: unknown): { command: ReturnType<typeof permissionCommand>; commandLine: string | undefined } {
  return { command: permissionCommand(command, cwd), commandLine: floorCommandLine(command) };
}

/** Whether a driver may answer a request itself with nobody looking; when false it must raise the request instead. */
export function answersAlone(command: unknown): boolean {
  return safetyFloorClears(floorCommandLine(command));
}

export function permissionLaunchCwd(cwd: string): string | undefined {
  try { return realpathSync(cwd); } catch { return undefined; }
}

// Antigravity's ACP shell input uses CommandLine/Cwd instead of command/cwd.
const COMMAND_KEYS = ["command", "CommandLine"] as const;
const DIRECTORY_KEYS = ["cwd", "Cwd", "workdir", "working_directory", "directory", "dir"] as const;

/** ACP's rawInput is provider-specific: only a complete command string and unambiguous absolute directories count. */
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

/** Every command an ACP rawInput names, under either spelling. */
function acpCommands(rawInput: unknown): unknown[] {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return [];
  return COMMAND_KEYS.map((key) => (rawInput as Record<string, unknown>)[key]).filter((value) => value !== undefined);
}

export function acpCarriesCommand(rawInput: unknown): boolean {
  return acpCommands(rawInput).length > 0;
}

/** answersAlone for an ACP request: every command it names, under either spelling, must clear the never-list, and a
 * command that cannot be read as a line never does. */
export function acpAnswersAlone(rawInput: unknown): boolean {
  return acpCommands(rawInput).every((command) => {
    const line = floorCommandLine(command);
    return line === undefined ? typeof command === "string" : safetyFloorClears(line);
  });
}

/** shellRequest for an ACP tool call: only a shell-typed call gets the descriptor, but any call naming a command
 * line, under either spelling, carries it for the safety floor. Two different spellings are both read. */
export function acpShellRequest(isShellCommand: boolean, rawInput: unknown, launchCwd: string | undefined): ReturnType<typeof shellRequest> {
  const lines = [...new Set(acpCommands(rawInput).map(floorCommandLine).filter((line) => line !== undefined))];
  return { command: isShellCommand ? acpPermissionCommand(rawInput, launchCwd) : undefined, commandLine: lines.length ? lines.join("\n") : undefined };
}

/** Where `path` really is: links resolved as far as the path exists, the rest appended as written. */
function realTarget(path: string): string | undefined {
  let existing = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest);
    } catch {
      // A link whose target is missing is there but cannot be followed here, while a write would follow it.
      try { if (lstatSync(existing, { throwIfNoEntry: false })) return undefined; } catch { return undefined; }
      const parent = dirname(existing);
      if (parent === existing) return undefined;
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** Whether an ACP permission request is only a file edit inside `root`: its kind is `edit`, it names no command, and
 * every location it gives is an absolute path to a file inside `root` that goes through no link. A request that gives
 * no location cannot be placed, so it is not one. */
export function acpFileEditWithin(toolCall: { kind?: unknown; rawInput?: unknown; locations?: unknown }, root: string | undefined): boolean {
  if (toolCall.kind !== "edit" || !root || acpCarriesCommand(toolCall.rawInput)) return false;
  const realRoot = permissionLaunchCwd(root);
  if (!realRoot || !Array.isArray(toolCall.locations) || !toolCall.locations.length) return false;
  return toolCall.locations.every((location) => {
    const path = (location as { path?: unknown } | null)?.path;
    // A `..` after a link climbs from the link's target, not from where the path's text says: such a path is asked.
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/u).includes("..")) return false;
    const target = realTarget(path);
    if (target === undefined || !fileOrNothing(target)) return false;
    const inside = relative(realRoot, target);
    const written = [relative(resolve(root), resolve(path)), relative(realRoot, resolve(path))];
    return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) && written.includes(inside);
  });
}

function fileOrNothing(path: string): boolean {
  try {
    const info = statSync(path, { throwIfNoEntry: false });
    return info === undefined || info.isFile();
  } catch {
    return false;
  }
}

/** An ACP permission request's exact operation, for the driver's own session allow; null for a generic title with no input. */
export function acpSessionOperationKey(toolCall: any): string | null {
  const rawInput = toolCall?.rawInput;
  const command = typeof rawInput?.command === "string" ? rawInput.command : undefined;
  const hasInput = rawInput && typeof rawInput === "object" && Object.keys(rawInput).length > 0;
  if (!command && !hasInput) return null;
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]))
        : value;
  return JSON.stringify(stable({
    kind: toolCall?.kind,
    title: toolCall?.title,
    command,
    input: rawInput,
    locations: toolCall?.locations,
  }));
}
