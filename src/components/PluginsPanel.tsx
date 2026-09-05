// Connected apps marketplace, backed by Composio Sessions. Catalog comes
// from /api/connectors/catalog — the full toolkit list with logos when a
// Composio API key is configured, a curated set otherwise. Icons resolve
// logo → favicon → monogram.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, RefreshCw, Search, TriangleAlert, X } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { readCachedInventory, writeCachedInventory } from "@/lib/connected-apps-cache";
import { managedConnectorUnavailableReason } from "../../shared/connector-availability";
import { McpServersPanel } from "./McpServersPanel";

interface ToolkitCard {
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
  return `Disconnect ${identity} from ${service}? Only this ${service} account will be revoked. Your other ${service} accounts will stay connected.`;
}

export function connectedAppsMayDisconnect(remoteClient: boolean): boolean {
  return !remoteClient;
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
  if (state.included) return "Included";
  if (phase === "loading") return "Checking…";
  if (phase === "error") return "Unavailable";
  if (state.canContinue) return "Continue";
  if (state.pending) return "Check status";
  if (state.hasAccounts) return "Add account";
  if (state.failed) return "Retry";
  return "Connect";
}

export function connectedInventoryCopy(phase: ConnectorInventoryPhase) {
  if (phase === "loading") return {
    title: "Checking connected apps…",
    description: "Your accounts will appear here as soon as the secure connection check finishes.",
  };
  if (phase === "error") return {
    title: "Couldn’t load connected apps",
    description: "Retry the connection check before adding another account.",
  };
  return {
    title: "No connected apps yet",
    description: "Connect an app from Marketplace and it will appear here.",
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

function ServiceIcon({ card }: { card: ToolkitCard }) {
  // 0 = official logo, 1 = favicon by domain, 2 = monogram
  const [stage, setStage] = useState(card.logo ? 0 : card.domain ? 1 : 2);
  if (stage === 0 && card.logo) {
    return <img src={card.logo} alt="" className="size-11 rounded-xl object-contain" onError={() => setStage(1)} />;
  }
  if (stage === 1 && card.domain) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${card.domain}&sz=64`}
        alt=""
        className="size-11 rounded-xl object-contain"
        onError={() => setStage(2)}
      />
    );
  }
  return (
    <div className="flex size-11 items-center justify-center rounded-xl bg-raised text-[15px] font-semibold text-ink-secondary">
      {card.label.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function PluginsPanel() {
  const { dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const mayDisconnect = connectedAppsMayDisconnect(remoteClient);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [surface, setSurface] = useState<"apps" | "mcp">("apps");
  const [cards, setCards] = useState<ToolkitCard[] | null>(null);
  const [source, setSource] = useState<"api" | "curated">("curated");
  const [configured, setConfigured] = useState(true);
  const [mode, setMode] = useState<"managed" | "self-hosted" | "unavailable">("unavailable");
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
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"marketplace" | "connected">("marketplace");

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
        setConfigured(Boolean(r.configured));
        setMode(r.mode ?? "unavailable");
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
      );

    (dialog?.querySelector<HTMLElement>("input") ?? focusable()[0] ?? dialog)?.focus();
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
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
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
    if (!opened) throw new Error("Your browser blocked the connection page. Click Continue to open it.");
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
        setError("This app already has an account. Add a label such as work or personal to connect another.");
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
  const visible = matching.filter((card) =>
    tab === "marketplace" || status[card.slug]?.connected || Boolean(status[card.slug]?.accounts?.length)
  );
  const connectedCount = Object.values(status).filter((service) => service.connected || service.accounts?.length).length;
  const connectedEmptyCopy = connectedInventoryCopy(inventoryPhase);
  const close = () => dispatch({ type: "togglePlugins", open: false });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugins-title"
        tabIndex={-1}
        className="animate-pop-in flex h-[min(780px,calc(100dvh-2rem))] w-full max-w-[1040px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-6 sm:px-8 sm:pt-7">
          <div>
            <h2 id="plugins-title" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">Plugins</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">Connect apps and your own MCP tools.</p>
          </div>
          <div className="flex items-center gap-1">
            {surface === "apps" && (
              <button
                onClick={() => void loadConnectionInventory(true)}
                disabled={refreshing}
                className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                title="Refresh connection status"
              >
                <RefreshCw size={17} className={cn(refreshing && "animate-spin")} />
              </button>
            )}
            <button
              onClick={close}
              aria-label="Close plugins"
              className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={21} />
            </button>
          </div>
        </header>

        <div className="border-b border-hairline/40 px-6 sm:px-8">
          <div className="flex gap-6" role="tablist" aria-label="Plugin type">
            {(["apps", "mcp"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={surface === item}
                onClick={() => setSurface(item)}
                className={cn(
                  "border-b-2 px-0.5 pb-3 pt-1 text-[13.5px] font-medium transition-colors",
                  surface === item ? "border-accent text-ink" : "border-transparent text-ink-secondary hover:text-ink",
                )}
              >
                {item === "apps" ? "Connected apps" : "MCP servers"}
              </button>
            ))}
          </div>
        </div>

        {surface === "apps" ? (
          <>
        {stale && (
          // Say which of the two things is true. Silence here is what makes a
          // remembered list indistinguishable from a confirmed one.
          <div className="mx-6 mb-1 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning sm:mx-8">
            <TriangleAlert size={14} className="mt-px shrink-0" />
            <span>
              Showing what was connected last time — this Mac's credential store could not be opened just now, so these
              could not be re-checked. Your apps are still connected; restarting OpenMausBot usually clears this.
            </span>
          </div>
        )}

        <div className="flex flex-col gap-3 px-6 pb-4 pt-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div className="flex w-fit rounded-xl bg-raised/70 p-1" role="tablist" aria-label="Connected apps view">
            <button
              role="tab"
              aria-selected={tab === "marketplace"}
              onClick={() => setTab("marketplace")}
              className={cn(
                "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                tab === "marketplace" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
              )}
            >
              Marketplace
            </button>
            <button
              role="tab"
              aria-selected={tab === "connected"}
              onClick={() => setTab("connected")}
              className={cn(
                "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                tab === "connected" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
              )}
            >
              Connected{connectedCount > 0 ? ` ${connectedCount}` : ""}
            </button>
          </div>
          <label className="flex h-11 w-full items-center gap-2.5 rounded-xl bg-raised/70 px-3.5 sm:w-[320px]">
            <Search size={17} className="shrink-0 text-ink-secondary" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search apps"
              aria-label="Search apps"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </label>
        </div>

        {/* Two notices about the same fact is one too many: the stale banner
            above already explains this launch, and "configure your own
            connection service" is advice for someone who never set one up. */}
        {!configured && !stale && (
          <div className="mx-6 mb-1 rounded-xl bg-warning/10 px-4 py-3 text-[13px] text-warning sm:mx-8">
            Connected apps are temporarily unavailable. Retry after restarting the host, or configure the connection service there.{" "}
            <button
              className={cn("font-medium underline underline-offset-2", remoteClient && "hidden")}
              onClick={() => {
                close();
                dispatch({ type: "toggleAppSettings", open: true });
              }}
            >
              Open settings
            </button>
          </div>
        )}
        {configured && !remoteClient && source === "curated" && mode === "self-hosted" && (
          <div className="mx-6 mb-1 text-[12px] text-ink-secondary sm:mx-8">
            Showing featured apps.{" "}
            <button
              className="underline underline-offset-2 hover:text-ink"
              onClick={() => {
                close();
                dispatch({ type: "toggleAppSettings", open: true });
              }}
            >
              Update your Composio key
            </button>{" "}
            for the full catalog.
          </div>
        )}
        {error && <div role="alert" className="mx-6 mt-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger sm:mx-8">{error}</div>}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-5 sm:px-8">
          {cards === null ? (
            <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary">
              <Loader2 size={14} className="animate-spin" /> Loading catalog…
            </div>
          ) : (
            <div>
              <div className="mb-3 text-[12px] font-medium text-ink-secondary">
                {tab === "connected" ? "Your connections" : search ? "Search results" : "Available apps"}
              </div>
              <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
              {visible.map((card) => {
              const serviceStatus = status[card.slug];
              const pending = serviceStatus?.pending;
              const failed = serviceStatus?.status && /^(expired|failed)$/i.test(serviceStatus.status);
              const accounts = serviceStatus?.accounts ?? [];
              // connected with no accounts and nothing in flight = a no-auth
              // toolkit: there is no OAuth to run, so "Connect" would mint a
              // pointless authorize. It ships included.
              const included = card.noAuth === true
                || (serviceStatus?.connected === true && !accounts.length && !pending && !failed);
              const addingAccount = aliasSlug === card.slug && !pending;
              const busy = busySlug === card.slug;
              const unavailableReason = managedConnectorUnavailableReason(mode, card.slug);
              return (
                <div
                  key={card.slug}
                  className="min-h-[88px] border-b border-hairline/35 px-1 py-4"
                >
                  <div className="flex items-center gap-3">
                    <ServiceIcon card={card} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium text-ink">{card.label}</div>
                      <div
                        className="mt-0.5 truncate text-[12.5px] text-ink-secondary"
                        title={unavailableReason ?? undefined}
                      >
                        {unavailableReason ?? (
                          pending
                            ? pendingUrls[card.slug]
                              ? "Finish setup in your browser"
                              : "Finish setup in your browser, or disconnect the pending account below to start again"
                            : failed && !accounts.length
                              ? "Authorization expired — try again"
                              : card.blurb
                        )}
                      </div>
                    </div>
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
                      className="flex min-w-[88px] items-center justify-center gap-1.5 rounded-full bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
                    >
                      {unavailableReason ? (
                        "Self-host only"
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
                  {accounts.length > 0 && (
                    <div className="ml-14 mt-3 space-y-2">
                      {accounts.map((account) => {
                        const active = /^active$/i.test(account.status);
                        return (
                          <div key={account.id} className="flex items-center gap-2 rounded-lg bg-raised/45 px-3 py-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                                {active && <Check size={13} className="shrink-0 text-success" />}
                                <span className="truncate">{account.alias || account.id}</span>
                              </div>
                              <div className="mt-0.5 truncate text-[10.5px] text-ink-secondary">
                                {account.alias ? `${account.id} · ` : ""}{account.status.toLowerCase()}
                              </div>
                            </div>
                            {mayDisconnect && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  if (!window.confirm(disconnectAccountConfirmation(card.label, account))) return;
                                  disconnectAccount(card.slug, account.id);
                                }}
                                className="rounded-md px-2 py-1 text-[11px] text-ink-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                                aria-label={`Disconnect ${account.alias || account.id} from ${card.label}`}
                              >
                                Disconnect
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {addingAccount && (
                    <form
                      className="ml-14 mt-3 flex items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const alias = aliasDraft.trim();
                        if (!alias) {
                          setError("Enter a label for the account, such as work or personal.");
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
                        placeholder="Account label (work, personal…)"
                        aria-label={accounts.length > 0 ? `Label for another ${card.label} account` : `Label for the new ${card.label} account`}
                        className="min-w-0 flex-1 rounded-lg bg-raised px-3 py-2 text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                      <button
                        type="submit"
                        disabled={busy || !aliasDraft.trim()}
                        className="rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-white disabled:opacity-40"
                      >
                        Continue
                      </button>
                    </form>
                  )}
                </div>
              );
              })}
              </div>
            </div>
          )}
          {cards !== null && visible.length === 0 && (
            <div className="flex min-h-56 flex-col items-center justify-center text-center">
              <div className="text-[14px] font-medium text-ink">
                {tab === "connected" ? connectedEmptyCopy.title : "No apps found"}
              </div>
              <div className="mt-1 text-[12.5px] text-ink-secondary">
                {tab === "connected" ? connectedEmptyCopy.description : "Try a different search."}
              </div>
              {tab === "connected" && inventoryPhase === "error" && (
                <button
                  type="button"
                  disabled={refreshing}
                  onClick={() => void loadConnectionInventory(true)}
                  className="mt-4 flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-50"
                >
                  <RefreshCw size={13} className={cn(refreshing && "animate-spin")} />
                  Retry
                </button>
              )}
            </div>
          )}
        </div>
          </>
        ) : (
          <McpServersPanel />
        )}
      </div>
    </div>
  );
}
