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

/** The MausBot bot in Grok Bot: it sends each Bot's setup to the link below. */
export const MAUSBOT_GROK_TEMPLATE_URL = "https://x.ai/bot/3i4Tvjckmdk05UwntFeNo";

/** A task Grok Bot handed off through the link, as the app shows it. */
export interface GrokHandoff {
  title: string;
  state: "working" | "needs_you" | "done" | "failed" | "stopped";
  botId: string;
  threadId: string;
  at: number;
}

/** The link Grok Bot sends Bots and tasks to, when this app can make one, what arrived through it and the last handoffs. */
export interface GrokConnector {
  available: boolean;
  connectorUrl?: string;
  /** The link was made and no longer works; what arrived through it is still here. */
  stopped: boolean;
  /** A link is opening: asked for, or coming back on as the app starts. */
  opening: boolean;
  /** The link came back on with a new address as the app started; until the person copies it or closes the notice. */
  changed: boolean;
  arrived: GrokLook["files"];
  /** The last arrival's number: the next look asks for what came after it. */
  seq: number;
  handoffs: GrokHandoff[];
}

/** A look that asks for no arrivals. */
export const NO_ARRIVALS = Number.MAX_SAFE_INTEGER;

/** POST opens the link (or gives the one already open; a new one takes a few seconds) or, with `taken`, lets go of what
 * was imported up to that number; GET looks for what arrived after `after`; DELETE turns the link off. */
export async function grokConnector(method: "GET" | "POST" | "DELETE", after = 0, taken?: number): Promise<GrokConnector> {
  const answer = await api<{ available?: boolean; connectorUrl?: string; stopped?: boolean; opening?: boolean; changed?: boolean; arrived?: Array<{ seq: number; at: number; text: string }>; handoffs?: GrokHandoff[] } | null>(
    `/api/setup-import/grok/connector${method === "GET" && after ? `?after=${after}` : ""}`,
    { method, timeoutMs: 60_000, ...(method === "POST" ? { body: JSON.stringify(taken === undefined ? {} : { taken }) } : {}) },
  );
  const arrived = Array.isArray(answer?.arrived) ? answer.arrived : [];
  return {
    available: answer?.available === true,
    ...(typeof answer?.connectorUrl === "string" ? { connectorUrl: answer.connectorUrl } : {}),
    stopped: answer?.stopped === true,
    opening: answer?.opening === true,
    changed: answer?.changed === true,
    arrived: arrived.map((item) => ({ name: String(item.seq), modifiedAt: item.at, text: item.text })),
    seq: arrived.reduce((last, item) => Math.max(last, item.seq), taken ?? after),
    handoffs: Array.isArray(answer?.handoffs) ? answer.handoffs : [],
  };
}

/** The person copied the link that came back on, or closed the notice saying it changed. */
export function grokLinkSeen(): Promise<unknown> {
  return api("/api/setup-import/grok/connector", { method: "POST", body: JSON.stringify({ seen: true }) });
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
