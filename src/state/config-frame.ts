import type { ConfigStatus } from "./store";

export type ConfigStatusFrame = Pick<
  ConfigStatus,
  "xai" | "mistral" | "cerebras" | "groq" | "deepseek" | "meta" | "xResearch" | "treg" | "anthropic" | "openai" | "openrouter" | "openaiCompat" | "fleet" | "composio" | "box" | "vps" | "rooms" | "mcp" | "threads" | "automaticRecovery" | "approvalReview" | "cacheKeepWarm" | "localVm" | "opencodeGo" | "tts" | "decider" | "imageGen" | "live" | "profile" | "language" | "features" | "onboarding" | "browserEngine" | "browserProfiles" | "edition" | "budgets" | "billing" | "managedPolicy" | "cloudHome"
>;

export function configStatusFromFrame(frame: ConfigStatusFrame): ConfigStatus {
  return {
    xai: frame.xai,
    mistral: frame.mistral,
    cerebras: frame.cerebras,
    groq: frame.groq,
    deepseek: frame.deepseek,
    meta: frame.meta, xResearch: frame.xResearch, treg: frame.treg,
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
    approvalReview: frame.approvalReview,
    localVm: frame.localVm,
    opencodeGo: frame.opencodeGo,
    tts: frame.tts,
    decider: frame.decider,
    imageGen: frame.imageGen,
    live: frame.live,
    profile: frame.profile,
    language: frame.language,
    features: frame.features,
    onboarding: frame.onboarding,
    browserEngine: frame.browserEngine,
    browserProfiles: frame.browserProfiles,
    edition: frame.edition,
    budgets: frame.budgets,
    billing: frame.billing,
    managedPolicy: frame.managedPolicy,
    ...(frame.cloudHome ? { cloudHome: true } : {}),
  };
}
