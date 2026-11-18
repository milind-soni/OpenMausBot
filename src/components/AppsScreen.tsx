import { UsageRings } from "./UsageRings";
// Dedicated full-screen App Store page for browsing, searching, and connecting
// integrations powered by Composio Connect.
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  Globe,
  Grid,
  Layers,
  LayoutGrid,
  Loader2,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Unlink,
  X,
  Zap,
} from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";

export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  domain: string | null;
}

export type AppCategory = "all" | "connected" | "developer" | "productivity" | "communication" | "marketing" | "data";

const CATEGORIES: Array<{ id: AppCategory; label: string; icon: typeof Grid }> = [
  { id: "all", label: "All Apps", icon: LayoutGrid },
  { id: "connected", label: "Connected", icon: CheckCircle2 },
  { id: "developer", label: "Developer Tools", icon: Zap },
  { id: "productivity", label: "Productivity", icon: Layers },
  { id: "communication", label: "Communication", icon: Radio },
  { id: "marketing", label: "Marketing & CRM", icon: Sparkles },
  { id: "data", label: "Data & Storage", icon: Globe },
];

const FEATURED_SLUGS = ["github", "slack", "notion", "googledrive", "linear", "discord", "jira"];

function categorizeApp(card: ToolkitCard): AppCategory {
  const text = `${card.slug} ${card.label} ${card.blurb} ${card.domain ?? ""}`.toLowerCase();

  if (
    text.includes("git") ||
    text.includes("code") ||
    text.includes("repo") ||
    text.includes("issue") ||
    text.includes("jira") ||
    text.includes("linear") ||
    text.includes("sentry") ||
    text.includes("postman") ||
    text.includes("render") ||
    text.includes("supabase") ||
    text.includes("vercel") ||
    text.includes("bitbucket") ||
    text.includes("dev") ||
    text.includes("terminal") ||
    text.includes("ci/cd")
  ) {
    return "developer";
  }

  if (
    text.includes("slack") ||
    text.includes("discord") ||
    text.includes("mail") ||
    text.includes("gmail") ||
    text.includes("chat") ||
    text.includes("teams") ||
    text.includes("message") ||
    text.includes("telegram") ||
    text.includes("whatsapp") ||
    text.includes("zoom")
  ) {
    return "communication";
  }

  if (
    text.includes("drive") ||
    text.includes("box") ||
    text.includes("dropbox") ||
    text.includes("storage") ||
    text.includes("s3") ||
    text.includes("cloud") ||
    text.includes("database") ||
    text.includes("snowflake") ||
    text.includes("bigquery") ||
    text.includes("onedrive") ||
    text.includes("file")
  ) {
    return "data";
  }

  if (
    text.includes("hubspot") ||
    text.includes("salesforce") ||
    text.includes("stripe") ||
    text.includes("shopify") ||
    text.includes("zendesk") ||
    text.includes("intercom") ||
    text.includes("marketing") ||
    text.includes("crm") ||
    text.includes("twitter") ||
    text.includes("linkedin") ||
    text.includes("mailchimp")
  ) {
    return "marketing";
  }

  return "productivity";
}

function categoryLabel(cat: AppCategory): string {
  switch (cat) {
    case "developer":
      return "Developer Tools";
    case "productivity":
      return "Productivity";
    case "communication":
      return "Communication";
    case "marketing":
      return "Marketing & CRM";
    case "data":
      return "Data & Storage";
    default:
      return "Integration";
  }
}

