import { t } from "@/lib/i18n";
import { addTemplate } from "@/lib/template-add";
import { api, type Action, type Bot } from "@/state/store";
import type { LocaleKey } from "@/locales";
import { takeImportName } from "../../shared/import-name";
import {
  GrokImportError, grokMovePlan, grokRedactions, mergeGrokBots, parseGrokExport, routinesLeftOut, type GrokBot, type GrokItem, type GrokMovePlan,
} from "../../shared/grok-import";

/** What the desktop app found on this computer. */
export interface GrokLook {
  files: Array<{ name: string; modifiedAt: number; text: string }>;
  bots: string[];
  routines: Record<string, string[]>;
}

export const NOTHING_FOUND: GrokLook = { files: [], bots: [], routines: {} };

export function lookForGrokBot(): Promise<GrokLook> {
  return api<Partial<GrokLook> | null>("/api/setup-import/grok", { timeoutMs: 10_000 }).then(
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
  plans: GrokMovePlan[];
  /** Lines for what could not be planned or is here already. */
  items: GrokItem[];
  warnings: string[];
}

export interface GrokPreviewFacts {
  look: GrokLook;
  bots: readonly Pick<Bot, "name" | "installedPackage">[];
  servers: ReadonlySet<string>;
  timeZone: string;
}

/** The whole plan, nothing written. A Bot already moved is a conflict, a Bot that can't be read an error of its own. */
export function previewGrokMove(bots: readonly GrokBot[], facts: GrokPreviewFacts): GrokPreview {
  const moved = new Set(facts.bots.flatMap((bot) => bot.installedPackage?.id ?? []));
  const names = new Set(facts.bots.map((bot) => bot.name.trim().toLowerCase()));
  const servers = new Set(facts.servers);
  const plans: GrokMovePlan[] = [];
  const items: GrokItem[] = [];
  for (const bot of bots) {
    try {
      const plan = grokMovePlan(bot, { timeZone: facts.timeZone, takenServers: servers });
      if (moved.has(plan.packageId)) {
        items.push({ kind: "bot", name: plan.name, status: "conflict", reason: "alreadyMoved" });
        continue;
      }
      for (const connection of plan.document.package.connections ?? []) servers.add(connection.key);
      const taken = takeImportName(plan.name, names);
      if (taken !== plan.name) plan.items[0] = { ...plan.items[0]!, reason: "renamed", values: { name: taken } };
      plans.push(plan);
    } catch (cause) {
      items.push({ kind: "bot", name: bot.name, status: "error", reason: "botFailed", values: { error: grokErrorText(cause) } });
    }
  }
  const named = new Set(bots.map((bot) => bot.name.toLowerCase()));
  const notExported = facts.look.bots.filter((name) => !named.has(name.toLowerCase()) && !facts.bots.some((bot) => bot.installedPackage?.name.toLowerCase() === name.toLowerCase()));
  const redacted = bots.reduce((total, bot) => total + grokRedactions(bot), 0);
  const warnings = [
    ...(notExported.length ? [t("grokMove.warning.notExported", { names: notExported.join(", ") })] : []),
    ...bots.flatMap((bot) => {
      const announced = Object.entries(facts.look.routines).find(([name]) => name.toLowerCase() === bot.name.toLowerCase())?.[1] ?? [];
      const routines = routinesLeftOut(bot, announced);
      return routines.length ? [t("grokMove.warning.routinesLeftOut", { bot: bot.name, routines: routines.join(", ") })] : [];
    }),
    ...(redacted ? [t("grokMove.warning.redacted", { count: redacted })] : []),
  ];
  return { plans, items, warnings };
}

export interface GrokReport {
  items: GrokItem[];
  warnings: string[];
  /** The routines now paused here, for the one next step. */
  routines: string[];
}

/** Imports each plan through the package path, then switches on its skills. One Bot failing gets its own error line. */
export async function runGrokMove(preview: GrokPreview, dispatch: (action: Action) => void): Promise<GrokReport> {
  const items = [...preview.items];
  const routines: string[] = [];
  for (const plan of preview.plans) {
    try {
      const added = await addTemplate(plan.document, dispatch);
      const bot = added.first;
      if (!bot) throw new Error(t("grokMove.error.noBot"));
      const stillOff = new Set<string>();
      for (const skill of plan.skillsOn) {
        await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill)}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) }).catch(() => stillOff.add(skill));
      }
      const refused = new Set((plan.document.package.connections ?? []).map((connection) => connection.label));
      for (const connection of (added.connections ?? []) as Array<{ label: string }>) refused.delete(connection.label);
      items.push(...plan.items.map((item): GrokItem => {
        if (item.kind === "app" && item.status === "imported" && refused.has(item.name)) return { kind: "app", name: item.name, status: "skipped", reason: "serverRefused" };
        return item.skill && stillOff.has(item.skill) ? { ...item, reason: "skillStillOff" } : item;
      }));
      routines.push(...(added.routines ?? []).map((routine) => routine.name));
    } catch (cause) {
      items.push({ kind: "bot", name: plan.name, status: "error", reason: "botFailed", values: { error: grokErrorText(cause) } });
    }
  }
  return { items, warnings: preview.warnings, routines };
}
