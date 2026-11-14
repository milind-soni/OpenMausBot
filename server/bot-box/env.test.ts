import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BOX_ENV_NAMES, BOX_ENV_NEVER, BOX_ENV_OMB_NAMES, BOX_ENV_OMB_PREFIXES, boxEnvironment, boxEnvironmentAllows, instanceEnvNames } from "./env.ts";

/** Every other `OMB_` name the server's code knows: decided to stay on the server, never in a bot's environment. A name
 * ending in `_` is a family (`OMB_CLOUD_*`). */
const SERVER_ONLY_OMB: ReadonlySet<string> = new Set([
  "OMB_ACP_LIMIT_QUIET_MS", "OMB_ACP_NO_SIGNS_STOP_MS", "OMB_ACP_PLAN_LINES", "OMB_ACP_QUIET_NOTICE_MS",
  "OMB_ACP_QUIET_TICK_MS", "OMB_ACP_SESSION_IDLE_", "OMB_ACP_SHARED_RECYCLE_MS", "OMB_ADMIN_", "OMB_ADMIN_MEMBERSHIP",
  "OMB_ADMIN_URL", "OMB_ADMIN_WORKSPACE", "OMB_AGENT_BROWSER_PATH", "OMB_AI_CHECKS", "OMB_ANTHROPIC_API_KEY",
  "OMB_ANTHROPIC_API_URL", "OMB_APP_VERSION", "OMB_ATTACHMENTS_MAX_BYTES", "OMB_AZURE_OPENAI_LIVE_DEPLOYMENT",
  "OMB_AZURE_OPENAI_LIVE_ENDPOINT", "OMB_BOAT_API", "OMB_BOT_BOX", "OMB_BOX_CANARY", "OMB_BRAND_FILE",
  "OMB_BROWSER_CONNECTION", "OMB_BROWSER_IDLE_HANDOVER_MS", "OMB_BROWSER_LANG", "OMB_BROWSER_LEGACY_SHELL",
  "OMB_BROWSER_MAX_RUNNING", "OMB_BROWSER_SANDBOX", "OMB_BROWSER_SCREEN", "OMB_BROWSER_TIMEZONE", "OMB_BROWSER_TIMING",
  "OMB_BUG_REPORT_URL", "OMB_CADDY_PATH", "OMB_CHROME_PATH", "OMB_CLAUDE_AUTOCOMPACT",
  "OMB_CLAUDE_INHERIT_USER_CONFIG", "OMB_CLAUDE_SESSION_IDLE_", "OMB_CLI_OWNER_STDIN", "OMB_CLI_PREFIX",
  "OMB_CLOUDFLARED_PATH", "OMB_CLOUD_", "OMB_CLOUD_ADMIN_URL", "OMB_CLOUD_AI_TOKEN", "OMB_CLOUD_AI_URL",
  "OMB_CLOUD_BOAT_TOKEN", "OMB_CLOUD_BOAT_URL", "OMB_CLOUD_BOOTSTRAP_SECRET", "OMB_CLOUD_CAPS_DROPPED",
  "OMB_CLOUD_CLIENT_IP_HEADER", "OMB_CLOUD_COMPUTER_AUTO_REPLACE", "OMB_CLOUD_COMPUTER_DEAD_CONFIRM_MS", "OMB_CLOUD_COMPUTER_IDLE_MS", "OMB_CLOUD_COMPUTER_START_BUDGET_MS",
  "OMB_CLOUD_CONNECTED_APPS_GRANT", "OMB_CLOUD_DECIDER_TOKEN", "OMB_CLOUD_DECIDER_URL", "OMB_CLOUD_EDGE_ACME_EMAIL",
  "OMB_CLOUD_EDGE_ACME_FALLBACK_ONLY", "OMB_CLOUD_EDGE_BIN", "OMB_CLOUD_EDGE_CERT_ISSUERS",
  "OMB_CLOUD_EDGE_CLIENT_IP_HEADER", "OMB_CLOUD_EDGE_CONFIG", "OMB_CLOUD_EDGE_HOLD", "OMB_CLOUD_EDGE_STORAGE",
  "OMB_CLOUD_EDGE_TLS", "OMB_CLOUD_EDGE_TRUSTED_PROXIES", "OMB_CLOUD_EXPORT_ONLY", "OMB_CLOUD_HARDEN", "OMB_CLOUD_HOSTING_TOKEN", "OMB_CLOUD_HOSTING_URL",
  "OMB_CLOUD_HOME", "OMB_CLOUD_IMAGE", "OMB_CLOUD_LEGACY_ORIGINS", "OMB_CLOUD_MACHINE_ID", "OMB_CLOUD_MOVES",
  "OMB_CLOUD_PUBLIC_HOST", "OMB_CLOUD_ROLE", "OMB_CLOUD_SECRETS_FD", "OMB_CLOUD_STAGING",
  "OMB_CLOUD_STOPPED_HOLD_DAYS", "OMB_CLOUD_TEAM_ID", "OMB_CLOUD_TEAM_LANGUAGE", "OMB_CLOUD_TEAM_NAME",
  "OMB_CLOUD_TRUSTED_PROXIES", "OMB_CLOUD_TUNNEL_BIN", "OMB_CLOUD_TUNNEL_TOKEN", "OMB_CLOUD_VOICE_TOKEN",
  "OMB_CLOUD_VOICE_URL", "OMB_CLOUD_X_TOKEN", "OMB_CLOUD_X_URL", "OMB_CODEX_LAUNCH_SLOTS", "OMB_COMPANION_DIR",
  "OMB_COMPANION_HOSTED_URL", "OMB_COMPANION_INTERNAL_ORIGIN", "OMB_COMPANION_PORT", "OMB_COMPANION_ROUTES",
  "OMB_COMPANION_TAILNET_NAME", "OMB_COMPOSIO_API", "OMB_COMPOSIO_BROKER", "OMB_COMPOSIO_BROKER_TOKEN",
  "OMB_COMPOSIO_BROKER_URL", "OMB_COMPOSIO_TOOLKITS_API", "OMB_COMPUTER_CALL_ACT_WITHIN_MS",
  "OMB_COMPUTER_CALL_WAIT_MS", "OMB_COMPUTER_WAIT_MAX_MS", "OMB_CONTROL_PLANE_URL", "OMB_CONTROL_PORT",
  "OMB_CREDENTIAL_STORE", "OMB_CUSTOM_DECIDER_KEY", "OMB_CUSTOM_IMAGE_KEY", "OMB_DATA_DIR", "OMB_DECISION_RETENTION_DAYS",
  "OMB_DEEPSEEK_API_KEY", "OMB_DESKTOP_LAUNCH_ID", "OMB_DESKTOP_PARENT", "OMB_DEVS_STATUS_MS",
  "OMB_DEV_TRUST_LOCAL_BROWSER", "OMB_DISABLE_ANNOUNCEMENTS", "OMB_DISABLE_MODEL_CATALOG_FETCH", "OMB_DISABLE_MODEL_MANIFEST_FETCH", "OMB_DUCKDB_DIR", "OMB_DUCKDB_MAX_TEMP_SIZE",
  "OMB_DUCKDB_MEMORY_LIMIT", "OMB_ELEVENLABS_API", "OMB_ENTERPRISE_DIR", "OMB_ENVIRONMENT_LABEL", "OMB_EOF",
  "OMB_FIRST_REPLY_NOTICE_MS", "OMB_FISH_AUDIO_API", "OMB_FISH_AUDIO_API_KEY", "OMB_FISH_LIVE_AGENT_ID", "OMB_FISH_LIVE_URL", "OMB_FLEET_SOCKET", "OMB_GATE_",
  "OMB_GEMINI_API_KEY", "OMB_GEMINI_IMAGE_KEY", "OMB_GEMINI_TTS_API", "OMB_GOAL_WAIT_MAX_MS",
  "OMB_GREENFERENCE_API_KEY", "OMB_LLMTR_API_KEY", "OMB_GROQ_API_KEY", "OMB_HELPER_INSTANCE", "OMB_HELPER_MODEL", "OMB_HOOKS", "OMB_HOOK_",
  "OMB_HOSTED_", "OMB_HOSTED_MODELS", "OMB_HOSTED_MODEL_TOKEN", "OMB_HOSTED_MODEL_URL", "OMB_INSTALLATION_CREDENTIAL",
  "OMB_JEV_API_KEY", "OMB_LAN", "OMB_LICENSE_KEY", "OMB_LINUX_GPU", "OMB_LIVE_PROVIDER", "OMB_LOCAL_VM_UPDATE_WAIT_MS",
  "OMB_LOOPBACK_TRUST", "OMB_LOOP_GUARD", "OMB_LOOP_GUARD_STOP_AT", "OMB_META_API_KEY", "OMB_MODELGO_API_KEY", "OMB_NETLIFY_API_URL", "OMB_OPENAI_API_KEY",
  "OMB_OPENAI_IMAGE_KEY", "OMB_OPENAI_LIVE_KEY", "OMB_OPENAI_LIVE_URL", "OMB_OPENROUTER_API_KEY",
  "OMB_OPENROUTER_DECIDER_KEY", "OMB_PERSON_FIRST_MS", "OMB_PHONE_RELAY", "OMB_PHONE_RELAY_URL", "OMB_PHONE_SECRET_PUBLIC_KEY", "OMB_PORT", "OMB_SERVES_TUNNEL", "OMB_POSTIZ_API_KEY",
  "OMB_POSTIZ_CLOUD_URL", "OMB_PROCESS_ID", "OMB_PUBLIC_IPV4", "OMB_PUBLIC_URL", "OMB_QUOTA_SWITCH",
  "OMB_REPLAY_TOOL_HISTORY", "OMB_ROOM_SESSIONS", "OMB_SAFETY_FLOOR", "OMB_SERVER_COMPILE_CACHE", "OMB_SERVER_NAME",
  "OMB_SERVER_UPDATE_DIR",
  "OMB_SESSION_IDLE_MIN_MS", "OMB_SESSION_IDLE_MS", "OMB_SESSION_MAX_DAYS", "OMB_SESSION_TTL_DAYS",
  "OMB_SHARED_WORKSPACE_FULL_ACCESS", "OMB_SIGNIN_EMAILS", "OMB_SIGNIN_MEMBER_EMAILS", "OMB_SIGNIN_SMTP_FROM",
  "OMB_SIGNIN_SMTP_URL", "OMB_SKILLS_DIR", "OMB_SMOKE_BUNDLED_CUA", "OMB_SMOKE_CUA", "OMB_SMOKE_KEEP_OPEN",
  "OMB_SMOKE_TEST", "OMB_SSE_HEARTBEAT_MS", "OMB_STATIC_DIR", "OMB_SYNC_ROOT", "OMB_TAILNET_ADDRESSES", "OMB_TAILNET_NAME", "OMB_TAILNET_SERVED", "OMB_TEAM_AWAY_WINDOW_MS",
  "OMB_TEAM_PRESENCE_GRACE_MS", "OMB_TEST_INTERNAL_CAPABILITY_KEY", "OMB_TEST_ORG_LIBRARY_KEY",
  "OMB_TEST_PLAN_USAGE_FILE", "OMB_TEST_TAILNET_STAND_IN", "OMB_TOOL_STALL_MS", "OMB_TREG_KEY", "OMB_TREG_URL", "OMB_TTS_DEFAULT_VOICE",
  "OMB_TTS_KEY", "OMB_TUNNEL_ORIGIN_PORT", "OMB_TUNNEL_SOCKET", "OMB_TURN_STALL_MS", "OMB_UPDATE_CHANNEL", "OMB_UPDATE_INSTALL",
  "OMB_USER_DATA", "OMB_WARM_SUMMARY", "OMB_WARM_SUMMARY_TIME_SCALE", "OMB_WEBHOOK_PORT", "OMB_WEBHOOK_PUBLIC_URL", "OMB_WEBHOOK_SOCKET",
  "OMB_WORKERS_AI_TOKEN", "OMB_XAI_TTS_API",
]);

