import { t } from "@/lib/i18n";
import { addTemplate } from "@/lib/template-add";
import { api, type Action, type Bot } from "@/state/store";
import type { LocaleKey } from "@/locales";
import { takeImportName } from "../../shared/import-name";
import { GROK_HISTORY_REASONS, GrokImportError, grokMovePlan, mergeGrokBots, parseGrokExport, type GrokAssetsAnswer, type GrokBot, type GrokHistoryReason, type GrokMovePlan } from "../../shared/grok-import";

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

/** `elsewhere`: another copy of the app took the link, and this one stays away until asked to take it back. */
export type GrokReach = "connecting" | "connected" | "elsewhere";

/** The link Grok Bot sends Bots and tasks to, when this app can have one, what arrived through it and the last handoffs. */
export interface GrokConnector {
  available: boolean;
  /** While the connector is on: its link, the same for as long as it stays on. */
  connectorUrl?: string;
  /** While the connector is on: whether Grok Bot's calls reach this app now. */
  reach?: GrokReach;
  arrived: GrokLook["files"];
  /** Every page and file waiting to be imported: whose it is and its title or path, never its content. */
  assets: GrokAsset[];
  /** The last arrival's number: the next look asks for what came after it. */
  seq: number;
  handoffs: GrokHandoff[];
}

export interface GrokAsset { kind: "page" | "file"; bot: string; name: string }

/** A look that asks for no arrivals. */
export const NO_ARRIVALS = Number.MAX_SAFE_INTEGER;

const REACHES: readonly string[] = ["connecting", "connected", "elsewhere"] satisfies GrokReach[];

/** POST turns the link on (or gives the one already on, or takes it back from another copy of the app) or, with `taken`,
 * lets go of what was imported up to that number; GET looks for what arrived after `after`; DELETE turns the link off. */
