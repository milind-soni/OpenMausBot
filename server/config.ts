// Config + data dirs. One file, ~/.openmausbot/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"apiKey":"ak_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
import { readFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { parseStoredMcpServer } from "./mcp-registry.ts";
import { parseJson, schemaIssue, type JsonObject, type JsonValue } from "./schema.ts";

const optionalText = z.string().optional();
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LEGACY_BROWSER_PROFILE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const BROWSER_PROFILE_ID = /^[a-z0-9_-]{1,40}$/;

export const DEFAULT_ROOM_TURN_TIMEOUT_MINUTES = 5;
export const MIN_ROOM_TURN_TIMEOUT_MINUTES = 1;
export const MAX_ROOM_TURN_TIMEOUT_MINUTES = 1_440;
export const DEFAULT_LOCAL_VM_MODE = "shared" as const;
export const DEFAULT_LOCAL_VM_MAX_INSTANCES = 2;
export const MIN_LOCAL_VM_MAX_INSTANCES = 1;
export const MAX_LOCAL_VM_MAX_INSTANCES = 4;

export function isValidSshAlias(value: unknown): value is string {
  return typeof value === "string" && SSH_ALIAS.test(value);
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
const roomConfigSchema = z.object({
  turnTimeoutMinutes: z
    .number()
    .int()
    .min(MIN_ROOM_TURN_TIMEOUT_MINUTES)
    .max(MAX_ROOM_TURN_TIMEOUT_MINUTES),
});
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
const featureConfigSchema = z.object({
  /** Experimental desktop workflow recorder. Hidden unless explicitly enabled. */
  skillRecorder: z.boolean().optional(),
  /** Show each tool run in the transcript. Off unless explicitly enabled. */
  showToolCalls: z.boolean().optional(),
  /** Experimental built-in browser. Off until explicitly enabled; each bot
   * also has its own switch. */
  browser: z.boolean().optional(),
  /** The Spaces canvas: every bot as a card on one zoomable surface. */
  spaces: z.boolean().optional(),
});
const instanceConfigSchema = z.object({
  driver: z.string().min(1),
  displayName: optionalText,
  accentColor: optionalText,
  environment: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  config: z.json().optional(),
});
const instanceConfigMapSchema = z.record(z.string(), instanceConfigSchema);
const appConfigSchema = z.object({
  xai: z.object({ key: optionalText, url: optionalText }).optional(),
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
  /** Voice credentials and the selected voice id. `provider` picks the
   * engine: "elevenlabs" (default; needs a key) or "system" (the Mac's
   * built-in voices, no key). */
  tts: z.object({ key: optionalText, voice: optionalText, provider: z.enum(["elevenlabs", "system"]).optional() }).optional(),
  /** OpenAI key used only by the in-process avatar image generator. */
  imageGen: z.object({ key: optionalText }).optional(),
  /** Non-secret profile details shown in the sidebar. */
  profile: z.object({ name: optionalText, email: optionalText }).optional(),
  /** UI language override (BCP-47, lowercase). Empty/absent = follow the
   * system language. Unknown tags degrade to English in the renderer. */
  language: optionalText,
  rooms: roomConfigSchema.optional(),
  localVm: localVmConfigSchema.optional(),
  features: featureConfigSchema.optional(),
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
});
const appConfigPatchSchema = appConfigSchema.omit({ instances: true, mcpServers: true });
const jsonObjectSchema = z.record(z.string(), z.json());

export interface AppConfig {
  mcpServers?: Record<string, unknown>;
  language?: string;
  xai?: { key?: string; url?: string };
  openaiCompat?: { key?: string; url?: string; model?: string; provider?: string };
  composio?: { apiKey?: string; userId?: string; sessionId?: string };
  box?: { token?: string };
  /** A named host from the user's SSH config. Authentication stays with SSH. */
  vps?: { sshAlias?: string };
  opencodeGo?: { apiKey?: string };
  tts?: { key?: string; voice?: string; provider?: "elevenlabs" | "system" };
  imageGen?: { key?: string };
  profile?: { name?: string; email?: string };
  rooms?: { turnTimeoutMinutes: number };
  /** Shared preserves the historical singleton. Per-bot gives every bot a
   * separate container, durable workspace, viewer and lease. */
  localVm?: { mode?: "shared" | "per-bot"; maxInstances?: number };
  /** Opt-in product experiments. Every flag defaults to disabled. */
  features?: { skillRecorder?: boolean; showToolCalls?: boolean; browser?: boolean; spaces?: boolean };
  /** Named browser sessions any bot can be pointed at. */
  browserProfiles?: BrowserProfile[];
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

export function roomTurnTimeoutMinutes(cfg: AppConfig): number {
  return cfg.rooms?.turnTimeoutMinutes ?? DEFAULT_ROOM_TURN_TIMEOUT_MINUTES;
}

export function localVmMode(cfg: AppConfig): "shared" | "per-bot" {
  return cfg.localVm?.mode ?? DEFAULT_LOCAL_VM_MODE;
}

export function localVmMaxInstances(cfg: AppConfig): number {
  return cfg.localVm?.maxInstances ?? DEFAULT_LOCAL_VM_MAX_INSTANCES;
}

export function skillRecorderEnabled(cfg: AppConfig): boolean {
  return cfg.features?.skillRecorder === true;
}

export function showToolCallsEnabled(cfg: AppConfig): boolean {
  return cfg.features?.showToolCalls === true;
}

/** Workspace-level gate for the experimental built-in browser. A bot's own
 * switch sits under it, so either can withhold the browser. */
export function builtInBrowserEnabled(cfg: AppConfig): boolean {
  return cfg.features?.browser === true;
}

/** Workspace-level gate for the Spaces canvas. */
export function spacesEnabled(cfg: AppConfig): boolean {
  return cfg.features?.spaces === true;
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
}

export function loadConfig(): AppConfig {
  let cfg: AppConfig = {};
  try {
    cfg = parseStoredConfig(parseJson(readFileSync(join(DATA_DIR, "config.json"), "utf8")));
  } catch {
    /* first run — env fallbacks below */
  }
  // Env wins over the file for every credential. The desktop shell keeps
  // these secrets OS-encrypted and hands them to this process as env at
  // spawn, leaving config.json without the plaintext field — so the file
  // value is the dev-mode (no desktop shell) fallback, not the primary.
  // Anything that saves a credential mid-session must keep process.env in
  // step (syncCredentialEnv below), or the value injected at boot would
  // shadow the save until the next launch.
  cfg.xai = { ...cfg.xai };
  if (process.env.XAI_API_KEY !== undefined) cfg.xai.key = process.env.XAI_API_KEY;
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
  cfg.imageGen = { ...cfg.imageGen };
  if (process.env.OMB_OPENAI_IMAGE_KEY !== undefined) cfg.imageGen.key = process.env.OMB_OPENAI_IMAGE_KEY;
  return cfg;
}

/** After saveConfig() writes a credential, the running process's env must
 * follow the newest value — loadConfig() prefers env, so the secret injected
 * at boot would otherwise shadow the save until relaunch: the UI would show
 * "saved" while every turn still used the old key. An empty string means the
 * user cleared the credential, so the var is dropped and the (now empty)
 * file value is authoritative again. Fields absent from the patch are
 * untouched. */
export function syncCredentialEnv(patch: Partial<AppConfig>): void {
  const secrets: Array<[value: string | undefined, name: string]> = [
    [patch.xai?.key, "XAI_API_KEY"],
    [patch.openaiCompat?.key, "OPENAI_COMPAT_API_KEY"],
    [patch.composio?.apiKey, "COMPOSIO_API_KEY"],
    [patch.box?.token, "BOX_TOKEN"],
    [patch.opencodeGo?.apiKey, "OPENCODE_API_KEY"],
    [patch.tts?.key, "OMB_TTS_KEY"],
    [patch.imageGen?.key, "OMB_OPENAI_IMAGE_KEY"],
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
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_URL",
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "OMB_TTS_KEY",
  "OMB_OPENAI_IMAGE_KEY",
  "COMPOSIO_API_KEY",
  "OMB_COMPOSIO_BROKER_TOKEN",
  // Harness-private filesystem hints are not credentials themselves, but
  // exposing them to a shell-capable agent points straight at app-owned
  // state. The built-in browser master is delivered privately in memory.
  "OMB_BROWSER_CONNECTION",
  "OMB_USER_DATA",
] as const;

/** Drop every workspace credential from a child-process env (in place). */
export function stripWorkspaceCredentialEnv(env: Record<string, string | undefined>): void {
  for (const key of WORKSPACE_CREDENTIAL_ENV) delete env[key];
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
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
] as const;

/** Merge a partial config into ~/.openmausbot/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
export function saveConfig(patch: Partial<AppConfig>): void {
  const p = join(DATA_DIR, "config.json");
  let disk: JsonObject = {};
  try {
    const parsed = jsonObjectSchema.safeParse(parseJson(readFileSync(p, "utf8")));
    if (parsed.success) disk = parsed.data;
  } catch {
    /* first write */
  }
  const checkedPatch = appConfigSchema.partial().parse(patch);
  // A write is the durable migration point. Preserve every other raw key in
  // config.json, but never write #567's mixed-case or duplicate profile ids
  // back after we have successfully recognized the legacy list.
  const storedProfiles = storedBrowserProfilesSchema.safeParse(disk.browserProfiles);
  if (storedProfiles.success) disk.browserProfiles = storedProfiles.data;
  for (const key of ["xai", "openaiCompat", "composio", "box", "opencodeGo", "tts", "imageGen", "profile", "rooms", "localVm", "features"] as const) {
    const section = checkedPatch[key];
    if (!section) continue;
    const current = jsonObjectSchema.safeParse(disk[key]);
    const merged: JsonObject = current.success ? { ...current.data } : {};
    Object.assign(merged, section);
    disk[key] = merged;
  }
  if (checkedPatch.vps !== undefined) disk.vps = normalizeVpsConfig(checkedPatch.vps);
  // scalar, not a section: the merge loop above only walks objects
  if (checkedPatch.language !== undefined) disk.language = checkedPatch.language;
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
  }
  if (checkedPatch.instances) {
    const currentInstances = jsonObjectSchema.safeParse(disk.instances);
    const diskInstances: JsonObject = currentInstances.success ? currentInstances.data : {};
    for (const [instanceId, entry] of Object.entries(checkedPatch.instances)) {
      const current = jsonObjectSchema.safeParse(diskInstances[instanceId]);
      const merged: JsonObject = current.success ? { ...current.data } : {};
      Object.assign(merged, entry);
      diskInstances[instanceId] = merged;
    }
    disk.instances = diskInstances;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(p, JSON.stringify(disk, null, 2), { mode: 0o600 });
}

/** Set one instance's `config.cli` ("" clears the override back to the
 * driver default). Creating the instance entry is fine — a config-less
 * entry rides driver.defaultConfig(). Returns false for unknown instances
 * when the fleet is explicitly configured. The returned map must stay
 * PERSISTABLE: instanceConfigs() injects credential env into consuming
 * drivers' entries for the live fleet, so those injected keys are stripped
 * back out before the map is returned — otherwise saving an override would
 * copy xai/box/opencodeGo secrets into the instances section of
 * config.json. */
export function withInstanceCli(
  cfg: AppConfig,
  instanceId: string,
  cli: string,
): InstanceCliUpdate {
  const next: AppConfig = structuredClone(cfg);
  const map = instanceConfigs(next);
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
  for (const e of Object.values(map)) {
    if (!e.environment) continue;
    const injected = injectedEnvironment(next, e.driver);
    for (const [k, v] of Object.entries(e.environment)) {
      if (injected.get(k) === v) delete e.environment[k];
    }
    if (!Object.keys(e.environment).length) delete e.environment;
  }
  next.instances = map;
  return { ok: true, config: next };
}

interface InstanceCliUpdate {
  ok: boolean;
  config: AppConfig;
}

/** The credential env instanceConfigs() injects for one driver — shared with
 * withInstanceCli() so the inject rule and the strip rule cannot drift apart.
 * Each secret goes only to the driver that actually reads it: the API-key
 * Grok driver reads XAI_API_KEY, the Computer driver reads BOX_TOKEN, and
 * OpenCode reads OPENCODE_API_KEY. Every other engine brings its own
 * login, so handing it a key it never uses would only put that key in the
 * environment of an unrelated child process. */
function injectedEnvironment(cfg: AppConfig, driver: string): Map<string, string> {
  const environment = new Map<string, string>();
  if (driver === "grok" && cfg.xai?.key) environment.set("XAI_API_KEY", cfg.xai.key);
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
// ["-y", "@x/notes-mcp"], "env": { "NOTES_TOKEN": "…" } } } }
// stdio only for now; validate-with-skip so one bad entry never takes the
// fleet down, and each skip is logged once with a sentence that teaches.

export interface CustomMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const reportedMcpSkips = new Set<string>();
function skipMcpEntry(name: string, why: string): void {
  const key = `${name}: ${why}`;
  if (reportedMcpSkips.has(key)) return;
  reportedMcpSkips.add(key);
  console.error(`mcpServers.${JSON.stringify(name)} skipped — ${why}`);
}

/** The validated, normalized custom servers from config — or {}. */
export function customMcpServers(cfg: AppConfig): Record<string, CustomMcpServer> {
  const out: Record<string, CustomMcpServer> = {};
  for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
    if (raw && typeof raw === "object" && "url" in raw) {
      skipMcpEntry(name, 'only stdio servers ("command") are supported so far — HTTP transports are a planned follow-up');
      continue;
    }
    const parsed = parseStoredMcpServer(name, raw);
    if (!parsed.ok) {
      skipMcpEntry(name, `${parsed.error} Expected { "command": "npx", "args": [...], "env": { ... } }`);
      continue;
    }
    if (!parsed.server.enabled) continue;
    out[name] = {
      command: parsed.server.command,
      args: parsed.server.args,
      env: parsed.server.env,
    };
  }
  return out;
}
