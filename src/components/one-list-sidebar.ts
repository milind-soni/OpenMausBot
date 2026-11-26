// The sidebar's side of the one list (src/lib/one-list.ts): the bots laid out in departments for this page, and what a
// drag, a rename or a delete does with a bot or department that main keeps rather than this page's server.
import type { Dispatch } from "react";
import { arrangedEntries, deletedEntries, layOneList, placeDepartment, renamedEntries } from "@/lib/one-list";
import { isPlacedBot, oneListOn, type PlacedBot } from "@/lib/place-rows";
import { arrangeOneList, usePlacesTogetherPart, type ArrangedBot, type BotHome, type PlacesTogetherState } from "@/lib/places-together";
import { api, type Action, type Bot } from "@/state/store";

/** What a drag of the one list does with each bot: this page's server keeps the place of its own bots on the home
 * place's page (`server`); main keeps the other place's (`kept`); a bot of the home place on the other page is drawn
 * where its own place keeps it and is not moved from there (`movable`). */
export interface OneListRoute {
  server(id: string): boolean;
  kept(id: string): boolean;
  movable(id: string): boolean;
  /** `order`: the list's ids as drawn after a move. */
  place(list: string, order: readonly string[]): void;
  rename(from: string, to: string, onServer: () => Promise<void>): Promise<void>;
}

export interface OneList {
  bots: Bot[];
  sections: string[];
  route: OneListRoute;
  /** The other page: its departments are the home place's, so its own department menus are not offered here. */
  mirror: boolean;
  /** A department only main's entries hold (the place's own department, or one a bot of the other place was put in). */
  virtual(name: string): boolean;
  /** A department of this page's server was renamed: the bots main keeps in it follow. */
  renamed(from: string, to: string): void;
  deleteDepartment(name: string, onServer: () => Promise<{ sections: string[] }>): Promise<{ sections: string[] }>;
  /** Makes a department only main holds a department of this page's server, before bots of its own are added to it. */
  realize(name: string): Promise<void> | null;
}

type View = { here: BotHome; home: BotHome; arranged: readonly ArrangedBot[]; sections: readonly string[] };
let lastView: { state: PlacesTogetherState | null; text: string; view: View | null } = { state: null, text: "", view: null };
const viewOf = (state: PlacesTogetherState | null): View | null => {
  if (state === lastView.state) return lastView.view;
  const view = oneListOn(state) ? { here: state!.here, home: state!.home ?? "computer", arranged: state!.arranged ?? [], sections: state!.other?.sections ?? [] } : null;
  const text = JSON.stringify(view);
  lastView = { state, text, view: text === lastView.text ? lastView.view : view };
  return lastView.view;
};

/** The one list for this page while it is on; null with it off. `own`: this page's bots as the sidebar shows them (search
 * applied), `placed`: the other place's rows, `ownSections`: this page's server's departments. */
export function useOneList(own: Bot[], placed: readonly PlacedBot[], ownSections: readonly string[], dispatch: Dispatch<Action>): OneList | null {
  const view = usePlacesTogetherPart(viewOf);
  if (!view) return null;
  const { here, home, arranged } = view, mirror = here !== home;
  const keyOf = (id: string) => (id.includes(":") ? id : `${here}:${id}`);
  const kept = (id: string) => id.includes(":") !== mirror;
  const laid = layOneList<Bot>({
    homeBots: mirror ? placed : own, homeSections: mirror ? view.sections : ownSections, otherBots: mirror ? own : placed,
    arranged, keyOf: (bot) => (isPlacedBot(bot) ? bot.id : keyOf(bot.id)), landing: placeDepartment(home === "cloud" ? "computer" : "cloud"),
  });
  const virtual = (name: string) => !mirror && !ownSections.includes(name);
  const renamed = (from: string, to: string) => { const moved = renamedEntries(arranged, from, to); if (moved) arrangeOneList(moved); };
  const leave = (name: string) => {
    const members = laid.bots.filter((bot) => bot.section === name && kept(bot.id)).map((bot) => keyOf(bot.id));
    const moved = deletedEntries(members, laid.bots.filter((bot) => !bot.section).map((bot) => keyOf(bot.id)));
    if (moved) arrangeOneList(moved);
  };
  return {
    bots: laid.bots, sections: laid.sections, mirror, virtual, renamed,
    route: {
      server: (id) => !mirror && !id.includes(":"),
      kept,
      movable: (id) => !mirror || !id.includes(":"),
      place: (list, order) => arrangeOneList(arrangedEntries(list, order, kept, keyOf)),
      rename: (from, to, onServer) => (virtual(from) ? Promise.resolve(renamed(from, to)) : onServer().then(() => renamed(from, to))),
    },
    deleteDepartment: (name, onServer) => (virtual(name) ? Promise.resolve(leave(name)).then(() => ({ sections: [...ownSections] }))
      : onServer().then((answer) => { leave(name); return answer; })),
    realize: (name) => (virtual(name) ? api<{ sections: string[] }>("/api/sidebar-sections", { method: "POST", body: JSON.stringify({ name, botIds: [] }) })
      .then(({ sections }) => { dispatch({ type: "sections", sections }); }) : null),
  };
}
