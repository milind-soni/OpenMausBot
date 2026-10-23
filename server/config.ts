import type { AppConfig } from "./config-types.ts";
export type { AppConfig } from "./config-types.ts";
   import { readFileSync, mkdirSync, existsSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { normalizeImageGenerationUrl } from "../shared/image-generation.ts";
import { botAvatarUrlSchema } from "../shared/bot-avatar.ts";
import { writeFileAtomic } from "./atomic.ts";
import { anthropicKeyEnv } from "./anthropic-key-env.ts";
import { withoutComputerEngine } from "./computer-engine-removal.ts";
import { newBotDefaultsSchema } from "./new-bot-defaults.ts";
import { replaySettings } from "./replay-settings.ts";
import { EFFORT_LEVELS } from "../shared/wire.ts";
import { isModelVariant, type InstanceConfigMap, type McpServerSpec } from "./contracts.ts";
import { DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES } from "./cache-keepwarm.ts";
import { PROVIDER_ICON_PRESETS, providerIconError } from "../shared/provider-icon.ts";
import { helperStoredShape } from "./side-jobs.ts";
import { loopGuardConfigSchema } from "./host/loop-guard.ts";
import { migrateLegacyFeatureFlags } from "./legacy-feature-flags.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "./mcp-registry.ts";
import { parseJson, schemaIssue, type JsonObject, type JsonValue } from "./schema.ts";
import { deciderConfigSchema } from "./decider/config.ts";
import { browserEngineConfigSchema, isValidCdpTarget } from "./browser/config.ts";
import { roomContextSettings } from "./room-context-settings.ts";
const optionalText = z.string().optional();
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LEGACY_BROWSER_PROFILE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const BROWSER_PROFILE_ID = /^[a-z0-9_-]{1,40}$/;

 export const FISH_TTS_MODELS = ["s2.1-pro", "s2.1-pro-free"] as const;
export type FishTtsModel = (typeof FISH_TTS_MODELS)[number];

export const DEFAULT_ROOM_TURN_TIMEOUT_MINUTES = 5;
export const MIN_ROOM_TURN_TIMEOUT_MINUTES = 1;
export const MAX_ROOM_TURN_TIMEOUT_MINUTES = 1_440;
 export const DEFAULT_MCP_CALL_TIMEOUT_MINUTES = 10;
export const MIN_MCP_CALL_TIMEOUT_MINUTES = 1;
export const MAX_MCP_CALL_TIMEOUT_MINUTES = 60;
export const DEFAULT_MAX_CONCURRENT_BOT_THREADS = 3;
export const MAX_CONCURRENT_BOT_THREADS = 10;
 export const MIN_THREAD_EVENT_LOG_BYTES = 256 * 1024;
export const MAX_THREAD_EVENT_LOG_BYTES = 4 * 1024 * 1024 * 1024;
export const DEFAULT_LOCAL_VM_MODE = "shared" as const;
export const DEFAULT_LOCAL_VM_MAX_INSTANCES = 2;
export const MIN_LOCAL_VM_MAX_INSTANCES = 1;
export const MAX_LOCAL_VM_MAX_INSTANCES = 8;
 export const DEFAULT_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 480;
export const MIN_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 5;
export const MAX_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 1_440;

export function isValidSshAlias(value: unknown): value is string {
  return typeof value === "string" && SSH_ALIAS.test(value);
}

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

const vpsConfigSchema = z.object({
  sshAlias: z.string().refine((value) => value === "" || isValidSshAlias(value), { message: "must be a simple SSH config alias" }).optional(),
});
const roomConfigSchema = z.object({
  turnTimeoutMinutes: z
    .number()
    .int()
    .min(MIN_ROOM_TURN_TIMEOUT_MINUTES)
    .max(MAX_ROOM_TURN_TIMEOUT_MINUTES),
});
const mcpConfigSchema = z.object({
  callTimeoutMinutes: z
    .number()
    .int()
    .min(MIN_MCP_CALL_TIMEOUT_MINUTES)
    .max(MAX_MCP_CALL_TIMEOUT_MINUTES)
    .optional(),
}).strict();
 const localVmConfigSchema = z.object({
  mode: z.enum(["shared", "per-bot", "pool"]).optional(),
  maxInstances: z
    .number()
    .int()
    .min(MIN_LOCAL_VM_MAX_INSTANCES)
    .max(MAX_LOCAL_VM_MAX_INSTANCES)
    .optional(),
  idleTimeoutMinutes: z
    .number()
    .int()
    .min(MIN_LOCAL_VM_IDLE_TIMEOUT_MINUTES)
    .max(MAX_LOCAL_VM_IDLE_TIMEOUT_MINUTES)
    .optional(),
});
 const browserProfileSchema = z.object({
  id: z.string().regex(BROWSER_PROFILE_ID).refine((id) => id !== "guest", "guest is reserved"),
  name: z.string().trim().min(1).max(40),
  browser: z.literal("chrome").optional(),
}).strict();
   const legacyBrowserProfileSchema = z.object({
  id: z.string().regex(LEGACY_BROWSER_PROFILE_ID).refine((id) => id !== "guest", "guest is reserved"),
  name: z.string().trim().min(1).max(40),
  partitionId: z.string().regex(LEGACY_BROWSER_PROFILE_ID).refine((id) => id !== "guest", "guest is reserved").optional(),
  browser: z.literal("chrome").optional(),
}).strict();

interface StoredBrowserProfileMigration {
  profiles: BrowserProfile[];
  aliases: ReadonlyMap<string, string>;
}

function suffixedBrowserProfileId(base: string, unavailable: ReadonlySet<string>): string {
  for (let suffix = 2; ; suffix += 1) {
    const ending = `-${suffix}`;
    const candidate = `${base.slice(0, 40 - ending.length)}${ending}`;
    if (candidate !== "guest" && !unavailable.has(candidate)) return candidate;
  }
}

function migrateStoredBrowserProfiles(
  profiles: Array<z.output<typeof legacyBrowserProfileSchema>>,
): StoredBrowserProfileMigration {
  const requestedPartitions = profiles.map((profile) => profile.partitionId ?? profile.id);
  const rawBases = profiles.map((profile) => profile.id.toLowerCase());

  const canonicalIds: Array<string | undefined> = Array(profiles.length).fill(undefined);
  const used = new Set<string>();
  const baseOwner = new Map<string, number>();
  rawBases.forEach((base, index) => {
    if (base === "guest") return;
    const current = baseOwner.get(base);
    if (current === undefined || (profiles[index]!.id === base && profiles[current]!.id !== base)) {
      baseOwner.set(base, index);
    }
  });
  for (const [base, index] of baseOwner) {
    canonicalIds[index] = base;
    used.add(base);
  }
  const reserved = new Set([
    "guest",
    ...rawBases,
    ...requestedPartitions.map((partitionId) => partitionId.toLowerCase()),
  ]);
  rawBases.forEach((base, index) => {
    if (canonicalIds[index] !== undefined) return;
    const id = suffixedBrowserProfileId(base, new Set([...reserved, ...used]));
    canonicalIds[index] = id;
    used.add(id);
  });

  const partitionWinner = new Map<string, number>();
  requestedPartitions.forEach((partitionId, index) => {
    const folded = partitionId.toLowerCase();
    const current = partitionWinner.get(folded);
    if (current === undefined) {
      partitionWinner.set(folded, index);
      return;
    }
    const score = (candidate: number) => canonicalIds[candidate] === folded ? 1 : 0;
    if (score(index) > score(current)) partitionWinner.set(folded, index);
  });

  let effectivePartitions = requestedPartitions.map((partitionId, index) =>
    partitionWinner.get(partitionId.toLowerCase()) === index ? partitionId : canonicalIds[index]!,
  );

  const conflictingIdOwners = new Set<number>();
  canonicalIds.forEach((id, owner) => {
    effectivePartitions.forEach((partitionId, partitionOwner) => {
      if (partitionOwner !== owner && partitionId.toLowerCase() === id) conflictingIdOwners.add(owner);
    });
  });
  const unavailable = new Set([...reserved, ...used]);
  for (const owner of conflictingIdOwners) {
    const id = suffixedBrowserProfileId(rawBases[owner]!, unavailable);
    canonicalIds[owner] = id;
    unavailable.add(id);
  }
  if (conflictingIdOwners.size > 0) {
    effectivePartitions = requestedPartitions.map((partitionId, index) =>
      partitionWinner.get(partitionId.toLowerCase()) === index ? partitionId : canonicalIds[index]!,
    );
  }

  const aliases = new Map<string, string>();
  const canonical: BrowserProfile[] = profiles.map((profile, index) => {
    const id = canonicalIds[index]!;
    const partitionId = effectivePartitions[index]!;
    const migrated: BrowserProfile = { id, name: profile.name };
    if (profile.browser) migrated.browser = profile.browser;
    if (partitionId !== id) migrated.partitionId = partitionId;
    if (!aliases.has(profile.id)) aliases.set(profile.id, id);
    return migrated;
  });
  return { profiles: canonical, aliases };
}

const legacyBrowserProfilesSchema = z.array(legacyBrowserProfileSchema).max(20);
const storedBrowserProfilesSchema = legacyBrowserProfilesSchema.transform(
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
   const featureConfigSchema = z.object({
  skillAuthoring: z.boolean().optional(),
  skillReview: z.boolean().optional(),
  /** Tool steps in one conversation between automatic reviews. */
  skillReviewSteps: z.number().int().min(3).max(100).optional(),
  /** Show each tool run in the transcript. Off unless explicitly enabled. */
  showToolCalls: z.boolean().optional(),
  /** Built-in browser. On unless false; each bot also has its own switch. */
  browser: z.boolean().optional(),
  sharedComputers: z.boolean().optional(),
  claudeUserMcp: z.boolean().optional(), // Claude bots also load this machine's Claude Code MCP servers. Off unless true: tools cost tokens.
  claudeUserSkills: z.boolean().optional(), // Claude bots also load the skills in ~/.claude/skills, in place. Off unless true.
  /** LLM-generated titles for new threads. Off unless true. */
  llmThreadTitles: z.boolean().optional(),
  autoRecall: z.boolean().optional(),
  skillsLibrary: z.boolean().optional(),
  shareLearnedSkills: z.enum(["off", "ask", "auto"]).optional(),
  /** Memory upkeep also reads a member bot's room turns. Off unless true. */
  roomMemoryCapture: z.boolean().optional(),
  /** Room jobs to several members run side by side, each in a thread of its own. Off unless true. */
  parallelRoomJobs: z.boolean().optional(),
  /** A teammate parked on a gate only the person can lift is reported to its Chief of Staff. Off unless true. */
  chiefEscalations: z.boolean().optional(),
  acpPlanLines: z.boolean().optional(), // An ACP agent's plan as activity lines. Off unless true.
}).extend({ agentsToolBridge: z.boolean().optional() }); // the find_tool / use_tool bridge; off unless true
const onboardingConfigSchema = z.object({
  completedAt: z.string().trim().max(40).optional(),
  version: z.number().int().min(0).max(1000).optional(),
  reelSeen: z.boolean().optional(),
  hintsSeen: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
  firstTurnAt: z.string().trim().max(40).optional(),
}).strict();
const instanceConfigSchema = z.object({
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
  access: z.enum(["subscription", "custom", "api"]).optional(),
  config: z.json().optional(),
});
const instanceConfigMapSchema = z.record(z.string(), instanceConfigSchema);
const defaultModelSelectionSchema = z.object({
  instanceId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(500),
  effort: z.enum(EFFORT_LEVELS).optional(),
  variant: z.string().refine(isModelVariant, "invalid model variant").optional(),
}).refine((selection) => selection.variant === undefined || selection.effort === undefined,
  "choose either a model variant or an effort level");
const automaticRecoverySchema = z.object({
  enabled: z.boolean(),
  backup: defaultModelSelectionSchema.optional(),
}).strict().refine((recovery) => !recovery.enabled || recovery.backup !== undefined,
  { message: "Choose a backup model before enabling automatic recovery", path: ["backup"] });
 const cacheKeepWarmSchema = z.object({
  enabled: z.boolean(),
  windowMinutes: z.number().int().min(15).max(MAX_WINDOW_MINUTES).optional(),
}).strict();
const threadsConfigSchema = z.object({
  maxConcurrentPerBot: z.number().int().min(1).max(MAX_CONCURRENT_BOT_THREADS),
  eventLogMaxBytes: z.number().int().min(MIN_THREAD_EVENT_LOG_BYTES).max(MAX_THREAD_EVENT_LOG_BYTES).optional(),
  eventLogRetentionDays: z.number().int().min(1).max(3650).optional(),
}).strict();
 const newBotsConfigSchema = z.object({
  /** Effort for a new bot whose model selection names none. */
  effort: z.enum(EFFORT_LEVELS).optional(),
}).strict();
 const newBotsPatchSchema = z.object({
  effort: newBotsConfigSchema.shape.effort.nullable(),
}).strict();
 const threadsPatchSchema = threadsConfigSchema.extend({
  maxConcurrentPerBot: threadsConfigSchema.shape.maxConcurrentPerBot.optional(),
  eventLogMaxBytes: threadsConfigSchema.shape.eventLogMaxBytes.nullable(),
  eventLogRetentionDays: threadsConfigSchema.shape.eventLogRetentionDays.nullable(),
});
const appConfigSchema = z.object({
  customDomain: z.string().optional(),
  signIn: z.object({ admins: z.array(z.string().max(320)).max(500).optional(), members: z.array(z.string().max(320)).max(5000).optional() }).optional(),
  defaultModelSelection: defaultModelSelectionSchema.optional(),
  automaticRecovery: automaticRecoverySchema.optional(),
  cacheKeepWarm: cacheKeepWarmSchema.optional(),
  newBotDefaults: newBotDefaultsSchema.optional(),
  newBots: newBotsConfigSchema.optional(),
  cliStartup: z.object({
    access: z.enum(["local", "tunnel", "tailscale", "public-url"]),
    publicUrl: z.string().url().optional(),
    phone: z.enum(["ios", "android"]).optional(),
  }).optional(),
  mistral: z.object({ key: optionalText }).optional(),
  cerebras: z.object({ key: optionalText }).optional(), treg: z.object({ key: optionalText }).optional(),
  groq: z.object({ key: optionalText, url: optionalText }).optional(),
  meta: z.object({ key: optionalText, url: optionalText }).optional(),
  deepseek: z.object({ key: optionalText }).optional(),
  xai: z.object({ key: optionalText, url: optionalText }).optional(),
  anthropic: z.object({ key: optionalText, url: optionalText, everyClaudeBot: z.boolean().optional() }).optional(),
  openai: z.object({ key: optionalText }).optional(),
  /** OpenRouter key, for the `openrouter` instance only. */
  openrouter: z.object({ key: optionalText }).optional(),
  budgets: z
    .object({
      monthlyUsd: z.number().min(0).max(1_000_000).optional(),
      warnAtPercent: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
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
  openaiCompat: z
    .object({ key: optionalText, url: optionalText, model: optionalText, provider: optionalText,
      contextWindows: z.record(z.string().min(1), z.record(z.string().trim().min(1), z.number().int().positive())).optional() })
    .optional(),
  composio: z.object({ apiKey: optionalText, userId: optionalText, sessionId: optionalText }).optional(),
  box: z.object({ token: optionalText }).optional(),
  vps: vpsConfigSchema.optional(),
  opencodeGo: z.object({ apiKey: optionalText, providerKeys: z.record(z.string(), z.string()).optional() }).optional(),
  tts: z.object({
    key: optionalText,
    fishKey: optionalText,
    voice: optionalText,
    provider: z.enum(["elevenlabs", "fish", "system", "chatterbox", "xai"]).optional(),
    baseUrl: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => !value || /^https?:\/\//i.test(value), "the Chatterbox server address must start with http:// or https://")
      .optional(),
    model: optionalText,
    fishModel: z.enum(FISH_TTS_MODELS).optional(),
  }).optional(),
  decider: deciderConfigSchema.optional(),
  /** Live calls: `key` is an OpenAI key for Live calls only; without one they use `openai.key`. `voice` is a GPT-Live voice. */
  live: z.object({
    key: optionalText,
    voice: z.string().trim().max(40).regex(/^[a-z]*$/, "a Live voice is a lowercase built-in voice name").optional(),
    readTypedReplies: z.boolean().optional(),
    idleMinutes: z.number().int().min(1).max(60).optional(),
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
  /** Non-secret profile details; aboutMe is shared with every bot. */
  profile: z.object({ name: optionalText, email: optionalText, aboutMe: z.string().max(24_000).optional(), avatarUrl: z.union([z.literal(""), botAvatarUrlSchema]).optional() }).optional(),
  /** UI language override (BCP-47, lowercase); absent follows the system. */
  language: optionalText,
  rooms: roomConfigSchema.optional(),
  mcp: mcpConfigSchema.optional(),
  context: z.object({
    compactAt: z.number().positive().max(10_000_000).optional(),
    autoCompact: z.boolean().optional(),
  }).extend(roomContextSettings).extend(replaySettings).optional(),
  /** Memory upkeep timing, for bots with Memory upkeep switched on. */
  memory: z.object({
    /** Quiet time after a turn before its facts are captured (ms). */
    captureQuietMs: z.number().int().min(1_000).max(24 * 60 * 60_000).optional(),
    /** Local hour (0-23) after which the nightly tidy-up runs. */
    tidyHour: z.number().int().min(0).max(23).optional(),
  }).strict().optional(),
  threads: threadsConfigSchema.optional(),
  decisions: z.object({ retentionDays: z.number().int().min(1).max(3650).optional() }).strict().optional(),
  loopGuard: loopGuardConfigSchema.optional(),
  safetyFloor: z.object({ enabled: z.boolean().optional() }).strict().optional(), // off by default: safetyFloorEnabled in server/safety-floor-gate.ts
  localVm: localVmConfigSchema.optional(),
  features: featureConfigSchema.optional(),
  onboarding: onboardingConfigSchema.optional(),
  browserEngine: browserEngineConfigSchema.optional(),
  browserProfiles: browserProfilesSchema.optional(),
  instances: instanceConfigMapSchema.optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});
const storedAppConfigSchema = appConfigSchema.extend(helperStoredShape).extend({
  browserProfiles: storedBrowserProfilesSchema.optional(),
  opencodeGo: z.object({
    apiKey: optionalText,
    providerKeys: z.record(z.string(), z.unknown()).catch({})
      .transform((keys) => Object.fromEntries(Object.entries(keys).filter((entry): entry is [string, string] => typeof entry[1] === "string")))
      .optional(),
  }).optional(),
});
const appConfigPatchSchema = appConfigSchema.omit({ instances: true, mcpServers: true, cliStartup: true, customDomain: true })
  .extend({ threads: threadsPatchSchema.optional(), newBots: newBotsPatchSchema.optional() });
const jsonObjectSchema = z.record(z.string(), z.json());

export type BrowserProfile = z.output<typeof browserProfileSchema> & {
  partitionId?: string;
};
export type ConfigPatch = z.output<typeof appConfigPatchSchema>;

 export function browserProfilePartitionId(profile: BrowserProfile): string {
  return profile.partitionId ?? profile.id;
}

 export function browserProfileRoutingConflict(
  profiles: readonly BrowserProfile[],
): string | null {
  const logicalOwner = new Map(profiles.map((profile, index) => [profile.id.toLowerCase(), index]));
  const partitionOwner = new Map<string, number>();
  for (const [index, profile] of profiles.entries()) {
    const partitionId = browserProfilePartitionId(profile);
    const foldedPartition = partitionId.toLowerCase();
    const existingPartitionOwner = partitionOwner.get(foldedPartition);
    if (existingPartitionOwner !== undefined && existingPartitionOwner !== index) {
      return `browser profiles cannot share the durable session “${partitionId}”`;
    }
    partitionOwner.set(foldedPartition, index);
    const otherLogicalOwner = logicalOwner.get(foldedPartition);
    if (otherLogicalOwner !== undefined && otherLogicalOwner !== index) {
      return `browser profile id “${profiles[otherLogicalOwner]!.id}” is already used by another durable session`;
    }
  }
  return null;
}

 export function browserProfileReplacementConflict(
  currentProfiles: readonly BrowserProfile[],
  nextProfiles: readonly BrowserProfile[],
): string | null {
  const routingConflict = browserProfileRoutingConflict(nextProfiles);
  if (routingConflict) return routingConflict;
  const currentIds = new Set(currentProfiles.map((profile) => profile.id));
  const nextIds = new Set(nextProfiles.map((profile) => profile.id));
  const removedPartitions = new Set(
    currentProfiles
      .filter((profile) => !nextIds.has(profile.id))
      .map((profile) => browserProfilePartitionId(profile).toLowerCase()),
  );
  const reused = nextProfiles.find((profile) =>
    !currentIds.has(profile.id)
    && removedPartitions.has(browserProfilePartitionId(profile).toLowerCase()));
  return reused
    ? `browser profile “${reused.name}” cannot reuse a session that is being erased; delete it first, then add the new profile`
    : null;
}

export interface BrowserProfilePartitionTarget {
  profileId: string;
  partitionId: string;
}

export function browserProfilePartitionTarget(
  config: Pick<AppConfig, "browserProfiles">,
  profileId: string,
): BrowserProfilePartitionTarget | null {
  const profile = config.browserProfiles?.find((candidate) => candidate.id === profileId);
  return profile ? { profileId: profile.id, partitionId: browserProfilePartitionId(profile) } : null;
}

export function parseStoredConfig(value: JsonValue): AppConfig {
  const parsed = storedAppConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "Invalid stored configuration"));
  return parsed.data;
}

 export function loadBrowserProfileIdAliases(): ReadonlyMap<string, string> {
  try {
    const document = z.object({ browserProfiles: legacyBrowserProfilesSchema.optional() }).safeParse(
      parseJson(readFileSync(join(DATA_DIR, "config.json"), "utf8")),
    );
    if (!document.success || !document.data.browserProfiles) return new Map();
    return migrateStoredBrowserProfiles(document.data.browserProfiles).aliases;
  } catch {
    return new Map();
  }
}

export function parseConfigPatch(value: JsonValue): ConfigPatch {
  const parsed = appConfigPatchSchema.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error(schemaIssue(parsed.error, "Invalid configuration")), { status: 400 });
  }
  return parsed.data;
}

export function vpsSshAlias(cfg: AppConfig): string | null {
  return isValidSshAlias(cfg.vps?.sshAlias) ? cfg.vps.sshAlias : null;
}

 export function browserEngineAttachCdpUrl(cfg: AppConfig): string | null {
  return isValidCdpTarget(cfg.browserEngine?.attachCdpUrl) ? cfg.browserEngine.attachCdpUrl : null;
}

export function roomTurnTimeoutMinutes(cfg: AppConfig): number {
  return cfg.rooms?.turnTimeoutMinutes ?? DEFAULT_ROOM_TURN_TIMEOUT_MINUTES;
}

export function mcpCallTimeoutMinutes(cfg: AppConfig): number {
  return cfg.mcp?.callTimeoutMinutes ?? DEFAULT_MCP_CALL_TIMEOUT_MINUTES;
}

 export function cacheKeepWarmSettings(cfg: AppConfig): { enabled: boolean; windowMinutes: number } {
  return { enabled: cfg.cacheKeepWarm?.enabled === true, windowMinutes: cfg.cacheKeepWarm?.windowMinutes ?? DEFAULT_WINDOW_MINUTES };
}

export function maxConcurrentBotThreads(cfg: { threads?: { maxConcurrentPerBot?: number } }): number {
  return cfg.threads?.maxConcurrentPerBot ?? DEFAULT_MAX_CONCURRENT_BOT_THREADS;
}

 export function threadEventLogMaxBytes(cfg: AppConfig): number | null {
  const cap = cfg.threads?.eventLogMaxBytes;
  return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : null;
}

 export function threadEventLogRetentionDays(cfg: AppConfig): number | null {
  return cfg.threads?.eventLogRetentionDays ?? null;
}

export function localVmMode(cfg: AppConfig): "shared" | "per-bot" | "pool" {
  return cfg.localVm?.mode ?? DEFAULT_LOCAL_VM_MODE;
}

export function localVmMaxInstances(cfg: AppConfig): number {
  return cfg.localVm?.maxInstances ?? DEFAULT_LOCAL_VM_MAX_INSTANCES;
}

export function localVmIdleTimeoutMinutes(cfg: AppConfig): number {
  return cfg.localVm?.idleTimeoutMinutes ?? DEFAULT_LOCAL_VM_IDLE_TIMEOUT_MINUTES;
}

 export function skillAuthoringEnabled(cfg: AppConfig): boolean {
  return cfg.features?.skillAuthoring !== false;
}

export const DEFAULT_SKILL_REVIEW_STEPS = 10;
export const MIN_SKILL_REVIEW_STEPS = 3;
export const MAX_SKILL_REVIEW_STEPS = 100;

 export function skillReviewEnabled(cfg: AppConfig): boolean {
  return skillAuthoringEnabled(cfg) && cfg.features?.skillReview === true;
}

 export function skillReviewSteps(cfg: AppConfig): number {
  const raw = cfg.features?.skillReviewSteps;
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_SKILL_REVIEW_STEPS;
  return Math.min(MAX_SKILL_REVIEW_STEPS, Math.max(MIN_SKILL_REVIEW_STEPS, value));
}

 export function autoRecallEnabled(cfg: AppConfig): boolean {
  return cfg.features?.autoRecall !== false;
}

 export function roomMemoryCaptureEnabled(cfg: AppConfig): boolean {
  return cfg.features?.roomMemoryCapture === true;
}

export const DEFAULT_CAPTURE_QUIET_MS = 2 * 60_000;
export const DEFAULT_TIDY_HOUR = 3;

export function captureQuietMs(cfg: AppConfig): number {
  return cfg.memory?.captureQuietMs ?? DEFAULT_CAPTURE_QUIET_MS;
}

export function tidyHour(cfg: AppConfig): number {
  return cfg.memory?.tidyHour ?? DEFAULT_TIDY_HOUR;
}

export function showToolCallsEnabled(cfg: AppConfig): boolean {
  return cfg.features?.showToolCalls === true;
}

export function builtInBrowserEnabled(cfg: AppConfig, _env: NodeJS.ProcessEnv = process.env): boolean {
  return cfg.features?.browser !== false;
}

 export function sharedComputersEnabled(cfg: AppConfig): boolean {
  return cfg.features?.sharedComputers === true;
}

export function claudeUserMcpEnabled(cfg: Pick<AppConfig, "features">): boolean {
  return cfg.features?.claudeUserMcp === true;
}

 export function llmThreadTitlesEnabled(cfg: AppConfig): boolean {
  return cfg.features?.llmThreadTitles === true;
}


export function engineLaunches(configs: InstanceConfigMap, env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  return Object.fromEntries(Object.entries(configs).map(([id, entry]) =>
    [id, { ...entry, fallbackEnv: Object.fromEntries(fallbackEnv(entry).map((name) => [name, env[name]])) }]));
}

 function fallbackEnv(entry: InstanceConfigMap[string]): string[] {
  const config = typeof entry.config === "object" && entry.config !== null && !Array.isArray(entry.config)
    ? entry.config as { apiKeyEnv?: unknown } : {};
  const named = typeof config.apiKeyEnv === "string" && config.apiKeyEnv ? config.apiKeyEnv : undefined;
  switch (entry.driver) {
    case "mistral": return ["MISTRAL_API_KEY"];
    case "cerebras": return ["CEREBRAS_API_KEY"];
    case "grok": return [named ?? "XAI_API_KEY"];
    case "openai-compat":
      return named && Object.values(API_KEY_FLEET).some((own) => (own.config as { apiKeyEnv?: string } | undefined)?.apiKeyEnv === named)
        ? [named]
        : [...new Set([named ?? "OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_URL", "OPENAI_COMPAT_MODEL", "OPENAI_COMPAT_PROVIDER"])];
    default: return [];
  }
}

 export function changedInstanceIds(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((id) => !isDeepStrictEqual(before[id], after[id]));
}

 export const DATA_DIR = process.env.OMB_DATA_DIR ?? join(homedir(), ".openmausbot");
const LEGACY_DATA_DIR = join(homedir(), ".opengrokbot");
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");

export function ensureDirs() {
  if (!existsSync(DATA_DIR) && existsSync(LEGACY_DATA_DIR)) {
    try {
      renameSync(LEGACY_DATA_DIR, DATA_DIR);
    } catch {
      /* cross-device or busy — fall through to a fresh dir */
    }
  }
  for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR]) mkdirSync(dir, { recursive: true });
  migrateLegacyFeatureFlags(DATA_DIR);
}

 let lastIgnoredConfigWarning = "";

