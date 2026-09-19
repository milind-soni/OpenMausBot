// Zod schemas, bounds constants, and the stored/patch types for
// ~/.openmausbot/config.json. The family's base module: accessors, io and
// the fleet modules all depend on it, and it depends only on ./profiles.ts.
import { z } from "zod";
import { normalizeImageGenerationUrl, type ImageGenerationConfig } from "../../shared/image-generation.ts";
import { PROVIDER_ICON_PRESETS, providerIconError } from "../../shared/provider-icon.ts";
import { EFFORT_LEVELS } from "../../shared/wire.ts";
import { isModelVariant, type InstanceConfigMap, type ModelSelection } from "../contracts.ts";
import { schemaIssue, type JsonValue } from "../schema.ts";

import { migrateStoredBrowserProfiles } from "./profiles.ts";

const optionalText = z.string().optional();
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LEGACY_BROWSER_PROFILE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const BROWSER_PROFILE_ID = /^[a-z0-9_-]{1,40}$/;

const CDP_PORT = /^[0-9]{1,5}$/;
const CDP_URL = /^(https?|wss?):\/\/\S+$/i;

/** A bare TCP port (agent-browser's `--cdp <port>` shorthand) or an
 * http(s)/ws(s) URL to a Chrome DevTools Protocol endpoint. */
export function isValidCdpTarget(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  if (CDP_PORT.test(value)) {
    const port = Number(value);
    return port >= 1 && port <= 65535;
  }
  return CDP_URL.test(value);
}


export const DEFAULT_ROOM_TURN_TIMEOUT_MINUTES = 5;
export const MIN_ROOM_TURN_TIMEOUT_MINUTES = 1;
export const MAX_ROOM_TURN_TIMEOUT_MINUTES = 1_440;
export const DEFAULT_ROOM_HANDOFF_LIFETIME_MINUTES = 30;
export const DEFAULT_ROOM_HANDOFF_MIN_RUNWAY_MINUTES = 10;
export const DEFAULT_ROOM_HANDOFF_HARD_CAP_MINUTES = 240;
export const DEFAULT_MAX_CONCURRENT_BOT_THREADS = 3;
export const MAX_CONCURRENT_BOT_THREADS = 10;
/** Bounds for threads.eventLogMaxBytes: the floor keeps the kept tail large
 * enough to still serve the event inspector's recent-line window; the
 * ceiling just rejects absurd hand edits. */
export const MIN_THREAD_EVENT_LOG_BYTES = 256 * 1024;
export const MAX_THREAD_EVENT_LOG_BYTES = 4 * 1024 * 1024 * 1024;
export const DEFAULT_LOCAL_VM_MODE = "shared" as const;
export const DEFAULT_LOCAL_VM_MAX_INSTANCES = 2;
export const MIN_LOCAL_VM_MAX_INSTANCES = 1;
export const MAX_LOCAL_VM_MAX_INSTANCES = 4;

export function isValidSshAlias(value: unknown): value is string {
  return typeof value === "string" && SSH_ALIAS.test(value);
}

const vpsConfigSchema = z.object({
  sshAlias: z.string().refine((value) => value === "" || isValidSshAlias(value), {
    message: "must be a simple SSH config alias",
  }).optional(),
});
/** Attach a bot's browser to a Chrome the operator already has running,
 * instead of agent-browser spawning its own (#1396). Deliberately a
 * server-owned config field, not an env-var passthrough: the ambient
 * process environment must never redirect a bot's browser
 * (server/browser-live.test.ts pins this guarantee down). */
