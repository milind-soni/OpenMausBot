import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Search, Server, TriangleAlert, X } from "lucide-react";
import { api, type Bot, type InstanceInfo } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { cn } from "@/lib/cn";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { activeLocale, intlLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { readCachedInventory } from "@/lib/connected-apps-cache";
import { connectorStatusMemory, preloadConnectedApps, rememberConnectorStatus } from "@/lib/connected-apps";
import { reserveConnectionPage, type PendingAuthorization } from "@/lib/connector-oauth";
import { mcpSignInLink } from "@/lib/mcp-sign-in";
import { pollConnector } from "@/lib/connector-poll";
import { connectorConnect } from "@/lib/product-events";
import { managedConnectorUnavailableReason } from "../../shared/connector-availability";
import { isConnectorToolGrantShape } from "@/lib/connector-grants";
import {
  accountAliasTaken,
  connectedInventoryCopy,
  hasActiveConnection,
  requiresAccountAlias,
  type ConnectorAccount,
  type ConnectorInventoryPhase,
  type ConnectorStatus,
} from "@/lib/connector-status";
import { SidebarPopoverMenu } from "./SidebarPopoverMenu";
import { appCategoryLabel, CATEGORY_SECTION_SIZE, catalogSections, connectorDescription, inCategory, rankCategories } from "@/lib/app-catalog";
import { McpServersPanel } from "./McpServersPanel";
import { HOSTED_MCP_APPS, mcpServerConnected, ownMcpServer, type HostedApp, type HostedConnections } from "@/lib/hosted-mcp-apps";
import { isRemoteMcpListing, type McpServerListing } from "./mcp-draft";
import { useSuggestedApps } from "@/lib/app-suggestions";
import { matchesCatalogSearch } from "../../shared/app-suggestions";
import { EmailCard } from "./EmailCard";
import { PostizCard } from "./PostizCard";
import { POSTIZ_CATALOG_CARD, POSTIZ_SEARCH } from "@/lib/postiz";
import { X_CARD_SEARCH, XCard } from "./XCard";
import { mergeCompleteConnectorStatus, mergeCurrentConnectorStatus, onlyLatestConnectorResponses } from "@/lib/connector-status-merge";
import { openBotSettings } from "./bot-panel/panel-link";
import { openKeySettings } from "./keys/key-focus";
import { lacksAdminScope } from "@/lib/admin-scope";
import { SavedKeysReset } from "./SavedKeysReset";
import { botAppScope } from "@/lib/bot-app-access";
import { AppGrantPrompt, botsForApps, useAppGrants } from "./AppGrantPrompt";
import { ConfirmDialog } from "./ConfirmDialog";
import { ServiceIcon, type ToolkitCard } from "./ServiceIcon"; import { AppsSection } from "./AppsSection";
import { AppTile, tileStanding, useTileActions } from "./AppTile";
import { appCatalogMemory, loadAppCatalog, onAppCatalog, type AppCatalog, type CatalogPagination, type ConnectorSetup } from "@/lib/app-catalog-cache";
export { ServiceIcon, type ToolkitCard } from "./ServiceIcon";

export { preloadConnectedApps, type ConnectorInventory } from "@/lib/connected-apps";

export function disconnectAccountConfirmation(
  service: string,
  account: { id: string; alias?: string },
) {
  const identity = account.alias ? `“${account.alias}” (${account.id})` : `“${account.id}”`;
  return t("connectors.disconnectConfirm", { identity, service });
}

export function botsWithLimitedServiceTools(bots: Bot[], instances: InstanceInfo[], slug: string): Bot[] {
  return bots.filter((bot) => {
    if (bot.hidden || bot.composio === false) return false;
    if (!instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)
      ?.capabilities?.composioMcp) return false;
    const record: unknown = bot.connectorTools;
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    const grant = (record as Record<string, unknown>)[slug];
    if (grant === undefined) return true;
    return !isConnectorToolGrantShape(grant) || grant.tools !== "*";
  });
}

/** Whether a hosted app's card shows: it matches the search, and the filter is All, or Connected and it isn't known to be
 * disconnected (unknown while its servers load). */
export function hostedShown(app: HostedApp, search: string, filter: AppsFilter, connected: HostedConnections | null): boolean {
  const matches = !search || `${app.label} ${app.keywords} ${t(app.description)}`.toLowerCase().includes(search.toLowerCase().trim());
  return matches && (filter === "all" || (filter === "connected" && connected?.[app.id] !== false));
}

export type { CatalogPagination, ConnectorSetup } from "@/lib/app-catalog-cache";