export async function grokConnector(method: "GET" | "POST" | "DELETE", after = 0, taken?: number): Promise<GrokConnector> {
  const answer = await api<{ available?: boolean; link?: { url?: unknown; reach?: unknown }; arrived?: Array<{ seq: number; at: number; text: string }>; assets?: GrokAsset[]; handoffs?: GrokHandoff[] } | null>(
    `/api/setup-import/grok/connector${method === "GET" && after ? `?after=${after}` : ""}`,
    { method, timeoutMs: 60_000, ...(method === "POST" ? { body: JSON.stringify(taken === undefined ? {} : { taken }) } : {}) },
  );
  const arrived = Array.isArray(answer?.arrived) ? answer.arrived : [];
  const link = answer?.link;
  return {
    available: answer?.available === true,
    ...(typeof link?.url === "string" && typeof link.reach === "string" && REACHES.includes(link.reach) ? { connectorUrl: link.url, reach: link.reach as GrokReach } : {}),
    arrived: arrived.map((item) => ({ name: String(item.seq), modifiedAt: item.at, text: item.text })),
    assets: Array.isArray(answer?.assets) ? answer.assets.map(({ kind, bot, name }) => ({ kind, bot, name })) : [],
    seq: arrived.reduce((last, item) => Math.max(last, item.seq), taken ?? after),
    handoffs: Array.isArray(answer?.handoffs) ? answer.handoffs : [],
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

/** What arrived through the link for one Bot: its pages by title, and how many files. */
export interface GrokWaiting { pages: string[]; files: number }

export interface GrokPreview {
  /** `addedAs`: the Bot's name here, numbered when it is taken. */
  plans: Array<GrokMovePlan & { addedAs: string } & GrokWaiting>;
  /** Bots moved before: `botId` is the bot here, so the move can still bring its chat, pages and files. */
  moved: Array<{ name: string; botId: string } & GrokWaiting>;
  unreadable: string[];
  /** Bots whose pages or files arrived before their setup: nothing of theirs is imported until it does. */
  noSetup: string[];
}

export interface GrokPreviewFacts {
  bots: readonly Pick<Bot, "id" | "name" | "installedPackage">[];
  servers: ReadonlySet<string>;
  timeZone: string;
  assets?: readonly GrokAsset[];
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** The bot added from a Bot whose setup is no longer waiting: an installed bot that carries the Bot's name. */
const movedEarlier = (bots: GrokPreviewFacts["bots"], grokName: string) => bots.find((bot) => bot.installedPackage && sameName(bot.name, grokName));

/** The whole plan, nothing written. A Bot already moved or that can't be read is named, and costs the others nothing. */
export function previewGrokMove(bots: readonly GrokBot[], facts: GrokPreviewFacts): GrokPreview {
  const installed = new Map(facts.bots.flatMap((bot) => bot.installedPackage ? [[bot.installedPackage.id, bot.id] as const] : []));
  const names = new Set(facts.bots.map((bot) => bot.name.trim().toLowerCase()));
  const servers = new Set(facts.servers);
  const preview: GrokPreview = { plans: [], moved: [], unreadable: [], noSetup: [] };
  const assets = facts.assets ?? [];
  const waiting = (name: string): GrokWaiting => {
    const own = assets.filter((asset) => sameName(asset.bot, name));
    return { pages: own.filter((asset) => asset.kind === "page").map((asset) => asset.name), files: own.filter((asset) => asset.kind === "file").length };
  };
  for (const bot of bots) {
    try {
      const plan = grokMovePlan(bot, { timeZone: facts.timeZone, takenServers: servers });
      const here = installed.get(plan.packageId);
      if (here) {
        preview.moved.push({ name: plan.name, botId: here, ...waiting(plan.name) });
        continue;
      }
      for (const connection of plan.document.package.connections ?? []) servers.add(connection.key);
      preview.plans.push({ ...plan, addedAs: takeImportName(plan.name, names), ...waiting(plan.name) });
    } catch {
      preview.unreadable.push(bot.name);
    }
  }
  for (const { bot: name } of assets) {
    if ([...preview.plans, ...preview.moved].some((plan) => sameName(plan.name, name)) || preview.noSetup.some((other) => sameName(other, name))) continue;
    const here = movedEarlier(facts.bots, name);
    if (here) preview.moved.push({ name, botId: here.id, ...waiting(name) });
    else preview.noSetup.push(name);
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

/** A moved Bot's pages and files: how many came over and which could not, or "failed" when the request got no answer. */
export type GrokBrought = GrokAssetsAnswer | { reason: "failed" };

async function bringAssets(botId: string, grokName: string): Promise<GrokBrought> {
  const answer = await api<Partial<GrokAssetsAnswer> | null>("/api/setup-import/grok/assets",
    { method: "POST", body: JSON.stringify({ botId, grokName }), timeoutMs: 120_000 }).catch(() => null);
  if (typeof answer?.pages !== "number" || typeof answer.files !== "number") return { reason: "failed" };
  return { pages: answer.pages, files: answer.files, skipped: Array.isArray(answer.skipped) ? answer.skipped : [] };
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
  /** Absent when nothing of the Bot's arrived through the link. */
  brought?: GrokBrought;
}

export interface GrokReport {
  bots: GrokMovedBot[];
  /** Bots moved before; `history` is their chat and `brought` their pages and files, brought now on the desktop app. */
  moved: Array<{ name: string; history?: GrokHistory; brought?: GrokBrought }>;
  unreadable: string[];
  failed: string[];
}

/** Imports each plan through the package path, switches on its skills and, on the desktop app (`local`), brings its chat
 * over from the Grok Bot app there. One Bot failing is named and the rest carry on. */
export async function runGrokMove(preview: GrokPreview, dispatch: (action: Action) => void, local = false): Promise<GrokReport> {
  const report: GrokReport = { bots: [], moved: [], unreadable: preview.unreadable, failed: [] };
  const bring = async (botId: string, name: string, waiting: GrokWaiting) => {
    const history = local ? await bringHistory(botId, name) : undefined;
    const brought = local && (waiting.pages.length || waiting.files) ? await bringAssets(botId, name) : undefined;
    return { ...(history ? { history } : {}), ...(brought ? { brought } : {}) };
  };
  for (const moved of preview.moved) report.moved.push({ name: moved.name, ...await bring(moved.botId, moved.name, moved) });
  for (const plan of preview.plans) {
    try {
      const bot = (await addTemplate(plan.document, dispatch)).first;
      if (!bot) throw new Error("no bot");
      const skillsOff: string[] = [];
      for (const skill of plan.skills) {
        const on = skill.on && await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.folder)}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) }).then(() => true, () => false);
        if (!on) skillsOff.push(skill.name);
      }
      report.bots.push({ name: bot.name, skills: plan.skills.length, skillsOff, routines: plan.routines, notes: plan.notes, memories: plan.memories, apps: plan.apps,
        ...await bring(bot.id, plan.name, plan) });
    } catch {
      report.failed.push(plan.name);
    }
  }
  return report;
}
