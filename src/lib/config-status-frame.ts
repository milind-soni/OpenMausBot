import type { ConfigStatus } from "@/state/config-status";

// A section left out here is wiped from state.config whenever a config frame lands.
export type ConfigStatusFrame = Pick<
  ConfigStatus,
  "awakeLimit" | "pausedBots" | "xai" | "mistral" | "cerebras" | "groq" | "greenference" | "llmtr" | "modelgo" | "meta" | "deepseek" | "xResearch" | "treg" | "postiz" | "anthropic" | "openai" | "openrouter" | "openaiCompat" | "fleet" | "composio" | "box" | "vps" | "rooms" | "mcp" | "threads" | "automaticRecovery" | "cacheKeepWarm" | "localVm" | "opencodeGo" | "tts" | "decider" | "helpers" | "imageGen" | "live" | "savedKeys" | "profile" | "everyBotRules" | "language" | "features" | "onboarding" | "browserEngine" | "browserProfiles" | "edition" | "budgets" | "billing" | "managedPolicy" | "cloudHome" | "team" | "workspaceBanner"
>;

export function configStatusFromFrame(frame: ConfigStatusFrame): ConfigStatus {
  return {
    xai: frame.xai,
    mistral: frame.mistral,
    cerebras: frame.cerebras,
    groq: frame.groq, greenference: frame.greenference, llmtr: frame.llmtr, modelgo: frame.modelgo, deepseek: frame.deepseek,
    meta: frame.meta, xResearch: frame.xResearch, treg: frame.treg, postiz: frame.postiz,
    anthropic: frame.anthropic,
    openai: frame.openai,
    openrouter: frame.openrouter,
    openaiCompat: frame.openaiCompat,
    fleet: frame.fleet,
    composio: frame.composio,
    box: frame.box,
    vps: frame.vps,
    rooms: frame.rooms,
    mcp: frame.mcp,
    threads: frame.threads,
    automaticRecovery: frame.automaticRecovery,
    cacheKeepWarm: frame.cacheKeepWarm,
    localVm: frame.localVm,
    opencodeGo: frame.opencodeGo,
    tts: frame.tts,
    decider: frame.decider, helpers: frame.helpers,
    imageGen: frame.imageGen,
    live: frame.live, savedKeys: frame.savedKeys,
    profile: frame.profile, everyBotRules: frame.everyBotRules,
    language: frame.language,
    features: frame.features,
    onboarding: frame.onboarding,
    browserEngine: frame.browserEngine,
    browserProfiles: frame.browserProfiles,
    edition: frame.edition,
    budgets: frame.budgets,
    billing: frame.billing,
    managedPolicy: frame.managedPolicy,
    ...(frame.cloudHome ? { cloudHome: true } : {}), ...(frame.team ? { team: frame.team } : {}), ...(frame.awakeLimit !== undefined ? { awakeLimit: frame.awakeLimit } : {}), ...(frame.pausedBots ? { pausedBots: frame.pausedBots } : {}), ...(frame.workspaceBanner ? { workspaceBanner: frame.workspaceBanner } : {}),
  };
}