const browserEngineConfigSchema = z.object({
  attachCdpUrl: z.string().trim().max(2048).refine((value) => value === "" || isValidCdpTarget(value), {
    message: "browserEngine.attachCdpUrl must be a CDP port (1-65535) or an http(s)/ws(s) URL",
  }).optional(),
});
const roomConfigSchema = z.object({
  turnTimeoutMinutes: z
    .number()
    .int()
    .min(MIN_ROOM_TURN_TIMEOUT_MINUTES)
    .max(MAX_ROOM_TURN_TIMEOUT_MINUTES),
  /** Room handoff tree lifetime. Active execution pauses this clock; the
   * hard cap is wall-clock and bounds trees that never stop executing. */
  handoffLifetimeMinutes: z.number().int().min(1).max(MAX_ROOM_TURN_TIMEOUT_MINUTES).optional(),
  handoffMinRunwayMinutes: z.number().int().min(1).max(MAX_ROOM_TURN_TIMEOUT_MINUTES).optional(),
  handoffHardCapMinutes: z.number().int().min(1).max(7 * MAX_ROOM_TURN_TIMEOUT_MINUTES).optional(),
}).refine(
  (rooms) =>
    (rooms.handoffMinRunwayMinutes ?? DEFAULT_ROOM_HANDOFF_MIN_RUNWAY_MINUTES) <=
      (rooms.handoffLifetimeMinutes ?? DEFAULT_ROOM_HANDOFF_LIFETIME_MINUTES) &&
    (rooms.handoffLifetimeMinutes ?? DEFAULT_ROOM_HANDOFF_LIFETIME_MINUTES) <=
      (rooms.handoffHardCapMinutes ?? DEFAULT_ROOM_HANDOFF_HARD_CAP_MINUTES),
  { message: "rooms handoff bounds must satisfy handoffMinRunwayMinutes <= handoffLifetimeMinutes <= handoffHardCapMinutes" },
);
const localVmConfigSchema = z.object({
  mode: z.enum(["shared", "per-bot"]).optional(),
  maxInstances: z
    .number()
    .int()
    .min(MIN_LOCAL_VM_MAX_INSTANCES)
    .max(MAX_LOCAL_VM_MAX_INSTANCES)
    .optional(),
});
/** A named, shareable browser session ("Work", "Client A"). The id names a
 * durable Electron partition; user-controlled characters never reach it. */
const browserProfileSchema = z.object({
  // "guest" is the throwaway session's reserved id, never a saved profile
  // Lowercase is part of the storage contract: durable Chromium partition
  // directories would otherwise collide on case-insensitive filesystems.
  id: z.string().regex(BROWSER_PROFILE_ID).refine((id) => id !== "guest", "guest is reserved"),
  name: z.string().trim().min(1).max(40),
}).strict();
// #567 accepted mixed-case and duplicate ids. This schema exists only at the
// persisted-data boundary so an existing config can be read and migrated;
// API patches and save inputs continue to use browserProfileSchema above.
export const legacyBrowserProfileSchema = z.object({
  id: z.string().regex(LEGACY_BROWSER_PROFILE_ID).refine((id) => id !== "guest", "guest is reserved"),
  name: z.string().trim().min(1).max(40),
  /** Exact #567 Electron partition identity. This is persisted only by the
   * migration boundary; config PATCH callers cannot choose or redirect it. */
  partitionId: z.string().regex(LEGACY_BROWSER_PROFILE_ID).refine((id) => id !== "guest", "guest is reserved").optional(),
}).strict();

