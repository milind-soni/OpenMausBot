import { useSyncExternalStore } from "react";

import { api } from "@/state/api";
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

export type SetupStep = "ai" | "bots" | "apps" | "phone" | "cloud";

/** What MausBot's intro offers to set up, each optional: only what is still to do, and on a place with bots of the
 * person's own only an AI, which nothing works without. On a Team Cloud the team's admins set those up. */
export function setupSteps(input: { aiReady: boolean; ownBots: number; onCloud: boolean; team: boolean; remote: boolean }): SetupStep[] {
  if (input.team) return [];
  const fresh = input.ownBots === 0;
  return [
    ...(input.aiReady ? [] : ["ai" as const]),
    ...(fresh ? ["bots" as const, "apps" as const, "phone" as const] : []),
    ...(fresh && !input.onCloud && !input.remote ? ["cloud" as const] : []),
  ];
}

let welcoming: string | null = null;
const welcomingListeners = new Set<() => void>();

/** The MausBot whose first-launch welcome is open: kept out of the sidebar until Add lands it there. */
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
