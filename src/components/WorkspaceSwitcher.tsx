import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2, Menu, Plus, Settings, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

type SavedEnvironment = {
  id: string;
  kind?: "local" | "remote";
  name: string;
  dataDir?: string;
  missing?: boolean;
  color?: string;
};

type EnvironmentsState = {
  activeId: string;
  environments: SavedEnvironment[];
  packaged?: boolean;
};

type WebEnvironment = {
  environmentId: string;
  label: string;
  platform?: string;
  capabilities?: Record<string, unknown>;
};

const basename = (p: string) => p.split(/[\\/]/).pop() ?? "";

const SWITCHER_BUTTON =
  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus";

const ITEM =
  "flex w-full items-center gap-3 px-3 py-2 text-[13px] text-ink hover:bg-raised hover:text-ink";

export function WorkspaceSwitcher() {
  const { dispatch } = useStore();
  const bridge = window.ogb?.environments;
  const [envs, setEnvs] = useState<EnvironmentsState | null>(null);
  const [webEnv, setWebEnv] = useState<WebEnvironment | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [forgetId, setForgetId] = useState<string | null>(null);
  const [purge, setPurge] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (bridge) {
      const current = ++generation.current;
      void bridge.state().then((state: EnvironmentsState) => {
        if (generation.current === current) setEnvs(state);
      }).catch(() => { if (generation.current === current) setError("Could not load workspaces."); });
      return;
    }
    void fetch("/.well-known/openmausbot/environment")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => { if (data && typeof data === "object" && "label" in data) setWebEnv(data as WebEnvironment); })
      .catch(() => {});
  }, [bridge]);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, []);

  const packaged = envs?.packaged === true;
  const namedLocals = (envs?.environments.filter((e) => e.kind === "local") ?? []);
  const locals = bridge ? [
    { id: "local", kind: "local" as const, name: t("workspaceSwitcher.thisComputer"), dataDir: undefined },
    ...namedLocals,
  ] : namedLocals;
  const active = envs ? locals.find((e) => e.id === envs.activeId) : null;
  const isWeb = !bridge;

  const switchTo = useCallback(async (id: string) => {
    if (!bridge || busy) return;
    const target = locals.find((e) => e.id === id);
    if (!target) return;
    if (!(await window.ogb?.confirm?.(t("workspaceSwitcher.switchConfirm", { name: target.name })) ?? window.confirm(`Switch to ${target.name}?`))) return;
    setBusy(true); setError("");
    try {
      const result = await bridge.switch(id);
      if (result && typeof result === "object" && "ok" in result && result.ok === false) throw new Error(t("workspaceSwitcher.switchError"));
      setOpen(false);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }, [bridge, busy, locals]);

  const forget = useCallback(async () => {
    if (!bridge || !forgetId) return;
    setBusy(true); setError("");
    try {
      const result = await bridge.forget(forgetId, purge === true);
      if (result && typeof result === "object" && "ok" in result && result.ok === false) throw new Error(t("workspaceSwitcher.forgetError"));
      setForgetId(null);
      setOpen(false);
      const state = await bridge.state();
      setEnvs(state as EnvironmentsState);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }, [bridge, forgetId, purge]);

  const createWorkspace = useCallback(async () => {
    if (!bridge || creating || !newName.trim()) return;
    setBusy(true); setError("");
    try {
      const created = await bridge.create(newName.trim());
      if (!created || typeof created !== "object" || !(created as { ok?: boolean }).ok) throw new Error(t("workspaceSwitcher.createError"));
      setCreating(false); setNewName("");
      setOpen(false);
      const state = await bridge.state();
      setEnvs(state as EnvironmentsState);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }, [bridge, creating, newName]);

  const openSettings = () => {
    setOpen(false);
    dispatch({ type: "toggleAppSettings", open: true, section: "desktopWorkspaces" });
  };

  const openInDesktop = () => {
    setOpen(false);
    window.location.href = "openmausbot://desktop";
  };

  const currentName = active?.name ?? webEnv?.label ?? t("workspaceSwitcher.thisComputer");
  const hasEnv = Boolean(bridge || webEnv);

  if (!hasEnv) return null;

  return (
    <div className="relative inline-block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(SWITCHER_BUTTON, busy && "opacity-70 cursor-not-allowed")}
        disabled={busy}
      >
        {busy && <Loader2 size={14} className="animate-spin shrink-0" />}
        {!busy && <Menu size={15} strokeWidth={1.75} aria-hidden="true" />}
        <span className="shrink-0 truncate max-w-[140px] text-[12px] font-medium text-ink">
          {currentName}
        </span>
      </button>
      {open && (
        <div ref={menuRef} className={cn("absolute z-50 mt-2 w-80 rounded-lg border border-hairline bg-card shadow-lg", open ? "" : "hidden")}
          onMouseDown={(event) => event.stopPropagation()}>
          <div className="px-3 py-2 border-b border-hairline/40">
            <div className="text-[11px] font-semibold text-ink-secondary uppercase tracking-wider">{t("workspaceSwitcher.title")}</div>
            <div className="text-[12px] text-ink-secondary">{t("workspaceSwitcher.subtitle")}</div>
          </div>
          <div className="py-1">
            {locals.map((entry) => {
              const isActive = entry.id === envs?.activeId;
              const isDefault = entry.id === "local";
              return (
                <div key={entry.id} className="flex w-full items-center justify-between gap-3 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => switchTo(entry.id)}
                    disabled={busy || isActive}
                    className={cn("flex w-full items-center gap-3 px-0 py-0 text-[13px] hover:bg-raised hover:text-ink", isActive ? "bg-raised" : "", (busy || isActive) && "opacity-50 cursor-not-allowed")}
                  >
                    <span className="shrink-0 w-5 text-ink-secondary">
                      {isActive ? <Check size={13} /> : entry.missing === true ? <Trash2 size={13} strokeWidth={1.5} /> : <div className="w-3 h-3 rounded-full border border-ink/20" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={cn("text-[13px]", isActive ? "font-medium text-ink" : "text-ink-secondary")}>{entry.name}</div>
                      {isDefault ? <div className="text-[11px] truncate text-ink-tertiary">{t("workspaceSwitcher.defaultFolder")}</div> : <div className="text-[11px] truncate text-ink-tertiary">{entry.dataDir ?? t("workspaceSwitcher.defaultFolder")}</div>}
                    </div>
                    {isActive && <span className="shrink-0 text-[11px] text-ink-secondary">{t("workspaceSwitcher.current")}</span>}
                  </button>
                  {!isDefault && !isActive && !busy && (
                    <button
                      type="button"
                      aria-label={t("workspaceSwitcher.forgetEntry", { name: entry.name })}
                      onClick={() => { setForgetId(entry.id); setPurge(false); }}
                      className="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-danger"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              );
            })}
            {isWeb && webEnv && (
              <button
                role="menuitem"
                type="button"
                disabled={busy}
                className={cn(ITEM, "opacity-60 cursor-not-allowed")}
              >
                <span className="shrink-0 w-5 text-ink-secondary">
                  <div className="w-3 h-3 rounded-full border border-ink/20" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-ink-secondary">{webEnv.label}</div>
                  <div className="text-[11px] truncate text-ink-tertiary">{t("workspaceSwitcher.webMode")}</div>
                </div>
              </button>
            )}
          </div>
          <div className="border-t border-hairline/40 py-2 px-3">
            {bridge && (
              <>
                {packaged && (
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => { setCreating(true); }}
                    disabled={busy}
                    className={cn(ITEM, busy && "opacity-50 cursor-not-allowed")}
                  >
                    <Plus size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                    <span>{t("workspaceSwitcher.newWorkspace")}</span>
                  </button>
                )}
                <div className="mt-2 px-2">
                  <button
                    type="button"
                    onClick={openSettings}
                    disabled={busy}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-ink-secondary hover:bg-raised disabled:opacity-50"
                  >
                    <Settings size={13} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                    <span>{t("workspaceSwitcher.manage")}</span>
                  </button>
                </div>
              </>
            )}
            {isWeb && (
              <div className="mt-2 px-2">
                <button
                  type="button"
                  onClick={openInDesktop}
                  disabled={busy}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-ink-secondary hover:bg-raised disabled:opacity-50"
                >
                  <ExternalLink size={13} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                  <span>{t("workspaceSwitcher.openInDesktop")}</span>
                </button>
              </div>
            )}
          </div>
          {error && <div className="px-3 py-2 text-[12px] text-danger">{error}</div>}
          {creating && (
            <div className="border-t border-hairline/40 p-3">
              <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
                {t("workspaceSwitcher.name")}
                <input
                  autoFocus
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  disabled={busy || !creating}
                  maxLength={60}
                  placeholder={t("workspaceSwitcher.envPlaceholder")}
                  className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/50"
                />
              </label>
              <div className="mt-2 pt-2 text-[11px] text-ink-tertiary">
                {t("workspaceSwitcher.desktopOnly")}
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy || !newName.trim()}
                  onClick={createWorkspace}
                  className="flex-1 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-50"
                >
                  {busy && <Loader2 size={13} className="animate-spin shrink-0" />}
                  {!busy && t("workspaceSwitcher.create")}
                </button>
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className="flex-1 rounded-lg border border-hairline px-3 py-2 text-[13px] text-ink hover:bg-raised"
                >
                  {t("workspaceSwitcher.cancel")}
                </button>
              </div>
            </div>
          )}
          {forgetId && (
            <div className="border-t border-hairline/40 p-3">
              <p className="text-[12px] text-ink-secondary leading-relaxed">
                {t("workspaceSwitcher.forgetConfirm", { name: locals.find((e) => e.id === forgetId)?.name ?? "" })}
              </p>
              {(() => {
                const target = locals.find((e) => e.id === forgetId);
                const purgeable = Boolean(target?.dataDir && basename(target.dataDir).startsWith(".openmausbot"));
                return (
                  <label className="flex items-start gap-2 mt-2 text-[12px] text-ink-secondary">
                    <input type="checkbox" checked={purge} onChange={(event) => setPurge(event.target.checked)} className="mt-0.5" disabled={!purgeable} />
                    {t("workspaceSwitcher.forgetPurge", { path: target?.dataDir ?? "" })}
                  </label>
                );
              })()}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={forget}
                  className="flex-1 rounded-lg bg-danger px-3 py-2 text-[13px] font-medium text-danger-ink disabled:opacity-50"
                >
                  {t("workspaceSwitcher.forget")}
                </button>
                <button
                  type="button"
                  onClick={() => setForgetId(null)}
                  className="flex-1 rounded-lg border border-hairline px-3 py-2 text-[13px] text-ink hover:bg-raised"
                >
                  {t("workspaceSwitcher.cancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
