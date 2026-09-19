// Derived config reads: the scalar every caller asks the config for (turn
// timeout, thread caps, feature gates) plus the persisted-VPS shape helper.
import {
  DEFAULT_LOCAL_VM_MAX_INSTANCES,
  DEFAULT_LOCAL_VM_MODE,
  DEFAULT_MAX_CONCURRENT_BOT_THREADS,
  DEFAULT_ROOM_HANDOFF_HARD_CAP_MINUTES,
  DEFAULT_ROOM_HANDOFF_LIFETIME_MINUTES,
  DEFAULT_ROOM_HANDOFF_MIN_RUNWAY_MINUTES,
  DEFAULT_ROOM_TURN_TIMEOUT_MINUTES,
  isValidCdpTarget,
  isValidSshAlias,
  type AppConfig,
} from "./schema.ts";

/** Keep the persisted VPS shape deliberately smaller than an SSH connection. */
export function normalizeVpsConfig(raw: unknown): { sshAlias?: string } {
  if (raw === undefined || raw === null) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("vps must be an object containing an SSH config alias");
  }
  const alias = (raw as Record<string, unknown>).sshAlias;
  if (alias === undefined || alias === "") return {};
  if (!isValidSshAlias(alias)) {
    throw new Error("vps.sshAlias must be a simple SSH config alias (letters, numbers, dot, dash, or underscore)");
  }
  return { sshAlias: alias };
}

export function vpsSshAlias(cfg: AppConfig): string | null {
  return isValidSshAlias(cfg.vps?.sshAlias) ? cfg.vps.sshAlias : null;
}

/** Read-and-revalidate accessor, same shape as vpsSshAlias above: even
 * though loadConfig()/parseStoredConfig() already schema-validate this
 * field, callers that forward it into a child process environment get a
 * second, cheap guarantee rather than trusting a hand-edited config.json. */
export function browserEngineAttachCdpUrl(cfg: AppConfig): string | null {
  return isValidCdpTarget(cfg.browserEngine?.attachCdpUrl) ? cfg.browserEngine.attachCdpUrl : null;
}

export interface RoomHandoffLimitsMs {
  lifetimeMs: number;
  minRunwayMs: number;
  hardCapMs: number;
}

/** Room handoff tree budgets in milliseconds. The tree lifetime pauses
 * while a node is actively executing; the hard cap is wall-clock and bounds
 * trees that never stop. Read when the server starts. */
export function roomHandoffLimits(cfg: AppConfig): RoomHandoffLimitsMs {
  return {
    lifetimeMs: (cfg.rooms?.handoffLifetimeMinutes ?? DEFAULT_ROOM_HANDOFF_LIFETIME_MINUTES) * 60_000,
    minRunwayMs: (cfg.rooms?.handoffMinRunwayMinutes ?? DEFAULT_ROOM_HANDOFF_MIN_RUNWAY_MINUTES) * 60_000,
    hardCapMs: (cfg.rooms?.handoffHardCapMinutes ?? DEFAULT_ROOM_HANDOFF_HARD_CAP_MINUTES) * 60_000,
  };
}

/** Opt-in generated titles for new bot threads: a cheap provider one-shot
 * names the row instead of the first-message snippet. Off until enabled by
 * hand in ~/.openmausbot/config.json
 * (`{"features": {"llmThreadTitles": true}}`); a one-shot that fails or
 * answers anything unusable leaves the snippet untouched. */
export function llmThreadTitlesEnabled(cfg: AppConfig): boolean {
  return cfg.features?.llmThreadTitles === true;
}

export function roomTurnTimeoutMinutes(cfg: AppConfig): number {
  return cfg.rooms?.turnTimeoutMinutes ?? DEFAULT_ROOM_TURN_TIMEOUT_MINUTES;
}

export function maxConcurrentBotThreads(cfg: AppConfig): number {
  return cfg.threads?.maxConcurrentPerBot ?? DEFAULT_MAX_CONCURRENT_BOT_THREADS;
}

/** Size cap for each per-thread events/ and native/ NDJSON log. Null (the
 * default) means unbounded growth — rotation is strictly opt-in (#1280). */
export function threadEventLogMaxBytes(cfg: AppConfig): number | null {
  const cap = cfg.threads?.eventLogMaxBytes;
  return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : null;
}

/** Days a closed or archived bot thread's event logs survive before the
 * retention sweep removes them (#1280). Null — the default — keeps them
 * forever. */
export function threadEventLogRetentionDays(cfg: AppConfig): number | null {
  return cfg.threads?.eventLogRetentionDays ?? null;
}

export function localVmMode(cfg: AppConfig): "shared" | "per-bot" {
  return cfg.localVm?.mode ?? DEFAULT_LOCAL_VM_MODE;
}

export function localVmMaxInstances(cfg: AppConfig): number {
  return cfg.localVm?.maxInstances ?? DEFAULT_LOCAL_VM_MAX_INSTANCES;
}

/** On by default; only an explicit `false` (the Settings toggle, or a legacy
 * `skillRecorder: false` carried over at startup) switches it off. */
export function skillAuthoringEnabled(cfg: AppConfig): boolean {
  return cfg.features?.skillAuthoring !== false;
}

export function showToolCallsEnabled(cfg: AppConfig): boolean {
  return cfg.features?.showToolCalls === true;
}

/** Workspace-level gate for the experimental built-in browser. A bot's own
 * switch sits under it, so either can withhold the browser. */
export function builtInBrowserEnabled(cfg: AppConfig): boolean {
  return cfg.features?.browser === true;
}

/** Opt-in computer sharing: the routes, the agent tools, the advertised
 * capability and the desktop connector. Off unless an explicit `true` turns
 * it on, because the reviewed feature still has open security holes (a
 * read-only folder grant could be escalated to a shell).
 *
 * Deliberately NOT a Settings toggle: this is a maintainer-only escape hatch
 * for an unfinished feature, not a user preference. Someone who needs it
 * enables it by hand in `~/.openmausbot/config.json`
 * (`{"features": {"sharedComputers": true}}`) and restarts the server. */
export function sharedComputersEnabled(cfg: AppConfig): boolean {
  return cfg.features?.sharedComputers === true;
}

/** Claude bots also see the MCP servers of this machine's own Claude Code
 * setup — the way Codex bots already read ~/.codex/config.toml. Off unless
 * the person switched it on under Plugins → MCP servers; the Claude driver
 * then omits --strict-mcp-config while keeping skills, hooks and the
 * personal CLAUDE.md out. */
export function claudeUserMcpEnabled(cfg: AppConfig): boolean {
  return cfg.features?.claudeUserMcp === true;
}

/** Config sections no provider driver reads. A write that touches only
 * these must not rebuild the fleet: rebuilding disposes every engine child
 * and reloads it, seconds of work that would also interrupt in-flight
 * turns. The guided tour writes `onboarding` on every step, so it in
 * particular has to stay cheap. */
export const FLEET_NEUTRAL_KEYS: ReadonlySet<string> = new Set([
  "profile",
  "language",
  "tts",
  "imageGen",
  "vps",
  "rooms",
  "threads",
  "localVm",
  "features",
  "browserProfiles",
  "onboarding",
]);

/** The keys of a config patch that require the provider fleet to reload. */
export function providerReloadKeys(patch: object): string[] {
  return Object.keys(patch).filter((key) => !FLEET_NEUTRAL_KEYS.has(key));
}
