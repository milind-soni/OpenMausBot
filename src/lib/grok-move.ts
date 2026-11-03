import { useSyncExternalStore } from "react";

import { engineReady } from "@/components/EngineLibrary";
import { prependComposerDraft } from "@/lib/drafts";
import { t } from "@/lib/i18n";
import { addTemplate } from "@/lib/template-add";
import { api, type Action, type AppSettingsSection, type Bot, type BotSettingsSection, type InstanceInfo } from "@/state/store";
import { GrokImportError, mergeGrokBots, parseGrokExport, routinesLeftOut, type GrokBot, type GrokMovePlan } from "../../shared/grok-import";
import type { LocaleKey } from "@/locales";

/** What the desktop app found on this computer. */
export interface GrokLook {
  files: Array<{ name: string; modifiedAt: number; text: string }>;
  bots: string[];
  routines: Record<string, string[]>;
}

export const NOTHING_FOUND: GrokLook = { files: [], bots: [], routines: {} };

export function lookForGrokBot(quiet = false): Promise<GrokLook> {
  return api<Partial<GrokLook> | null>(`/api/setup-import/grok${quiet ? "?quiet=1" : ""}`, { timeoutMs: 10_000 }).then(
    (look) => ({ files: Array.isArray(look?.files) ? look.files : [], bots: Array.isArray(look?.bots) ? look.bots : [], routines: look?.routines ?? {} }),
    () => NOTHING_FOUND,
  );
}

/** A refusal or an unreadable reply, in the person's words. */
export function grokErrorText(cause: unknown): string {
  if (!(cause instanceof GrokImportError)) return cause instanceof Error ? cause.message : String(cause);
  return t(`grokMove.error.${cause.code}` as LocaleKey, { keys: cause.keys.join(", ") });
}

export interface FoundExports {
  bots: GrokBot[];
  refused: Array<{ file: string; error: string }>;
}

/** One row per Bot however many files it wrote: a split export joins up, and a saved-twice file counts once. */
export function foundExports(files: GrokLook["files"]): FoundExports {
  const refused: FoundExports["refused"] = [];
  const bots = [...files].reverse().flatMap((file) => {
    try {
      return parseGrokExport(file.text);
    } catch (cause) {
      refused.push({ file: file.name, error: grokErrorText(cause) });
      return [];
    }
  });
  return { bots: mergeGrokBots(bots), refused };
}

/** Routines each Bot's chat announced that its export does not have. */
export function missingRoutines(bots: readonly GrokBot[], look: GrokLook): Array<{ bot: string; routines: string[] }> {
  return bots.flatMap((bot) => {
    const announced = Object.entries(look.routines).find(([name]) => name.toLowerCase() === bot.name.toLowerCase())?.[1] ?? [];
    const routines = routinesLeftOut(bot, announced);
    return routines.length ? [{ bot: bot.name, routines }] : [];
  });
}

export interface GrokMoved {
  plan: GrokMovePlan;
  bot: Bot;
  routineIds: string[];
  webhookIds: string[];
  /** Webhook routines whose paused automation could not be made: they join the ones to rebuild. */
  webhooksFailed: string[];
  servers: string[];
  serversSkipped: number;
}

/** Writes one plan: the package path for everything it can carry, then a paused webhook automation per webhook routine.
 * A failed automation leaves the bot in place and the routine in the list to rebuild. */
export async function moveGrokBot(plan: GrokMovePlan, dispatch: (action: Action) => void): Promise<GrokMoved> {
  const added = await addTemplate(plan.document, dispatch);
  const bot = added.first;
  if (!bot) throw new Error(t("grokMove.error.noBot"));
  const webhookIds: string[] = [];
  const webhooksFailed: string[] = [];
  for (const webhook of plan.webhooks) {
    try {
      const created = await api<{ webhook: { id: string } }>("/api/webhooks", {
        method: "POST",
        body: JSON.stringify({ name: webhook.name, prompt: webhook.prompt, botId: bot.id, enabled: false }),
      });
      if (!webhook.pausedThere) webhookIds.push(created.webhook.id);
    } catch {
      webhooksFailed.push(webhook.name);
    }
  }
  const routineIds = (added.routines ?? []).filter((_, index) => !plan.routines[index]?.pausedThere).map((routine) => routine.id);
  const connections = (added.connections ?? []) as Array<{ name: string }>;
  return {
    plan, bot, routineIds, webhookIds, webhooksFailed,
    servers: connections.map((connection) => connection.name),
    serversSkipped: plan.servers.length - connections.length,
  };
}

export type GrokMoveTarget =
  | { kind: "appSettings"; section: AppSettingsSection }
  | { kind: "plugins"; surface: "apps" | "mcp" }
  | { kind: "botSettings"; section: BotSettingsSection; botId: string }
  | { kind: "automations"; botId: string }
  | { kind: "chat"; bot: Bot; message: string };

export type GrokMoveRowId = "ai" | "signIn" | "appAccess" | "servers" | "skills" | "routines" | "webhooks" | "rebuild";

export interface GrokMoveRow {
  /** Stable across renders: what a tap marks as seen. */
  key: string;
  id: GrokMoveRowId;
  title: string;
  detail: string;
  target: GrokMoveTarget;
  done: boolean;
  /** What each routine to rebuild said, for the person to read here. */
  rebuild?: GrokMovePlan["rebuild"];
}

export interface GrokMoveFacts {
  instances: readonly InstanceInfo[];
  routines: ReadonlyArray<{ id: string; enabled: boolean }>;
  webhooks: ReadonlyArray<{ id: string; enabled: boolean }>;
  seen: ReadonlySet<string>;
}

