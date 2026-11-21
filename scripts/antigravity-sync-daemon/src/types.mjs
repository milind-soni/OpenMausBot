/***
 * Canonical Types & Constants for Antigravity Sync Daemon
 * Spec: SPEC_CONTRACT.md v1.0.0
 */

export const DAEMON_STATES = Object.freeze([
  "BOOTSTRAPPING",
  "RECONCILING",
  "WATCHING",
  "DEBOUNCING",
  "EVALUATING_POOL",
  "WAITING_QUIESCENT",
  "SYNCING_ATOMIC",
  "VERIFYING",
  "COOLDOWN_BACKOFF",
  "DEGRADED_READONLY",
  "SHUTTING_DOWN"
]);

export const CORE_CODING_MODELS = Object.freeze([
  "gemini-3.8-flash-high",
  "gemini-4-neon-high",
  "claude-sonnet-5-5-high",
  "claude-opus-5-5-high"
]);

export const MANAGED_GATEWAY_MODELS = Object.freeze([
  "gemini-3.8-flash",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "claude-sonnet-5-5-high",
  "claude-opus-5-5-high",
  "gemini-4-neon-high",
  "gemini-4-argon-high"
]);

export const TIMERS = Object.freeze({
  DEBOUNCE_MS: 3000,
  DEBOUNCE_MAX_WAIT_MS: 10000,
  RECONCILE_INTERVAL_MS: 60000,
  QUIESCENT_POLL_MS: 500,
  QUIESCENT_TIMEOUT_MS: 15000,
  SETTLE_WINDOW_MS: 250,
  POST_EXIT_GUARD_WINDOW_MS: 30000,
  MIN_PROMOTION_COOLDOWN_MS: 120000,
  OAUTH_CACHE_TTL_MS: 900000,       // 15 min
  NEGATIVE_COOLDOWN_MS: 600000,     // 10 min
  MAX_BACKOFF_MS: 300000,           // 5 min
  BASE_BACKOFF_MS: 2000
});

export const GATEWAY_CONSTANTS = Object.freeze({
  INSTANCE_ID: "antigravity-local-gateway",
  DISPLAY_NAME: "Antigravity Local Gateway (Backup)",
  DEFAULT_URL: "http://127.0.0.1:8045/v1",
  DEFAULT_PORT: 8045,
  DRIVER: "openai-compat",
  ACCESS: "api",
  REPLY_WAIT_MINUTES: 5
});
