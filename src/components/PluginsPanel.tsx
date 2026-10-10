// Connected apps marketplace, backed by Composio Sessions. Catalog comes
// from /api/connectors/catalog — the full toolkit list with logos when a
// Composio API key is configured, a curated set otherwise. Icons resolve
// logo → favicon → monogram.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2, RefreshCw, Search, Server, TriangleAlert, X } from "lucide-react";
import { api, useStore, type Bot, type InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { readCachedInventory, writeCachedInventory } from "@/lib/connected-apps-cache";
import { reserveConnectionPage, reusableConnectionUrl, type PendingAuthorization } from "@/lib/connector-oauth";
import { mcpSignInLink } from "@/lib/mcp-sign-in";
import { managedConnectorUnavailableReason } from "../../shared/connector-availability";
import { connectorServiceAccess, isConnectorToolGrantShape } from "@/lib/connector-grants";
import { BotAvatar } from "./Avatar";
import { SidebarPopoverMenu } from "./SidebarPopoverMenu";
import { CATEGORY_SECTION_SIZE, catalogSections, inCategory, rankCategories } from "@/lib/app-catalog";
import { McpServersPanel } from "./McpServersPanel";

export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  noAuth?: boolean;
  domain: string | null;
  /** the marketplace's own categories, grouped and filtered by below */
  categories?: string[];
}

export interface ConnectorStatus {
  connected: boolean;
  pending?: boolean;
  status?: string;
  accounts?: Array<{
    id: string;
    alias?: string;
    status: string;
  }>;
}

// The panel is a modal and unmounts whenever it closes. Keep the last known
// account inventory at module scope so reopening never flashes every service
// as disconnected while a fresh secure status check runs in the background.
let cachedConnectorStatus: Record<string, ConnectorStatus> | null = null;
let cachedConnectorStatusAt = 0;
let cachedConnectorStatusAuthoritative = true;
let connectorStatusRequest: Promise<ConnectorInventory> | null = null;
const CONNECTOR_STATUS_CACHE_MS = 30_000;

export interface ConnectorInventory {
  services: Record<string, ConnectorStatus>;
  /** false when the server could not read the credential store: the list is
   * then "we do not know", and nothing may be cleared on the strength of it */
  authoritative: boolean;
}

/** Warm the account inventory once the app server is ready. Concurrent panel
 * opens share the same request, and recent data survives modal unmounts. */
export function preloadConnectedApps(force = false): Promise<ConnectorInventory> {
  if (!force && cachedConnectorStatus !== null && Date.now() - cachedConnectorStatusAt < CONNECTOR_STATUS_CACHE_MS) {
    return Promise.resolve({
      services: cachedConnectorStatus,
      authoritative: cachedConnectorStatusAuthoritative,
    });
  }
  if (connectorStatusRequest) return connectorStatusRequest;
  connectorStatusRequest = api("/api/connectors/connected")
    .then((response) => {
      const services: Record<string, ConnectorStatus> = response.services ?? {};
      // An unreadable credential store tells us nothing about what is
      // connected. Keep the last inventory we were sure about instead.
      if (response.credentialStore === "unavailable") {
        return { services: readCachedInventory()?.services ?? {}, authoritative: false };
      }
      cachedConnectorStatus = services;
      cachedConnectorStatusAt = Date.now();
      cachedConnectorStatusAuthoritative = true;
      writeCachedInventory(services, Date.now());
      return { services, authoritative: true };
    })
    .catch(() => ({ services: readCachedInventory()?.services ?? {}, authoritative: false }))
    .finally(() => {
      connectorStatusRequest = null;
    });
  return connectorStatusRequest;
}

export function disconnectAccountConfirmation(
  service: string,
  account: { id: string; alias?: string },
) {
  const identity = account.alias ? `“${account.alias}” (${account.id})` : `“${account.id}”`;
  return t("connectors.disconnectConfirm", { identity, service });
}

/** Bots that cannot see the workspace's connected apps because their own
 * per-bot grant is off. Connecting an app is only half of it: a bot a Chief
 * of Staff created, a package brought in, or a backup restored starts with
 * that grant off, and until it is on the bot is never told the tools exist
 * and reaches for a browser instead — with nothing on screen saying why.
 * Bots whose engine cannot mount the tools at all are left out, because
 * their switch is disabled: naming them would move the dead end, not end it.
 * Hidden bots are left out for the same reason — the person cannot act on
 * one from here. */
export function botsMissingConnectedApps(bots: Bot[], instances: InstanceInfo[]): Bot[] {
  return bots.filter((bot) =>
    !bot.hidden &&
    bot.composio === false &&
    instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)
      ?.capabilities?.composioMcp === true);
}

