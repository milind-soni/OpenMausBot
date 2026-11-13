import { z } from "zod";

import { credentialIsConfigured, CREDENTIAL_TARGETS, PROVIDER_CREDENTIAL_TARGETS, type CredentialConfig, type CredentialTargetId } from "../../shared/credential-request.ts";
import { WINDOW_PREFS, type WindowPrefId } from "../../shared/app-settings.ts";
import { defaultBotThreads, MAX_CONCURRENT_BOT_THREADS } from "../bot-thread-limits.ts";
import { isClaudeBedrock } from "../claude-bedrock.ts";
import { isClaudeEndpoint } from "../claude-endpoints.ts";
import { isCodexEndpoint } from "../codex-endpoints.ts";
import { MAX_MCP_CALL_TIMEOUT_MINUTES, MAX_ROOM_TURN_TIMEOUT_MINUTES, mcpCallTimeoutMinutes, MIN_MCP_CALL_TIMEOUT_MINUTES, MIN_ROOM_TURN_TIMEOUT_MINUTES, persistableInstanceConfigs, roomTurnTimeoutMinutes, type AppConfig } from "../config.ts";
import type { InstanceConfig } from "../contracts.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { endpointDisplayUrl, isAddedEndpoint } from "../openai-compat-endpoints.ts";
import type { RequestAuth } from "../request-auth.ts";
import { callRoute, type RouteReply } from "../routes/call-route.ts";
import { engineChosen } from "../routes/instances.ts";
import type { RouteHandler } from "../routes/table.ts";
import type { BotRecord, Store } from "../store.ts";
import { botEntries } from "./registry-bots.ts";
import { configEntries } from "./registry-config.ts";
import { windowEntries } from "./registry-window.ts";

/** Where the person changes it by hand, as the bot tells them. */
export type Where = "Settings → Overview" | "Settings → Appearance" | "Settings → General" | "Settings → AI" | "Settings → AI → API keys" | "Settings → You and your bots"
  | "Settings → Phone & devices" | "Settings → Vault" | "Settings → Data" | "Settings → Your account" | "Settings → Desktops & browser" | "the sidebar" | "a bot's Settings";

interface Base {
  id: string;
  label: string;
  help: string;
  where: Where;
  synonyms: string[];
  /** What a person or bot sees. Never a secret: a key reads as set or not set. */
  read(): string;
}
/** `value` checks what the bot sends at the boundary; `current` is the typed value as `write` takes it, kept for Undo.
 * `describe` is for a change that does not read as before → after: the one line its card shows, or why it can't happen
 * now, before any card. */
interface Writable {
  tier: "safe" | "confirm";
  value: z.ZodType;
  allowed: string;
  current(): unknown;
  write(value: unknown): Promise<string | null>;
  describe?(value: unknown): { change: string } | { refusal: string };
}
interface Secret {
  tier: "secret";
  credentialId: CredentialTargetId;
}
interface OwnerOnly {
  tier: "owner-only";
}
export type SettingEntry = Base & (Writable | Secret | OwnerOnly);
export type WritableEntry = Base & Writable;

export type AppRoute = "customDomain" | "starterAwake" | "skills";
export interface RegistryDeps {
  cfg(): AppConfig;
  /** PUT /api/config as Settings does; a refusal comes back as its text. */
  saveConfig(patch: Record<string, unknown>): Promise<string | null>;
  bots(): BotRecord[];
  sections(): string[];
  reorderBots(botIds: string[]): Promise<string | null>;
  /** Moves bots into a sidebar group, making it when new; an empty name ungroups them. */
  groupBots(name: string, botIds: string[]): Promise<string | null>;
  pinBot(botId: string, pinned: boolean): Promise<string | null>;
  /** PATCH /api/bots/:id as the bot's Settings panel does; a refusal comes back as its text. */
  patchBot(botId: string, body: Record<string, unknown>): Promise<string | null>;
  /** Another of the Settings window's routes, called as the window calls it. */
  call(route: AppRoute, method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>): Promise<string | null>;
  credentials(): CredentialConfig;
  window: { read(id: WindowPrefId): unknown; write(id: WindowPrefId, value: unknown): string | null };
  /** The engines Settings → AI lists; never a key. */
  engines(): Array<{ instanceId: string; name: string; working: boolean }>;
  engineChosen(instanceId: string): boolean;
  /** POST /api/instances/<path> and DELETE /api/instances/<id>, as Settings does; a refusal comes back as its text. */
  addEngine(path: "openai-compat" | "claude-bedrock", body: Record<string, unknown>): Promise<string | null>;
  removeEngine(instanceId: string): Promise<string | null>;
}

