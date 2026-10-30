// The welcome flow's "Bring what you already use": finds the skills and MCP servers of a person's other AI tools on
// this computer and brings them in. It opens only the paths setupPaths names, plus the text files inside each skill
// folder; credential, session and history files are never listed, opened or copied, and nothing found is uploaded.
// A link out of a skills folder is followed only while it stays in the home folder, out of the folders macOS guards
// and out of the tools' own logins and history. Skills are copied once into this computer's imported skills, which every bot uses (imported-skills.ts);
// MCP servers go through the same parser as Plugins → MCP servers → Paste config, switched off.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { SetupDetection, SetupImportRequest, SetupImportResult, SetupSource, SkillSkip, SkillSource, ToolSkip } from "../shared/setup-import.ts";
import { holdsCredential } from "../shared/redact.ts";
import { parseSkillMd, scanSkillText, SKILL_FILE_MAX_BYTES, type ParsedSkill } from "../shared/skill-md.ts";
import { importedSkillIntact, readImportedSkills, storeImportedSkills, type ImportedSkillEntry, type ImportedSkillInput } from "./imported-skills.ts";
import { importedMcpServerName, isRemoteMcpServer, MAX_MCP_SERVERS, parseMcpServersImport, parseStoredMcpServer, type StoredMcpServer } from "./mcp-registry.ts";
import { parseToml } from "./toml-lite.ts";

/** The file operations finding and copying use, so tests can see every path touched. Each answers null on failure. */
export interface SetupFs {
  lstat(path: string): Stats | null;
  readdir(path: string): string[] | null;
  readlink(path: string): string | null;
  /** Asked of the home folder only. */
  realpath(path: string): string | null;
  /** A regular file of at most `max` bytes; `follow: false` refuses a symlink, `oneLink` a file with other hard links. */
  read(path: string, max: number, follow?: boolean, oneLink?: boolean): Buffer | null;
}

export interface SetupMachine {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  fs: SetupFs;
}

/** What finding and bringing in need from the server. Skills need nothing from it: they are kept once for every bot. */
export interface SetupHost {
  mcpServers(): Record<string, unknown>;
  mcpPolicyRefusal(name: string, server: object): string | undefined;
  persistMcpServers(next: Record<string, unknown>): void;
  mcpConfigBusy: { get(): boolean; set(busy: boolean): void };
  /** "Also use my Claude Code MCP servers" is on: Claude bots already run Claude Code's own, so they are not offered. */
  claudeUserMcp?(): boolean;
}

const nodeFs: SetupFs = {
  lstat: (path) => {
    try { return lstatSync(path); } catch { return null; }
  },
  readdir: (path) => {
    try { return readdirSync(path); } catch { return null; }
  },
  readlink: (path) => {
    try { return readlinkSync(path).replace(/^\\\\\?\\/, ""); } catch { return null; }
  },
  realpath: (path) => {
    try { return realpathSync(path); } catch { return null; }
  },
  read: (path, max, follow = true, oneLink = false) => {
    let fd: number | null = null;
    try {
      // Checked before opening, and opened non-blocking: a FIFO in place of a file must not hang the request.
      const before = follow ? statSync(path) : lstatSync(path);
      if (!before.isFile() || before.size > max || (oneLink && before.nlink > 1)) return null;
      const noFollow = !follow && process.platform !== "win32" ? constants.O_NOFOLLOW : 0;
      const nonBlock = process.platform !== "win32" ? constants.O_NONBLOCK : 0;
      fd = openSync(path, constants.O_RDONLY | noFollow | nonBlock);
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > max || (oneLink && opened.nlink > 1)) return null;
      const buffer = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (count <= 0) break;
        offset += count;
      }
      return buffer.subarray(0, offset);
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
    }
  },
};

export function thisMachine(): SetupMachine {
  return { home: homedir(), platform: process.platform, env: process.env, fs: nodeFs };
}

type ToolFormat = "claudeJson" | "json" | "toml";

