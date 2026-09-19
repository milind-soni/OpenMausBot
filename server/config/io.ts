// Data dirs and the config.json lifecycle: boot migration, env-over-file
// load, and the section-merging atomic save. The OMB_DATA_DIR/homedir
// constants evaluate exactly once here at import time, before any function
// in the family runs; the barrel re-exports them unchanged.
import { readFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { parseJson, type JsonObject, type JsonValue } from "../schema.ts";
import { normalizeVpsConfig } from "./accessors.ts";
import { browserProfileReplacementConflict, migrateStoredBrowserProfiles } from "./profiles.ts";
import {
  appConfigSchema,
  instanceConfigSchema,
  jsonObjectSchema,
  legacyBrowserProfilesSchema,
  parseStoredConfig,
  storedBrowserProfilesSchema,
  type AppConfig,
  type BrowserProfile,
} from "./schema.ts";

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

export function loadConfig(): AppConfig {
  let cfg: AppConfig = {};
  const stored = readStoredConfigJson();
  if (stored !== undefined) {
    try {
      cfg = parseStoredConfig(stored);
    } catch {
      /* a parseable file of the wrong shape keeps its schema-lenient read:
         only unreadable or unparseable files are fatal */
    }
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
  // Deliberately not ANTHROPIC_API_KEY: a key in the server's own env is
  // never the workspace key, so an operator's stray variable cannot flip
  // every Claude bot onto pay-as-you-go billing.
  cfg.anthropic = { ...cfg.anthropic };
  if (process.env.OMB_ANTHROPIC_API_KEY !== undefined) cfg.anthropic.key = process.env.OMB_ANTHROPIC_API_KEY;
  if (process.env.OMB_ANTHROPIC_API_URL !== undefined) cfg.anthropic.url = process.env.OMB_ANTHROPIC_API_URL;
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
  if (process.env.OMB_FISH_AUDIO_API_KEY !== undefined) cfg.tts.fishKey = process.env.OMB_FISH_AUDIO_API_KEY;
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

/** config.json's parsed contents, or undefined when the file does not yet
 * exist (first run). A file that exists but cannot be read (EACCES, EISDIR)
 * or does not parse as JSON is a broken install, not a fresh one: silently
 * booting into defaults would mask it, and a save that ignored it would
 * clobber the operator's real config. Both loadConfig and saveConfig fail
 * loudly here instead. */
function readStoredConfigJson(): JsonValue | undefined {
  const p = join(DATA_DIR, "config.json");
  const unreadable = (cause: unknown): Error =>
    new Error(`${p} exists but could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unreadable(error);
  }
  try {
    return parseJson(raw);
  } catch (error) {
    throw unreadable(error);
  }
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

/** Merge a partial config into ~/.openmausbot/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
export function saveConfig(patch: Partial<AppConfig>, options: { replaceInstances?: boolean } = {}): void {
  const p = join(DATA_DIR, "config.json");
  let disk: JsonObject = {};
  const stored = readStoredConfigJson();
  if (stored !== undefined) {
    const parsed = jsonObjectSchema.safeParse(stored);
    if (parsed.success) disk = parsed.data;
  }
  const checkedPatch = appConfigSchema.partial().parse(patch);
  // A write is the durable migration point. Preserve every other raw key in
  // config.json, but never write #567's mixed-case or duplicate profile ids
  // back after we have successfully recognized the legacy list.
  const storedProfiles = storedBrowserProfilesSchema.safeParse(disk.browserProfiles);
  if (storedProfiles.success) disk.browserProfiles = storedProfiles.data;
  for (const key of ["xai", "anthropic", "openaiCompat", "composio", "box", "opencodeGo", "tts", "imageGen", "profile", "rooms", "threads", "localVm", "features", "budgets", "billing", "onboarding", "browserEngine"] as const) {
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
  if (checkedPatch.customDomain !== undefined) disk.customDomain = checkedPatch.customDomain;
  if (checkedPatch.signIn !== undefined) disk.signIn = checkedPatch.signIn;
  // A selection is replaced as one value, so changing engines also clears
  // an effort level omitted from the new selection.
  if (checkedPatch.defaultModelSelection !== undefined) {
    disk.defaultModelSelection = checkedPatch.defaultModelSelection;
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
}
