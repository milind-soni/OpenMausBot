// A bot reading its own files never needs the person: its standing instructions (SOUL.md), its skills with every
// revision, its memory and its conversation folders are its own, and an unattended run that waits for an approval to
// read them only stalls. Only plain reads count: one of the reading commands below made of plain words alone, or a read
// tool's own paths, with every path inside the bot's own folders once every link is followed.
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Commands that only read the files they name, with the flags that keep them that way: none that follows links out
 * (grep -R, rg -L), runs a program (rg --pre), follows a file forever (tail -f) or writes (sed -i). */
const READERS: Record<string, { flags: RegExp; valued?: RegExp; pattern?: boolean; script?: RegExp }> = {
  cat: { flags: /^-[nbsvAET]+$/ },
  head: { flags: /^-(?:[nqv]+|\d+)$/, valued: /^-[nc]$/ },
  tail: { flags: /^-(?:[nqv]+|\d+)$/, valued: /^-[nc]$/ },
  wc: { flags: /^-[lwcmL]+$/ },
  ls: { flags: /^-[laAhRt1SrdFpG]+$/ },
  nl: { flags: /^-[ba]+$/ },
  stat: { flags: /^-L$/ },
  grep: { flags: /^-(?:[nilcrvwxHhEFsoq]+|-color=never)$/, valued: /^-[ABCm]$/, pattern: true },
  rg: { flags: /^-(?:[nilcvwxHhFsS]+|-no-heading|-color=never)$/, valued: /^-[ABCmg]$/, pattern: true },
  sed: { flags: /^-n$/, script: /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/ },
};

/** One plain word: letters, digits and the punctuation of paths and numbers, or a whole quoted string the shell expands
 * nothing in, each ending at a space or the end. No glob, variable, substitution, redirection, pipe or second command can
 * be one. */
const WORD = /[ \t]*(?:'([^']*)'|"([^"$`\\!]*)"|([\w./~+@%:,=-]+))(?=[ \t]|$)/y;

function words(command: string): string[] | null {
  if (/[\0\r\n]/.test(command)) return null;
  const text = command.trim(), out: string[] = [];
  for (let index = 0; index < text.length;) {
    WORD.lastIndex = index;
    const found = WORD.exec(text);
    if (!found) return null;
    // A bare word with a ~ anywhere (bash expands one after an =, as in foo=~/x) or starting with = (zsh's =cmd) is the
    // shell's to expand, to a home, the folder it was in before or a command's own path, none of which is checked here.
    if (found[3] !== undefined && (found[3].includes("~") || found[3].startsWith("="))) return null;
    out.push(found[1] ?? found[2] ?? found[3]!);
    index = WORD.lastIndex;
  }
  return out.length ? out : null;
}

/** The paths a shell command reads when it is one of the plain readers, or null when it might do anything else. */
export function readOnlyPaths(command: string): string[] | null {
  const parts = words(command);
  if (!parts) return null;
  const [name, ...rest] = parts;
  const reader = READERS[name!];
  if (!reader) return null;
  const paths: string[] = [];
  let patternTaken = !reader.pattern, scriptTaken = !reader.script, endOfFlags = false;
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index]!;
    if (!endOfFlags && word === "--") { endOfFlags = true; continue; }
    if (!endOfFlags && word.startsWith("-") && word !== "-") {
      if (reader.valued?.test(word)) { if (++index >= rest.length) return null; continue; }
      if (!reader.flags.test(word)) return null;
      continue;
    }
    if (!scriptTaken) { if (!reader.script!.test(word)) return null; scriptTaken = true; continue; }
    if (!patternTaken) { patternTaken = true; continue; }
    if (word === "-") return null;
    paths.push(word);
  }
  return scriptTaken && patternTaken && paths.length ? paths : null;
}

/** The files a read tool's ask names (Claude's Read, Grep, Glob, LS, NotebookRead), or undefined for any other tool or
 * a search that could reach past the path it names. */
export function readToolPaths(tool: unknown, input: unknown): string[] | undefined {
  if (typeof tool !== "string" || !input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const fields = input as Record<string, unknown>;
  const path = tool === "Read" ? fields.file_path : tool === "NotebookRead" ? fields.notebook_path
    : tool === "Grep" || tool === "LS" ? fields.path
    : tool === "Glob" && typeof fields.pattern === "string" && !fields.pattern.split(/[\\/]/).includes("..") && !isAbsolute(fields.pattern) ? fields.path
    : undefined;
  return typeof path === "string" && isAbsolute(path) ? [path] : undefined;
}

/** The files an ACP read call names: its locations and the usual path fields of its input. */
export function acpReadPaths(toolCall: { kind?: unknown; locations?: unknown; rawInput?: unknown }): string[] | undefined {
  if (toolCall.kind !== "read") return undefined;
  const input = toolCall.rawInput && typeof toolCall.rawInput === "object" && !Array.isArray(toolCall.rawInput) ? toolCall.rawInput as Record<string, unknown> : {};
  const located = Array.isArray(toolCall.locations) ? toolCall.locations.map((location) => (location as { path?: unknown })?.path) : [];
  const paths = [...located, input.filePath, input.file_path, input.path].filter((path): path is string => typeof path === "string");
  return paths.length && paths.every((path) => isAbsolute(path)) ? [...new Set(paths)] : undefined;
}

const inside = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function real(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

/** The bot's own folders and files, as they are on disk: its folder, its conversation folders and its SOUL.md. */
export function ownReadRoots(dataDir: string, botId: string): string[] {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(botId)) return [];
  return [join(dataDir, "workspaces", botId), join(dataDir, "task-workspaces", botId), join(dataDir, "bots", botId, "SOUL.md")]
    .flatMap((root) => real(root) ?? []);
}

/** Every path exists and is inside one of `roots` once its links are followed. */
export function readsOnly(paths: readonly string[], cwd: string, roots: readonly string[]): boolean {
  if (!paths.length || !roots.length) return false;
  return paths.every((path) => {
    const full = real(resolve(cwd, path));
    return full !== null && roots.some((root) => inside(full, root));
  });
}

/** Whether this ask only reads the bot's own files: a plain reading command in its shell, or a read tool's paths. */
export function readsOwnFiles(dataDir: string, botId: string, ask: { command?: { command: string; cwd: string }; reads?: readonly string[] }): boolean {
  const roots = ownReadRoots(dataDir, botId);
  if (ask.reads?.length) return readsOnly(ask.reads, "/", roots);
  const paths = ask.command ? readOnlyPaths(ask.command.command) : null;
  return Boolean(paths && ask.command && readsOnly(paths, ask.command.cwd, roots));
}
