// Claude CLI environment and auth: sign-in probes, per-account env
// isolation, config-dir resolution, and the settings a retained account
// must (or must not) carry into a turn. Split out of drivers/claude.ts.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, normalize } from "node:path";

import { stripWorkspaceCredentialEnv } from "../../config.ts";
import { augmentedPath } from "../../env-path.ts";
import { execCli } from "../../procs.ts";
import { classifyError } from "../retry.ts";
import { applyClaudeInject } from "../local-inject.ts";
import type { ProviderSnapshot } from "../../contracts.ts";

/** Whether `claude` has been signed in.
 *
 * Credential storage is deliberately not inspected here. Claude Code uses the
 * macOS Keychain for OAuth, a JSON file on some platforms, and may gain other
 * backends over time. Presence checks also accept stale credentials. The CLI's
 * own machine-readable auth command is the source of truth for every backend.
 */
export function claudeAuthStatus(
  cli: string,
  env: NodeJS.ProcessEnv,
  run: typeof execCli = execCli,
): Promise<{ authenticated: boolean; account?: ProviderSnapshot["account"] }> {
  return new Promise((resolve) => {
    run(cli, ["auth", "status", "--json"], { timeout: 8000, maxBuffer: 65_536, env }, (_error, stdout) => {
      try {
        const status: unknown = JSON.parse(stdout);
        if (!status || typeof status !== "object" || !("loggedIn" in status) || status.loggedIn !== true) {
          return resolve({ authenticated: false });
        }
        // Only display identity fields, never the CLI's full auth response.
        const identity = status as { email?: unknown; orgName?: unknown; authMethod?: unknown };
        const boundedText = (value: unknown, max: number): string | undefined =>
          typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value)
            ? value.trim() : undefined;
        const candidateEmail = boundedText(identity.email, 254);
        const email = candidateEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail) ? candidateEmail : undefined;
        const organization = boundedText(identity.orgName, 160);
        // An API key is a workspace decision, not a person: say so instead
        // of showing an empty identity.
        const account = {
          ...(email ? { email } : {}),
          ...(organization ? { organization } : {}),
          ...(identity.authMethod === "api_key" ? { method: "api-key" as const } : {}),
        };
        resolve({ authenticated: true, ...(Object.keys(account).length ? { account } : {}) });
      } catch {
        resolve({ authenticated: false });
      }
    });
  });
}

export async function claudeSignedIn(
  cli: string,
  env: NodeJS.ProcessEnv,
  run: typeof execCli = execCli,
): Promise<boolean> {
  return (await claudeAuthStatus(cli, env, run)).authenticated;
}

/** Parent-session credentials/routing that a named account must not inherit.
 * Shared with terminal sign-in instructions so login and turns select alike. */
export const CLAUDE_ACCOUNT_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** Resolve the CLI's config location without changing HOME or Keychain. */
export function resolveClaudeConfigDir(configDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  const configured = configDir?.trim() || env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const expanded = configured === "~" ? home : configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
  if (!isAbsolute(expanded) || /[\p{Cc}\p{Cf}]/u.test(expanded)) {
    throw new Error("claude: configDir must be an absolute path or start with ~/");
  }
  return normalize(expanded);
}

/** Whether a stream frame is the CLI reporting that it has no login.
 *
 * The CLI flags its own api-error frames (`error`, `is_api_error_message`);
 * a model reply never carries them. Requiring that flag first is what keeps
 * an answer that merely discusses being logged out from being read as a
 * failure — the text classifier runs only once the CLI has already called
 * the frame an error, and covers CLI builds that flag the frame without
 * naming the reason.
 */
export function claudeAuthFailure(
  frame: { error?: unknown; is_api_error_message?: unknown },
  text: string,
): boolean {
  if (frame.is_api_error_message !== true && typeof frame.error !== "string") return false;
  return frame.error === "authentication_failed" || classifyError({ text }).reason === "auth";
}

/** The CLI environment shared by auth probes and real turns.
 *
 * Subscription users can be billed pay-as-you-go if an inherited API key
 * leaks through, and a nested CLI must not inherit this session's identity.
 * Keeping the probe and turn environments identical prevents setup from
 * claiming an API-key login that the turn itself would deliberately remove.
 */