/** A setting's value for a person or bot; empty when unset, so each edge can say "not set" in its own words. */
export const display = (value: unknown): string => (value === undefined || value === null || value === "" ? "" : typeof value === "string" ? value : JSON.stringify(value));
const url = z.string().trim().max(2048).refine((text) => text === "" || /^https?:\/\/\S+$/.test(text), "an http(s) address, or empty to clear");

const KEY_WHERE: Partial<Record<CredentialTargetId, Where>> = {
  ttsKey: "Settings → General", geminiTtsKey: "Settings → General", fishAudioKey: "Settings → General",
  onePasswordToken: "Settings → Vault", boxToken: "Settings → Desktops & browser", composioApiKey: "Settings → AI",
};

export type WritableSpec = Omit<Base, "read"> & Omit<Writable, "write" | "describe"> & { read?(): string; write(value: never): Promise<string | null>; describe?(value: never): { change: string } | { refusal: string } };
export type WindowPref = (id: WindowPrefId, label: string, help: string, where: Where, synonyms: string[], allowed: string,
  confirm?: { says(value: never): string; value?: z.ZodType }) => SettingEntry;

/** Security: a key never passes through the bot. A value naming a key, token, secret or password field is refused at
 * the boundary; `except` lets through a field that only names a saved key. */
export const withoutKeys = <T extends z.ZodType>(schema: T, except: readonly string[] = []) => z.record(z.string(), z.unknown())
  .refine((fields) => !Object.keys(fields).some((field) => !except.includes(field) && /key|token|secret|password/i.test(field)),
    "Never put a key or token in the value. Save it first with set on keys.<id> (a secure card asks the user), then name that id in keyFrom.")
  // The record check above already holds an object; the schema decides its shape.
  .pipe(schema as unknown as z.ZodType<z.output<T>, Record<string, unknown>>);

const PROVIDER_KEY_SECTION = {
  openaiApiKey: "openai", anthropicApiKey: "anthropic", openrouterApiKey: "openrouter", mistralApiKey: "mistral", cerebrasApiKey: "cerebras",
  groqApiKey: "groq", greenferenceApiKey: "greenference", modelgoApiKey: "modelgo", metaApiKey: "meta", deepseekApiKey: "deepseek",
} as const satisfies Record<(typeof PROVIDER_CREDENTIAL_TARGETS)[number], keyof CredentialConfig>;
type ProviderKeyId = keyof typeof PROVIDER_KEY_SECTION;
/** A local server takes no key; Settings sends the same stand-in for one. */
const LOCAL_SERVER = { ollama: { name: "Ollama", key: "ollama" }, lmstudio: { name: "LM Studio", key: "lm-studio" } } as const;

const engineName = z.string().trim().min(1).max(80);
const engineUrl = z.string().trim().min(1).max(512);
/** Security: a key never passes through the bot. An engine that needs one names a key the person saved through the
 * secure card (`keyFrom`), and the server reads it at the moment the owner taps Change. */
const engineChange = withoutKeys(z.discriminatedUnion("kind", [
    z.object({ kind: z.enum(["ollama", "lmstudio"]), name: engineName.optional(), url: engineUrl }).strict(),
    z.object({ kind: z.literal("openai-compat"), name: engineName, url: engineUrl, keyFrom: z.enum(PROVIDER_CREDENTIAL_TARGETS), models: z.array(z.string().trim().min(1).max(200)).max(64).optional() }).strict(),
    z.object({ kind: z.literal("bedrock"), name: engineName, awsProfile: z.string().trim().min(1).max(128), awsRegion: z.string().trim().min(1).max(40), model: z.string().trim().min(1).max(160) }).strict(),
    z.object({ kind: z.literal("remove"), instanceId: z.string().regex(/^[\w.-]{1,120}$/) }).strict(),
  ]), ["keyFrom"]);
