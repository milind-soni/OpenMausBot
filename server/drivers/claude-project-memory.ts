// Claude Code delivers the working folder's project memory — CLAUDE.md, or AGENTS.md when no CLAUDE.md sits in the
// working folder or any folder above it (code.claude.com/docs/en/memory) — as an attachment that follows the first
// message of a session. A new session's first message always differs, because the volatile half of the prompt rides it
// (prompt-split.ts), so every new session wrote the whole memory to the provider's cache again. An isolated
// launch folds the same files the CLI would read into the system prompt it starts with and lists them in
// claudeMdExcludes, so the memory shares the system prompt's cached prefix instead of following the first message.
//
// The fold runs only when the launch passes the private --settings file (claude.ts): it carries the exclusions, and a
// fold without them would leave the CLI attaching the same files too. The user's own scope stays out, as it already is
// for isolated turns, whose claudeMdExcludes hold out the personal memory and rules: project-only settings still find
// them via the ancestor walk when a bot lives under HOME, so nothing under the home's .claude folder is folded.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// Claude Code skips a project memory file over 4 MiB entirely, so a larger file is neither folded nor excluded.
const FILE_MAX_BYTES = 4 * 1024 * 1024;

export interface ClaudeProjectMemory {
  /** The folded files' text, each under an `Instructions from <path>:` header, root-down as the CLI concatenates them. */
  text: string;
  /** The folded files' absolute paths, for claudeMdExcludes. */
  excludes: string[];
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** The file's text, or null when it cannot serve as project memory: unreadable, or over the size the CLI skips. */
function memoryText(path: string): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > FILE_MAX_BYTES) return null;
    return readFileSync(path, "utf8").trimEnd();
  } catch {
    return null;
  }
}

/** The project memory Claude Code would attach for a turn launched in `cwd`, or null when it would attach none.
 * CLAUDE.md and CLAUDE.local.md load from the working folder and every folder above it, root-down, the local one after
 * the folder's CLAUDE.md; AGENTS.md counts only when no CLAUDE.md file exists in the working folder or above it. A
 * `.claude/CLAUDE.md` (or, in the fallback, `.claude/AGENTS.md`) is the project's own and is checked in `cwd` only —
 * never in the home's, whose .claude folder is the person's user scope. */
export function claudeProjectMemory(cwd: string, home: string): ClaudeProjectMemory | null {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dirname(dir) === dir) break;
  }
  dirs.reverse();
  const projectOwn = (dir: string): boolean => dir === cwd && dir !== home;
  const claudeNames = (dir: string): string[] => projectOwn(dir) ? ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"] : ["CLAUDE.md", "CLAUDE.local.md"];
  const agentsNames = (dir: string): string[] => projectOwn(dir) ? ["AGENTS.md", ".claude/AGENTS.md"] : ["AGENTS.md"];
  const names = dirs.some((dir) => claudeNames(dir).some((name) => isFile(join(dir, name)))) ? claudeNames : agentsNames;
  const files: { path: string; text: string }[] = [];
  for (const dir of dirs) {
    for (const name of names(dir)) {
      const path = join(dir, name);
      const text = memoryText(path);
      if (text !== null) files.push({ path, text });
    }
  }
  if (!files.length) return null;
  return {
    text: files.map((file) => `Instructions from ${file.path}:\n\n${file.text}`).join("\n\n"),
    excludes: files.map((file) => file.path),
  };
}

/** The system prompt a launch starts with: the project memory folded in, the stable half alone when there is none. */
export function withProjectMemory(launchSystem: string | undefined, memory: ClaudeProjectMemory | null): string | undefined {
  if (!memory) return launchSystem;
  return launchSystem ? `${launchSystem}\n\n${memory.text}` : memory.text;
}
