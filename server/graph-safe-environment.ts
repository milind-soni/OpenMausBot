/**
 * Environment variables that can change how a provider CLI or one of its
 * stdio children is located, initialized, or made to load code before the
 * approved graph prompt runs. Provider-instance environment is user
 * configuration, so none of these names may participate in an admitted
 * graph route or cross the full-task process boundary.
 *
 * Matching is deliberately case-insensitive. Windows treats environment
 * names that way, and a draft created on one platform must not become more
 * permissive when it is executed on another.
 */
const UNSAFE_GRAPH_ENVIRONMENT_NAMES = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_REPL_EXTERNAL_MODULE",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SHELL",
  "ZDOTDIR",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "WINDIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "OPENSSL_CONF",
  "OPENSSL_MODULES",
  "SSLKEYLOGFILE",
  "RUBYOPT",
  "RUBYLIB",
  "GEM_HOME",
  "GEM_PATH",
  "PERL5OPT",
  "PERL5LIB",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "CLASSPATH",
  "LUA_PATH",
  "LUA_CPATH",
  "GCONV_PATH",
  "ELECTRON_RUN_AS_NODE",
  "OMB_CLAUDE_API_KEY_ALIAS",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDECODE",
  "CODEX_HOME",
]);

export function isUnsafeGraphEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return UNSAFE_GRAPH_ENVIRONMENT_NAMES.has(normalized) ||
    normalized.startsWith("LD_") ||
    normalized.startsWith("DYLD_") ||
    normalized.startsWith("ANTHROPIC_") ||
    normalized.startsWith("CLAUDE_CODE_") ||
    normalized.startsWith("CODEX_") ||
    normalized.startsWith("OPENAI_");
}

export function unsafeGraphEnvironmentNames(
  environment: Readonly<Record<string, unknown>>,
): string[] {
  return Object.keys(environment)
    .filter(isUnsafeGraphEnvironmentName)
    .sort((left, right) => left.localeCompare(right));
}

export function hasUnsafeGraphEnvironment(
  environment: Readonly<Record<string, unknown>>,
): boolean {
  return Object.keys(environment).some(isUnsafeGraphEnvironmentName);
}

/** Return a fresh object so callers cannot accidentally mutate shared config. */
export function stripUnsafeGraphEnvironment<T>(
  environment: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !isUnsafeGraphEnvironmentName(name)),
  ) as Record<string, T>;
}

/**
 * Full-task providers receive a closed process environment, not a denylist.
 * Locale/display-only settings are copied from the parent; executable search
 * paths and provider homes must be supplied as explicit app-owned overrides.
 * Vitest's scripted provider controls are admitted only in a test process.
 */
export function isolatedGraphChildEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  trustedOverrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  const output: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(source)) {
    const normalized = name.toUpperCase();
    if (
      normalized === "LANG" || normalized === "LANGUAGE" || normalized === "TZ" ||
      normalized === "TERM" || normalized === "COLORTERM" || normalized === "NO_COLOR" ||
      normalized === "FORCE_COLOR" || normalized === "SYSTEMROOT" || normalized === "WINDIR" ||
      normalized.startsWith("LC_")
    ) output[name] = value;
    else if (
      source.NODE_ENV === "test" &&
      (normalized.startsWith("FAKE_CLAUDE_") || normalized.startsWith("FAKE_CODEX_"))
    ) output[name] = value;
  }
  for (const [name, value] of Object.entries(trustedOverrides)) {
    if (value !== undefined) output[name] = value;
  }
  return output;
}

/** Exact environment contract for the app-owned capability MCP proxy. */
export function isolatedGraphCapabilityMcpEnvironment(
  source: Readonly<Record<string, string>>,
): Record<string, string> {
  const allowed = new Set([
    "ELECTRON_RUN_AS_NODE",
    "OMB_HARNESS_URL",
    "OMB_COMMS_TOKEN",
    "OMB_TURN_TOKEN",
  ]);
  return Object.fromEntries(Object.entries(source).filter(([name]) => allowed.has(name)));
}
