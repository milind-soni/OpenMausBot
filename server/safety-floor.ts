// A never-list of shell commands the server will not approve by itself at any approval level. Rules lean towards
// letting a command through; words used as data (an echo, a commit message, a heredoc body) are never a command.
// Security invariant: a line not read to its end is "could not read", never "clear"; a block found before that stands.

export type FloorRule = "delete-root" | "delete-home" | "delete-system-directory" | "format-disk" | "overwrite-disk" | "fork-bomb";

export interface FloorVerdict {
  /** Which rule matched: a stable name, for the decision log. */
  rule: FloorRule;
  /** Words a person reads; never the command itself, which may hold a credential. */
  label: string;
}

const DELETE_ROOT: FloorVerdict = { rule: "delete-root", label: "recursive delete of the filesystem root" };
const DELETE_DRIVE: FloorVerdict = { rule: "delete-root", label: "recursive delete of a drive root" };
const DELETE_HOME: FloorVerdict = { rule: "delete-home", label: "recursive delete of the home directory" };
const FORMAT_DISK: FloorVerdict = { rule: "format-disk", label: "formatting a disk" };
const OVERWRITE_DISK: FloorVerdict = { rule: "overwrite-disk", label: "overwriting a disk device" };
const FORK_BOMB: FloorVerdict = { rule: "fork-bomb", label: "a fork bomb" };
const deleteSystem = (name: string): FloorVerdict => ({ rule: "delete-system-directory", label: `recursive delete of ${name}` });

const SYSTEM_DIRECTORIES = [
  "/etc", "/usr", "/bin", "/sbin", "/var", "/boot", "/home", "/lib", "/lib32", "/lib64", "/libx32", "/lib*",
  "/System", "/Library", "/Applications", "/Users",
];
/** macOS keeps `/etc` and `/var` under `/private`; elsewhere `/private` is an ordinary directory. */
const MAC_DIRECTORIES = ["/private", "/private/etc", "/private/var"];
const WINDOWS_DIRECTORIES = new Map([
  ["windows", "Windows"], ["users", "Users"], ["program files", "Program Files"],
  ["program files (x86)", "Program Files (x86)"], ["programdata", "ProgramData"],
]);
const deleteWindowsSystem = (name: string): FloorVerdict => deleteSystem(`a Windows system folder (${name})`);

/** Lexed marker for the home directory: an unquoted `~` (a quoted `'~'` is only a name), `$HOME`, `%USERPROFILE%`. */
const HOME = "\uE000";
/** Lexed marker for anything else substituted at run time; a word holding it is unknown. */
const DYNAMIC = "\uE001";
const MARKERS = /[\uE000\uE001]/g;

const WINDOWS_VARIABLES: Record<string, string> = {
  userprofile: HOME, home: HOME,
  systemdrive: "C:", homedrive: "C:",
  systemroot: "C:\\Windows", windir: "C:\\Windows",
  programfiles: "C:\\Program Files", "programfiles(x86)": "C:\\Program Files (x86)",
  programdata: "C:\\ProgramData", allusersprofile: "C:\\ProgramData",
};

/** Disks, partitions, RAID arrays and mapped volumes; the rest of /dev (null, ttys, serial ports) is fine to write. */
const DISK_DEVICE = /^\/dev\/(?:r?disk\d+(?:s\d+)*|disk\/.+|sd[a-z]{1,3}\d*|hd[a-z]\d*|x?vd[a-z]{1,2}\d*|nvme\d+(?:n\d+)?(?:p\d+)?|mmcblk\d+(?:p\d+)?|md\d+(?:p\d+)?|md\/[^/]+|dm-\d+|mapper\/(?!loop\d)[^/]+)$/;
const diskDevice = (word: string): boolean => DISK_DEVICE.test(word.replace(/\/{2,}/g, "/"));
/** Devices a disk image is built on: loop, RAM, network block, zram, and loop partitions under /dev/mapper. */
const SCRATCH_DEVICE = /^\/dev\/(?:mapper\/)?(?:loop|ram|nbd|zram)\d/;
/** mkfs on any device but a scratch one erases it; an image file or a variable's value is not known to be a device. */
const formatsDevice = (word: string): boolean => {
  const path = word.replace(/\/{2,}/g, "/");
  return path.startsWith("/dev/") && path.length > 5 && !path.includes(HOME) && !path.includes(DYNAMIC) && !SCRATCH_DEVICE.test(path);
};