export const legacyBrowserProfilesSchema = z.array(legacyBrowserProfileSchema).max(20);
export const storedBrowserProfilesSchema = legacyBrowserProfilesSchema.transform(
  (profiles) => migrateStoredBrowserProfiles(profiles).profiles,
);
const browserProfilesSchema = z.array(browserProfileSchema).max(20).superRefine((profiles, ctx) => {
  const seen = new Set<string>();
  profiles.forEach((profile, index) => {
    if (!seen.has(profile.id)) {
      seen.add(profile.id);
      return;
    }
    ctx.addIssue({
      code: "custom",
      path: [index, "id"],
      message: `browser profile id ${profile.id} is duplicated`,
    });
  });
});
// Deliberately non-strict: an unknown flag (such as `skillRecorder`, the
// pre-rename name a stale client may still PATCH) is dropped as a no-op
// instead of failing the whole stored config or the request.
const featureConfigSchema = z.object({
  /** Bots may draft skills (skill_manage, the Verify card's Save as skill,
   * /learn) for your review. On unless explicitly switched off in Settings;
   * every draft still waits for review. */
  skillAuthoring: z.boolean().optional(),
  /** Show each tool run in the transcript. Off unless explicitly enabled. */
  showToolCalls: z.boolean().optional(),
  /** Experimental built-in browser. Off until explicitly enabled; each bot
   * also has its own switch. */
  browser: z.boolean().optional(),
  /** Opt-in computer sharing (a desktop lending folders, a terminal or
   * computer control to a workspace). Off until explicitly enabled; there is
   * no Settings toggle — see sharedComputersEnabled. */
  sharedComputers: z.boolean().optional(),
  /** Claude bots also load the MCP servers and connectors from this
   * machine's own Claude Code setup (Plugins → MCP servers switch). Off by
   * default: each extra tool costs tokens on every model call. */
  claudeUserMcp: z.boolean().optional(),
  /** LLM-generated titles for new bot threads. Off until explicitly
   * enabled; a one-shot that fails or answers junk leaves the first-message
   * snippet in place — see llmThreadTitlesEnabled. */
  llmThreadTitles: z.boolean().optional(),
});
/** First-run progress. Kept in the workspace config rather than a browser so
 * it survives cleared site data and is shared by every paired client. Hint
 * ids are short renderer-chosen slugs; the list is capped so a buggy client
 * cannot grow the file without bound. */
const onboardingConfigSchema = z.object({
  /** ISO timestamp of finishing (or skipping to the end of) the welcome flow. */
  completedAt: z.string().trim().max(40).optional(),
  /** Which welcome flow was completed; a newer flow may re-show itself. */
  version: z.number().int().min(0).max(1000).optional(),
  reelSeen: z.boolean().optional(),
  hintsSeen: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
}).strict();
export const instanceConfigSchema = z.object({
  driver: z.string().min(1),
  displayName: optionalText,
  accentColor: optionalText,
  icon: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("preset"), preset: z.enum(PROVIDER_ICON_PRESETS) }).strict(),
    z.object({ kind: z.literal("custom"), dataUrl: z.string() }).strict()
      .refine((icon) => providerIconError(icon) === null, { message: "Invalid provider icon" }),
  ]).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  config: z.json().optional(),
});
const instanceConfigMapSchema = z.record(z.string(), instanceConfigSchema);
const defaultModelSelectionSchema = z.object({
  instanceId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  effort: z.enum(EFFORT_LEVELS).optional(),
  variant: z.string().refine(isModelVariant, "invalid model variant").optional(),
}).refine((selection) => selection.variant === undefined || selection.effort === undefined,
  "choose either a model variant or an effort level");