const CONFIG_MAX_BYTES = 1024 * 1024;
/** ~/.claude.json also keeps every project's history, so it can be large; only its mcpServers member is parsed. */
const CLAUDE_JSON_MAX_BYTES = 256 * 1024 * 1024;

/** Every path finding reads, and nothing else. */
export function setupPaths(machine: Pick<SetupMachine, "home" | "platform" | "env">) {
  const { home, platform, env } = machine;
  const absolute = (value: string | undefined) => (value && isAbsolute(value) ? value : null);
  const codexHome = absolute(env.CODEX_HOME) ?? join(home, ".codex");
  const desktop = platform === "darwin" ? join(home, "Library", "Application Support", "Claude")
    : platform === "win32" ? join(absolute(env.APPDATA) ?? join(home, "AppData", "Roaming"), "Claude")
      : join(home, ".config", "Claude");
  const codexLabel = codexHome === join(home, ".codex") ? "~/.codex/skills" : "$CODEX_HOME/skills";
  return {
    codexHome,
    skills: [
      { source: "claudeCode", root: join(home, ".claude", "skills"), label: "~/.claude/skills" },
      { source: "codex", root: join(codexHome, "skills"), label: codexLabel },
    ] satisfies Array<{ source: SkillSource; root: string; label: string }>,
    tools: [
      { source: "claudeCode", path: join(home, ".claude.json"), format: "claudeJson", max: CLAUDE_JSON_MAX_BYTES },
      { source: "claudeDesktop", path: join(desktop, "claude_desktop_config.json"), format: "json", max: CONFIG_MAX_BYTES },
      { source: "cursor", path: join(home, ".cursor", "mcp.json"), format: "json", max: CONFIG_MAX_BYTES },
      { source: "codex", path: join(codexHome, "config.toml"), format: "toml", max: CONFIG_MAX_BYTES },
      { source: "gemini", path: join(home, ".gemini", "settings.json"), format: "json", max: CONFIG_MAX_BYTES },
    ] satisfies Array<{ source: SetupSource; path: string; format: ToolFormat; max: number }>,
  };
}

interface FoundSkill {
  name: string;
  source: SkillSource;
  parsed: ParsedSkill;
  /** The folder it is read from. */
  folder: string;
  /** The tool's skills folder, and the skill's own folder in it. */
  root: string;
  origin: string;
  /** Where it came from, as the bot's Skills settings show it. */
  label: string;
  text: string;
  sha256: string;
}

const MAX_SKILL_FOLDERS = 500;

const SECRET_WORDS = /(?:^|[^a-z])(?:o?auth|tokens?|sessions?|cookies?|passw\w*|secrets?|credentials?|api[-_]?keys?|keys?|bearer|storage[-_]?state|service[-_]?accounts?|private[-_]?keys?)(?:[^a-z]|$)/;
const SECRET_FOLDERS = /^(?:secrets?|credentials?|sessions?|cookies?|tokens?|keys?|private[-_]?keys?|service[-_]?accounts?)$/;
const KEY_STORES = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|keychain|keychain-db|sqlite3?|db|env)$|^id_(?:rsa|dsa|ecdsa|ed25519)/;
/** Data formats a credential is kept in. Instructions and code may well be named after one (credentials.md, auth.py). */
const DATA_EXTENSIONS = new Set(["json", "jsonc", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "txt", "text", "csv", "tsv", "xml"]);

/** A name inside a skill folder that holds a credential, a session or a key rather than instructions or code: it is left
 * out, decided before anything is opened. */
export function secretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_FOLDERS.test(lower) || KEY_STORES.test(lower)) return true;
  const dot = lower.lastIndexOf(".");
  return dot > 0 && DATA_EXTENSIONS.has(lower.slice(dot + 1)) && SECRET_WORDS.test(lower.slice(0, dot));
}

/** Folders macOS asks the person about before an app looks inside. */
const GUARDED_HOME_FOLDERS = new Set(["desktop", "documents", "downloads", "library", "movies", "music", "pictures"]);
const MAX_LINK_HOPS = 16;