export function connectorSetupNotice(state: {
  configured: boolean;
  stale: boolean;
  setup: ConnectorSetup | undefined;
  remoteClient: boolean;
}): { key: LocaleKey; tone: "info" | "warning" } | null {
  if (state.configured || state.stale) return null;
  if (state.setup === "needs-setup") {
    return { key: state.remoteClient ? "connectors.setupNeededRemote" : "connectors.setupNeeded", tone: "info" };
  }
  return { key: "connectors.notConfigured", tone: "warning" };
}

export type AppsFilter = "all" | "connected" | "mcp";

export const APPS_PREVIEW_COUNT = 48;

export { USED_BY_AVATAR_SIZE } from "./AppTile";

const NO_BOTS: readonly Bot[] = [];
/** A config frame brings the policy as a new object each time; the tiles get the one they have while it says the same. */
const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function botsUsingService(bots: Bot[], instances: InstanceInfo[], slug: string): Bot[] {
  return botsForApps(bots, instances).filter((bot) => botAppScope(bot, slug) !== null);
}

export function PluginsPanel() {
  const surface = useStoreSelector((state) => state.pluginsSurface);
  const bots = useStoreSelector((state) => state.bots);
  const instances = useStoreSelector((state) => state.instances);
  const policy = useStoreSelector((state) => state.config?.managedPolicy, sameJson);
  const dispatch = useStoreDispatch();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const dialogRef = useRef<HTMLDivElement>(null);
  const [cards, setCards] = useState<ToolkitCard[] | null>(() => appCatalogMemory()?.cards ?? null);
  const [source, setSource] = useState<"api" | "curated">(() => appCatalogMemory()?.source ?? "curated");
  const [pagination, setPagination] = useState<CatalogPagination | null>(() => appCatalogMemory()?.pagination ?? null);
  const [configured, setConfigured] = useState(() => appCatalogMemory()?.configured ?? false);
  const [mode, setMode] = useState<AppCatalog["mode"]>(() => appCatalogMemory()?.mode ?? "unavailable");
  const [setup, setSetup] = useState<ConnectorSetup | undefined>(() => appCatalogMemory()?.setup);
  const [status, setStatus] = useState<Record<string, ConnectorStatus>>(
    () => connectorStatusMemory()?.services ?? readCachedInventory()?.services ?? {},
  );
  const [stale, setStale] = useState(
    connectorStatusMemory()?.authoritative === false,
  );
  const [pendingUrls, setPendingUrls] = useState<Record<string, PendingAuthorization>>({});
  const [aliasSlug, setAliasSlug] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [inventoryPhase, setInventoryPhase] = useState<ConnectorInventoryPhase>(
    connectorStatusMemory() === null ? "loading" : "ready",
  );
  const [error, setError] = useState<string | { key: LocaleKey } | null>(null);
  const [typed, setSearch] = useState("");
  const [tab, setTab] = useState<"marketplace" | "connected">("marketplace");
  const [showAllApps, setShowAllApps] = useState(false);
  const [hostedConnected, setHostedConnected] = useState<HostedConnections | null>(null);
  const [cardsRefresh, setCardsRefresh] = useState(0);
  const [category, setCategory] = useState<string | null>(null);
  // Appended after the older state so tests that seed state by call order keep their indices.
  const [xConnected, setXConnected] = useState<boolean | null>(null);
  const [postizConnected, setPostizConnected] = useState<boolean | null>(null);
  const [emailConnected, setEmailConnected] = useState<boolean | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerListing[]>([]);

  const disconnectingRef = useRef<{ slug: string; label: string; account: ConnectorAccount } | null>(null);
  const polls = useRef(new Map<string, () => void>());
  const statusGenerations = useRef(new Map<string, number>());
  const latestStatusRequests = useRef(new Map<string, number>());
  const opening = useRef<ReturnType<typeof reserveConnectionPage> | null>(null);
  const reconnecting = useRef(new Set<string>());

  /** A connection that finished or failed since a request no newer than this one no longer needs its sign-in page. */
  const forgetSettledUrls = (services: Record<string, ConnectorStatus>, requestGenerations: ReadonlyMap<string, number>) => {
    const settled = Object.entries(services).filter(([slug, state]) => (statusGenerations.current.get(slug) ?? 0) === (requestGenerations.get(slug) ?? 0)
      && ((state.connected && !state.pending) || /^(expired|failed)$/i.test(state.status ?? ""))).map(([slug]) => slug);
    if (settled.length) setPendingUrls((current) => settled.some((slug) => current[slug]) ? Object.fromEntries(Object.entries(current).filter(([slug]) => !settled.includes(slug))) : current);
  };
  const refreshStatus = useCallback((slugs: string[]): Promise<Record<string, ConnectorStatus>> => {
    if (!slugs.length) return Promise.resolve({});
    const requestGenerations = new Map(slugs.map((slug) => [slug, statusGenerations.current.get(slug) ?? 0]));
    const requestIds = new Map(slugs.map((slug) => {
      const requestId = (latestStatusRequests.current.get(slug) ?? 0) + 1;
      latestStatusRequests.current.set(slug, requestId);
      return [slug, requestId];
    }));
    return api(`/api/connectors?services=${slugs.join(",")}`)
      .then((r) => {
        const services = onlyLatestConnectorResponses(
          r.services ?? {},
          latestStatusRequests.current,
          requestIds,
        );
        // A one-service poll must not erase other apps' state, and a request older than Connect must not erase the
        // newer INITIATED state.
        setStatus((current) => mergeCurrentConnectorStatus(
          current,
          services,
          statusGenerations.current,
          requestGenerations,
        ));
        forgetSettledUrls(services, requestGenerations);
        return services;
      })
      .catch(() => ({}));
  }, []);

  const refreshConnectedStatus = useCallback((force = false): Promise<Record<string, ConnectorStatus>> => {
    const requestGenerations = new Map(statusGenerations.current);
    setRefreshing(true);
    return preloadConnectedApps(force)
      .then(({ services, authoritative, refused }) => {
        setStale(!authoritative);
        if (refused) setError({ key: "connectors.adminOnly" });
        setStatus((current) => mergeCompleteConnectorStatus(
          current,
          services,
          statusGenerations.current,
          requestGenerations,
          authoritative,
        ));
        forgetSettledUrls(services, requestGenerations);
        return services;
      })
      .finally(() => setRefreshing(false));
  }, []);

  const loadConnectionInventory = useCallback((force = false) => {
    const hadCachedInventory = connectorStatusMemory() !== null;
    if (!hadCachedInventory) setInventoryPhase("loading");
    setError(null);
    return refreshConnectedStatus(force)
      .then((services) => {
        setInventoryPhase("ready");
        return services;
      })
      .catch((cause) => {
        if (!hadCachedInventory) setInventoryPhase("error");
        setError(cause instanceof Error ? cause.message : String(cause));
        return {};
      });
  }, [refreshConnectedStatus]);

  useEffect(() => () => {
    opening.current?.cancel();
    opening.current = null;
    for (const stop of polls.current.values()) stop();
    polls.current.clear();
  }, []);
  const appGrants = useAppGrants({ status, emailConnected, inventoryReady: inventoryPhase === "ready" && !stale });

  useEffect(() => {
    if (inventoryPhase !== "ready") return;
    rememberConnectorStatus(status, !stale);
  }, [inventoryPhase, stale, status]);

  useEffect(() => {
    let alive = true;
    void loadConnectionInventory();
    const stop = onAppCatalog((r) => {
      setCards(r.cards);
      setSource(r.source);
      setPagination(r.pagination);
      setConfigured(r.configured);
      setMode(r.mode);
      setSetup(r.setup);
    });
    loadAppCatalog().catch((e) => {
      if (!alive) return;
      setCards((current) => current ?? []);
      setError(lacksAdminScope(e) ? { key: "connectors.adminOnly" } : e.message);
    });
    return () => {
      alive = false;
      stop();
    };
  }, [loadConnectionInventory]);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);

    const controls = focusable();
    (controls.find((element) => element.matches("input")) ?? controls[0] ?? dialog)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (disconnectingRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "togglePlugins", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (!items.some((element) => element === document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      returnFocus?.focus();
    };
  }, [dispatch]);

  const { suggestions, picking, pick } = useSuggestedApps(cards !== null && configured && inventoryPhase === "ready", `${cardsRefresh}:${Object.keys(status).filter((slug) => status[slug]?.connected).sort().join()}`);
  const [disconnecting, setDisconnecting] = useState<{ slug: string; label: string; account: ConnectorAccount } | null>(null); disconnectingRef.current = disconnecting;

  const openConnectUrl = async (url: string) => {
    if (opening.current) return;
    const launch = reserveConnectionPage();
    opening.current = launch;
    try {
      if (!await launch.open(url) && opening.current === launch) {
        setError({ key: "connectors.popupBlockedContinue" });
      }
    } finally {
      launch.cancel();
      if (opening.current === launch) opening.current = null;
    }
  };

  const startPolling = (slug: string, before: ConnectorStatus | undefined, firstConnection: boolean) => {
    polls.current.get(slug)?.();
    const stop = pollConnector(before, () => refreshStatus([slug]).then((services) => services[slug]), (result) => {
      if (polls.current.get(slug) === stop) polls.current.delete(slug);
      connectorConnect(slug, result);
      if (result === "connected" && firstConnection) appGrants.appConnected(slug, cards?.find((card) => card.slug === slug)?.label ?? slug);
    });
    polls.current.set(slug, stop);
  };

  const connect = async (slug: string, alias?: string, replacing?: ConnectorAccount) => {
    if (busySlug || opening.current) return;
    const launch = reserveConnectionPage();
    opening.current = launch;
    statusGenerations.current.set(slug, (statusGenerations.current.get(slug) ?? 0) + 1);
    setBusySlug(slug);
    setError(null);
    if (replacing) reconnecting.current.add(slug);
    const firstConnection = !reconnecting.current.has(slug) && !hasActiveConnection(status[slug]);
    try {
      const createdAt = Date.now();
      if (replacing) await api(`/api/connectors/${slug}/accounts/${encodeURIComponent(replacing.id)}`, { method: "DELETE" });
      const request: RequestInit = { method: "POST" };
      if (alias) request.body = JSON.stringify({ alias });
      const result = await api(`/api/connectors/${slug}/authorize`, request);
      if (opening.current !== launch) return;
      const url = mcpSignInLink(typeof result.url === "string" ? result.url : null);
      if (!url) throw new Error(t("connectors.invalidAuthorizationUrl"));
      setPendingUrls((current) => ({ ...current, [slug]: { url, createdAt } }));
      setStatus((current) => ({
        ...current,
        [slug]: {
          ...current[slug],
          connected: current[slug]?.connected ?? false,
          pending: true,
          status: "INITIATED",
        },
      }));
      setAliasSlug(null);
      setAliasDraft("");
      startPolling(slug, status[slug], firstConnection);
      if (!await launch.open(url) && opening.current === launch) {
        setError({ key: "connectors.popupBlockedContinue" });
      }
    } catch (e) {
      if (opening.current !== launch) return;
      const message = e instanceof Error ? e.message : String(e);
      if (requiresAccountAlias(message)) {
        setAliasSlug(slug);
        setAliasDraft("");
        setError({ key: "connectors.aliasNeeded" });
        void refreshStatus([slug]);
      } else {
        setError(accountAliasTaken(message) ? { key: "connectors.aliasTaken" } : message);
      }
    } finally {
      launch.cancel();
      if (opening.current === launch) {
        opening.current = null;
        setBusySlug(null);
      }
    }
  };

  const disconnectAccount = (slug: string, accountId: string) => {
    setBusySlug(slug);
    api(`/api/connectors/${slug}/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" })
      .then(() => refreshStatus([slug]))
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  const search = useDeferredValue(typed);
  const matching = useMemo(() => (cards ?? []).filter((c) => (!managedConnectorUnavailableReason(mode, c.slug) || hasActiveConnection(status[c.slug]))
    && matchesCatalogSearch(`${c.label} ${c.slug} ${connectorDescription(c)} ${(c.categories ?? []).join(" ")}`, search)), [cards, mode, status, search]);
  const isConnected = useCallback((slug: string) => Boolean(status[slug]?.connected || status[slug]?.accounts?.length), [status]);
  const filter: AppsFilter = surface === "mcp" ? "mcp" : tab === "connected" ? "connected" : "all";
  const searching = search.trim().length > 0;
  /** A search covers the whole catalog, whichever view it was typed in. */
  const listing: AppsFilter = searching && filter === "connected" ? "all" : filter;
  const shownHosted = new Set(HOSTED_MCP_APPS.filter((app) => hostedShown(app, search, listing, hostedConnected)).map((app) => app.id));
  const showEmail = (!search || `email mail imap smtp mailbox ${t("email.description")}`.toLowerCase().includes(search.toLowerCase().trim())) && (listing === "all" || (listing === "connected" && emailConnected !== false));
  const showX = (!search || `${X_CARD_SEARCH} ${t("apps.x.description")}`.toLowerCase().includes(search.toLowerCase().trim())) && (listing === "all" || (listing === "connected" && xConnected !== false));
  const showPostiz = (!search || `${POSTIZ_SEARCH} ${t("postiz.description")}`.toLowerCase().includes(search.toLowerCase().trim())) && (listing === "all" || (listing === "connected" && postizConnected !== false));
  const visible = useMemo(() => (listing === "connected" ? matching.filter((card) => isConnected(card.slug)) : matching)
    .map((card, index) => ({ card, index }))
    .sort((a, b) => Number(isConnected(b.card.slug)) - Number(isConnected(a.card.slug)) || a.index - b.index)
    .map(({ card }) => card), [listing, matching, isConnected]);
  const connectedHosted = HOSTED_MCP_APPS.filter((app) => hostedConnected?.[app.id]);
  const ownServers = mcpServers.filter((server) => ownMcpServer(server));
  const ownServerShown = (server: McpServerListing) => matchesCatalogSearch(`${server.name} ${isRemoteMcpListing(server) ? server.url : [server.command, ...server.args].join(" ")}`, search);
  const connectedCount = Object.values(status).filter(hasActiveConnection).length + connectedHosted.length + ownServers.filter(mcpServerConnected).length + Number(emailConnected === true) + Number(xConnected === true) + Number(postizConnected === true);
  const connectedEmptyCopy = connectedInventoryCopy(inventoryPhase);
  const close = () => dispatch({ type: "togglePlugins", open: false });
  const setupNotice = connectorSetupNotice({ configured, stale, setup, remoteClient });
  const chooseFilter = (next: AppsFilter) => {
    setCategory(null);
    if (next === "mcp") {
      dispatch({ type: "togglePlugins", open: true, surface: "mcp" });
      return;
    }
    setTab(next === "connected" ? "connected" : "marketplace");
    if (surface !== "apps") dispatch({ type: "togglePlugins", open: true, surface: "apps" });
  };

  const ranked = useMemo(() => rankCategories([...(cards ?? []), POSTIZ_CATALOG_CARD], undefined, POSTIZ_CATALOG_CARD.categories), [cards]);
  const moreCategories = ranked.more;
  const categoryInMore = category !== null && moreCategories.includes(category);
  const inCategoryView = filter === "all" && category !== null && !searching;
  const postizHere = showPostiz && (!inCategoryView || inCategory(POSTIZ_CATALOG_CARD, category));
  const nativeCardsShown = (!inCategoryView && (shownHosted.size > 0 || showEmail || showX)) || postizHere || (filter === "connected" && ownServers.some((server) => server.enabled && ownServerShown(server)));
  const categoryCards = useMemo(() => inCategoryView ? visible.filter((card) => inCategory(card, category)) : visible, [inCategoryView, visible, category]);
  const sectioned = filter === "all" && !searching && category === null;
  const sections = useMemo(() => sectioned ? catalogSections(visible, isConnected, ranked.inline) : [], [sectioned, visible, isConnected, ranked]);
  const allSection = sections.find((section) => section.kind === "all");
  const allCards = sectioned ? allSection?.cards ?? [] : categoryCards;
  const allCapped = sectioned && !showAllApps && allCards.length > APPS_PREVIEW_COUNT;
  const allShown = allCapped ? allCards.slice(0, APPS_PREVIEW_COUNT) : allCards;
  const connectedCards = useMemo(() => (cards ?? []).filter((card) => hasActiveConnection(status[card.slug])), [cards, status]);
  const botLists = useMemo(() => {
    const cached = (find: (slug: string) => Bot[]) => {
      const found = new Map<string, Bot[]>();
      return (slug: string) => found.get(slug) ?? found.set(slug, find(slug)).get(slug)!;
    };
    return { usedBy: cached((slug) => botsUsingService(bots, instances, slug)), limited: cached((slug) => botsWithLimitedServiceTools(bots, instances, slug)) };
  }, [bots, instances]);
  const tileActions = useTileActions({
    connect: (slug, alias, replacing) => void connect(slug, alias, replacing),
    openUrl: (url) => { setError(null); void openConnectUrl(url).catch((e) => setError(e.message)); },
    toggleAlias: (slug) => { setAliasSlug((current) => current === slug ? null : slug); setAliasDraft(""); },
    setAliasDraft,
    aliasRequired: () => setError({ key: "connectors.aliasRequired" }),
    changeBots: appGrants.change,
    disconnect: setDisconnecting,
    openBotApps: (botId) => { close(); openBotSettings(dispatch, "access", { botId, page: "apps" }); },
  });
  const pickCategory = (next: string | null) => {
    setCategory(next);
    setTab("marketplace");
    if (surface !== "apps") dispatch({ type: "togglePlugins", open: true, surface: "apps" });
  };
  const listTitle = searching
    ? t("connectors.section.results")
    : filter === "connected"
      ? t("connectors.section.yours")
      : category ? appCategoryLabel(category) : (sections.length > 1 ? t("apps.section.all") : t("connectors.section.available"));
  const pill = "inline-flex h-7 shrink-0 items-center justify-center gap-2 rounded-full px-3 text-[13px] font-medium leading-5 transition-colors";
  const pillTone = (selected: boolean) => selected
    ? "bg-ink text-app"
    : "bg-control/70 text-ink-secondary hover:bg-raised-hover hover:text-ink";

  return (
    <div
      className="glass-popup-frame"
      style={glassPopupFrameStyle()}
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      {/* A sibling, not the parent: a backdrop-filter on an ancestor would stop the pop-up's own glass from seeing the app behind it. */}
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
      <div
        ref={dialogRef}
        data-tour="apps-panel"
        role="dialog" data-look="dialog"
        aria-modal="true"
        aria-labelledby="plugins-title"
        tabIndex={-1}
        className="glass-surface glass-popup animate-pop-in relative flex max-w-[780px] flex-col overflow-hidden rounded-2xl"
      >
        <header className="flex flex-col gap-4 px-5 pb-4 pt-5 sm:px-7 sm:pt-6">
          <div>
          <div className="flex items-center justify-between gap-3">
            <h2 id="plugins-title" className="min-w-0 truncate text-[20px] font-semibold leading-7 tracking-[-0.01em] text-ink">{t("apps.title")}</h2>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                data-apps-filter="connected"
                aria-pressed={filter === "connected"}
                onClick={() => chooseFilter(filter === "connected" ? "all" : "connected")}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-full ps-1.5 pe-2 text-[13px] font-medium leading-5 transition-colors",
                  filter === "connected" ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
                )}
              >
                {connectedCards.length > 0 && (
                  <span aria-hidden="true" className="flex -space-x-1.5 rtl:space-x-reverse">
                    {connectedCards.slice(0, 4).map((card) => (
                      <span key={card.slug} className="flex size-5 items-center justify-center overflow-hidden rounded-md bg-menu ring-2 ring-menu">
                        <ServiceIcon card={card} className="size-5 rounded-md" />
                      </span>
                    ))}
                  </span>
                )}
                <span className="whitespace-nowrap">
                  {connectedCount > 0 ? t("apps.connectedCount", { count: connectedCount }) : t("apps.filter.connected")}
                </span>
                <ChevronRight size={14} aria-hidden="true" className="shrink-0 rtl:-scale-x-100" />
              </button>
              <button
                onClick={() => { setCardsRefresh((value) => value + 1); void loadConnectionInventory(true); }}
                disabled={refreshing}
                className="flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                title={t("connectors.refreshTitle")}
                aria-label={t("connectors.refreshTitle")}
              >
                <RefreshCw size={16} className={cn(refreshing && "animate-spin")} />
              </button>
              <button data-tour="apps-close"
                onClick={close}
                aria-label={t("connectors.closeAria")}
                className="flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <X size={18} />
              </button>
            </div>
          </div>
          <p className="mt-0.5 text-[13px] leading-5 text-ink-secondary">{t("apps.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-control/70 px-3.5 focus-within:ring-1 focus-within:ring-accent">
              <Search size={15} className="shrink-0 text-ink-secondary" />
              <input
                value={typed}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("connectors.searchPlaceholder")}
                aria-label={t("connectors.searchPlaceholder")}
                className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
              />
            </label>
            <button
              type="button"
              data-apps-filter="mcp"
              aria-pressed={filter === "mcp"}
              onClick={() => chooseFilter(filter === "mcp" ? "all" : "mcp")}
              className={cn(pill, "h-9 border border-hairline/40 px-3.5", filter === "mcp" ? "bg-ink text-app" : "text-ink hover:bg-raised")}
            >
              <Server size={14} aria-hidden="true" />
              <span className="hidden sm:inline">{t("apps.filter.mcp")}</span>
              <span className="sr-only sm:hidden">{t("apps.filter.mcp")}</span>
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("apps.categoriesAria")}>
            <button
              type="button"
              data-apps-filter="all"
              aria-pressed={filter === "all" && category === null}
              onClick={() => { chooseFilter("all"); setCategory(null); }}
              className={cn(pill, pillTone(filter === "all" && category === null))}
            >
              {t("apps.filter.all")}
            </button>
            {ranked.inline.map((name) => (
              <button
                key={name}
                type="button"
                data-apps-category={name}
                aria-pressed={filter === "all" && category === name}
                onClick={() => pickCategory(category === name ? null : name)}
                className={cn(pill, pillTone(filter === "all" && category === name))}
              >
                {appCategoryLabel(name)}
              </button>
            ))}
            {moreCategories.length > 0 && (
              <SidebarPopoverMenu
                ariaLabel={t("apps.moreCategories")}
                items={moreCategories.map((name) => ({ key: name, label: appCategoryLabel(name), active: category === name, onSelect: () => pickCategory(name) }))}
                renderTrigger={({ open }) => (
                  <span className={cn(pill, pillTone(filter === "all" && categoryInMore), open && !categoryInMore && "bg-raised-hover text-ink")}>
                    {categoryInMore ? appCategoryLabel(category) : t("apps.more")}
                    <ChevronDown size={14} aria-hidden="true" />
                  </span>
                )}
              />
            )}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-7 sm:px-7">
          {stale ? (
            <div className="mb-3 flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-[13px] text-warning">
              <TriangleAlert size={14} className="mt-px shrink-0" />
              <span>
                {t("connectors.stale")}
                <SavedKeysReset />
              </span>
            </div>
          ) : (
            <SavedKeysReset notice />
          )}
          {setupNotice && filter !== "mcp" && (
            <div
              className={cn(
                "mb-3 rounded-xl px-4 py-3 text-[13px]",
                setupNotice.tone === "warning" ? "bg-warning/10 text-warning" : "bg-control/50 text-ink-secondary",
              )}
            >
              {connectedHosted.length > 0
                ? t("hostedMcp.otherAppsSetup", { services: new Intl.ListFormat(activeLocale(), { style: "long", type: "conjunction" }).format(connectedHosted.map((app) => app.label)) })
                : t(setupNotice.key)}{" "}
              <button
                className={cn(
                  "font-medium underline underline-offset-2",
                  setupNotice.tone === "info" && "text-ink",
                  remoteClient && "hidden",
                )}
                onClick={() => { close(); dispatch(openKeySettings("composio")); }}
              >
                {t("connectors.openSettings")}
              </button>
            </div>
          )}
          {configured && !remoteClient && source === "curated" && mode === "self-hosted" && filter !== "mcp" && (
            <div className="mb-3 text-[12px] text-ink-secondary">
              {t("connectors.featuredBefore")}{" "}
              <button
                className="underline underline-offset-2 hover:text-ink"
                onClick={() => {
                  close();
                  dispatch({ type: "toggleAppSettings", open: true });
                }}
              >
                {t("connectors.updateKey")}
              </button>{" "}
              {t("connectors.featuredAfter")}
            </div>
          )}
          {error && <div role="alert" className="mb-3 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger">{typeof error === "string" ? error : t(error.key)}</div>}

          {filter !== "mcp" && (
            <div data-apps-grid className="@container flex flex-col gap-7 pt-1">
              {!sections.some((section) => section.kind === "connected") && renderSuggested()}
              {sections.filter((section) => section.kind !== "all").map((section) => section.kind === "connected" ? (
                <Fragment key="connected">
                  <AppsSection
                    id="apps-section-connected"
                    title={t("apps.section.connected")}
                    viewAll={section.cards.length > CATEGORY_SECTION_SIZE ? { label: t("apps.viewAll"), onClick: () => chooseFilter("connected") } : undefined}
                  >
                    {section.cards.slice(0, CATEGORY_SECTION_SIZE).map((card) => renderTile(card))}
                  </AppsSection>
                  {renderSuggested()}
                </Fragment>
              ) : (
                <AppsSection
                  key={section.category}
                  id={`apps-section-${section.category}`}
                  title={appCategoryLabel(section.category)}
                  viewAll={section.more ? { label: t("apps.viewAll"), onClick: () => pickCategory(section.category) } : undefined}
                >
                  {section.cards.map((card) => renderTile(card))}
                </AppsSection>
              ))}
              <AppsSection
                id="apps-grid-title"
                title={listTitle}
                note={filter === "all" && !search && category === null && pagination
                  && (pagination.stalled || (pagination.totalItems !== undefined && pagination.items < pagination.totalItems))
                  ? `${pagination.totalItems !== undefined && pagination.items < pagination.totalItems
                    ? t("connectors.marketplace.partialCount", {
                      shown: pagination.items.toLocaleString(intlLocale()),
                      total: pagination.totalItems.toLocaleString(intlLocale()),
                    })
                    : t("connectors.marketplace.partialStalled")}${pagination.reason
                    ? ` — ${t("connectors.marketplace.partialReason", { reason: pagination.reason })}`
                    : ""}`
                  : undefined}
                viewAll={allCapped ? { label: t("apps.viewAll"), onClick: () => setShowAllApps(true) } : undefined}
                after={(
                  <>
                    {cards === null && (
                      <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary">
                        <Loader2 size={14} className="animate-spin" /> {t("connectors.loadingCatalog")}
                      </div>
                    )}
                    {allCapped && (
                      <div className="mt-4 flex justify-center">
                        <button
                          type="button"
                          onClick={() => setShowAllApps(true)}
                          className={cn(pill, "bg-control/70 px-4 text-ink hover:bg-raised-hover")}
                        >
                          {t("apps.showAll", { count: allCards.length.toLocaleString(intlLocale()) })}
                        </button>
                      </div>
                    )}
                    {cards !== null && allShown.length === 0 && !nativeCardsShown && sections.length <= 1 && (
                      <div className="flex min-h-40 flex-col items-center justify-center text-center">
                        <div className="text-[14px] font-medium text-ink">
                          {listing === "connected" ? connectedEmptyCopy.title : t("connectors.noAppsFound")}
                        </div>
                        <div className="mt-1 text-[13px] text-ink-secondary">
                          {listing === "connected" ? connectedEmptyCopy.description : t("connectors.tryDifferentSearch")}
                        </div>
                        {filter === "connected" && inventoryPhase === "error" && (
                          <button
                            type="button"
                            disabled={refreshing}
                            onClick={() => void loadConnectionInventory(true)}
                            className={cn(pill, "mt-4 bg-raised text-ink hover:bg-raised-hover disabled:opacity-50")}
                          >
                            <RefreshCw size={14} className={cn(refreshing && "animate-spin")} />
                            {t("connectors.action.retry")}
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              >
                <McpServersPanel hostedCards={{ shown: (id) => !inCategoryView && shownHosted.has(id), onConnections: setHostedConnected, onServers: setMcpServers, ...(filter === "connected" ? { ownServers: { shown: ownServerShown, manage: () => chooseFilter("mcp") } } : {}) }} refreshKey={cardsRefresh} />
                <div data-native-card="x" className={showX && !inCategoryView ? "contents" : "hidden"}><XCard refreshKey={cardsRefresh} onConnection={setXConnected} /></div>
                <div data-native-card="email" className={showEmail && !inCategoryView ? "contents" : "hidden"}><EmailCard refreshKey={cardsRefresh} onConnection={setEmailConnected} /></div>
                <div data-native-card="postiz" className={postizHere ? "contents" : "hidden"}><PostizCard refreshKey={cardsRefresh} onConnection={setPostizConnected} /></div>
                {allShown.map((card) => renderTile(card))}
              </AppsSection>
            </div>
          )}

          {filter !== "connected" && category === null && (
            <div className={cn(filter === "all" && "mt-8 border-t border-hairline/30 pt-6", filter === "mcp" && "pt-1")}>
              <McpServersPanel embedded hideHosted={filter === "all"} />
            </div>
          )}
        </div>
        <ConfirmDialog open={disconnecting !== null} layer="z-[60]" tone="danger" title={t("connectors.disconnect")} confirmLabel={t("connectors.disconnect")}
          body={disconnecting ? disconnectAccountConfirmation(disconnecting.label, disconnecting.account) : ""} onCancel={() => setDisconnecting(null)}
          onConfirm={() => { if (disconnecting) disconnectAccount(disconnecting.slug, disconnecting.account.id); setDisconnecting(null); }} />
        {appGrants.changing && (
          <AppGrantPrompt
            key={appGrants.changing}
            app={cards?.find((card) => card.slug === appGrants.changing)?.label ?? appGrants.changing}
            slug={appGrants.changing}
            bots={appGrants.bots}
            onDone={appGrants.done}
            onDismiss={appGrants.dismiss}
          />
        )}
      </div>
    </div>
  );

  function renderSuggested() {
    const shown = suggestions.cards.filter((card) => !isConnected(card.slug));
    if (!sectioned || shown.length === 0) return null;
    const action = suggestions.pick === "available"
      ? { label: t(picking ? "apps.suggested.picking" : "apps.suggested.show"), onClick: pick }
      : suggestions.pick === "needs-key" && !remoteClient
        ? { label: t("apps.suggested.addKey"), onClick: () => { close(); dispatch(openKeySettings("jev")); } }
        : undefined;
    return (
      <AppsSection id="apps-section-suggested" title={t("apps.section.suggested")} note={suggestions.pick === "picked" ? t("apps.suggested.picked") : undefined} viewAll={action}>
        {shown.map((card) => renderTile(card))}
      </AppsSection>
    );
  }

  function renderTile(card: ToolkitCard) {
    const serviceStatus = status[card.slug];
    const standing = tileStanding(card, serviceStatus);
    return (
      <AppTile
        key={card.slug}
        card={card}
        serviceStatus={serviceStatus}
        pendingUrl={pendingUrls[card.slug]}
        aliasDraft={aliasSlug === card.slug ? aliasDraft : null}
        busy={busySlug === card.slug}
        configured={configured}
        inventoryPhase={inventoryPhase}
        mode={mode}
        policy={policy}
        usedBy={standing.connected || standing.included ? botLists.usedBy(card.slug) : NO_BOTS}
        limited={serviceStatus?.connected || standing.included ? botLists.limited(card.slug) : NO_BOTS}
        canChangeBots={appGrants.canChange}
        actions={tileActions}
      />
    );
  }
}
