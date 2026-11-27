// What each Claude CLI release accepts, and what an Engines snapshot should tell the operator to update.
import { parseVersionTriple, versionAtLeast } from "./acp/version-probe.ts";
import type { ProviderSnapshot } from "../contracts.ts";

/** The first Claude CLI to accept each flag; an unknown flag is a hard argument error. Checked
 * against the published binaries (the changelog never records --autocompact): --strict-mcp-config
 * 1.0.60, --setting-sources 1.0.122, --autocompact 2.1.122. */
export const CLAUDE_FLAG_FLOORS = {
  "--strict-mcp-config": [1, 0, 60],
  "--setting-sources": [1, 0, 122],
  "--autocompact": [2, 1, 122],
  "--system-prompt-snapshot": [2, 1, 267],
  // 2.1.248 takes --restricted; 2.1.257 honours blockReadsOutsideWorkingDirectories.
  "--restricted": [2, 1, 257],
  // Keep-warm pings only. Not bisected: both are in every 2.1 build checked.
  "--fork-session": [2, 1, 0],
  "--no-session-persistence": [2, 1, 0],
  // Background calls. Not bisected: the guest path passes it from 2.1.257.
  "--tools": [2, 1, 257],
} as const satisfies Record<string, ClaudeCliVersion>;

export type ClaudeCliVersion = readonly [number, number, number];

export const CLAUDE_CONTEXT_CONTROL_MIN_VERSION: ClaudeCliVersion = CLAUDE_FLAG_FLOORS["--system-prompt-snapshot"];

/** The first CLI seen to echo a stdin user message with its uuid as a model call takes it in
 * (--replay-user-messages, 2.1.282): a steer written during a tool call is echoed after that
 * tool's result, one written during the last model call only after the turn's `result`. */
export const CLAUDE_REPLAY_FLOOR: ClaudeCliVersion = [2, 1, 282];

/** `claude --version` prints "2.1.232 (Claude Code)". */
export function parseClaudeCliVersion(stdout: string | null | undefined): ClaudeCliVersion | null {
  return parseVersionTriple(stdout ?? "");
}

export function claudeCliSupports(version: ClaudeCliVersion | null, flag: keyof typeof CLAUDE_FLAG_FLOORS): boolean {
  return version === null || versionAtLeast(version, CLAUDE_FLAG_FLOORS[flag]);
}

export function claudeCliUpdate(version: string | null, cli: string): ProviderSnapshot["update"] | undefined {
  const parsed = parseClaudeCliVersion(version);
  if (!parsed || versionAtLeast(parsed, CLAUDE_CONTEXT_CONTROL_MIN_VERSION)) return undefined;
  const floor = CLAUDE_CONTEXT_CONTROL_MIN_VERSION.join(".");
  const missing = (Object.keys(CLAUDE_FLAG_FLOORS) as (keyof typeof CLAUDE_FLAG_FLOORS)[])
    .filter((flag) => !claudeCliSupports(parsed, flag));
  const effects = [
    ...(missing.includes("--autocompact") ? ["no compaction window picked by OpenMausBot"] : []),
    ...(missing.includes("--setting-sources") ? ["bots still see this machine's own Claude Code setup"] : []),
    ...(missing.includes("--system-prompt-snapshot") ? ["resumed turns cannot refresh stale system prompts"] : []),
  ];
  return {
    title: "Update Claude Code for context controls",
    message:
      `Claude Code ${parsed.join(".")} predates ${floor}, so bots run without ${missing.join(", ")}: ` +
      `${effects.join("; ")}. Update it, then refresh Engines.`,
    command: cli === "claude" ? "claude update" : `${cli} update`,
  };
}
