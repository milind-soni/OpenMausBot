import { t } from "@/lib/i18n";
import { addTemplate } from "@/lib/template-add";
import { api, type Action, type Bot } from "@/state/store";
import type { LocaleKey } from "@/locales";
import { takeImportName } from "../../shared/import-name";
import { GrokImportError, grokMovePlan, mergeGrokBots, parseGrokExport, type GrokBot, type GrokMovePlan } from "../../shared/grok-import";

/** What the desktop app found on this computer. */
export interface GrokLook {
  files: Array<{ name: string; modifiedAt: number; text: string }>;
  bots: string[];
}

export const NOTHING_FOUND: GrokLook = { files: [], bots: [] };

export function lookForGrokBot(): Promise<GrokLook> {
  return api<Partial<GrokLook> | null>("/api/setup-import/grok", { timeoutMs: 10_000 }).then(
    (look) => ({ files: Array.isArray(look?.files) ? look.files : [], bots: Array.isArray(look?.bots) ? look.bots : [] }),
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

/** Every file found, joined by Bot: a split export comes together and a saved-twice one counts once. A refused file says
 * why and costs the others nothing. Oldest first, so the newest copy wins. */
export function foundExports(files: GrokLook["files"]): FoundExports {
  const refused: FoundExports["refused"] = [];
  const bots = [...files].sort((a, b) => a.modifiedAt - b.modifiedAt).flatMap((file) => {
    try {
      return parseGrokExport(file.text);
    } catch (cause) {
      refused.push({ file: file.name, error: grokErrorText(cause) });
      return [];
    }
  });
  return { bots: mergeGrokBots(bots), refused };
}

export interface GrokPreview {
  /** `addedAs`: the Bot's name here, numbered when it is taken. */
  plans: Array<GrokMovePlan & { addedAs: string }>;
  moved: string[];
  unreadable: string[];
}

export interface GrokPreviewFacts {
  bots: readonly Pick<Bot, "name" | "installedPackage">[];
  servers: ReadonlySet<string>;
  timeZone: string;
}

/** The whole plan, nothing written. A Bot already moved or that can't be read is named, and costs the others nothing. */
export function previewGrokMove(bots: readonly GrokBot[], facts: GrokPreviewFacts): GrokPreview {
  const installed = new Set(facts.bots.flatMap((bot) => bot.installedPackage?.id ?? []));
  const names = new Set(facts.bots.map((bot) => bot.name.trim().toLowerCase()));
  const servers = new Set(facts.servers);
  const preview: GrokPreview = { plans: [], moved: [], unreadable: [] };
  for (const bot of bots) {
    try {
      const plan = grokMovePlan(bot, { timeZone: facts.timeZone, takenServers: servers });
      if (installed.has(plan.packageId)) {
        preview.moved.push(plan.name);
        continue;
      }
      for (const connection of plan.document.package.connections ?? []) servers.add(connection.key);
      preview.plans.push({ ...plan, addedAs: takeImportName(plan.name, names) });
    } catch {
      preview.unreadable.push(bot.name);
    }
  }
  return preview;
}

export interface GrokMovedBot {
  name: string;
  skills: number;
  /** Skills left off: the skill scan flagged them, or they could not be switched on. */
  skillsOff: string[];
  routines: number;
  notes: number;
  memories: number;
  apps: number;
}

export interface GrokReport {
  bots: GrokMovedBot[];
  moved: string[];
  unreadable: string[];
  failed: string[];
}

/** Imports each plan through the package path, then switches on its skills. One Bot failing is named and the rest carry on. */
export async function runGrokMove(preview: GrokPreview, dispatch: (action: Action) => void): Promise<GrokReport> {
  const report: GrokReport = { bots: [], moved: preview.moved, unreadable: preview.unreadable, failed: [] };
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
