import type { BrowserEngineConfig } from "./browser/config.ts";
import type { HelperConfig } from "./side-jobs.ts";
import type { LoopGuardConfig } from "./host/loop-guard.ts";
import type { ImageGenerationConfig } from "../shared/image-generation.ts";
import type { NewBotDefaults } from "./new-bot-defaults.ts";
import type { EffortLevel } from "../shared/wire.ts";
import type { InstanceConfigMap, ModelSelection } from "./contracts.ts";
import type { BrowserProfile, FishTtsModel } from "./config.ts";
import type { DeciderConfig } from "./decider/config.ts";

export interface AppConfig extends HelperConfig {
  customDomain?: string;
  signIn?: { admins?: string[]; members?: string[] };
  /** Preferred selection for newly created bots; existing bots keep theirs. */
  defaultModelSelection?: ModelSelection;
  /** Off by default; one backup attempt only before any work starts. */
  automaticRecovery?: { enabled: boolean; backup?: ModelSelection };
  cacheKeepWarm?: { enabled: boolean; windowMinutes?: number };
  /** UI creation template. Saving it never mutates a bot or grants access. */
  newBotDefaults?: NewBotDefaults;
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
  cerebras?: { key?: string }; treg?: { key?: string };
  groq?: { key?: string; url?: string };
  meta?: { key?: string; url?: string };
  /** DeepSeek API key for the DeepSeek Harness engine (`dsh`). */
  deepseek?: { key?: string };
  /** `everyClaudeBot`: the key runs every Claude bot instead of its login; unset means true. */
  anthropic?: { key?: string; url?: string; everyClaudeBot?: boolean };
  openai?: { key?: string };
  openrouter?: { key?: string };
  budgets?: { monthlyUsd?: number; warnAtPercent?: number };
  decisions?: { retentionDays?: number };
  loopGuard?: LoopGuardConfig;
  safetyFloor?: { enabled?: boolean };
  billing?: { currency?: string; prices?: Record<string, { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number }> };
  openaiCompat?: { key?: string; url?: string; model?: string; provider?: string };
  composio?: { apiKey?: string; userId?: string; sessionId?: string };
  /** Boat token (ascii.dev renamed Box to Boat); config key "box", env BOX_TOKEN. */
  box?: { token?: string };
  /** A named host from the user's SSH config. Authentication stays with SSH. */
  vps?: { sshAlias?: string };
  opencodeGo?: { apiKey?: string; providerKeys?: Record<string, string> };
  tts?: { key?: string; fishKey?: string; voice?: string; provider?: "elevenlabs" | "fish" | "system" | "chatterbox" | "xai"; baseUrl?: string; model?: string; fishModel?: FishTtsModel };
  decider?: DeciderConfig;
  imageGen?: ImageGenerationConfig;
  live?: { key?: string; voice?: string; readTypedReplies?: boolean; idleMinutes?: number };
  profile?: { name?: string; email?: string; aboutMe?: string; avatarUrl?: string };
  rooms?: { turnTimeoutMinutes: number };
  mcp?: { callTimeoutMinutes?: number };
  threads?: { maxConcurrentPerBot: number; eventLogMaxBytes?: number; eventLogRetentionDays?: number };
  context?: { rebuildBytes?: number; compactAt?: number; autoCompact?: boolean; roomCompactAt?: number; checkpointOutputTokens?: number; checkpointTailTokens?: number; checkpointPrefillTimeoutMs?: number | null; checkpointIdleTimeoutMs?: number } & { roomSessions?: boolean; replayToolHistory?: boolean };
  memory?: { captureQuietMs?: number; tidyHour?: number };
  localVm?: { mode?: "shared" | "per-bot" | "pool"; maxInstances?: number; idleTimeoutMinutes?: number };
  features?: { skillAuthoring?: boolean; skillReview?: boolean; skillReviewSteps?: number; showToolCalls?: boolean; browser?: boolean; sharedComputers?: boolean; claudeUserMcp?: boolean; claudeUserSkills?: boolean; llmThreadTitles?: boolean; autoRecall?: boolean; skillsLibrary?: boolean; shareLearnedSkills?: "off" | "ask" | "auto"; roomMemoryCapture?: boolean; parallelRoomJobs?: boolean; chiefEscalations?: boolean; acpPlanLines?: boolean; agentsToolBridge?: boolean };
  onboarding?: { completedAt?: string; version?: number; reelSeen?: boolean; hintsSeen?: string[]; firstTurnAt?: string };
  browserProfiles?: BrowserProfile[];
  browserEngine?: BrowserEngineConfig;
  instances?: InstanceConfigMap;
}
