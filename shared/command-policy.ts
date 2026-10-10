// A middle approval level for shell commands.
//
// Today a bot's command either waits for a tap (Ask, Auto-accept edits) or
// runs with nothing in the way (Full — `yolo` on Antigravity). There is
// nothing in between, so an operator who wants unattended work has to accept
// unattended `rm -rf`, `sudo` and `git push` as well. This module is that
// missing middle: it answers the ordinary commands and leaves the rest on a
// card, so the card means something again.
//
// **What this is NOT.** It is not a sandbox. `python3` and `node` are on the
// safe list, because writing and running code is the work; either one can do
// anything the user can. A bot that wanted to escape this policy could, and a
// prompt-injected one might. What the policy buys is that the *ordinary* path
// — the hundreds of reads, greps, builds and file writes a day — stops
// interrupting anyone, while the handful of commands that are destructive,
// outward-facing or irreversible still stop. Treat it as a filter that makes
// attention affordable, never as containment. Real containment needs the
// engine under its own uid.
//
// Fail closed: `allow` is returned only for a command every part of which was
// recognised. Anything unparsed, unknown or ambiguous returns `ask`, which is
// the behaviour that exists today.

export type CommandDecision = "allow" | "ask";

export interface CommandPolicyVerdict {
  decision: CommandDecision;
  /** Why, in words that can go in the transcript chip or the held note. */
  reason: string;
}

/** Binaries whose ordinary use is reading, searching, moving text around, or
 * building inside a folder the bot owns. A binary is listed here only when a
 * person reviewing a day of its output would not want to have been asked. */
const SAFE_BINARIES = new Set([
  // reading and searching
  "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag",
  "find", "fd", "ls", "ll", "tree", "wc", "file", "stat", "du", "df", "realpath",
  "basename", "dirname", "readlink", "pwd", "which", "type", "whoami", "date",
  "env", "printenv", "uname", "hostname",
  // text
  "sed", "awk", "cut", "sort", "uniq", "tr", "paste", "join", "comm", "diff",
  "jq", "yq", "xmllint", "column", "fold", "tee", "echo", "printf", "true", "false",
  // files, inside the workspace (checked separately by path rules)
  "mkdir", "touch", "cp", "mv", "ln", "chmod", "rmdir", "rm",
  // archives
  "tar", "zip", "unzip", "gzip", "gunzip",
  // code and tooling: this is the work, and it is also why this is not a sandbox
  "python3", "python", "node", "npm", "npx", "pnpm", "yarn", "tsx", "deno", "bun",
  "make", "cargo", "go", "java", "ruby", "perl", "php",
  // media and images
  "ffmpeg", "convert", "magick", "identify", "mogrify", "qpdf", "pdftotext",
  // version control, read-only subcommands only (checked separately)
  "git",
  // misc
  "sleep", "timeout", "xargs", "test", "[",
]);

/** `git` is safe to read and never safe to publish or rewrite. Anything not
 * listed asks, so a new subcommand is not silently allowed. */
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "blame", "shortlog", "describe", "ls-files",
  "ls-tree", "rev-parse", "rev-list", "cat-file", "for-each-ref", "merge-base",
  "name-rev", "symbolic-ref", "grep", "check-ignore", "var", "version", "config",
]);

/** Commands that always ask, even when the binary is otherwise safe. Matched
 * against the whole command text, case-insensitively. These are the actions
 * whose cost is paid by someone who never saw the bot. */
