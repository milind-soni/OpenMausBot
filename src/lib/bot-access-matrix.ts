// No bulk route on purpose: every cell goes through the bot's own PATCH, so each per-bot server check still applies.
import { botAppScope, withBotApp } from "@/lib/bot-app-access";
import { connectorServiceAccess, isConnectorToolsRecordShape, withServiceGrant } from "@/lib/connector-grants";
import { HIGHLEVEL_SLUG } from "@/lib/highlevel-sign-in";
import { t } from "@/lib/i18n";
import type { BotUpdatePatch } from "@/state/bot-patch-queue";
import type { Bot, InstanceInfo } from "@/state/store";
import { approvalModeFor } from "../../shared/approval-mode";
import type { ConnectorScope, ConnectorScopes } from "../../shared/connector-scopes";
import { DEFAULT_OUTBOUND_POLICY, type OutboundPolicy } from "../../shared/outbound";
import { planTeamChange, TEAM_APPROVAL_MODES, type TeamApprovalMode, type TeamPlanRow } from "./team-bulk-settings";

/** What one bot may do with one connected app, as the matrix shows it. */
export type AppAccess = "all" | "read" | "some" | "none" | "custom" | "unsupported";
export type AppAccessChoice = "all" | "read" | "none";

export function accessBots(bots: readonly Bot[]): Bot[] {
  return bots.filter((bot) => !bot.hidden);
}

export function botCanUseApp(bot: Bot, instances: readonly InstanceInfo[], slug: string): boolean {
  const capabilities = instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.capabilities;
  return slug === HIGHLEVEL_SLUG ? capabilities?.highlevelMcp === true : capabilities?.composioMcp === true;
}

/** HighLevel is scoped by read/write only; Composio apps also carry per-tool grants. */
const hasToolGrants = (slug: string) => slug !== HIGHLEVEL_SLUG;

export function appAccess(bot: Bot, instances: readonly InstanceInfo[], slug: string): AppAccess {
  if (!botCanUseApp(bot, instances, slug)) return "unsupported";
  const scope = botAppScope(bot, slug);
  if (!scope) return "none";
  if (hasToolGrants(slug)) {
    const grant = connectorServiceAccess(bot.connectorTools, slug);
    if (!grant.editable) return "custom";
    if (grant.level === "none") return "none";
    if (grant.level === "partial") return "some";
  }
  return scope === "read" ? "read" : "all";
}

/**
 * The smallest change that gives `bot` exactly `choice` on `slug` and leaves every other app as the matrix shows it.
 * Null when there is nothing to change, or the bot's record is one this build cannot edit safely.
 */
export function appAccessPatch(
  bot: Bot,
  instances: readonly InstanceInfo[],
  slug: string,
  choice: AppAccessChoice,
  connected: readonly string[],
): BotUpdatePatch | null {
  const current = appAccess(bot, instances, slug);
  if (current === "unsupported" || current === "custom" || current === choice) return null;
  const record = bot.connectorTools;
  const hasRecord = record !== undefined && record !== null;
  if (hasRecord && !isConnectorToolsRecordShape(record)) return null;
  const patch: BotUpdatePatch = {};

  if (choice === "none") {
    if (bot.composio === false) return null;
    if (bot.connectorScopes?.apps[slug]) {
      const apps = { ...bot.connectorScopes.apps };
      delete apps[slug];
      patch.connectorScopes = { apps };
    }
    if (hasToolGrants(slug) && hasRecord && record[slug]) patch.connectorTools = withServiceGrant(record, slug, null);
    if (!bot.connectorScopes && (!hasRecord || !hasToolGrants(slug))) {
      patch.connectorScopes = withBotApp(undefined, connected, slug, false);
    }
    return Object.keys(patch).length ? patch : null;
  }

  const scope: ConnectorScope = choice === "read" ? "read" : "write";
  if (bot.composio === false) {
    // Every app showed as off: the other apps stay off once connected apps come on.
    patch.composio = true;
    patch.connectorScopes = { apps: { [slug]: scope } };
  } else if (bot.connectorScopes) {
    if (bot.connectorScopes.apps[slug] !== scope) patch.connectorScopes = { apps: { ...bot.connectorScopes.apps, [slug]: scope } };
  } else if (scope === "read") {
    const apps: ConnectorScopes["apps"] = {};
    for (const other of connected) apps[other] = "write";
    apps[slug] = "read";
    patch.connectorScopes = { apps };
  }
  if (hasToolGrants(slug) && hasRecord && record[slug]?.tools !== "*") {
    patch.connectorTools = withServiceGrant(record, slug, { tools: "*" });
  }
  return Object.keys(patch).length ? patch : null;
}

