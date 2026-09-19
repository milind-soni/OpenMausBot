// The runtime instance fleet: default fleet construction with per-driver
// credential env injection, the persistable (secret-free) projection of it,
// and the per-instance config.cli override.
import type { InstanceConfigMap } from "../contracts.ts";
import type { JsonObject } from "../schema.ts";
import { jsonObjectSchema, type AppConfig } from "./schema.ts";

/** Set one instance's `config.cli` ("" clears the override back to the
 * driver default). Creating the instance entry is fine — a config-less
 * entry rides driver.defaultConfig(). Returns false for unknown instances
 * when the fleet is explicitly configured. The returned map must stay
 * PERSISTABLE: instanceConfigs() injects credential env into consuming
 * drivers' entries for the live fleet, so only their originally configured
 * environment is retained — otherwise saving an override would
 * copy xai/box/opencodeGo secrets into the instances section of
 * config.json. */
export function withInstanceCli(
  cfg: AppConfig,
  instanceId: string,
  cli: string,
): InstanceCliUpdate {
  const next: AppConfig = structuredClone(cfg);
  const map = persistableInstanceConfigs(next);
  // hasOwn, not truthiness: map is a plain object literal, so
  // map["__proto__"] resolves to Object.prototype — truthy — and the
  // assignment below would poison EVERY object in the process (instanceId
  // comes off the URL, where `__proto__` passes the route's [\w.-]+ regex)
  if (!Object.hasOwn(map, instanceId)) return { ok: false, config: cfg };
  const entry = map[instanceId];
  const cliKey = cli.trim();
  const currentConfig = jsonObjectSchema.safeParse(entry.config);
  if (cliKey) {
    const nextConfig: JsonObject = currentConfig.success ? { ...currentConfig.data } : {};
    nextConfig.cli = cliKey;
    entry.config = nextConfig;
  } else if (currentConfig.success && Object.hasOwn(currentConfig.data, "cli")) {
    const rest = { ...currentConfig.data };
    delete rest.cli;
    entry.config = Object.keys(rest).length ? rest : undefined;
  }
  next.instances = map;
  return { ok: true, config: next };
}

/** Materialize defaults without freezing injected workspace settings or secrets. */
export function persistableInstanceConfigs(cfg: AppConfig): InstanceConfigMap {
  const map = instanceConfigs(cfg);
  for (const [id, entry] of Object.entries(map)) {
    const environment = cfg.instances?.[id]?.environment;
    if (environment) entry.environment = { ...environment };
    else delete entry.environment;
    const config = cfg.instances?.[id]?.config;
    if (config !== undefined) entry.config = structuredClone(config);
    else delete entry.config;
  }
  return map;
}

interface InstanceCliUpdate {
  ok: boolean;
  config: AppConfig;
}

/** The credential env instanceConfigs() injects for one driver at runtime.
 * Each secret goes only to the driver that actually reads it: the API-key
 * Grok driver reads XAI_API_KEY, the Computer driver reads BOX_TOKEN, and
 * OpenCode reads OPENCODE_API_KEY. Every other engine brings its own
 * login, so handing it a key it never uses would only put that key in the
 * environment of an unrelated child process. */
function injectedEnvironment(cfg: AppConfig, driver: string): Map<string, string> {
  const environment = new Map<string, string>();
  if (driver === "grok" && cfg.xai?.key) environment.set("XAI_API_KEY", cfg.xai.key);
  // The workspace Anthropic key reaches Claude Code as the variable it
  // reads, carried in the instance environment so the driver can tell a
  // deliberate workspace key from one riding along in the parent's env.
  if (driver === "claudeAgent" && cfg.anthropic?.key) environment.set("ANTHROPIC_API_KEY", cfg.anthropic.key);
  if (driver === "claudeAgent" && cfg.anthropic?.key && cfg.anthropic.url) environment.set("ANTHROPIC_BASE_URL", cfg.anthropic.url);
  if (driver === "openai-compat" && cfg.openaiCompat?.key)
    environment.set("OPENAI_COMPAT_API_KEY", cfg.openaiCompat.key);
  if (driver === "openai-compat" && cfg.openaiCompat?.url)
    environment.set("OPENAI_COMPAT_URL", cfg.openaiCompat.url);
  if (driver === "boxAgent" && cfg.box?.token) environment.set("BOX_TOKEN", cfg.box.token);
  if (driver === "opencodeGo" && cfg.opencodeGo?.apiKey) environment.set("OPENCODE_API_KEY", cfg.opencodeGo.apiKey);
  return environment;
}

// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars — but only into the
// driver that consumes each key (injectedEnvironment above).
export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  // The default `grok` instance rides the `grokAgent` driver, not the API-key
  // one: like claude and codex it needs no credential from us, just the CLI
  // installed and logged in (it shows up unavailable otherwise). The API-key
  // `grok` driver stays registered but out of the default fleet — that key is
  // a credential Milind doesn't want to manage; an `instances` entry brings
  // it back anytime.
  //
  // Google rides `antigravityAgent` (the official Google ACP server), not
  // `geminiAgent`:
  // Google retired Gemini CLI for the free/Pro/Ultra tiers on 2026-06-18
  // (developers.googleblog.com, "transitioning Gemini CLI to Antigravity
  // CLI"), so a default `gemini` instance could only ever show unavailable.
  // The driver stays registered for enterprise licences, which keep Gemini
  // CLI — `{"instances": {"gemini": {"driver": "geminiAgent"}}}` restores it.
  const DEFAULT_FLEET: InstanceConfigMap = {
    grok: { driver: "grokAgent" },
    kimi: { driver: "kimiAgent" },
    droid: { driver: "droidAgent" },
    cursor: { driver: "cursorAgent" },
    claude: { driver: "claudeAgent" },
    codex: { driver: "codex" },
    antigravity: { driver: "antigravityAgent" },
    opencodeGo: { driver: "opencodeGo" },
    computer: { driver: "boxAgent" },
    openaiCompat: { driver: "openai-compat" },
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
    pi: { driver: "piAgent" },
  };
  const CUSTOM_ONLY = {
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
    pi: { driver: "piAgent" },
  } as const;
  // New default-fleet engines that existing product configs would otherwise
  // never see. Custom-only engines stay in CUSTOM_ONLY so a one-off test map
  // is not expanded, matching the claude/grok/codex product-fleet probe.
  const PRODUCT_FLEET_ADDITIONS = {
    cursor: { driver: "cursorAgent" },
    openaiCompat: { driver: "openai-compat" },
    ...CUSTOM_ONLY,
  } as const;
  const configured = cfg.instances && Object.keys(cfg.instances).length ? cfg.instances : null;
  const map: InstanceConfigMap = configured ? { ...configured } : { ...DEFAULT_FLEET };
  // Product fleets pick up newly shipped engines. A one-off test/shadow map
  // (no claude/grok/codex) is left exactly as written.
  if (
    configured &&
    (Object.hasOwn(configured, "claude") || Object.hasOwn(configured, "grok") || Object.hasOwn(configured, "codex"))
  ) {
    for (const [id, entry] of Object.entries(PRODUCT_FLEET_ADDITIONS)) {
      if (!Object.hasOwn(map, id)) map[id] = { ...entry };
    }
  }
  // A configured Box runs every cloud and team-Box surface on the boxAgent
  // "Computer" engine: the turn runner, the Computer panel's engine gate,
  // and selectableComputers all look that runner up in the fleet. A custom
  // map that omits it would leave Box configured while every cloud surface
  // reports unusable and cloud turns fail with a configure-Box hint, so
  // materialize the runner exactly when Box is configured (boxConfigured's
  // own check) and no entry rides the driver.
  if (configured && cfg.box?.token && !Object.values(map).some((entry) => entry.driver === "boxAgent")) {
    map.computer = { driver: "boxAgent" };
  }
  for (const [id, sourceEntry] of Object.entries(map)) {
    // instanceConfigs() builds a transient runtime map. Never mutate the
    // caller's persisted entries while injecting workspace defaults: doing so
    // would turn the first workspace URL into a stale per-instance override.
    const entry = { ...sourceEntry };
    map[id] = entry;
    const environment = { ...entry.environment };
    for (const [key, value] of injectedEnvironment(cfg, entry.driver)) environment[key] = value;
    entry.environment = environment;
    // The driver URL is configuration, not a credential. Environment is
    // intentionally not consulted by ProviderRegistry when it decodes a
    // driver's config, so carry the workspace default into the transient
    // instance map while preserving a per-instance override.
    if (entry.driver === "openai-compat" && cfg.openaiCompat) {
      const defaults: Record<string, string> = {};
      if (cfg.openaiCompat.url) defaults.url = cfg.openaiCompat.url;
      if (cfg.openaiCompat.model) defaults.model = cfg.openaiCompat.model;
      if (cfg.openaiCompat.provider) defaults.provider = cfg.openaiCompat.provider;
      if (Object.keys(defaults).length) {
        const raw = entry.config;
        const current =
          typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
        const merged = { ...current };
        // A per-instance value always wins over the workspace default.
        for (const [k, v] of Object.entries(defaults)) {
          // Empty routing explicitly means "no upstream pin" for isolated
          // API connections. Do not replace it with a workspace provider.
          if (k === "provider" && typeof merged[k] === "string") continue;
          if (typeof merged[k] !== "string" || !(merged[k] as string).trim()) merged[k] = v;
        }
        entry.config = merged;
      }
    }
  }
  return map;
}
