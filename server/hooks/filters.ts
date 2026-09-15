// PreToolUse command filters (docs/plans/2026-09-14-phase-0-foundation.md,
// item 0.2, step 9).
//
// A test run or a package install can put thousands of lines into the
// context for one line of signal. This is a SMALL allowlist of commands the
// harness knows to be noisy, each rewritten to a bounded form before the
// engine runs it, delivered through Claude Code's PreToolUse `updatedInput`.
// Rules of the table: never block, never rewrite a command the table does
// not name, never touch a command that already pipes, redirects or chains
// (the person or the model already shaped its output), and keep every
// rewrite a strict superset of what the original would have run. Off by
// default per bot until the bench shows it saves tokens (item 0.6).

export interface FilteredCommand {
  command: string;
  rule: "test-runner" | "install" | "git-log";
}

const TEST_RUNNERS = [
  /^(pnpm|npm|yarn|bun) (run )?test\b/,
  /^(npx|pnpm|yarn|bun) (vitest|jest|mocha)\b/,
  /^(python -m )?pytest\b/,
  /^cargo test\b/,
  /^go test\b/,
];
const INSTALLS = [
  /^(pnpm|yarn|bun) (install|i|add)\b/,
  /^npm (install|i|ci|add)\b/,
  /^pip3? install\b/,
];
const GIT_LOG = /^git log\b/;
const GIT_LOG_BOUNDED = /(^|\s)(-n\s*\d+|-\d+|--max-count(=|\s)\d+)(\s|$)/;
// anything that already shapes or chains the command is left alone
const SHAPED = /[|><;&`\n]|\$\(/;

export function filterCommand(raw: string): FilteredCommand | null {
  const command = raw.trim();
  if (!command || SHAPED.test(command)) return null;
  if (TEST_RUNNERS.some((rule) => rule.test(command))) return { command: `${command} 2>&1 | tail -n 200`, rule: "test-runner" };
  if (INSTALLS.some((rule) => rule.test(command))) return { command: `${command} 2>&1 | tail -n 40`, rule: "install" };
  if (GIT_LOG.test(command) && !GIT_LOG_BOUNDED.test(command)) {
    return { command: command.replace(/^git log\b/, "git log -n 30"), rule: "git-log" };
  }
  return null;
}
