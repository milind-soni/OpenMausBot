// Claude Code can keep MCP tools out of the request until the model looks one up with its ToolSearch
// tool: the turn carries the tool names, and a schema loads only when searched. Its `auto` mode
// instead sends every schema while they fit under a share of the context window (a tenth by
// default), which on a 1M-token model is nearly always: every model call pays for every connected
// app's schemas, and a session writes them into the prompt cache again and again. Claude Code
// 2.1.312 defers by default when nothing is set, but holds a resumed conversation that ran without
// ToolSearch to the old way ("ENABLE_TOOL_SEARCH=true overrides this"), and OpenMausBot resumes every
// thread. So a turn runs with ENABLE_TOOL_SEARCH=true unless the person chose otherwise.
//
// The value goes in the turn's private --settings file. Claude Code applies a settings file's `env`
// over its own process environment, so a value in the project's or the person's .claude settings
// would beat one set on the process; settings passed with --settings beat both.
//
// OpenMausBot's own small servers stay loaded (`alwaysLoad` in claude.ts): `ogb` (approvals and
// questions) and `agents` (bots, rooms, jobs), plus the browser when the turn plans to browse.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Only a regular file this small is read: a FIFO would hold the server's one thread. */
const FILE_MAX_BYTES = 1024 * 1024;

function smallFile(path: string): string | null {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size <= FILE_MAX_BYTES ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** Claude Code's reading of N in auto:N: a whole number written with an exponent ("1e2"), digits
 * grouped by `_`, `,` or a space ("1_000"), else parseInt. */
function claudeInteger(text: string): number {
  const value = text.trim();
  if (value.length <= 32 && /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(value)) {
    const number = Number(value);
    return Number.isInteger(number) ? number : Number.NaN;
  }
  if (value.length <= 32 && /^[+-]?\d{1,3}([_,   ])\d{3}(?:\1\d{3})*$/.test(value)) {
    return Number.parseInt(value.replace(/[_,   ]/g, ""), 10);
  }
  return Number.parseInt(value, 10);
}

/** What a turn sets ENABLE_TOOL_SEARCH to, from the value Claude Code would read otherwise. Nothing
 * and auto become "true". Any other value is the person's own and is kept: "false", "0", "off" or
 * auto:100 (N is clamped to 0..100) turn tool search off, and "true" or auto:0 already have it on. */
export function claudeToolSearchValue(value: string | undefined): string {
  if (!value || value === "auto") return "true";
  if (!value.startsWith("auto:")) return value;
  const percent = claudeInteger(value.slice("auto:".length));
  // Claude Code reads an auto:N it cannot parse as plain auto.
  if (Number.isNaN(percent)) return "true";
  return percent > 0 && percent < 100 ? "true" : value;
}

/** ENABLE_TOOL_SEARCH in a settings file's `env`, or undefined when the file is missing, not JSON or silent. */
function settingsValue(file: string): string | undefined {
  const text = smallFile(file);
  if (text === null) return undefined;
  try {
    const value = (JSON.parse(text) as { env?: Record<string, unknown> } | null)?.env?.ENABLE_TOOL_SEARCH;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The main checkout of a folder holding `.git`, else null. A worktree's `.git` file points at
 * <main>/.git/worktrees/<name>, whose commondir leads back to <main>/.git. */
function checkoutRoot(folder: string): string | null {
  const git = join(folder, ".git");
  try {
    if (!statSync(git).isFile()) return folder;
  } catch {
    return null;
  }
  const gitDir = /^gitdir:\s*(.+)$/m.exec(smallFile(git) ?? "")?.[1]?.trim();
  if (!gitDir) return folder;
  const worktree = resolve(folder, gitDir);
  const commonDir = smallFile(join(worktree, "commondir"))?.trim();
  if (!commonDir) return folder;
  const common = resolve(worktree, commonDir);
  return basename(common) === ".git" ? dirname(common) : folder;
}

/** Where Claude Code keeps .claude/settings.local.json: the repository's root, or the folder itself
 * outside a repository, on Windows, or when the root is the home folder. */
function localSettingsFolder(cwd: string, home: string): string {
  if (process.platform === "win32") return cwd;
  for (let folder = cwd; ; folder = dirname(folder)) {
    const root = checkoutRoot(folder);
    if (root !== null) return root === home ? cwd : root;
    if (dirname(folder) === folder) return cwd;
  }
}

/** The turn's ENABLE_TOOL_SEARCH (claudeToolSearchValue) from what Claude Code would read: the local
 * settings over the project's over the person's own, then the process environment. The person's own
 * settings count even when the turn leaves them out (--setting-sources project), so an opt-out made
 * there still holds. `env` is the turn's environment, its CLAUDE_CONFIG_DIR already resolved. */
export function claudeToolSearchSetting(cwd: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  const local = localSettingsFolder(cwd, home);
  const files = [
    join(local, ".claude", "settings.local.json"),
    // An older Claude Code left the local file in the launch folder; the root one wins.
    ...(local === cwd ? [] : [join(cwd, ".claude", "settings.local.json")]),
    join(cwd, ".claude", "settings.json"),
    join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json"),
  ];
  for (const file of files) {
    const value = settingsValue(file);
    if (value !== undefined) return claudeToolSearchValue(value);
  }
  return claudeToolSearchValue(env.ENABLE_TOOL_SEARCH);
}
