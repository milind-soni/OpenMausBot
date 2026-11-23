import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, sep } from "node:path";

import { isValidSshAlias } from "./vps-config.ts";

const MAX_HOSTS = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_INCLUDE_DEPTH = 4;
const MAX_INCLUDE_TARGETS = 200;

export interface SshConfigFiles {
  read(path: string): string | null;
  list(directory: string): string[];
}

const nodeFiles: SshConfigFiles = {
  read(path) {
    try {
      if (statSync(path).size > MAX_FILE_BYTES) return null;
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  list(directory) {
    try {
      return readdirSync(directory).sort();
    } catch {
      return [];
    }
  },
};

const wildcard = (pattern: string) => /[*?]/.test(pattern);

const segmentMatcher = (segment: string) =>
  new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

/** Expands `*` and `?` in every path segment, in lexical order, like OpenSSH's Include. */
function includeTargets(pattern: string, sshDir: string, files: SshConfigFiles): string[] {
  const expanded = pattern.startsWith("~/") ? join(homedir(), pattern.slice(2)) : pattern;
  const path = isAbsolute(expanded) ? expanded : join(sshDir, expanded);
  const { root } = parse(path);
  let paths = [root];
  for (const segment of path.slice(root.length).split(sep === "\\" ? /[\\/]/ : "/").filter(Boolean)) {
    const next: string[] = [];
    for (const parent of paths) {
      if (!wildcard(segment)) next.push(join(parent, segment));
      else for (const name of files.list(parent || ".").filter((entry) => segmentMatcher(segment).test(entry))) next.push(join(parent, name));
    }
    paths = next.slice(0, MAX_INCLUDE_TARGETS);
  }
  return paths;
}

/** Splits a config line into arguments the way ssh_config does: double quotes group, `=` may follow the keyword, `#` outside quotes starts a comment. */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quoted = false;
  for (const char of line) {
    if (quoted) {
      if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') {
      quoted = true;
      started = true;
    } else if (char === "#") {
      break;
    } else if (/\s/.test(char) || (char === "=" && tokens.length === 0)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

function collect(path: string, sshDir: string, files: SshConfigFiles, depth: number, seen: Set<string>, out: string[]): void {
  if (depth > MAX_INCLUDE_DEPTH || seen.has(path)) return;
  seen.add(path);
  const text = files.read(path);
  if (text === null) return;
  for (const raw of text.split(/\r?\n/)) {
    const [keyword = "", ...rest] = tokenize(raw);
    const key = keyword.toLowerCase();
    if (key === "host") {
      for (const name of rest) if (!name.startsWith("!") && !wildcard(name) && isValidSshAlias(name) && !out.includes(name)) out.push(name);
    } else if (key === "include") {
      for (const pattern of rest) for (const target of includeTargets(pattern, sshDir, files)) collect(target, sshDir, files, depth + 1, seen, out);
    }
    if (out.length >= MAX_HOSTS) return;
  }
}

/** The concrete `Host` names in the user's SSH config, in file order, including files it `Include`s. Patterns, negations and names that are no valid alias are left out. */
export function sshConfigHosts(sshDir = join(homedir(), ".ssh"), files: SshConfigFiles = nodeFiles): string[] {
  const out: string[] = [];
  collect(join(sshDir, "config"), sshDir, files, 0, new Set(), out);
  return out.slice(0, MAX_HOSTS);
}