// A function that pipes itself into itself in the background, then runs; the name is bounded to keep the regex cheap.
const BOMB_BODY = String.raw`\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;?\s*\1(?![\w:.-])`;
const BOMB_NAME = String.raw`([A-Za-z_:.][\w:.-]{0,63})`;
const FORK_BOMBS = [
  new RegExp(String.raw`(?:^|[\s;&|(){}])${BOMB_NAME}\s*\(\s*\)${BOMB_BODY}`),
  new RegExp(String.raw`(?:^|[\s;&|(){}])function\s+${BOMB_NAME}\s*(?:\(\s*\))?${BOMB_BODY}`),
];

interface Command {
  /** Quotes removed; substitutions appear as HOME or DYNAMIC. */
  words: string[];
  starts: number[];
  /** Redirection targets. */
  writes: string[];
  from: number;
  to: number;
}

interface Reading {
  commands: Command[];
  /** The text outside every quote, heredoc and comment. */
  bare: string;
  /** False when something never closed or nested too deep: the rest was not read. */
  synced: boolean;
}

const MAX_NESTING = 40;
/** Shell words that precede a command without being one. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"]);

/** Splits a command line into every simple command a shell would run, in linear time. `windows`: cmd escapes with
 * `^` and PowerShell with a backtick, so a backslash there is an ordinary character. */
