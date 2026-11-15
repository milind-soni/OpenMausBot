// The environment a boxed process gets: an allow-list, never the server's whole environment. The drivers already strip
// the workspace credentials and every OMB_CLOUD_ setting before a spawn (server/config.ts stripWorkspaceCredentialEnv);
// this is the second gate, applied at the box boundary, so a name a driver forgot never reaches a bot's shell.

/** Names a bot's engine, its tools and the proxies OpenMausBot starts inside the box may read. */
export const BOX_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "HOSTNAME", "PWD",
  "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "TMPDIR", "NO_COLOR", "FORCE_COLOR", "CI", "DEBUG",
  "NODE_ENV", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY",
  "AGENT_BROWSER_EXECUTABLE_PATH", "BROWSER", "BASH_MAX_TIMEOUT_MS", "ELECTRON_RUN_AS_NODE", "PYTHONUNBUFFERED", "PYTHONDONTWRITEBYTECODE",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
]);

/** OpenMausBot's own variables a boxed process reads: what the harness sets for a bot's engine, its hooks and the MCP
 * proxies it starts. Security: no other `OMB_` name passes, whatever the operator set on the server (an SMTP URL, a
 * token); env.test.ts lists every `OMB_` name the server knows, so a new one needs a decision. */
export const BOX_ENV_OMB_NAMES: ReadonlySet<string> = new Set([
  "OMB_HARNESS_URL", "OMB_BOT_ID", "OMB_THREAD_ID", "OMB_COMMS_TOKEN", "OMB_EXTERNAL_RUNTIME",
  "OMB_CHIEF_OF_STAFF", "OMB_MAUSBOT", "OMB_SKILL_AUTHORING_ENABLED", "OMB_MEMORY_ENABLED", "OMB_SHARED_COMPUTERS_ENABLED",
  "OMB_VOICE_NOTES", "OMB_X_RESEARCH", "OMB_RESEARCH", "OMB_TEAM_PEOPLE", "OMB_COMPUTER_SELECTION", "OMB_ROOM",
  "OMB_IMAGE_GENERATION", "OMB_MEETINGS", "OMB_APP_HOSTING", "OMB_AGENTS_TOOL_BRIDGE", "OMB_TOOL_LIMIT", "OMB_TOOL_SCHEMA_PROFILE",
  "OMB_MCP_CONFIG", "OMB_MCP_RESTART", "OMB_MCP_RESULT_BUDGET",
  "OMB_HOOK_URL", "OMB_HOOK_TOKEN_FILE", "OMB_HOOK_TIMEOUT_MS", "OMB_PERMISSION_TOOL_SCOPE",
  "OMB_CONNECTOR_UPSTREAM_URL", "OMB_CONNECTOR_UPSTREAM_HEADERS", "OMB_CONNECTOR_TOKEN", "OMB_CONNECTOR_ALLOWED_TOOLS",
  "OMB_CONNECTOR_SERVICE_SLUGS", "OMB_CONNECTOR_APP_TOOLS", "OMB_CONNECTOR_APP_TOOL_NAMES",
  "OMB_GATE_NAME", "OMB_GATE_UPSTREAM", "OMB_GATE_BUDGET", "OMB_GATE_SPILL_DIR", "OMB_GATE_SPILL_HINT", "OMB_GATE_TOOL_SCOPE",
  "OMB_GATE_DIRECTORY", "OMB_GATE_APPS", "OMB_REMOTE_MCP_SERVER", "OMB_REMOTE_MCP_DIRECTORY", "OMB_REMOTE_MCP_APPS",
  "OMB_CONTROL_URL", "OMB_CONTROL_TOKEN", "OMB_COMPUTER_JOURNAL", "OMB_CUA_ARGS", "OMB_CUA_COMMAND", "OMB_CUA_PLATFORM",
  "OMB_PHONE_TOKEN", "OMB_ADB_PATH", "OMB_RESOURCES_PATH", "OMB_CODEX_AUTH_SOCKET", "OMB_CODEX_AUTH_SECRET",
  "OMB_COPILOT_MCP_CONFIG", "OMB_BROWSER_PROFILE", "OMB_BOX_PROBE", "OMB_EXTRA_PATH", "OMB_TEST_SEALED_PATH",
]);
/** Families of the same, one variable per server or kind: a harness MCP server's token, a gated or remote server's config. */
export const BOX_ENV_OMB_PREFIXES: readonly string[] = ["OMB_MCP_TOKEN_", "OMB_GATE_CONFIG_", "OMB_REMOTE_MCP_CONFIG_"];

