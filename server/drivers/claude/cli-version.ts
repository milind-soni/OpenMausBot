// Claude CLI version floors: which context-control flags each CLI build
// accepts, and the Engines-page update notice when one predates them.
// Split out of drivers/claude.ts.
import type { ProviderSnapshot } from "../../contracts.ts";

/** The Claude CLI version that first accepted each flag the harness passes
 * for context control. An unknown flag is a hard argument error, so passing
 * one to an older CLI would fail every turn rather than degrade; each flag
 * is therefore only passed to a CLI known to accept it.
 *
 * Verified against the published binaries, not the changelog (which never
 * records `--autocompact`): `--strict-mcp-config` is present in 1.0.60 and
 * absent from 1.0.0; `--setting-sources` first appears in 1.0.122 (1.0.120
 * lacks it); `--autocompact` first appears in 2.1.122 (2.1.121 lacks it).
 * Shipped builds have since diverged from that autocompact floor in both
 * directions, so the driver feature-detects the flag from the CLI's own
 * --help output and only falls back to the floor when help is missing or
 * unparseable (issue #1187: an unknown flag is a hard argv error). */
export const CLAUDE_FLAG_FLOORS = {
  "--strict-mcp-config": [1, 0, 60],
  "--setting-sources": [1, 0, 122],
  "--autocompact": [2, 1, 122],
  // 2.1.267 is the first CLI that accepts it; below that the recorded prompt
  // simply is not refreshed, which is the pre-existing behaviour.
  "--system-prompt-snapshot": [2, 1, 267],
} as const satisfies Record<string, ClaudeCliVersion>;

export type ClaudeCliVersion = readonly [number, number, number];

/** The newest floor above: a CLI at or past it accepts everything the
 * harness sends. Below it the engine still works, minus the flags the CLI
 * predates, and the Engines page suggests an update. */
export const CLAUDE_CONTEXT_CONTROL_MIN_VERSION: ClaudeCliVersion = CLAUDE_FLAG_FLOORS["--system-prompt-snapshot"];

/** `claude --version` prints "2.1.232 (Claude Code)"; the first dotted triple
 * is the version. Null when nothing parses, e.g. a wrapper that prints its
 * own banner first — see claudeCliSupports for how that is treated. */
export function parseClaudeCliVersion(stdout: string | null | undefined): ClaudeCliVersion | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout ?? "");
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The flag names a CLI's `--help` output advertises. Null when the output
 * is missing or shows nothing flag-shaped: anything that did not come from
 * a real help page must not be mistaken for a feature probe, and the caller
 * keeps governing by the version floors. */
export function parseClaudeHelpFlags(stdout: string | null | undefined): Set<string> | null {
  const flags = new Set(
    (stdout ?? "")
      .split(/\s+/)
      .map((token) => token.replace(/^[<([]*/, "").replace(/[=,].*$/, "").replace(/[.,:;)\]]+$/, ""))
      .filter((token) => /^--[A-Za-z0-9][A-Za-z0-9-]*$/.test(token)),
  );
  return flags.size > 0 ? flags : null;
}

/** Whether this build accepts `--autocompact`: its own --help decides when
 * the probe could be read, and the 2.1.122 floor otherwise (#1187). */
export function claudeCliSupportsAutocompact(
  version: ClaudeCliVersion | null,
  helpFlags: Set<string> | null | undefined,
): boolean {
  if (helpFlags) return helpFlags.has("--autocompact");
  return claudeCliSupports(version, "--autocompact");
}

function versionAtLeast(installed: ClaudeCliVersion, floor: ClaudeCliVersion): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (installed[i] !== floor[i]) return installed[i] > floor[i];
  }
  return true;
}

/** Whether a CLI reporting `version` accepts `flag`. A version that could
 * not be parsed counts as current: every CLI that predates a floor prints a
 * plain "x.y.z (Claude Code)", so an unreadable version is far more likely
 * a newer wrapper than an old build, and withholding the flags from a modern
 * CLI would silently re-open the context leak this file exists to close. */
export function claudeCliSupports(version: ClaudeCliVersion | null, flag: keyof typeof CLAUDE_FLAG_FLOORS): boolean {
  return version === null || versionAtLeast(version, CLAUDE_FLAG_FLOORS[flag]);
}

/** The Engines-page notice for a CLI older than the newest floor. The engine
 * keeps working without the flags its CLI predates. */
export function claudeCliUpdate(version: string | null, cli: string): ProviderSnapshot["update"] | undefined {
  const parsed = parseClaudeCliVersion(version);
  if (!parsed || versionAtLeast(parsed, CLAUDE_CONTEXT_CONTROL_MIN_VERSION)) return undefined;
  const floor = CLAUDE_CONTEXT_CONTROL_MIN_VERSION.join(".");
  const missing = (Object.keys(CLAUDE_FLAG_FLOORS) as (keyof typeof CLAUDE_FLAG_FLOORS)[])
    .filter((flag) => !claudeCliSupports(parsed, flag));
  const effects = [
    ...(missing.includes("--autocompact") ? ["no compaction window picked by OpenMausBot"] : []),
    ...(missing.includes("--setting-sources") ? ["bots still see this machine's own Claude Code setup"] : []),
    ...(missing.includes("--system-prompt-snapshot") ? ["coordinated resumed turns cannot refresh stale system prompts"] : []),
  ];
  return {
    title: "Update Claude Code for context controls",
    message:
      `Claude Code ${parsed.join(".")} predates ${floor}, so bots run without ${missing.join(", ")}: ` +
      `${effects.join("; ")}. Update it, then refresh Engines.`,
    command: cli === "claude" ? "claude update" : `${cli} update`,
  };
}
