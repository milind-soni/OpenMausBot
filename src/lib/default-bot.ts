import { useSyncExternalStore } from "react";

import { api } from "@/state/api";
import { chiefScope, type OwnedBot } from "../../shared/bot-owner";
import { defaultBotPerson, viewersDefaultBot, type DefaultBotFields } from "../../shared/default-bot";

export { DEFAULT_BOT_NAME } from "../../shared/default-bot";

let email: string | null | undefined;
const listeners = new Set<() => void>();
let asked = false;

function ask(): void {
  if (asked) return;
  asked = true;
  void api<{ email?: unknown }>("/api/auth/session", { timeoutMs: 10_000, background: true })
    .then((session) => { email = typeof session.email === "string" ? session.email.trim().toLowerCase() : null; })
    .catch(() => { email = null; })
    .finally(() => { for (const listener of listeners) listener(); });
}

/** The signed-in person's email on a shared server, null on this computer or when it has none, undefined until known. */
export function useViewerEmail(): string | null | undefined {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    ask();
    return () => listeners.delete(listener);
  }, () => email, () => undefined);
}

/** Someone else's MausBot on a Team Cloud: an Admin may open it, but it is never in their sidebar. */
export function someoneElsesDefaultBot(bot: DefaultBotFields, viewer: string | null | undefined): boolean {
  const person = defaultBotPerson(bot);
  return Boolean(bot.defaultBot && person && person !== (viewer ?? ""));
}

export function hiddenFromSidebar(bot: DefaultBotFields, viewer: string | null | undefined): boolean {
  return Boolean(bot.sidebarHidden) || someoneElsesDefaultBot(bot, viewer);
}

export function myDefaultBot<T extends DefaultBotFields>(bots: readonly T[], viewer: string | null | undefined): T | undefined {
  return viewer === undefined ? undefined : viewersDefaultBot(bots, viewer);
}

type ChiefCandidate = DefaultBotFields & OwnedBot & { id: string; hidden?: boolean };

/** The Chief of Staff in MausBot's scope (its department, or its person on a Team Cloud), if one is there to see. */
export function chiefFor<T extends ChiefCandidate>(bots: readonly T[], maus: T | undefined): T | undefined {
  const scope = chiefScope(maus ?? {});
  return bots.find((bot) => bot.chiefOfStaff && !bot.hidden && chiefScope(bot) === scope);
}

/** The bots a person may make their Chief instead of MausBot: their own, in MausBot's scope, in their sidebar. */
export function chiefChoices<T extends ChiefCandidate>(bots: readonly T[], maus: T | undefined, viewer: string | null | undefined): T[] {
  const scope = chiefScope(maus ?? {});
  return bots.filter((bot) => !bot.defaultBot && !bot.hidden && !hiddenFromSidebar(bot, viewer) && chiefScope(bot) === scope);
}

/** The first run shows its Chief step only for a MausBot not yet introduced, where no other bot is the Chief in its
 * scope; otherwise the first run ends in the chat. */
export function chiefStepFits<T extends ChiefCandidate>(bots: readonly T[], maus: (T & { welcomed?: boolean }) | undefined): boolean {
  if (!maus || maus.welcomed || maus.hidden) return false;
  const chief = chiefFor(bots, maus);
  return !chief || chief.id === maus.id;
}

let chiefStep = false;
const chiefStepListeners = new Set<() => void>();

/** The first run's Chief step is on screen: the app behind it is the empty shell, never a chat. */
export function setChiefStepOpen(open: boolean): void {
  if (chiefStep === open) return;
  chiefStep = open;
  for (const listener of chiefStepListeners) listener();
}

export function useChiefStepOpen(): boolean {
  return useSyncExternalStore((listener) => {
    chiefStepListeners.add(listener);
    return () => chiefStepListeners.delete(listener);
  }, () => chiefStep, () => false);
}

/** What Create saves on MausBot: seen, in the sidebar, and the Chief only where there is none, so a Chief someone
 * already has is never replaced. */
export function createChiefPatch(maus: DefaultBotFields, chief: { id: string } | undefined): { welcomed: true; sidebarHidden?: false; chiefOfStaff?: true } {
  return { welcomed: true, ...(maus.sidebarHidden ? { sidebarHidden: false as const } : {}), ...(chief ? {} : { chiefOfStaff: true as const }) };
}

export type SetupStep = "ai" | "bots" | "apps" | "phone" | "cloud";

/** What MausBot's intro offers to set up in Advanced mode, each optional: only what is still to do, and on a place with
 * bots of the person's own only an AI, which nothing works without. On a Team Cloud the team's admins set those up. */
export function setupSteps(input: { aiReady: boolean; ownBots: number; onCloud: boolean; team: boolean; remote: boolean }): SetupStep[] {
  if (input.team) return [];
  const fresh = input.ownBots === 0;
  return [
    ...(input.aiReady ? [] : ["ai" as const]),
    ...(fresh ? ["bots" as const, "apps" as const, "phone" as const] : []),
    ...(fresh && !input.onCloud && !input.remote ? ["cloud" as const] : []),
  ];
}

export type IntroChip = "ai" | "apps" | "import" | "phone" | "cloud";

export interface IntroFacts {
  aiReady: boolean;
  ownBots: number;
  onCloud: boolean;
  team: boolean;
  remote: boolean;
  /** Known to have a connected app or a paired phone; unknown counts as not yet. */
  appsConnected?: boolean;
  phonePaired?: boolean;
  /** This computer has skills or MCP servers from another AI tool to bring in. */
  importFound?: boolean;
}

/** At most this many chips under MausBot's look around: a step done or tapped leaves, and the next takes its place. */
export const INTRO_CHIPS = 3;

/** The chips under MausBot's look around (Simple mode), in order, before the cap: what is still missing, and on a place
 * with bots of the person's own only an AI. Adding a bot lives on the sidebar's +. */
export function introChips(input: IntroFacts): IntroChip[] {
  if (input.team) return [];
  const fresh = input.ownBots === 0;
  return [
    ...(input.aiReady ? [] : ["ai" as const]),
    ...(fresh && !input.appsConnected ? ["apps" as const] : []),
    ...(fresh && input.importFound ? ["import" as const] : []),
    ...(fresh && !input.phonePaired ? ["phone" as const] : []),
    ...(fresh && !input.onCloud && !input.remote ? ["cloud" as const] : []),
  ];
}

let welcoming: string | null = null;
const welcomingListeners = new Set<() => void>();

/** The MausBot being introduced (its first-launch card, or the first run's Chief screen): kept out of the sidebar and
 * its chat says nothing yet, until it lands. */
export function setWelcomingBot(id: string | null): void {
  if (welcoming === id) return;
  welcoming = id;
  for (const listener of welcomingListeners) listener();
}

export function useWelcomingBot(): string | null {
  return useSyncExternalStore((listener) => {
    welcomingListeners.add(listener);
    return () => welcomingListeners.delete(listener);
  }, () => welcoming, () => null);
}

let staged: string | null = null;

/** The bot whose first messages arrive one at a time, as a first run lands in its chat; null once they have. */
export function stageIntro(botId: string | null): void {
  staged = botId;
}

export function introStaged(botId: string): boolean {
  return staged === botId;
}
