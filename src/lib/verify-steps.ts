// A bot's run in the current ask, read off its tool chips. Every shell
// command the bot ran is a step; the ones through a control CLI (`pnpm
// control:omb doctor`, a `control-<app>.mjs` script) are the verified ones,
// since the control CLI is the project's verification lever. Reads — `cat`,
// `git log`, `gh pr view` — are not steps: looking is not doing. The card
// lists the run and can hand it to the composer as a skill request.
import { SAVE_RUN_AS_SKILL_LINE } from "../../shared/learn-request";
import type { Message } from "@/state/store";
import { t } from "./i18n";

export type RunStep = {
  id: string;
  command: string;
  /** For a verified step, the control subcommand — `doctor`, `send`,
   * `press` — or the CLI token's basename when there is none. Otherwise
   * the program that did the work, with its subcommand for the few whose
   * subcommand is the story (`git push`, `gh release`, `npm publish`). */
  label: string;
  status: "running" | "passed" | "failed";
  /** `--dry-run` anywhere in the invocation: the step proves nothing. */
  dryRun: boolean;
  /** The step ran through a control CLI, so its outcome is a verification. */
  verified: boolean;
};
/** @deprecated the card records every command now; use RunStep. */
export type VerifyStep = RunStep;

/** A tool name that is itself a command line (Codex and ACP title their
 * chips with the command) rather than a bare tool name such as `Bash`. */
export function nameIsCommand(name: string): boolean {
  return /[\s/]/.test(name);
}

/** The command a tool chip ran: the driver's summary, which is the shell
 * command by construction. Never the name — server-authored status chips
 * quote commands in their name ("Same call repeated 3× — Bash: pnpm
 * control:omb doctor…") and must not become steps. */
export function commandOf(m: Message): string | undefined {
  return m.kind === "activity" ? m.tool?.summary || undefined : undefined;
}

// ── parsing one command line ─────────────────────────────────────────
// Position-based, not substring-based: `cat scripts/control-omb.ts` reads
// the CLI's source and is not a step. Only the first program of a shell
// segment counts, after whatever runs it (`node --flags`, `pnpm run`, an
// env assignment) is dropped.

const SEGMENT = /\s*(?:&&|\|\||;|\||\r?\n)\s*/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `env FOO=1 cmd`, `sudo cmd`, `timeout 30 cmd`, `cd dir`: around a
 * command without being it. Dropped before the label too, so the label
 * names what ran. */
const WRAPPER = new Set(["env", "sudo"]);
/** A wrapper flag that takes the next token: `sudo -u root`, `env -u VAR`. */
const WRAPPER_VALUE_FLAG = new Set(["-u", "-g", "-C"]);
/** `pnpm run control:omb`, `npm run control:omb -- doctor`, `yarn -s control:omb`. */
const PACKAGE_RUNNER = new Set(["pnpm", "npm", "yarn", "bun"]);
const PACKAGE_RUNNER_WORD = new Set(["run", "exec", "-s", "--silent", "-r", "--"]);
/** `node --experimental-strip-types scripts/control-omb.ts`, `npx tsx …`. */
const SCRIPT_RUNNER = new Set(["node", "npx", "tsx"]);
const CLI_SCRIPT = /^control:[\w-]+$/;
const CLI_FILE = /^control-[\w-]+\.(?:mjs|ts|js|cjs)$/;
const REDIRECT = /^\d*[<>]/;
const URL = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `--url http://…`: a long flag without `=` takes the next token as its
 * value. `--dry-run` is the boolean flag this file knows about. */
const LONG_FLAG_WITH_VALUE = /^--[^=]+$/;
const DRY_RUN = /(?:^|\s)--dry-run(?:=|\s|$)/;

