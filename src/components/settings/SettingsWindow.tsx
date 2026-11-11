import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { glassPopupFrameStyle, glassPopupTopInset, GLASS_POPUP_GUTTER } from "@/lib/glass-popup";
import { scrollWithin } from "@/lib/scroll-within";
import { useMediaQuery } from "@/lib/use-media-query";
import { useStore } from "@/state/store";
import { useIsTopLayer } from "../Layer";
import { LicenseExpiryBanner } from "../LicenseExpiryBanner";
import { shortcutLabel } from "../ShortcutHint";
import { SettingsLook } from "../SettingsPrimitives";
import { SettingsPageBody } from "./pages/SettingsPageBody";
import { useSwitchToComputer } from "./inert";
import { KEY_CATALOG, keyMatches, type KeyEntry } from "../keys/key-catalog";
import { openKeySettings } from "../keys/key-focus";
import { useSettingsContext, useSettingsPlace } from "./settings-context";
import { pageById, resolveSettingsTarget, searchSettings, visiblePages, type SearchHit, type SettingsPageId } from "./settings-index";
import { SettingsShellContext, type SettingsShell } from "./settings-shell";
import { SettingsNav, hitLabel, pageLabel } from "./SettingsNav";
import { SettingsPageHeader } from "./SettingsPageHeader";
import { SettingsSkeletonCard, SettingsUnreachable } from "./SettingsStates";

const NARROW = "(max-width: 767.98px)";
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
const OPENED = "omb-settings-opened";

function markOpened(): void {
  try { if (!localStorage.getItem(OPENED)) localStorage.setItem(OPENED, String(Date.now())); } catch { /* storage may be blocked */ }
}

/** Opening a found row: scroll the pane (only the pane) to it, focus its control and mark it for a moment. */
export function revealAnchor(scroller: HTMLElement | null, anchor: string | null): void {
  if (!scroller || !anchor) return;
  const block = scroller.querySelector<HTMLElement>(`[data-settings-block="${CSS.escape(anchor)}"]`);
  if (!block) return;
  // A row (a block drawn as `contents` has no box of its own) lands a third of the way down the pane, focused and lit.
  const target = getComputedStyle(block).display === "contents" ? block.firstElementChild as HTMLElement | null ?? block : block;
  const header = scroller.querySelector<HTMLElement>("[data-settings-header]");
  const isRow = target !== block || block.matches("[data-setting-row], [data-setting-row] *");
  if (isRow) {
    const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 3);
    target.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
  } else scrollWithin(scroller, block, "start", (header?.offsetHeight ?? 96) + 8);
  target.setAttribute("data-settings-highlight", "");
  window.setTimeout(() => target.removeAttribute("data-settings-highlight"), 1200);
}

