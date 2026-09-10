// A bot's own verification run, read off its tool chips. The project's
// verification lever is a control CLI (`pnpm control:omb doctor`, a
// `control-<app>.mjs` script); when the bot in the visible thread runs one,
// the Verify card lists each invocation as a checklist step and can ask the
// bot to keep the run as a skill through the ordinary skill review flow.
import type { Message } from "@/state/store";
import { t } from "./i18n";

export type VerifyStep = {
  id: string;
  command: string;
  /** The first word after the CLI token that is not a flag — `doctor`,
   * `send`, `press` — or the CLI token's basename when there is none. */
  subcommand: string;
  status: "running" | "passed" | "failed";
  /** `--dry-run` anywhere in the invocation: the step proves nothing. */
  dryRun: boolean;
};

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
/** `pnpm run control:omb`, `npm run control:omb -- doctor`, `yarn -s control:omb`. */
const PACKAGE_RUNNER = new Set(["pnpm", "npm", "yarn", "bun"]);
const PACKAGE_RUNNER_WORD = new Set(["run", "exec", "-s", "--silent", "-r", "--"]);
/** `node --experimental-strip-types scripts/control-omb.ts`, `npx tsx …`. */
const SCRIPT_RUNNER = new Set(["node", "npx", "tsx", "env"]);
const CLI_SCRIPT = /^control:[\w-]+$/;
const CLI_FILE = /^control-[\w-]+\.(?:mjs|ts|js|cjs)$/;
const REDIRECT = /^\d*[<>]/;
const URL = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `--url http://…`: a long flag without `=` takes the next token as its
 * value. `--dry-run` is the boolean flag this file knows about. */
const LONG_FLAG_WITH_VALUE = /^--[^=]+$/;
const DRY_RUN = /(?:^|\s)--dry-run(?:=|\s|$)/;

const unquote = (token: string) => token.replace(/^['"`]+|['"`]+$/g, "");

/** Drop what runs the CLI, leaving the CLI token first. */
function stripRunners(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length) {
    const word = argv[i];
    if (ENV_ASSIGNMENT.test(word)) i += 1;
    else if (word === "timeout") i += 2;
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
  const basename = token.split(/[\\/]/).pop() ?? token;
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
    const argv = stripRunners(segment.split(/\s+/).filter(Boolean));
    const cli = argv.length > 0 ? cliTokenOf(argv[0]) : undefined;
    if (cli) return { subcommand: subcommandOf(argv.slice(1), cli), dryRun: DRY_RUN.test(segment) };
  }
  return undefined;
}

/** Every control-CLI invocation in the thread, in order. */
export function verifySteps(messages: Message[]): VerifyStep[] {
  const steps: VerifyStep[] = [];
  for (const m of messages) {
    const command = commandOf(m);
    const parsed = command ? parseControlCommand(command) : undefined;
    if (!command || !parsed) continue;
    const ok = m.tool?.ok;
    steps.push({ id: m.id, command, ...parsed, status: ok === undefined ? "running" : ok ? "passed" : "failed" });
  }
  return steps;
}

/** The counts and their one-line label ("3 passed · 1 failed"). A settled
 * dry run is neither passed nor failed — it proved nothing — so it is
 * counted apart; one still running is running. */
export function verifySummary(steps: VerifyStep[]): {
  passed: number;
  failed: number;
  running: number;
  dryRuns: number;
  label: string;
} {
  const counts = { passed: 0, failed: 0, running: 0, dryRuns: 0 };
  for (const step of steps) {
    if (step.dryRun && step.status !== "running") counts.dryRuns += 1;
    else counts[step.status] += 1;
  }
  const label = [
    counts.passed > 0 && t("chat.verify.passed", { count: counts.passed }),
    counts.failed > 0 && t("chat.verify.failed", { count: counts.failed }),
    counts.running > 0 && t("chat.verify.running", { count: counts.running }),
    counts.dryRuns === 1 ? t("chat.verify.dryRunOne") : counts.dryRuns > 1 && t("chat.verify.dryRunMany", { count: counts.dryRuns }),
  ].filter(Boolean).join(" · ");
  return { ...counts, label };
}

/** Whether the bot has already staged a skill from this run: an options
 * message carrying a skill proposal after the run's first step. The card
 * then points at the review instead of offering Save again. */
export function skillStaged(messages: Message[], steps: VerifyStep[]): boolean {
  const first = steps[0];
  if (!first) return false;
  const start = messages.findIndex((m) => m.id === first.id);
  return start >= 0 && messages.slice(start + 1).some((m) => m.kind === "options" && m.card?.skillRequest !== undefined);
}

const MARK = { passed: "✓", failed: "✗", running: "…" } as const;

/** The message Save as skill sends to the bot. Its first sentence is a
 * create-verification-skill trigger phrase, so that skill mounts on the
 * turn and lays the file out; the rest is the run itself. A dry run is
 * marked as one and never reads as passing. */
export function skillPrompt(steps: VerifyStep[]): string {
  return [
    "Create a verification skill from the run below.",
    "Do not re-run these steps; their results are in this thread. Use the passing ones as the recipe with their exact commands and note the failed ones as gotchas.",
    "",
    ...steps.map((step) => `${step.dryRun ? "[dry run]" : MARK[step.status]} ${step.subcommand} — ${step.command}`),
  ].join("\n");
}
