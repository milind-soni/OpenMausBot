import { AudioLines, Blocks, CalendarClock, Fingerprint, Image, LockKeyhole, Monitor, Phone, Search, Server, Zap, type LucideIcon } from "lucide-react";
import type { AppSettingsSection, ConfigStatus } from "@/state/store";
import type { SavedKey } from "@/state/config-status";
import type { KeyProvider } from "@/lib/analytics-allowlist";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { ProviderIconPreset } from "../../../shared/provider-icon";

export type KeySectionId = "ai" | "servers" | "voice" | "computers" | "apps" | "helpers";

export const KEY_SECTIONS: ReadonlyArray<{ id: KeySectionId; titleKey: LocaleKey; purposeKey: LocaleKey }> = [
  { id: "ai", titleKey: "keys.section.ai", purposeKey: "keys.section.ai.purpose" },
  { id: "servers", titleKey: "keys.section.servers", purposeKey: "keys.section.servers.purpose" },
  { id: "voice", titleKey: "keys.section.voice", purposeKey: "keys.section.voice.purpose" },
  { id: "computers", titleKey: "keys.section.computers", purposeKey: "keys.section.computers.purpose" },
  { id: "apps", titleKey: "keys.section.apps", purposeKey: "keys.section.apps.purpose" },
  { id: "helpers", titleKey: "keys.section.helpers", purposeKey: "keys.section.helpers.purpose" },
];

export type TestableProvider = "anthropic" | "openai" | "openrouter" | "openaiCompat" | "xai" | "mistral" | "cerebras" | "groq" | "greenference" | "meta" | "treg";

export type DesktopSlot = Parameters<NonNullable<NonNullable<Window["ogb"]>["setCredential"]>>[0];

export interface SavedState { configured: boolean; last4?: string; included?: boolean }

export interface KeyTarget {
  patch: (value: string, firstKey: boolean) => Record<string, unknown>;
  slot?: DesktopSlot;
  saved: (config: ConfigStatus) => SavedState;
  placeholder: string;
  placeholderKey?: LocaleKey;
  href?: string;
  test?: TestableProvider;
  verifiedOnSave?: boolean;
  analytics: KeyProvider;
  shape?: RegExp;
  warningKey?: LocaleKey;
  noteKey?: LocaleKey;
}

export type KeyId =
  | "openai" | "anthropic" | "xai" | "openrouter" | "mistral" | "cerebras" | "groq" | "greenference" | "meta" | "deepseek" | "opencodeGo" | "opencodeProviders"
  | "lmStudio" | "openaiCompat" | "liveCalls" | "liveKey" | "elevenlabs" | "fishAudio" | "box" | "vps" | "onePassword" | "composio" | "treg" | "postiz"
  | "jev" | "openrouterHelper" | "workersAi" | "imageOpenai" | "imageCustom";

export type KeyMark = { driverKind: string; preset?: ProviderIconPreset } | { icon: LucideIcon };

export interface KeyEntry {
  id: KeyId;
  section: KeySectionId;
  labelKey: LocaleKey;
  purposeKey: LocaleKey;
  name: string;
  env: readonly string[];
  words: readonly string[];
  mark: KeyMark;
  kind: "key" | "uses" | "panel" | "elsewhere";
  target?: KeyTarget;
  uses?: KeyId;
  opens?: AppSettingsSection;
  whereKey?: LocaleKey;
  status?: (config: ConfigStatus) => SavedState;
}

function flag(saved: SavedKey | undefined): SavedState {
  return { configured: saved?.configured === true, ...(saved?.configured && saved.last4 ? { last4: saved.last4 } : {}) };
}

type TopLevelKey = "openai" | "openrouter" | "xai" | "mistral" | "cerebras" | "groq" | "greenference" | "meta" | "deepseek" | "treg";

function providerKey(name: TopLevelKey, rest: Omit<KeyTarget, "patch" | "saved">): KeyTarget {
  return { patch: (value) => ({ [name]: { key: value } }), saved: (config) => flag(config[name]), ...rest };
}

const OPENAI_SHAPE = /^sk-(proj|svcacct|admin)-/;
const provider = (driverKind: string, preset?: ProviderIconPreset): KeyMark => ({ driverKind, ...(preset ? { preset } : {}) });

