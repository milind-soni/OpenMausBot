import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ArrowUpRight, ChevronRight, Laptop, Search, X } from "lucide-react";
import { cloudColor } from "@/lib/cloud-look";
import { placeInitials } from "@/lib/places";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { productName } from "@/lib/brand";
import { setAdvancedMode, useAdvancedMode } from "@/lib/interface-mode";
import { SIMPLE_ONLY } from "@/lib/simple-only";
import { useStore } from "@/state/store";
import { InitialsAvatar } from "../Avatar";
import { PlaceMark } from "../PlacesRail";
import { profileInitials } from "../SidebarProfileMenu";
import { Switch, SettingsTag } from "../SettingsPrimitives";
import { accountLine, useAccountSummary, useYou } from "./account-summary";
import { usePhonePlaceState } from "./phone-status";
import type { SettingsPlace } from "./settings-context";
import { OWNERS, pageById, type SearchHit, type SettingsContext, type SettingsOwner, type SettingsPage, type SettingsPageId } from "./settings-index";
import { useUpdaterState } from "@/lib/updater";
import { keySection, type KeyEntry } from "../keys/key-catalog";
import { HELP_CENTER_URL, desktopAppVersion } from "@/lib/app-links";

export const NAV_ITEM = "relative flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-[13px] leading-5 text-ink transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";

/** A place's badge as its rail circle draws it; with no colour of its own (This computer, or a Cloud in a browser) it is a
 * quiet filled tile with an edge, so it never vanishes on the sheet. */
export function PlaceBadge({ place, size }: { place: Pick<SettingsPlace, "kind" | "name" | "color"> & { named?: boolean }; size: number }) {
  if (cloudColor(place.color)) {
    return <PlaceMark place={{ kind: place.kind === "server" ? "cloud" : place.kind, name: place.name, color: place.color, ...(place.named ? { named: true as const } : {}) }} size={size} />;
  }
  const glyph = size <= 14 ? 10 : size <= 20 ? 12 : 14;
  return (
    <span aria-hidden="true" data-place-badge={place.kind}
      className="grid shrink-0 place-items-center bg-ink/[0.06] font-semibold leading-none text-ink-secondary shadow-[inset_0_0_0_0.5px_var(--settings-edge)]"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), fontSize: Math.max(7, Math.round(size * 0.4)) }}>
      {place.kind === "computer" && !place.named ? <Laptop size={glyph} strokeWidth={1.75} /> : placeInitials(place.name)}
    </span>
  );
}

export function AppIcon({ size }: { size: number }) {
  // A 0.5 px edge keeps the tile's shape on a dark sheet, where its own black would melt into Midnight's.
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }}>
      <img src="/app-icon.svg" alt="" width={size} height={size} className="rounded-[6px]" style={{ width: size, height: size }} />
      <span aria-hidden="true" className="absolute inset-0 rounded-[6px] shadow-[inset_0_0_0_0.5px_var(--settings-edge)]" />
    </span>
  );
}

export function YouAvatar({ size }: { size: number }) {
  const { profile } = useYou();
  return <InitialsAvatar initials={profileInitials(profile)} avatarUrl={profile?.avatarUrl} size={size} fontSize={Math.round(size * 0.42)} className="bg-ink/[0.08]" />;
}

/** The place's one status line under its name: bots on This computer, power on a Cloud. */
export function usePlaceSubLine(place: SettingsPlace): string {
  const { state } = useStore();
  const update = useUpdaterState();
  if (update?.status === "downloaded" && place.kind === "computer") return t("sidebar.update.readyShort");
  if (place.kind === "computer") {
    const count = state.bots.length;
    return count === 0 ? t("settings.place.botsNone") : count === 1 ? t("settings.place.botsOne") : t("settings.place.botsMany", { count });
  }
  return place.kind === "server" ? t("settings.place.running") : t("settings.place.alwaysOn");
}

export function useAppSubLine(desktop: boolean): string {
  const update = useUpdaterState();
  if (!desktop) return t("settings.scope.browser");
  if (update?.status === "downloaded") return t("settings.app.updateReadyLine", { version: desktopAppVersion() });
  return t("settings.app.upToDateLine", { version: desktopAppVersion() });
}

export function ownerLabel(owner: SettingsOwner, place: SettingsPlace, desktop: boolean): string {
  if (owner === "place") return place.name;
  if (owner === "account") return t("settings.page.account");
  return desktop ? t("settings.page.app") : t("settings.page.browser");
}

