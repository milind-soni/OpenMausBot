import { useEffect, useRef, useState } from "react";
import { Check, LogIn } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { placeKindWord, usePlaces } from "@/lib/places";
import { MENU_ROW, MENU_SEPARATOR, MENU_SHEET } from "./menu-recipe";
import { PlaceAddSheet } from "./PlaceAddSheet";
import { PlaceMark, openPlace, placeActs, placeLabel } from "./PlacesRail";

/** The list the place tag in the page's top bar opens (WindowPlaceTitle), under that tag, in the window's middle: every place
 * main lists, opened the way a tile of the rail opens them, and Sign in while main offers it. On the rail's own page: no
 * place's page reads this list. */
export function WindowPlacesList({ onClose }: { onClose: () => void }) {
  const state = usePlaces();
  const [connecting, setConnecting] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const ready = Boolean(state.list);
  useEffect(() => { if (ready) (sheet.current?.querySelector<HTMLElement>("[aria-current='page']") ?? sheet.current?.querySelector<HTMLElement>("button:not([disabled])"))?.focus(); }, [ready]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  if (connecting !== null) return <PlaceAddSheet choices={state.add} connect={{ name: connecting }} onClose={onClose} />;
  const canPair = state.add.link || state.add.address;
  const signIn = () => { onClose(); void window.ogb?.workspaces?.add?.("signIn").catch(() => {}); };
  return <div data-window-places-backdrop className="fixed inset-0 z-[60]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    {ready && <div ref={sheet} role="dialog" aria-label={t("rail.label")} data-window-places className={cn(MENU_SHEET, "absolute left-1/2 top-[33px] max-h-[calc(100%-48px)] w-80 max-w-[calc(100%-32px)] -translate-x-1/2")}>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {state.list!.map((place) => {
          const word = placeKindWord(place.kind, place.name);
          return <li key={place.id}>
            <button type="button" disabled={!placeActs(place, canPair)} aria-current={place.active ? "page" : undefined} data-window-place-row={place.id} className={cn(MENU_ROW, "h-9 focus-visible:outline-none")}
              onClick={() => {
                if (place.active) { onClose(); return; }
                openPlace(place, setConnecting);
                if (place.opens) onClose();
              }}>
              <PlaceMark place={place} size={22} />
              <span className="min-w-0 flex-1 truncate">{placeLabel(place)}</span>
              {word && !place.server && <span className="shrink-0 text-[12px] text-ink-tertiary">{word}</span>}
              {place.active && <Check size={15} aria-hidden="true" className="shrink-0 text-ink-secondary" />}
            </button>
          </li>;
        })}
      </ul>
      {state.add.signIn && <>
        <div aria-hidden="true" className={MENU_SEPARATOR} />
        <button type="button" data-window-places-sign-in className={cn(MENU_ROW, "h-auto min-h-9 py-1.5 font-medium focus-visible:outline-none")} onClick={signIn}>
          <LogIn size={16} aria-hidden="true" className="mx-[3px] shrink-0" />
          <span className="min-w-0 flex-1">{t("rail.signIn")}</span>
        </button>
      </>}
    </div>}
  </div>;
}

/** The list as the rail's page keeps it: asked for by main, from the person's click on the page beside the rail, perhaps before
 * this page was up. It shows once the view covers the window. `hidesRail`: the rail itself isn't up, only this page for the list,
 * so its tiles stay away. */
export function useWindowPlacesList(): { open: boolean; hidesRail: boolean; close: () => void } {
  const rail = window.ogb?.rail;
  const [asked, setAsked] = useState<{ besideRail: boolean } | null>(null);
  const [covering, setCovering] = useState(false);
  useEffect(() => {
    const show = (besideRail: boolean) => setAsked({ besideRail });
    void rail?.listAsked?.().then((besideRail) => { if (besideRail !== null) show(besideRail); }).catch(() => {});
    return rail?.onOpenList?.(show);
  }, [rail]);
  const wanted = asked !== null;
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    void rail?.expand?.(true)?.catch(() => {}).then(() => { if (alive) setCovering(true); });
    return () => { alive = false; };
  }, [wanted, rail]);
  return { open: wanted && covering, hidesRail: wanted && !asked.besideRail, close: () => {
    setAsked(null);
    setCovering(false);
    void rail?.expand?.(false)?.catch(() => {});
    void rail?.listClosed?.().catch(() => {});
  } };
}