const ALWAYS_ASK: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b|\bsu\b|\bdoas\b|\bpkexec\b/, reason: "runs as another user" },
  { pattern: /\b(apt|apt-get|dpkg|snap|yum|dnf|pacman|brew)\b/, reason: "changes installed software" },
  { pattern: /\b(npm|pnpm|yarn|pip|pip3|gem|cargo|go)\s+(i|install|add|get|publish)\b/, reason: "installs or publishes a package" },
  { pattern: /\bnpx\s+(?!--no-install\b)/, reason: "npx can fetch and run a package" },
  { pattern: /\b(systemctl|service|launchctl|crontab|at)\b/, reason: "changes what runs on this machine" },
  { pattern: /\b(ssh|scp|sftp|rsync|telnet|nc|ncat|netcat|socat)\b/, reason: "reaches another machine" },
  { pattern: /\b(curl|wget|http|httpie)\b/, reason: "makes a network request" },
  { pattern: /\bgit\s+(push|commit|add|stash|checkout|reset|rebase|merge|cherry-pick|tag|remote|clean|filter-branch)\b/, reason: "writes to a repository" },
  { pattern: /\b(kill|pkill|killall|reboot|shutdown|halt|poweroff)\b/, reason: "stops something running" },
  { pattern: /\b(mkfs|fdisk|mount|umount|dd)\b/, reason: "touches a disk or filesystem" },
  { pattern: /\b(chown|chgrp|usermod|useradd|passwd|visudo)\b/, reason: "changes ownership or accounts" },
  { pattern: /\bgh\b|\bglab\b/, reason: "acts on a hosting account" },
  // `omb` and `openmausbot` are not on the safe list, so a command that RUNS
  // either already asks. They are deliberately not matched as text: a bot's
  // own task workspace is `~/.openmausbot/task-workspaces/…`, so a pattern
  // on the word refused every ordinary command run in the folder the engine
  // actually works in. Observed 2026-10-10.
  { pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/, reason: "recursive forced delete" },
  { pattern: />\s*\/(?!home\/[^/]+\/agent-workspace\/)/, reason: "writes to a path outside the workspace" },
];

/** Shell syntax this policy will not reason about. Each of these can hide a
 * second command from the checks below, so their presence alone means ask. */