export function pageLabel(page: SettingsPage, place: SettingsPlace, desktop: boolean): string {
  if (page.id === "overview") return place.name;
  if (page.id === "account" || page.id === "app") return ownerLabel(page.owner, place, desktop);
  return t(page.labelKey);
}

function IdentityRow({ page, current, badge, name, line, onOpen, narrow }: {
  page: SettingsPageId; current: boolean; badge: ReactNode; name: string; line: string; onOpen: () => void; narrow: boolean;
}) {
  return (
    <button type="button" data-settings-page={page} data-settings-section={page} data-settings-identity="" aria-current={current ? "page" : undefined} onClick={onOpen}
      className={cn("flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-left", narrow ? "h-12" : "h-11", " transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
        current ? "bg-menu-active" : "hover:bg-menu-hover")}>
      <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-[6px]">{badge}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14px] font-medium leading-[18px] text-ink">{name}</span>
        <span className="truncate text-[12px] leading-4 text-ink-secondary">{line}</span>
      </span>
      {narrow && <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary rtl:-scale-x-100" />}
    </button>
  );
}

function PageItem({ page, label, current, dot, onOpen }: { page: SettingsPage; label: string; current: boolean; dot?: "success" | "warning" | null; onOpen: () => void }) {
  const Icon = page.icon;
  return (
    <button type="button" data-settings-page={page.id} data-settings-section={page.id} aria-current={current ? "page" : undefined} onClick={onOpen}
      className={cn(NAV_ITEM, current ? "bg-menu-active font-medium" : "hover:bg-menu-hover")}>
      <span className="flex w-6 shrink-0 justify-center">{Icon && <Icon size={16} strokeWidth={1.75} aria-hidden="true" className={current ? "text-ink" : "text-ink-secondary"} />}</span>
      <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden" title={label}>
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [grid-area:1/1]">{label}</span>
        <span aria-hidden="true" className="invisible h-0 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium [grid-area:1/1]">{label}</span>
      </span>
      {dot && <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dot === "success" ? "bg-success" : "bg-warning")} />}
    </button>
  );
}

export interface NavProps {
  ctx: SettingsContext;
  place: SettingsPlace;
  pages: SettingsPage[];
  current: SettingsPageId | null;
  query: string;
  hits: SearchHit[];
  onQuery: (query: string) => void;
  onOpen: (page: SettingsPageId) => void;
  onHit: (hit: SearchHit) => void;
  /** keys from the key catalog, opened at their own field */
  keyHits: KeyEntry[];
  onKey: (entry: KeyEntry) => void;
  onClose: () => void;
  narrow: boolean;
  /** the footer's Advanced mode switch */
  onAdvanced?: (on: boolean) => void;
}

export function SettingsSearchField({ query, onQuery, onClose, onFirst }: { query: string; onQuery: (query: string) => void; onClose: () => void; onFirst: () => void }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 rounded-lg border-[0.5px] border-(--settings-edge) px-2 focus-within:border-ink/25">
      <Search size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
      <input
        data-settings-search
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); onFirst(); return; }
          if (event.key !== "Escape") return;
          event.stopPropagation();
          if (query) onQuery("");
          else onClose();
        }}
        placeholder={t("settings.searchAria")}
        aria-label={t("settings.searchAria")}
        className="h-full w-full min-w-0 text-ellipsis bg-transparent text-[13px] leading-5 text-ink outline-none placeholder:text-ink-tertiary"
      />
      {query ? (
        <button type="button" aria-label={t("settings.search.clear")} onClick={() => onQuery("")} className="flex size-4 shrink-0 cursor-pointer items-center justify-center text-ink-tertiary hover:text-ink">
          <X size={12} aria-hidden="true" />
        </button>
      ) : (
        <kbd aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border-[0.5px] border-(--settings-edge) font-sans text-[11px] font-medium leading-4 text-ink-tertiary">/</kbd>
      )}
    </div>
  );
}

function moveFocus(event: ReactKeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("button[data-settings-page], button[data-settings-hit]")];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0 && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
  items[next]?.focus();
}

