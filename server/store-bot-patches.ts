import type { BotProfilePatch } from "./bot-profile.ts";
import { parseConnectorTools } from "./connector-tools.ts";
import type { BotRecord } from "./store.ts";
import { mascotStateForBody, mascotStateForProfile } from "./mascot-profile-store.ts";
import { parseToolScope, toolScopeWidens } from "../shared/tool-scope.ts";
import { soulHash } from "./bot-folder.ts";

export class BotAppearanceRevisionTracker {
  private revisions = new WeakMap<BotRecord, number>();

  get(bot: BotRecord): number {
    return this.revisions.get(bot) ?? 0;
  }

  record(bot: BotRecord): void {
    this.revisions.set(bot, this.get(bot) + 1);
  }

  recordChoice(bot: BotRecord, patch: Partial<BotRecord>): void {
    const fields = ["avatarUrl", "avatarCrop", "mascotBody", "mascotProfile", "color", "mascotExpression"] as const;
    if (fields.some((field) => Object.hasOwn(patch, field))) this.record(bot);
  }
}

export function normalizeBotPatch(bot: BotRecord, input: Partial<BotRecord>) {
  let patch = input;
  if (patch.mascotProfile !== undefined) {
    patch = { ...patch, ...mascotStateForProfile(patch.mascotProfile) };
  } else if (patch.mascotBody !== undefined) {
    patch = { ...patch, ...mascotStateForBody(bot.mascotProfile, patch.mascotBody) };
  }
  if (patch.connectorTools !== undefined) {
    const parsed = parseConnectorTools(patch.connectorTools);
    if (!parsed.ok) throw new Error(parsed.error);
    patch = { ...patch, connectorTools: parsed.grants };
  }
  if (Object.hasOwn(patch, "toolScope")) {
    const parsed = parseToolScope(patch.toolScope);
    if (!parsed.ok) throw new Error(parsed.error);
    patch = { ...patch, toolScope: parsed.scope };
  }
  const wideningToolScope = Object.hasOwn(patch, "toolScope") && toolScopeWidens(bot.toolScope, patch.toolScope);
  const nextToolScope = patch.toolScope;
  if (wideningToolScope) {
    patch = { ...patch };
    delete patch.toolScope;
  }
  return { patch, wideningToolScope, nextToolScope };
}

export function applyBotProfilePatch(
  bot: BotRecord,
  patch: BotProfilePatch & Partial<Pick<BotRecord, "cwd" | "lastProfileRequestId">>,
): BotRecord {
  const next = { ...bot, ...patch };
  if (patch.mascotBody !== undefined) Object.assign(next, mascotStateForBody(bot.mascotProfile, patch.mascotBody));
  if (patch.soul !== undefined) {
    next.soulHash = soulHash(patch.soul);
    next.soulDrift = false;
  }
  return next;
}