interface Places {
  /** The home folder as given and as it really is: nothing outside them is looked at. */
  homes: string[];
  darwin: boolean;
  /** Where the tools keep their logins and history. */
  toolHomes: string[];
  /** Each skills folder that is safe to read, to where it really is. */
  roots: Map<string, string>;
  skillRoots: string[];
}

const within = (base: string, path: string) => {
  const rel = relative(base, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const samePath = (a: string, b: string) => relative(a, b) === "";

/** Where `path` really is, each link followed one at a time while it stays in the home folder and out of the folders
 * macOS guards; null when a link leads anywhere else, or nothing is there. Nothing outside is ever looked at. */
function locate(machine: SetupMachine, places: Pick<Places, "homes" | "darwin">, path: string): { path: string; info: Stats } | null {
  let current = resolve(path);
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops++) {
    const home = places.homes.find((candidate) => within(candidate, current));
    if (!home) return null;
    const parts = relative(home, current).split(/[\\/]/).filter(Boolean);
    if (places.darwin && parts.length && GUARDED_HOME_FOLDERS.has(parts[0]!.toLowerCase())) return null;
    let at = home;
    let info = machine.fs.lstat(home);
    let next: string | null = null;
    for (let index = 0; index < parts.length && next === null; index++) {
      at = join(at, parts[index]!);
      info = machine.fs.lstat(at);
      if (!info) return null;
      if (info.isSymbolicLink()) {
        const target = machine.fs.readlink(at);
        if (target === null) return null;
        next = resolve(dirname(at), target, ...parts.slice(index + 1));
      }
    }
    if (next === null) return info ? { path: at, info } : null;
    current = next;
  }
  return null;
}

function placesFor(machine: SetupMachine): Places {
  const real = machine.fs.realpath(machine.home);
  const homes = [...new Set([machine.home, ...(real ? [real] : [])])];
  const darwin = machine.platform === "darwin";
  /** A path under the home folder in each of its spellings, and where it really is. */
  const forms = (path: string) => {
    const rel = relative(machine.home, path);
    const spellings = rel.startsWith("..") || isAbsolute(rel) ? [path] : homes.map((home) => join(home, rel));
    const found = locate(machine, { homes, darwin }, path);
    return [...new Set([...spellings, ...(found ? [found.path] : [])])];
  };
  const paths = setupPaths(machine);
  const toolHomes = [join(machine.home, ".claude"), paths.codexHome, join(machine.home, ".gemini"), join(machine.home, ".cursor")].flatMap(forms);
  const roots = new Map<string, string>();
  for (const { root } of paths.skills) {
    const found = locate(machine, { homes, darwin }, root);
    // A skills folder that is the home folder or a tool's own folder (or holds one) would list their private files.
    if (!found?.info.isDirectory() || homes.some((home) => within(found.path, home)) || toolHomes.some((tool) => within(found.path, tool))) continue;
    roots.set(root, found.path);
  }
  return { homes, darwin, toolHomes, roots, skillRoots: [...roots.keys()].flatMap(forms) };
}

/** A skill folder must stay a skill folder wherever its link leads: never a skills folder itself, nor a place in a
 * tool's own folder (~/.claude, $CODEX_HOME, ~/.gemini, ~/.cursor) outside its skills. */
function skillFolderAllowed(places: Places, real: string): boolean {
  if (places.homes.some((home) => within(real, home)) || places.skillRoots.some((root) => samePath(root, real))) return false;
  return !places.toolHomes.some((tool) => within(tool, real)) || places.skillRoots.some((root) => within(root, real));
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Skill folders with a valid SKILL.md, Claude Code's first; a name found twice keeps its first folder. */
function findSkills(machine: SetupMachine): FoundSkill[] {
  const places = placesFor(machine);
  const found: FoundSkill[] = [];
  const names = new Set<string>();
  for (const { source, root, label } of setupPaths(machine).skills) {
    const real = places.roots.get(root);
    if (!real) continue;
    // Dot folders hold the tools' own built-in skills (Codex's .system), not the person's.
    const folders = (machine.fs.readdir(real) ?? []).filter((folder) => !folder.startsWith(".")).sort().slice(0, MAX_SKILL_FOLDERS);
    for (const folder of folders) {
      const dir = locate(machine, places, join(real, folder));
      if (!dir?.info.isDirectory() || !skillFolderAllowed(places, dir.path)) continue;
      const bytes = machine.fs.read(join(dir.path, "SKILL.md"), SKILL_FILE_MAX_BYTES, false);
      const text = bytes ? utf8(bytes) : null;
      const parsed = text === null ? null : parseSkillMd(text);
      if (!parsed || "error" in parsed || names.has(parsed.name)) continue;
      names.add(parsed.name);
      found.push({
        name: parsed.name, source, parsed, folder: dir.path, root, origin: join(root, folder), label: `${label}/${folder}`, text: text!, sha256: sha256(text!),
      });
    }
  }
  return found;
}

/** Copied beside SKILL.md: scripts, references and templates, as text. */
const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "mdx", "txt", "text", "rst", "adoc", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "sh", "bash", "zsh",
  "fish", "ps1", "bat", "cmd", "rb", "go", "rs", "java", "kt", "kts", "swift", "php", "pl", "lua", "r", "sql", "json",
  "jsonc", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "csv", "tsv", "xml", "xsd", "xsl", "xslt", "html", "htm",
  "css", "scss", "svg", "tex", "j2", "jinja", "jinja2", "tmpl", "tpl", "template", "hbs", "mustache", "graphql", "gql",
  "proto", "c", "h", "cc", "cpp", "hpp", "cs", "vue", "svelte", "dart", "scala", "ex", "exs", "hs", "clj", "el", "vim",
]);
const TEXT_NAMES = new Set(["makefile", "dockerfile", "license", "readme", "notice", "gemfile", "procfile", "justfile"]);
/** Installed dependencies, rebuilt where the skill runs; .git and .venv are dot folders, skipped already. */
const SKIPPED_FOLDERS = new Set(["node_modules", "__pycache__", "venv"]);