type EngineChange = z.infer<typeof engineChange>;
/** The engines a bot may remove: added without a sign-in. Accounts and the built-in engines stay with the owner. */
const removableKind = (instanceId: string, entry: InstanceConfig | undefined) => isAddedEndpoint(instanceId, entry) ? "OpenAI-compatible server"
  : isClaudeBedrock(entry) ? "Claude on Amazon Bedrock" : isClaudeEndpoint(entry) ? "Claude endpoint" : isCodexEndpoint(entry) ? "Codex endpoint" : null;

export function createSettingsRegistry(deps: RegistryDeps): SettingEntry[] {
  const cfg = deps.cfg;
  const names = (ids: readonly string[]) => ids.map((id) => deps.bots().find((bot) => bot.id === id)?.name ?? id).join(", ");
  const writable = (spec: WritableSpec): SettingEntry => ({ ...spec, read: spec.read ?? (() => display(spec.current())), write: spec.write as Writable["write"] });
  const config = <V,>(patch: (value: V) => Record<string, unknown>) => (value: V) => deps.saveConfig(patch(value));
  /** With `confirm`, a Change/Cancel card says what the new value does, and the window is told only on Change. */
  const windowPref: WindowPref = (id, label, help, where, synonyms, allowed, confirm) => writable({
    id, label, help, where, synonyms, tier: confirm ? "confirm" : "safe", value: confirm?.value ?? WINDOW_PREFS[id], allowed,
    current: () => deps.window.read(id), write: async (value: unknown) => deps.window.write(id, value),
    ...(confirm ? { describe: (value: never) => ({ change: confirm.says(value) }) } : {}),
  });
  const enumOf = (values: readonly string[]) => values.join(", ");
  const pinned = () => deps.bots().filter((bot) => bot.pinned).map((bot) => bot.id);
  const groups = () => Object.fromEntries(deps.sections().map((section) => [section, deps.bots().filter((bot) => bot.section === section).map((bot) => bot.id)]));

  const safe: SettingEntry[] = [
    windowPref("appearance.skin", "Skin", "The window's look; \"system\" follows the computer's light or dark mode.", "Settings → Appearance", ["theme", "dark mode", "light mode", "colors", "look"], enumOf(WINDOW_PREFS["appearance.skin"].options)),
    windowPref("appearance.advanced", "Advanced mode", "Advanced shows every setting and tool; Simple keeps the everyday ones.", "Settings → Appearance", ["simple mode", "advanced mode", "interface mode"], "true or false"),
    windowPref("appearance.font", "Font", "The app's typeface.", "Settings → Appearance", ["typeface", "typography"], enumOf(WINDOW_PREFS["appearance.font"].options)),
    windowPref("appearance.chatWidth", "Chat width", "How wide the chat column is.", "Settings → Appearance", ["layout", "column", "wide"], enumOf(WINDOW_PREFS["appearance.chatWidth"].options)),
    windowPref("general.sendKey", "Send key", "Which key sends a message in the composer.", "Settings → General", ["enter", "typing", "keyboard", "shortcut"], enumOf(WINDOW_PREFS["general.sendKey"].options)),
    windowPref("general.notificationSounds", "Notification sounds", "Play a sound when a bot needs you or finishes.", "Settings → General", ["sound", "sounds", "mute", "alerts", "notifications"], "true or false"),
    writable({
      id: "general.language", label: "Language", help: "The app's language, as a tag such as en, de or pt-br; empty follows the computer.", where: "Settings → General",
      synonyms: ["locale", "translation"], tier: "safe", value: z.string().trim().max(16).regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$|^$/i, "a language tag such as en or pt-br"), allowed: "a language tag such as en, de, ja, pt-br, zh-tw; empty to follow the computer",
      current: () => cfg().language ?? "", write: config((language: string) => ({ language })),
    }),
    writable({
      id: "bots.order", label: "Bot order", help: "The order bots are listed in the sidebar and on phones. Send bot ids from list_bots; bots you leave out keep their places.", where: "the sidebar",
      synonyms: ["reorder", "sidebar order", "sort bots", "move bot", "arrange"], tier: "safe", value: z.array(z.string().regex(/^[\w-]+$/)).min(1).max(100), allowed: "an array of bot ids in the wanted order",
      current: () => deps.bots().map((bot) => bot.id), read: () => names(deps.bots().map((bot) => bot.id)), write: (botIds: string[]) => deps.reorderBots(botIds),
    }),
    writable({
      id: "bots.pinned", label: "Pinned bots", help: "Which bots are pinned to the top of the sidebar. Send every bot id that should be pinned, including ones already pinned; the rest are unpinned.", where: "the sidebar",
      synonyms: ["pin", "pinned", "unpin", "favorite", "favourite", "top", "star"], tier: "safe", value: z.array(z.string().regex(/^[\w-]+$/)).max(100), allowed: "an array of the bot ids to pin; an empty array unpins every bot",
      current: pinned, read: () => names(pinned()),
      write: async (botIds: string[]) => {
        const unknown = botIds.find((id) => !deps.bots().some((bot) => bot.id === id));
        if (unknown) return `No bot has the id ${unknown}. Use list_bots for the ids.`;
        for (const bot of deps.bots()) {
          if (Boolean(bot.pinned) === botIds.includes(bot.id)) continue;
          const refusal = await deps.pinBot(bot.id, botIds.includes(bot.id));
          if (refusal) return refusal;
        }
        return null;
      },
    }),
    writable({
      id: "bots.groups", label: "Sidebar groups", help: "Which bots sit in which sidebar group (department). Send an object of group name to bot ids; a bot in no listed group is ungrouped.", where: "the sidebar",
      synonyms: ["group", "groups", "department", "departments", "section", "sections", "team", "folder"], tier: "safe",
      value: z.record(z.string().trim().min(1).max(60), z.array(z.string().regex(/^[\w-]+$/)).max(100)), allowed: "an object: group name → array of bot ids",
      current: groups,
      read: () => {
        const grouped = Object.entries(groups()).map(([section, ids]) => `${section}: ${names(ids) || "(empty)"}`);
        const loose = deps.bots().filter((bot) => !bot.section).map((bot) => bot.id);
        return [...grouped, ...(loose.length ? [`ungrouped: ${names(loose)}`] : [])].join("; ");
      },
      write: async (wanted: Record<string, string[]>) => {
        const listed = new Set(Object.values(wanted).flat());
        const loosen = deps.bots().filter((bot) => bot.section && !listed.has(bot.id)).map((bot) => bot.id);
        for (const [name, botIds] of Object.entries(wanted)) {
          const refusal = await deps.groupBots(name, botIds);
          if (refusal) return refusal;
        }
        return loosen.length ? deps.groupBots("", loosen) : null;
      },
    }),
    writable({
      id: "threads.maxConcurrentPerBot", label: "Threads per bot", help: "How many conversations one bot may work on at once.", where: "Settings → You and your bots",
      synonyms: ["concurrent", "parallel", "limit", "limits", "thread limit"], tier: "safe", value: z.number().int().min(1).max(MAX_CONCURRENT_BOT_THREADS), allowed: `1 to ${MAX_CONCURRENT_BOT_THREADS}`,
      current: () => cfg().threads?.maxConcurrentPerBot ?? defaultBotThreads(), write: config((maxConcurrentPerBot: number) => ({ threads: { maxConcurrentPerBot } })),
    }),
    writable({
      id: "threads.eventLogRetentionDays", label: "Thread log retention", help: "Days a closed conversation's event logs are kept; null keeps them forever.", where: "Settings → Data",
      synonyms: ["cleanup", "clean up", "retention", "logs", "delete old", "storage"], tier: "safe", value: z.number().int().min(1).max(3650).nullable(), allowed: "1 to 3650 days, or null to keep forever",
      current: () => cfg().threads?.eventLogRetentionDays ?? null, read: () => display(cfg().threads?.eventLogRetentionDays ?? "forever"),
      write: config((eventLogRetentionDays: number | null) => ({ threads: { eventLogRetentionDays } })),
    }),
    writable({
      id: "rooms.turnTimeoutMinutes", label: "Room turn timeout", help: "Minutes a bot's turn in a room may run before it is stopped.", where: "Settings → You and your bots",
      synonyms: ["room", "channel", "timeout", "turn limit"], tier: "safe", value: z.number().int().min(MIN_ROOM_TURN_TIMEOUT_MINUTES).max(MAX_ROOM_TURN_TIMEOUT_MINUTES), allowed: `${MIN_ROOM_TURN_TIMEOUT_MINUTES} to ${MAX_ROOM_TURN_TIMEOUT_MINUTES} minutes`,
      current: () => roomTurnTimeoutMinutes(cfg()), write: config((turnTimeoutMinutes: number) => ({ rooms: { turnTimeoutMinutes } })),
    }),
    writable({
      id: "mcp.callTimeoutMinutes", label: "MCP call timeout", help: "Minutes one MCP tool call may run.", where: "Settings → AI",
      synonyms: ["mcp", "tool timeout", "call timeout"], tier: "safe", value: z.number().int().min(MIN_MCP_CALL_TIMEOUT_MINUTES).max(MAX_MCP_CALL_TIMEOUT_MINUTES), allowed: `${MIN_MCP_CALL_TIMEOUT_MINUTES} to ${MAX_MCP_CALL_TIMEOUT_MINUTES} minutes`,
      current: () => mcpCallTimeoutMinutes(cfg()), write: config((callTimeoutMinutes: number) => ({ mcp: { callTimeoutMinutes } })),
    }),
    writable({
      id: "bots.defaultModel", label: "Default model for new bots", help: "The engine and model a newly created bot starts on; existing bots keep theirs. Ids come from list_models.", where: "Settings → You and your bots",
      synonyms: ["default model", "new bots", "model", "engine"], tier: "safe", value: z.object({ instanceId: z.string().min(1).max(80), model: z.string().min(1).max(200) }), allowed: "{ instanceId, model } from list_models",
      current: () => cfg().defaultModelSelection, read: () => { const selection = cfg().defaultModelSelection; return selection ? `${selection.instanceId} / ${selection.model}` : ""; },
      write: config((defaultModelSelection: { instanceId: string; model: string }) => ({ defaultModelSelection })),
    }),
  ];

  const provider = (id: string, label: string, synonyms: string[], current: () => string | undefined, patch: (text: string) => Record<string, unknown>): SettingEntry => writable({
    id, label, help: `${label}: the address MausBot sends requests to. Empty uses the provider's own.`, where: "Settings → AI", synonyms: [...synonyms, "url", "base url", "endpoint", "address", "proxy"],
    tier: "confirm", value: url, allowed: "an http(s) address, or empty to clear", current: () => current() ?? "", write: config(patch),
  });
  const confirm: SettingEntry[] = [
    provider("providers.anthropic.url", "Anthropic address", ["anthropic", "claude"], () => cfg().anthropic?.url, (text) => ({ anthropic: { ...cfg().anthropic, url: text } })),
    provider("providers.xai.url", "xAI address", ["xai", "grok"], () => cfg().xai?.url, (text) => ({ xai: { ...cfg().xai, url: text } })),
    provider("providers.groq.url", "Groq address", ["groq"], () => cfg().groq?.url, (text) => ({ groq: { ...cfg().groq, url: text } })),
    provider("providers.meta.url", "Meta address", ["meta", "llama"], () => cfg().meta?.url, (text) => ({ meta: { ...cfg().meta, url: text } })),
    provider("providers.openaiCompat.url", "OpenAI-compatible address", ["openai compatible", "custom provider", "ollama", "lm studio", "openrouter"], () => cfg().openaiCompat?.url, (text) => ({ openaiCompat: { ...cfg().openaiCompat, url: text } })),
    writable({
      id: "providers.openaiCompat.model", label: "OpenAI-compatible model", help: "The model name sent to the OpenAI-compatible provider.", where: "Settings → AI",
      synonyms: ["openai compatible", "custom provider", "model name"], tier: "confirm", value: z.string().trim().max(200), allowed: "a model name, or empty to clear",
      current: () => cfg().openaiCompat?.model ?? "", write: config((model: string) => ({ openaiCompat: { ...cfg().openaiCompat, model } })),
    }),
    provider("voice.baseUrl", "Voice server address", ["tts", "voice", "speech", "chatterbox"], () => cfg().tts?.baseUrl, (text) => ({ tts: { ...cfg().tts, baseUrl: text } })),
  ];

  const secret: SettingEntry[] = (Object.keys(CREDENTIAL_TARGETS) as CredentialTargetId[]).map((credentialId) => {
    const target = CREDENTIAL_TARGETS[credentialId];
    return {
      id: `keys.${credentialId}`, label: target.label, help: target.description, synonyms: ["key", "api key", "token", "credential", target.label.split(" ")[0]!.toLowerCase()],
      where: KEY_WHERE[credentialId] ?? ((PROVIDER_CREDENTIAL_TARGETS as readonly string[]).includes(credentialId) ? "Settings → AI → API keys" : "Settings → AI"),
      tier: "secret", credentialId, read: () => (credentialIsConfigured(deps.credentials(), credentialId) ? "set" : ""),
    };
  });

  const instances = () => persistableInstanceConfigs(cfg());
  const savedKey = (id: ProviderKeyId) => deps.credentials()[PROVIDER_KEY_SECTION[id]]?.key;
  const keyMissing = (id: ProviderKeyId) => `Your ${CREDENTIAL_TARGETS[id].label} is not saved yet. Call set on keys.${id} with no value first (a secure card asks the user for it), then add the engine.`;
  const listEngines = () => deps.engines().map(({ instanceId, name, working }) => {
    const entry = instances()[instanceId];
    const url = isAddedEndpoint(instanceId, entry) ? endpointDisplayUrl(entry!.config) : undefined;
    return `${instanceId}: ${name}${url ? ` at ${url}` : ""}${working ? "" : " (not working)"}${removableKind(instanceId, entry) ? "" : " (removed only in Settings)"}`;
  }).join("; ");
  const engines = writable({
    id: "engines", label: "AI engines", help: "The AI engines bots run on. get lists each one's id; set adds or removes one, always on a Change/Cancel card.", where: "Settings → AI",
    synonyms: ["engine", "engines", "ai engine", "add engine", "remove engine", "provider", "providers", "ollama", "lm studio", "lmstudio", "bedrock", "endpoint", "local model"], tier: "confirm",
    value: engineChange,
    allowed: '{"kind":"ollama" or "lmstudio","url"} for a local server; {"kind":"openai-compat","name","url","keyFrom":"<a keys.* id, e.g. openrouterApiKey>","models"?:[...]}; '
      + '{"kind":"bedrock","name","awsProfile","awsRegion","model"}; {"kind":"remove","instanceId"}. Sign-in accounts (Claude, ChatGPT, Antigravity) are added, signed in and removed by the user in Settings → AI',
    current: () => undefined, read: listEngines,
    describe: (change: EngineChange) => {
      if (change.kind === "remove") {
        const entry = instances()[change.instanceId];
        const listed = deps.engines().find((engine) => engine.instanceId === change.instanceId);
        if (!entry && !listed) return { refusal: `No engine has the id ${change.instanceId}. Use get on engines to list them.` };
        const name = listed?.name ?? entry?.displayName ?? change.instanceId;
        const kind = removableKind(change.instanceId, entry);
        if (!kind) return { refusal: `${name} is removed only by the user, in Settings → AI. Tell them where; do not try another way.` };
        if (deps.engineChosen(change.instanceId)) return { refusal: `Bots or the default model for new bots use ${name}. Move them to another model first (a bot's Settings, or bots.defaultModel), then remove it.` };
        const last = deps.engines().filter((engine) => engine.working).every((engine) => engine.instanceId === change.instanceId);
        const url = isAddedEndpoint(change.instanceId, entry) ? endpointDisplayUrl(entry.config) : undefined;
        return { change: `Remove the engine "${name}" (${kind}${url ? `, ${url}` : ""})${last ? ". It is your only working engine" : ""}` };
      }
      if (change.kind === "openai-compat") {
        if (!savedKey(change.keyFrom)) return { refusal: keyMissing(change.keyFrom) };
        return { change: `Add the engine "${change.name}" (OpenAI-compatible) at ${change.url}, sending it your saved ${CREDENTIAL_TARGETS[change.keyFrom].label}` };
      }
      if (change.kind === "bedrock") return { change: `Add the engine "${change.name}" (Claude on Amazon Bedrock), AWS profile ${change.awsProfile} in ${change.awsRegion}, model ${change.model}` };
      return { change: `Add the engine "${change.name ?? LOCAL_SERVER[change.kind].name}" (${LOCAL_SERVER[change.kind].name} on ${change.url})` };
    },
    write: async (change: EngineChange) => {
      if (change.kind === "remove") return deps.removeEngine(change.instanceId);
      if (change.kind === "bedrock") return deps.addEngine("claude-bedrock", { displayName: change.name, awsProfile: change.awsProfile, awsRegion: change.awsRegion, model: change.model });
      if (change.kind === "openai-compat") {
        const key = savedKey(change.keyFrom);
        return key ? deps.addEngine("openai-compat", { displayName: change.name, url: change.url, key, ...(change.models ? { models: change.models } : {}) }) : keyMissing(change.keyFrom);
      }
      const local = LOCAL_SERVER[change.kind];
      return deps.addEngine("openai-compat", { displayName: change.name ?? local.name, url: change.url, key: local.key, catalog: change.kind });
    },
  });

  const ownerOnly = (id: string, label: string, help: string, where: Where, synonyms: string[], read: () => string): SettingEntry => ({ id, label, help, where, synonyms, tier: "owner-only", read });
  const owner: SettingEntry[] = [
    ownerOnly("cloud.account", "MausBot Cloud account", "The account this app is signed in with, and its plan.", "Settings → Your account", ["account", "sign in", "sign out", "plan", "billing", "subscription"], () => "managed in Settings"),
    ownerOnly("vault.logins", "Vault and logins", "Saved website logins and secrets bots may use.", "Settings → Vault", ["vault", "password", "passwords", "login", "logins", "1password"], () => "managed in Settings"),
    ownerOnly("data.backups", "Backups", "Making a backup (it takes a password), restoring or deleting one, and the daily company backup (it takes a typed confirmation).", "Settings → Data",
      ["backup", "backups", "restore", "export", "import", "schedule"], () => "managed in Settings"),
    ownerOnly("phone.pairing", "Paired devices", "Pairing a phone or computer with a code, removing one, and what each paired device may do.", "Settings → Phone & devices",
      ["pair", "pairing", "qr", "code", "paired", "revoke", "remove device", "device access"], () => "managed in Settings"),
    ownerOnly("computer.lending", "Lending this computer", "Which folders and apps this computer lends to a Cloud or server; each grant is picked and confirmed in the desktop app's own dialogs.", "Settings → Desktops & browser",
      ["lend", "lending", "share computer", "share folders", "pause sharing"], () => "managed in Settings"),
    ownerOnly("data.keepHere", "Keep bots on this computer", "Whether this computer's bots stay here or move to My Cloud; the desktop app takes it only from the person's own click.", "Settings → Data",
      ["keep here", "move to cloud", "move back", "bring back"], () => "managed in Settings"),
    ownerOnly("appearance.sidebarPicture", "Sidebar picture", "The picture at the top of the sidebar; it is a file the person picks or removes.", "Settings → Overview",
      ["wallpaper", "background", "banner", "sidebar image", "picture"], () => "managed in Settings"),
    ownerOnly("account.organization", "Organization", "Joining or leaving a company's managed MausBot; it signs in through the company's portal.", "Settings → Your account",
      ["organization", "organisation", "company", "managed"], () => "managed in Settings"),
  ];

  return [...safe, ...confirm, engines, ...botEntries(deps, writable), ...configEntries(deps, writable), ...windowEntries(windowPref), ...secret, ...owner];
}

