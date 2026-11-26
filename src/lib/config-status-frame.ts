import type { ConfigStatus } from "@/state/config-status";

// A setting left out here is wiped from state.config whenever a config frame lands.
export type ConfigStatusFrame = Pick<
  ConfigStatus,
  "awakeLimit" | "pausedBots" | "pausedByPerson" | "heldBots" | "xai" | "mistral" | "cerebras" | "groq" | "greenference" | "modelgo" | "meta" | "deepseek" | "xResearch" | "treg" | "postiz" | "anthropic" | "openai" | "openrouter" | "openaiCompat" | "fleet" | "composio" | "box" | "vps" | "rooms" | "mcp" | "threads" | "automaticRecovery" | "cacheKeepWarm" | "localVm" | "opencodeGo" | "tts" | "decider" | "helpers" | "imageGen" | "live" | "savedKeys" | "profile" | "everyBotRules" | "language" | "features" | "onboarding" | "browserEngine" | "browserProfiles" | "edition" | "budgets" | "billing" | "managedPolicy" | "cloudHome" | "team" | "workspaceBanner" | "toolGroups"
>;

/** What the server says about the place itself. Its frames carry them as GET /api/config does, one left out meaning
 * unset (planTurns off Starter, routinesUnreadable once the routines read again); a frame with none of them (an older
 * server's) says nothing about them. */
const PLACE_FIELDS = ["computerName", "newBots", "signIn", "membership", "cloudStarter", "waitingForRoom", "planTurns", "decisions", "safetyFloor", "routinesUnreadable", "botLimit"];

function placeFields(frame: object, held: ConfigStatus | null | undefined): Partial<ConfigStatus> {
  const carried = PLACE_FIELDS.some((field) => field in frame);
  const source = (carried ? frame : held ?? {}) as Record<string, unknown>;
  return Object.fromEntries(PLACE_FIELDS.flatMap((field) => source[field] === undefined ? [] : [[field, source[field]]]));
}

/** `held`: the config the store holds now, which keeps the place fields a frame without them says nothing about. */
export function configStatusFromFrame(frame: ConfigStatusFrame, held?: ConfigStatus | null): ConfigStatus {
  return {
    ...placeFields(frame, held),
    xai: frame.xai,
    mistral: frame.mistral,
    cerebras: frame.cerebras,
    groq: frame.groq, greenference: frame.greenference, modelgo: frame.modelgo, deepseek: frame.deepseek,
    meta: frame.meta, xResearch: frame.xResearch, treg: frame.treg, postiz: frame.postiz,
    anthropic: frame.anthropic,
    openai: frame.openai,
    openrouter: frame.openrouter,
    openaiCompat: frame.openaiCompat,
    fleet: frame.fleet, toolGroups: frame.toolGroups,
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
    ...(frame.pausedByPerson ? { pausedByPerson: frame.pausedByPerson } : {}), ...(frame.heldBots ? { heldBots: frame.heldBots } : {}),
    ...(frame.cloudHome ? { cloudHome: true } : {}), ...(frame.team ? { team: frame.team } : {}), ...(frame.awakeLimit !== undefined ? { awakeLimit: frame.awakeLimit } : {}), ...(frame.pausedBots ? { pausedBots: frame.pausedBots } : {}), ...(frame.workspaceBanner ? { workspaceBanner: frame.workspaceBanner } : {}),
  };
}