const unquote = (token: string) => token.replace(/^['"`]+|['"`]+$/g, "");
/** `./node_modules/.bin/vitest` → `vitest`; a Windows path reads the same. */
const basenameOf = (token: string) => {
  const bare = unquote(token);
  return bare.split(/[\\/]/).pop() || bare;
};

/** Drop what wraps a command — and, with `runners`, what runs it — leaving
 * the program first. Order-agnostic: `sudo env FOO=1 npx tsx x.ts` peels
 * one layer per pass. */
function strip(argv: string[], runners: boolean): string[] {
  let i = 0;
  while (i < argv.length) {
    const word = argv[i];
    if (ENV_ASSIGNMENT.test(word)) i += 1;
    else if (word === "timeout" || word === "cd") i += 2;
    else if (WRAPPER.has(word)) {
      i += 1;
      while (i < argv.length && argv[i].startsWith("-")) i += WRAPPER_VALUE_FLAG.has(argv[i]) ? 2 : 1;
    } else if (!runners) break;
    else if (word === "deno") i += argv[i + 1] === "run" ? 2 : 1;
    else if (PACKAGE_RUNNER.has(word)) {
      i += 1;
      while (i < argv.length && PACKAGE_RUNNER_WORD.has(argv[i])) i += 1;
    } else if (SCRIPT_RUNNER.has(word)) {
      i += 1;
      while (i < argv.length && argv[i].startsWith("-")) i += 1;
    } else break;
  }
  return argv.slice(i);
}

/** The CLI token's basename when the token IS a control CLI: `control:omb`
 * for the package script, `control-atlas.mjs` for a script by path (`/` or
 * `\`, so a Windows path reads the same). */
function cliTokenOf(word: string): string | undefined {
  const token = unquote(word);
  if (CLI_SCRIPT.test(token)) return token;
  const basename = basenameOf(token);
  return CLI_FILE.test(basename) ? basename : undefined;
}

function subcommandOf(rest: string[], cli: string): string {
  let valueNext = false;
  for (const raw of rest) {
    const token = unquote(raw);
    if (token.startsWith("-")) valueNext = LONG_FLAG_WITH_VALUE.test(token) && token !== "--dry-run";
    else if (valueNext) valueNext = false;
    else if (token && !REDIRECT.test(token) && !URL.test(token)) return token;
  }
  return cli;
}

/** What a command line invokes when its first program (after runners) is a
 * control CLI; undefined for anything else, including reading the CLI's
 * source. Only the first matching shell segment counts. */
export function parseControlCommand(command: string): { subcommand: string; dryRun: boolean } | undefined {
  for (const segment of command.split(SEGMENT)) {
    const argv = strip(segment.split(/\s+/).filter(Boolean), true);
    const cli = argv.length > 0 ? cliTokenOf(argv[0]) : undefined;
    if (cli) return { subcommand: subcommandOf(argv.slice(1), cli), dryRun: DRY_RUN.test(segment) };
  }
  return undefined;
}

// ── reads ────────────────────────────────────────────────────────────
// A segment that only looks — at a file, the tree, a process list, a git
// or GitHub object, a URL — is not a step. Shell no-ops (`export`, `true`,
// `sleep`) are not steps either. Everything else did work.

const READ_PROGRAM = new Set([
  "cat", "less", "more", "head", "tail", "wc", "stat", "file", "du", "df", "ls", "tree", "find",
  "which", "type", "where", "whereis", "pwd", "echo", "printf", "printenv", "env", "ps", "pgrep", "top",
  "grep", "rg", "ag", "ack", "fgrep", "egrep", "awk", "cut", "sort", "uniq", "tr", "diff", "cmp",
  "md5", "shasum", "sha256sum", "jq", "yq", "column",
  "export", "unset", "alias", "true", "false", ":", "sleep", "exit",
]);
const GIT_READ = new Set(["status", "log", "diff", "show", "blame", "branch", "tag", "ls-files", "rev-parse", "remote", "describe", "shortlog", "reflog"]);
const GIT_VALUE_FLAG = new Set(["-C", "-c"]);
const GH_READ = new Set(["pr view", "pr list", "pr checks", "pr diff", "issue view", "issue list", "run view", "run list"]);
const GH_VALUE_FLAG = new Set(["-R", "--repo"]);
const NO_VALUE_FLAG = new Set<string>();
const SED_IN_PLACE = /^(?:-[a-zA-Z]*i|--in-place)/;
const HTTP_MUTATION = /^(?:POST|PUT|PATCH|DELETE)$/i;
const METHOD_FLAG = /^(?:-X|--request|--method)(?:=(.*))?$/;
const METHOD_ATTACHED = /^-X(\w+)$/;
/** curl/wget flags that send or save something. */
const TRANSFER_FLAG = /^(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file|-o|--output|-O|--remote-name|--output-document|--post-data|--post-file)(?:=|$)/;
const GH_FIELD_FLAG = /^(?:-f|-F|--field|--raw-field)(?:=|$)/;

/** The bare words of an argument list — flags dropped, a value flag taking
 * the next token with it, redirects and URLs skipped. */
function words(rest: string[], valueFlags: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = unquote(rest[i]);
    if (valueFlags.has(token)) i += 1;
    else if (token.startsWith("-") || REDIRECT.test(token) || URL.test(token) || !token) continue;
    else found.push(token);
  }
  return found;
}

/** `-X POST`, `-XPOST`, `--request=DELETE`, `--method PUT`. */
function mutatesOverHttp(rest: string[]): boolean {
  for (let i = 0; i < rest.length; i += 1) {
    const token = unquote(rest[i]);
    const attached = METHOD_ATTACHED.exec(token);
    if (attached) {
      if (HTTP_MUTATION.test(attached[1])) return true;
      continue;
    }
    const flag = METHOD_FLAG.exec(token);
    if (!flag) continue;
    const method = flag[1] ?? unquote(rest[i + 1] ?? "");
    if (HTTP_MUTATION.test(method)) return true;
  }
  return false;
}

/** Whether a segment, runners stripped, only looked. An empty segment (an
 * env assignment alone, `cd dir`) did nothing, so it is a read too. */
function isRead(argv: string[]): boolean {
  if (argv.length === 0) return true;
  const program = basenameOf(argv[0]);
  if (READ_PROGRAM.has(program)) return true;
  const rest = argv.slice(1);
  switch (program) {
    case "sed":
      return !rest.some((token) => SED_IN_PLACE.test(unquote(token)));
    case "git": {
      const [subcommand] = words(rest, GIT_VALUE_FLAG);
      return subcommand === undefined || GIT_READ.has(subcommand);
    }
    case "gh": {
      const [group, verb] = words(rest, GH_VALUE_FLAG);
      if (group === "api") return !mutatesOverHttp(rest) && !rest.some((token) => GH_FIELD_FLAG.test(unquote(token)));
      return group === undefined || GH_READ.has(`${group} ${verb}`);
    }
    case "curl":
    case "wget":
      return !mutatesOverHttp(rest) && !rest.some((token) => TRANSFER_FLAG.test(unquote(token)));
    default:
      return false;
  }
}

/** Programs whose subcommand is the story: `git push`, not `git`. */
const LABELLED_BY_SUBCOMMAND = new Set(["git", "gh", "npm", "pnpm", "docker", "kubectl"]);

/** What to call a segment that did work: its program, plus the subcommand
 * for the programs above (`pnpm run build` reads `pnpm build`). */
function labelOf(argv: string[]): string {
  const program = basenameOf(argv[0]);
  if (!LABELLED_BY_SUBCOMMAND.has(program)) return program;
  const rest = PACKAGE_RUNNER.has(program) ? argv.slice(1).filter((word) => !PACKAGE_RUNNER_WORD.has(word)) : argv.slice(1);
  const [subcommand] = words(rest, program === "git" ? GIT_VALUE_FLAG : program === "gh" ? GH_VALUE_FLAG : NO_VALUE_FLAG);
  return subcommand ? `${program} ${subcommand}` : program;
}

/** What a command line did — its label, whether it went through a control
 * CLI, whether it was a dry run — or undefined when every segment only
 * looked. A control CLI names the step when any segment is one; otherwise
 * the first segment that did work does. */
export function parseRunCommand(command: string): { label: string; verified: boolean; dryRun: boolean } | undefined {
  const control = parseControlCommand(command);
  if (control) return { label: control.subcommand, verified: true, dryRun: control.dryRun };
  for (const segment of command.split(SEGMENT)) {
    const argv = strip(segment.split(/\s+/).filter(Boolean), false);
    if (isRead(strip(argv, true))) continue;
    return { label: labelOf(argv), verified: false, dryRun: DRY_RUN.test(segment) };
  }
  return undefined;
}

// ── the run ──────────────────────────────────────────────────────────

/** The index of the message that opened the current ask: the last user
 * message with text, the same boundary the task timeline draws. -1 when
 * there is none (a routine's thread, a channel goal's): the thread is one
 * ask then. */
function askIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === "user" && m.kind === "text" && m.text?.trim()) return i;
  }
  return -1;
}