function lex(source: string, windows: boolean): Reading {
  const commands: Command[] = [];
  const heredocs: Array<{ end: string; tabs: boolean }> = [];
  let bare = "";
  let at = 0;
  let nesting = 0;
  let synced = true;

  const variable = (name: string): string => {
    // ${HOME:?} and ${HOME?message} are $HOME, or an error when it is unset.
    if (!windows) return /^HOME(?::?\?[^}]*)?$/.test(name) ? HOME : DYNAMIC;
    const key = name.toLowerCase();
    if (key === "home") return HOME;
    return key.startsWith("env:") ? WINDOWS_VARIABLES[key.slice(4)] ?? DYNAMIC : DYNAMIC;
  };

  /** Returns the text up to the matching `shut`. Inside `"${…}"` double quotes still quote but `'` is literal. */
  const balanced = (open: string, shut: string, inDoubleQuotes: boolean): string => {
    const from = at;
    for (let depth = 1; at < source.length; at++) {
      const c = source[at];
      if (c === "\\" && !windows) at++;
      else if (c === "'" && !inDoubleQuotes) at = endOf("'", at + 1);
      else if (c === '"') {
        for (at++; at < source.length && source[at] !== '"'; at++) if (source[at] === "\\" && !windows) at++;
      } else if (c === open) depth++;
      else if (c === shut && --depth === 0) return source.slice(from, at++);
    }
    synced = false;
    return source.slice(from);
  };
  const endOf = (mark: string, from: number): number => {
    const found = source.indexOf(mark, from);
    return found === -1 ? source.length : found;
  };

  const variableAt = (inDoubleQuotes: boolean): string => {
    const next = source[at + 1];
    if (next === "{") {
      at += 2;
      return variable(balanced("{", "}", inDoubleQuotes));
    }
    if (next === "'" && !windows && !inDoubleQuotes) {
      // $'…' decodes escapes such as \x2f, so its text is not read here.
      for (at += 2; at < source.length && source[at] !== "'"; at++) if (source[at] === "\\") at++;
      if (at >= source.length) synced = false;
      at++;
      return DYNAMIC;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(at + 1, at + 130))?.[0];
    if (name) {
      at += 1 + name.length;
      const scoped = windows && name.toLowerCase() === "env" ? /^:[A-Za-z0-9_]+/.exec(source.slice(at, at + 130))?.[0] : undefined;
      if (scoped) at += scoped.length;
      return variable(name + (scoped ?? ""));
    }
    if (next !== undefined && /[0-9@*#?$!_-]/.test(next)) {
      at += 2;
      return DYNAMIC;
    }
    at++;
    return "$";
  };

  /** Reads commands until `close`; false when it ended anywhere else. */
  function script(close: string | null): boolean {
    let command: Command = { words: [], starts: [], writes: [], from: at, to: at };
    // Assigned in closures, which TypeScript's narrowing does not follow.
    let word = null as string | null;
    let wordAt = 0;
    let token = 0;
    let next: "argument" | "write" | "read" | "heredoc" | "heredoc-tabs" = "argument";
    let depth = 0;

    const add = (text: string) => {
      if (word === null) {
        word = "";
        wordAt = token;
      }
      word += text;
    };
    const endWord = () => {
      if (word === null) return;
      if (next === "argument") {
        command.words.push(word);
        command.starts.push(wordAt);
      } else if (next === "write") command.writes.push(word);
      else if (next !== "read") heredocs.push({ end: word, tabs: next === "heredoc-tabs" });
      word = null;
      next = "argument";
    };
    const cut = (skip: number) => {
      endWord();
      next = "argument";
      command.to = at;
      if (command.words.length || command.writes.length) commands.push(command);
      at += skip;
      command = { words: [], starts: [], writes: [], from: at, to: at };
    };
    const nested = (shut: string) => {
      if (++nesting > MAX_NESTING) {
        at = source.length;
        synced = false;
      } else if (!script(shut)) synced = false;
      nesting--;
    };
    const quoted = () => {
      while (at < source.length) {
        const c = source[at];
        const after = source[at + 1];
        if (c === '"') {
          at++;
          return;
        }
        if (!windows && c === "\\" && after !== undefined && "$`\"\\\n".includes(after)) {
          if (after !== "\n") add(after);
          at += 2;
        } else if (windows && c === "`" && after !== undefined) {
          add(after);
          at += 2;
        } else if (c === "$") add(dollar(true));
        else if (c === "`" && !windows) {
          at++;
          nested("`");
          add(DYNAMIC);
        } else {
          add(c);
          at++;
        }
      }
      synced = false;
    };
    const dollar = (inDoubleQuotes: boolean): string => {
      if (source[at + 1] !== "(") return variableAt(inDoubleQuotes);
      at += 2;
      nested(")");
      return DYNAMIC;
    };

    while (at < source.length) {
      const c = source[at];
      const after = source[at + 1];
      token = at;
      if (c === close && depth === 0) {
        cut(1);
        return true;
      }
      if (windows ? c === "^" || c === "`" : c === "\\") {
        // An escaped newline continues the line; anything else is itself.
        if (after !== "\n" && after !== undefined) add(after);
        at += 2;
      } else if (c === "'") {
        const end = endOf("'", at + 1);
        if (end === source.length) synced = false;
        add(source.slice(at + 1, end));
        at = end + 1;
      } else if (c === '"') {
        add("");
        at++;
        quoted();
      } else if (c === "$") add(dollar(false));
      else if (c === "`") {
        at++;
        nested("`");
        add(DYNAMIC);
      } else if (c === " " || c === "\t" || c === "\r") {
        endWord();
        bare += c;
        at++;
      } else if (c === "\n") {
        cut(1);
        bare += c;
        // A heredoc body is input, not commands.
        for (const heredoc of heredocs.splice(0)) {
          let ended = false;
          while (at < source.length && !ended) {
            const end = endOf("\n", at);
            const line = source.slice(at, end).replace(/\r$/, "");
            at = Math.min(end + 1, source.length);
            ended = (heredoc.tabs ? line.replace(/^\t+/, "") : line) === heredoc.end;
          }
          if (!ended) synced = false;
        }
        command.from = command.to = at;
      } else if (c === "#" && word === null) at = endOf("\n", at);
      else if (c === ";" || c === "|" || (c === "&" && after !== ">")) {
        bare += c;
        cut(1);
      } else if (c === "(" && word !== null && !/^\s*\)/.test(source.slice(at + 1, at + 40))
        && !(command.words.length === 0 && (KEYWORDS.has(word) || word === "time"))) {
        // Inside a word `( … )` is data (`name=( … )`, `logs/(old|tmp)`), except `name()`, which defines a function,
        // and a leading keyword (`then(…)`, `if(…)`), which is followed by a subshell.
        at++;
        balanced("(", ")", false);
        add(DYNAMIC);
      } else if (c === "(" || c === ")") {
        bare += c;
        depth = Math.max(0, depth + (c === "(" ? 1 : -1));
        cut(1);
      } else if ((c === "<" || c === ">") && after === "(") {
        at += 2;
        nested(")");
        add(DYNAMIC);
      } else if (c === "<" || c === ">" || c === "&") {
        // Digits right before a redirection name a descriptor (2>).
        if (word !== null && /^\d+$/.test(word)) word = null;
        else endWord();
        bare += c;
        at += c === "&" ? 2 : 1;
        const duplicate = () => {
          const descriptor = /^&[\d-]+/.exec(source.slice(at, at + 12))?.[0];
          if (descriptor) at += descriptor.length;
          else if (source[at] === "&") at++;
          return Boolean(descriptor);
        };
        if (c !== "<") {
          if (source[at] === ">" || source[at] === "|") at++;
          next = duplicate() ? "argument" : "write";
        } else if (source[at] === "<") {
          at++;
          const hereString = source[at] === "<" || windows;
          const tabs = !hereString && source[at] === "-";
          if (source[at] === "<" || tabs) at++;
          next = hereString ? "read" : tabs ? "heredoc-tabs" : "heredoc";
        } else if (source[at] === ">") {
          at++;
          next = "write";
        } else next = duplicate() ? "argument" : "read";
      } else if (c === "~" && word === null) {
        // `~` and `~/…` are the home directory; `~name` is somebody else's.
        add(after === undefined || /[\s/;&|()<>`]/.test(after) || (windows && after === "\\") ? HOME : DYNAMIC);
        bare += c;
        at++;
      } else {
        add(c);
        bare += c;
        at++;
      }
    }
    cut(0);
    if (depth > 0) synced = false;
    return close === null;
  }

  script(null);
  if (heredocs.length) synced = false;
  return { commands, bare, synced };
}

/** Commands that run the command after them. `values`/`named`: options taking a value; `asks`: options that only
 * report on the command; `split`: the option whose value is more arguments (`env -S`). */
const PREFIXES: Record<string, { values?: string; named?: string[]; operands?: number; asks?: string; asksNamed?: string[]; split?: { letter: string; named: string } }> = {
  // `sudo -l rm` lists whether rm may be run; it runs nothing.
  sudo: { values: "CDghpRrtTUu", named: ["user", "group", "host", "prompt", "chdir", "chroot", "role", "type", "other-user", "close-from", "command-timeout"], asks: "l", asksNamed: ["list"] },
  doas: { values: "Cu" },
  env: { values: "uCS", named: ["unset", "chdir", "split-string"], split: { letter: "S", named: "split-string" } },
  nice: { values: "n", named: ["adjustment"] },
  timeout: { values: "ks", named: ["kill-after", "signal"], operands: 1 },
  exec: { values: "a" },
  // `command -v rm` looks a command up; it does not run it.
  command: { asks: "vV" },
  nohup: {}, time: {}, builtin: {}, busybox: {},
};
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);
/** How deep wrappers are followed (`sh -c "bash -c …"`). */
const MAX_DEPTH = 4;
/** A longer command line is reported as not read, without being scanned. */
export const MAX_COMMAND_LENGTH = 32 * 1024;

function programName(word: string): string {
  return word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1).toLowerCase().replace(/\.(?:exe|com|cmd|bat)$/, "");
}

/** The words `env -S` makes of its value, or null: env itself expands `$NAME`, backslash escapes and `#` comments. */
function splitWords(value: string | undefined): string[] | null {
  if (value === undefined) return [];
  if (/[$\\#]/.test(value) || value.includes(DYNAMIC)) return null;
  const words: string[] = [];
  let word: string | null = null;
  let quote = "";
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = "";
      else word = (word ?? "") + char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? "") + char;
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words;
}

/** Index of the command word past assignments, keywords and prefix commands, or -1. Rewrites `env -S LINE` in
 * `words` into the arguments env makes of it, and calls `unread` when it cannot. */
function commandIndex(words: string[], unread: () => void): number {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (ASSIGNMENT.test(word) || KEYWORDS.has(word)) {
      index++;
      continue;
    }
    if (word === "function") {
      index += 2;
      continue;
    }
    const prefix = PREFIXES[programName(word)];
    if (!prefix) return index;
    index++;
    while (index < words.length && /^-./.test(words[index])) {
      const option = words[index++];
      if (option === "--") break;
      // GNU env reads LINE in `-S LINE`, `-SLINE` or `--split-string=LINE` (any start of the name) as more arguments.
      let line: string | undefined;
      let spliced = 0;
      if (option.startsWith("--")) {
        if (prefix.asksNamed?.includes(option.slice(2))) return -1;
        const equals = option.indexOf("=");
        const name = option.slice(2, equals < 0 ? undefined : equals);
        if (name && prefix.split?.named.startsWith(name)) {
          line = equals < 0 ? words[index] : option.slice(equals + 1);
          spliced = equals < 0 ? 2 : 1;
        } else {
          if (prefix.named?.includes(option.slice(2))) index++;
          // getopt_long accepts any unambiguous start (`sudo --us root`), so the next word may be its value: never clear.
          else if (name && equals < 0 && prefix.named?.some((known) => known.startsWith(name))) unread();
          continue;
        }
      } else {
        // The first letter taking a value ends a cluster: the value is the rest (-uroot) or the next word (-nu root).
        const letters = option.slice(1).split("");
        const value = letters.findIndex((letter) => prefix.values?.includes(letter));
        if (letters.slice(0, value < 0 ? undefined : value).some((letter) => prefix.asks?.includes(letter))) return -1;
        if (value >= 0 && letters[value] === prefix.split?.letter) {
          const rest = option.slice(value + 2);
          line = rest || words[index];
          spliced = rest ? 1 : 2;
        } else {
          if (value === letters.length - 1) index++;
          continue;
        }
      }
      const parts = splitWords(line);
      if (!parts) {
        unread();
        return -1;
      }
      words.splice(--index, spliced, ...parts);
    }
    index += prefix.operands ?? 0;
  }
  return -1;
}

/** The command line a shell is handed with `-c`, or null. */
function inlineScript(args: string[]): string | null {
  let inline = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue;
    if (/^--[a-z-]+$/.test(arg)) {
      if (arg === "--rcfile" || arg === "--init-file") index++;
    } else if (/^[-+][A-Za-z]+$/.test(arg)) {
      if (arg[0] === "-" && arg.includes("c")) inline = true;
      // -o pipefail and -O extglob take a value
      if (/[oO]$/.test(arg)) index++;
    } else return inline ? arg : null;
  }
  return null;
}

/** What `rm` deletes, or null when not recursive. GNU rm takes options on either side of the paths. */
function rmTargets(args: string[]): string[] | null {
  const targets: string[] = [];
  let recursive = false;
  let operandsOnly = false;
  for (const arg of args) {
    if (operandsOnly || !/^-./.test(arg)) targets.push(arg);
    else if (arg === "--") operandsOnly = true;
    // -r or -R, alone or in a cluster of rm's letters; --recursive or any start of it GNU rm accepts.
    else if (/^-[dfiIPvWx]*[rR][dfiIPRrvWx]*$/.test(arg) || (arg.length > 2 && "--recursive".startsWith(arg))) recursive = true;
  }
  return recursive ? targets : null;
}

/** Resolves `.` and `..` by spelling and drops a final `*`; `above` counts steps past the start. */
function resolved(segments: string[]): { parts: string[]; above: number } {
  const parts: string[] = [];
  let above = 0;
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") parts.push(segment);
    else if (parts.length) parts.pop();
    else above++;
  }
  if (parts.at(-1) === "*" || parts.at(-1) === "*.*") parts.pop();
  return { parts, above };
}

interface Host {
  /** macOS and Windows find `/ETC` where Linux does not. */
  foldCase: boolean;
  mac: boolean;
  windows: boolean;
  home?: string;
}

/** A home under a temp directory (HOME=/tmp in a container) is not matched by path: deleting it is cleanup.
 * `~` and `$HOME` still mean home. */
const SCRATCH_HOME = /^(?:\/private)?\/(?:tmp|var\/tmp|var\/folders)(?:\/|$)|^\/dev\/shm(?:\/|$)|^[A-Za-z]:[\\/](?:te?mp|windows[\\/]temp)(?:[\\/]|$)|[\\/]appdata[\\/]local[\\/]temp(?:[\\/]|$)/i;

/** The rule a recursive delete of this POSIX path meets, or null. */
function posixTarget(word: string, host: Host): FloorVerdict | null {
  if (word.includes(DYNAMIC)) return null;
  const fromHome = word.startsWith(HOME);
  const path = fromHome ? word.slice(1) : word;
  if (path.includes(HOME) || !(path.startsWith("/") || (fromHome && path === ""))) return null;
  const { parts } = resolved(path.split("/"));
  // `~/..` holds home; `~/../name` cannot be placed, so it is allowed.
  if (fromHome) return parts.length ? null : DELETE_HOME;
  if (!parts.length) return DELETE_ROOT;
  const spelled = `/${parts.join("/")}`;
  const same = (left: string, right: string) => host.foldCase ? left.toLowerCase() === right.toLowerCase() : left === right;
  const system = [...SYSTEM_DIRECTORIES, ...(host.mac ? MAC_DIRECTORIES : [])].find((directory) => same(directory, spelled));
  if (system) return deleteSystem(system);
  // Git Bash spells C:\Users\me as /c/Users/me.
  const home = host.home?.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`).replace(/\/+$/, "");
  if (home?.startsWith("/") && same(home, spelled)) return DELETE_HOME;
  // In Git Bash a one-letter root directory is a drive. WSL's /mnt/c is not read: elsewhere it is any mount.
  const drive = host.windows ? /^\/[A-Za-z](?:\/(.+))?$/.exec(spelled) : null;
  if (!drive) return null;
  if (drive[1] === undefined) return DELETE_DRIVE;
  const folder = WINDOWS_DIRECTORIES.get(drive[1].toLowerCase());
  return folder ? deleteWindowsSystem(folder) : null;
}

/** posixTarget for a cmd or PowerShell path. `percent`: a cmd command, where `%NAME%` expands anywhere. */
function windowsTarget(word: string, percent: boolean, host: Host): FloorVerdict | null {
  const expanded = percent ? word.replace(/%([^%\s]+)%/g, (_match, name: string) => WINDOWS_VARIABLES[name.toLowerCase()] ?? DYNAMIC) : word;
  if (expanded.includes(DYNAMIC)) return null;
  const fromHome = expanded.startsWith(HOME);
  const path = (fromHome ? expanded.slice(1) : expanded).replace(/\//g, "\\");
  const drive = fromHome ? "" : /^[A-Za-z]:/.exec(path)?.[0] ?? "";
  const rest = path.slice(drive.length);
  // `C:` and `C:\` are the drive; `C:name` and `name` depend on where it runs.
  if (path.includes(HOME) || !(rest === "" ? fromHome || drive : rest.startsWith("\\"))) return null;
  // \\server\share is another machine; after a drive letter a doubled backslash is one separator.
  if (!drive && !fromHome && rest.startsWith("\\\\")) return null;
  const { parts } = resolved(rest.split("\\"));
  if (fromHome) return parts.length ? null : DELETE_HOME;
  if (!parts.length) return DELETE_DRIVE;
  const folder = parts.length === 1 ? WINDOWS_DIRECTORIES.get(parts[0].toLowerCase()) : undefined;
  if (folder) return deleteWindowsSystem(folder);
  const home = host.home?.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return home && drive && home === `${drive}\\${parts.join("\\")}`.toLowerCase() ? DELETE_HOME : null;
}

/** `powershell`: PowerShell on macOS or Linux, whose deletes take POSIX paths. */
type Mode = "posix" | "windows" | "powershell";

/** `synced` goes false for good once any part, or a script a wrapper hands on, could not be read to its end. */
interface Pass {
  host: Host;
  synced: boolean;
}

function judge(command: Command, source: string, pass: Pass, mode: Mode, depth: number): FloorVerdict | null {
  const { host } = pass;
  if (mode === "posix" && command.writes.some(diskDevice)) return OVERWRITE_DISK;
  const words = [...command.words];
  const index = commandIndex(words, () => {
    pass.synced = false;
  });
  if (index < 0) return null;
  const program = programName(words[index]);
  const args = words.slice(index + 1);
  const run = (line: string | null | undefined, as: Mode): FloorVerdict | null => {
    if (!line) return null;
    if (depth >= MAX_DEPTH) {
      // Not followed deeper, so unread: never clear.
      pass.synced = false;
      return null;
    }
    return scan(line, pass, as, depth + 1);
  };

  if (SHELLS.has(program)) return run(inlineScript(args), "posix");
  // PowerShell 7 off Windows: `rm` is the real rm and Remove-Item takes POSIX paths, so its script is read both ways.
  // The outer shell already removed the quotes, so the words after the flag are the script.
  if (!host.windows && mode === "posix" && (program === "pwsh" || program === "powershell")) {
    const flag = args.findIndex((arg) => arg.length > 1 && "-command".startsWith(arg.toLowerCase()));
    const inner = flag < 0 ? "" : args.slice(flag + 1).join(" ");
    return run(inner, "posix") ?? run(inner, "powershell");
  }
  // On Windows Git Bash can call cmd and PowerShell too: their line is read their way even inside a POSIX line.
  if (host.windows && (program === "cmd" || program === "powershell" || program === "pwsh")) {
    let text = source;
    let read: Command | undefined = command;
    if (mode === "posix") {
      text = source.slice(command.from, command.to);
      const reading = lex(text, true);
      if (!reading.synced) pass.synced = false;
      read = reading.commands.find((candidate) => candidate.words.some((word) => programName(word) === program));
    }
    if (!read) return null;
    const first = read.words.findIndex((word) => programName(word) === program) + 1;
    const flag = read.words.findIndex((arg, at) => at >= first &&
      (program === "cmd" ? /^\/[ck]$/i.test(arg) : arg.length > 1 && "-command".startsWith(arg.toLowerCase())));
    if (flag < 0) return null;
    // One quoted argument is the whole line; otherwise it is the raw text after the flag, quotes included.
    const rest = read.words.slice(flag + 1);
    return run(rest.length === 1 ? rest[0] : text.slice(read.starts[flag + 1] ?? read.to, read.to), "windows");
  }

  if (mode === "posix") {
    if (program === "eval") return run(args.join(" "), "posix");
    if (program === "rm") {
      for (const target of rmTargets(args) ?? []) {
        // Git Bash also takes a drive path (C:/Users); nothing else does.
        const verdict = posixTarget(target, host) ?? (host.windows && /^[A-Za-z]:/.test(target) ? windowsTarget(target, false, host) : null);
        if (verdict) return verdict;
      }
      return null;
    }
    if (program === "dd") return args.some((arg) => arg.startsWith("of=") && diskDevice(arg.slice(3))) ? OVERWRITE_DISK : null;
    if (program === "mkfs" || program.startsWith("mkfs.")) return args.some(formatsDevice) ? FORMAT_DISK : null;
    if (program === "diskutil") {
      const operands = args.filter((arg) => !arg.startsWith("-"));
      const verb = (operands[0]?.toLowerCase() === "apfs" ? operands[1] : operands[0])?.toLowerCase() ?? "";
      // The disk comes last; one from `$(hdiutil attach …)` is a fresh RAM disk.
      return ["erasedisk", "erasevolume", "reformat"].includes(verb) && !args.at(-1)!.includes(DYNAMIC) ? FORMAT_DISK : null;
    }
    return null;
  }

  if (mode === "powershell") {
    // Remove-Item's aliases off Windows, where `rm` and `rmdir` are the real programs the POSIX reading judges.
    if (!["remove-item", "ri", "rd", "del", "erase"].includes(program)) return null;
    const isSwitch = (arg: string) => /^-./.test(arg);
    if (!args.some((arg) => isSwitch(arg) && "-recurse".startsWith(arg.toLowerCase()))) return null;
    for (const target of args) {
      // PowerShell takes either slash in a path.
      const verdict = isSwitch(target) ? null : posixTarget(target.replace(/\\/g, "/"), host);
      if (verdict) return verdict;
    }
    return null;
  }

  // On Windows `rm` is PowerShell's Remove-Item, which rejects `rm -rf`; the POSIX reading judges that spelling.
  const cmdStyle = program === "rd" || program === "rmdir" || program === "del" || program === "erase";
  if (cmdStyle || program === "ri" || program === "remove-item" || program === "rm") {
    // cmd switches are /s /q or /s/q; PowerShell takes -Recurse or any unambiguous start of it.
    const isSwitch = (arg: string) => /^-./.test(arg) || (cmdStyle && /^\/[A-Za-z?]/.test(arg));
    const recursive = args.some((arg) => isSwitch(arg) && (arg[0] === "/"
      ? arg.toLowerCase().split("/").includes("s")
      : "-recurse".startsWith(arg.toLowerCase())));
    if (!recursive) return null;
    for (const target of args) {
      // After `rm` a lone backslash is a POSIX line continuation; after the others it is the drive root.
      if (isSwitch(target) || (program === "rm" && target === "\\")) continue;
      const verdict = windowsTarget(target, cmdStyle, host);
      if (verdict) return verdict;
    }
    return null;
  }
  if (program === "format") return args.some((arg) => /^[A-Za-z]:\\?$/.test(arg)) ? FORMAT_DISK : null;
  return null;
}

function scan(source: string, pass: Pass, mode: Mode, depth: number): FloorVerdict | null {
  const reading = lex(source, mode !== "posix");
  if (!reading.synced) pass.synced = false;
  if (mode === "posix" && FORK_BOMBS.some((bomb) => bomb.test(reading.bare))) return FORK_BOMB;
  for (const command of reading.commands) {
    const verdict = judge(command, source, pass, mode, depth);
    if (verdict) return verdict;
  }
  return null;
}

/** "Not on the list" lets an automatic approval go ahead; "could not read" (`read: false`) must not. */
export type FloorReading = { read: true; verdict: FloorVerdict | null } | { read: false };

/** Reads a shell command line against the never-list; never throws. A caller enforcing the floor must not answer
 * for `{ read: false }`. `platform` picks the reading: POSIX (a backslash escapes) on macOS and Linux; on Windows also
 * cmd and PowerShell (a backslash ends a path), and a hit in either blocks. `home` lets a spelled-out home path match. */
export function floorReading(command: string, platform: NodeJS.Platform = process.platform, home?: string): FloorReading {
  if (typeof command !== "string" || !command.trim()) return { read: true, verdict: null };
  if (command.length > MAX_COMMAND_LENGTH) return { read: false };
  try {
    const pass: Pass = {
      host: {
        foldCase: platform === "darwin" || platform === "win32",
        mac: platform === "darwin",
        windows: platform === "win32",
        home: home && !SCRATCH_HOME.test(home.replace(/[\\/]+$/, "")) ? home : undefined,
      },
      synced: true,
    };
    // A command cannot forge the lexer's markers.
    const line = command.replace(MARKERS, "\uFFFD");
    const verdict = scan(line, pass, "posix", 0) ?? (pass.host.windows ? scan(line, pass, "windows", 0) : null);
    if (verdict) return { read: true, verdict };
    return pass.synced ? { read: true, verdict: null } : { read: false };
  } catch {
    return { read: false };
  }
}

/** Null both for "not on the list" and "could not read": an approval must be decided with floorReading. */
export function floorVerdict(command: string, platform: NodeJS.Platform = process.platform, home?: string): FloorVerdict | null {
  const reading = floorReading(command, platform, home);
  return reading.read ? reading.verdict : null;
}