export function loadConfig(): AppConfig {
  let cfg: AppConfig = {};
  try {
    cfg = parseStoredConfig(parseJson(readFileSync(join(DATA_DIR, "config.json"), "utf8")));
    lastIgnoredConfigWarning = "";
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      const reason = error instanceof SyntaxError ? "invalid JSON"
        : error instanceof Error ? error.message : "unable to read configuration";
      const warning = `config: ignoring ${join(DATA_DIR, "config.json")} and using defaults: ${reason}`;
      if (warning !== lastIgnoredConfigWarning) console.warn(warning);
      lastIgnoredConfigWarning = warning;
    } else {
      lastIgnoredConfigWarning = "";
    }
  }
  cfg.mistral = { ...cfg.mistral };
  if (process.env.MISTRAL_API_KEY !== undefined) cfg.mistral.key = process.env.MISTRAL_API_KEY;
  cfg.cerebras = { ...cfg.cerebras };
  if (process.env.CEREBRAS_API_KEY !== undefined) cfg.cerebras.key = process.env.CEREBRAS_API_KEY;
  if (process.env.OMB_TREG_KEY !== undefined) cfg.treg = { ...cfg.treg, key: process.env.OMB_TREG_KEY };
  cfg.groq = { ...cfg.groq };
  if (process.env.OMB_GROQ_API_KEY !== undefined) cfg.groq.key = process.env.OMB_GROQ_API_KEY;
  cfg.meta = { ...cfg.meta };
  if (process.env.OMB_META_API_KEY !== undefined) cfg.meta.key = process.env.OMB_META_API_KEY;
  cfg.deepseek = { ...cfg.deepseek };
  if (process.env.OMB_DEEPSEEK_API_KEY !== undefined) cfg.deepseek.key = process.env.OMB_DEEPSEEK_API_KEY;
  cfg.xai = { ...cfg.xai };
  if (process.env.XAI_API_KEY !== undefined) cfg.xai.key = process.env.XAI_API_KEY;
  cfg.anthropic = { ...cfg.anthropic };
  if (process.env.OMB_ANTHROPIC_API_KEY !== undefined) cfg.anthropic.key = process.env.OMB_ANTHROPIC_API_KEY;
  if (process.env.OMB_ANTHROPIC_API_URL !== undefined) cfg.anthropic.url = process.env.OMB_ANTHROPIC_API_URL;
  cfg.openai = { ...cfg.openai };
  if (process.env.OMB_OPENAI_API_KEY !== undefined) cfg.openai.key = process.env.OMB_OPENAI_API_KEY;
  cfg.openrouter = { ...cfg.openrouter };
  if (process.env.OMB_OPENROUTER_API_KEY !== undefined) cfg.openrouter.key = process.env.OMB_OPENROUTER_API_KEY;
  cfg.openaiCompat = { ...cfg.openaiCompat };
  if (process.env.OPENAI_COMPAT_API_KEY !== undefined) cfg.openaiCompat.key = process.env.OPENAI_COMPAT_API_KEY;
  if (process.env.OPENAI_COMPAT_URL !== undefined) cfg.openaiCompat.url = process.env.OPENAI_COMPAT_URL;
  if (process.env.OPENAI_COMPAT_MODEL !== undefined) cfg.openaiCompat.model = process.env.OPENAI_COMPAT_MODEL;
  if (process.env.OPENAI_COMPAT_PROVIDER !== undefined) cfg.openaiCompat.provider = process.env.OPENAI_COMPAT_PROVIDER;
  cfg.composio = { ...cfg.composio };
  if (process.env.COMPOSIO_API_KEY !== undefined) cfg.composio.apiKey = process.env.COMPOSIO_API_KEY;
  cfg.box = { ...cfg.box };
  if (process.env.BOX_TOKEN !== undefined) cfg.box.token = process.env.BOX_TOKEN;
  cfg.opencodeGo = { ...cfg.opencodeGo };
  if (process.env.OPENCODE_API_KEY !== undefined) cfg.opencodeGo.apiKey = process.env.OPENCODE_API_KEY;
  cfg.tts = { ...cfg.tts };
  if (process.env.OMB_TTS_KEY !== undefined) cfg.tts.key = process.env.OMB_TTS_KEY;
  const presetVoice = process.env.OMB_TTS_DEFAULT_VOICE?.trim();
  if (presetVoice && !cfg.tts.voice?.trim() && (cfg.tts.provider ?? "elevenlabs") === "elevenlabs") cfg.tts.voice = presetVoice;
  if (process.env.OMB_FISH_AUDIO_API_KEY !== undefined) cfg.tts.fishKey = process.env.OMB_FISH_AUDIO_API_KEY;
  cfg.decider = { ...cfg.decider };
  if (process.env.OMB_JEV_API_KEY !== undefined) cfg.decider.key = process.env.OMB_JEV_API_KEY;
  if (process.env.OMB_OPENROUTER_DECIDER_KEY !== undefined) cfg.decider.openrouterKey = process.env.OMB_OPENROUTER_DECIDER_KEY;
  cfg.live = { ...cfg.live };
  if (process.env.OMB_OPENAI_LIVE_KEY !== undefined) cfg.live.key = process.env.OMB_OPENAI_LIVE_KEY;
  cfg.imageGen = { ...cfg.imageGen };
  if (process.env.OMB_OPENAI_IMAGE_KEY !== undefined) cfg.imageGen.key = process.env.OMB_OPENAI_IMAGE_KEY;
  if (process.env.OMB_CUSTOM_IMAGE_KEY !== undefined) cfg.imageGen.customApiKey = process.env.OMB_CUSTOM_IMAGE_KEY;
  const splitEmails = (value: string) => value.split(/[,\s]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (process.env.OMB_SIGNIN_EMAILS !== undefined || process.env.OMB_SIGNIN_MEMBER_EMAILS !== undefined) {
    cfg.signIn = { ...cfg.signIn };
    if (process.env.OMB_SIGNIN_EMAILS !== undefined) cfg.signIn.admins = splitEmails(process.env.OMB_SIGNIN_EMAILS);
    if (process.env.OMB_SIGNIN_MEMBER_EMAILS !== undefined) cfg.signIn.members = splitEmails(process.env.OMB_SIGNIN_MEMBER_EMAILS);
  }
  return cfg;
}

 export function cacheUntilConfigChanges<T>(derive: (config: AppConfig) => T): () => T {
  let cached: { stamp: string; value: T } | null = null;
  return () => {
    let stamp: string | null = null;
    try {
      const file = statSync(join(DATA_DIR, "config.json"), { bigint: true });
      if (Date.now() - Number(file.mtimeMs) >= 2_000) stamp = `${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
    } catch {
      // Missing or out of reach: read it the way loadConfig() always has.
    }
    if (stamp !== null && cached?.stamp === stamp) return cached.value;
    const value = derive(loadConfig());
    cached = stamp === null || lastIgnoredConfigWarning !== "" ? null : { stamp, value };
    return value;
  };
}

 export function syncCredentialEnv(patch: Partial<Omit<AppConfig, "threads" | "newBots">>): void {
  const secrets: Array<[value: string | undefined, name: string]> = [
    [patch.xai?.key, "XAI_API_KEY"],
    [patch.mistral?.key, "MISTRAL_API_KEY"],
    [patch.cerebras?.key, "CEREBRAS_API_KEY"], [patch.treg?.key, "OMB_TREG_KEY"],
    [patch.groq?.key, "OMB_GROQ_API_KEY"],
    [patch.meta?.key, "OMB_META_API_KEY"],
    [patch.deepseek?.key, "OMB_DEEPSEEK_API_KEY"],
    [patch.anthropic?.key, "OMB_ANTHROPIC_API_KEY"],
    [patch.openaiCompat?.key, "OPENAI_COMPAT_API_KEY"],
    [patch.openai?.key, "OMB_OPENAI_API_KEY"],
    [patch.openrouter?.key, "OMB_OPENROUTER_API_KEY"],
    [patch.composio?.apiKey, "COMPOSIO_API_KEY"],
    [patch.box?.token, "BOX_TOKEN"],
    [patch.opencodeGo?.apiKey, "OPENCODE_API_KEY"],
    [patch.tts?.key, "OMB_TTS_KEY"],
    [patch.tts?.fishKey, "OMB_FISH_AUDIO_API_KEY"],
    [patch.decider?.key, "OMB_JEV_API_KEY"],
    [patch.decider?.openrouterKey, "OMB_OPENROUTER_DECIDER_KEY"],
    [patch.imageGen?.key, "OMB_OPENAI_IMAGE_KEY"],
    [patch.imageGen?.customApiKey, "OMB_CUSTOM_IMAGE_KEY"],
    [patch.live?.key, "OMB_OPENAI_LIVE_KEY"],
  ];
  for (const [value, name] of secrets) {
    if (value === undefined) continue;
    if (value) process.env[name] = value;
    else delete process.env[name];
  }
  const settings: Array<[value: string | undefined, name: string]> = [
    [patch.openaiCompat?.url, "OPENAI_COMPAT_URL"],
    [patch.anthropic?.url, "OMB_ANTHROPIC_API_URL"],
    [patch.openaiCompat?.model, "OPENAI_COMPAT_MODEL"],
    [patch.openaiCompat?.provider, "OPENAI_COMPAT_PROVIDER"],
  ];
  for (const [value, name] of settings) {
    if (value === undefined) continue;
    if (value) process.env[name] = value;
    else delete process.env[name];
  }
}

import { WORKSPACE_CREDENTIAL_ENV, CONTROL_PLANE_ENV, CONTROL_PLANE_ENV_PREFIX, stripControlPlaneEnv, stripWorkspaceCredentialEnv, PROVIDER_CREDENTIAL_ENV, OPENCODE_PROVIDER_ENV } from "./credential-env.ts";
export { WORKSPACE_CREDENTIAL_ENV, CONTROL_PLANE_ENV, CONTROL_PLANE_ENV_PREFIX, stripControlPlaneEnv, stripWorkspaceCredentialEnv, PROVIDER_CREDENTIAL_ENV, OPENCODE_PROVIDER_ENV };

 export const OPENCODE_PROVIDER_KEY_LIMIT = 20;
const OPENCODE_PROVIDER_KEY_NAME = /^[A-Z][A-Z0-9_]{0,59}_(?:API_KEY|KEY|TOKEN)$/;
 const OPENCODE_PROVIDER_KEY_VALUE = /^[\x21-\x7e]{1,4096}$/;

 function openCodeProviderKeyNameRefusal(name: string): string | undefined {
  if (!OPENCODE_PROVIDER_KEY_NAME.test(name)) {
    return "Use the name the provider reads its key from: capitals, ending in _API_KEY, _KEY or _TOKEN, such as VENICE_API_KEY.";
  }
  if (name === "OPENCODE_API_KEY") return "Save the OpenCode key in the OpenCode API key box instead.";
  const reserved = name.startsWith("OPENCODE_") || name.startsWith("OMB_")
    || (WORKSPACE_CREDENTIAL_ENV as readonly string[]).includes(name)
    || ((PROVIDER_CREDENTIAL_ENV as readonly string[]).includes(name) && !(OPENCODE_PROVIDER_ENV as readonly string[]).includes(name));
  return reserved ? `OpenMaus keeps ${name} for itself, so OpenCode can't be given it here. Put this key in opencode.json instead.` : undefined;
}

 export function openCodeProviderKeys(cfg: Pick<AppConfig, "opencodeGo">): Record<string, string> {
  const saved = cfg.opencodeGo?.providerKeys ?? {};
  const usable = Object.keys(saved).sort()
    .filter((name) => !openCodeProviderKeyNameRefusal(name) && OPENCODE_PROVIDER_KEY_VALUE.test(saved[name] ?? ""))
    .slice(0, OPENCODE_PROVIDER_KEY_LIMIT);
  return Object.fromEntries(usable.map((name) => [name, saved[name]!]));
}

 export function mergeOpenCodeProviderKeys(
  cfg: Pick<AppConfig, "opencodeGo">,
  change: Record<string, string>,
): { ok: true; keys: Record<string, string> } | { ok: false; error: string } {
  const keys = new Map(Object.entries(openCodeProviderKeys(cfg)));
  for (const [name, raw] of Object.entries(change)) {
    const value = raw.trim();
    if (!value) {
      keys.delete(name);
      continue;
    }
    const refusal = openCodeProviderKeyNameRefusal(name);
    if (refusal) return { ok: false, error: refusal };
    if (!OPENCODE_PROVIDER_KEY_VALUE.test(value)) return { ok: false, error: "That doesn't look like a key. Paste only the key, with no spaces." };
    keys.set(name, value);
  }
  if (keys.size > OPENCODE_PROVIDER_KEY_LIMIT) {
    return { ok: false, error: `OpenCode can hold up to ${OPENCODE_PROVIDER_KEY_LIMIT} provider keys. Remove one you no longer use, then add this one.` };
  }
  return { ok: true, keys: Object.fromEntries([...keys].sort(([a], [b]) => (a < b ? -1 : 1))) };
}

const configSaveListeners = new Set<(before: JsonObject, after: JsonObject) => void>();

 export function onConfigSaved(listener: (before: JsonObject, after: JsonObject) => void): () => void {
  configSaveListeners.add(listener);
  return () => { configSaveListeners.delete(listener); };
}

 export function saveConfig(
  patch: Partial<Omit<AppConfig, "threads" | "newBots">> & {
    threads?: z.output<typeof threadsPatchSchema>;
    newBots?: z.output<typeof newBotsPatchSchema>;
  },
  options: { replaceInstances?: boolean } = {},
): void {
  const p = join(DATA_DIR, "config.json");
  let disk: JsonObject = {};
  try {
    const parsed = jsonObjectSchema.safeParse(parseJson(readFileSync(p, "utf8")));
    if (parsed.success) disk = parsed.data;
  } catch {
    /* first write */
  }
  const checkedPatch = appConfigSchema.partial().extend({ threads: threadsPatchSchema.optional(), newBots: newBotsPatchSchema.optional() }).parse(patch);
  const before = configSaveListeners.size ? structuredClone(disk) : disk;
  const storedProfiles = storedBrowserProfilesSchema.safeParse(disk.browserProfiles);
  if (storedProfiles.success) disk.browserProfiles = storedProfiles.data;
  for (const key of ["xai", "anthropic", "mistral", "cerebras", "treg", "groq", "meta", "deepseek", "openai", "openrouter", "openaiCompat", "composio", "box", "opencodeGo", "tts", "decider", "imageGen", "live", "profile", "rooms", "mcp", "threads", "context", "memory", "localVm", "features", "budgets", "billing", "decisions", "loopGuard", "onboarding", "browserEngine", "newBots", "safetyFloor"] as const) {
    const section = checkedPatch[key];
    if (!section) continue;
    const current = jsonObjectSchema.safeParse(disk[key]);
    const merged: JsonObject = current.success ? { ...current.data } : {};
    if (key === "threads" && !current.success) merged.maxConcurrentPerBot = DEFAULT_MAX_CONCURRENT_BOT_THREADS;
    Object.assign(merged, section);
    for (const [sectionKey, sectionValue] of Object.entries(section as Record<string, unknown>)) {
      if (sectionValue === null) delete merged[sectionKey];
    }
    disk[key] = merged;
  }
  if (checkedPatch.vps !== undefined) disk.vps = normalizeVpsConfig(checkedPatch.vps);
  if (checkedPatch.language !== undefined) disk.language = checkedPatch.language;
  if (checkedPatch.customDomain !== undefined) disk.customDomain = checkedPatch.customDomain;
  if (checkedPatch.signIn !== undefined) disk.signIn = checkedPatch.signIn;
  // Replace the section so clearing a backup cannot revive the old selection.
  if (checkedPatch.automaticRecovery !== undefined) disk.automaticRecovery = checkedPatch.automaticRecovery;
  if (checkedPatch.cacheKeepWarm !== undefined) disk.cacheKeepWarm = checkedPatch.cacheKeepWarm;
  if (checkedPatch.defaultModelSelection !== undefined) {
    disk.defaultModelSelection = checkedPatch.defaultModelSelection;
    if (disk.newBotDefaults) {
      const previousDefaults = newBotDefaultsSchema.parse(disk.newBotDefaults);
      disk.newBotDefaults = newBotDefaultsSchema.parse({
        ...previousDefaults,
        profile: { ...previousDefaults.profile, modelSelection: checkedPatch.defaultModelSelection },
      });
    }
  }
  if (checkedPatch.newBotDefaults !== undefined) {
    disk.newBotDefaults = checkedPatch.newBotDefaults;
    if (checkedPatch.newBotDefaults.profile.modelSelection) {
      disk.defaultModelSelection = checkedPatch.newBotDefaults.profile.modelSelection;
    } else {
      delete disk.defaultModelSelection;
    }
  }
  if (checkedPatch.cliStartup !== undefined) disk.cliStartup = checkedPatch.cliStartup;
  if (checkedPatch.mcpServers !== undefined) {
    disk.mcpServers = jsonObjectSchema.parse(checkedPatch.mcpServers);
  }
  if (checkedPatch.browserProfiles !== undefined) {
    const existingProfiles = new Map(
      (storedProfiles.success ? storedProfiles.data : []).map((profile) => [profile.id, profile]),
    );
    const nextProfiles: BrowserProfile[] = checkedPatch.browserProfiles.map((profile) => {
      const partitionId = existingProfiles.get(profile.id)?.partitionId;
      return partitionId ? { ...profile, partitionId } : profile;
    });
    const routingConflict = browserProfileReplacementConflict(
      storedProfiles.success ? storedProfiles.data : [],
      nextProfiles,
    );
    if (routingConflict) throw Object.assign(new Error(routingConflict), { status: 409 });
    disk.browserProfiles = nextProfiles;
    if (disk.newBotDefaults) {
      const defaults = newBotDefaultsSchema.parse(disk.newBotDefaults);
      const profileId = defaults.profile.browserProfile;
      if (profileId && profileId !== "guest" && !nextProfiles.some(profile => profile.id === profileId)) {
        delete defaults.profile.browserProfile;
        disk.newBotDefaults = defaults;
      }
    }
  }
  if (checkedPatch.instances) {
    const currentInstances = jsonObjectSchema.safeParse(disk.instances);
    const storedInstances: JsonObject = currentInstances.success ? currentInstances.data : {};
    const diskInstances: JsonObject = options.replaceInstances ? {} : storedInstances;
    for (const [instanceId, entry] of Object.entries(checkedPatch.instances)) {
      const current = jsonObjectSchema.safeParse(storedInstances[instanceId]);
      const merged: JsonObject = current.success ? { ...current.data } : {};
      if (options.replaceInstances) {
        for (const key of Object.keys(instanceConfigSchema.shape)) delete merged[key];
      }
      Object.assign(merged, entry);
      diskInstances[instanceId] = merged;
    }
    disk.instances = diskInstances;
  }
  if (checkedPatch.openaiCompat?.url !== undefined && checkedPatch.instances?.openaiCompat === undefined) {
    const instances = jsonObjectSchema.safeParse(disk.instances);
    const entry = jsonObjectSchema.safeParse(instances.success ? instances.data.openaiCompat : undefined);
    const config = jsonObjectSchema.safeParse(entry.success ? entry.data.config : undefined);
    const environment = jsonObjectSchema.safeParse(entry.success ? entry.data.environment : undefined);
    if (entry.success && entry.data.driver === "openai-compat" && config.success
      && !config.data.key
      && (!config.data.apiKeyEnv || config.data.apiKeyEnv === "OPENAI_COMPAT_API_KEY")
      && !(environment.success && Object.hasOwn(environment.data, "OPENAI_COMPAT_API_KEY"))) {
      const nextConfig = { ...config.data };
      delete nextConfig.url;
      (disk.instances as JsonObject).openaiCompat = { ...entry.data, config: nextConfig };
    }
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(p, JSON.stringify(disk, null, 2), { mode: 0o600 });
  for (const listener of configSaveListeners) {
    try {
      listener(before, disk);
    } catch (error) {
      console.warn(`config: a save listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

 export function withInstanceCli(
  cfg: AppConfig,
  instanceId: string,
  cli: string,
): InstanceCliUpdate {
  const next: AppConfig = structuredClone(cfg);
  const map = persistableInstanceConfigs(next);
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

 const CLAUDE_ROUTING_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

 export function claudeInstanceOwnsRouting(environment: Record<string, string> | undefined): boolean {
  return CLAUDE_ROUTING_ENV.some((key) => typeof environment?.[key] === "string" && environment[key] !== "");
}

const sameUrl = (a: string, b: string) => a.trim().replace(/\/+$/u, "") === b.trim().replace(/\/+$/u, "");

 export function instanceOwnsRouting(
  cfg: AppConfig,
  entry: { driver: string; config?: unknown; environment?: Record<string, string> },
  routingDefaults?: { url?: string; apiKeyEnv?: string },
): boolean {
  const config = typeof entry.config === "object" && entry.config !== null && !Array.isArray(entry.config)
    ? entry.config as Record<string, unknown>
    : {};
  const own = (value: unknown) => typeof value === "string" && value.trim() !== "";
  const ownUrl = (...workspace: Array<string | undefined>) => own(config.url)
    && !workspace.some((url) => url !== undefined && sameUrl(config.url as string, url));
  const compatKeyEnv = routingDefaults?.apiKeyEnv ?? "OPENAI_COMPAT_API_KEY";
  switch (entry.driver) {
    case "claudeAgent":
      return claudeInstanceOwnsRouting(entry.environment);
    case "openai-compat":
      return own(config.key) || own(entry.environment?.OPENAI_COMPAT_API_KEY)
        || own(entry.environment?.[compatKeyEnv])
        || (own(config.apiKeyEnv) && config.apiKeyEnv !== compatKeyEnv)
        || ownUrl(routingDefaults?.url || cfg.openaiCompat?.url || process.env.OPENAI_COMPAT_URL || "https://openrouter.ai/api/v1");
    case "mistral":
      return own(entry.environment?.MISTRAL_API_KEY) || ownUrl("https://api.mistral.ai/v1");
    case "cerebras":
      return own(entry.environment?.CEREBRAS_API_KEY) || ownUrl("https://api.cerebras.ai/v1");
    case "groq":
      return own(entry.environment?.GROQ_API_KEY) || ownUrl("https://api.groq.com/openai/v1", cfg.groq?.url);
    case "meta":
      return own(entry.environment?.META_API_KEY) || ownUrl("https://api.meta.ai/v1", cfg.meta?.url);
    case "deepseekAgent":
      // A second DeepSeek Harness account brings its own key; the workspace key fills only an instance without one.
      return own(entry.environment?.DEEPSEEK_API_KEY);
    case "grok":
      return own(entry.environment?.XAI_API_KEY) || (own(config.apiKeyEnv) && config.apiKeyEnv !== "XAI_API_KEY")
        || ownUrl("https://api.x.ai/v1", cfg.xai?.url);
    default:
      return false;
  }
}

 function injectedEnvironment(cfg: AppConfig, instanceId: string, driver: string): Map<string, string> {
  const environment = new Map<string, string>();
  if (driver === "mistral" && cfg.mistral?.key) environment.set("MISTRAL_API_KEY", cfg.mistral.key);
  if (driver === "cerebras" && cfg.cerebras?.key) environment.set("CEREBRAS_API_KEY", cfg.cerebras.key);
  if (driver === "groq" && cfg.groq?.key) environment.set("GROQ_API_KEY", cfg.groq.key);
  if (driver === "meta" && cfg.meta?.key) environment.set("META_API_KEY", cfg.meta.key);
  if (driver === "deepseekAgent" && cfg.deepseek?.key) environment.set("DEEPSEEK_API_KEY", cfg.deepseek.key);
  if (driver === "grok" && cfg.xai?.key) environment.set("XAI_API_KEY", cfg.xai.key);
  if (driver === "claudeAgent") for (const [name, value] of Object.entries(anthropicKeyEnv(cfg.anthropic, instanceId === CLAUDE_API_INSTANCE))) environment.set(name, value);
  if (driver === "openai-compat" && instanceId === OPENAI_API_INSTANCE) {
    if (cfg.openai?.key) environment.set("OMB_OPENAI_API_KEY", cfg.openai.key);
  } else if (driver === "openai-compat" && instanceId === OPENROUTER_API_INSTANCE) {
    if (cfg.openrouter?.key) environment.set("OMB_OPENROUTER_API_KEY", cfg.openrouter.key);
  } else {
    if (driver === "openai-compat" && cfg.openaiCompat?.key)
      environment.set("OPENAI_COMPAT_API_KEY", cfg.openaiCompat.key);
    if (driver === "openai-compat" && cfg.openaiCompat?.url)
      environment.set("OPENAI_COMPAT_URL", cfg.openaiCompat.url);
  }
  if (driver === "opencodeGo") {
    for (const [name, key] of Object.entries(openCodeProviderKeys(cfg))) environment.set(name, key);
    if (cfg.opencodeGo?.apiKey) environment.set("OPENCODE_API_KEY", cfg.opencodeGo.apiKey);
  }
  return environment;
}

 export const OPENAI_API_INSTANCE = "openai";
export const OPENROUTER_API_INSTANCE = "openrouter";
export const XAI_API_INSTANCE = "xaiApi";
export const CLAUDE_API_INSTANCE = "claudeApi";
const API_KEY_FLEET: InstanceConfigMap = {
  [OPENAI_API_INSTANCE]: {
    driver: "openai-compat", displayName: "OpenAI", access: "api", icon: { kind: "preset", preset: "openai" },
    config: { url: "https://api.openai.com/v1", apiKeyEnv: "OMB_OPENAI_API_KEY", catalog: "openai" },
  },
  [CLAUDE_API_INSTANCE]: {
    driver: "claudeAgent", displayName: "Claude (API key)", access: "api", icon: { kind: "preset", preset: "anthropic" },
    config: { requireApiKey: true },
  },
  [XAI_API_INSTANCE]: { driver: "grok", displayName: "xAI", access: "api", icon: { kind: "preset", preset: "xai" } },
  [OPENROUTER_API_INSTANCE]: {
    driver: "openai-compat", displayName: "OpenRouter", access: "api", icon: { kind: "preset", preset: "openrouter" },
    config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "OMB_OPENROUTER_API_KEY" },
  },
};

     export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  const DEFAULT_FLEET: InstanceConfigMap = {
    grok: { driver: "grokAgent" },
    kimi: { driver: "kimiAgent" },
    droid: { driver: "droidAgent" },
    cursor: { driver: "cursorAgent" },
    claude: { driver: "claudeAgent" },
    codex: { driver: "codex" },
    chatgpt: { driver: "codex", displayName: "ChatGPT plan", config: { authMode: "chatgpt-plan" } },
    antigravity: { driver: "antigravityAgent" },
    opencodeGo: { driver: "opencodeGo" },
    openaiCompat: { driver: "openai-compat" },
    mistral: { driver: "mistral" },
    cerebras: { driver: "cerebras" },
    groq: { driver: "groq" },
    meta: { driver: "meta" },
    deepseek: { driver: "deepseekAgent" },
    museCode: { driver: "museCode" },
    ...API_KEY_FLEET,
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
    cline: { driver: "clineAgent" },
    pi: { driver: "piAgent" },
  };
  const CUSTOM_ONLY = {
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
    cline: { driver: "clineAgent" },
    pi: { driver: "piAgent" },
  } as const;
  const PRODUCT_FLEET_ADDITIONS = {
    chatgpt: { driver: "codex", displayName: "ChatGPT plan", config: { authMode: "chatgpt-plan" } },
    cursor: { driver: "cursorAgent" },
    openaiCompat: { driver: "openai-compat" },
    mistral: { driver: "mistral" },
    cerebras: { driver: "cerebras" },
    groq: { driver: "groq" },
    meta: { driver: "meta" },
    deepseek: { driver: "deepseekAgent" },
    museCode: { driver: "museCode" },
    ...API_KEY_FLEET,
    ...CUSTOM_ONLY,
  } as const;
  const configured = cfg.instances && Object.keys(cfg.instances).length ? cfg.instances : null;
  const map: InstanceConfigMap = withoutComputerEngine(configured ? { ...configured } : { ...DEFAULT_FLEET });
  if (
    configured &&
    (Object.hasOwn(configured, "claude") || Object.hasOwn(configured, "grok") || Object.hasOwn(configured, "codex"))
  ) {
    for (const [id, entry] of Object.entries(PRODUCT_FLEET_ADDITIONS)) {
      if (!Object.hasOwn(map, id)) map[id] = { ...entry };
    }
  }
  for (const [id, builtIn] of Object.entries(API_KEY_FLEET)) {
    const saved = map[id];
    if (!saved || saved.driver !== builtIn.driver) continue;
    const savedConfig = typeof saved.config === "object" && saved.config !== null && !Array.isArray(saved.config) ? saved.config : {};
    map[id] = { ...builtIn, ...saved, config: { ...(builtIn.config as object | undefined), ...savedConfig } };
  }
  if (map.chatgpt?.driver === "codex" && !(map.chatgpt.config as { cli?: unknown } | undefined)?.cli) {
    const cli = (map.codex?.config as { cli?: unknown } | undefined)?.cli;
    if (typeof cli === "string" && cli) map.chatgpt = { ...map.chatgpt, config: { ...map.chatgpt.config as object, cli } };
  }
  for (const [id, sourceEntry] of Object.entries(map)) {
    const entry = { ...sourceEntry };
    map[id] = entry;
    const environment = { ...entry.environment };
    const builtIn = API_KEY_FLEET[id];
    const routingDefaults = builtIn?.driver === entry.driver
      ? builtIn.config as { url?: string; apiKeyEnv?: string } | undefined
      : undefined;
    const ownsRouting = instanceOwnsRouting(cfg, entry, routingDefaults);
    if (!ownsRouting) {
      for (const [key, value] of injectedEnvironment(cfg, id, entry.driver)) environment[key] = value;
    }
    entry.environment = environment;
    if (entry.driver === "groq" && cfg.groq?.url && !ownsRouting) {
      entry.config = { ...entry.config as object, url: cfg.groq.url };
    }
    if (entry.driver === "meta" && cfg.meta?.url && !ownsRouting) {
      entry.config = { ...entry.config as object, url: cfg.meta.url };
    }
    if (entry.driver === "openai-compat" && cfg.openaiCompat && id !== OPENAI_API_INSTANCE && id !== OPENROUTER_API_INSTANCE) {
      const defaults: Record<string, string> = {};
      if (cfg.openaiCompat.url) defaults.url = cfg.openaiCompat.url;
      if (cfg.openaiCompat.model) defaults.model = cfg.openaiCompat.model;
      if (cfg.openaiCompat.provider) defaults.provider = cfg.openaiCompat.provider;
      if (Object.keys(defaults).length) {
        const raw = entry.config;
        const current =
          typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
        const merged = { ...current };
        for (const [k, v] of Object.entries(defaults)) {
          if (k === "provider" && typeof merged[k] === "string") continue;
          if (typeof merged[k] !== "string" || !(merged[k] as string).trim()) merged[k] = v;
        }
        entry.config = merged;
      }
    }
  }
  // Workspace overrides belong to this connection and endpoint, never to
  // a separate compatible account that happens to use the same model ID.
  const shared = map.openaiCompat;
  if (shared?.driver === "openai-compat" && cfg.openaiCompat?.contextWindows) {
    const current = typeof shared.config === "object" && shared.config !== null && !Array.isArray(shared.config) ? shared.config as Record<string, unknown> : {};
    const url = typeof current.url === "string" && current.url ? current.url : cfg.openaiCompat.url || "https://openrouter.ai/api/v1";
    const windows = cfg.openaiCompat.contextWindows[url.replace(/\/+$/, "")];
    if (windows && !Object.hasOwn(current, "contextWindows")) shared.config = { ...current, contextWindows: windows };
  }
  return map;
}


export type CustomMcpServer = McpServerSpec;

const reportedMcpSkips = new Set<string>();
function skipMcpEntry(name: string, why: string): void {
  const key = `${name}: ${why}`;
  if (reportedMcpSkips.has(key)) return;
  reportedMcpSkips.add(key);
  console.error(`mcpServers.${JSON.stringify(name)} skipped — ${why}`);
}

 export function customMcpServers(cfg: AppConfig, only?: string[]): Record<string, CustomMcpServer> {
  const out: Record<string, CustomMcpServer> = {};
  for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
    if (only && !only.includes(name)) continue;
    const parsed = parseStoredMcpServer(name, raw);
    if (!parsed.ok) {
      skipMcpEntry(name, `${parsed.error} Expected { "command": "npx", "args": [...], "env": { ... } } or { "type": "http", "url": "https://…", "headers": { ... } }`);
      continue;
    }
    if (!parsed.server.enabled || parsed.server.runsOn) continue; // a server of another computer's never starts here
    out[name] = isRemoteMcpServer(parsed.server)
      ? { type: parsed.server.type, url: parsed.server.url, headers: parsed.server.headers }
      : { command: parsed.server.command, args: parsed.server.args, env: parsed.server.env };
  }
  return out;
}
