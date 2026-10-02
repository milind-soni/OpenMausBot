// Connected apps marketplace, backed by Composio Sessions. Catalog comes
// from /api/connectors/catalog — the full toolkit list with logos when a
// Composio API key is configured, a curated set otherwise. Icons resolve
// logo → favicon → monogram.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, RefreshCw, Search, TriangleAlert, X } from "lucide-react";
import { api, useStore, type Bot, type InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { readCachedInventory, writeCachedInventory } from "@/lib/connected-apps-cache";
import { managedConnectorUnavailableReason } from "../../shared/connector-availability";
import { connectorServiceAccess, isConnectorToolGrantShape } from "@/lib/connector-grants";
import { BotAvatar } from "./Avatar";
import { McpServersPanel } from "./McpServersPanel";

export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  noAuth?: boolean;
  domain: string | null;
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
  const [pendingUrls, setPendingUrls] = useState<Record<string, string>>({});
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

  const pollTimers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const statusGenerations = useRef(new Map<string, number>());
  const latestStatusRequests = useRef(new Map<string, number>());

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
          if (isCurrent && state.connected && !state.pending) setPendingUrls((current) => {
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
          if (isCurrent && state.connected && !state.pending) setPendingUrls((current) => {
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
    if (window.ogb?.openExternal) {
      await window.ogb.openExternal(url);
      return;
    }
    // Browser development fallback. If a popup blocker rejects the first
    // asynchronous open, the visible Continue button retries from a direct
    // user gesture using the URL retained in pendingUrls.
    const opened = window.open("", "_blank");
    if (!opened) {
      setError({ key: "connectors.popupBlockedContinue" });
      return;
    }
    // Open a same-origin blank page first so the OAuth origin never receives
    // an opener reference, while a real null remains a reliable blocked signal.
    opened.opener = null;
    opened.location.replace(url);
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
    statusGenerations.current.set(slug, (statusGenerations.current.get(slug) ?? 0) + 1);
    setBusySlug(slug);
    setError(null);
    try {
      const request: RequestInit = { method: "POST" };
      if (alias) request.body = JSON.stringify({ alias });
      const { url } = await api(`/api/connectors/${slug}/authorize`, request);
      setPendingUrls((current) => ({ ...current, [slug]: url }));
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
      await openConnectUrl(url);
    } catch (e) {
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
      setBusySlug(null);
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
  // Connected apps lead the grid, so the ones you use are never a scroll away.
  const visible = (filter === "connected" ? matching.filter((card) => isConnected(card.slug)) : matching)
    .map((card, index) => ({ card, index }))
    .sort((a, b) => Number(isConnected(b.card.slug)) - Number(isConnected(a.card.slug)) || a.index - b.index)
    .map(({ card }) => card);
  // The full catalog runs past a thousand apps. Without a search, show the
  // first screenful so the MCP section below stays a short scroll away.
  const capped = filter === "all" && !search && !showAllApps && visible.length > APPS_PREVIEW_COUNT;
  const shown = capped ? visible.slice(0, APPS_PREVIEW_COUNT) : visible;
  const connectedCount = Object.values(status).filter((service) => service.connected || service.accounts?.length).length;
  const connectedEmptyCopy = connectedInventoryCopy(inventoryPhase);
  const close = () => dispatch({ type: "togglePlugins", open: false });
  // Only worth saying once an app is actually connected and reachable.
  const setupNotice = connectorSetupNotice({ configured, stale, setup, remoteClient });
  const botsWithoutApps = hasUsableConnectedApps(configured, inventoryPhase, stale, status)
    ? botsMissingConnectedApps(state.bots, state.instances)
    : [];
  const chooseFilter = (next: AppsFilter) => {
    if (next === "mcp") {
      dispatch({ type: "togglePlugins", open: true, surface: "mcp" });
      return;
    }
    setTab(next === "connected" ? "connected" : "marketplace");
    if (surface !== "apps") dispatch({ type: "togglePlugins", open: true, surface: "apps" });
  };
  const filters: Array<{ id: AppsFilter; label: string }> = [
    { id: "all", label: t("apps.filter.all") },
    { id: "connected", label: `${t("apps.filter.connected")}${connectedCount > 0 ? ` ${connectedCount}` : ""}` },
    { id: "mcp", label: t("apps.filter.mcp") },
  ];

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
        className="glass-surface glass-popup animate-pop-in relative flex flex-col overflow-hidden rounded-[24px]"
      >
        <header className="flex flex-col gap-4 px-6 pb-3 pt-6 sm:px-8 sm:pt-7">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id="plugins-title" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">{t("apps.title")}</h2>
              <p className="mt-1 text-[13px] text-ink-secondary">{t("apps.subtitle")}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <label className="hidden h-10 w-[260px] items-center gap-2.5 rounded-xl bg-control/70 px-3.5 md:flex">
                <Search size={16} className="shrink-0 text-ink-secondary" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("connectors.searchPlaceholder")}
                  aria-label={t("connectors.searchPlaceholder")}
                  className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
                />
              </label>
              <button
                onClick={() => void loadConnectionInventory(true)}
                disabled={refreshing}
                className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                title={t("connectors.refreshTitle")}
                aria-label={t("connectors.refreshTitle")}
              >
                <RefreshCw size={17} className={cn(refreshing && "animate-spin")} />
              </button>
              <button data-tour="apps-close"
                onClick={close}
                aria-label={t("connectors.closeAria")}
                className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <X size={21} />
              </button>
            </div>
          </div>
          {/* A narrow window has no room in the header row for the search. */}
          <label className="flex h-10 w-full items-center gap-2.5 rounded-xl bg-control/70 px-3.5 md:hidden">
            <Search size={16} className="shrink-0 text-ink-secondary" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("connectors.searchPlaceholder")}
              aria-label={t("connectors.searchPlaceholder")}
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </label>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("apps.filter.aria")}>
            {filters.map((item) => (
              <button
                key={item.id}
                type="button"
                data-apps-filter={item.id}
                aria-pressed={filter === item.id}
                onClick={() => chooseFilter(item.id)}
                className={cn(
                  "rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-colors",
                  filter === item.id ? "bg-accent text-accent-ink" : "bg-control/70 text-ink-secondary hover:bg-raised-hover hover:text-ink",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-2 sm:px-8">
          {stale && (
            // Say which of the two things is true. Silence here is what makes a
            // remembered list indistinguishable from a confirmed one.
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
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
                "mb-2 rounded-xl px-4 py-3 text-[13px]",
                setupNotice.tone === "warning" ? "bg-warning/10 text-warning" : "glass-card text-ink-secondary",
              )}
            >
              {t(setupNotice.key)}{" "}
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
            <div className="glass-card mb-2 rounded-xl px-4 py-3 text-[12.5px] leading-relaxed text-ink-secondary">
              <span className="font-medium text-ink">{t("connectors.perBot.title")}</span>{" "}
              {t("connectors.perBot.body")}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {botsWithoutApps.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => dispatch({ type: "updateBot", botId: candidate.id, patch: { composio: true } })}
                    className="rounded-full bg-control px-2.5 py-1 text-[11.5px] font-medium text-ink hover:bg-raised-hover"
                  >
                    {t("connectors.perBot.allow", { name: candidate.name })}
                  </button>
                ))}
              </div>
            </div>
          )}
          {configured && !remoteClient && source === "curated" && mode === "self-hosted" && filter !== "mcp" && (
            <div className="mb-2 text-[12px] text-ink-secondary">
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
          {error && <div role="alert" className="mb-2 mt-1 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{typeof error === "string" ? error : t(error.key)}</div>}

          {filter !== "mcp" && (
            <section data-apps-grid aria-labelledby="apps-grid-title" className="@container pt-3">
              {/* @container: the tile columns follow the pop-up's width, not the window's (3, then 2, then 1) */}
              <div id="apps-grid-title" className="mb-3 text-[12px] font-medium text-ink-secondary">
                {filter === "connected"
                  ? t("connectors.section.yours")
                  : search
                    ? t("connectors.section.results")
                    : t("connectors.section.available")}
                {filter === "all" && !search && pagination
                  && (pagination.stalled || (pagination.totalItems !== undefined && pagination.items < pagination.totalItems)) && (
                  <span className="ml-2 font-normal">
                    {pagination.totalItems !== undefined && pagination.items < pagination.totalItems
                      ? t("connectors.marketplace.partialCount", {
                        shown: pagination.items.toLocaleString(),
                        total: pagination.totalItems.toLocaleString(),
                      })
                      : t("connectors.marketplace.partialStalled")}
                    {pagination.reason
                      ? ` — ${t("connectors.marketplace.partialReason", { reason: pagination.reason })}`
                      : null}
                  </span>
                )}
              </div>
              {cards === null ? (
                <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary">
                  <Loader2 size={14} className="animate-spin" /> {t("connectors.loadingCatalog")}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @3xl:grid-cols-3">
                  {shown.map((card) => renderTile(card))}
                </div>
              )}
              {capped && (
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setShowAllApps(true)}
                    className="rounded-full bg-control/70 px-4 py-2 text-[12.5px] font-medium text-ink hover:bg-raised-hover"
                  >
                    {t("apps.showAll", { count: visible.length.toLocaleString() })}
                  </button>
                </div>
              )}
              {cards !== null && visible.length === 0 && (
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
                      className="mt-4 flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-50"
                    >
                      <RefreshCw size={13} className={cn(refreshing && "animate-spin")} />
                      {t("connectors.action.retry")}
                    </button>
                  )}
                </div>
              )}
            </section>
          )}

          {filter !== "connected" && (
            <div className={cn(filter === "all" && "mt-8 border-t border-hairline/30 pt-6", filter === "mcp" && "pt-3")}>
              <McpServersPanel embedded />
            </div>
          )}
        </div>
      </div>
    </div>
  );

  function renderTile(card: ToolkitCard) {
    const serviceStatus = status[card.slug];
    const pending = serviceStatus?.pending;
    const failed = serviceStatus?.status && /^(expired|failed)$/i.test(serviceStatus.status);
    const accounts = serviceStatus?.accounts ?? [];
    // connected with no accounts and nothing in flight = a no-auth
    // toolkit: there is no OAuth to run, so "Connect" would mint a
    // pointless authorize. It ships included.
    const included = card.noAuth === true
      || (serviceStatus?.connected === true && !accounts.length && !pending && !failed);
    const connected = Boolean(serviceStatus?.connected || accounts.length);
    const addingAccount = aliasSlug === card.slug && !pending;
    const busy = busySlug === card.slug;
    const unavailableReason = managedConnectorUnavailableReason(mode, card.slug)
      ? t("connectors.selfHostOnlyReason")
      : null;
    const usedBy = connected || included ? botsUsingService(state.bots, state.instances, card.slug) : [];
    return (
      <div
        key={card.slug}
        data-app-tile={card.slug}
        className="glass-card flex min-h-[132px] flex-col rounded-2xl p-4"
      >
        <div className="flex items-start gap-3">
          <ServiceIcon card={card} className="size-10" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium text-ink">{card.label}</div>
            <div
              className="mt-0.5 line-clamp-1 text-[12px] text-ink-secondary"
              title={unavailableReason ?? card.blurb}
            >
              {unavailableReason ?? (
                pending
                  ? pendingUrls[card.slug]
                    ? t("connectors.finishSetup")
                    : t("connectors.finishSetupOrDisconnect")
                  : failed && !accounts.length
                    ? t("connectors.authExpired")
                    : card.blurb
              )}
            </div>
          </div>
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 pt-3">
          {connected && !pending ? (
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-success">
              <Check size={13} className="shrink-0" /> {t("apps.connected")}
            </span>
          ) : <span />}
          <div className="flex min-w-0 items-center gap-2">
            {usedBy.length > 0 && (
              <span
                className="flex shrink-0 -space-x-1.5"
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
            <button
              type="button"
              disabled={!configured || inventoryPhase !== "ready" || busy || included || Boolean(unavailableReason)}
              title={unavailableReason ?? undefined}
              onClick={() => {
                if (pending) {
                  if (pendingUrls[card.slug]) {
                    setError(null);
                    void openConnectUrl(pendingUrls[card.slug]).catch((e) => setError(e.message));
                  } else {
                    setAliasSlug(null);
                    setError(null);
                    void refreshStatus([card.slug]);
                    startPolling(card.slug);
                  }
                } else {
                  setAliasSlug((current) => current === card.slug ? null : card.slug);
                  setAliasDraft("");
                }
              }}
              className="flex min-w-[80px] items-center justify-center gap-1.5 rounded-full bg-control px-3 py-1.5 text-[12px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
            >
              {unavailableReason ? (
                t("connectors.selfHostOnly")
              ) : busy ? (
                <Loader2 size={13} className="mx-auto animate-spin" />
              ) : (
                connectorActionLabel(inventoryPhase, {
                  busy,
                  included,
                  canContinue: Boolean(pending && pendingUrls[card.slug]),
                  pending,
                  hasAccounts: accounts.length > 0,
                  failed: Boolean(failed),
                })
              )}
            </button>
          </div>
        </div>
        {accounts.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {accounts.map((account) => {
              const active = /^active$/i.test(account.status);
              return (
                <div key={account.id} className="flex items-center gap-2 rounded-lg bg-inset/60 px-2.5 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                      {active && <Check size={12} className="shrink-0 text-success" />}
                      <span className="truncate">{account.alias || account.id}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[10.5px] text-ink-secondary">
                      {account.alias ? `${account.id} · ` : ""}{account.status.toLowerCase()}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(disconnectAccountConfirmation(card.label, account))) return;
                      disconnectAccount(card.slug, account.id);
                    }}
                    className="rounded-md px-2 py-1 text-[11px] text-ink-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
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
            <div className="mt-2 text-[11px] leading-relaxed text-ink-secondary">
              <span>{t("connectors.grants.limited", { count: limited.length })}</span>{" "}
              {names}
              {limited.length > 4 && <span>{t("connectors.grants.more", { count: limited.length - 4 })}</span>}
            </div>
          );
        })()}
        {addingAccount && (
          <form
            className="mt-3 flex items-center gap-2"
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
              className="min-w-0 flex-1 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              type="submit"
              disabled={busy || !aliasDraft.trim()}
              className="rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink disabled:opacity-40"
            >
              {t("connectors.action.continue")}
            </button>
          </form>
        )}
      </div>
    );
  }
}