const OPAQUE_SYNTAX: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\$\(|`/, reason: "command substitution" },
  { pattern: /<\(|>\(/, reason: "process substitution" },
  { pattern: /\beval\b|\bexec\b|\bsource\b|^\s*\./, reason: "runs text as a command" },
  { pattern: /\b(bash|sh|zsh|dash|ksh)\s+-c\b/, reason: "runs a nested shell" },
];

/** Paths a bot must never read or write, whatever else the command does.
 *
 * `~/.openmausbot` is deliberately NOT listed: a bot's own task workspace
 * lives under it (`task-workspaces/<bot>/<thread>`), so it is normally one of
 * the roots. Containment against the roots is what keeps the rest of that
 * directory — config.json, bots.json, the transcripts in messages.db — out of
 * reach, and it does so by resolved path rather than by spelling. */
const PROTECTED_PATHS: ReadonlyArray<{ fragment: string; reason: string }> = [
  { fragment: "/.hermes", reason: "another agent runtime's data" },
  { fragment: "/.ssh", reason: "ssh keys" },
  { fragment: "/.gnupg", reason: "gpg keys" },
  { fragment: "/.aws", reason: "cloud credentials" },
  { fragment: "/.config/gcloud", reason: "cloud credentials" },
  { fragment: "/.gemini-profiles", reason: "signed-in Google profiles" },
  { fragment: "/.claude", reason: "Claude Code's own configuration" },
  { fragment: "/etc/", reason: "system configuration" },
  { fragment: "/.bashrc", reason: "shell startup files" },
  { fragment: "/.profile", reason: "shell startup files" },
];

const ask = (reason: string): CommandPolicyVerdict => ({ decision: "ask", reason });

/** Split on the operators that chain one command to the next, so every
 * segment is checked on its own. Quoting is deliberately not interpreted:
 * a `;` inside quotes splits here too, which can only ever produce an extra
 * `ask`, never an extra `allow`. */
function segments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||[;|\n])\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The binary a segment runs, with any leading `VAR=value` assignments and
 * `env`/`time`/`nice` wrappers stripped. */
function binaryOf(segment: string): string | null {
  let rest = segment;
  // leading environment assignments
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) {
    const space = rest.indexOf(" ");
    if (space === -1) return null;
    rest = rest.slice(space + 1).trim();
  }
  const first = rest.split(/\s+/)[0];
  if (!first) return null;
  // a path-qualified binary is judged by its name, never its spelling
  const name = first.replace(/^.*\//, "");
  return name || null;
}

/** Resolve `token` against `cwd` and normalise `.` and `..`, without touching
 * the filesystem. Pure string work so this module stays usable in the browser
 * as well as the server. A symlink inside the workspace could still point
 * out of it — one more reason this is a filter and not containment. */
function resolvePath(cwd: string, token: string): string {
  const absolute = token.startsWith("/") ? token : `${cwd}/${token}`;
  const out: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

export interface CommandPolicyInput {
  command: string;
  cwd: string;
  /** Absolute paths the bot's work may stay inside. More than one because a
   * bot's own per-thread task workspace is not where its project files live:
   * on this setup the engine runs commands in
   * `~/.openmausbot/task-workspaces/<bot>/<thread>` while the shared material
   * sits in `~/agent-workspace`. A command is in bounds if it is inside any
   * of them. */
  workspaceRoots: readonly string[];
}

/**
 * Should this command run without asking?
 *
 * `allow` only when: the working directory is inside the workspace, the
 * command contains no syntax this policy cannot read, no segment names a
 * protected path or an absolute path outside the workspace, every segment's
 * binary is on the safe list, and nothing matches the always-ask list.
 * Otherwise `ask`, with the reason that decided it.
 */
export function commandPolicyVerdict(input: CommandPolicyInput): CommandPolicyVerdict {
  const command = input.command?.trim();
  if (!command) return ask("no command text");
  if (command.length > 4_096) return ask("command is too long to review");

  const roots = (input.workspaceRoots ?? [])
    .map((root) => root.trim().replace(/\/+$/, ""))
    .filter((root) => root.startsWith("/"));
  if (!roots.length) return ask("no workspace root configured");

  const inWorkspace = (path: string) => roots.some((root) => path === root || path.startsWith(`${root}/`));
  if (!inWorkspace(input.cwd ?? "")) return ask("working folder is outside the workspace");

  for (const { pattern, reason } of OPAQUE_SYNTAX) {
    if (pattern.test(command)) return ask(reason);
  }
  for (const { pattern, reason } of ALWAYS_ASK) {
    if (pattern.test(command.toLowerCase())) return ask(reason);
  }
  for (const { fragment, reason } of PROTECTED_PATHS) {
    if (command.includes(fragment)) return ask(reason);
  }
  const parts = segments(command);
  if (!parts.length) return ask("no command text");

  for (const segment of parts) {
    // Every argument is resolved against the working directory and has to
    // land inside the workspace. `../review/orion` is therefore fine and
    // `../../../etc/shadow` is not, which a plain ban on `..` could not tell
    // apart. Arguments that are not paths resolve to somewhere harmless
    // inside the workspace and pass, which is why this is cheap to apply to
    // everything rather than trying to work out which token is a path.
    for (const token of segment.split(/\s+/).slice(1)) {
      const bare = token.replace(/^["']|["']$/g, "");
      if (!bare || bare.startsWith("-")) continue;
      if (bare.startsWith("~")) return ask("a home path, which this policy does not expand");
      const resolved = resolvePath(input.cwd, bare);
      if (!inWorkspace(resolved)) return ask("a path outside the workspace");
    }

    const binary = binaryOf(segment);
    if (!binary) return ask("could not read which program runs");
    if (!SAFE_BINARIES.has(binary)) return ask(`${binary} is not on the safe list`);

    if (binary === "git") {
      const args = segment.split(/\s+/).slice(1).filter((a) => !a.startsWith("-"));
      const sub = args[0];
      if (!sub || !SAFE_GIT_SUBCOMMANDS.has(sub)) return ask("a git subcommand that is not read-only");
    }
  }

  return { decision: "allow", reason: "ordinary command inside the workspace" };
}
