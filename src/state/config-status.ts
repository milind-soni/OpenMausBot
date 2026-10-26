// What GET /api/config tells the app about the server and its settings (re-exported by store.tsx).
import type { EffortLevel, LiveSettings } from "../../shared/wire";
import type { OnboardingStatus } from "@/lib/onboarding";
import type { ModelSelection } from "./store";

/** GET /api/config — configured flags only; secrets are never echoed. */
export interface ConfigStatus {
  xai?: { configured: boolean };
  mistral?: { configured: boolean };
  cerebras?: { configured: boolean };
  groq?: { configured: boolean };
  deepseek?: { configured: boolean };
  meta?: { configured: boolean };
  /** X research comes with MausBot Cloud plans: `included` while this server holds the plan's relay credential;
   * `unavailable` when the Admin said no to this desktop's paid sign-in. */
  xResearch?: { included: boolean; unavailable?: boolean };
  /** The person's own treg key for research: configured or not, never the key. */
  treg?: { configured: boolean };
  /** `everyClaudeBot`: the key runs every Claude bot, not only "Claude (API key)". */
  anthropic?: { configured: boolean; everyClaudeBot?: boolean };
  openai?: { configured: boolean };
  openrouter?: { configured: boolean };
  openaiCompat?: { configured: boolean; url?: string };
  /** what this server is entitled to; Settings shows only what works here.
   * `license` reaches admins only, and only while the key is inside its
   * warning window or grace period. */
  edition?: {
    edition: "oss" | "enterprise";
    features: string[];
    license?: { expiresAt: string; expiresInDays: number; graceEndsAt?: string };
  };
  /** a fleet agent exists on this server (Settings → Workspaces) */
  fleet?: { available: boolean };
  budgets?: { monthlyUsd?: number; warnAtPercent?: number };
  billing?: { currency?: string; prices?: Record<string, { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number }> };
  composio: { configured: boolean; mode?: "managed" | "self-hosted" | "unavailable" };
  /** `included`: cloud computers come with Cloud Pro, no key is saved. */
  box: { configured: boolean; included?: boolean };
  vps: { configured: boolean; sshAlias: string };
  rooms: { turnTimeoutMinutes: number };
  /** Per-call ceiling (minutes) for a bot's MCP tools. Absent from servers
   * older than the setting; read it with mcpCallTimeoutMinutes(). */
  mcp?: { callTimeoutMinutes: number };
  /** Workspace defaults for new bots; absent effort = no level is sent. */
  newBots?: { effort?: EffortLevel };
  threads?: { maxConcurrentPerBot: number; eventLogMaxBytes?: number; eventLogRetentionDays?: number };
  automaticRecovery?: { enabled: boolean; backup?: ModelSelection };
  /** Prompt-cache keep-warm for idle Claude threads. Absent from older servers. */
  cacheKeepWarm?: { enabled: boolean; windowMinutes: number };
  localVm: { mode: "shared" | "per-bot" | "pool"; maxInstances: number; idleTimeoutMinutes?: number };
  /** `providerKeys`: names of the keys saved for OpenCode's other
   * providers, never the keys. */
  opencodeGo?: { configured: boolean; providerKeys?: string[] };
  /** Voice. `configured` = the engine has what it needs (an ElevenLabs or
   * Fish Audio key, or a Chatterbox server address); `ready` = that AND a voice, which is
   * what it takes to actually speak. The key itself is never echoed back;
   * `baseUrl`/`model` are Chatterbox settings, not credentials. */
  tts?: {
    configured: boolean;
    ready: boolean;
    voice: string;
    provider?: "elevenlabs" | "fish" | "system" | "chatterbox" | "xai";
    baseUrl?: string;
    model?: string;
    /** Fish Audio speech model; present only while Fish is the provider. */
    fishModel?: "s2.1-pro" | "s2.1-pro-free";
    /** ElevenLabs voice comes with Cloud Pro; no key is saved. */
    included?: boolean;
  };
  /** The decision model: switches and whether a key is on file. The key
   * itself never comes back. `enabled` is the switch as it takes effect
   * (off while no key is saved). `included`: Cloud Pro's decisions, no key
   * saved. OpenRouter only: `keySource` says which key is in use (its own, or
   * the one under Settings → API keys); `sharedKey`: that one is on file. */
  decider?: {
    provider: "jev" | "workersai" | "openrouter";
    /** The OpenRouter model in use; present only while OpenRouter is the provider. */
    model?: string;
    configured: boolean;
    keySource?: "own" | "shared";
    sharedKey?: boolean;
    included?: boolean;
    enabled: boolean;
    jobs: { roomRouting: boolean };
  };
  /** The decision and extraction models' keys: which of the person's own are on file, never a key. */
  helpers?: {
    own: { jev: boolean; workersAi: boolean; openrouter: boolean };
    sharedKey?: boolean;
    workersAiAccountId?: string;
    extraction: { provider?: "jev" | "workersai" | "openrouter"; included?: boolean; ready: boolean };
  };
  /** Live calls (OpenAI GPT-Live): configured-or-not, never the key. */
  live?: LiveSettings;
  /** Shared write-only credential for on-demand GPT Image avatars. */
  imageGen?: {
    configured: boolean;
    provider?: "openai" | "xai" | "custom";
    model?: string;
    customUrl?: string;
    customModel?: string;
    openaiConfigured?: boolean;
    xaiConfigured?: boolean;
    customKeyConfigured?: boolean;
  };
  /** who's using the app — collected in onboarding, shown in the sidebar */
  profile?: { name: string; email: string; aboutMe?: string; avatarUrl?: string };
  /** UI language override; "" (or absent) follows the system language. */
  language?: string;
  /** Opt-in flags. Absent means off. */
  features?: { skillAuthoring: boolean; skillReview?: boolean; skillReviewSteps?: number; showToolCalls?: boolean; browser?: boolean; sharedComputers?: boolean; claudeUserMcp?: boolean; llmThreadTitles?: boolean; skillsLibrary?: boolean; shareLearnedSkills?: "off" | "ask" | "auto"; roomMemoryCapture?: boolean };
  /** First-run progress: whether the welcome tour was finished and which
   * one-time hints were dismissed. Server-owned so it follows the workspace. */
  onboarding?: OnboardingStatus;
  /** Which browser this server can give bots: the desktop app's surface, the
   * agent-browser engine, or nothing yet (with the reason). */
  browserEngine?: BrowserEngineSummary;
  /** Named browser sessions any bot can be pointed at. */
  browserProfiles?: BrowserProfile[];
  /** The enrolled organisation's read-only desktop policy; null when this
   * desktop is not enrolled or its Admin sends no policy. */
  managedPolicy?: ManagedPolicySummary | null;
  /** This server is an OMB Cloud home: it offers no "this computer" and no
   * Local VM (server/cloud-home.ts). Absent everywhere else. */
  cloudHome?: boolean;
  /** A Team Cloud: the team this server is the home of, and the Plan page (MausBot Cloud) where its people and plan
   * are managed. Absent everywhere else. */
  team?: { id: string; name: string; cloudPage?: string };
}

