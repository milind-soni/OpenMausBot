import { usageView } from "@/lib/usage";
// Model picker: an instance rail + model list, backed by /api/instances.
// Routing is by exact instanceId only — an entry is never inferred from a
// driver kind, and unavailable instances render disabled with the reason.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import { api, useStore, type Bot, type InstanceInfo } from "@/state/store";
import { ProviderMark } from "./ProviderIcons";
import { cn } from "@/lib/cn";

function modelLabel(instance: InstanceInfo | undefined, model: string, savedLabel?: string): string {
  return instance?.models.options.find((o) => o.id === model)?.label ?? savedLabel ?? model;
}

export function ModelPicker({
  bot,
  className,
  compact = false,
  iconOnly = false,
}: {
  bot: Bot;
  className?: string;
  compact?: boolean;
  iconOnly?: boolean;
}) {
  const { state, dispatch } = useStore();
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupError, setBackupError] = useState("");
  const [open, setOpen] = useState(false);
  const [railId, setRailId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [popupCoords, setPopupCoords] = useState<{ top: number; right: number } | null>(null);
  const [backupCoords, setBackupCoords] = useState<{ top: number; right: number } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const backupTriggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const backupPopupRef = useRef<HTMLDivElement>(null);

  const working = bot.busy || state.groups.some((g) => g.busyBotId === bot.id);
  const selection = bot.usingBackup && bot.backupModelSelection ? bot.backupModelSelection : bot.modelSelection;
  const active = state.instances.find((i) => i.instanceId === selection.instanceId);
  const railInstance =
    state.instances.find((i) => i.instanceId === (railId ?? selection.instanceId)) ??
    state.instances[0];
  const retired = active?.models.status === "ready" && !active.models.options.some((o) => o.id === selection.model);

  const refresh = () => {
    setRefreshing(true);
    api("/api/instances?refresh=1")
      .then(({ instances }) => dispatch({ type: "instances", instances }))
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };

  const updatePopupCoords = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPopupCoords({
        top: rect.bottom + 8,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    }
  };

  const updateBackupCoords = () => {
    if (backupTriggerRef.current) {
      const rect = backupTriggerRef.current.getBoundingClientRect();
      setBackupCoords({
        top: rect.bottom + 6,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    }
  };

  useEffect(() => {
    if (!open && !backupOpen) return;

    if (open) updatePopupCoords();
    if (backupOpen) updateBackupCoords();

    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      const insideRoot = rootRef.current?.contains(target);
      const insidePopup = popupRef.current?.contains(target);
      const insideBackup = backupPopupRef.current?.contains(target);

      if (!insideRoot && !insidePopup && !insideBackup) {
        setOpen(false);
        setBackupOpen(false);
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
        if (backupOpen) {
          e.preventDefault();
          e.stopPropagation();
          setBackupOpen(false);
          backupTriggerRef.current?.focus();
        }
      }
    };

    const onScrollOrResize = () => {
      if (open) updatePopupCoords();
      if (backupOpen) updateBackupCoords();
    };

    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);

    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, backupOpen]);

  const pick = (instance: InstanceInfo, model: string) => {
    dispatch({
      type: "setModel",
      botId: bot.id,
      selection: {
        instanceId: instance.instanceId,
        model,
        label: instance.models.options.find((o) => o.id === model)?.label,
      },
    });
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div ref={rootRef} className={cn("relative inline-flex items-center", className)}>
      {bot.usingBackup && bot.backupModelSelection && (
        <div className="mb-1 text-[11px] text-warning">
          <button
            ref={backupTriggerRef}
            type="button"
            aria-expanded={backupOpen}
            onClick={() => {
              updateBackupCoords();
              setBackupOpen(!backupOpen);
              setOpen(false);
            }}
          >
            Using backup ▾
          </button>
          {backupOpen &&
            backupCoords &&
            typeof document !== "undefined" &&
            createPortal(
              <div
                ref={backupPopupRef}
                style={{
                  position: "fixed",
                  top: `${backupCoords.top}px`,
                  right: `${backupCoords.right}px`,
                  zIndex: 50,
                }}
                className="w-[260px] space-y-2 rounded-xl border border-hairline/40 bg-card p-3 text-ink shadow-2xl"
              >
                <p>Currently using {selection.label ?? selection.model}.</p>
                <button
                  disabled={working}
                  className="block w-full rounded-lg bg-raised px-3 py-2 text-left disabled:opacity-40"
                  onClick={() => {
                    void api(`/api/bots/${bot.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({
                        modelSelection: bot.backupModelSelection,
                        backupModelSelection: null,
                        onUsageLimit: "wait",
                      }),
                    })
                      .then(({ bot: saved }) => {
                        dispatch({ type: "botPatched", bot: saved });
                        setBackupOpen(false);
                        backupTriggerRef.current?.focus();
                      })
                      .catch(() => setBackupError("Couldn’t keep this model. Wait for the Buddy to finish and try again."));
                  }}
                >
                  Keep this model
                </button>
                <button
                  disabled={working}
                  className="block w-full rounded-lg border border-hairline/50 px-3 py-2 text-left text-ink-secondary hover:text-ink disabled:opacity-40"
                  onClick={() => {
                    void api(`/api/bots/${bot.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ modelSelection: bot.modelSelection }),
                    })
                      .then(({ bot: saved }) => {
                        dispatch({ type: "botPatched", bot: saved });
                        setBackupOpen(false);
                        backupTriggerRef.current?.focus();
                      })
                      .catch(() => setBackupError("Couldn’t switch back. Wait for the Buddy to finish and try again."));
                  }}
                >
                  Switch back now
                </button>
                <p className="text-[11px] text-ink-secondary">
                  The main model will be used for a new request after its usage is reported as available.
                </p>
                {usageView(state.usage.find((u) => u.instanceId === bot.modelSelection.instanceId)).tone === "unknown" && (
                  <p className="text-[11px] text-ink-secondary">
                    The main model’s usage is not known yet. You can choose it manually when you are ready.
                  </p>
                )}
                {backupError && <p role="alert" className="text-danger">{backupError}</p>}
              </div>,
              document.body,
            )}
        </div>
      )}
      <button
        ref={triggerRef}
        disabled={working}
        onClick={() => {
          setRailId(selection.instanceId);
          updatePopupCoords();
          setOpen((o) => !o);
          if (!open) refresh();
        }}
        className={cn(
          "flex shrink-0 items-center rounded-full border border-hairline/40 bg-raised/60 text-[13px] text-ink hover:bg-raised transition-colors",
          iconOnly ? "p-1.5" : "gap-1.5 py-1 pl-2 pr-2.5",
        )}
        title={active ? `${active.displayName} · ${modelLabel(active, selection.model, selection.label)}` : selection.model}
        aria-label={active ? `Model: ${modelLabel(active, selection.model, selection.label)}` : `Model: ${selection.model}`}
      >
        {active && <ProviderMark driverKind={active.driverKind} size={14} className="shrink-0" />}
        {!iconOnly && (
          <span
            className={cn(
              "truncate",
              compact
                ? "max-w-[45px]"
                : "max-w-[70px] min-[1600px]:max-w-[140px]",
            )}
          >
            {modelLabel(active, selection.model, selection.label)}
            {retired ? " (retired)" : ""}
          </span>
        )}
        <ChevronDown size={iconOnly ? 10 : 14} className="text-ink-secondary shrink-0" />
      </button>

      {open &&
        popupCoords &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popupRef}
            data-model-picker-content
            style={{
              position: "fixed",
              top: `${popupCoords.top}px`,
              right: `${popupCoords.right}px`,
              zIndex: 50,
            }}
            className="flex w-[320px] overflow-hidden rounded-xl border border-hairline/50 bg-card shadow-2xl shadow-black/50"
          >
            {/* instance rail */}
            <div className="flex flex-col gap-1 border-r border-hairline/40 bg-panel p-2">
              {state.instances.map((instance) => {
                const unavailable = instance.snapshot.state !== "available";
                const onRail = instance.instanceId === railInstance?.instanceId;
                return (
                  <button
                    key={instance.instanceId}
                    onClick={() => setRailId(instance.instanceId)}
                    title={
                      unavailable
                        ? `${instance.displayName} — ${instance.snapshot.reason ?? "unavailable"}`
                        : instance.displayName
                    }
                    className={cn(
                      "flex size-9 items-center justify-center rounded-lg",
                      onRail ? "bg-raised" : "hover:bg-raised/60",
                      unavailable && "opacity-40",
                    )}
                  >
                    <ProviderMark driverKind={instance.driverKind} size={18} />
                  </button>
                );
              })}
            </div>

            {/* model list for the rail-selected instance */}
            <div className="min-w-0 flex-1 p-2">
              {railInstance ? (
                <>
                  <div className="flex items-start justify-between gap-2 px-2 pb-1 pt-1">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-ink">{railInstance.displayName}</div>
                      <div className="truncate text-[11px] text-ink-secondary">
                        {railInstance.snapshot.state === "available"
                          ? (railInstance.snapshot.version ?? "ready")
                          : (railInstance.snapshot.reason ?? "unavailable")}
                      </div>
                    </div>
                    <button
                      onClick={refresh}
                      disabled={refreshing}
                      title="Refresh models"
                      className="rounded p-1 text-ink-secondary hover:bg-raised disabled:opacity-50"
                    >
                      <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
                    </button>
                  </div>
                  {railInstance.models.status !== "ready" && (
                    <div className="px-2 py-1 text-[11px] text-warning">
                      {railInstance.models.status === "stale"
                        ? "Last known models; refresh failed"
                        : railInstance.models.status === "unverified"
                          ? "Provider model list unavailable"
                          : (railInstance.models.error ?? "Model list unavailable")}
                    </div>
                  )}
                  {selection.instanceId === railInstance.instanceId && retired && (
                    <div className="px-2 py-1 text-[11px] text-warning">Selected model is no longer offered. Choose another.</div>
                  )}
                  {railInstance.models.options.map((option) => {
                    const current =
                      selection.instanceId === railInstance.instanceId && selection.model === option.id;
                    const disabled = railInstance.snapshot.state !== "available";
                    return (
                      <button
                        key={option.id}
                        disabled={disabled}
                        onClick={() => pick(railInstance, option.id)}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]",
                          disabled ? "cursor-not-allowed text-ink-secondary/50" : "text-ink hover:bg-raised/60",
                          current && "bg-raised",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate">{option.label}</span>
                          {option.id === railInstance.models.default && (
                            <span className="shrink-0 rounded bg-inset px-1 py-px text-[10px] text-ink-secondary">
                              default
                            </span>
                          )}
                        </span>
                        {current && <Check size={14} className="shrink-0 text-accent" />}
                      </button>
                    );
                  })}
                </>
              ) : (
                <div className="px-2 py-3 text-[13px] text-ink-secondary">
                  No providers — is the server running?
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
