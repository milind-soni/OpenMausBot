// The sidebar's side of the one list (src/lib/one-list.ts): the bots laid out in departments for this page, and what a
// drag, a rename or a delete does with a bot or department that main keeps rather than this page's server.
import type { Dispatch } from "react";
import { arrangedEntries, layOneList, leftEntries, placeDepartment, renamedEntries } from "@/lib/one-list";
import { isPlacedBot, oneListOn, type PlacedBot } from "@/lib/place-rows";
import { arrangeOneList, usePlacesTogetherPart, type ArrangedBot, type BotHome, type PlacesTogetherState } from "@/lib/places-together";
import { t } from "@/lib/i18n";
import { api, type Action, type Bot } from "@/state/store";

/** What a drag of the one list does with each bot: this page's server keeps the place of its own bots on the home
 * place's page (`server`); main keeps the other place's (`kept`); a bot of the home place on the other page is drawn
 * where its own place keeps it and is not moved from there (`movable`). */
export interface OneListRoute {
  server(id: string): boolean;
  kept(id: string): boolean;
  movable(id: string): boolean;
  /** `order`: the list's ids as drawn after a move; `moved`: the bot the person moved, when it was one. */
  place(list: string, order: readonly string[], moved?: string): void;
  /** Dropping a bot on another starts a department: not on the other page, which can make no department of the home
   * place's. */
  group: boolean;
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

type View = { here: BotHome; home: BotHome; arranged: readonly ArrangedBot[]; sections: readonly string[]; ready: boolean };
let lastView: { state: PlacesTogetherState | null; text: string; view: View | null } = { state: null, text: "", view: null };
const viewOf = (state: PlacesTogetherState | null): View | null => {
  if (state === lastView.state) return lastView.view;
  const view = oneListOn(state) ? { here: state!.here, home: state!.home ?? "computer", arranged: state!.arranged ?? [], sections: state!.other?.sections ?? [], ready: state!.other?.state === "ready" } : null;
  const text = JSON.stringify(view);
  lastView = { state, text, view: text === lastView.text ? lastView.view : view };
  return lastView.view;
};

/** The one list for this page while it is on; null with it off. `own`: this page's bots as the sidebar shows them (search
 * applied), `placed`: the other place's rows, `ownSections`: this page's server's departments, `loaded`: this page's
 * store has loaded them. */
export function useOneList(own: Bot[], placed: readonly PlacedBot[], ownSections: readonly string[], dispatch: Dispatch<Action>, loaded: boolean): OneList | null {
  const view = usePlacesTogetherPart(viewOf);
  if (!view) return null;
  const { here, home, arranged } = view, mirror = here !== home;
  const keyOf = (id: string) => (id.includes(":") ? id : `${here}:${id}`);
  const kept = (id: string) => id.includes(":") !== mirror;
  const otherPlace = home === "cloud" ? "computer" : "cloud", keptKey = (key: string) => key.startsWith(`${otherPlace}:`);
  const landing = placeDepartment(home === "cloud" ? "computer" : "cloud"), certain = mirror ? view.ready : loaded;
  const laid = layOneList<Bot>({ certain,
    homeBots: mirror ? placed : own, homeSections: mirror ? view.sections : ownSections, otherBots: mirror ? own : placed,
    arranged, keyOf: (bot) => (isPlacedBot(bot) ? bot.id : keyOf(bot.id)), landing,
  });
  const virtual = (name: string) => !mirror && !ownSections.includes(name) && !own.some((bot) => bot.section === name);
  /** A department this page's server lacks is made there first (empty), so the layout, which holds a bot only in a
   * department the home place has or in the place's own, keeps it. */
  const create = (name: string) => api<{ sections: string[] }>("/api/sidebar-sections", { method: "POST", body: JSON.stringify({ name, botIds: [] }) })
    .then(({ sections }) => { dispatch({ type: "sections", sections }); });
  /** A department made for bots main then would not keep is taken away again, and the person is told. */
  const unmake = (name: string) => api<{ sections: string[] }>(`/api/sidebar-sections?section=${encodeURIComponent(name)}`, { method: "DELETE" })
    .then(({ sections }) => { dispatch({ type: "sectionDeleted", section: name, sections }); }, () => {}).then(() => { throw new Error(t("together.switch.failed")); });
  const renamed = (from: string, to: string) => arrangeOneList(renamedEntries(laid.bots, arranged, from, to, kept, keyOf, keptKey, laid.fallback, landing));
  const leave = (name: string) => {
    const moved = leftEntries(laid.bots, arranged, name, kept, keyOf, keptKey, laid.fallback, landing);
    if (moved) arrangeOneList(moved);
  };
  // While the home place's departments are not known for sure, a move writes the moved bot only: every other bot's
  // entry is carried through as it was, never rewritten from a place it is only drawn in for now. A bot drawn where
  // the layout fell back is never written unless it is the one being moved.
  const place = (list: string, order: readonly string[], moved?: string) => arrangeOneList(arrangedEntries(list, order, kept, keyOf, landing)
    .filter((entry) => (moved !== undefined && entry.key === keyOf(moved)) || (!laid.fallback.has(entry.key) && (certain || moved === undefined))));
  const failed = (cause: unknown) => { dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }); };
  return {
    bots: laid.bots, sections: laid.sections, mirror, virtual, renamed,
    route: {
      server: (id) => !mirror && !id.includes(":"),
      kept,
      movable: (id) => !mirror || !id.includes(":"),
      place: (list, order, moved) => {
        if (!(list && list !== landing && virtual(list) && order.some(kept))) return void place(list, order, moved);
        // A failed make stores nothing, so the drop goes back; a department main would not fill is taken away again.
        void create(list).then(() => place(list, order, moved).then((saved) => (saved ? undefined : unmake(list)))).catch(failed);
      },
      group: !mirror,
      // The place's own department, while only main holds it, becomes a department of the new name on this page's
      // server, and every bot drawn in it moves there; new bots of the other place land in the place's own again.
      // Only a department this rename made is taken away again: one of that name that was there before stays.
      rename: (from, to, onServer) => {
        const fresh = virtual(to), refused = () => (fresh ? unmake(to) : Promise.reject(new Error(t("together.switch.failed"))));
        return virtual(from) ? create(to).then(() => renamed(from, to)).then((saved) => (saved ? undefined : refused())) : onServer().then(() => { void renamed(from, to); });
      },
    },
    deleteDepartment: (name, onServer) => (virtual(name) ? Promise.resolve(leave(name)).then(() => ({ sections: [...ownSections] }))
      : onServer().then((answer) => { leave(name); return answer; })),
    realize: (name) => (virtual(name) ? create(name) : null),
  };
}
