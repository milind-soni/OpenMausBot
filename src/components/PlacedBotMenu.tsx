// A My Cloud bot's row in this computer's one list: its ⋯ menu (and right-click) offers My Cloud's own page at that bot,
// the way every click opened it before bots opened in place (src/lib/place-chat.ts). Nothing on that menu changes
// anything here: the bot's settings, files and everything else not in its conversation stay on its own page.
// PlaceChatKeeper lets the bot open in place go once the person chooses anything else.
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, MoreHorizontal, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { closePlaceBot, isPlaceId, noteChosen, placeOwnId } from "@/lib/place-chat";
import { openOtherPlaceBot } from "@/lib/places-together";
import { isPlacedBot, type PlacedBot } from "@/lib/place-rows";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { useAdvancedMode } from "@/lib/interface-mode";
import { sidePanelCls } from "./bot-panel/side-panel";
import { ELEVATED_FLOAT } from "./elevated";
import type { Bot } from "@/state/store";
import { MENU_ITEM, MENU_SHEET } from "./menu-recipe";
import type { MenuState } from "./Sidebar";

let open: { menu: MenuState; ownId: string; name: string } | null = null;
const listeners = new Set<() => void>();
const set = (next: typeof open) => { open = next; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Placed rows' menus, by the row's key: each row hands its bot here so its right-click finds it. */
const rows = new Map<string, PlacedBot>();

/** What a row of the other place opens as its menu: right-click or its ⋯ button. */
export function openPlacedMenu(menu: MenuState): void {
  const bot = rows.get(menu.botId);
  if (bot) set({ menu, ownId: bot.placedFrom.id, name: bot.name });
}

/** The ⋯ button on a My Cloud row of this computer's page. Elsewhere (My Cloud's own page lists this computer's bots)
 * its row keeps no menu, as before. */
export function PlacedRowActions({ bot, selected, simpleRow }: { bot: Bot; selected: boolean; simpleRow: boolean }) {
  const placed = isPlacedBot(bot) && bot.placedFrom.place.kind === "my-cloud" && Boolean(window.ogb?.placesTogether?.openInPlace) ? bot : null;
  useEffect(() => {
    if (!placed) return;
    rows.set(placed.id, placed);
    return () => { if (rows.get(placed.id) === placed) rows.delete(placed.id); };
  }, [placed]);
  if (!placed) return null;
  return <button type="button" data-placed-actions={placed.id} aria-label={t("sidebar.bot.actions", { name: placed.name })} title={t("sidebar.bot.actions", { name: placed.name })} aria-haspopup="menu"
    onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openPlacedMenu({ botId: placed.id, x: rect.left, y: rect.bottom }); }}
    className={cn("absolute top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink", simpleRow ? "end-[3px] top-1.5 size-6 translate-y-0 rounded-lg" : "right-1",
      selected && !simpleRow ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:pointer-events-auto max-md:opacity-70 touch:pointer-events-auto touch:opacity-70")}><MoreHorizontal size={16} /></button>;
}

/** The menu itself, drawn once for the whole list. */
export function PlacedBotMenuHost() {
  const shown = useSyncExternalStore(subscribe, () => open, () => null);
  const sheet = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = sheet.current;
    if (!shown || !element) return;
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(shown.menu.x, window.innerWidth - width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(shown.menu.y, window.innerHeight - height - 8))}px`;
    element.querySelector<HTMLButtonElement>("button")?.focus();
  }, [shown]);
  useEffect(() => {
    if (!shown) return;
    const close = () => set(null);
    const onDown = (event: MouseEvent) => { if (!(event.target instanceof Element) || !event.target.closest("[data-placed-menu]")) close(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); window.removeEventListener("blur", close); };
  }, [shown]);
  if (!shown) return null;
  return createPortal(<div ref={sheet} data-placed-menu="" data-sidebar="" role="menu" data-look="menu" aria-label={t("sidebar.bot.actions", { name: shown.name })}
    className={cn(MENU_SHEET, "fixed z-50 min-w-[220px]")} style={{ left: shown.menu.x, top: shown.menu.y }}>
    <button type="button" role="menuitem" className={cn(MENU_ITEM, "hover:bg-menu-hover")} onClick={() => { const id = shown.ownId; set(null); openOtherPlaceBot(id); }}>
      <ExternalLink size={16} className="shrink-0 text-ink-secondary" aria-hidden="true" />{t("together.openThere")}
    </button>
  </div>, document.body);
}

/** Keeps the store to what the person has open: a My Cloud bot opened in place goes once they choose anything else. */
export function PlaceChatKeeper() {
  const chosen = useStoreSelector((state) => state.selectedId);
  const held = useRef<string | null>(null);
  useEffect(() => {
    noteChosen(chosen);
    const was = held.current;
    held.current = isPlaceId(chosen) ? chosen : null;
    if (was && was !== chosen) closePlaceBot(was);
  }, [chosen]);
  return null;
}

/** The side panel of a My Cloud bot open in place: its settings, files, computer and everything else not in its
 * conversation are on My Cloud's own page, which this opens at that bot. Said once, plainly, where its panel would be. */
export function PlacedBotPanel({ bot }: { bot: Bot }) {
  const dispatch = useStoreDispatch(), simple = !useAdvancedMode();
  const close = () => { dispatch({ type: "toggleSettings", open: false }); dispatch({ type: "toggleComputer", open: false }); };
  return <aside role="dialog" aria-labelledby="placed-bot-title" data-placed-panel="" className={sidePanelCls(false, simple)}>
    <div className="flex shrink-0 items-center justify-between px-4 py-3">
      <span id="placed-bot-title" className="truncate text-[15px] font-semibold text-ink">{bot.name}</span>
      <button type="button" onClick={close} aria-label={t("botSettings.simple.close")} className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"><X size={18} className="pointer-events-none" /></button>
    </div>
    <div className="flex flex-col gap-3 px-4 pb-4 text-[13px] leading-[18px] text-ink-secondary">
      <p>{t("together.inPlace.panel", { name: bot.name })}</p>
      <button type="button" onClick={() => { close(); openOtherPlaceBot(placeOwnId(bot.id)); }}
        className="flex h-9 items-center justify-center gap-2 self-start rounded-full bg-raised px-3.5 text-[13px] font-medium text-ink hover:bg-raised-hover">
        <ExternalLink size={14} aria-hidden="true" />{t("together.openThere")}
      </button>
    </div>
  </aside>;
}

/** The model a My Cloud bot open in place uses, as My Cloud names it: shown plainly where the model pill is, never
 * matched to this computer's engines, accounts or usage, and changed only on My Cloud's own page. */
export function PlacedModelPill({ bot, quiet = false }: { bot: Bot; quiet?: boolean }) {
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);
  const own = task?.modelSelection?.model;
  const model = own && own !== "profile-default" ? own : bot.modelSelection?.model ?? "";
  if (!model) return null;
  const said = t("together.inPlace.model");
  return <button type="button" disabled data-placed-model="" title={said} aria-label={`${model}. ${said}`}
    className={cn("flex h-9 min-w-0 max-w-[16rem] items-center rounded-full px-3 text-[13px] text-ink-secondary disabled:cursor-default", !quiet && ELEVATED_FLOAT)}>
    <span className="min-w-0 truncate">{model}</span>
  </button>;
}