export function outboundOf(bot: Bot): OutboundPolicy {
  return bot.outbound ?? DEFAULT_OUTBOUND_POLICY;
}

export function outboundPatch(bot: Bot, policy: OutboundPolicy["policy"]): BotUpdatePatch | null {
  const current = outboundOf(bot);
  return current.policy === policy ? null : { outbound: { policy, dailyCap: current.dailyCap } };
}

function rowFor(bot: Bot, patch: BotUpdatePatch | null, skip?: string): TeamPlanRow {
  if (skip) return { bot, status: "skip", reason: skip };
  return patch ? { bot, status: "apply", patch } : { bot, status: "unchanged" };
}

export function planAppForAll(
  bots: readonly Bot[],
  instances: readonly InstanceInfo[],
  slug: string,
  choice: AppAccessChoice,
  connected: readonly string[],
): TeamPlanRow[] {
  return bots.map((bot) => {
    const access = appAccess(bot, instances, slug);
    if (access === "unsupported") return rowFor(bot, null, t("botAccessMatrix.skip.unsupported"));
    if (access === "custom") return rowFor(bot, null, t("botAccessMatrix.skip.custom"));
    return rowFor(bot, appAccessPatch(bot, instances, slug, choice, connected));
  });
}

export function planOutboundForAll(bots: readonly Bot[], policy: OutboundPolicy["policy"]): TeamPlanRow[] {
  return bots.map((bot) => rowFor(bot, outboundPatch(bot, policy)));
}

export function planApprovalForAll(bots: readonly Bot[], instances: readonly InstanceInfo[], mode: TeamApprovalMode): TeamPlanRow[] {
  return planTeamChange(bots, instances, { kind: "approval", mode });
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Gives every other bot the source's connected apps, sending rule and approval level. Custom is granted per bot, so it
 * is neither copied from the source nor replaced on a target; a level a target cannot take (busy, unsupported by its
 * engine) also leaves the target's own level in place.
 */
export function planCopyAccess(source: Bot, bots: readonly Bot[], instances: readonly InstanceInfo[]): TeamPlanRow[] {
  const sourceMode = approvalModeFor(source);
  const copyable = (TEAM_APPROVAL_MODES as readonly string[]).includes(sourceMode);
  return bots.filter((bot) => bot.id !== source.id).map((bot) => {
    const patch: BotUpdatePatch = {};
    if ((source.composio !== false) !== (bot.composio !== false)) patch.composio = source.composio !== false;
    if (!sameJson(source.connectorTools, bot.connectorTools)) patch.connectorTools = structuredClone(source.connectorTools ?? null);
    if (!sameJson(source.connectorScopes, bot.connectorScopes)) patch.connectorScopes = structuredClone(source.connectorScopes ?? null);
    if (!sameJson(outboundOf(source), outboundOf(bot))) patch.outbound = { ...outboundOf(source) };
    let approvalSkip: string | undefined;
    if (!copyable || approvalModeFor(bot) === "custom") approvalSkip = t("botAccessMatrix.skip.customApproval");
    else {
      const [approval] = planTeamChange([bot], instances, { kind: "approval", mode: sourceMode as TeamApprovalMode });
      if (approval?.status === "apply") Object.assign(patch, approval.patch);
      else if (approval?.status === "skip") approvalSkip = approval.reason;
    }
    if (Object.keys(patch).length === 0) return rowFor(bot, null, approvalSkip);
    return rowFor(bot, patch);
  });
}