export function claudeEnvironment(
  model?: string | null,
  source: NodeJS.ProcessEnv = process.env,
  configDir?: string,
  instanceEnvironment: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" };
  if (configDir?.trim()) {
    env.CLAUDE_CONFIG_DIR = resolveClaudeConfigDir(configDir, env);
    for (const key of CLAUDE_ACCOUNT_ENV_KEYS) {
      // Explicit custom endpoint settings still work; subscription OAuth
      // always belongs to this account's CLI-managed login, never its parent.
      if (key.startsWith("CLAUDE_CODE_OAUTH_") || key.endsWith("_FILE_DESCRIPTOR") || !Object.hasOwn(instanceEnvironment, key)) {
        delete env[key];
      }
    }
  } else if (env.CLAUDE_CONFIG_DIR) {
    env.CLAUDE_CONFIG_DIR = resolveClaudeConfigDir(undefined, env);
  }
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // The harness process may hold workspace credentials (xai/box/voice keys,
  // env-injected at boot); none of them are this CLI's to see.
  stripWorkspaceCredentialEnv(env);
  const applied = applyClaudeInject(env, model);
  // A key set on purpose for this workspace (Settings → Connections, carried
  // in the instance environment) stays. One riding along in the parent's
  // env never does: it would flip a subscription login to pay-as-you-go.
  if (!applied.injected && !instanceEnvironment.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;
  return env;
}

/** Escape hatch back to the pre-isolation launch, where a bot inherited this
 * machine's Claude Code setup: its MCP servers and connectors, skills,
 * agents, hooks and personal CLAUDE.md. Set it only to recover a bot that
 * genuinely depended on a user- or local-scope MCP server; the supported way
 * to give a bot a server is the app's own `mcpServers` config or the bot
 * project's `.mcp.json`. */
export function inheritsUserConfig(env: NodeJS.ProcessEnv): boolean {
  return env.OMB_CLAUDE_INHERIT_USER_CONFIG === "1";
}

/** The Engines-page warning while the escape hatch is set. The flag is a
 * footgun: it is invisible once exported, and what it costs — every Claude
 * bot re-reading this machine's own servers, skills, hooks and CLAUDE.md on
 * every model call — shows up only on the bill. Naming it where the person
 * looks when something is off is the whole point. */
export function claudeInheritWarning(env: NodeJS.ProcessEnv): ProviderSnapshot["warning"] | undefined {
  if (!inheritsUserConfig(env)) return undefined;
  return {
    title: "Bots inherit this machine's Claude Code setup",
    message:
      "OMB_CLAUDE_INHERIT_USER_CONFIG=1 is set on the OpenMausBot process, so every Claude bot also loads this " +
      "computer's own MCP servers, connectors, skills, hooks and personal CLAUDE.md on every turn — often thousands " +
      "of extra tokens per model call, and tools nobody gave the bot. Unless a bot genuinely needs a server from " +
      "your user-scope Claude config, remove the variable and restart; add the server under Settings → MCP servers " +
      "or the bot project's .mcp.json instead.",
  };
}

/** Retain the selected CLI account's authentication without importing its
 * hooks, permissions, MCP servers or personal instructions. Explicit OMB
 * connections/local endpoints own their entire routing + credential pair. */
export function readClaudeAuthSettings(
  env: NodeJS.ProcessEnv,
  instanceEnvironment: NodeJS.ProcessEnv = {},
): { env?: Record<string, string>; apiKeyHelper?: string } {
  if (CLAUDE_ACCOUNT_ENV_KEYS.some((key) => instanceEnvironment[key])) return {};
  try {
    const settings = JSON.parse(readFileSync(join(resolveClaudeConfigDir(undefined, env), "settings.json"), "utf8"));
    const authEnv: Record<string, string> = {};
    for (const key of CLAUDE_ACCOUNT_ENV_KEYS) {
      if (!key.endsWith("_FILE_DESCRIPTOR") && typeof settings?.env?.[key] === "string") {
        authEnv[key] = settings.env[key];
      }
    }
    return {
      ...(Object.keys(authEnv).length ? { env: authEnv } : {}),
      ...(typeof settings?.apiKeyHelper === "string" && settings.apiKeyHelper.trim()
        ? { apiKeyHelper: settings.apiKeyHelper } : {}),
    };
  } catch {
    return {};
  }
}

/** MCP servers the bot's own project declares in `<cwd>/.mcp.json`.
 *
 * The CLI would find this file itself, but the harness launches it with
 * --strict-mcp-config, which makes the harness's config the only source.
 * The project file IS part of the bot's definition (its cwd is chosen per
 * bot), so it is forwarded verbatim — including `type: "http"`/`"sse"`
 * entries the harness never mounts itself, because the CLI, not this code,
 * is what has to understand them. A malformed file is ignored rather than
 * failing the turn: an unreadable project config must not brick a bot. */
export function projectMcpServers(cwd: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
  } catch {
    return {};
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
  const out: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers as Record<string, unknown>)) {
    if (server && typeof server === "object" && !Array.isArray(server)) out[name] = server;
  }
  return out;
}

/** The CLI compacts its own session when it approaches a window. Left alone
 * that window is the model's, so a Sonnet 5 session runs to something near a
 * million tokens before anything happens — and every model call until then
 * re-reads the whole thing. The measured food-ordering thread sat at 330k
 * tokens per call and looked perfectly healthy to the CLI.
 *
 * So the harness picks the window instead. This delegates the actual
 * compaction to the CLI, which owns the session and already has a summarizer
 * for it; the harness only decides when it is worth paying for.
 *
 * OMB_CLAUDE_AUTOCOMPACT takes a token count, "auto" to hand the decision
 * back to the CLI, or "off" to pass nothing at all. The CLI rejects a window
 * outside 100k-1M as a hard argument error, so a configured value is clamped
 * rather than passed through: a mistyped setting must not fail every turn. */
export function autoCompactWindow(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.OMB_CLAUDE_AUTOCOMPACT ?? "").trim().toLowerCase();
  if (raw === "off") return null;
  if (raw === "auto") return "auto";
  const parsed = raw ? Number(raw) : DEFAULT_AUTOCOMPACT_TOKENS;
  if (!Number.isFinite(parsed) || parsed <= 0) return String(DEFAULT_AUTOCOMPACT_TOKENS);
  return String(Math.min(1_000_000, Math.max(100_000, Math.floor(parsed))));
}

/** Generous for real work, and still a third of where a 1M-window session
 * would otherwise get to. With bot tool results gated (mcp-gate.ts) most
 * threads never reach it; this is the backstop for the ones that do. */
const DEFAULT_AUTOCOMPACT_TOKENS = 200_000;