export function SettingsWindow() {
  const isTop = useIsTopLayer();
  const { state, dispatch } = useStore();
  const ctx = useSettingsContext();
  const place = useSettingsPlace();
  const narrow = useMediaQuery(NARROW, false);
  const target = resolveSettingsTarget(state.appSettingsSection, ctx);
  const [anchor, setAnchor] = useState<string | null>(target.anchor ?? null);
  const [narrowPage, setNarrowPage] = useState(state.appSettingsSection !== "overview");
  const [query, setQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const pages = visiblePages(ctx);
  const page = pageById(target.page);
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setAnchor(target.anchor ?? null); setNarrowPage((open) => open || state.appSettingsSection !== "overview"); }, [state.appSettingsSection, target.anchor]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (anchor) revealAnchor(scrollRef.current, anchor);
      else if (scrollRef.current) scrollRef.current.scrollTop = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [anchor, target.page]);
  useEffect(() => window.ogb?.onOpenAppSettings?.(() => setQuery("")), []);
  useEffect(markOpened, []);

  const hits = useMemo(() => searchSettings(query, ctx, (entry) => hitLabel({ entry, elsewhere: false, score: 0 }, place, ctx.desktop),
    (candidate) => pageLabel(candidate, place, ctx.desktop)), [query, ctx, place]);

  const keyHits = useMemo(() => (ctx.client || !query.trim() ? [] : KEY_CATALOG.filter((entry) => keyMatches(entry, query.trim().toLowerCase())).slice(0, 8)), [ctx.client, query]);
  const openKey = (entry: KeyEntry) => { setQuery(""); setNarrowPage(true); dispatch(entry.uses ? openKeySettings(entry.uses, entry.id) : openKeySettings(entry.id)); };
  const computer = useSwitchToComputer();
  const close = () => dispatch({ type: "toggleAppSettings", open: false });
  const go = (next: SettingsPageId, nextAnchor?: string) => {
    setNarrowPage(true);
    if (next === target.page) setAnchor(nextAnchor ?? null);
    dispatch({ type: "toggleAppSettings", open: true, section: next });
    if (nextAnchor) window.setTimeout(() => setAnchor(nextAnchor), 0);
  };
  const openHit = (hit: SearchHit) => {
    const entry = hit.entry;
    if (entry.jump === "apps") { close(); dispatch({ type: "togglePlugins", open: true }); return; }
    if (entry.jump === "automations") { close(); dispatch({ type: "showRoutines", view: "list" }); return; }
    if (entry.jump === "shortcuts") { close(); dispatch({ type: "toggleShortcuts", open: true }); return; }
    if (entry.jump === "bot") { close(); return; }
    if (hit.elsewhere) { computer.open?.(); return; }
    go(entry.page, entry.anchor);
  };

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const search = dialog?.querySelector<HTMLInputElement>("[data-settings-search]");
    if (search?.checkVisibility()) search.focus({ preventScroll: true });
    else dialog?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (!isTop() || !dialog) return;
      if (event.defaultPrevented || [...dialog.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].some((child) => child.getClientRects().length)) return;
      const field = dialog.querySelector<HTMLInputElement>("[data-settings-search]");
      const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement
        || (document.activeElement as HTMLElement | null)?.isContentEditable;
      if (field && ((event.key === "/" && !typing) || (event.key.toLowerCase() === "f" && (event.metaKey || event.ctrlKey)))) {
        event.preventDefault();
        field.focus();
        field.select();
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.checkVisibility());
      if (focusable.length === 0) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0]!, last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previousFocus?.focus(); };
  }, [dispatch, isTop]);

  const shell: SettingsShell = { ctx, place, page: target.page, anchor, go };
  const missing = target.missing ? pageLabel(pageById(target.missing), place, ctx.desktop) : undefined;
  const showList = narrow && !narrowPage;
  const closeButton = (
    <button type="button" onClick={close} aria-label={t("settings.close")} title={`${t("settings.close")} (${shortcutLabel("close-panel")})`}
      className={cn("ui-icon-button z-20 size-8 shrink-0 cursor-pointer rounded-full text-ink-secondary hover:bg-menu-hover hover:text-ink", !narrow && "absolute right-3 top-3")}>
      <X size={16} aria-hidden="true" />
    </button>
  );

  return (
    <SettingsLook.Provider value={true}>
      <SettingsShellContext.Provider value={shell}>
        <div className="glass-popup-frame" data-settings-sheet data-settings-look="simple" style={{ ...glassPopupFrameStyle(), ["--settings-narrow-top" as string]: `${glassPopupTopInset() === GLASS_POPUP_GUTTER ? 12 : glassPopupTopInset()}px` }} onMouseDown={(event) => event.target === event.currentTarget && close()}>
          <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
          <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="app-settings-title" tabIndex={-1} style={{ outline: "none" }}
            data-settings-page-open={target.page} data-settings-advanced={ctx.advanced ? "" : undefined}
            className="glass-surface glass-popup animate-pop-in relative flex flex-col overflow-hidden text-ink">
            <span id="app-settings-title" className="sr-only">{t("settings.title")}</span>
            {narrow && (
              <div className="flex shrink-0 flex-col">
                <span aria-hidden="true" className="mx-auto mt-2 h-1 w-8 rounded-full bg-ink/15" />
                <div className="relative flex h-12 items-center justify-between gap-2 px-2">
                  {showList ? <h2 className="flex-1 px-2 text-[16px] font-semibold leading-[22px] text-ink">{t("settings.title")}</h2> : (
                    <>
                      <button type="button" data-settings-back="" onClick={() => { setNarrowPage(false); setQuery(""); }}
                        className="flex h-8 shrink-0 cursor-pointer items-center gap-0.5 rounded-full pl-1 pr-2 text-[13px] font-medium leading-5 text-ink-secondary hover:bg-menu-hover hover:text-ink">
                        <ChevronLeft size={16} aria-hidden="true" className="rtl:-scale-x-100" />{t("settings.title")}
                      </button>
                      <h2 className="pointer-events-none absolute left-1/2 top-1/2 max-w-[calc(100%-224px)] -translate-x-1/2 -translate-y-1/2 truncate text-center text-[16px] font-semibold leading-[22px] text-ink">{pageLabel(page, place, ctx.desktop)}</h2>
                    </>
                  )}
                  {closeButton}
                </div>
              </div>
            )}
            <div className="flex min-h-0 flex-1">
              {(!narrow || showList) && (
                <SettingsNav ctx={ctx} place={place} pages={pages} current={narrow ? null : target.page} query={query} hits={hits} narrow={narrow}
                  onQuery={setQuery} onOpen={(next) => go(next)} onHit={openHit} keyHits={keyHits} onKey={openKey} onClose={close} />
              )}
              {(!narrow || !showList) && (
                <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                  {!narrow && closeButton}
                  <div ref={scrollRef} data-settings-scroll data-settings-content="" onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
                    className={cn("settings-scroll min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]", narrow ? "pb-12" : "px-8 pb-12")}>
                    <div className={cn("flex max-w-[640px] flex-col", narrow && "max-w-none")}>
                      <SettingsPageHeader page={page} ctx={ctx} place={place} scrolled={scrolled} narrow={narrow} missing={missing} />
                      <div key={target.page} data-settings-page-body={target.page} className={cn("flex flex-col gap-6", narrow && "px-4")}>
                        <LicenseExpiryBanner config={state.config} />
                        {page.owner === "place" && state.config === null
                          ? state.error ? <SettingsUnreachable place={place.name} onRetry={() => location.reload()} />
                            : <><SettingsSkeletonCard place={place.name} /><SettingsSkeletonCard place={place.name} /></>
                          : <SettingsPageBody page={target.page} />}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </SettingsShellContext.Provider>
    </SettingsLook.Provider>
  );
}
