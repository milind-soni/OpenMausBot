// The agents tools' internal calls that need only the capability's bot and conversation, its body and its folders: research,
// the helper models' decide and extract, what_changed, MausBot's notifications, the usage limits and publishing an app.
// Runs inside index.ts's /api/internal/ block, after the capability bearer is checked; each route answers its own paths
// and passes the rest on.
import type { AppPublisher } from "../host/app-publisher.ts";
import { createAppHostingInternalRoutes } from "./app-hosting.ts";
import { createBotUsageRoute } from "./bot-usage.ts";
import { createEngineLimitsRoutes, type EngineLimitsDeps } from "./engine-limits.ts";
import { createHelperToolRoutes, type HelperToolContext, type HelperToolDeps } from "./helper-tools.ts";
import { createMausBotNotificationRoutes, type LiveNotificationsDeps } from "./mausbot-notifications.ts";
import { PASS } from "./table.ts";
import { createWhatChangedRoutes, type WhatChangedDeps } from "./what-changed.ts";
import { createXResearchInternalRoutes, type XResearchDeps } from "./x-research.ts";

export function createInternalToolRoutes(deps: { helpers: HelperToolDeps; xResearch: XResearchDeps; notifications: LiveNotificationsDeps; engineLimits: EngineLimitsDeps; botUsage: Parameters<typeof createBotUsageRoute>[0]; appPublisher: AppPublisher; whatChanged: WhatChangedDeps }) {
  const routes = [createXResearchInternalRoutes(deps.xResearch), createHelperToolRoutes(deps.helpers), createWhatChangedRoutes(deps.whatChanged), createMausBotNotificationRoutes(deps.notifications), createBotUsageRoute(deps.botUsage), createEngineLimitsRoutes(deps.engineLimits), createAppHostingInternalRoutes(deps.appPublisher)];
  return async (ctx: HelperToolContext & { threadId: string; url: URL; requireActive(): void }): Promise<typeof PASS | void> => {
    for (const route of routes) if (await route(ctx) !== PASS) return;
    return PASS;
  };
}