/** Word for word in the chat message: the person reads it there before sending. Never sent for them. */
export function rebuildMessage(moved: GrokMoved): string {
  const named = moved.webhooksFailed.map((name) => moved.plan.webhooks.find((webhook) => webhook.name === name)!)
    .map((webhook) => ({ name: webhook.name, trigger: "webhook", details: webhook.details, when: "", instruction: webhook.prompt }));
  const routines = [...moved.plan.rebuild, ...named].map((routine) => [
    `- ${routine.name}`,
    routine.trigger ? `  ${t("grokMove.message.trigger", { trigger: routine.trigger })}` : "",
    routine.details || routine.when ? `  ${t("grokMove.message.details", { details: routine.details || routine.when })}` : "",
    `  ${routine.instruction.replace(/\n/g, "\n  ")}`,
  ].filter(Boolean).join("\n"));
  return `${t("grokMove.message.intro", { name: moved.bot.name })}\n\n${routines.join("\n\n")}`;
}

/** Only what still needs the person, each with the one place that does it. Rows they have dealt with stay, ticked. */
export function grokMoveRows(moved: readonly GrokMoved[], facts: GrokMoveFacts): GrokMoveRow[] {
  const rows: GrokMoveRow[] = [];
  const ready = facts.instances.filter(engineReady);
  if (facts.instances.length && !ready.length) {
    rows.push({ key: "ai", id: "ai", title: t("grokMove.row.ai"), detail: t("grokMove.row.aiDetail"), target: { kind: "appSettings", section: "engines" }, done: false });
  }
  const many = moved.length > 1;
  for (const item of moved) {
    const { plan, bot } = item;
    const row = (id: GrokMoveRowId, title: string, detail: string, target: GrokMoveTarget, done?: boolean, rebuild?: GrokMovePlan["rebuild"]) => {
      const key = `${bot.id}:${id}`;
      rows.push({ key, id, title: many ? `${bot.name}: ${title}` : title, detail, target, done: done ?? facts.seen.has(key), ...(rebuild ? { rebuild } : {}) });
    };
    if (plan.apps.length) {
      row("signIn", t("grokMove.row.signIn", { apps: plan.apps.join(", ") }), t("grokMove.row.signInDetail"), { kind: "plugins", surface: "apps" });
      row("appAccess", t("grokMove.row.appAccess", { name: bot.name }), t("grokMove.row.appAccessDetail"), { kind: "botSettings", section: "access", botId: bot.id });
    }
    if (item.servers.length) {
      const needs = [...new Set(plan.servers.flatMap((server) => server.values))];
      row("servers", t("grokMove.row.servers", { apps: plan.servers.map((server) => server.name).join(", ") }),
        needs.length ? t("grokMove.row.serversNeed", { values: needs.join(", ") }) : t("grokMove.row.serversDetail"), { kind: "plugins", surface: "mcp" });
    }
    if (plan.skills.length) {
      row("skills", t("grokMove.row.skills", { count: plan.skills.length }), t("grokMove.row.skillsDetail"), { kind: "botSettings", section: "skills", botId: bot.id });
    }
    if (item.routineIds.length) {
      const on = facts.routines.filter((routine) => item.routineIds.includes(routine.id) && routine.enabled).length;
      row("routines", t("grokMove.row.routines", { count: item.routineIds.length }), t("grokMove.row.routinesDetail"),
        { kind: "botSettings", section: "routines", botId: bot.id }, on === item.routineIds.length);
    }
    if (item.webhookIds.length) {
      const on = facts.webhooks.filter((webhook) => item.webhookIds.includes(webhook.id) && webhook.enabled).length;
      row("webhooks", t("grokMove.row.webhooks", { count: item.webhookIds.length }), t("grokMove.row.webhooksDetail"),
        { kind: "automations", botId: bot.id }, on === item.webhookIds.length);
    }
    const toRebuild = plan.rebuild.length + item.webhooksFailed.length;
    if (toRebuild) {
      row("rebuild", t("grokMove.row.rebuild", { count: toRebuild }), t("grokMove.row.rebuildDetail", { name: bot.name }),
        { kind: "chat", bot, message: rebuildMessage(item) }, undefined, plan.rebuild);
    }
  }
  return rows;
}

/** Goes to the row's place. The chat's message is only put in its composer. */
export function goToGrokMoveTarget(target: GrokMoveTarget, dispatch: (action: Action) => void): void {
  switch (target.kind) {
    case "appSettings": return dispatch({ type: "toggleAppSettings", open: true, section: target.section });
    case "plugins": return dispatch({ type: "togglePlugins", open: true, surface: target.surface });
    case "botSettings": return dispatch({ type: "toggleSettings", open: true, section: target.section, botId: target.botId });
    case "automations":
      dispatch({ type: "toggleAppSettings", open: false });
      return dispatch({ type: "showRoutines", botId: target.botId });
    case "chat":
      prependComposerDraft(`bot:${target.bot.id}:${target.bot.threadId}`, target.message);
      dispatch({ type: "toggleAppSettings", open: false });
      dispatch({ type: "showChat" });
      return dispatch({ type: "select", id: target.bot.id });
  }
}

export interface GrokMoveRequest {
  /** A reply already in hand, such as a file dropped on Templates. */
  reply?: string;
  /** After a first import, from a welcome screen that must now step aside. */
  onMoved?: (botId: string) => void;
}

let request: GrokMoveRequest | null = null;
const listeners = new Set<() => void>();
const publish = (next: GrokMoveRequest | null) => {
  request = next;
  for (const listener of listeners) listener();
};

export const openGrokMove = (next: GrokMoveRequest = {}) => publish(next);
export const closeGrokMove = () => publish(null);
export function useGrokMoveRequest(): GrokMoveRequest | null {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => request);
}
