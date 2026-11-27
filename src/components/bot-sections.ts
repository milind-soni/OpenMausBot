import type { Dispatch } from "react";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, type Action, type AppState, type Bot } from "@/state/store";

const failure = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Whether this person may move bots, from a menu or by dragging: into or out of a department, or to another place in
 * a list. */
export function useMayMoveBots(): boolean {
  return useOwnerOrAdmin() !== false;
}

/** Every department in use, in the order the workspace lists them. */
export function departmentNames(state: Pick<AppState, "sections" | "bots" | "groups">): string[] {
  return [...new Set([
    ...(state.sections ?? []),
    ...state.bots.filter((bot) => !bot.hidden && bot.section).map((bot) => bot.section!),
    ...state.groups.filter((group) => group.section).map((group) => group.section!),
  ])];
}

/** Puts bots in a department, a new one too; `""` takes them out. A remote client's profile patches don't reach the
 * workspace, so it asks for the move in one request. */
export function moveBotsToSection(dispatch: Dispatch<Action>, botIds: string[], section: string): void {
  if (!botIds.length) return;
  if (typeof window === "undefined" || window.ogb?.remoteClient?.active !== true) {
    for (const botId of botIds) dispatch({ type: "updateBot", botId, patch: { section } });
    return;
  }
  void api("/api/sidebar-sections", { method: "POST", body: JSON.stringify({ name: section, botIds }) })
    .then(({ bots }) => bots.forEach((bot: Bot) => dispatch({ type: "botPatched", bot })))
    .catch((cause) => dispatch({ type: "error", message: failure(cause) }));
}

/** Shows `botIds` in this order at once and saves it; every other bot keeps its place in the fleet. */
export function saveBotOrder(dispatch: Dispatch<Action>, bots: readonly Pick<Bot, "id">[], botIds: string[]): void {
  const before = bots.filter((bot) => botIds.includes(bot.id)).map((bot) => bot.id);
  if (before.length === botIds.length && before.every((id, index) => id === botIds[index])) return;
  dispatch({ type: "botsOrdered", botIds });
  void api("/api/bots/order", { method: "PUT", body: JSON.stringify({ botIds }) }).catch((cause) => {
    dispatch({ type: "botsOrdered", botIds: before });
    dispatch({ type: "error", message: failure(cause) });
  });
}

export async function renameDepartment(dispatch: Dispatch<Action>, from: string, to: string): Promise<void> {
  const { sections } = await api(`/api/sidebar-sections?section=${encodeURIComponent(from)}`, { method: "PATCH", body: JSON.stringify({ name: to }) });
  dispatch({ type: "sections", sections });
}
