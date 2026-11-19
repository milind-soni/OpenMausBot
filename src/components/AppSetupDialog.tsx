// Set up one curated app: plain numbered steps, the access token (write-only
// — the saved value is never shown), an optional address under Advanced, and
// a live Test connection before saving.
import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Loader2, Unlink, X } from "lucide-react";
import { api } from "@/state/store";
import { setApps, type AppInfo, type AppState } from "@/state/apps";
import { useDialogFocus } from "@/lib/dialogFocus";
import { cn } from "@/lib/cn";
import { AppIcon, AppModelTags, AppStatusPill } from "./AppsScreen";

interface TestResult {
  state: AppState;
  message: string;
  toolCount: number;
}

export function AppSetupDialog({ app, onClose }: { app: AppInfo; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const testRef = useRef<HTMLButtonElement>(null);
  const needsToken = app.auth.kind === "bearer";
  const [token, setToken] = useState("");
  const [endpoint, setEndpoint] = useState(app.settings.endpoint);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useDialogFocus({ open: true, containerRef, entryFocusRef: needsToken ? tokenRef : testRef, onClose });

  const endpointChanged = endpoint.trim() !== app.settings.endpoint;
  const hasChanges = Boolean(token.trim()) || endpointChanged;
  const tokenId = `app-token-${app.id}`;
  const endpointId = `app-endpoint-${app.id}`;

  const test = async () => {
    setTesting(true);
    setError(null);
    try {
      const r = await api(`/api/apps/${app.id}/test`, {
        method: "POST",
        body: JSON.stringify({ token: token.trim() || undefined, endpoint: endpoint.trim() || undefined }),
      });
      setResult(r.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await api(`/api/apps/${app.id}`, {
        method: "PUT",
        body: JSON.stringify({ token: token.trim() || undefined, endpoint: endpoint.trim() }),
      });
      setApps(r.apps ?? []);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await api(`/api/apps/${app.id}`, { method: "DELETE" });
      setApps(r.apps ?? []);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`app-setup-title-${app.id}`}
        className="animate-pop-in flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl shadow-black/80"
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline/40 p-5">
          <div className="flex min-w-0 items-center gap-3.5">
            <AppIcon app={app} size={48} />
            <div className="min-w-0">
              <h2 id={`app-setup-title-${app.id}`} className="text-[17px] font-semibold text-ink">
                Set up {app.name}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-secondary">
                <span>by {app.maker}</span>
                <AppStatusPill state={app.status.state} />
              </div>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-ink-secondary transition-colors hover:bg-raised hover:text-ink">
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 text-[13px]">
          <p className="leading-relaxed text-ink-secondary">{app.blurb}</p>

          <section aria-labelledby={`app-steps-${app.id}`}>
            <h3 id={`app-steps-${app.id}`} className="font-medium text-ink">How to connect</h3>
            <ol className="mt-2 space-y-2">
              {app.setupSteps.map((step, i) => (
                <li key={step} className="flex gap-2.5 text-ink">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">{i + 1}</span>
                  <span className="leading-relaxed">{step}</span>
                </li>
              ))}
            </ol>
          </section>

          {app.auth.kind === "bearer" ? <div>
            <label htmlFor={tokenId} className="font-medium text-ink">
              {app.auth.label}
            </label>
            <input
              ref={tokenRef}
              id={tokenId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setResult(null);
              }}
              placeholder={app.settings.tokenConfigured ? "Saved. Paste a new one to replace it." : `Paste the ${app.auth.label.toLowerCase()}`}
              aria-describedby={`${tokenId}-help`}
              className="mt-1.5 w-full rounded-xl border border-hairline/50 bg-card px-3.5 py-2.5 font-mono text-[13px] text-ink placeholder:font-sans placeholder:text-ink-secondary focus:border-accent focus:outline-none"
            />
            <p id={`${tokenId}-help`} className="mt-1.5 text-[12px] text-ink-secondary">
              {app.auth.help} Keep it private: anyone with it can control {app.name} while its automation server is on.
            </p>
          </div> : <p className="rounded-xl border border-hairline/40 bg-card/60 p-3 text-[12px] text-ink-secondary">{app.auth.help} To stop access, turn off MCP in {app.name}’s settings.</p>}

          <details className="group rounded-xl border border-hairline/40 bg-card/60 px-3.5 py-2.5">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-medium text-ink-secondary">
              <ChevronRight size={14} className="transition-transform group-open:rotate-90" />
              Advanced
            </summary>
            <label htmlFor={endpointId} className="mt-3 block text-[12px] font-medium text-ink">
              Address
            </label>
            <input
              id={endpointId}
              value={endpoint}
              spellCheck={false}
              onChange={(e) => {
                setEndpoint(e.target.value);
                setResult(null);
              }}
              className="mt-1 w-full rounded-lg border border-hairline/50 bg-card px-3 py-2 font-mono text-[12px] text-ink focus:border-accent focus:outline-none"
            />
            <p className="mt-1.5 text-[11px] text-ink-secondary">
              Only change this if {app.name} shows a different port. Apps connect only to this computer. Default: {app.defaultEndpoint}
            </p>
          </details>

          <AppModelTags />

          <div aria-live="polite">
            {result && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-xl border p-3 text-[12px]",
                  result.state === "ready" ? "border-success/30 bg-success/10 text-success" : "border-warning/30 bg-warning/10 text-warning",
                )}
              >
                {result.state === "ready" ? <CheckCircle2 size={15} className="mt-px shrink-0" /> : <AlertTriangle size={15} className="mt-px shrink-0" />}
                <span>{result.message}</span>
              </div>
            )}
            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-[12px] text-danger">
                <AlertTriangle size={15} className="mt-px shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline/40 bg-card/40 px-5 py-4">
          <div>
            {app.settings.tokenConfigured && (
              <button
                onClick={disconnect}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
              >
                <Unlink size={14} /> Disconnect
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!needsToken && <button onClick={onClose} className="rounded-xl px-3 py-2 text-[13px] text-ink hover:bg-raised">Done</button>}
            <button
              ref={testRef}
              onClick={test}
              disabled={testing || saving || (needsToken && !token.trim() && !app.settings.tokenConfigured)}
              className="inline-flex items-center gap-2 rounded-xl bg-raised px-4 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-raised-hover disabled:opacity-50"
            >
              {testing && <Loader2 size={14} className="animate-spin" />}
              Test connection
            </button>
            <button
              onClick={save}
              disabled={saving || !hasChanges}
              title={result?.state === "ready" ? undefined : "You can save without testing, but test first to be sure it works."}
              className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white shadow-sm transition-all hover:brightness-110 disabled:opacity-50"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              Save
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