function ServiceIcon({ card, size = 36 }: { card: ToolkitCard; size?: number }) {
  // 0 = official logo, 1 = favicon by domain, 2 = monogram
  const [stage, setStage] = useState(card.logo ? 0 : card.domain ? 1 : 2);

  if (stage === 0 && card.logo) {
    return (
      <img
        src={card.logo}
        alt=""
        style={{ width: size, height: size }}
        className="shrink-0 rounded-xl object-contain bg-white p-1.5 border border-white/10"
        onError={() => setStage(1)}
      />
    );
  }
  if (stage === 1 && card.domain) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${card.domain}&sz=64`}
        alt=""
        style={{ width: size, height: size }}
        className="shrink-0 rounded-xl object-contain bg-white p-1.5 border border-white/10"
        onError={() => setStage(2)}
      />
    );
  }
  return (
    <div
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-xl bg-raised font-bold text-ink border border-hairline/50"
    >
      <span className={size > 36 ? "text-[16px]" : "text-[13px]"}>{card.label.slice(0, 2).toUpperCase()}</span>
    </div>
  );
}

function AppDetailsModal({
  card,
  connected,
  busy,
  configured,
  onClose,
  onConnect,
  onDisconnect,
}: {
  card: ToolkitCard;
  connected: boolean;
  busy: boolean;
  configured: boolean;
  onClose: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const { dispatch } = useStore();
  const category = categorizeApp(card);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="animate-pop-in flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl shadow-black/80">
        <header className="flex items-start justify-between border-b border-hairline/40 p-5">
          <div className="flex items-center gap-3.5">
            <ServiceIcon card={card} size={48} />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[17px] font-semibold text-ink">{card.label}</h2>
                <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
                  {categoryLabel(category)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-secondary">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 font-medium",
                    connected ? "text-success" : "text-ink-secondary"
                  )}
                >
                  <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-ink-secondary/40")} />
                  {connected ? "Connected & Ready" : "Not connected"}
                </span>
                {card.domain && (
                  <>
                    <span>·</span>
                    <a
                      href={`https://${card.domain}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-accent hover:underline"
                    >
                      {card.domain} <ArrowUpRight size={11} />
                    </a>
                  </>
                )}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink transition-colors"
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-4 text-[13px]">
          <div>
            <h3 className="font-medium text-ink">About {card.label}</h3>
            <p className="mt-1.5 leading-relaxed text-ink-secondary">{card.blurb || "Integrate this service to enable automated actions and context retrieval for all your Buddies."}</p>
          </div>

          <div className="rounded-xl border border-hairline/40 bg-card p-4 space-y-2.5">
            <div className="text-[12px] font-medium uppercase tracking-wider text-ink-secondary">Capabilities</div>
            <div className="grid grid-cols-2 gap-2 text-[12px] text-ink">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-accent shrink-0" />
                <span>Agent Tools & Actions</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-accent shrink-0" />
                <span>Context & Search</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-accent shrink-0" />
                <span>Secure OAuth 2.0</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-accent shrink-0" />
                <span>Buddy Automation</span>
              </div>
            </div>
          </div>

          {!configured && (
            <div className="rounded-xl border border-warning/30 bg-warning/10 p-3.5 text-[12px] text-warning space-y-1.5">
              <div className="font-medium flex items-center gap-1.5">
                <AlertTriangle size={14} /> Composio Key Required
              </div>
              <p className="leading-normal">
                To authorize and connect this app, add your Composio Connect Key in App Settings.
              </p>
              <button
                onClick={() => {
                  onClose();
                  dispatch({ type: "toggleAppSettings", open: true });
                }}
                className="mt-1 inline-flex items-center gap-1 font-semibold underline hover:opacity-80"
              >
                Go to App Settings <ArrowUpRight size={12} />
              </button>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-hairline/40 px-5 py-4 bg-card/40">
          <button
            onClick={onClose}
            className="rounded-xl bg-raised px-4 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover transition-colors"
          >
            Close
          </button>
          <div>
            {connected ? (
              <button
                disabled={busy}
                onClick={onDisconnect}
                className="inline-flex items-center gap-2 rounded-xl bg-danger/10 border border-danger/25 px-4 py-2 text-[13px] font-medium text-danger hover:bg-danger/20 transition-colors disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Unlink size={14} />}
                Disconnect App
              </button>
            ) : (
              <button
                disabled={!configured || busy}
                onClick={onConnect}
                className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 transition-all disabled:opacity-50 shadow-sm"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                Connect {card.label}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function SpotlightBanner({
  cards,
  status,
  busySlug,
  configured,
  onConnect,
  onDisconnect,
  onSelect,
}: {
  cards: ToolkitCard[];
  status: Record<string, { connected: boolean }>;
  busySlug: string | null;
  configured: boolean;
  onConnect: (slug: string) => void;
  onDisconnect: (slug: string) => void;
  onSelect: (card: ToolkitCard) => void;
}) {
  const spotlightCards = cards.filter((c) => FEATURED_SLUGS.includes(c.slug)).slice(0, 3);
  if (!spotlightCards.length) return null;

  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[14px] font-semibold text-ink">
          <Sparkles size={16} className="text-accent" />
          Featured & Popular Apps
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        {spotlightCards.map((card) => {
          const connected = status[card.slug]?.connected;
          const busy = busySlug === card.slug;
          return (
            <div
              key={card.slug}
              onClick={() => onSelect(card)}
              className="group relative flex flex-col justify-between rounded-2xl border border-hairline/60 bg-gradient-to-b from-card to-panel p-4 shadow-sm hover:border-accent/40 hover:shadow-md transition-all cursor-pointer"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <ServiceIcon card={card} size={40} />
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border",
                      connected
                        ? "border-success/30 bg-success/10 text-success"
                        : "border-hairline/50 bg-raised/70 text-ink-secondary"
                    )}
                  >
                    <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-ink-secondary/50")} />
                    {connected ? "Connected" : "Available"}
                  </span>
                </div>

                <div className="mt-3">
                  <h3 className="text-[15px] font-semibold text-ink group-hover:text-accent transition-colors">
                    {card.label}
                  </h3>
                  <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-ink-secondary">
                    {card.blurb}
                  </p>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-hairline/40 pt-3">
                <span className="text-[11px] font-medium text-ink-secondary">
                  {categorizeApp(card) === "developer" ? "Dev Tool" : "Integration"}
                </span>
                <button
                  disabled={!configured || busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (connected) onDisconnect(card.slug);
                    else onConnect(card.slug);
                  }}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-[12px] font-medium transition-all disabled:opacity-50",
                    connected
                      ? "bg-raised text-ink-secondary hover:bg-danger/10 hover:text-danger border border-hairline/40"
                      : "bg-accent text-white hover:brightness-110 shadow-sm"
                  )}
                >
                  {busy ? (
                    <Loader2 size={13} className="animate-spin inline" />
                  ) : connected ? (
                    "Disconnect"
                  ) : (
                    "Connect"
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function AppsScreen() {
  const { dispatch } = useStore();
  const [cards, setCards] = useState<ToolkitCard[] | null>(null);
  const [source, setSource] = useState<"api" | "curated">("curated");
  const [configured, setConfigured] = useState(true);
  const [status, setStatus] = useState<Record<string, { connected: boolean }>>({});
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<AppCategory>("all");
  const [selectedModalCard, setSelectedModalCard] = useState<ToolkitCard | null>(null);

  // Esc key closes AppsScreen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !selectedModalCard) {
        dispatch({ type: "toggleApps", open: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, selectedModalCard]);

  const refreshStatus = useCallback((slugs: string[]) => {
    if (!slugs.length) return Promise.resolve();
    setRefreshing(true);
    return api(`/api/connectors?services=${slugs.join(",")}`)
      .then((r) => setStatus((prev) => ({ ...prev, ...(r.services ?? {}) })))
      .catch(() => {})
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => {
    let alive = true;
    api("/api/connectors/catalog")
      .then((r) => {
        if (!alive) return;
        setCards(r.cards ?? []);
        setSource(r.source ?? "curated");
        setConfigured(Boolean(r.configured));
        if (r.configured) {
          void refreshStatus((r.cards ?? []).map((c: ToolkitCard) => c.slug).slice(0, 50));
        }
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [refreshStatus]);

  const connect = (slug: string) => {
    setBusySlug(slug);
    setError(null);
    api(`/api/connectors/${slug}/authorize`, { method: "POST" })
      .then(({ url }) => {
        window.open(url);
        // the user finishes OAuth in the browser; poll a few times to catch it
        let tries = 0;
        const timer = setInterval(() => {
          void refreshStatus([slug]);
          if (++tries >= 6 || status[slug]?.connected) clearInterval(timer);
        }, 4000);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  const disconnect = (slug: string) => {
    setBusySlug(slug);
    api(`/api/connectors/${slug}`, { method: "DELETE" })
      .then(() => refreshStatus([slug]))
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  const connectedCount = useMemo(() => {
    return Object.values(status).filter((s) => s.connected).length;
  }, [status]);

  // The featured banner shows these; the grid below skips them so no app appears twice.
  const spotlightSlugs = useMemo(
    () => new Set((cards ?? []).filter((c) => FEATURED_SLUGS.includes(c.slug)).slice(0, 3).map((c) => c.slug)),
    [cards],
  );
  const filteredCards = useMemo(() => {
    if (!cards) return [];
    return cards.filter((card) => {
      const matchesSearch =
        !search ||
        `${card.label} ${card.slug} ${card.blurb} ${card.domain ?? ""}`
          .toLowerCase()
          .includes(search.toLowerCase());

      if (!matchesSearch) return false;

      if (activeCategory === "all") return true;
      if (activeCategory === "connected") return Boolean(status[card.slug]?.connected);
      return categorizeApp(card) === activeCategory;
    });
  }, [cards, search, activeCategory, status]);

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Header bar */}
      <header
        className="flex h-[64px] shrink-0 items-center justify-between border-b border-hairline/40 px-6"
        style={{ WebkitAppRegion: "drag", paddingRight: window.gbs?.platform === "win32" ? 148 : undefined } as CSSProperties}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => dispatch({ type: "toggleApps", open: false })}
            className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink transition-colors"
            title="Back to conversation (Esc)"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex items-center gap-2.5">
            <LayoutGrid size={20} className="text-accent" />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-[16px] font-semibold text-ink">Apps & Integrations</h1>
                {connectedCount > 0 && (
                  <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-semibold text-success border border-success/30">
                    {connectedCount} connected
                  </span>
                )}
              </div>
              <p className="text-[12px] text-ink-secondary">
                Connect external services, developer tools, and data stores to power your bots.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
          <UsageRings />
          <button
            onClick={() => {
              if (cards) refreshStatus(cards.map((c) => c.slug).slice(0, 50));
            }}
            disabled={refreshing}
            className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink transition-colors disabled:opacity-40"
            title="Refresh connection status"
          >
            <RefreshCw size={17} className={cn(refreshing && "animate-spin")} />
          </button>
          <button
            onClick={() => dispatch({ type: "toggleApps", open: false })}
            className="rounded-lg bg-raised px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover transition-colors"
          >
            Done
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-6xl space-y-6">
          {/* Top banner when unconfigured */}
          {!configured && (
            <div className="flex items-center justify-between rounded-2xl border border-warning/30 bg-warning/10 p-4 text-[13px] text-warning shadow-sm">
              <div className="flex items-center gap-3">
                <AlertTriangle size={20} className="shrink-0 text-warning" />
                <div>
                  <span className="font-semibold text-ink">Composio Connect key required.</span> Add your key in App Settings to authorize and connect apps with your AI Buddies.
                </div>
              </div>
              <button
                onClick={() => dispatch({ type: "toggleAppSettings", open: true })}
                className="inline-flex items-center gap-1.5 rounded-xl bg-warning px-3.5 py-2 text-[12px] font-medium text-black hover:brightness-105 transition-all shrink-0"
              >
                <Settings size={14} /> Open Settings
              </button>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-between rounded-xl border border-danger/30 bg-danger/10 p-3.5 text-[13px] text-danger">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="p-1 hover:opacity-80">
                <X size={16} />
              </button>
            </div>
          )}

          {/* Search bar & Category filters */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-secondary" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search apps by name, service, or keyword…"
                className="w-full rounded-xl border border-hairline/50 bg-panel pl-10 pr-4 py-2.5 text-[14px] text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none transition-colors"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-secondary hover:text-ink p-1"
                >
                  <X size={15} />
                </button>
              )}
            </div>
          </div>

          {/* Category tabs */}
          <nav
            aria-label="App categories"
            className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar"
          >
            {CATEGORIES.map((cat) => {
              const active = activeCategory === cat.id;
              const Icon = cat.icon;
              return (
                <button
                  key={cat.id}
                  onClick={() => setActiveCategory(cat.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-xl px-3.5 py-2 text-[13px] whitespace-nowrap transition-all border",
                    active
                      ? "bg-accent text-white border-accent font-medium shadow-sm"
                      : "bg-panel text-ink-secondary border-hairline/40 hover:bg-raised hover:text-ink"
                  )}
                >
                  <Icon size={14} className={active ? "text-white" : "text-ink-secondary"} />
                  {cat.label}
                  {cat.id === "connected" && connectedCount > 0 && (
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.2 text-[10px] font-bold",
                        active ? "bg-white/20 text-white" : "bg-raised text-ink-secondary"
                      )}
                    >
                      {connectedCount}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Featured row (shown on 'all' view with no active search query) */}
          {activeCategory === "all" && !search && cards && cards.length > 0 && (
            <SpotlightBanner
              cards={cards}
              status={status}
              busySlug={busySlug}
              configured={configured}
              onConnect={connect}
              onDisconnect={disconnect}
              onSelect={setSelectedModalCard}
            />
          )}

          {/* Apps Grid */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[13px] font-semibold text-ink">
                {activeCategory === "all"
                  ? search
                    ? `Matching Apps (${filteredCards.length})`
                    : "All Available Integrations"
                  : `${CATEGORIES.find((c) => c.id === activeCategory)?.label ?? "Apps"} (${filteredCards.length})`}
              </div>
              {configured && source === "curated" && (
                <div className="text-[11px] text-ink-secondary">
                  Showing curated apps.{" "}
                  <button
                    onClick={() => dispatch({ type: "toggleAppSettings", open: true })}
                    className="text-accent underline hover:opacity-80"
                  >
                    Add Composio API Key
                  </button>{" "}
                  for 500+ integrations.
                </div>
              )}
            </div>

            {cards === null ? (
              <div className="flex flex-col items-center justify-center gap-3 py-24 text-ink-secondary">
                <Loader2 size={24} className="animate-spin text-accent" />
                <span className="text-[14px]">Loading app directory…</span>
              </div>
            ) : filteredCards.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-hairline/60 bg-panel/40 py-20 text-center">
                <LayoutGrid size={36} className="text-ink-secondary/50" />
                <h3 className="mt-3 text-[15px] font-semibold text-ink">No apps found</h3>
                <p className="mt-1 max-w-sm text-[13px] text-ink-secondary">
                  {search
                    ? `No applications matched “${search}”. Try clearing your search or category filter.`
                    : activeCategory === "connected"
                      ? "You haven't connected any apps yet. Browse the catalog to connect your first app."
                      : "No apps available in this category."}
                </p>
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="mt-4 rounded-xl bg-raised px-4 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover"
                  >
                    Clear search
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-4">
                {(activeCategory === "all" && !search
                  ? filteredCards.filter((c) => !spotlightSlugs.has(c.slug))
                  : filteredCards
                ).map((card) => {
                  const connected = Boolean(status[card.slug]?.connected);
                  const busy = busySlug === card.slug;
                  const category = categorizeApp(card);

                  return (
                    <div
                      key={card.slug}
                      onClick={() => setSelectedModalCard(card)}
                      className="group flex flex-col justify-between rounded-2xl border border-hairline/50 bg-card p-4 shadow-sm hover:border-accent/40 hover:shadow-md transition-all cursor-pointer"
                    >
                      <div>
                        <div className="flex items-start justify-between gap-3">
                          <ServiceIcon card={card} size={42} />
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border",
                              connected
                                ? "border-success/30 bg-success/10 text-success"
                                : "border-hairline/40 bg-raised/70 text-ink-secondary"
                            )}
                          >
                            <span
                              className={cn(
                                "size-1.5 rounded-full",
                                connected ? "bg-success" : "bg-ink-secondary/40"
                              )}
                            />
                            {connected ? "Connected" : "Available"}
                          </span>
                        </div>

                        <div className="mt-3">
                          <div className="flex items-center gap-2">
                            <h3 className="text-[14px] font-semibold text-ink group-hover:text-accent transition-colors">
                              {card.label}
                            </h3>
                          </div>
                          <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-ink-secondary">
                            {card.blurb || "Integrate external automation and data capabilities for Buddies."}
                          </p>
                        </div>
                      </div>

                      <div className="mt-4 flex items-center justify-between border-t border-hairline/40 pt-3">
                        <span className="rounded-md bg-raised/80 px-2 py-0.5 text-[10px] font-medium text-ink-secondary">
                          {categoryLabel(category)}
                        </span>
                        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                          <button
                            disabled={!configured || busy}
                            onClick={() => {
                              if (connected) disconnect(card.slug);
                              else connect(card.slug);
                            }}
                            className={cn(
                              "rounded-xl px-3 py-1.5 text-[12px] font-medium transition-all disabled:opacity-50",
                              connected
                                ? "bg-raised text-ink-secondary hover:bg-danger/10 hover:text-danger border border-hairline/40"
                                : "bg-accent text-white hover:brightness-110 shadow-sm"
                            )}
                          >
                            {busy ? (
                              <Loader2 size={13} className="animate-spin inline mx-2" />
                            ) : connected ? (
                              "Disconnect"
                            ) : (
                              "Connect"
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal for App Details */}
      {selectedModalCard && (
        <AppDetailsModal
          card={selectedModalCard}
          connected={Boolean(status[selectedModalCard.slug]?.connected)}
          busy={busySlug === selectedModalCard.slug}
          configured={configured}
          onClose={() => setSelectedModalCard(null)}
          onConnect={() => connect(selectedModalCard.slug)}
          onDisconnect={() => disconnect(selectedModalCard.slug)}
        />
      )}
    </main>
  );
}