export const appConfigSchema = z.object({
  /** Verified by the dedicated domain endpoint, never a generic config patch. */
  customDomain: z.string().optional(),
  /** Who may sign in with an emailed code (server/account-signin.ts):
   * addresses or `@domain` entries; admins get every scope, members chat only. */
  signIn: z.object({ admins: z.array(z.string().max(320)).max(500).optional(), members: z.array(z.string().max(320)).max(5000).optional() }).optional(),
  defaultModelSelection: defaultModelSelectionSchema.optional(),
  /** CLI-only launch preferences. Never enable remote access implicitly. */
  cliStartup: z.object({
    access: z.enum(["local", "tunnel", "tailscale", "public-url"]),
    publicUrl: z.string().url().optional(),
    phone: z.enum(["ios", "android"]).optional(),
  }).optional(),
  xai: z.object({ key: optionalText, url: optionalText }).optional(),
  /** Anthropic API key for Claude Code billed per token, handed only to
   * Claude instances; `url` only for a proxy or a test double. Never a
   * personal-login OAuth token. */
  anthropic: z.object({ key: optionalText, url: optionalText }).optional(),
  /** Monthly spend limit for the whole workspace, against the cost engines
   * report to the usage ledger. Enforced only with the `budgets` entitlement. */
  budgets: z
    .object({
      monthlyUsd: z.number().min(0).max(1_000_000).optional(),
      warnAtPercent: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
  /** The operator's own sell prices per million tokens, keyed by model id,
   * `driver/model`, or `default`. Read only with the `billing` entitlement. */
  billing: z
    .object({
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      prices: z
        .record(
          z.string().min(1).max(160),
          z.object({
            inputPerMillion: z.number().min(0).max(1_000_000),
            outputPerMillion: z.number().min(0).max(1_000_000),
            cachedInputPerMillion: z.number().min(0).max(1_000_000).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  /** `model` seeds the default selection; `provider` pins an OpenRouter
   * upstream (e.g. "fireworks"). Both are non-secret and optional. */
  openaiCompat: z
    .object({ key: optionalText, url: optionalText, model: optionalText, provider: optionalText })
    .optional(),
  /** Project key used for Sessions, catalog and agent tools. userId/sessionId
   * are non-secret local identifiers used to reuse one Composio Session. */
  composio: z.object({ apiKey: optionalText, userId: optionalText, sessionId: optionalText }).optional(),
  box: z.object({ token: optionalText }).optional(),
  vps: vpsConfigSchema.optional(),
  /** Optional OpenCode key; persisted write-only and passed only to its child. */
  opencodeGo: z.object({ apiKey: optionalText }).optional(),
  /** Voice settings and the selected voice id. `provider` picks the
   * engine: "elevenlabs" (default; needs `key`), "fish" (needs its own
   * `fishKey`), "system" (the Mac's built-in voices, no key), or
   * "chatterbox" (a local OpenAI-compatible Chatterbox server; `baseUrl`
   * and `model` are settings, not secrets). Cloud keys stay separate so
   * switching providers never overwrites or misuses the other key. */
  tts: z.object({
    key: optionalText,
    fishKey: optionalText,
    voice: optionalText,
    provider: z.enum(["elevenlabs", "fish", "system", "chatterbox"]).optional(),
    baseUrl: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => !value || /^https?:\/\//i.test(value), "the Chatterbox server address must start with http:// or https://")
      .optional(),
    model: optionalText,
  }).optional(),
  /** Avatar provider credentials stay separate; choosing a router never reuses a cloud key. */
  imageGen: z.object({
    provider: z.enum(["openai", "xai", "custom"]).optional(),
    key: optionalText,
    customApiKey: optionalText,
    customUrl: z.string().trim().max(2048).transform((value, ctx) => {
      if (!value) return "";
      try { return normalizeImageGenerationUrl(value); } catch (error) {
        ctx.addIssue({ code: "custom", message: (error as Error).message });
        return z.NEVER;
      }
    }).optional(),
    customModel: z.string().trim().max(200).refine(
      (value) => !["\r", "\n", "\0"].some((character) => value.includes(character)),
      "Use a model ID without control characters",
    ).optional(),
  }).optional(),
  /** Non-secret profile details shown in the sidebar. */
  profile: z.object({ name: optionalText, email: optionalText }).optional(),
  /** UI language override (BCP-47, lowercase). Empty/absent = follow the
   * system language. Unknown tags degrade to English in the renderer. */
  language: optionalText,
  rooms: roomConfigSchema.optional(),
  threads: z.object({
    maxConcurrentPerBot: z.number().int().min(1).max(MAX_CONCURRENT_BOT_THREADS),
    /** Cap each per-thread events/ and native/ NDJSON log at this many
     * bytes; absent (the default) keeps today's unbounded growth (#1280). */
    eventLogMaxBytes: z.number().int().min(MIN_THREAD_EVENT_LOG_BYTES).max(MAX_THREAD_EVENT_LOG_BYTES).optional(),
    /** Days a closed or archived thread's event logs survive (#1280).
     * Absent keeps them forever. */
    eventLogRetentionDays: z.number().int().min(1).max(3650).optional(),
  }).strict().optional(),
  localVm: localVmConfigSchema.optional(),
  features: featureConfigSchema.optional(),
  onboarding: onboardingConfigSchema.optional(),
  browserProfiles: browserProfilesSchema.optional(),
  /** CDP attach target for a bot's browser; see browserEngineConfigSchema. */
  browserEngine: browserEngineConfigSchema.optional(),
  instances: instanceConfigMapSchema.optional(),
  /** User-configured MCP servers, mounted into every capable engine. Kept
   * loosely typed HERE on purpose: parseStoredConfig throws away the whole
   * file on a schema error, and one bad server entry must degrade to a
   * skipped entry (customMcpServers), never to a vanished config. */
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});
const storedAppConfigSchema = appConfigSchema.extend({
  browserProfiles: storedBrowserProfilesSchema.optional(),
});
const appConfigPatchSchema = appConfigSchema.omit({ instances: true, mcpServers: true, cliStartup: true, customDomain: true });
export const jsonObjectSchema = z.record(z.string(), z.json());

export interface AppConfig {
  customDomain?: string;
  signIn?: { admins?: string[]; members?: string[] };
  /** Preferred selection for newly created bots; existing bots keep theirs. */
  defaultModelSelection?: ModelSelection;
  cliStartup?: {
    access: "local" | "tunnel" | "tailscale" | "public-url";
    publicUrl?: string;
    phone?: "ios" | "android";
  };
  mcpServers?: Record<string, unknown>;
  language?: string;
  xai?: { key?: string; url?: string };
  anthropic?: { key?: string; url?: string };
  budgets?: { monthlyUsd?: number; warnAtPercent?: number };
  billing?: { currency?: string; prices?: Record<string, { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number }> };
  openaiCompat?: { key?: string; url?: string; model?: string; provider?: string };
  composio?: { apiKey?: string; userId?: string; sessionId?: string };
  box?: { token?: string };
  /** A named host from the user's SSH config. Authentication stays with SSH. */
  vps?: { sshAlias?: string };
  opencodeGo?: { apiKey?: string };
  tts?: { key?: string; fishKey?: string; voice?: string; provider?: "elevenlabs" | "fish" | "system" | "chatterbox"; baseUrl?: string; model?: string };
  imageGen?: ImageGenerationConfig;
  profile?: { name?: string; email?: string };
  rooms?: { turnTimeoutMinutes: number; handoffLifetimeMinutes?: number; handoffMinRunwayMinutes?: number; handoffHardCapMinutes?: number };
  threads?: { maxConcurrentPerBot: number; eventLogMaxBytes?: number; eventLogRetentionDays?: number };
  /** Shared preserves the historical singleton. Per-bot gives every bot a
   * separate container, durable workspace, viewer and lease. */
  localVm?: { mode?: "shared" | "per-bot"; maxInstances?: number };
  /** Opt-in product experiments. Every flag defaults to disabled. */
  features?: { skillAuthoring?: boolean; showToolCalls?: boolean; browser?: boolean; sharedComputers?: boolean; claudeUserMcp?: boolean; llmThreadTitles?: boolean };
  /** First-run progress; see onboardingConfigSchema. */
  onboarding?: { completedAt?: string; version?: number; reelSeen?: boolean; hintsSeen?: string[] };
  /** Named browser sessions any bot can be pointed at. */
  browserProfiles?: BrowserProfile[];
  /** CDP target of a Chrome the operator already has running (a bare port,
   * e.g. "9333", or an http(s)/ws(s) URL). When set, a bot's browser
   * attaches to it instead of agent-browser spawning its own (#1396). */
  browserEngine?: { attachCdpUrl?: string };
  instances?: InstanceConfigMap;
}
export type BrowserProfile = z.output<typeof browserProfileSchema> & {
  /** Exact durable Electron partition inherited from #567. Internal and
   * immutable; omit from PATCH/config UI payloads. Absent means `id`. */
  partitionId?: string;
};
export type ConfigPatch = z.output<typeof appConfigPatchSchema>;

export function parseStoredConfig(value: JsonValue): AppConfig {
  const parsed = storedAppConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "Invalid stored configuration"));
  return parsed.data;
}


export function parseConfigPatch(value: JsonValue): ConfigPatch {
  const parsed = appConfigPatchSchema.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error(schemaIssue(parsed.error, "Invalid configuration")), { status: 400 });
  }
  return parsed.data;
}
