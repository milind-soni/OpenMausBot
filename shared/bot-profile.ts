/** Profile input limits shared by every web and server write surface. */
export const BOT_PROFILE_LIMITS = {
  name: 100,
  title: 200,
  description: 4000,
  instructions: 16_000,
  voice: 200,
} as const;

/** How much unsolicited operational chatter an agent should surface. This is
 * a user-owned behavior preference, not a capability or permission. */
export const BOT_REPORTING_MODES = ["all", "actionable", "silent"] as const;
export type BotReportingMode = (typeof BOT_REPORTING_MODES)[number];