export function SettingsNav({ ctx, place, pages, current, query, hits, keyHits, onKey, onQuery, onOpen, onHit, onClose, narrow, onAdvanced = setAdvancedMode }: NavProps) {
  const summary = useAccountSummary();
  const { profile } = useYou();
  // Until main shares the account with a Cloud's page, its email is the one the place knows you by.
  const account = { ...summary, email: summary.email ?? (summary.plan ? profile?.email ?? null : null) };
  const placeLine = usePlaceSubLine(place);
  const appLine = useAppSubLine(ctx.desktop);
  const phone = usePhonePlaceState(!ctx.client);
  const listRef = useRef<HTMLDivElement>(null);
  const openSource = ctx.desktop && !window.ogb?.cloudAccount && !window.ogb?.cloudPlan;
  const lines: Record<SettingsOwner, { badge: ReactNode; name: string; line: string; page: SettingsPageId }> = {
    place: { badge: <PlaceBadge place={place} size={24} />, name: place.name, line: placeLine, page: "overview" },
    account: { badge: <YouAvatar size={24} />, name: t("settings.page.account"), line: accountLine(account, { browser: !ctx.desktop, place: place.name, openSource }), page: "account" },
    app: { badge: <AppIcon size={24} />, name: ctx.desktop ? t("settings.page.app") : t("settings.page.browser"), line: appLine, page: "app" },
  };
  const dot = (page: SettingsPageId) => page === "phone" && phone.kind === "paired" && phone.connected ? "success" as const
    : page === "phone" && phone.kind === "attention" ? "warning" as const : null;
  const searching = query.trim() !== "";
  return (
    <nav aria-label={t("settings.title")} className={cn("flex min-h-0 flex-col", narrow ? "flex-1" : "w-[220px] shrink-0 shadow-[inset_-0.5px_0_0_var(--settings-edge)]")}>
      <div className={cn("shrink-0", narrow ? "px-4 pb-2" : "p-3 pb-0")}>
        <SettingsSearchField query={query} onQuery={onQuery} onClose={onClose}
          onFirst={() => listRef.current?.querySelector<HTMLElement>("button[data-settings-hit], button[data-settings-page]")?.focus()} />
      </div>
      <div ref={listRef} onKeyDown={moveFocus} className={cn("settings-scroll flex min-h-0 flex-1 flex-col overflow-y-auto", narrow ? "px-2 pb-4 pt-1" : "px-3 pb-3 pt-3")}>
        {searching ? <SearchResults ctx={ctx} place={place} hits={hits} keyHits={keyHits} onKey={onKey} query={query} onHit={onHit} /> : OWNERS.map((owner, index) => {
          const group = pages.filter((page) => page.owner === owner && page.id !== lines[owner].page);
          const identity = lines[owner];
          return (
            <div key={owner} role="group" aria-label={identity.name} data-settings-group={owner} className={cn("flex flex-col gap-0.5", index > 0 && "mt-4")}>
              <IdentityRow page={identity.page} current={current === identity.page} badge={identity.badge} name={identity.name} line={identity.line} narrow={narrow} onOpen={() => onOpen(identity.page)} />
              <div className="mt-0.5 flex flex-col gap-0.5">
                {group.map((page) => narrow ? (
                  <button key={page.id} type="button" data-settings-page={page.id} data-settings-section={page.id} onClick={() => onOpen(page.id)}
                    className="flex h-11 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-[14px] leading-5 text-ink hover:bg-menu-hover">
                    <span className="flex w-6 shrink-0 justify-center">{page.icon && <page.icon size={16} strokeWidth={1.75} aria-hidden="true" className="text-ink-secondary" />}</span>
                    <span className="min-w-0 flex-1 truncate">{t(page.labelKey)}</span>
                    {dot(page.id) && <span aria-hidden="true" className={cn("size-1.5 rounded-full", dot(page.id) === "success" ? "bg-success" : "bg-warning")} />}
                    <ChevronRight size={14} aria-hidden="true" className="text-ink-tertiary rtl:-scale-x-100" />
                  </button>
                ) : (
                  <PageItem key={page.id} page={page} label={t(page.labelKey)} current={current === page.id} dot={dot(page.id)} onOpen={() => onOpen(page.id)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {!SIMPLE_ONLY && <AdvancedModeFooter narrow={narrow} onChange={onAdvanced} />}
    </nav>
  );
}

function AdvancedModeFooter({ narrow, onChange }: { narrow: boolean; onChange: (on: boolean) => void }) {
  const advanced = useAdvancedMode();
  return (
    <div data-settings-block="advanced-mode" title={t("settings.advancedMode.tooltip")}
      className={cn("flex h-12 shrink-0 items-center justify-between gap-3 shadow-[inset_0_0.5px_0_var(--settings-edge)]", narrow ? "px-4" : "px-5")}>
      <span id="settings-advanced-mode" className="text-[13px] leading-5 text-ink">{t("settings.advancedMode.title")}</span>
      <Switch checked={advanced} aria-labelledby="settings-advanced-mode" data-settings-advanced-switch="" onClick={() => onChange(!advanced)} />
    </div>
  );
}

function SearchResults({ ctx, place, hits, keyHits, onKey, query, onHit }: {
  ctx: SettingsContext; place: SettingsPlace; hits: SearchHit[]; keyHits: KeyEntry[]; onKey: (entry: KeyEntry) => void; query: string; onHit: (hit: SearchHit) => void;
}) {
  const here = hits.filter((hit) => !hit.elsewhere).slice(0, 8);
  const elsewhere = hits.filter((hit) => hit.elsewhere).slice(0, 8);
  if (here.length === 0 && elsewhere.length === 0 && keyHits.length === 0) {
    return (
      <div data-settings-no-match="" className="flex flex-col items-center gap-1 px-2 py-6 text-center">
        <p className="text-[13px] leading-[18px] text-ink-secondary">{t("settings.noMatch", { query: query.trim() })}</p>
        <a href={HELP_CENTER_URL} target="_blank" rel="noreferrer" className="text-[12px] leading-4 text-accent-text hover:underline">{t("settings.search.helpCenter")}</a>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5" data-settings-results="">
      {here.map((hit) => <HitRow key={`h:${hit.entry.id}`} ctx={ctx} place={place} hit={hit} query={query} onHit={onHit} />)}
      {keyHits.map((entry) => (
        <button key={`k:${entry.id}`} type="button" data-settings-key-result={entry.id} onClick={() => onKey(entry)}
          className="flex w-full cursor-pointer flex-col rounded-lg px-2 py-1.5 text-left hover:bg-menu-hover focus-visible:bg-menu-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
          <span className="truncate text-[13px] leading-5 text-ink">{highlight(t(entry.labelKey), query)}</span>
          <span className="truncate text-[12px] leading-4 text-ink-secondary">{[place.name, t("settings.group.ai"), t(keySection(entry).titleKey)].join(" › ")}</span>
        </button>
      ))}
      {elsewhere.length > 0 && (
        <>
          <div className="px-2 pb-1 pt-3 text-[12px] leading-4 text-ink-secondary">{t("settings.search.otherPlaces")}</div>
          {elsewhere.map((hit) => <HitRow key={`e:${hit.entry.id}`} ctx={ctx} place={place} hit={hit} query={query} onHit={onHit} />)}
        </>
      )}
    </div>
  );
}

function highlight(label: string, query: string): ReactNode {
  const at = label.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  if (at < 0 || !query.trim()) return label;
  const end = at + query.trim().length;
  return <>{label.slice(0, at)}<span className="font-medium">{label.slice(at, end)}</span>{label.slice(end)}</>;
}

export function hitLabel(hit: SearchHit, place: SettingsPlace, desktop: boolean): string {
  if (hit.entry.id === "page:overview") return place.name;
  if (hit.entry.id === "page:account") return t("settings.page.account");
  if (hit.entry.id === "page:app") return desktop ? t("settings.page.app") : t("settings.page.browser");
  return t(hit.entry.labelKey, { app: productName(), helper: "" });
}

function HitRow({ ctx, place, hit, query, onHit }: { ctx: SettingsContext; place: SettingsPlace; hit: SearchHit; query: string; onHit: (hit: SearchHit) => void }) {
  const entry = hit.entry;
  const label = hitLabel(hit, place, ctx.desktop);
  const where = searchWhere(hit, place, ctx);
  const full = searchLocation(hit, place, ctx);
  const Icon = entry.jump ? null : pageById(entry.page).icon;
  const tag = hit.advanced && !ctx.advanced;
  // The title gets the whole width (up to two lines); the second line is "owner › page", where the owner gives way
  // first so the page name always shows, and the Advanced tag follows it. The full path is the row's tooltip.
  return (
    <button type="button" data-settings-hit={entry.id} onClick={() => onHit(hit)} title={full ? `${label} · ${full}` : label}
      className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-menu-hover focus-visible:bg-menu-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
      <span className="flex h-5 w-6 shrink-0 items-center justify-center text-ink-secondary">{Icon && <Icon size={16} strokeWidth={1.75} aria-hidden="true" />}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span data-settings-hit-title="" className="line-clamp-2 text-[13px] leading-5 text-ink [overflow-wrap:anywhere]">{highlight(label, query)}</span>
        {(where || tag) && (
          <span data-settings-hit-location="" className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-secondary">
            {where && (
              <span className="flex min-w-0 flex-[0_1_auto] overflow-hidden whitespace-nowrap">
                {/* The owner gives way a hundred times faster than the page, so the page name stays whole. */}
                <span className="min-w-[1.5em] shrink-[100] overflow-hidden text-ellipsis">{where.owner}</span>
                {where.page && <span className="min-w-0 shrink overflow-hidden text-ellipsis">{` › ${where.page}`}</span>}
              </span>
            )}
            {tag && <span className="flex flex-none"><SettingsTag>{t("settings.simple.advanced")}</SettingsTag></span>}
          </span>
        )}
      </span>
      {entry.jump && <ArrowUpRight size={12} aria-hidden="true" className="mt-1 shrink-0 text-ink-tertiary" />}
    </button>
  );
}

const PAGE_OWNER: Record<SettingsPageId, SettingsOwner> = {
  overview: "place", phone: "place", ai: "place", bots: "place", desktops: "place", vault: "place", usage: "place", data: "place",
  people: "place", installations: "place", account: "account", plan: "account", app: "app", general: "app", appearance: "app",
};

const PAGE_KEY: Partial<Record<SettingsPageId, Parameters<typeof t>[0]>> = {
  phone: "settings.section.phoneDevices", ai: "settings.group.ai", bots: "settings.page.bots", desktops: "settings.page.desktops",
  vault: "settings.section.vault", usage: "settings.page.spending", data: "settings.page.data", people: "settings.section.people",
  installations: "settings.section.workspaces", plan: "settings.page.plan", general: "settings.section.general", appearance: "settings.section.appearance",
};

/** A result's second line: its owner and its page ("This computer › Phone & devices"), or what a jump opens. */
export function searchWhere(hit: SearchHit, place: SettingsPlace, ctx: SettingsContext): { owner: string; page?: string } | null {
  const entry = hit.entry;
  if (entry.jump) return { owner: searchLocation(hit, place, ctx) };
  if (entry.id.startsWith("page:") && (entry.page === "overview" || entry.page === "account" || entry.page === "app")) return null;
  const owner = PAGE_OWNER[entry.page];
  const ownerName = hit.elsewhere ? t("rail.thisComputer") : owner === "place" ? place.name : ownerLabel(owner, place, ctx.desktop);
  const pageKey = PAGE_KEY[entry.page];
  return { owner: ownerName, ...(pageKey && !entry.id.startsWith("page:") ? { page: t(pageKey) } : {}) };
}

/** The full path, owner first ("This computer › Phone & devices › How your phone reaches this computer"): the tooltip. */
export function searchLocation(hit: SearchHit, place: SettingsPlace, ctx: SettingsContext): string {
  const entry = hit.entry;
  if (entry.jump === "apps") return t("settings.search.opensApps");
  if (entry.jump === "bot") return t("settings.search.onEachBot");
  if (entry.jump === "automations") return t("settings.search.opensAutomations");
  if (entry.jump === "shortcuts") return t("settings.search.opensShortcuts");
  const owner = PAGE_OWNER[entry.page];
  // Every location starts with its owner (the place, Your account, This app), so the path reads the same everywhere.
  const ownerName = hit.elsewhere ? t("rail.thisComputer") : owner === "place" ? place.name : ownerLabel(owner, place, ctx.desktop);
  const pageKey = PAGE_KEY[entry.page];
  const parts: string[] = [ownerName];
  if (pageKey && !entry.id.startsWith("page:")) parts.push(t(pageKey));
  const label = hitLabel(hit, place, ctx.desktop);
  if (entry.sectionKey && t(entry.sectionKey) !== label) parts.push(t(entry.sectionKey));
  if (entry.id.startsWith("page:") && (entry.page === "overview" || entry.page === "account" || entry.page === "app")) return "";
  return parts.join(" › ");
}