/** Bots whose connector tool grants limit this service below every tool —
 * a partial list, no entry at all inside an explicit record, or a grant
 * shape this build cannot read. Legacy bots (no grants record) have every
 * tool and never appear. Engines that cannot mount the tools and hidden
 * bots are left out: their editors are dead ends from here. */
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

export function hasUsableConnectedApps(configured: boolean, phase: ConnectorInventoryPhase, stale: boolean, status: Record<string, ConnectorStatus>): boolean {
  return configured && phase === "ready" && !stale && Object.values(status).some((service) => service.connected);
}

/** What the host says about why connected apps are off (see
 * `connectorSetup` in server/composio.ts). Absent from older hosts. */
export type ConnectorSetup = "ready" | "needs-setup" | "service-unavailable";

/** The one notice above the marketplace when connected apps are off. A fresh
 * install that never had a connection service gets a calm "here is what to
 * do"; only a real outage of the managed service, or an older host that does
 * not say which it is, gets the warning. Two notices about the same fact is
 * one too many, so the stale banner wins when it is showing. */
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

export function requiresAccountAlias(message: string) {
  return /account alias.*existing connection.*not replaced/i.test(message);
}

export type ConnectorInventoryPhase = "loading" | "ready" | "error";

export function connectorActionLabel(
  phase: ConnectorInventoryPhase,
  state: { busy: boolean; included: boolean; canContinue: boolean; pending?: boolean; hasAccounts: boolean; failed: boolean },
) {
  if (state.busy) return null;
  if (state.included) return t("connectors.action.included");
  if (phase === "loading") return t("connectors.action.checking");
  if (phase === "error") return t("connectors.action.unavailable");
  if (state.canContinue) return t("connectors.action.continue");
  if (state.pending) return t("connectors.action.checkStatus");
  if (state.hasAccounts) return t("connectors.action.addAccount");
  if (state.failed) return t("connectors.action.retry");
  return t("connectors.action.connect");
}

export function connectedInventoryCopy(phase: ConnectorInventoryPhase) {
  if (phase === "loading") return {
    title: t("connectors.empty.loadingTitle"),
    description: t("connectors.empty.loadingDesc"),
  };
  if (phase === "error") return {
    title: t("connectors.empty.errorTitle"),
    description: t("connectors.empty.errorDesc"),
  };
  return {
    title: t("connectors.empty.noneTitle"),
    description: t("connectors.empty.noneDesc"),
  };
}

export function mergeCurrentConnectorStatus(
  current: Record<string, ConnectorStatus>,
  incoming: Record<string, ConnectorStatus>,
  latestGenerations: ReadonlyMap<string, number>,
  requestGenerations: ReadonlyMap<string, number>,
) {
  const next = { ...current };
  for (const [slug, state] of Object.entries(incoming)) {
    if ((latestGenerations.get(slug) ?? 0) !== (requestGenerations.get(slug) ?? 0)) continue;
    next[slug] = state;
  }
  return next;
}

export function mergeCompleteConnectorStatus(
  current: Record<string, ConnectorStatus>,
  incoming: Record<string, ConnectorStatus>,
  latestGenerations: ReadonlyMap<string, number>,
  requestGenerations: ReadonlyMap<string, number>,
  /** Did the server actually KNOW the full picture? A response sent while the
   * credential store was unreadable carries no information about what is
   * connected, so it must not be allowed to clear anything — an empty list
   * from an ignorant server is exactly how a connected app became a Connect
   * button. Disconnection still shows up on the next authoritative answer. */
  authoritative = true,
) {
  const next = { ...current };
  if (!authoritative) return mergeCurrentConnectorStatus(next, incoming, latestGenerations, requestGenerations);
  for (const [slug, state] of Object.entries(current)) {
    if (incoming[slug]) continue;
    if (!state.connected && !state.accounts?.length) continue;
    if ((latestGenerations.get(slug) ?? 0) !== (requestGenerations.get(slug) ?? 0)) continue;
    next[slug] = { connected: false, pending: false, status: "not_connected", accounts: [] };
  }
  return mergeCurrentConnectorStatus(next, incoming, latestGenerations, requestGenerations);
}

export function onlyLatestConnectorResponses(
  incoming: Record<string, ConnectorStatus>,
  latestRequests: ReadonlyMap<string, number>,
  requestIds: ReadonlyMap<string, number>,
) {
  return Object.fromEntries(
    Object.entries(incoming).filter(
      ([slug]) => (latestRequests.get(slug) ?? 0) === (requestIds.get(slug) ?? 0),
    ),
  );
}