export function findSettings(entries: readonly SettingEntry[], query: string, limit = 8): SettingEntry[] {
  const words = query.toLowerCase().split(/[^a-z0-9.-]+/).filter((word) => word.length > 1);
  if (!words.length) return [];
  const phrase = words.join(" ");
  const scored = entries.map((entry) => {
    const label = entry.label.toLowerCase(), id = entry.id.toLowerCase();
    const synonyms = entry.synonyms.map((synonym) => synonym.toLowerCase());
    const loose = [entry.help, ...synonyms].join(" ").toLowerCase();
    const whole = id === phrase || label === phrase || synonyms.includes(phrase) ? 10 : 0;
    const score = words.reduce((sum, word) => sum + (id === word || label === word ? 6 : label.includes(word) || id.includes(word) ? 3 : loose.includes(word) ? 1 : 0), whole);
    return { entry, score };
  }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((hit) => hit.entry);
}

/** The registry over the Settings window's own routes, called as the window calls them. */
export function routeBackedRegistry(deps: {
  cfg(): AppConfig;
  store: Pick<Store, "bots" | "sections" | "tasks">;
  routes: { config: RouteHandler; botOrder: RouteHandler; botPatch: RouteHandler; sections: RouteHandler; instances: RouteHandler } & Record<AppRoute, RouteHandler>;
  providers: Pick<ProviderRegistry, "instances" | "lastSnapshot">;
  credentials(): CredentialConfig;
  window: RegistryDeps["window"];
}): SettingEntry[] {
  const auth: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
  const refusal = async (reply: Promise<RouteReply>) => {
    try {
      const { status, body } = await reply;
      return status < 300 ? null : String(body.error ?? `HTTP ${status}`);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  return createSettingsRegistry({
    cfg: deps.cfg, bots: () => deps.store.bots, sections: () => deps.store.sections, credentials: deps.credentials, window: deps.window,
    saveConfig: (patch) => refusal(callRoute(deps.routes.config, { method: "PUT", path: "/api/config", body: patch, auth })),
    reorderBots: (botIds) => refusal(callRoute(deps.routes.botOrder, { method: "PUT", path: "/api/bots/order", body: { botIds }, auth })),
    pinBot: (botId, pinned) => refusal(callRoute(deps.routes.botPatch, { method: "PATCH", path: `/api/bots/${encodeURIComponent(botId)}`, body: { pinned }, auth })),
    patchBot: (botId, body) => refusal(callRoute(deps.routes.botPatch, { method: "PATCH", path: `/api/bots/${encodeURIComponent(botId)}`, body, auth })),
    call: (route, method, path, body) => refusal(callRoute(deps.routes[route], { method, path, ...(body ? { body } : {}), auth })),
    groupBots: (name, botIds) => refusal(callRoute(deps.routes.sections, { method: "POST", path: "/api/sidebar-sections", body: { name, botIds }, auth })),
    engines: () => deps.providers.instances().filter((instance) => instance.enabled).map((instance) => ({
      instanceId: instance.instanceId, working: deps.providers.lastSnapshot(instance.instanceId)?.state === "available",
      name: instance.displayName ?? BUILT_IN_DRIVERS.find((driver) => driver.driverKind === instance.driverKind)?.metadata.displayName ?? instance.instanceId,
    })),
    engineChosen: (instanceId) => engineChosen(deps.store, deps.cfg(), instanceId),
    addEngine: (path, body) => refusal(callRoute(deps.routes.instances, { method: "POST", path: `/api/instances/${path}`, body, auth })),
    removeEngine: (instanceId) => refusal(callRoute(deps.routes.instances, { method: "DELETE", path: `/api/instances/${encodeURIComponent(instanceId)}`, auth })),
  });
}
