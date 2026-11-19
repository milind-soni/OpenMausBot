import { UsageRings } from "./UsageRings";
// Apps screen: a short, curated list of apps Buddies can use, each set up in
// about a minute (no accounts or developer keys). Status is checked live.
import { useEffect, useState, type CSSProperties } from "react";
import { ArrowLeft, Clapperboard, LayoutGrid, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { useStore } from "@/state/store";
import { APP_STATE_LABEL, refreshApps, useApps, type AppInfo, type AppState } from "@/state/apps";
import { cn } from "@/lib/cn";
import { AppSetupDialog } from "./AppSetupDialog";

const STATE_STYLE: Record<AppState, { pill: string; dot: string }> = {
  ready: { pill: "border-success/30 bg-success/10 text-success", dot: "bg-success" },
  needs_setup: { pill: "border-warning/30 bg-warning/10 text-warning", dot: "bg-warning" },
  not_running: { pill: "border-hairline/40 bg-raised/70 text-ink-secondary", dot: "bg-ink-secondary/50" },
  error: { pill: "border-danger/30 bg-danger/10 text-danger", dot: "bg-danger" },
};

export function AppStatusPill({ state }: { state: AppState }) {
  const style = STATE_STYLE[state];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", style.pill)}>
      <span className={cn("size-1.5 rounded-full", style.dot)} aria-hidden />
      {APP_STATE_LABEL[state]}
    </span>
  );
}

const CATEGORY_ICON: Record<string, typeof Clapperboard> = { video: Clapperboard };

export function AppIcon({ app, size = 42 }: { app: Pick<AppInfo, "category" | "icon">; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (app.icon && !failed) {
    // the app's real icon (a full tile, so no extra frame)
    return <img src={app.icon} alt="" aria-hidden width={size} height={size} onError={() => setFailed(true)} className="shrink-0 rounded-[22%] object-contain" />;
  }
  const Icon = CATEGORY_ICON[app.category] ?? Sparkles;
  return (
    <div style={{ width: size, height: size }} className="flex shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-accent/12 text-accent" aria-hidden>
      <Icon size={Math.round(size * 0.5)} />
    </div>
  );
}

/** Which of the user's models can use apps: apps reach Buddies through MCP tools, which not every driver loads. */
export function AppModelTags({ compact = false }: { compact?: boolean }) {
  const { state } = useStore();
  const instances = state.instances ?? [];
  if (!instances.length) return null;
  const supported = instances.filter((i) => i.appsCapable);
  const unsupported = instances.filter((i) => !i.appsCapable);
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", compact ? "text-[10px]" : "text-[11px]")}>
      <span className="text-ink-secondary">Works with</span>
      {supported.length ? (
        supported.map((i) => (
          <span key={i.instanceId} className="rounded-md border border-accent/25 bg-accent/10 px-1.5 py-0.5 font-medium text-accent">
            {i.displayName}
          </span>
        ))
      ) : (
        <span className="text-warning">none of your models yet</span>
      )}
      {unsupported.length > 0 && (
        <span className="text-ink-secondary/80" title="Buddies on these models can't use apps">
          · Not on {unsupported.map((i) => i.displayName).join(", ")}
        </span>
      )}
    </div>
  );
}

function AppCard({ app, onSetup }: { app: AppInfo; onSetup: () => void }) {
  const ready = app.status.state === "ready";
  return (
    <article className="flex flex-col justify-between rounded-2xl border border-hairline/50 bg-card p-4 shadow-sm transition-all hover:border-accent/40">
      <div>
        <div className="flex items-start justify-between gap-3">
          <AppIcon app={app} />
          <AppStatusPill state={app.status.state} />
        </div>
        <h3 className="mt-3 text-[14px] font-semibold text-ink">
          {app.name} <span className="font-normal text-ink-secondary">by {app.maker}</span>
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{app.blurb}</p>
        <p className={cn("mt-2 text-[12px]", ready ? "text-ink-secondary" : "text-ink")}>{app.status.message}</p>
        <div className="mt-3">
          <AppModelTags compact />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-hairline/40 pt-3">
        <code className="rounded-md bg-raised/80 px-1.5 py-0.5 text-[11px] text-accent" title={`Tag it in a message to choose ${app.name}`}>
          +{app.id}
        </code>
        <button
          onClick={onSetup}
          className={cn(
            "rounded-xl px-3 py-1.5 text-[12px] font-medium transition-all",
            app.settings.tokenConfigured ? "border border-hairline/40 bg-raised text-ink hover:bg-raised-hover" : "bg-accent text-white shadow-sm hover:brightness-110",
          )}
        >
          {app.settings.tokenConfigured ? "Manage" : "Set up"}
        </button>
      </div>
    </article>
  );
}