const ROOT = new URL("../../", import.meta.url);

/** The `OMB_` names in the code the server runs, and in what starts it (the desktop app). */
function knownOmbNames(): string[] {
  const files = execFileSync("git", ["ls-files", "server", "shared", "packages", "enterprise/server", "electron"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((file) => /\.(?:ts|mts|mjs|cjs|js)$/.test(file) && !/\.test\.|\/testing\/|node-test/.test(file));
  const names = new Set<string>();
  for (const file of files) for (const match of readFileSync(new URL(file, ROOT), "utf8").matchAll(/\bOMB_[A-Z0-9_]+\b/g)) names.add(match[0]);
  return [...names].sort();
}

describe("the box's environment allow-list", () => {
  it("keeps what an engine needs and drops the server's own settings and the control plane", () => {
    const kept = boxEnvironment({
      PATH: "/usr/bin", HOME: "/data", LANG: "C.UTF-8", TZ: "Europe/Berlin", LC_ALL: "C", TERM: "xterm",
      ANTHROPIC_API_KEY: "sk-ant-1", ANTHROPIC_BASE_URL: "http://127.0.0.1:18080/b/t/anthropic", CLAUDE_CONFIG_DIR: "/data/.claude",
      OPENAI_API_KEY: "sk-1", CODEX_HOME: "/data/.codex", OMB_HOOK_URL: "http://127.0.0.1:8799/api/internal/hook", OMB_COMMS_TOKEN: "cap",
      HTTPS_PROXY: "http://127.0.0.1:3128", NO_PROXY: "127.0.0.1", NPM_CONFIG_LOGLEVEL: "error", ELECTRON_RUN_AS_NODE: "1",
      OMB_CLOUD_BOOTSTRAP_SECRET: "s", OMB_CLOUD_MACHINE_ID: "m", OMB_CLOUD_ADMIN_URL: "https://a", OMB_LICENSE_KEY: "k",
      OMB_DATA_DIR: "/data/.openmausbot", OMB_PORT: "8799", OMB_LOOPBACK_TRUST: "owner", AWS_SECRET_ACCESS_KEY: "aws", SSH_AUTH_SOCK: "/x",
      SOME_RANDOM_NAME: "x", EMPTY: undefined,
    });
    expect(Object.keys(kept).sort()).toEqual([
      "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "ELECTRON_RUN_AS_NODE", "HOME", "HTTPS_PROXY", "LANG", "LC_ALL",
      "NO_PROXY", "NPM_CONFIG_LOGLEVEL", "OMB_COMMS_TOKEN", "OMB_HOOK_URL", "OPENAI_API_KEY", "PATH", "TERM", "TZ",
    ]);
  });

  it("a denied name loses even against an allowing list or prefix, and the never-list beats everything", () => {
    expect(boxEnvironmentAllows("OMB_COMMS_TOKEN")).toBe(true);
    expect(boxEnvironmentAllows("OMB_COMMS_TOKEN", new Set(["OMB_COMMS_TOKEN"]))).toBe(false);
    expect(boxEnvironmentAllows("ANTHROPIC_API_KEY", new Set(["ANTHROPIC_API_KEY"]))).toBe(false);
    expect(boxEnvironmentAllows("OMB_COMPOSIO_BROKER_TOKEN")).toBe(false);
    for (const name of BOX_ENV_NEVER) expect(boxEnvironmentAllows(name), name).toBe(false);
    expect(boxEnvironmentAllows("OMB_CLOUD_ANYTHING")).toBe(false);
    expect(boxEnvironmentAllows("OMB_CLOUDFLARED_PATH")).toBe(false);
    expect(BOX_ENV_NAMES.has("PATH")).toBe(true);
  });

  // The CLI's session token and server address (server/headless/client.ts, scripts/mcp-server.ts): an operator may put
  // them in the server's environment, and nothing that runs in a box reads them. The engines' own OPENMAUSBOT_ keys
  // (OPENMAUSBOT_CODEX_API_KEY, OPENMAUSBOT_CHATGPT_TOKEN) still pass, and a spawn's allowEnv never lifts these two.
  it("keeps the CLI's session token and server address on the server, and the engines' OPENMAUSBOT_ keys in the box", () => {
    const kept = boxEnvironment(
      { OPENMAUSBOT_TOKEN: "omb_sess_x", OPENMAUSBOT_URL: "http://127.0.0.1:8799", OPENMAUSBOT_CODEX_API_KEY: "k", OPENMAUSBOT_CHATGPT_TOKEN: "t" },
      new Set(), new Set(["OPENMAUSBOT_TOKEN", "OPENMAUSBOT_URL"]),
    );
    expect(Object.keys(kept).sort()).toEqual(["OPENMAUSBOT_CHATGPT_TOKEN", "OPENMAUSBOT_CODEX_API_KEY"]);
  });

  it("keeps what Antigravity's runtime is started with: its harness, its file storage switch and the browser hook", () => {
    for (const name of ["ANTIGRAVITY_HARNESS_PATH", "AGY_ACP_FORCE_FILE_STORAGE", "BROWSER", "GEMINI_HOME"]) expect(boxEnvironmentAllows(name), name).toBe(true);
  });

  it("keeps the keys one spawn vouches for, under any name, past the allow-list and the deny, never past the never-list or OMB_", () => {
    const deny = new Set(["OPENCODE_API_KEY", "OMB_COMPOSIO_BROKER_TOKEN"]);
    const allow = new Set(["NANO_GPT_API_KEY", "OPENCODE_API_KEY", "OMB_LICENSE_KEY", "OMB_CLOUD_AI_TOKEN", "OMB_COMPOSIO_BROKER_TOKEN"]);
    const env = { NANO_GPT_API_KEY: "n", OPENCODE_API_KEY: "o", OMB_LICENSE_KEY: "l", OMB_CLOUD_AI_TOKEN: "c", OMB_COMPOSIO_BROKER_TOKEN: "b", DEEPSEEK_API_KEY: "d" };
    expect(boxEnvironment(env, deny, allow)).toEqual({ NANO_GPT_API_KEY: "n", OPENCODE_API_KEY: "o" });
    expect(boxEnvironment(env, deny)).toEqual({});
  });

  it("vouches only for the names the engine instance's own environment set, with its own value", () => {
    expect(instanceEnvNames({ NANO_GPT_API_KEY: "n", OPENCODE_API_KEY: "o", GONE: "g" }, { NANO_GPT_API_KEY: "n", OPENCODE_API_KEY: "server's", PATH: "/usr/bin" }))
      .toEqual(["NANO_GPT_API_KEY"]);
  });

  it("passes only the OMB_ names a boxed process reads; an operator's own settings stay on the server", () => {
    const kept = boxEnvironment({
      OMB_SIGNIN_SMTP_URL: "smtp://user:pass@mail.example.com", OMB_SIGNIN_EMAILS: "a@example.com", OMB_PHONE_SECRET_PUBLIC_KEY: "k",
      OMB_TEST_INTERNAL_CAPABILITY_KEY: "k", OMB_PUBLIC_URL: "https://x", OMB_SOMETHING_NEW: "x", OMB_EXTRA_PATH: "/opt/tools/bin",
      OMB_MCP_TOKEN_BROWSER: "t", OMB_GATE_CONFIG_ab12: "{}", OMB_REMOTE_MCP_CONFIG_cd34: "{}", OMB_HARNESS_URL: "http://127.0.0.1:8799",
    });
    expect(Object.keys(kept).sort()).toEqual(["OMB_EXTRA_PATH", "OMB_GATE_CONFIG_ab12", "OMB_HARNESS_URL", "OMB_MCP_TOKEN_BROWSER", "OMB_REMOTE_MCP_CONFIG_cd34"]);
  });

  it("every OMB_ name the server knows has a decision: passed to a bot's box or kept on the server", () => {
    const passed = (name: string) => BOX_ENV_OMB_NAMES.has(name) || BOX_ENV_OMB_PREFIXES.includes(name);
    const undecided = knownOmbNames().filter((name) => !passed(name) && !SERVER_ONLY_OMB.has(name));
    expect(undecided, "add each to BOX_ENV_OMB_NAMES in env.ts if a bot's engine, hook or MCP proxy reads it, else to SERVER_ONLY_OMB here").toEqual([]);
    expect([...BOX_ENV_OMB_NAMES].filter((name) => SERVER_ONLY_OMB.has(name))).toEqual([]);
    for (const name of SERVER_ONLY_OMB) if (!name.endsWith("_")) expect(boxEnvironmentAllows(name), name).toBe(false);
  });

  it("returns a fresh object, never the caller's", () => {
    const source = { PATH: "/usr/bin" };
    const kept = boxEnvironment(source);
    kept.PATH = "/changed";
    expect(source.PATH).toBe("/usr/bin");
  });
});
