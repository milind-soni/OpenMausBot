import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { isValidSshAlias } from "./vps-config.ts";

const MAX_HOSTS = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_INCLUDE_DEPTH = 4;

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

function includeTargets(pattern: string, sshDir: string, files: SshConfigFiles): string[] {
  const expanded = pattern.startsWith("~/") ? join(homedir(), pattern.slice(2)) : pattern;
  const path = isAbsolute(expanded) ? expanded : join(sshDir, expanded);
  if (!wildcard(path)) return [path];
  const directory = dirname(path);
  if (wildcard(directory)) return [];
  const base = path.slice(directory.length + 1);
  const matcher = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return files.list(directory).filter((name) => matcher.test(name)).map((name) => join(directory, name));
}

function collect(path: string, sshDir: string, files: SshConfigFiles, depth: number, seen: Set<string>, out: string[]): void {
  if (depth > MAX_INCLUDE_DEPTH || seen.has(path)) return;
  seen.add(path);
  const text = files.read(path);
  if (text === null) return;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const [keyword = "", ...rest] = line.split(/[\s=]+/).filter(Boolean);
    const key = keyword.toLowerCase();
    if (key === "host") {
      for (const name of rest) if (!name.startsWith("!") && !wildcard(name) && isValidSshAlias(name) && !out.includes(name)) out.push(name);
    } else if (key === "include") {
      for (const pattern of rest) for (const target of includeTargets(pattern.replace(/^"|"$/g, ""), sshDir, files)) collect(target, sshDir, files, depth + 1, seen, out);
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
