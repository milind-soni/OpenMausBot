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

/** Security invariant: a web search call carries text from the open web, so it gets the one built-in tool that runs on
 * Anthropic's side and no MCP servers, settings or hooks of the person's, whatever OMB_CLAUDE_INHERIT_USER_CONFIG says.
 * WebFetch is left out: it fetches from this computer, so a page could aim it at local addresses. Null when this CLI
 * can't be held to that. */
export function webSearchCallArgs(input: { model: string; supports: (flag: BackgroundFlag) => boolean }): string[] | null {
  if (!input.supports("--tools") || !input.supports("--strict-mcp-config") || !input.supports("--setting-sources")) return null;
  return [
    "-p", "--model", input.model, "--output-format", "text", "--settings", BACKGROUND_SETTINGS,
    "--tools", "WebSearch", "--allowedTools", "WebSearch", "--strict-mcp-config", "--setting-sources", "project",
    ...(input.supports("--no-session-persistence") ? ["--no-session-persistence"] : []),
  ];
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