/** What the person asked for, as the first line of their last message, at
 * most 300 characters; undefined when the thread has no such message. */
export function askText(messages: Message[]): string | undefined {
  const index = askIndex(messages);
  if (index < 0) return undefined;
  const line = messages[index].text!.trim().split(/\r?\n/, 1)[0].trim();
  return line ? line.slice(0, 300) : undefined;
}

/** Every command the bot ran in the current ask, in order, reads left out. */
export function runSteps(messages: Message[]): RunStep[] {
  const steps: RunStep[] = [];
  for (const m of messages.slice(askIndex(messages) + 1)) {
    const command = commandOf(m);
    const parsed = command ? parseRunCommand(command) : undefined;
    if (!command || !parsed) continue;
    const ok = m.tool?.ok;
    steps.push({ id: m.id, command, ...parsed, status: ok === undefined ? "running" : ok ? "passed" : "failed" });
  }
  return steps;
}
/** @deprecated renamed runSteps: the card records every command now. */
export const verifySteps = runSteps;

/** Whether a run is worth a card: something was verified, or the bot did
 * more than one thing. One unverified command is a chip, not a run. */
export function showRun(steps: RunStep[]): boolean {
  return steps.some((step) => step.verified) || steps.length >= 2;
}

/** The counts and their one-line label ("3 steps · 2 verified · 1 failed").
 * A settled dry run is neither passed nor failed — it proved nothing — so
 * it is counted apart; one still running is running. */