export function AppsScreen() {
  const { dispatch } = useStore();
  const apps = useApps();
  const [setupId, setSetupId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setupApp = apps?.find((a) => a.id === setupId) ?? null;

  const refresh = () => {
    setRefreshing(true);
    setError(null);
    refreshApps(true)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRefreshing(false));
  };

  // live check whenever the screen opens
  useEffect(refresh, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !setupId) dispatch({ type: "toggleApps", open: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, setupId]);

  const readyCount = apps?.filter((a) => a.status.state === "ready").length ?? 0;

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <header
        className="flex h-[64px] shrink-0 items-center justify-between border-b border-hairline/40 px-6"
        style={{ WebkitAppRegion: "drag", paddingRight: window.gbs?.platform === "win32" ? 148 : undefined } as CSSProperties}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => dispatch({ type: "toggleApps", open: false })}
            className="rounded-lg p-2 text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
            title="Back to conversation (Esc)"
            aria-label="Back to conversation"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex items-center gap-2.5">
            <LayoutGrid size={20} className="text-accent" />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-[16px] font-semibold text-ink">Apps</h1>
                {readyCount > 0 && (
                  <span className="rounded-full border border-success/30 bg-success/15 px-2 py-0.5 text-[11px] font-semibold text-success">{readyCount} ready</span>
                )}
              </div>
              <p className="text-[12px] text-ink-secondary">Apps your Buddies can use. Each one sets up in about a minute, with no accounts or developer keys.</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
          <UsageRings />
          <button
            onClick={refresh}
            disabled={refreshing}
            className="rounded-lg p-2 text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
            title="Check app status again"
            aria-label="Check app status again"
          >
            <RefreshCw size={17} className={cn(refreshing && "animate-spin")} />
          </button>
          <button
            onClick={() => dispatch({ type: "toggleApps", open: false })}
            className="rounded-lg bg-raised px-3.5 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-raised-hover"
          >
            Done
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-5xl space-y-5">
          {error && (
            <div role="alert" className="flex items-center justify-between rounded-xl border border-danger/30 bg-danger/10 p-3.5 text-[13px] text-danger">
              <span>{error}</span>
              <button onClick={() => setError(null)} aria-label="Dismiss" className="p-1 hover:opacity-80">
                <X size={16} />
              </button>
            </div>
          )}

          <p className="text-[13px] text-ink-secondary">
            Ask a Buddy for something an app can do, and it will use the app or tell you how to set it up. To choose an app yourself, tag it in your message, like{" "}
            <code className="rounded bg-raised px-1 text-accent">+edits</code>.
          </p>

          {apps === null ? (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-ink-secondary">
              <Loader2 size={24} className="animate-spin text-accent" />
              <span className="text-[14px]">Checking your apps…</span>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">
              {apps.map((app) => (
                <AppCard key={app.id} app={app} onSetup={() => setSetupId(app.id)} />
              ))}
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-hairline/60 bg-panel/40 p-6 text-center">
                <Sparkles size={22} className="text-ink-secondary/60" aria-hidden />
                <p className="mt-2 text-[13px] font-medium text-ink">More apps coming</p>
                <p className="mt-1 text-[12px] text-ink-secondary">We add apps that are quick to set up.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {setupApp && <AppSetupDialog app={setupApp} onClose={() => setSetupId(null)} />}
    </main>
  );
}