export const KEY_CATALOG: readonly KeyEntry[] = [
  { id: "openai", section: "ai", labelKey: "keys.openai.label", purposeKey: "keys.purpose.openai", name: "OpenAI", env: ["OMB_OPENAI_API_KEY"],
    words: ["openai", "chatgpt", "gpt", "live calls"], mark: provider("openai-compat", "openai"), kind: "key",
    target: providerKey("openai", { placeholder: "sk-…", href: "https://platform.openai.com/api-keys", test: "openai", analytics: "openai", shape: OPENAI_SHAPE, noteKey: "keys.openai.note" }) },
  { id: "anthropic", section: "ai", labelKey: "keys.anthropic.label", purposeKey: "keys.purpose.anthropic", name: "Anthropic", env: ["OMB_ANTHROPIC_API_KEY"],
    words: ["anthropic", "claude"], mark: provider("claudeAgent", "anthropic"), kind: "key",
    target: { patch: (value, firstKey) => ({ anthropic: { key: value, ...(firstKey && value ? { everyClaudeBot: false } : {}) } }), saved: (config) => flag(config.anthropic),
      placeholder: "sk-ant-…", href: "https://console.anthropic.com/settings/keys", test: "anthropic", analytics: "anthropic", shape: /^sk-ant-/ } },
  { id: "xai", section: "ai", labelKey: "keys.xai.label", purposeKey: "keys.purpose.xai", name: "xAI", env: ["XAI_API_KEY"],
    words: ["xai", "grok", "pictures", "images"], mark: provider("grok", "xai"), kind: "key",
    target: providerKey("xai", { slot: "xaiApiKey", placeholder: "xai-…", href: "https://console.x.ai", test: "xai", analytics: "xai", shape: /^xai-/ }) },
  { id: "openrouter", section: "ai", labelKey: "keys.openrouter.label", purposeKey: "keys.purpose.openrouter", name: "OpenRouter", env: ["OMB_OPENROUTER_API_KEY"],
    words: ["openrouter", "router", "models"], mark: provider("openai-compat", "openrouter"), kind: "key",
    target: providerKey("openrouter", { placeholder: "sk-or-v1-…", href: "https://openrouter.ai/keys", test: "openrouter", analytics: "openrouter", shape: /^sk-or-/ }) },
  { id: "mistral", section: "ai", labelKey: "keys.mistral.label", purposeKey: "keys.purpose.mistral", name: "Mistral", env: ["MISTRAL_API_KEY"],
    words: ["mistral"], mark: provider("mistral", "mistral"), kind: "key",
    target: providerKey("mistral", { placeholder: "…", placeholderKey: "keys.mistral.placeholder", href: "https://console.mistral.ai/api-keys", test: "mistral", analytics: "mistral" }) },
  { id: "cerebras", section: "ai", labelKey: "keys.cerebras.label", purposeKey: "keys.purpose.cerebras", name: "Cerebras", env: ["CEREBRAS_API_KEY"],
    words: ["cerebras", "fast"], mark: provider("cerebras"), kind: "key",
    target: providerKey("cerebras", { placeholder: "csk-…", href: "https://cloud.cerebras.ai/", test: "cerebras", analytics: "cerebras", shape: /^csk-/ }) },
  { id: "groq", section: "ai", labelKey: "keys.groq.label", purposeKey: "keys.purpose.groq", name: "Groq", env: ["OMB_GROQ_API_KEY"],
    words: ["groq", "fast"], mark: provider("groq"), kind: "key",
    target: providerKey("groq", { placeholder: "gsk_…", href: "https://console.groq.com/keys", test: "groq", analytics: "groq", shape: /^gsk_/ }) },
  { id: "greenference", section: "ai", labelKey: "keys.greenference.label", purposeKey: "keys.purpose.greenference", name: "Greenference", env: ["OMB_GREENFERENCE_API_KEY"],
    words: ["greenference", "green", "open models"], mark: provider("greenference"), kind: "key",
    target: providerKey("greenference", { placeholder: "…", placeholderKey: "keys.greenference.placeholder", href: "https://greenference.com/dashboard/tokens", test: "greenference", analytics: "greenference" }) },
  { id: "meta", section: "ai", labelKey: "keys.meta.label", purposeKey: "keys.purpose.meta", name: "Meta", env: ["OMB_META_API_KEY"],
    words: ["meta", "muse", "llama"], mark: provider("meta", "meta"), kind: "key",
    target: providerKey("meta", { placeholder: "LLM|…", href: "https://dev.meta.ai/docs/authentication", test: "meta", analytics: "meta", shape: /^LLM\|/ }) },
  { id: "deepseek", section: "ai", labelKey: "keys.deepseek.label", purposeKey: "keys.purpose.deepseek", name: "DeepSeek", env: ["OMB_DEEPSEEK_API_KEY"],
    words: ["deepseek", "dsh", "harness"], mark: provider("deepseekAgent", "deepseek"), kind: "key",
    target: providerKey("deepseek", { placeholder: "sk-…", href: "https://platform.deepseek.com/api_keys", analytics: "deepseek" }) },
  { id: "opencodeGo", section: "ai", labelKey: "keys.opencode.label", purposeKey: "keys.purpose.opencodeGo", name: "OpenCode", env: ["OPENCODE_API_KEY"],
    words: ["opencode", "zen", "go"], mark: provider("opencodeGo"), kind: "key",
    target: { patch: (value) => ({ opencodeGo: { apiKey: value } }), slot: "opencodeGoApiKey", saved: (config) => flag(config.opencodeGo),
      placeholder: "…", placeholderKey: "keys.opencode.placeholder", href: "https://opencode.ai/docs/providers/", analytics: "opencode_go" } },
  { id: "opencodeProviders", section: "ai", labelKey: "keys.opencode.otherProviders.title", purposeKey: "keys.purpose.opencodeProviders", name: "OpenCode", env: [],
    words: ["opencode", "venice", "providers", "provider keys"], mark: provider("opencodeGo"), kind: "panel",
    status: (config) => ({ configured: (config.opencodeGo?.providerKeys?.length ?? 0) > 0 }) },
  { id: "lmStudio", section: "servers", labelKey: "lmStudio.title", purposeKey: "keys.purpose.lmStudio", name: "LM Studio", env: [],
    words: ["lm studio", "lmstudio", "llm studio", "local", "bionic"], mark: { icon: Server }, kind: "panel" },
  { id: "openaiCompat", section: "servers", labelKey: "keys.openaiCompat.label", purposeKey: "keys.purpose.openaiCompat", name: "OpenAI-compatible", env: ["OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_URL"],
    words: ["openai-compatible", "openai compatible", "ollama", "together", "base url", "server", "endpoint"], mark: { icon: Server }, kind: "key",
    target: { patch: (value) => ({ openaiCompat: { key: value } }), saved: (config) => flag(config.openaiCompat), placeholder: "…", placeholderKey: "keys.openaiCompat.placeholder",
      href: "https://platform.openai.com/docs/api-reference", test: "openaiCompat", analytics: "openai_compat" } },
  { id: "liveCalls", section: "voice", labelKey: "call.live.key", purposeKey: "keys.purpose.liveCalls", name: "OpenAI", env: [],
    words: ["openai", "live calls", "calls", "voice", "talk", "gpt-live"], mark: { icon: Phone }, kind: "uses", uses: "openai" },
  { id: "liveKey", section: "voice", labelKey: "keys.label.liveKey", purposeKey: "keys.purpose.liveKey", name: "OpenAI", env: ["OMB_OPENAI_LIVE_KEY"],
    words: ["openai", "live calls", "calls", "voice", "gpt-live"], mark: { icon: Phone }, kind: "key",
    target: { patch: (value) => ({ live: { key: value } }), slot: "openaiLiveKey",
      saved: (config) => flag(config.savedKeys?.openaiLiveKey ?? { configured: config.live?.keySource === "live" }),
      placeholder: "sk-…", href: "https://platform.openai.com/api-keys", analytics: "openai_live", shape: OPENAI_SHAPE } },
  { id: "elevenlabs", section: "voice", labelKey: "keys.label.elevenlabs", purposeKey: "keys.purpose.elevenlabs", name: "ElevenLabs", env: ["OMB_TTS_KEY"],
    words: ["elevenlabs", "eleven labs", "voice", "voices", "speech", "tts"], mark: { icon: AudioLines }, kind: "key",
    target: { patch: (value) => ({ tts: { key: value } }), slot: "ttsKey", verifiedOnSave: true,
      saved: (config) => ({ ...flag(config.savedKeys?.ttsKey ?? { configured: config.tts?.provider === "elevenlabs" && config.tts.configured && !config.tts.included }),
        ...(config.tts?.included ? { included: true } : {}) }),
      placeholder: "sk_…", href: "https://elevenlabs.io/app/settings/api-keys", analytics: "elevenlabs", shape: /^sk_/ } },
  { id: "fishAudio", section: "voice", labelKey: "keys.label.fishAudio", purposeKey: "keys.purpose.fishAudio", name: "Fish Audio", env: ["OMB_FISH_AUDIO_API_KEY"],
    words: ["fish", "fish audio", "voice", "voices", "speech", "tts"], mark: { icon: AudioLines }, kind: "key",
    target: { patch: (value) => ({ tts: { fishKey: value } }), slot: "fishAudioKey", verifiedOnSave: true,
      saved: (config) => flag(config.savedKeys?.fishAudioKey ?? { configured: config.tts?.provider === "fish" && config.tts.configured }),
      placeholder: "…", placeholderKey: "voice.fish.keyPlaceholder", href: "https://fish.audio/app/api-keys/", analytics: "fish_audio" } },
  { id: "box", section: "computers", labelKey: "keys.boat.label", purposeKey: "keys.purpose.box", name: "boat.dev", env: ["BOX_TOKEN"],
    words: ["boat", "box", "cloud desktop", "cloud computer", "computer", "sandbox"], mark: { icon: Monitor }, kind: "key",
    target: { patch: (value) => ({ box: { token: value } }), slot: "boxToken", verifiedOnSave: true,
      saved: (config) => ({ ...flag(config.box?.included ? undefined : config.box), ...(config.box?.included ? { included: true } : {}) }),
      placeholder: "boat_…", href: "https://docs.boat.dev/api-keys", analytics: "boat", shape: /^(boat|box)_/, warningKey: "keys.boat.warning" } },
  { id: "vps", section: "computers", labelKey: "keys.vps.label", purposeKey: "keys.purpose.vps", name: "VPS", env: [],
    words: ["vps", "ssh", "server", "self-hosted", "computer", "docker"], mark: { icon: Server }, kind: "panel",
    status: (config) => ({ configured: config.vps?.configured === true }) },
  { id: "onePassword", section: "computers", labelKey: "settings.logins.onePassword.title", purposeKey: "keys.purpose.onePassword", name: "1Password", env: [],
    words: ["1password", "one password", "logins", "passwords", "vault", "service account"], mark: { icon: LockKeyhole }, kind: "elsewhere",
    opens: "logins", whereKey: "keys.where.logins" },
  { id: "composio", section: "apps", labelKey: "keys.composio.label", purposeKey: "keys.purpose.composio", name: "Composio", env: ["COMPOSIO_API_KEY"],
    words: ["composio", "connected apps", "apps", "gmail", "slack", "github", "notion", "self-host"], mark: { icon: Blocks }, kind: "key",
    target: { patch: (value) => ({ composio: { apiKey: value } }), slot: "composioApiKey", verifiedOnSave: true,
      saved: (config) => ({ ...flag((config.composio?.mode ?? "self-hosted") === "self-hosted" ? config.composio : undefined),
        ...(config.composio?.mode === "managed" ? { included: true } : {}) }),
      placeholder: "ak_…", href: "https://dashboard.composio.dev", analytics: "composio", shape: /^ak_/ } },
  { id: "treg", section: "apps", labelKey: "keys.treg.label", purposeKey: "keys.purpose.treg", name: "treg", env: ["OMB_TREG_KEY"],
    words: ["treg", "research", "x", "twitter", "companies", "people", "funding", "news"], mark: { icon: Search }, kind: "key",
    target: { ...providerKey("treg", { slot: "tregApiKey", placeholder: "…", placeholderKey: "keys.treg.placeholder", href: "https://treg.to", test: "treg", analytics: "treg" }),
      saved: (config) => ({ ...flag(config.treg), ...(config.xResearch?.included && !config.treg?.configured ? { included: true } : {}) }) } },
  { id: "postiz", section: "apps", labelKey: "keys.postiz.label", purposeKey: "keys.purpose.postiz", name: "Postiz", env: ["OMB_POSTIZ_API_KEY"],
    words: ["postiz", "social", "social media", "posts", "schedule", "linkedin", "instagram", "x", "twitter"], mark: { icon: CalendarClock }, kind: "key",
    target: { patch: (value) => ({ postiz: { key: value } }), slot: "postizApiKey", verifiedOnSave: true, saved: (config) => flag(config.postiz),
      placeholder: "…", placeholderKey: "keys.postiz.placeholder", href: "https://platform.postiz.com/settings", analytics: "postiz" } },
  { id: "jev", section: "helpers", labelKey: "decider.key.label", purposeKey: "keys.purpose.jev", name: "Jev", env: ["OMB_JEV_API_KEY"],
    words: ["jev", "typesafe", "decisions", "extraction", "helper", "rooms"], mark: { icon: Zap }, kind: "key",
    target: { patch: (value) => ({ decider: { key: value } }), slot: "jevApiKey", verifiedOnSave: true,
      saved: (config) => ({ ...flag(config.savedKeys?.jevApiKey ?? { configured: config.helpers?.own.jev === true }), ...(config.decider?.included ? { included: true } : {}) }),
      placeholder: "…", placeholderKey: "decider.key.placeholder", href: "https://typesafe.ai", analytics: "jev" } },
  { id: "openrouterHelper", section: "helpers", labelKey: "keys.label.openrouterHelper", purposeKey: "keys.purpose.openrouterHelper", name: "OpenRouter", env: ["OMB_OPENROUTER_DECIDER_KEY"],
    words: ["openrouter", "decisions", "helper"], mark: provider("openai-compat", "openrouter"), kind: "key",
    target: { patch: (value) => ({ decider: { openrouterKey: value } }), slot: "openrouterDeciderKey", verifiedOnSave: true,
      saved: (config) => flag(config.savedKeys?.openrouterDeciderKey ?? { configured: config.helpers?.own.openrouter === true }),
      placeholder: "sk-or-v1-…", href: "https://openrouter.ai/keys", analytics: "openrouter_decider", shape: /^sk-or-/ } },
  { id: "workersAi", section: "helpers", labelKey: "decider.workersAi.title", purposeKey: "keys.purpose.workersAi", name: "Cloudflare", env: ["OMB_WORKERS_AI_TOKEN"],
    words: ["cloudflare", "workers ai", "clef", "clairic", "decisions", "helper"], mark: { icon: Zap }, kind: "elsewhere",
    opens: "decisionModel", whereKey: "keys.where.decisions",
    status: (config) => flag(config.savedKeys?.workersAiToken ?? { configured: config.helpers?.own.workersAi === true }) },
  { id: "imageOpenai", section: "helpers", labelKey: "keys.label.imageOpenai", purposeKey: "keys.purpose.imageOpenai", name: "OpenAI", env: ["OMB_OPENAI_IMAGE_KEY"],
    words: ["openai", "image", "images", "pictures", "avatar", "gpt image"], mark: { icon: Image }, kind: "key",
    target: { patch: (value) => ({ imageGen: { key: value } }), slot: "openaiImageApiKey",
      saved: (config) => flag(config.savedKeys?.openaiImageApiKey ?? { configured: config.imageGen?.openaiConfigured === true }),
      placeholder: "sk-…", href: "https://platform.openai.com/api-keys", analytics: "openai_image", shape: OPENAI_SHAPE } },
  { id: "imageCustom", section: "helpers", labelKey: "keys.label.imageCustom", purposeKey: "keys.purpose.imageCustom", name: "Custom", env: ["OMB_CUSTOM_IMAGE_KEY"],
    words: ["image", "images", "pictures", "avatar", "custom"], mark: { icon: Fingerprint }, kind: "elsewhere", whereKey: "keys.where.pictures",
    status: (config) => flag(config.savedKeys?.customImageApiKey ?? { configured: config.imageGen?.customKeyConfigured === true }) },
];

