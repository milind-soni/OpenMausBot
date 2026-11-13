import { t } from "@/lib/i18n";
import { addTemplate } from "@/lib/template-add";
import { api, type Action, type Bot } from "@/state/store";
import type { LocaleKey } from "@/locales";
import { takeImportName } from "../../shared/import-name";
import { BotImportError, type ImportedBot, type BotMovePlan } from "../../shared/bot-import";

/** What the desktop app found on this computer. */
export interface BotLook {
  files: Array<{ name: string; modifiedAt: number; text: string }>;
  bots: string[];
}

export const NOTHING_FOUND: BotLook = { files: [], bots: [] };

/** A refusal or an unreadable reply, in the person's words. */
export function botImportErrorText(cause: unknown): string {
  if (!(cause instanceof BotImportError)) return cause instanceof Error ? cause.message : String(cause);
  return t(`grokMove.error.${cause.code}` as LocaleKey, { keys: cause.keys.join(", ") });
}

export interface BotPreview {
  /** `addedAs`: the Bot's name here, numbered when it is taken. */
  plans: Array<BotMovePlan & { addedAs: string }>;
  moved: string[];
  unreadable: string[];
}

export interface BotPreviewFacts {
  bots: readonly Pick<Bot, "name" | "installedPackage">[];
  servers: ReadonlySet<string>;
  timeZone: string;
}

/** The whole plan, nothing written. A Bot already moved or that can't be read is named, and costs the others nothing. */
export function previewBotMove(bots: readonly ImportedBot[], facts: BotPreviewFacts, planBot: (bot: ImportedBot, options: { timeZone: string; takenServers: ReadonlySet<string> }) => BotMovePlan): BotPreview {
  const installed = new Set(facts.bots.flatMap((bot) => bot.installedPackage?.id ?? []));
  const names = new Set(facts.bots.map((bot) => bot.name.trim().toLowerCase()));
  const servers = new Set(facts.servers);
  const preview: BotPreview = { plans: [], moved: [], unreadable: [] };
  for (const bot of bots) {
    try {
      const plan = planBot(bot, { timeZone: facts.timeZone, takenServers: servers });
      if (installed.has(plan.packageId)) {
        preview.moved.push(plan.name);
        continue;
      }
      for (const connection of plan.document.package.connections ?? []) servers.add(connection.key);
      preview.plans.push({ ...plan, addedAs: takeImportName(plan.name, names) });
    } catch (cause) {
      if (cause instanceof BotImportError && cause.code === "memoryTooLarge") throw cause;
      preview.unreadable.push(bot.name);
    }
  }
  return preview;
}

export interface MovedBot {
  name: string;
  skills: number;
  /** Skills left off: the skill scan flagged them, or they could not be switched on. */
  skillsOff: string[];
  routines: number;
  notes: number;
  memories: number;
  apps: number;
}

export interface BotMoveReport {
  bots: MovedBot[];
  moved: string[];
  unreadable: string[];
  failed: string[];
}

/** Imports each plan through the package path, then switches on its skills. One Bot failing is named and the rest carry on. */
export async function runBotMove(preview: BotPreview, dispatch: (action: Action) => void): Promise<BotMoveReport> {
  const report: BotMoveReport = { bots: [], moved: preview.moved, unreadable: preview.unreadable, failed: [] };
  for (const plan of preview.plans) {
    try {
      const bot = (await addTemplate(plan.document, dispatch)).first;
      if (!bot) throw new Error("no bot");
      const skillsOff: string[] = [];
      for (const skill of plan.skills) {
        const on = skill.on && await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.folder)}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) }).then(() => true, () => false);
        if (!on) skillsOff.push(skill.name);
      }
      report.bots.push({ name: bot.name, skills: plan.skills.length, skillsOff, routines: plan.routines, notes: plan.notes, memories: plan.memories, apps: plan.apps });
    } catch {
      report.failed.push(plan.name);
    }
  }
  return report;
}