/** Prefixes of the engines' own settings and keys (T0b replaces the keys with per-turn broker tokens). */
export const BOX_ENV_PREFIXES: readonly string[] = [
  "LC_", "OPENMAUSBOT_", "NPM_CONFIG_", "npm_config_",
  "ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_", "OPENCODE_", "OPENROUTER_", "GEMINI_", "GOOGLE_", "GROK_", "XAI_",
  "MISTRAL_", "CEREBRAS_", "GROQ_", "GREENFERENCE_", "MODELGO_", "META_", "MINIMAX_", "KIMI_", "MOONSHOT_", "CURSOR_", "FACTORY_", "CLINE_", "HERMES_",
  "MUSE_", "PI_", "DWEB_", "UNSLOTH_", "FAKE_CLAUDE_", "MCP_", "ANTIGRAVITY_", "AGY_",
];

/** Never, whatever the allow-list says: the control plane's settings and secrets, and the server's own placement. The
 * CLI's session token and server address (server/headless/client.ts) too: nothing in a box reads them, and one an
 * operator set on the server would otherwise pass under the engines' OPENMAUSBOT_ prefix. */
export const BOX_ENV_NEVER: ReadonlySet<string> = new Set([
  "OMB_LICENSE_KEY", "OMB_INSTALLATION_CREDENTIAL", "OMB_LOOPBACK_TRUST", "OMB_CLOUD_SECRETS_FD",
  "OMB_DATA_DIR", "OMB_STATIC_DIR", "OMB_DUCKDB_DIR", "OMB_PORT", "OMB_WEBHOOK_PORT",
  "OPENMAUSBOT_TOKEN", "OPENMAUSBOT_URL",
]);
export const BOX_ENV_NEVER_PREFIXES: readonly string[] = ["OMB_CLOUD_"];

/** `allow` is what one spawn vouches for: the keys the person saved for its engine, under whatever name that engine reads
 * (NANO_GPT_API_KEY, OPENCODE_API_KEY). Security: it lifts the allow-list and `deny` for that process only, and never for
 * a name of OpenMausBot's own (`OMB_`) or one on the never-list. */
export function boxEnvironmentAllows(name: string, deny: ReadonlySet<string> = new Set(), allow: ReadonlySet<string> = new Set()): boolean {
  if (BOX_ENV_NEVER.has(name) || BOX_ENV_NEVER_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  if (allow.has(name) && !name.startsWith("OMB_")) return true;
  if (deny.has(name)) return false;
  if (name.startsWith("OMB_")) return BOX_ENV_OMB_NAMES.has(name) || BOX_ENV_OMB_PREFIXES.some((prefix) => name.startsWith(prefix));
  return BOX_ENV_NAMES.has(name) || BOX_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The box's environment: the allowed names of `env` with a value, in a fresh object. `deny` adds names (the workspace
 * credentials) that are refused even when a prefix would allow them. */
export function boxEnvironment(
  env: Record<string, string | undefined>,
  deny: ReadonlySet<string> = new Set(),
  allow: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !boxEnvironmentAllows(name, deny, allow)) continue;
    kept[name] = value;
  }
  return kept;
}

/** The names of `env` that hold the value `instance` gave them: what the environment configured for one engine instance
 * (its saved keys) put in a spawn, for that spawn's `allowEnv`. */
export function instanceEnvNames(instance: Readonly<Record<string, string>>, env: Record<string, string | undefined>): string[] {
  return Object.keys(instance).filter((name) => env[name] !== undefined && env[name] === instance[name]);
}
