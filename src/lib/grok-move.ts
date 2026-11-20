import { t } from "@/lib/i18n";
import { addTemplate } from "@/lib/template-add";
import { api, type Action, type Bot } from "@/state/store";
import type { LocaleKey } from "@/locales";
import { takeImportName } from "../../shared/import-name";
import { GROK_HISTORY_REASONS, GrokImportError, grokMovePlan, mergeGrokBots, parseGrokExport, type GrokBot, type GrokHistoryReason, type GrokMovePlan } from "../../shared/grok-import";

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

/** The MausBot bot in Grok Bot: it sends each Bot's setup to the link below. */
export const MAUSBOT_GROK_TEMPLATE_URL = "https://x.ai/bot/3i4Tvjckmdk05UwntFeNo";

/** The link Grok Bot sends Bots to, when this app can make one, and what arrived through it. */
export interface GrokConnector {
  available: boolean;
  connectorUrl?: string;
  /** The link was made and no longer works; what arrived through it is still here. */
  stopped: boolean;
  arrived: GrokLook["files"];
  /** The last arrival's number: the next look asks for what came after it. */
  seq: number;
}

/** POST opens the link (or gives the one already open; a new one takes a few seconds), GET looks for what arrived after `after`, DELETE ends it. */
export async function grokConnector(method: "GET" | "POST" | "DELETE", after = 0): Promise<GrokConnector> {
  const answer = await api<{ available?: boolean; connectorUrl?: string; stopped?: boolean; arrived?: Array<{ seq: number; at: number; text: string }> } | null>(
    `/api/setup-import/grok/connector${method === "GET" && after ? `?after=${after}` : ""}`,
    { method, timeoutMs: 60_000, ...(method === "POST" ? { body: "{}" } : {}) },
  );
  const arrived = Array.isArray(answer?.arrived) ? answer.arrived : [];
  return {
    available: answer?.available === true,
    ...(typeof answer?.connectorUrl === "string" ? { connectorUrl: answer.connectorUrl } : {}),
    stopped: answer?.stopped === true,
    arrived: arrived.map((item) => ({ name: String(item.seq), modifiedAt: item.at, text: item.text })),
    seq: arrived.reduce((last, item) => Math.max(last, item.seq), after),
  };
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
  /** Bots moved before: `botId` is the bot here, so the move can still bring its chat. */
  moved: Array<{ name: string; botId: string }>;
  unreadable: string[];
}

export interface GrokPreviewFacts {
  bots: readonly Pick<Bot, "id" | "name" | "installedPackage">[];
  servers: ReadonlySet<string>;
  timeZone: string;
}

/** The whole plan, nothing written. A Bot already moved or that can't be read is named, and costs the others nothing. */
export function previewGrokMove(bots: readonly GrokBot[], facts: GrokPreviewFacts): GrokPreview {
  const installed = new Map(facts.bots.flatMap((bot) => bot.installedPackage ? [[bot.installedPackage.id, bot.id] as const] : []));
  const names = new Set(facts.bots.map((bot) => bot.name.trim().toLowerCase()));
  const servers = new Set(facts.servers);
  const preview: GrokPreview = { plans: [], moved: [], unreadable: [] };
  for (const bot of bots) {
    try {
      const plan = grokMovePlan(bot, { timeZone: facts.timeZone, takenServers: servers });
      const here = installed.get(plan.packageId);
      if (here) {
        preview.moved.push({ name: plan.name, botId: here });
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

/** A moved Bot's chat: how many messages came over, or why none did ("failed": the request itself didn't get an answer). */
export type GrokHistory = { messages: number } | { reason: GrokHistoryReason | "failed" };

async function bringHistory(botId: string, grokName: string): Promise<GrokHistory> {
  const answer = await api<{ messages?: unknown; reason?: unknown } | null>("/api/setup-import/grok/history",
    { method: "POST", body: JSON.stringify({ botId, grokName }), timeoutMs: 60_000 }).catch(() => null);
  if (typeof answer?.messages === "number") return { messages: answer.messages };
  return { reason: GROK_HISTORY_REASONS.find((reason) => reason === answer?.reason) ?? "failed" };
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
  /** Absent where the move can't look at this computer: a browser, a paired device or a Cloud. */
  history?: GrokHistory;
}

export interface GrokReport {
  bots: GrokMovedBot[];
  /** Bots moved before; `history` is their chat, brought now on the desktop app. */
  moved: Array<{ name: string; history?: GrokHistory }>;
  unreadable: string[];
  failed: string[];
}

/** Imports each plan through the package path, switches on its skills and, on the desktop app (`local`), brings its chat
 * over from the Grok Bot app there. One Bot failing is named and the rest carry on. */
export async function runGrokMove(preview: GrokPreview, dispatch: (action: Action) => void, local = false): Promise<GrokReport> {
  const report: GrokReport = { bots: [], moved: [], unreadable: preview.unreadable, failed: [] };
  for (const { name, botId } of preview.moved) {
    const history = local ? await bringHistory(botId, name) : undefined;
    report.moved.push({ name, ...(history ? { history } : {}) });
  }
  for (const plan of preview.plans) {
    try {
      const bot = (await addTemplate(plan.document, dispatch)).first;
      if (!bot) throw new Error("no bot");
      const skillsOff: string[] = [];
      for (const skill of plan.skills) {
        const on = skill.on && await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.folder)}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) }).then(() => true, () => false);
        if (!on) skillsOff.push(skill.name);
      }
      const history = local ? await bringHistory(bot.id, plan.name) : undefined;
      report.bots.push({ name: bot.name, skills: plan.skills.length, skillsOff, routines: plan.routines, notes: plan.notes, memories: plan.memories, apps: plan.apps,
        ...(history ? { history } : {}) });
    } catch {
      report.failed.push(plan.name);
    }
  }
  return report;
}