export interface ManagedPolicySummary {
  organizationName: string;
  version: number;
  companyModelsOnly: boolean;
  allowedEngines: "all" | string[];
  mcp: { allowCustom: boolean; allowlist: string[] };
  computers: { thisComputer: boolean; localVm: boolean; box: boolean; vps: boolean };
  remoteAccess: boolean;
}

export interface BrowserEngineSummary {
  kind: "engine" | "unavailable";
  reason?: string;
  installable?: boolean;
  version?: string;
  /** The browser the engine starts, e.g. "Google Chrome 153 (installed)", or while Chrome for Testing downloads,
   * "Chrome for Testing 153.0.8010.47 (downloading: 52 of 182 MB)". */
  chrome?: string;
  installing?: boolean;
  installError?: string;
  /** Whether a browser profile can use "My Chrome", the person's own running
   * Chrome: only where the bots run on their computer (the desktop app). */
  myChrome?: boolean;
  /** browserEngine.engine: "chrome" when the bots' browsers run on OpenMausBot's own Chrome driver. */
  engine?: "agent-browser" | "chrome";
}

export interface BrowserProfile {
  id: string;
  name: string;
  /** "chrome": the profile's bots use the person's own Chrome (My Chrome).
   * Absent is the built-in browser. */
  browser?: "chrome";
  /** Read-only durable Electron routing inherited from legacy profiles.
   * Config PATCH payloads must omit it. */
  partitionId?: string;
}