/** A toolkit's mark: official logo, else favicon by domain, else monogram.
 * Shared with the onboarding connectors scene so both show the same logos. */
export function ServiceIcon({ card, className = "size-11" }: { card: Pick<ToolkitCard, "logo" | "domain" | "label">; className?: string }) {
  // 0 = official logo, 1 = favicon by domain, 2 = monogram
  const [stage, setStage] = useState(card.logo ? 0 : card.domain ? 1 : 2);
  // The full catalog is well over a thousand cards, so let the browser skip
  // the logos that are scrolled out of view instead of fetching every one.
  if (stage === 0 && card.logo) {
    return (
      <img
        src={card.logo}
        alt=""
        loading="lazy"
        className={cn("rounded-xl object-contain", className)}
        onError={() => setStage(1)}
      />
    );
  }
  if (stage === 1 && card.domain) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${card.domain}&sz=64`}
        alt=""
        loading="lazy"
        className={cn("rounded-xl object-contain", className)}
        onError={() => setStage(2)}
      />
    );
  }
  return (
    <div className={cn("flex items-center justify-center rounded-xl bg-raised text-[15px] font-semibold text-ink-secondary", className)}>
      {card.label.slice(0, 1).toUpperCase()}
    </div>
  );
}

/** Catalog completeness, as reported by /api/connectors/catalog. Absent
 * totalItems means upstream never stated a total, so there is nothing to
 * compare the served cards against. */
export interface CatalogPagination {
  items: number;
  totalItems?: number;
  stalled: boolean;
  /** Server-side stop reason, present only when the walk stalled (#1838). */
  reason?: string;
}

/** The Apps pop-up's chips: every app, only the connected ones, or only
 * your own MCP servers. "mcp" is the store's `pluginsSurface`, so a bot's
 * Tools page can still send someone straight to their servers. */
export type AppsFilter = "all" | "connected" | "mcp";

/** Without a search, the "All" grid shows this many tiles before a
 * "Show all" button. */
export const APPS_PREVIEW_COUNT = 48;

/** A "used by" bot avatar, drawn inside its 20px ring (size-5). The farthest
 * any mascot body reaches from the centre is 0.55 of its box (the shield; a
 * cursor's tip is 0.54), so at 16px every shape stays a pixel clear of the
 * circle's edge. */
export const USED_BY_AVATAR_SIZE = 16;

/** Bots that can use this service's tools today: visible, connected apps
 * on, an engine that mounts them, and a grant that includes the service
 * (no record at all is the legacy every-tool default). */
export function botsUsingService(bots: Bot[], instances: InstanceInfo[], slug: string): Bot[] {
  return bots.filter((bot) =>
    !bot.hidden &&
    bot.composio !== false &&
    instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)
      ?.capabilities?.composioMcp === true &&
    connectorServiceAccess(bot.connectorTools, slug).level !== "none");
}

export function PluginsPanel() {
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const dialogRef = useRef<HTMLDivElement>(null);
  const surface = state.pluginsSurface;
  const [cards, setCards] = useState<ToolkitCard[] | null>(null);
  const [source, setSource] = useState<"api" | "curated">("curated");
  const [pagination, setPagination] = useState<CatalogPagination | null>(null);
  const [configured, setConfigured] = useState(false);
  const [mode, setMode] = useState<"managed" | "self-hosted" | "unavailable">("unavailable");
  const [setup, setSetup] = useState<ConnectorSetup | undefined>(undefined);
  // Paint what we last knew before any request goes out: the module cache if
  // this window already fetched, otherwise the inventory saved on disk. An
  // empty panel is never the first thing a connected user sees.
  const [status, setStatus] = useState<Record<string, ConnectorStatus>>(
    () => cachedConnectorStatus ?? readCachedInventory()?.services ?? {},
  );
  /** true when what is on screen is remembered rather than confirmed */
  const [stale, setStale] = useState(
    cachedConnectorStatus !== null && !cachedConnectorStatusAuthoritative,
  );
  const [pendingUrls, setPendingUrls] = useState<Record<string, PendingAuthorization>>({});
  const [aliasSlug, setAliasSlug] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [inventoryPhase, setInventoryPhase] = useState<ConnectorInventoryPhase>(
    cachedConnectorStatus === null ? "loading" : "ready",
  );
  const [error, setError] = useState<string | { key: LocaleKey } | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"marketplace" | "connected">("marketplace");
  const [showAllApps, setShowAllApps] = useState(false);
  const [whopConnected, setWhopConnected] = useState<boolean | null>(null);
  const [whopRefresh, setWhopRefresh] = useState(0);
  // a marketplace category the list is narrowed to (null: every app)
  const [category, setCategory] = useState<string | null>(null);

  const pollTimers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const statusGenerations = useRef(new Map<string, number>());
  const latestStatusRequests = useRef(new Map<string, number>());
  const opening = useRef<ReturnType<typeof reserveConnectionPage> | null>(null);

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
        // A one-service OAuth poll must not erase every other app's state.
        // A request that began before Connect must also not erase the newer
        // local INITIATED state when its stale not_connected result arrives.
        setStatus((current) => mergeCurrentConnectorStatus(
          current,
          services,
          statusGenerations.current,
          requestGenerations,
        ));
        for (const [slug, state] of Object.entries(services)) {
          const isCurrent = (statusGenerations.current.get(slug) ?? 0) === (requestGenerations.get(slug) ?? 0);
          if (isCurrent && ((state.connected && !state.pending) || /^(expired|failed)$/i.test(state.status ?? ""))) setPendingUrls((current) => {
            if (!current[slug]) return current;
            const next = { ...current };
            delete next[slug];
            return next;
          });
        }
        return services;
      })
      .catch(() => ({}));
  }, []);

  const refreshConnectedStatus = useCallback((force = false): Promise<Record<string, ConnectorStatus>> => {
    const requestGenerations = new Map(statusGenerations.current);
    setRefreshing(true);
    return preloadConnectedApps(force)
      .then(({ services, authoritative }) => {
        setStale(!authoritative);
        setStatus((current) => mergeCompleteConnectorStatus(
          current,
          services,
          statusGenerations.current,
          requestGenerations,
          authoritative,
        ));
        for (const [slug, state] of Object.entries(services)) {
          const isCurrent = (statusGenerations.current.get(slug) ?? 0) === (requestGenerations.get(slug) ?? 0);
          if (isCurrent && ((state.connected && !state.pending) || /^(expired|failed)$/i.test(state.status ?? ""))) setPendingUrls((current) => {
            if (!current[slug]) return current;
            const next = { ...current };
            delete next[slug];
            return next;
          });
        }
        return services;
      })
      .finally(() => setRefreshing(false));
  }, []);

  const loadConnectionInventory = useCallback((force = false) => {
    const hadCachedInventory = cachedConnectorStatus !== null;
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
    for (const timer of pollTimers.current.values()) clearInterval(timer);
    pollTimers.current.clear();
  }, []);

  useEffect(() => {
    if (inventoryPhase !== "ready") return;
    cachedConnectorStatus = status;
    cachedConnectorStatusAt = Date.now();
    cachedConnectorStatusAuthoritative = !stale;
  }, [inventoryPhase, stale, status]);

  useEffect(() => {
    let alive = true;
    void loadConnectionInventory();
    api("/api/connectors/catalog")
      .then((r) => {
        if (!alive) return;
        setCards(r.cards ?? []);
        setSource(r.source ?? "curated");
        setPagination(r.pagination ?? null);
        setConfigured(Boolean(r.configured));
        setMode(r.mode ?? "unavailable");
        setSetup(r.setup);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message);
      });
    return () => {
      alive = false;
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

  const startPolling = (slug: string) => {
    const old = pollTimers.current.get(slug);
    if (old) clearInterval(old);
    let tries = 0;
    const timer = setInterval(() => {
      void refreshStatus([slug]).then((services) => {
        const state = services[slug];
        if (++tries >= 24 || (state?.connected && !state.pending) || (state?.status && /^(expired|failed)$/i.test(state.status))) {
          clearInterval(timer);
          pollTimers.current.delete(slug);
        }
      });
    }, 5000);
    pollTimers.current.set(slug, timer);
  };

  const connect = async (slug: string, alias?: string) => {
    if (busySlug || opening.current) return;
    const launch = reserveConnectionPage();
    opening.current = launch;
    statusGenerations.current.set(slug, (statusGenerations.current.get(slug) ?? 0) + 1);
    setBusySlug(slug);
    setError(null);
    try {
      const createdAt = Date.now();
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
      startPolling(slug);
      if (!await launch.open(url) && opening.current === launch) {
        setError({ key: "connectors.popupBlockedContinue" });
      }
    } catch (e) {
      if (opening.current !== launch) return;
      const message = e instanceof Error ? e.message : String(e);
      if (requiresAccountAlias(message)) {
        // Recover gracefully if an existing account was discovered after the
        // button rendered. Show the label field and refresh only this app.
        setAliasSlug(slug);
        setAliasDraft("");
        setError({ key: "connectors.aliasNeeded" });
        void refreshStatus([slug]);
      } else {
        setError(message);
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

  const matching = (cards ?? []).filter(
    (c) => !search || `${c.label} ${c.slug} ${c.blurb}`.toLowerCase().includes(search.toLowerCase()),
  );
  const isConnected = (slug: string) => Boolean(status[slug]?.connected || status[slug]?.accounts?.length);
  const filter: AppsFilter = surface === "mcp" ? "mcp" : tab === "connected" ? "connected" : "all";
  const whopMatches = !search || `whop ${t("whop.description")}`.toLowerCase().includes(search.toLowerCase().trim());
  const showWhop = whopMatches && (filter === "all" || (filter === "connected" && whopConnected !== false));
  // Connected apps lead the grid, so the ones you use are never a scroll away.
  const visible = (filter === "connected" ? matching.filter((card) => isConnected(card.slug)) : matching)
    .map((card, index) => ({ card, index }))
    .sort((a, b) => Number(isConnected(b.card.slug)) - Number(isConnected(a.card.slug)) || a.index - b.index)
    .map(({ card }) => card);
  const connectedCount = Object.values(status).filter((service) => service.connected || service.accounts?.length).length + Number(whopConnected === true);
  const connectedEmptyCopy = connectedInventoryCopy(inventoryPhase);
  const close = () => dispatch({ type: "togglePlugins", open: false });
  // Only worth saying once an app is actually connected and reachable.
  const setupNotice = connectorSetupNotice({ configured, stale, setup, remoteClient });
  const botsWithoutApps = hasUsableConnectedApps(configured, inventoryPhase, stale, status)
    ? botsMissingConnectedApps(state.bots, state.instances)
    : [];
  const chooseFilter = (next: AppsFilter) => {
    // a filter replaces the category view, so a stale category cannot hide the MCP section
    setCategory(null);
    if (next === "mcp") {
      dispatch({ type: "togglePlugins", open: true, surface: "mcp" });
      return;
    }
    setTab(next === "connected" ? "connected" : "marketplace");
    if (surface !== "apps") dispatch({ type: "togglePlugins", open: true, surface: "apps" });
  };

  // Category pills, most used first. The selected one stays in view even
  // when it ranks under More.
  const ranked = rankCategories(cards ?? []);
  const moreCategories = ranked.more;
  const categoryInMore = category !== null && moreCategories.includes(category);
  const inCategoryView = filter === "all" && category !== null;
  const categoryCards = inCategoryView ? visible.filter((card) => inCategory(card, category)) : visible;
  // the unfiltered, unsearched view stacks sections; any narrowing shows one list
  const sectioned = filter === "all" && !search && category === null;
  const sections = sectioned ? catalogSections(visible, isConnected, ranked.inline) : [];
  const allSection = sections.find((section) => section.kind === "all");
  const allCards = sectioned ? allSection?.cards ?? [] : categoryCards;
  const allCapped = sectioned && !showAllApps && allCards.length > APPS_PREVIEW_COUNT;
  const allShown = allCapped ? allCards.slice(0, APPS_PREVIEW_COUNT) : allCards;
  const connectedCards = (cards ?? []).filter((card) => isConnected(card.slug));
  const pickCategory = (next: string | null) => {
    setCategory(next);
    setTab("marketplace");
    if (surface !== "apps") dispatch({ type: "togglePlugins", open: true, surface: "apps" });
  };
  const listTitle = filter === "connected"
    ? t("connectors.section.yours")
    : search
      ? t("connectors.section.results")
      : category ?? (sections.length > 1 ? t("apps.section.all") : t("connectors.section.available"));
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
      {/* A sibling, not the parent: a backdrop-filter on an ancestor would
          stop the pop-up's own glass from seeing the app behind it. */}
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
      <div
        ref={dialogRef}
        data-tour="apps-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugins-title"
        tabIndex={-1}
        className="glass-surface glass-popup animate-pop-in relative flex max-w-[780px] flex-col overflow-hidden rounded-[24px]"
      >
        <header className="flex flex-col gap-4 px-5 pb-4 pt-5 sm:px-7 sm:pt-6">
          <div>
          <div className="flex items-center justify-between gap-3">
            <h2 id="plugins-title" className="min-w-0 truncate text-[20px] font-semibold leading-7 tracking-[-0.01em] text-ink">{t("apps.title")}</h2>
            <div className="flex shrink-0 items-center gap-1">
              {/* How many apps are connected, and the way to just those. */}
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
                onClick={() => { setWhopRefresh((value) => value + 1); void loadConnectionInventory(true); }}
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
          {/* under the row, so a narrow pop-up never squeezes it into a column */}
          <p className="mt-0.5 text-[13px] leading-5 text-ink-secondary">{t("apps.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-control/70 px-3.5 focus-within:ring-1 focus-within:ring-accent">
              <Search size={15} className="shrink-0 text-ink-secondary" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("connectors.searchPlaceholder")}
                aria-label={t("connectors.searchPlaceholder")}
                className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
              />
            </label>
            {/* your own MCP servers: the secondary destination beside the search */}
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
                {name}
              </button>
            ))}
            {moreCategories.length > 0 && (
              <SidebarPopoverMenu
                placement="below"
                ariaLabel={t("apps.moreCategories")}
                items={moreCategories.map((name) => ({ key: name, label: name, active: category === name, onSelect: () => pickCategory(name) }))}
                renderTrigger={({ open }) => (
                  <span className={cn(pill, pillTone(filter === "all" && categoryInMore), open && !categoryInMore && "bg-raised-hover text-ink")}>
                    {categoryInMore ? category : t("apps.more")}
                    <ChevronDown size={14} aria-hidden="true" />
                  </span>
                )}
              />
            )}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-7 sm:px-7">
          {stale && (
            // Say which of the two things is true. Silence here is what makes a
            // remembered list indistinguishable from a confirmed one.
            <div className="mb-3 flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
              <TriangleAlert size={14} className="mt-px shrink-0" />
              <span>
                {t("connectors.stale")}
              </span>
            </div>
          )}
          {/* Not set up yet is not an outage: see connectorSetupNotice. */}
          {setupNotice && filter !== "mcp" && (
            <div
              className={cn(
                "mb-3 rounded-xl px-4 py-3 text-[13px]",
                setupNotice.tone === "warning" ? "bg-warning/10 text-warning" : "bg-control/50 text-ink-secondary",
              )}
            >
              {t(whopConnected ? "whop.otherAppsSetup" : setupNotice.key)}{" "}
              <button
                className={cn(
                  "font-medium underline underline-offset-2",
                  setupNotice.tone === "info" && "text-ink",
                  remoteClient && "hidden",
                )}
                onClick={() => {
                  close();
                  dispatch({ type: "toggleAppSettings", open: true, section: "connections" });
                }}
              >
                {t("connectors.openSettings")}
              </button>
            </div>
          )}
          {botsWithoutApps.length > 0 && (
            <div className="mb-3 rounded-xl bg-control/50 px-4 py-3 text-[12.5px] leading-relaxed text-ink-secondary">
              <span className="font-medium text-ink">{t("connectors.perBot.title")}</span>{" "}
              {t("connectors.perBot.body")}
              <div className="mt-2 flex flex-wrap gap-2">
                {botsWithoutApps.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => dispatch({ type: "updateBot", botId: candidate.id, patch: { composio: true } })}
                    className={cn(pill, "bg-control text-ink hover:bg-raised-hover")}
                  >
                    {t("connectors.perBot.allow", { name: candidate.name })}
                  </button>
                ))}
              </div>
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
              {/* @container: the columns follow the pop-up's width, not the window's (2, then 1) */}
              {sections.filter((section) => section.kind !== "all").map((section) => section.kind === "connected" ? (
                <AppsSection
                  key="connected"
                  id="apps-section-connected"
                  title={t("apps.section.connected")}
                  viewAll={section.cards.length > CATEGORY_SECTION_SIZE ? { label: t("apps.viewAll"), onClick: () => chooseFilter("connected") } : undefined}
                >
                  {section.cards.slice(0, CATEGORY_SECTION_SIZE).map((card) => renderTile(card))}
                </AppsSection>
              ) : (
                <AppsSection
                  key={section.category}
                  id={`apps-section-${section.category}`}
                  title={section.category}
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
                      shown: pagination.items.toLocaleString(),
                      total: pagination.totalItems.toLocaleString(),
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
                          {t("apps.showAll", { count: allCards.length.toLocaleString() })}
                        </button>
                      </div>
                    )}
                    {cards !== null && allShown.length === 0 && !(showWhop && !inCategoryView) && sections.length <= 1 && (
                      <div className="flex min-h-40 flex-col items-center justify-center text-center">
                        <div className="text-[14px] font-medium text-ink">
                          {filter === "connected" ? connectedEmptyCopy.title : t("connectors.noAppsFound")}
                        </div>
                        <div className="mt-1 text-[12.5px] text-ink-secondary">
                          {filter === "connected" ? connectedEmptyCopy.description : t("connectors.tryDifferentSearch")}
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
                {/* Whop is its own sign-in, not a Composio app: it stays mounted in
                    the main list whichever chip is chosen, hidden where it does not belong. */}
                <div className={showWhop && !inCategoryView ? "contents" : "hidden"}>
                  <McpServersPanel whopCard refreshKey={whopRefresh} onWhopConnection={setWhopConnected} />
                </div>
                {allShown.map((card) => renderTile(card))}
              </AppsSection>
            </div>
          )}

          {filter !== "connected" && category === null && (
            <div className={cn(filter === "all" && "mt-8 border-t border-hairline/30 pt-6", filter === "mcp" && "pt-1")}>
              <McpServersPanel embedded hideWhop={filter === "all"} />
            </div>
          )}
        </div>
      </div>
    </div>
  );

  function renderTile(card: ToolkitCard) {
    const serviceStatus = status[card.slug];
    const failed = serviceStatus?.status && /^(expired|failed)$/i.test(serviceStatus.status);
    const pending = serviceStatus?.pending && !failed;
    const pendingAuthorization = pending && !failed ? pendingUrls[card.slug] : undefined;
    const authorizationUrl = reusableConnectionUrl(pendingAuthorization);
    const accounts = serviceStatus?.accounts ?? [];
    // connected with no accounts and nothing in flight = a no-auth
    // toolkit: there is no OAuth to run, so "Connect" would mint a
    // pointless authorize. It ships included.
    const included = card.noAuth === true
      || (serviceStatus?.connected === true && !accounts.length && !pending && !failed);
    const connected = Boolean(serviceStatus?.connected || accounts.length);
    const addingAccount = aliasSlug === card.slug && !included;
    const busy = busySlug === card.slug;
    const unavailableReason = managedConnectorUnavailableReason(mode, card.slug)
      ? t("connectors.selfHostOnlyReason")
      : null;
    const usedBy = connected || included ? botsUsingService(state.bots, state.instances, card.slug) : [];
    const description = unavailableReason ?? (
      pending
        ? authorizationUrl
          ? t("connectors.finishSetup")
          : t("connectors.finishSetupOrDisconnect")
        : failed && !accounts.length
          ? t("connectors.authExpired")
          : card.blurb
    );
    return (
      <div
        key={card.slug}
        data-app-tile={card.slug}
        className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40"
      >
        <div className="flex items-center gap-3">
          <ServiceIcon card={card} className="size-10 shrink-0 rounded-[10px]" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[14px] font-semibold leading-5 text-ink">{card.label}</span>
              {connected && !pending && (
                <Check size={13} strokeWidth={2.5} className="shrink-0 text-success" aria-label={t("apps.connected")} />
              )}
              {usedBy.length > 0 && (
                <span
                  className="ms-1 flex shrink-0 -space-x-1.5 rtl:space-x-reverse"
                  title={t("apps.usedBy", { names: usedBy.map((candidate) => candidate.name).join(", ") })}
                  aria-label={t("apps.usedBy", { names: usedBy.map((candidate) => candidate.name).join(", ") })}
                  role="img"
                >
                  {/* A mascot fills its whole square (a cursor's tip sits in the
                      corner), so drawn at the ring's own size it poked out of
                      the circle. Each one sits in a fixed disc that clips, drawn
                      small enough that every body and uploaded image fits. */}
                  {usedBy.slice(0, 3).map((candidate) => (
                    <span
                      key={candidate.id}
                      data-used-by-avatar={candidate.id}
                      className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-menu ring-2 ring-menu"
                    >
                      <BotAvatar bot={candidate} size={USED_BY_AVATAR_SIZE} animated={false} />
                    </span>
                  ))}
                </span>
              )}
            </div>
            <div className="truncate text-[12.5px] leading-[18px] text-ink-secondary" title={description}>
              {description}
            </div>
          </div>
          <button
            type="button"
            disabled={!configured || inventoryPhase !== "ready" || busy || included || Boolean(unavailableReason)}
            title={unavailableReason ?? undefined}
            onClick={() => {
              if (pending && !failed) {
                const url = reusableConnectionUrl(pendingAuthorization);
                if (url) {
                  setError(null);
                  void openConnectUrl(url).catch((e) => setError(e.message));
                } else {
                  // A reload or expired link cannot be resumed. The host
                  // safely retries unfinished-only accounts; live accounts
                  // still require an explicit new alias below.
                  void connect(card.slug);
                }
              } else {
                setAliasSlug((current) => current === card.slug ? null : card.slug);
                setAliasDraft("");
              }
            }}
            className="inline-flex h-7 min-w-[64px] shrink-0 items-center justify-center gap-2 rounded-full bg-control/80 px-3 text-[13px] font-medium leading-5 text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
          >
            {unavailableReason ? (
              t("connectors.selfHostOnly")
            ) : busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              connectorActionLabel(inventoryPhase, {
                busy,
                included,
                canContinue: Boolean(pendingAuthorization),
                pending,
                hasAccounts: accounts.length > 0,
                failed: Boolean(failed),
              })
            )}
          </button>
        </div>
        {/* everything below lines up with the name, past the icon */}
        <div className="ps-[52px]">
          {authorizationUrl && (
            <a href={authorizationUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => {
              if (!reusableConnectionUrl(pendingAuthorization)) {
                event.preventDefault();
                void connect(card.slug);
              }
            }} className="mt-1.5 inline-block text-[12px] text-accent-text underline underline-offset-2">
              {t("connectors.openAuthorizationPage")}
            </a>
          )}
          {accounts.length > 0 && (
            <div className="mt-1.5 space-y-0.5">
              {accounts.map((account) => {
                const active = /^active$/i.test(account.status);
                return (
                  <div key={account.id} className="flex min-w-0 items-center gap-2 text-[12px] leading-5">
                    {active ? <Check size={12} className="shrink-0 text-success" /> : <span className="size-3 shrink-0" />}
                    <span className="min-w-0 truncate text-ink" title={`${account.alias ? `${account.id} · ` : ""}${account.status.toLowerCase()}`}>
                      {account.alias || account.id}
                      <span className="text-ink-secondary"> · {account.status.toLowerCase()}</span>
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(disconnectAccountConfirmation(card.label, account))) return;
                        disconnectAccount(card.slug, account.id);
                      }}
                      className="ms-auto shrink-0 rounded-full px-2 text-[12px] font-medium leading-5 text-ink-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                      aria-label={t("connectors.disconnectAria", {
                        account: account.alias || account.id,
                        service: card.label,
                      })}
                    >
                      {t("connectors.disconnect")}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {(serviceStatus?.connected || included) && (() => {
            const limited = botsWithLimitedServiceTools(state.bots, state.instances, card.slug);
            if (!limited.length) return null;
            const names = limited.slice(0, 4).map((candidate, index) => (
              <span key={candidate.id}>
                {index > 0 && ", "}
                <button
                  type="button"
                  onClick={() => {
                    close();
                    dispatch({ type: "toggleSettings", open: true, botId: candidate.id, section: "access" });
                  }}
                  className="font-medium text-ink underline underline-offset-2 hover:text-accent-text"
                >
                  {candidate.name}
                </button>
              </span>
            ));
            return (
              <div className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
                <span>{t("connectors.grants.limited", { count: limited.length })}</span>{" "}
                {names}
                {limited.length > 4 && <span>{t("connectors.grants.more", { count: limited.length - 4 })}</span>}
              </div>
            );
          })()}
          {addingAccount && (
            <form
              className="mt-2 flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const alias = aliasDraft.trim();
                if (!alias) {
                  setError({ key: "connectors.aliasRequired" });
                  return;
                }
                void connect(card.slug, alias);
              }}
            >
              <input
                autoFocus
                value={aliasDraft}
                maxLength={64}
                onChange={(event) => setAliasDraft(event.target.value)}
                placeholder={t("connectors.aliasPlaceholder")}
                aria-label={accounts.length > 0
                  ? t("connectors.aliasAriaAnother", { service: card.label })
                  : t("connectors.aliasAriaNew", { service: card.label })}
                className="h-8 min-w-0 flex-1 rounded-full bg-inset px-3 text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <button
                type="submit"
                disabled={busy || !aliasDraft.trim()}
                className="inline-flex h-7 shrink-0 items-center rounded-full bg-accent px-3 text-[13px] font-medium leading-5 text-accent-ink disabled:opacity-40"
              >
                {t("connectors.action.continue")}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }
}

/** One block of the Apps list: a heading with an optional "View all" at the
 * far end, then its apps in a two-column list (one column when the pop-up is
 * narrow). */
function AppsSection({ id, title, note, viewAll, after, children }: {
  id: string;
  title: string;
  note?: string;
  viewAll?: { label: string; onClick: () => void };
  after?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} data-apps-section={id}>
      <div className="mb-1.5 flex min-h-7 items-center justify-between gap-3 px-2">
        <h3 id={id} className="min-w-0 truncate text-[14px] font-semibold leading-5 text-ink">
          {title}
          {note && <span className="ms-2 text-[12px] font-normal text-ink-secondary">{note}</span>}
        </h3>
        {viewAll && (
          <button
            type="button"
            onClick={viewAll.onClick}
            className="shrink-0 rounded-full px-2 text-[13px] font-medium leading-5 text-ink-secondary transition-colors hover:text-ink"
          >
            {viewAll.label}
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 items-start gap-x-6 gap-y-1 @xl:grid-cols-2">{children}</div>
      {after}
    </section>
  );
}