export function runSummary(steps: RunStep[]): {
  total: number;
  verified: number;
  passed: number;
  failed: number;
  running: number;
  dryRuns: number;
  label: string;
} {
  const counts = { total: steps.length, verified: 0, passed: 0, failed: 0, running: 0, dryRuns: 0 };
  for (const step of steps) {
    if (step.verified) counts.verified += 1;
    if (step.dryRun && step.status !== "running") counts.dryRuns += 1;
    else counts[step.status] += 1;
  }
  const label = [
    counts.total === 1 ? t("chat.verify.stepsOne") : t("chat.verify.stepsMany", { count: counts.total }),
    counts.verified > 0 && t("chat.verify.verifiedCount", { count: counts.verified }),
    counts.failed > 0 && t("chat.verify.failed", { count: counts.failed }),
    counts.running > 0 && t("chat.verify.running", { count: counts.running }),
    counts.dryRuns === 1 ? t("chat.verify.dryRunOne") : counts.dryRuns > 1 && t("chat.verify.dryRunMany", { count: counts.dryRuns }),
  ].filter(Boolean).join(" · ");
  return { ...counts, label };
}
/** @deprecated renamed runSummary. */
export const verifySummary = runSummary;

/** Whether the bot has already staged a skill from this run: an options
 * message carrying a skill proposal after the run's first step. The card
 * then points at the review instead of offering Save again. */
export function skillStaged(messages: Message[], steps: RunStep[]): boolean {
  const first = steps[0];
  if (!first) return false;
  const start = messages.findIndex((m) => m.id === first.id);
  return start >= 0 && messages.slice(start + 1).some((m) => m.kind === "options" && m.card?.skillRequest !== undefined);
}

const MARK = { passed: "✓", failed: "✗", running: "…" } as const;

const stepLine = (step: RunStep) =>
  `${step.dryRun ? "[dry run]" : MARK[step.status]} ${step.label} — ${step.command}${step.verified ? " (verified)" : ""}`;

/** The text Save as skill puts into the composer for the person to send,
 * carrying what they asked for so the skill knows its goal. Two shapes. A
 * run with a verified step opens with a create-verification-skill trigger
 * phrase, so that skill mounts on the turn and lays the file out (the
 * bundled skill matches its term anywhere in the turn, so notes above or
 * below are fine). A run without one asks, in plain words, to save the
 * steps as a skill: the server expands a turn that opens with that sentence
 * into the same authoring turn as `/learn`, so nobody sees or types a slash
 * command. Either way a dry run is marked as one and never reads as passing,
 * and the text ends with a blank line so the caret lands below the steps. */
export function skillPrompt(steps: RunStep[], ask?: string): string {
  const lines = steps.some((step) => step.verified)
    ? [
      "Create a verification skill from the run below.",
      ...(ask ? [`Goal: ${ask}`] : []),
      "Do not re-run these steps; their results are in this thread. Use the passing ones as the recipe with their exact commands and note the failed ones as gotchas.",
    ]
    : [
      SAVE_RUN_AS_SKILL_LINE,
      `Goal: ${ask ?? "the run below"}`,
      "Keep the exact commands and note the failed ones as gotchas. Do not re-run anything.",
    ];
  return [...lines, "", ...steps.map(stepLine), "", ""].join("\n");
}