export const SKILL_COPY_LIMITS = {
  fileBytes: 512 * 1024,
  skillBytes: 4 * 1024 * 1024,
  skillFiles: 200,
  totalBytes: 48 * 1024 * 1024,
  depth: 6,
};

interface SkillFile {
  path: string;
  content: string;
  executable: boolean;
}

function textFile(name: string): boolean {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot > 0 ? TEXT_EXTENSIONS.has(lower.slice(dot + 1)) : TEXT_NAMES.has(lower);
}

const decoder = new TextDecoder("utf-8", { fatal: true });
function utf8(bytes: Buffer): string | null {
  try {
    const text = decoder.decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

/** The text files beside SKILL.md, within the limits. Links are never followed, a file with another hard link (which
 * may be a credential elsewhere) is not read, and one holding a credential is not copied; anything left out is counted. */
function skillFiles(fs: SetupFs, dir: string, budget: { bytes: number }): { files: SkillFile[]; leftOut: number } {
  const files: SkillFile[] = [];
  let leftOut = 0;
  let bytes = 0;
  const walk = (folder: string, relative: string, depth: number) => {
    for (const name of (fs.readdir(folder) ?? []).sort()) {
      if (name.startsWith(".")) continue;
      // Decided by name before anything is opened.
      if (secretName(name)) {
        leftOut += 1;
        continue;
      }
      const path = relative ? `${relative}/${name}` : name;
      // Read already; on a disk that ignores case, skill.md is that same file.
      if (!relative && name.toLowerCase() === "skill.md") continue;
      const full = join(folder, name);
      const info = fs.lstat(full);
      if (!info) continue;
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) {
        leftOut += 1;
      } else if (info.isDirectory()) {
        if (SKIPPED_FOLDERS.has(name.toLowerCase())) continue;
        if (depth >= SKILL_COPY_LIMITS.depth) leftOut += 1;
        else walk(full, path, depth + 1);
      } else if (info.isFile()) {
        const fits = textFile(name) && info.size <= SKILL_COPY_LIMITS.fileBytes && files.length < SKILL_COPY_LIMITS.skillFiles &&
          bytes + info.size <= SKILL_COPY_LIMITS.skillBytes && budget.bytes + info.size <= SKILL_COPY_LIMITS.totalBytes;
        const raw = fits ? fs.read(full, SKILL_COPY_LIMITS.fileBytes, false, true) : null;
        const content = raw ? utf8(raw) : null;
        if (content === null || holdsCredential(content)) {
          leftOut += 1;
          continue;
        }
        files.push({ path, content, executable: (info.mode & 0o111) !== 0 });
        bytes += raw!.length;
        budget.bytes += raw!.length;
      }
    }
  };
  walk(dir, "", 0);
  return { files, leftOut };
}

/** The same skill from the same folder, already here and unchanged. */
function alreadyHere(skill: FoundSkill, held: ImportedSkillEntry | undefined): boolean {
  return Boolean(held) && held!.origin === skill.origin && held!.sha256 === skill.sha256 && importedSkillIntact(skill.name, held!);
}

/** New, or changed since it was brought in; a name another folder's skill already holds is not offered. */
function freshSkill(skill: FoundSkill, held: ImportedSkillEntry | undefined): boolean {
  return !held || (held.origin === skill.origin && !alreadyHere(skill, held));
}

const MAX_WARNINGS = 20;

/** The scan over SKILL.md and every file copied beside it, which can hold the same instructions. */
function skillWarnings(skillMd: string, files: readonly SkillFile[]): string[] {
  const all = [...scanSkillText(skillMd), ...files.flatMap((file) => scanSkillText(file.content).map((warning) => `${file.path}: ${warning}`))];
  const unique = [...new Set(all)];
  return unique.length > MAX_WARNINGS ? [...unique.slice(0, MAX_WARNINGS), `${unique.length - MAX_WARNINGS} more warnings in its files`] : unique;
}

/** A found skill as an import stores it: SKILL.md and the text files beside it, with the scan's warnings. */
function skillInput(machine: SetupMachine, skill: FoundSkill, budget: { bytes: number }): { input: ImportedSkillInput; leftOut: number } {
  const copy = skillFiles(machine.fs, skill.folder, budget);
  return {
    leftOut: copy.leftOut,
    input: {
      name: skill.name,
      skillMd: skill.text,
      files: copy.files,
      entry: {
        description: skill.parsed.description,
        source: skill.source,
        root: skill.root,
        origin: skill.origin,
        label: skill.label,
        sha256: skill.sha256,
        warnings: skillWarnings(skill.text, copy.files),
        ...(skill.parsed.license ? { license: skill.parsed.license } : {}),
        ...(skill.parsed.compatibility ? { compatibility: skill.parsed.compatibility } : {}),
      },
    },
  };
}

/** The person's own Claude Code skills, read as an import reads them, for a server that cannot see this computer's
 * ~/.claude/skills: it keeps them as imported skills. */
export function claudeCodeSkillInputs(machine: SetupMachine = thisMachine()): ImportedSkillInput[] {
  const budget = { bytes: 0 };
  return findSkills(machine).filter((skill) => skill.source === "claudeCode").map((skill) => skillInput(machine, skill, budget).input);
}

/** One copy for every bot, made once however many bots there are or will be. One the scan flags comes in switched off:
 * a person switches it on for a bot after reading it, as with any other import. */
function importSkills(machine: SetupMachine): NonNullable<SetupImportResult["skills"]> {
  const index = readImportedSkills();
  const budget = { bytes: 0 };
  const result: NonNullable<SetupImportResult["skills"]> = { added: [], present: [], skipped: [], filesLeftOut: 0, review: [] };
  const skip = (name: string, reason: SkillSkip) => result.skipped.push({ name, reason });
  const inputs: ImportedSkillInput[] = [];
  for (const skill of findSkills(machine)) {
    const held = index[skill.name];
    if (alreadyHere(skill, held)) {
      result.present.push(skill.name);
      continue;
    }
    if (held && held.origin !== skill.origin) {
      skip(skill.name, "conflict");
      continue;
    }
    const { input, leftOut } = skillInput(machine, skill, budget);
    result.filesLeftOut += leftOut;
    inputs.push(input);
  }
  const flagged = new Set(inputs.filter((one) => one.entry.warnings.length).map((one) => one.name));
  for (const stored of storeImportedSkills(inputs)) {
    result.filesLeftOut += stored.leftOut;
    if (!stored.stored) skip(stored.name, "failed");
    else {
      result.added.push(stored.name);
      if (flagged.has(stored.name)) result.review.push(stored.name);
    }
  }
  return result;
}

interface FoundTool {
  name: string;
  source: SetupSource;
  server: StoredMcpServer;
  identity: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function skipString(text: string, start: number): number {
  for (let at = start + 1; ;) {
    const quote = text.indexOf('"', at);
    if (quote < 0) return -1;
    let slashes = 0;
    while (text[quote - 1 - slashes] === "\\") slashes++;
    if (slashes % 2 === 0) return quote + 1;
    at = quote + 1;
  }
}

function skipValue(text: string, start: number): number {
  if (text[start] === '"') return skipString(text, start);
  if (text[start] !== "{" && text[start] !== "[") {
    let at = start;
    while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at++;
    return at > start ? at : -1;
  }
  let depth = 0;
  for (let at = start; at < text.length;) {
    const char = text[at]!;
    if (char === '"') {
      at = skipString(text, at);
      if (at < 0) return -1;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return at + 1;
    }
    at++;
  }
  return -1;
}

/** One top-level member's value, found by skipping every other member unparsed; null when absent or malformed. */
export function topLevelJsonMember(text: string, name: string): unknown {
  const spaces = (at: number) => {
    while (at < text.length && /\s/.test(text[at]!)) at++;
    return at;
  };
  let at = spaces(text.charCodeAt(0) === 0xfeff ? 1 : 0);
  if (text[at] !== "{") return null;
  let found: string | null = null;
  at = spaces(at + 1);
  if (text[at] === "}") return null;
  for (;;) {
    if (text[at] !== '"') return null;
    const keyEnd = skipString(text, at);
    if (keyEnd < 0) return null;
    let key: unknown;
    try { key = JSON.parse(text.slice(at, keyEnd)); } catch { return null; }
    at = spaces(keyEnd);
    if (text[at] !== ":") return null;
    at = spaces(at + 1);
    const valueEnd = skipValue(text, at);
    if (valueEnd < 0) return null;
    // The last of a repeated member wins, as in JSON.parse.
    if (key === name) found = text.slice(at, valueEnd);
    at = spaces(valueEnd);
    if (text[at] === ",") {
      at = spaces(at + 1);
      continue;
    }
    if (text[at] !== "}" || found === null) return null;
    try { return JSON.parse(found); } catch { return null; }
  }
}

/** Gemini CLI and some editors allow comments in their settings JSON. */
export function withoutJsonComments(text: string): string {
  let out = "";
  for (let at = 0; at < text.length;) {
    const char = text[at]!;
    if (char === '"') {
      const end = skipString(text, at);
      if (end < 0) return out + text.slice(at);
      out += text.slice(at, end);
      at = end;
    } else if (char === "/" && text[at + 1] === "/") {
      while (at < text.length && text[at] !== "\n") at++;
    } else if (char === "/" && text[at + 1] === "*") {
      const end = text.indexOf("*/", at + 2);
      at = end < 0 ? text.length : end + 2;
    } else {
      out += char;
      at++;
    }
  }
  return out;
}

/** Cursor and others accept a comma before a closing bracket; JSON.parse does not. */
export function withoutTrailingCommas(text: string): string {
  let out = "";
  for (let at = 0; at < text.length;) {
    const char = text[at]!;
    if (char === '"') {
      const end = skipString(text, at);
      if (end < 0) return out + text.slice(at);
      out += text.slice(at, end);
      at = end;
      continue;
    }
    if (char === ",") {
      let next = at + 1;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      if (text[next] === "}" || text[next] === "]") {
        at += 1;
        continue;
      }
    }
    out += char;
    at++;
  }
  return out;
}

/** Strings, numbers and booleans as text; anything else is dropped. */
function textValues(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") out[key] = String(entry);
  }
  return out;
}

/** Each tool's entry in the {"mcpServers": …} shape Paste config takes. Token variables are not resolved: the person
 * adds the token as a header when they test the server. */
function pasteEntry(source: SetupSource, raw: Record<string, unknown>): Record<string, unknown> {
  const headers = textValues(source === "codex" ? raw.http_headers : raw.headers);
  const remote = (type: "http" | "sse", url: unknown) => ({ type, url, ...(headers ? { headers } : {}) });
  if (source === "gemini") {
    if (typeof raw.httpUrl === "string") return remote("http", raw.httpUrl);
    if (typeof raw.url === "string") return remote(raw.type === "http" ? "http" : "sse", raw.url);
  } else if (typeof raw.url === "string") {
    return remote(typeof raw.type === "string" && /sse/i.test(raw.type) ? "sse" : "http", raw.url);
  }
  const env = textValues(raw.env);
  return {
    command: raw.command,
    ...(Array.isArray(raw.args) ? { args: raw.args.map((arg) => (typeof arg === "number" ? String(arg) : arg)) } : {}),
    ...(env ? { env } : {}),
  };
}

function identity(server: StoredMcpServer): string {
  if (!isRemoteMcpServer(server)) return `command ${JSON.stringify([server.command, ...server.args])}`;
  try {
    return `url ${new URL(server.url).href}`;
  } catch {
    return `url ${server.url.trim()}`;
  }
}

/** The raw {name: entry} map one tool keeps; null when the file is missing or cannot be read. */
function toolEntries(machine: SetupMachine, tool: ReturnType<typeof setupPaths>["tools"][number]): Record<string, unknown> | null {
  const bytes = machine.fs.read(tool.path, tool.max);
  const text = bytes ? utf8(bytes) : null;
  if (text === null) return null;
  try {
    if (tool.format === "claudeJson") {
      const servers = topLevelJsonMember(text, "mcpServers");
      return isRecord(servers) ? servers : null;
    }
    const parsed: unknown = tool.format === "toml" ? parseToml(text) : JSON.parse(withoutTrailingCommas(withoutJsonComments(text)));
    const servers = isRecord(parsed) ? parsed[tool.format === "toml" ? "mcp_servers" : "mcpServers"] : undefined;
    return isRecord(servers) ? servers : null;
  } catch {
    return null;
  }
}

/** One tool's entry as Paste config reads it; null for one it cannot, which leaves the others alone. */
function foundTool(source: SetupSource, rawName: string, raw: Record<string, unknown>): FoundTool | null {
  try {
    const parsed = parseMcpServersImport(JSON.stringify({ mcpServers: { [importedMcpServerName(rawName)]: pasteEntry(source, raw) } }));
    if (!parsed.ok) return null;
    const [name, server] = Object.entries(parsed.servers)[0]!;
    return { name, source, server, identity: identity(server) };
  } catch {
    return null;
  }
}

/** Every server the tools list, normalised and switched off by Paste config's parser, sorted into new, already here,
 * named like a different one here, and refused by the organization; a server two tools list is kept once. */
function findTools(machine: SetupMachine, current: Record<string, unknown>, host: Pick<SetupHost, "mcpPolicyRefusal" | "claudeUserMcp">) {
  const existing = Object.entries(current).flatMap(([name, raw]) => {
    const parsed = parseStoredMcpServer(name, raw);
    return parsed.ok ? [identity(parsed.server)] : [];
  });
  const takenNames = new Set(Object.keys(current));
  const takenIds = new Set(existing);
  const seenNames = new Set<string>();
  const seenIds = new Set<string>();
  const fresh: FoundTool[] = [];
  const present: FoundTool[] = [];
  const conflicts: FoundTool[] = [];
  const refused: FoundTool[] = [];
  const inPlace = host.claudeUserMcp?.() === true;
  for (const tool of setupPaths(machine).tools) {
    if (inPlace && tool.source === "claudeCode") continue;
    const entries = toolEntries(machine, tool);
    for (const [rawName, raw] of Object.entries(entries ?? {})) {
      if (!isRecord(raw)) continue;
      const found = foundTool(tool.source, rawName, raw);
      if (!found || seenNames.has(found.name) || seenIds.has(found.identity)) continue;
      seenNames.add(found.name);
      seenIds.add(found.identity);
      if (takenIds.has(found.identity)) present.push(found);
      else if (takenNames.has(found.name)) conflicts.push(found);
      else if (host.mcpPolicyRefusal(found.name, found.server)) refused.push(found);
      else fresh.push(found);
    }
  }
  return { fresh, present, conflicts, refused };
}

function importTools(machine: SetupMachine, host: SetupHost): NonNullable<SetupImportResult["tools"]> {
  const skipped = (tools: FoundTool[], reason: ToolSkip) => tools.map((tool) => ({ name: tool.name, reason }));
  // Single-flight with the MCP servers routes: a read of the list must not interleave with another save.
  if (host.mcpConfigBusy.get()) {
    return { added: [], present: [], skipped: skipped(findTools(machine, host.mcpServers(), host).fresh, "busy") };
  }
  host.mcpConfigBusy.set(true);
  try {
    const current = host.mcpServers();
    const { fresh, present, conflicts, refused } = findTools(machine, current, host);
    const room = Math.max(0, MAX_MCP_SERVERS - Object.keys(current).length);
    const adding = fresh.slice(0, room);
    let saved = true;
    if (adding.length) {
      try {
        host.persistMcpServers({ ...current, ...Object.fromEntries(adding.map((tool) => [tool.name, { ...tool.server, enabled: false }])) });
      } catch {
        saved = false;
      }
    }
    return {
      added: saved ? adding.map((tool) => tool.name) : [],
      present: present.map((tool) => tool.name),
      skipped: [
        ...(saved ? [] : skipped(adding, "failed")), ...skipped(fresh.slice(room), "limit"), ...skipped(conflicts, "conflict"),
        ...skipped(refused, "policy"),
      ],
    };
  } finally {
    host.mcpConfigBusy.set(false);
  }
}

/** What is new here, by name and source; an empty list when nothing is. */
export function detectSetup(machine: SetupMachine, host: SetupHost): SetupDetection {
  const index = readImportedSkills();
  const skills = findSkills(machine).filter((skill) => freshSkill(skill, index[skill.name])).map(({ name, source }) => ({ name, source }));
  const current = host.mcpServers();
  const tools = Object.keys(current).length < MAX_MCP_SERVERS
    ? findTools(machine, current, host).fresh.map(({ name, source }) => ({ name, source }))
    : [];
  return { skills, tools };
}

/** Each kind on its own: one that fails reports what it was bringing in as failed, and the other still comes in. */
export function applySetupImport(machine: SetupMachine, host: SetupHost, request: SetupImportRequest): SetupImportResult {
  const failed = <Reason extends string>(names: () => string[], reason: Reason) => {
    try {
      return names().map((name) => ({ name, reason }));
    } catch {
      return [];
    }
  };
  const skills = (): NonNullable<SetupImportResult["skills"]> => {
    try {
      return importSkills(machine);
    } catch {
      return { added: [], present: [], skipped: failed(() => findSkills(machine).map((skill) => skill.name), "failed"), filesLeftOut: 0, review: [] };
    }
  };
  const tools = (): NonNullable<SetupImportResult["tools"]> => {
    try {
      return importTools(machine, host);
    } catch {
      return { added: [], present: [], skipped: failed(() => findTools(machine, host.mcpServers(), host).fresh.map((tool) => tool.name), "failed") };
    }
  };
  return {
    ...(request.skills ? { skills: skills() } : {}),
    ...(request.tools ? { tools: tools() } : {}),
  };
}