export function keyEntry(id: KeyId): KeyEntry {
  const entry = KEY_CATALOG.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no key ${id}`);
  return entry;
}

export function keySection(entry: KeyEntry) {
  return KEY_SECTIONS.find((section) => section.id === entry.section)!;
}

export function savedState(entry: KeyEntry, config: ConfigStatus | null | undefined): SavedState {
  if (!config) return { configured: false };
  if (entry.uses) return savedState(keyEntry(entry.uses), config);
  return entry.target?.saved(config) ?? entry.status?.(config) ?? { configured: false };
}

export function keyMatches(entry: KeyEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [t(entry.labelKey), t(entry.purposeKey), t(keySection(entry).titleKey), entry.name, ...entry.words].some((part) => part.toLowerCase().includes(q));
}

export function looksLikeOtherKey(entry: KeyEntry, value: string): KeyEntry | null {
  const key = value.trim();
  const own = entry.uses ? keyEntry(entry.uses) : entry;
  if (!key || own.target?.shape?.test(key)) return null;
  return KEY_CATALOG.find((other) => other.name !== own.name && other.target?.shape?.test(key)) ?? null;
}

const INSTANCE_KEYS: Readonly<Record<string, KeyId>> = {
  openai: "openai", claudeApi: "anthropic", xaiApi: "xai", grok: "xai", openrouter: "openrouter", mistral: "mistral", cerebras: "cerebras",
  groq: "groq", greenference: "greenference", meta: "meta", deepseek: "deepseek", opencodeGo: "opencodeGo", openaiCompat: "openaiCompat",
};

export function keyForInstance(instanceId: string | undefined): KeyId | undefined {
  return instanceId ? INSTANCE_KEYS[instanceId] : undefined;
}
