// Config + data dirs. One file, ~/.openmausbot/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"apiKey":"ak_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
import { readFileSync, mkdirSync, existsSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { normalizeImageGenerationUrl, type ImageGenerationConfig } from "../shared/image-generation.ts";

import { writeFileAtomic } from "./atomic.ts";
import { newBotDefaultsSchema, type NewBotDefaults } from "./new-bot-defaults.ts";
import { EFFORT_LEVELS, type EffortLevel, type LiveSettings } from "../shared/wire.ts";
import { isModelVariant, type InstanceConfigMap, type ModelSelection } from "./contracts.ts";
import { PROVIDER_ICON_PRESETS, providerIconError } from "../shared/provider-icon.ts";
import type { McpServerSpec } from "./contracts.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "./mcp-registry.ts";
import { parseJson, schemaIssue, type JsonObject, type JsonValue } from "./schema.ts";

const optionalText = z.string().optional();
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LEGACY_BROWSER_PROFILE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const BROWSER_PROFILE_ID = /^[a-z0-9_-]{1,40}$/;

/** Fish Audio speech models (`tts.fishModel`). `s2.1-pro-free` is Fish's
 * free developer tier; an unset model means `s2.1-pro`. */
export const FISH_TTS_MODELS = ["s2.1-pro", "s2.1-pro-free"] as const;
export type FishTtsModel = (typeof FISH_TTS_MODELS)[number];

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
export const MAX_LOCAL_VM_MAX_INSTANCES = 8;
/** Idle window before a Local VM's disposable container is recycled. The
 * default keeps the historical 8-hour window for existing configs. */
export const DEFAULT_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 480;
export const MIN_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 5;
export const MAX_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 1_440;

export function isValidSshAlias(value: unknown): value is string {
  return typeof value === "string" && SSH_ALIAS.test(value);
}

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
   * hard cap is the maximum stall window, measured wall-clock from the
   * tree's last durable progress. */
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
/** Isolation for bot desktops. Migration note (issue #1654): switching
 * modes changes lease keys and vm-home directories, so desktops cold-start
 * under the new mode — a pool seat lives in vm-homes/pool-N — while the old
 * mode's workspaces stay on disk until removed. maxInstances caps per-bot
 * desktops in per-bot mode, or the pool's seat count in pool mode; it is
 * not a total across modes. Default stays "shared". */
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
const legacyBrowserProfileSchema = z.object({
  id: z.string().regex(LEGACY_BROWSER_PROFILE_ID).refine((id) => id !== "guest", "guest is reserved"),
  name: z.string().trim().min(1).max(40),
  /** Exact #567 Electron partition identity. This is persisted only by the
   * migration boundary; config PATCH callers cannot choose or redirect it. */
  partitionId: z.string().regex(LEGACY_BROWSER_PROFILE_ID).refine((id) => id !== "guest", "guest is reserved").optional(),
}).strict();

interface StoredBrowserProfileMigration {
  profiles: BrowserProfile[];
  /** Exact legacy id to its first canonical entry. Duplicate legacy ids are
   * inherently ambiguous, so bots deterministically retain the first one. */
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

  // Canonical logical ids must be stable even if bots.json is migrated before
  // config.json is rewritten. Give an exact lowercase spelling first claim on
  // its id, then the first case variant. Generated ids avoid every legacy base
  // and partition spelling, so applying the same legacy alias map again cannot
  // reinterpret a previously migrated bot reference.
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

  // Chromium partition directories collide by case on Windows and default
  // macOS volumes. Pick one safe owner for every case-folded identity. Prefer
  // the profile whose canonical id matches that partition; every loser gets a
  // new partition named after its collision-safe logical id.
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

  // An earlier implementation could produce a cycle such as
  // `foo-2 -> partition foo-2-2` and `foo-2-2 -> partition FOO-2`. The
  // partitions are distinct today, but deleting and re-adding either id would
  // join the other account. Move the *logical id owner* to a fresh id while
  // retaining both exact durable partitions. Fresh ids avoid every raw id, so
  // the old->new bot aliases below remain fixed points across repeated starts.
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
    if (partitionId !== id) migrated.partitionId = partitionId;
    // Exact duplicates are inherently ambiguous. Preserve the first mapping;
    // later duplicate records get isolated ids but existing bot references
    // cannot be distinguished from the first record.
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
  /** Run a routine inside the conversation it reports to, instead of a hidden
   * thread. Off unless explicitly enabled. The run still starts from its own
   * instructions, but the messages stay in that chat. */
  routinesInConversation: z.boolean().optional(),
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
  /** Before each turn, passages from the bot's own memory files and earlier
   * conversations that share words with the message ride into the turn.
   * Read-only; on unless explicitly switched off — see autoRecallEnabled. */
  autoRecall: z.boolean().optional(),
  /** Opt-in shared skills library: one store at the data dir that bots
   * read by assignment instead of per-workspace copies. Off until
   * explicitly enabled — see skillsLibraryEnabled. */
  skillsLibrary: z.boolean().optional(),
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
  /** OMB Cloud home only: when a bot's turn first finished on this machine
   * (cloud-home.ts firstCloudTurnPatch). Written by the server, read by the
   * Cloud's setup checklist. */
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
const threadsConfigSchema = z.object({
  maxConcurrentPerBot: z.number().int().min(1).max(MAX_CONCURRENT_BOT_THREADS),
  /** Cap each per-thread events/ and native/ NDJSON log at this many
   * bytes; absent (the default) keeps today's unbounded growth (#1280). */
  eventLogMaxBytes: z.number().int().min(MIN_THREAD_EVENT_LOG_BYTES).max(MAX_THREAD_EVENT_LOG_BYTES).optional(),
  /** Days a closed or archived thread's event logs survive (#1280).
   * Absent keeps them forever. */
  eventLogRetentionDays: z.number().int().min(1).max(3650).optional(),
}).strict();
/** Workspace-wide defaults every new bot starts with (Store.createBot). */
const newBotsConfigSchema = z.object({
  /** Effort for a new bot whose model selection names none. */
  effort: z.enum(EFFORT_LEVELS).optional(),
}).strict();
/** PATCH newBots: null clears a default back to absent (no level is sent). */
const newBotsPatchSchema = z.object({
  effort: newBotsConfigSchema.shape.effort.nullable(),
}).strict();
/** PATCH threads: every knob is independently patchable, and null clears an
 * event-log knob back to its absent (off) default. */
const threadsPatchSchema = threadsConfigSchema.extend({
  maxConcurrentPerBot: threadsConfigSchema.shape.maxConcurrentPerBot.optional(),
  eventLogMaxBytes: threadsConfigSchema.shape.eventLogMaxBytes.nullable(),
  eventLogRetentionDays: threadsConfigSchema.shape.eventLogRetentionDays.nullable(),
});
const appConfigSchema = z.object({
  /** Verified by the dedicated domain endpoint, never a generic config patch. */
  customDomain: z.string().optional(),
  /** Who may sign in with an emailed code (server/account-signin.ts):
   * addresses or `@domain` entries; admins get every scope, members chat only. */
  signIn: z.object({ admins: z.array(z.string().max(320)).max(500).optional(), members: z.array(z.string().max(320)).max(5000).optional() }).optional(),
  defaultModelSelection: defaultModelSelectionSchema.optional(),
  automaticRecovery: automaticRecoverySchema.optional(),
  newBotDefaults: newBotDefaultsSchema.optional(),
  newBots: newBotsConfigSchema.optional(),
  /** CLI-only launch preferences. Never enable remote access implicitly. */
  cliStartup: z.object({
    access: z.enum(["local", "tunnel", "tailscale", "public-url"]),
    publicUrl: z.string().url().optional(),
    phone: z.enum(["ios", "android"]).optional(),
  }).optional(),
  mistral: z.object({ key: optionalText }).optional(),
  cerebras: z.object({ key: optionalText }).optional(),
  xai: z.object({ key: optionalText, url: optionalText }).optional(),
  /** Anthropic API key for Claude Code billed per token, handed only to
   * Claude instances; `url` only for a proxy or a test double. Never a
   * personal-login OAuth token. */
  anthropic: z.object({ key: optionalText, url: optionalText, everyClaudeBot: z.boolean().optional() }).optional(),
  /** OpenAI's own API key, for the `openai` instance only. Codex keeps its
   * own ChatGPT or API login and never reads this. */
  openai: z.object({ key: optionalText }).optional(),
  /** OpenRouter key, for the `openrouter` instance only. */
  openrouter: z.object({ key: optionalText }).optional(),
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
  /** Historical config section name "box" (the persisted config.json key); the
   * provider is Boat now and the key is kept for compatibility. */
  box: z.object({ token: optionalText }).optional(),
  vps: vpsConfigSchema.optional(),
  /** Optional OpenCode key; persisted write-only and passed only to its child.
   * `providerKeys`: keys for OpenCode's other providers (Venice, Groq…) by the
   * environment name OpenCode reads, also write-only and only for its child.
   * Settings changes go through mergeOpenCodeProviderKeys; the stored copy
   * is read loosely (storedAppConfigSchema). */
  opencodeGo: z.object({ apiKey: optionalText, providerKeys: z.record(z.string(), z.string()).optional() }).optional(),
  /** Voice settings and the selected voice id. `provider` picks the
   * engine: "elevenlabs" (default; needs `key`), "fish" (needs its own
   * `fishKey`; `fishModel` picks its speech model), "system" (the Mac's
   * built-in voices, no key), "xai" (Grok TTS, reusing `xai.key`), or
   * "chatterbox" (a local OpenAI-compatible Chatterbox server; `baseUrl`
   * and `model` are settings, not secrets). Cloud keys stay separate so
   * switching providers never overwrites or misuses the other key. */
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
  /** The decision model (server/decider): a fast classifier that picks
   * things for bots, starting with who answers a room message. `key` is
   * write-only like every credential; `baseUrl` points at a Jev-compatible
   * server instead of TypeSafe's (an operator setting with no UI); `jobs`
   * switches each decision on or off. Not `decisions`: that section is the
   * authorization log's retention. */
  decider: z.object({
    enabled: z.boolean().optional(),
    provider: z.enum(["jev", "off"]).optional(),
    key: optionalText,
    baseUrl: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => !value || /^https?:\/\//i.test(value), "the decision model address must start with http:// or https://")
      .optional(),
    jobs: z.object({ roomRouting: z.boolean().optional() }).optional(),
  }).optional(),
  /** Live calls: an OpenAI project key for GPT-Live, kept apart from every
   * other OpenAI credential so a Live call never bills an image or engine key
   * the user did not hand to it. `voice` is a GPT-Live built-in voice name. */
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
  profile: z.object({ name: optionalText, email: optionalText, aboutMe: z.string().max(24_000).optional() }).optional(),
  /** UI language override (BCP-47, lowercase). Empty/absent = follow the
   * system language. Unknown tags degrade to English in the renderer. */
  language: optionalText,
  rooms: roomConfigSchema.optional(),
  context: z.object({
    rebuildBytes: z.number().int().min(1_024).max(1_000_000).optional(),
    compactAt: z.number().positive().max(10_000_000).optional(),
    autoCompact: z.boolean().optional(),
  }).optional(),
  /** Memory upkeep timing, for bots with Memory upkeep switched on. */
  memory: z.object({
    /** Quiet time after a turn before its facts are captured (ms). */
    captureQuietMs: z.number().int().min(1_000).max(24 * 60 * 60_000).optional(),
    /** Local hour (0-23) after which the nightly tidy-up runs. */
    tidyHour: z.number().int().min(0).max(23).optional(),
  }).strict().optional(),
  threads: threadsConfigSchema.optional(),
  /** The authorization decision log (server/decision-log.ts): days of month
   * files kept, at least; OMB_DECISION_RETENTION_DAYS wins when set. */
  decisions: z.object({ retentionDays: z.number().int().min(1).max(3650).optional() }).strict().optional(),
  localVm: localVmConfigSchema.optional(),
  features: featureConfigSchema.optional(),
  onboarding: onboardingConfigSchema.optional(),
  /** CDP attach target for a bot's browser; see browserEngineConfigSchema. */
  browserEngine: browserEngineConfigSchema.optional(),
  browserProfiles: browserProfilesSchema.optional(),
  instances: instanceConfigMapSchema.optional(),
  /** User-configured MCP servers, mounted into every capable engine. Kept
   * loosely typed HERE on purpose: parseStoredConfig throws away the whole
   * file on a schema error, and one bad server entry must degrade to a
   * skipped entry (customMcpServers), never to a vanished config. */
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});
const storedAppConfigSchema = appConfigSchema.extend({
  browserProfiles: storedBrowserProfilesSchema.optional(),
  /** Read loosely, like mcpServers: a hand-edited provider key that isn't
   * text is dropped here, and a bad name or key later
   * (openCodeProviderKeys), never the whole file. */
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

export interface AppConfig {
  customDomain?: string;
  signIn?: { admins?: string[]; members?: string[] };
  /** Preferred selection for newly created bots; existing bots keep theirs. */
  defaultModelSelection?: ModelSelection;
  /** Off by default; one backup attempt only before any work starts. */
  automaticRecovery?: { enabled: boolean; backup?: ModelSelection };
  /** UI creation template. Saving it never mutates a bot or grants access. */
  newBotDefaults?: NewBotDefaults;
  /** Defaults for newly created bots that no model selection carries. */
  newBots?: { effort?: EffortLevel };
  cliStartup?: {
    access: "local" | "tunnel" | "tailscale" | "public-url";
    publicUrl?: string;
    phone?: "ios" | "android";
  };
  mcpServers?: Record<string, unknown>;
  language?: string;
  xai?: { key?: string; url?: string };
  mistral?: { key?: string };
  cerebras?: { key?: string };
  /** `everyClaudeBot`: the key runs every Claude bot instead of its login.
   * Unset means true, which is how a key behaved before it had its own
   * `claudeApi` instance; a key first saved from Settings sets false. */
  anthropic?: { key?: string; url?: string; everyClaudeBot?: boolean };
  openai?: { key?: string };
  openrouter?: { key?: string };
  budgets?: { monthlyUsd?: number; warnAtPercent?: number };
  decisions?: { retentionDays?: number };
  billing?: { currency?: string; prices?: Record<string, { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number }> };
  openaiCompat?: { key?: string; url?: string; model?: string; provider?: string };
  composio?: { apiKey?: string; userId?: string; sessionId?: string };
  /** Persisted under the historical config key "box" (ascii.dev renamed Box to Boat). */
  box?: { token?: string };
  /** A named host from the user's SSH config. Authentication stays with SSH. */
  vps?: { sshAlias?: string };
  opencodeGo?: { apiKey?: string; providerKeys?: Record<string, string> };
  tts?: { key?: string; fishKey?: string; voice?: string; provider?: "elevenlabs" | "fish" | "system" | "chatterbox" | "xai"; baseUrl?: string; model?: string; fishModel?: FishTtsModel };
  /** The decision model; see the schema above and server/decider. */
  decider?: { enabled?: boolean; provider?: "jev" | "off"; key?: string; baseUrl?: string; jobs?: { roomRouting?: boolean } };
  imageGen?: ImageGenerationConfig;
  live?: { key?: string; voice?: string; readTypedReplies?: boolean; idleMinutes?: number };
  profile?: { name?: string; email?: string; aboutMe?: string };
  rooms?: { turnTimeoutMinutes: number; handoffLifetimeMinutes?: number; handoffMinRunwayMinutes?: number; handoffHardCapMinutes?: number };
  threads?: { maxConcurrentPerBot: number; eventLogMaxBytes?: number; eventLogRetentionDays?: number };
  context?: { rebuildBytes?: number; compactAt?: number; autoCompact?: boolean };
  memory?: { captureQuietMs?: number; tidyHour?: number };
  /** Shared preserves the historical singleton. Per-bot gives every bot a
   * separate container, durable workspace, viewer and lease. Pool runs N
   * seats shared by all conversations, with per-thread affinity (#1654). */
  localVm?: { mode?: "shared" | "per-bot" | "pool"; maxInstances?: number; idleTimeoutMinutes?: number };
  /** Opt-in product experiments. Every flag defaults to disabled. */
  features?: { skillAuthoring?: boolean; showToolCalls?: boolean; browser?: boolean; sharedComputers?: boolean; claudeUserMcp?: boolean; llmThreadTitles?: boolean; autoRecall?: boolean; routinesInConversation?: boolean; skillsLibrary?: boolean };
  /** First-run progress; see onboardingConfigSchema. */
  onboarding?: { completedAt?: string; version?: number; reelSeen?: boolean; hintsSeen?: string[]; firstTurnAt?: string };
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

/** Resolve a canonical profile record to its exact durable Electron
 * partition identity. Callers must never substitute the display/API id. */
export function browserProfilePartitionId(profile: BrowserProfile): string {
  return profile.partitionId ?? profile.id;
}

/** Every durable partition must have one owner, and no other profile may use
 * that partition's folded name as its logical id. Otherwise deleting and
 * re-adding the logical id can silently attach a bot to the retained account. */
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

/** A list replacement cannot recycle a removed partition in the same write.
 * Electron erases that partition only after commit, so allowing a new profile
 * to claim its case-folded name would race new activity against the wipe. */
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
  /** Canonical application identity: bot references and reuse locks use it. */
  profileId: string;
  /** Exact Electron storage identity: view routing and cleanup use it. */
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

/** Exact old→canonical profile ids from #567's persisted config. Store
 * hydration uses this to migrate bot references in the same write that
 * resets other transient bot state. Invalid/non-legacy config is inert. */
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

/** Read-and-revalidate accessor, same shape as vpsSshAlias above: even
 * though loadConfig()/parseStoredConfig() already schema-validate this
 * field, callers that forward it into a child process environment get a
 * second, cheap guarantee rather than trusting a hand-edited config.json. */
export function browserEngineAttachCdpUrl(cfg: AppConfig): string | null {
  return isValidCdpTarget(cfg.browserEngine?.attachCdpUrl) ? cfg.browserEngine.attachCdpUrl : null;
}

export function roomTurnTimeoutMinutes(cfg: AppConfig): number {
  return cfg.rooms?.turnTimeoutMinutes ?? DEFAULT_ROOM_TURN_TIMEOUT_MINUTES;
}

export const LIVE_IDLE_MINUTES_DEFAULT = 5;

/** Non-secret Live settings. The key only shows up as `configured`. */
export function liveSettingsFor(cfg: AppConfig): LiveSettings {
  const minutes = cfg.live?.idleMinutes;
  return {
    configured: Boolean(cfg.live?.key?.trim()),
    voice: cfg.live?.voice ?? "",
    readTypedReplies: cfg.live?.readTypedReplies ?? true,
    idleMinutes: Number.isInteger(minutes) && minutes! >= 1 && minutes! <= 60 ? minutes! : LIVE_IDLE_MINUTES_DEFAULT,
  };
}

export interface RoomHandoffLimitsMs {
  lifetimeMs: number;
  minRunwayMs: number;
  hardCapMs: number;
}

/** Room handoff tree budgets in milliseconds. The tree lifetime pauses
 * while a node is actively executing; the hard cap is the maximum stall
 * window, measured wall-clock from the tree's last durable progress. Read
 * when the server starts. */
export function roomHandoffLimits(cfg: AppConfig): RoomHandoffLimitsMs {
  return {
    lifetimeMs: (cfg.rooms?.handoffLifetimeMinutes ?? DEFAULT_ROOM_HANDOFF_LIFETIME_MINUTES) * 60_000,
    minRunwayMs: (cfg.rooms?.handoffMinRunwayMinutes ?? DEFAULT_ROOM_HANDOFF_MIN_RUNWAY_MINUTES) * 60_000,
    hardCapMs: (cfg.rooms?.handoffHardCapMinutes ?? DEFAULT_ROOM_HANDOFF_HARD_CAP_MINUTES) * 60_000,
  };
}

/** Accepts a full config or a parsed patch: the concurrency limit may be
 * read from either, and a patch may legitimately omit it. */
export function maxConcurrentBotThreads(cfg: { threads?: { maxConcurrentPerBot?: number } }): number {
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

export function localVmMode(cfg: AppConfig): "shared" | "per-bot" | "pool" {
  return cfg.localVm?.mode ?? DEFAULT_LOCAL_VM_MODE;
}

export function localVmMaxInstances(cfg: AppConfig): number {
  return cfg.localVm?.maxInstances ?? DEFAULT_LOCAL_VM_MAX_INSTANCES;
}

export function localVmIdleTimeoutMinutes(cfg: AppConfig): number {
  return cfg.localVm?.idleTimeoutMinutes ?? DEFAULT_LOCAL_VM_IDLE_TIMEOUT_MINUTES;
}

/** On by default; only an explicit `false` (the Settings toggle, or a legacy
 * `skillRecorder: false` carried over at startup) switches it off. */
export function skillAuthoringEnabled(cfg: AppConfig): boolean {
  return cfg.features?.skillAuthoring !== false;
}

/** Automatic recall is read-only, so it is on unless switched off. */
export function autoRecallEnabled(cfg: AppConfig): boolean {
  return cfg.features?.autoRecall !== false;
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

/** A routine's turns are posted in the conversation that receives its card.
 * Off by default, so scheduled work stays in a hidden thread. */
export function routinesInConversationEnabled(cfg: AppConfig): boolean {
  return cfg.features?.routinesInConversation === true;
}

/** Workspace-level gate for the built-in browser. A bot's own switch sits
 * under it, so either can withhold the browser. On unless the person switched
 * it off: an explicit `false` (Settings, or a bot's computer panel) is kept. */
export function builtInBrowserEnabled(cfg: AppConfig, _env: NodeJS.ProcessEnv = process.env): boolean {
  return cfg.features?.browser !== false;
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

/** Opt-in generated titles for new bot threads: a cheap provider one-shot
 * names the row instead of the first-message snippet. Off until enabled by
 * hand in ~/.openmausbot/config.json
 * (`{"features": {"llmThreadTitles": true}}`); a one-shot that fails or
 * answers anything unusable leaves the snippet untouched. */
export function llmThreadTitlesEnabled(cfg: AppConfig): boolean {
  return cfg.features?.llmThreadTitles === true;
}

/** Opt-in shared skills library (skills lane S1): one store at the data dir
 * that bots reference by assignment instead of per-workspace copies. Off
 * unless enabled by hand in ~/.openmausbot/config.json
 * (`{"features": {"skillsLibrary": true}}`); while off, every skills
 * surface keeps today's byte-identical per-bot behavior. */
export function skillsLibraryEnabled(cfg: AppConfig): boolean {
  return cfg.features?.skillsLibrary === true;
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
  // no engine reads it: the harness asks it before a turn starts
  "decider",
  "imageGen",
  "live",
  "vps",
  "rooms",
  "threads",
  "automaticRecovery",
  "context",
  "memory",
  "localVm",
  "features",
  "browserProfiles",
  "onboarding",
]);

/** The keys of a config patch that require the provider fleet to reload. */
export function providerReloadKeys(patch: object): string[] {
  return Object.keys(patch).filter((key) => !FLEET_NEUTRAL_KEYS.has(key));
}

// OMB_DATA_DIR isolates test/soak rigs from the user's real fleet.
export const DATA_DIR = process.env.OMB_DATA_DIR ?? join(homedir(), ".openmausbot");
const LEGACY_DATA_DIR = join(homedir(), ".opengrokbot");
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");

export function ensureDirs() {
  // one-time migration from the pre-rename data dir — bots, transcripts,
  // config and keys all carry over
  if (!existsSync(DATA_DIR) && existsSync(LEGACY_DATA_DIR)) {
    try {
      renameSync(LEGACY_DATA_DIR, DATA_DIR);
    } catch {
      /* cross-device or busy — fall through to a fresh dir */
    }
  }
  for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR]) mkdirSync(dir, { recursive: true });
  migrateLegacyFeatureFlags();
}

/** `features.skillRecorder` became `features.skillAuthoring` when the Teach a
 * skill recorder was removed. featureConfigSchema is non-strict, so
 * parseStoredConfig would silently drop the old key (reading the opt-in as
 * off) while saveConfig's raw section merge would carry it on disk forever.
 * Rewrite it once, here, before the server's single loadConfig() at boot: an
 * explicit `skillAuthoring` already on disk wins over the legacy key, and a
 * file without the legacy key is left untouched. */
function migrateLegacyFeatureFlags(): void {
  const p = join(DATA_DIR, "config.json");
  try {
    if (!existsSync(p)) return;
    const disk = jsonObjectSchema.safeParse(parseJson(readFileSync(p, "utf8")));
    if (!disk.success) return;
    const features = jsonObjectSchema.safeParse(disk.data.features);
    if (!features.success || !Object.hasOwn(features.data, "skillRecorder")) return;
    const next: JsonObject = { ...features.data };
    if (!Object.hasOwn(next, "skillAuthoring")) next.skillAuthoring = next.skillRecorder === true;
    delete next.skillRecorder;
    writeFileAtomic(p, JSON.stringify({ ...disk.data, features: next }, null, 2), { mode: 0o600 });
    console.log(`[config] features.skillRecorder renamed to features.skillAuthoring (${String(next.skillAuthoring)})`);
  } catch (error) {
    // A readable but unwritable config would otherwise lose the opt-in on
    // every boot with no trace: parseStoredConfig drops the legacy key.
    console.error(`[config] could not rename features.skillRecorder: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The last "config.json is being ignored" warning, so a file that stays
 * broken is reported once rather than on every loadConfig() call. */
let lastIgnoredConfigWarning = "";

export function loadConfig(): AppConfig {
  let cfg: AppConfig = {};
  try {
    cfg = parseStoredConfig(parseJson(readFileSync(join(DATA_DIR, "config.json"), "utf8")));
    lastIgnoredConfigWarning = "";
  } catch (error) {
    // No file yet is a normal first run: env fallbacks below. Any other failure
    // (unreadable file, invalid JSON, a schema error in one field) means the
    // whole file is being ignored for this process — every instance, account
    // and setting in it — so say why instead of silently running on defaults.
    // saveConfig() still merges into the raw file, so nothing on disk is lost;
    // the user just needs to know which field to fix.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      // JSON.parse includes a fragment of the input in some error messages.
      // A malformed credential must never be copied into the server log.
      const reason = error instanceof SyntaxError ? "invalid JSON"
        : error instanceof Error ? error.message : "unable to read configuration";
      const warning = `config: ignoring ${join(DATA_DIR, "config.json")} and using defaults: ${reason}`;
      if (warning !== lastIgnoredConfigWarning) console.warn(warning);
      lastIgnoredConfigWarning = warning;
    } else {
      lastIgnoredConfigWarning = "";
    }
  }
  // Env wins over the file for every credential. The desktop shell keeps
  // these secrets OS-encrypted and hands them to this process as env at
  // spawn, leaving config.json without the plaintext field — so the file
  // value is the dev-mode (no desktop shell) fallback, not the primary.
  // Anything that saves a credential mid-session must keep process.env in
  // step (syncCredentialEnv below), or the value injected at boot would
  // shadow the save until the next launch.
  cfg.mistral = { ...cfg.mistral };
  if (process.env.MISTRAL_API_KEY !== undefined) cfg.mistral.key = process.env.MISTRAL_API_KEY;
  cfg.cerebras = { ...cfg.cerebras };
  if (process.env.CEREBRAS_API_KEY !== undefined) cfg.cerebras.key = process.env.CEREBRAS_API_KEY;
  cfg.xai = { ...cfg.xai };
  if (process.env.XAI_API_KEY !== undefined) cfg.xai.key = process.env.XAI_API_KEY;
  // Deliberately not ANTHROPIC_API_KEY: a key in the server's own env is
  // never the workspace key, so an operator's stray variable cannot flip
  // every Claude bot onto pay-as-you-go billing.
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
  // BOX_TOKEN keeps its historical name; the provider is Boat.
  cfg.box = { ...cfg.box };
  if (process.env.BOX_TOKEN !== undefined) cfg.box.token = process.env.BOX_TOKEN;
  cfg.opencodeGo = { ...cfg.opencodeGo };
  if (process.env.OPENCODE_API_KEY !== undefined) cfg.opencodeGo.apiKey = process.env.OPENCODE_API_KEY;
  cfg.tts = { ...cfg.tts };
  if (process.env.OMB_TTS_KEY !== undefined) cfg.tts.key = process.env.OMB_TTS_KEY;
  // A preset ElevenLabs voice (Cloud Pro sets one) is only a default: a voice or
  // another speech provider the person picked in Settings always wins.
  const presetVoice = process.env.OMB_TTS_DEFAULT_VOICE?.trim();
  if (presetVoice && !cfg.tts.voice?.trim() && (cfg.tts.provider ?? "elevenlabs") === "elevenlabs") cfg.tts.voice = presetVoice;
  if (process.env.OMB_FISH_AUDIO_API_KEY !== undefined) cfg.tts.fishKey = process.env.OMB_FISH_AUDIO_API_KEY;
  cfg.decider = { ...cfg.decider };
  if (process.env.OMB_JEV_API_KEY !== undefined) cfg.decider.key = process.env.OMB_JEV_API_KEY;
  cfg.live = { ...cfg.live };
  if (process.env.OMB_OPENAI_LIVE_KEY !== undefined) cfg.live.key = process.env.OMB_OPENAI_LIVE_KEY;
  cfg.imageGen = { ...cfg.imageGen };
  if (process.env.OMB_OPENAI_IMAGE_KEY !== undefined) cfg.imageGen.key = process.env.OMB_OPENAI_IMAGE_KEY;
  if (process.env.OMB_CUSTOM_IMAGE_KEY !== undefined) cfg.imageGen.customApiKey = process.env.OMB_CUSTOM_IMAGE_KEY;
  // The sign-in allow-list: env is how a headless box or a container is
  // bootstrapped before anyone can reach Settings.
  const splitEmails = (value: string) => value.split(/[,\s]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (process.env.OMB_SIGNIN_EMAILS !== undefined || process.env.OMB_SIGNIN_MEMBER_EMAILS !== undefined) {
    cfg.signIn = { ...cfg.signIn };
    if (process.env.OMB_SIGNIN_EMAILS !== undefined) cfg.signIn.admins = splitEmails(process.env.OMB_SIGNIN_EMAILS);
    if (process.env.OMB_SIGNIN_MEMBER_EMAILS !== undefined) cfg.signIn.members = splitEmails(process.env.OMB_SIGNIN_MEMBER_EMAILS);
  }
  return cfg;
}

/** `derive(loadConfig())`, worked out again only when config.json changes:
 * a new file (every save renames one into place), a new size, a new
 * modification time, or new permissions or owner. For values read on every
 * request or stream frame, where parsing the file each time costs more than
 * the work itself. A file that is missing, saved in the last two seconds, or
 * that loadConfig() could not use (unreadable, a failed read, invalid JSON)
 * is read on every call: a second write inside one clock tick is never
 * missed, and a file that is fixed is used again on the next call. */
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
    // A warning means loadConfig() ignored the file and ran on defaults.
    cached = stamp === null || lastIgnoredConfigWarning !== "" ? null : { stamp, value };
    return value;
  };
}

/** After saveConfig() writes a credential, the running process's env must
 * follow the newest value — loadConfig() prefers env, so the secret injected
 * at boot would otherwise shadow the save until relaunch: the UI would show
 * "saved" while every turn still used the old key. An empty string means the
 * user cleared the credential, so the var is dropped and the (now empty)
 * file value is authoritative again. Fields absent from the patch are
 * untouched. */
export function syncCredentialEnv(patch: Partial<Omit<AppConfig, "threads" | "newBots">>): void {
  const secrets: Array<[value: string | undefined, name: string]> = [
    [patch.xai?.key, "XAI_API_KEY"],
    [patch.mistral?.key, "MISTRAL_API_KEY"],
    [patch.cerebras?.key, "CEREBRAS_API_KEY"],
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
    [patch.imageGen?.key, "OMB_OPENAI_IMAGE_KEY"],
    [patch.imageGen?.customApiKey, "OMB_CUSTOM_IMAGE_KEY"],
    [patch.live?.key, "OMB_OPENAI_LIVE_KEY"],
  ];
  for (const [value, name] of secrets) {
    if (value === undefined) continue;
    if (value) process.env[name] = value;
    else delete process.env[name];
  }
  // loadConfig() also prefers env for url/model/provider, so a saved value
  // must follow the same set-when-truthy / delete-when-cleared rule as keys.
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

/** Env names of every workspace credential this process may be holding —
 * injected at boot by the desktop shell or exported by a developer. Spawned
 * engine CLIs must never inherit them: the one driver that consumes a given
 * secret receives it through instanceConfigs() narrowing, and to every other
 * child these are someone else's keys riding along in `...process.env`. */
export const WORKSPACE_CREDENTIAL_ENV = [
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "OMB_ANTHROPIC_API_KEY",
  "OMB_ANTHROPIC_API_URL",
  "OMB_HOSTED_MODEL_TOKEN",
  "OMB_HOSTED_MODELS",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_URL",
  "OMB_OPENAI_API_KEY",
  "OMB_OPENROUTER_API_KEY",
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "OMB_TTS_KEY",
  "OMB_FISH_AUDIO_API_KEY",
  "OMB_JEV_API_KEY",
  "OMB_OPENAI_IMAGE_KEY",
  "OMB_CUSTOM_IMAGE_KEY",
  "OMB_OPENAI_LIVE_KEY",
  "COMPOSIO_API_KEY",
  "OMB_COMPOSIO_BROKER_TOKEN",
  // Cloud Pro's included Boat, voice and decision relay tokens
  // (included-services.ts), used only in-process by the Boat, voice and
  // decider modules.
  "OMB_CLOUD_BOAT_TOKEN",
  "OMB_CLOUD_VOICE_TOKEN",
  "OMB_CLOUD_DECIDER_TOKEN",
  // Harness-private filesystem hints are not credentials themselves, but
  // exposing them to a shell-capable agent points straight at app-owned
  // state. The built-in browser master is delivered privately in memory.
  "OMB_BROWSER_CONNECTION",
  "OMB_USER_DATA",
] as const;

/** Secrets of whoever operates this server, not of the workspace: the license
 * key, a fleet container's installation credential, and everything a hosting
 * control plane injects under `OMB_CLOUD_` (the readiness token, the bootstrap
 * document and its gateway token). Only this process reads them. The prefix
 * ends in an underscore on purpose: `OMB_CLOUDFLARED_PATH` is not one of them.
 * What an engine is meant to receive arrives under another name through its
 * instance environment (the hosted model token as ANTHROPIC_API_KEY or
 * OPENMAUSBOT_COMPANY_API_KEY), so nothing here is ever an engine's input. */
export const CONTROL_PLANE_ENV = ["OMB_LICENSE_KEY", "OMB_INSTALLATION_CREDENTIAL"] as const;
export const CONTROL_PLANE_ENV_PREFIX = "OMB_CLOUD_";

/** Drop every control-plane secret from a child-process env (in place). No
 * driver allowlist re-admits these. Names compare case-insensitively because
 * Windows environments do. */
export function stripControlPlaneEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (name.startsWith(CONTROL_PLANE_ENV_PREFIX) || (CONTROL_PLANE_ENV as readonly string[]).includes(name)) delete env[key];
  }
}

/** Drop every workspace credential, and every control-plane secret, from a
 * child-process env (in place). */
export function stripWorkspaceCredentialEnv(env: Record<string, string | undefined>): void {
  for (const key of WORKSPACE_CREDENTIAL_ENV) delete env[key];
  stripControlPlaneEnv(env);
}

/** Env names a provider CLI might read as its own billing identity. A spawned
 * engine keeps only what its driver explicitly allows: a foreign key riding
 * along in `...process.env` must not flip a subscription CLI onto
 * pay-as-you-go billing the user never granted. */
export const PROVIDER_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "FACTORY_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
] as const;

/** Provider keys OpenCode reads from its environment, as it does in a
 * terminal: with ANTHROPIC_API_KEY set, `opencode` lists Anthropic's models.
 * Keys OpenMaus saves for another engine (xAI, Mistral, the workspace
 * Anthropic key) are workspace credentials under other names and never
 * ride along. */
export const OPENCODE_PROVIDER_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
] as const;

/** Keys the owner saves in Settings for OpenCode's other providers (Venice,
 * Groq, DeepSeek…), each under the environment name OpenCode reads. A Cloud
 * has no terminal to export them in. They go to OpenCode's process only,
 * never to this server's own environment. */
export const OPENCODE_PROVIDER_KEY_LIMIT = 20;
const OPENCODE_PROVIDER_KEY_NAME = /^[A-Z][A-Z0-9_]{0,59}_(?:API_KEY|KEY|TOKEN)$/;
/** Printable, no spaces: no provider key has any, and a pasted sentence is not a key. */
const OPENCODE_PROVIDER_KEY_VALUE = /^[\x21-\x7e]{1,4096}$/;

/** Why OpenCode can't be given a key under this name, or undefined. A name
 * OpenMaus keeps for itself or another engine would never reach OpenCode:
 * every engine keeps only the credential names it reads (credentialEnv). */
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

/** The saved OpenCode provider keys that can be used, by name. A hand-edited
 * entry OpenCode could not be given, or whose value is not a key, is
 * skipped; so is anything past the limit. */
export function openCodeProviderKeys(cfg: Pick<AppConfig, "opencodeGo">): Record<string, string> {
  const saved = cfg.opencodeGo?.providerKeys ?? {};
  const usable = Object.keys(saved).sort()
    .filter((name) => !openCodeProviderKeyNameRefusal(name) && OPENCODE_PROVIDER_KEY_VALUE.test(saved[name] ?? ""))
    .slice(0, OPENCODE_PROVIDER_KEY_LIMIT);
  return Object.fromEntries(usable.map((name) => [name, saved[name]!]));
}

/** A Settings change to the saved OpenCode provider keys: a key saves or
 * replaces its name, "" removes it, and every other saved key stays. Returns
 * the whole new set to store, or why it was refused. */
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

/** Told, synchronously, what each saveConfig wrote: the file before and
 * after. The admin activity log (server/admin-activity.ts) records the
 * change for whoever's request made it. A listener must not throw. */
export function onConfigSaved(listener: (before: JsonObject, after: JsonObject) => void): () => void {
  configSaveListeners.add(listener);
  return () => { configSaveListeners.delete(listener); };
}

/** Merge a partial config into ~/.openmausbot/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
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
  // A write is the durable migration point. Preserve every other raw key in
  // config.json, but never write #567's mixed-case or duplicate profile ids
  // back after we have successfully recognized the legacy list.
  const storedProfiles = storedBrowserProfilesSchema.safeParse(disk.browserProfiles);
  if (storedProfiles.success) disk.browserProfiles = storedProfiles.data;
  for (const key of ["xai", "anthropic", "mistral", "cerebras", "openai", "openrouter", "openaiCompat", "composio", "box", "opencodeGo", "tts", "decider", "imageGen", "live", "profile", "rooms", "threads", "context", "memory", "localVm", "features", "budgets", "billing", "decisions", "onboarding", "browserEngine", "newBots"] as const) {
    const section = checkedPatch[key];
    if (!section) continue;
    const current = jsonObjectSchema.safeParse(disk[key]);
    const merged: JsonObject = current.success ? { ...current.data } : {};
    // parseStoredConfig requires threads.maxConcurrentPerBot, so creating
    // the section with only an event-log knob must still persist a valid
    // concurrency default.
    if (key === "threads" && !current.success) merged.maxConcurrentPerBot = DEFAULT_MAX_CONCURRENT_BOT_THREADS;
    Object.assign(merged, section);
    // null is the patch's explicit "remove this key" marker (the threads
    // event-log knobs and newBots.effort use it); a key the patch omits
    // keeps its value.
    for (const [sectionKey, sectionValue] of Object.entries(section as Record<string, unknown>)) {
      if (sectionValue === null) delete merged[sectionKey];
    }
    disk[key] = merged;
  }
  if (checkedPatch.vps !== undefined) disk.vps = normalizeVpsConfig(checkedPatch.vps);
  // scalar, not a section: the merge loop above only walks objects
  if (checkedPatch.language !== undefined) disk.language = checkedPatch.language;
  if (checkedPatch.customDomain !== undefined) disk.customDomain = checkedPatch.customDomain;
  if (checkedPatch.signIn !== undefined) disk.signIn = checkedPatch.signIn;
  // Replace the section so clearing a backup cannot revive the old selection.
  if (checkedPatch.automaticRecovery !== undefined) disk.automaticRecovery = checkedPatch.automaticRecovery;
  // A selection is replaced as one value, so changing engines also clears
  // an effort level omitted from the new selection.
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
  // Replace the complete template so clearing a field, file or routine
  // cannot revive an old value through the general section merge above.
  if (checkedPatch.newBotDefaults !== undefined) {
    disk.newBotDefaults = checkedPatch.newBotDefaults;
    if (checkedPatch.newBotDefaults.profile.modelSelection) {
      disk.defaultModelSelection = checkedPatch.newBotDefaults.profile.modelSelection;
    } else {
      delete disk.defaultModelSelection;
    }
  }
  if (checkedPatch.cliStartup !== undefined) disk.cliStartup = checkedPatch.cliStartup;
  // Custom MCP mutations go through their own dedicated local API, but
  // saveConfig remains the single atomic persistence boundary.
  if (checkedPatch.mcpServers !== undefined) {
    disk.mcpServers = jsonObjectSchema.parse(checkedPatch.mcpServers);
  }
  // the whole list is the unit of change: an add or a delete arrives as the
  // new list, never as a per-item merge
  if (checkedPatch.browserProfiles !== undefined) {
    // `partitionId` is read-only migration metadata. A rename/list replace
    // from the renderer omits it, so carry it forward only for an unchanged
    // canonical id. A genuinely new id always gets its own fresh partition.
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
      // Replacement clears omitted known settings, but retained shadow
      // entries keep fields understood only by a newer app or driver.
      if (options.replaceInstances) {
        for (const key of Object.keys(instanceConfigSchema.shape)) delete merged[key];
      }
      Object.assign(merged, entry);
      diskInstances[instanceId] = merged;
    }
    disk.instances = diskInstances;
  }
  // Settings edits the workspace connection. Older fleet saves could freeze
  // its inherited URL in the default instance, sending a replacement key to
  // the previous endpoint. An explicit URL save reconnects that shared-key
  // instance; custom connections and explicit instance patches stay intact.
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
      // Preserve raw extension fields elsewhere in this saved instance.
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

/** Claude Code variables that choose where a turn goes and how it signs in.
 * An instance that sets any of them (a router, a gateway, a cloud platform)
 * owns that routing and credential pair outright. */
const CLAUDE_ROUTING_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** Whether a Claude instance brings its own endpoint or credential. The
 * workspace Anthropic key must never reach it: the key would be sent as
 * x-api-key to that instance's host (a third-party router), or would
 * silently re-route its turns to the workspace URL. */
export function claudeInstanceOwnsRouting(environment: Record<string, string> | undefined): boolean {
  return CLAUDE_ROUTING_ENV.some((key) => typeof environment?.[key] === "string" && environment[key] !== "");
}

const sameUrl = (a: string, b: string) => a.trim().replace(/\/+$/u, "") === b.trim().replace(/\/+$/u, "");

/** Whether an instance brings its own endpoint or credential, so the
 * workspace key for its driver must never reach it: that key would be sent
 * to the instance's own host (a third-party router or proxy). The same rule
 * as a Claude router instance, for the API-key engines. An instance on the
 * workspace's own endpoint with nothing of its own still gets the key. */
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
    case "grok":
      return own(entry.environment?.XAI_API_KEY) || (own(config.apiKeyEnv) && config.apiKeyEnv !== "XAI_API_KEY")
        || ownUrl("https://api.x.ai/v1", cfg.xai?.url);
    default:
      return false;
  }
}

/** The credential env instanceConfigs() injects for one driver at runtime.
 * Each secret goes only to the driver that actually reads it: the API-key
 * Grok driver reads XAI_API_KEY, the Computer driver reads BOX_TOKEN, and
 * OpenCode reads OPENCODE_API_KEY. Every other engine brings its own
 * login, so handing it a key it never uses would only put that key in the
 * environment of an unrelated child process. */
function injectedEnvironment(cfg: AppConfig, instanceId: string, driver: string): Map<string, string> {
  const environment = new Map<string, string>();
  if (driver === "mistral" && cfg.mistral?.key) environment.set("MISTRAL_API_KEY", cfg.mistral.key);
  if (driver === "cerebras" && cfg.cerebras?.key) environment.set("CEREBRAS_API_KEY", cfg.cerebras.key);
  if (driver === "grok" && cfg.xai?.key) environment.set("XAI_API_KEY", cfg.xai.key);
  // The workspace Anthropic key reaches Claude Code as the variable it
  // reads, carried in the instance environment so the driver can tell a
  // deliberate workspace key from one riding along in the parent's env.
  // By default it runs only the `claudeApi` instance, so signed-in Claude
  // bots stay on their plan; `everyClaudeBot` (the pre-split behaviour, and
  // what a hosted workspace seeded with only a key relies on) runs every
  // other Claude instance on it too.
  const anthropicHere = driver === "claudeAgent" && Boolean(cfg.anthropic?.key)
    && (cfg.anthropic?.everyClaudeBot === false ? instanceId === CLAUDE_API_INSTANCE : instanceId !== CLAUDE_API_INSTANCE);
  if (anthropicHere) environment.set("ANTHROPIC_API_KEY", cfg.anthropic!.key!);
  if (anthropicHere && cfg.anthropic!.url) environment.set("ANTHROPIC_BASE_URL", cfg.anthropic!.url);
  // OpenAI and OpenRouter have their own instances and keys; the workspace
  // OpenAI-compatible key and URL belong to every other openai-compat
  // instance ("Other" in Settings).
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
  // driverKind "boxAgent" and env BOX_TOKEN keep their historical names.
  // Only the person's own token: without one the driver itself falls back
  // to Cloud Pro's included token, which never enters an environment map.
  if (driver === "boxAgent" && cfg.box?.token) environment.set("BOX_TOKEN", cfg.box.token);
  if (driver === "opencodeGo") {
    // Keys for OpenCode's other providers, under the names OpenCode reads.
    for (const [name, key] of Object.entries(openCodeProviderKeys(cfg))) environment.set(name, key);
    if (cfg.opencodeGo?.apiKey) environment.set("OPENCODE_API_KEY", cfg.opencodeGo.apiKey);
  }
  return environment;
}

/** One instance per pasted provider key, each running only on its own key.
 * They sit in the picker's "API keys" group and stay hidden until their key
 * is saved (unavailable without one). */
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
    chatgpt: { driver: "codex", displayName: "ChatGPT plan", config: { authMode: "chatgpt-plan" } },
    antigravity: { driver: "antigravityAgent" },
    opencodeGo: { driver: "opencodeGo" },
    computer: { driver: "boxAgent" },
    openaiCompat: { driver: "openai-compat" },
    mistral: { driver: "mistral" },
    cerebras: { driver: "cerebras" },
    ...API_KEY_FLEET,
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
    pi: { driver: "piAgent" },
    omp: { driver: "ompAgent" },
  };
  const CUSTOM_ONLY = {
    qwen: { driver: "qwenAgent" },
    hermes: { driver: "hermesAgent" },
    pi: { driver: "piAgent" },
    omp: { driver: "ompAgent" },
  } as const;
  // New default-fleet engines that existing product configs would otherwise
  // never see. Custom-only engines stay in CUSTOM_ONLY so a one-off test map
  // is not expanded, matching the claude/grok/codex product-fleet probe.
  const PRODUCT_FLEET_ADDITIONS = {
    chatgpt: { driver: "codex", displayName: "ChatGPT plan", config: { authMode: "chatgpt-plan" } },
    cursor: { driver: "cursorAgent" },
    openaiCompat: { driver: "openai-compat" },
    mistral: { driver: "mistral" },
    cerebras: { driver: "cerebras" },
    ...API_KEY_FLEET,
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
  // A saved `instances` map (any engine edit persists the whole fleet) keeps
  // these entries without their built-in routing. Re-apply it on every load
  // so the OpenAI and OpenRouter instances can never fall back to the shared
  // OpenAI-compatible key and URL; saved fields still win.
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
    // instanceConfigs() builds a transient runtime map. Never mutate the
    // caller's persisted entries while injecting workspace defaults: doing so
    // would turn the first workspace URL into a stale per-instance override.
    const entry = { ...sourceEntry };
    map[id] = entry;
    const environment = { ...entry.environment };
    // Main's rule: an instance that brought its own key or host gets no
    // workspace credential. Built-in per-provider routing is a default,
    // not an override, but saved custom routing on those IDs still owns its
    // credential rather than receiving the workspace's provider key.
    const builtIn = API_KEY_FLEET[id];
    const routingDefaults = builtIn?.driver === entry.driver
      ? builtIn.config as { url?: string; apiKeyEnv?: string } | undefined
      : undefined;
    const ownsRouting = instanceOwnsRouting(cfg, entry, routingDefaults);
    if (!ownsRouting) {
      for (const [key, value] of injectedEnvironment(cfg, id, entry.driver)) environment[key] = value;
    }
    entry.environment = environment;
    // The driver URL is configuration, not a credential. Environment is
    // intentionally not consulted by ProviderRegistry when it decodes a
    // driver's config, so carry the workspace default into the transient
    // instance map while preserving a per-instance override.
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

// ── user-configured MCP servers ─────────────────────────────────────────
// config.json: { "mcpServers": { "notes": { "command": "npx", "args":
// ["-y", "@x/notes-mcp"], "env": { "NOTES_TOKEN": "…" } },
//                                "docs": { "type": "http", "url": "https://…/mcp",
// "headers": { "Authorization": "Bearer …" } } } }
// Validate-with-skip so one bad entry never takes the fleet down, and each
// skip is logged once with a sentence that teaches.

export type CustomMcpServer = McpServerSpec;

const reportedMcpSkips = new Set<string>();
function skipMcpEntry(name: string, why: string): void {
  const key = `${name}: ${why}`;
  if (reportedMcpSkips.has(key)) return;
  reportedMcpSkips.add(key);
  console.error(`mcpServers.${JSON.stringify(name)} skipped — ${why}`);
}

/** The validated, normalized custom servers from config — or {}. */
export function customMcpServers(cfg: AppConfig, only?: string[]): Record<string, CustomMcpServer> {
  const out: Record<string, CustomMcpServer> = {};
  for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
    // a bot with its own list gets exactly those names; a bot without one
    // keeps getting every enabled server, as before this field existed
    if (only && !only.includes(name)) continue;
    const parsed = parseStoredMcpServer(name, raw);
    if (!parsed.ok) {
      skipMcpEntry(name, `${parsed.error} Expected { "command": "npx", "args": [...], "env": { ... } } or { "type": "http", "url": "https://…", "headers": { ... } }`);
      continue;
    }
    if (!parsed.server.enabled) continue;
    out[name] = isRemoteMcpServer(parsed.server)
      ? { type: parsed.server.type, url: parsed.server.url, headers: parsed.server.headers }
      : { command: parsed.server.command, args: parsed.server.args, env: parsed.server.env };
  }
  return out;
}
