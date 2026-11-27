import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCli } from "../procs.ts";

type BackgroundFlag = "--tools" | "--no-session-persistence" | "--strict-mcp-config" | "--setting-sources";

export const BACKGROUND_CALL_TIMEOUT_MS = 60_000;

/** No extended thinking and none of the person's hooks. Claude CLI 2.1.303: only this setting keeps Haiku 5.5 from thinking;
 * MAX_THINKING_TOKENS=0 still left it thinking on about half the calls, and any --effort turns thinking back on. */
export const BACKGROUND_SETTINGS = JSON.stringify({ alwaysThinkingEnabled: false, disableAllHooks: true });

/** Isolated like a turn (no MCP servers, user or local settings) and with no built-in tools, each flag only where the CLI accepts it. */
export function backgroundCallArgs(input: {
  model: string;
  outputFormat: "json" | "text";
  supports: (flag: BackgroundFlag) => boolean;
  /** False while OMB_CLAUDE_INHERIT_USER_CONFIG asks for the person's own setup. */
  isolated: boolean;
}): string[] {
  const args = ["-p", "--model", input.model, "--output-format", input.outputFormat, "--settings", BACKGROUND_SETTINGS];
  if (input.supports("--tools")) args.push("--tools", "");
  if (input.supports("--no-session-persistence")) args.push("--no-session-persistence");
  if (input.isolated) {
    if (input.supports("--strict-mcp-config")) args.push("--strict-mcp-config");
    if (input.supports("--setting-sources")) args.push("--setting-sources", "project");
  }
  return args;
}

/**
 * Whether a background call leaves the person's own Claude setup out. Security: the call runs outside the bot box with
 * the server's HOME, where a boxed bot can write ~/.claude/settings.json, and a call that loads it runs its apiKeyHelper
 * and hooks (seen with Claude Code 2.1.321; server/drivers/planted-home-config.test.ts). So where the box is on, or
 * required, it is always isolated, whatever OMB_CLAUDE_INHERIT_USER_CONFIG says.
 */
export function backgroundIsolated(inheritsUserConfig: boolean, boxOn: boolean): boolean {
  return !inheritsUserConfig || boxOn;
}

/** Runs in an empty temp folder so no project settings or files leak in; the caller removes it once settled. */
export function spawnBackgroundCall(cli: string, args: string[], env: NodeJS.ProcessEnv) {
  const cwd = mkdtempSync(join(tmpdir(), "omb-claude-background-"));
  const removeCwd = () => { try { rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} };
  try {
    return { child: spawnCli(cli, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env, botWork: true }), removeCwd };
  } catch (error) {
    removeCwd();
    throw error;
  }
}
