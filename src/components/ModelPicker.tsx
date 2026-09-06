// Compact model picker: providers live on a Cloud/Local rail. Ready engines
// show a short suggested list with search and an explicit all-models view;
// engines that need setup show one focused action instead of a disabled wall.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, RefreshCw, Search } from "lucide-react";
import { useStore, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import { filterCustomModels, partitionCustomModels, suggestedModels } from "@/lib/custom-models";
import { isCustomOnly, splitEngineRail } from "@/lib/engine-rail";
import { ProviderMark } from "./ProviderIcons";
import { EngineSetup, EngineUpdateNotice, needsCli, needsSignIn } from "./EngineSetup";
import { EngineGroupLabel } from "./EngineGroupLabel";
import { cn } from "@/lib/cn";
import { COMPACT_SQUARE } from "@/lib/compact-chip";

type ModelOption = InstanceInfo["models"]["options"][number];
const COMPACT_MODEL_COUNT = 5;

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((option) => option.id === model)?.label ?? model;
}

function modelProvider(instance: InstanceInfo | undefined, model: string): string | undefined {
  return instance?.models.options.find((option) => option.id === model)?.provider;
}

export function engineStatus(instance: InstanceInfo): string {
  if (needsCli(instance)) return "Setup required";
  if (needsSignIn(instance)) return "Sign-in required";
  return instance.snapshot.version ?? "Ready";
}

function ModelRow({
  option,
  current,
  defaultId,
  onPick,
}: {
  option: ModelOption;
  current: boolean;
  defaultId: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-control/60",
        current && "bg-control",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate">{option.label}</span>
        {option.provider && (
          <span
            className="shrink-0 rounded bg-inset px-1.5 py-px text-[10px] text-ink-secondary"
            title={`Provider: ${option.provider}`}
          >
            {option.provider}
          </span>
        )}
        {option.id === defaultId && (
          <span className="shrink-0 rounded bg-inset px-1.5 py-px text-[10px] text-ink-secondary">Default</span>
        )}
        {option.loaded && (
          <span className="shrink-0 rounded bg-accent/10 px-1.5 py-px text-[10px] text-accent">Loaded</span>
        )}
      </span>
      {current && <Check size={14} className="shrink-0 text-accent" />}
    </button>
  );
}

function ModelSearch({
  value,
  onChange,
  onEscape,
  local,
}: {
  value: string;
  onChange: (value: string) => void;
  onEscape: () => void;
  local: boolean;
}) {
  return (
    <div className="shrink-0 px-2 pb-2">
      <div className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 focus-within:border-accent/60">
        <Search size={13} className="shrink-0 text-ink-secondary" />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            onEscape();
          }}
          placeholder="Search models"
          aria-label={local ? "Search local models" : "Search models"}
          className="w-full bg-transparent text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
      </div>
    </div>
  );
}

export function ModelPicker({
  bot,
  className,
  contained = false,
  label,
}: {
  bot: Bot;
  className?: string;
  /** Expand the menu in-flow under the trigger so it cannot overflow a
   * narrow parent (the Agent profile sidebar). */
  contained?: boolean;
  label?: ReactNode;
}) {
  const { state, dispatch, refreshInstances, refreshModels: refreshInstanceModels } = useStore();
  const [open, setOpen] = useState(false);
  const [railId, setRailId] = useState<string | null>(null);
  const [pane, setPane] = useState<"main" | "custom">("main");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const refreshingRef = useRef(false);

  const selection = bot.modelSelection;
  const active = state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const railInstance =
    state.instances.find((instance) => instance.instanceId === (railId ?? selection.instanceId)) ?? state.instances[0];

  const refreshLocalInstances = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    void refreshInstances()
      .catch(() => {
        // Keep the last known catalog when the app is temporarily offline.
      })
      .finally(() => {
        refreshingRef.current = false;
        setRefreshing(false);
      });
  }, [refreshInstances]);

  const refreshModels = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const instanceId = railId ?? selection.instanceId;
    void refreshInstances()
      .then(() => refreshInstanceModels(instanceId))
      .catch(() => {
        // Keep the last known catalog when the app is temporarily offline.
      })
      .finally(() => {
        refreshingRef.current = false;
        setRefreshing(false);
      });
  }, [railId, refreshInstanceModels, refreshInstances, selection.instanceId]);

  useEffect(() => {
    if (open) refreshLocalInstances();
  }, [open, refreshLocalInstances]);

  useEffect(() => {
    if (bot.busy) setOpen(false);
  }, [bot.busy]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const clickedNode = event.target instanceof Node ? event.target : null;
      if (!rootRef.current?.contains(clickedNode)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (query) setQuery("");
      else if (pane === "custom" && railInstance?.models.options.some((option) => !option.custom)) setPane("main");
      else setOpen(false);
    };
    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, pane, query, railInstance]);

  const resetList = () => {
    setQuery("");
    setShowAll(false);
  };

  const openFor = (instance: InstanceInfo | undefined) => {
    const official = instance?.models.options.filter((option) => !option.custom) ?? [];
    const selectedIsCustom = instance?.models.options.some(
      (option) => option.id === selection.model && option.custom,
    );
    setPane(selectedIsCustom || isCustomOnly(instance) || official.length === 0 ? "custom" : "main");
    resetList();
  };

  const selectRail = (instance: InstanceInfo) => {
    setRailId(instance.instanceId);
    const official = instance.models.options.filter((option) => !option.custom);
    setPane(isCustomOnly(instance) || official.length === 0 ? "custom" : "main");
    resetList();
  };

  const pick = (instance: InstanceInfo, model: string) => {
    if (bot.busy) return;
    const sameInstance = instance.instanceId === selection.instanceId;
    const nextSelection: ModelSelection = {
      instanceId: instance.instanceId,
      model,
    };
    if (sameInstance && selection.effort) nextSelection.effort = selection.effort;
    dispatch({
      type: "setModel",
      botId: bot.id,
      selection: nextSelection,
    });
    setOpen(false);
  };

  const official = railInstance?.models.options.filter((option) => !option.custom) ?? [];
  const custom = railInstance?.models.options.filter((option) => option.custom) ?? [];
  const currentModel = selection.instanceId === railInstance?.instanceId ? selection.model : undefined;
  const filteredOfficial = filterCustomModels(official, query);
  const compactOfficial = railInstance
    ? suggestedModels(official, railInstance.models.default, currentModel, COMPACT_MODEL_COUNT)
    : [];
  const shownOfficial = query ? filteredOfficial : showAll ? official : compactOfficial;
  const filteredCustom = filterCustomModels(custom, query);
  const { pinned, rest } = partitionCustomModels(filteredCustom);
  const blocked = railInstance
    ? pane === "custom"
      ? needsCli(railInstance)
      : needsCli(railInstance) || needsSignIn(railInstance)
    : false;
  const canOpenCustom = Boolean(railInstance && !needsCli(railInstance));
  const canReturnToOfficial = official.length > 0 && !isCustomOnly(railInstance);

  const renderRow = (option: ModelOption) => (
    <ModelRow
      key={option.id}
      option={option}
      current={selection.instanceId === railInstance?.instanceId && selection.model === option.id}
      defaultId={railInstance?.models.default ?? ""}
      onPick={() => railInstance && pick(railInstance, option.id)}
    />
  );

  const trigger = (
    <button
      type="button"
      disabled={Boolean(bot.busy)}
      onClick={() => {
        if (bot.busy) return;
        setRailId(selection.instanceId);
        setOpen((wasOpen) => {
          const next = !wasOpen;
          if (next) openFor(state.instances.find((instance) => instance.instanceId === selection.instanceId));
          return next;
        });
      }}
      aria-expanded={open && !bot.busy}
      aria-haspopup="dialog"
      className={cn(
        "flex items-center gap-1.5 rounded-full border border-hairline/40 bg-control/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-control/60",
        // in a narrow chat header fold to a rounded square with just the
        // provider mark; the model name rides the tooltip (a bot with no
        // resolved engine keeps its label — the mark is what would hide it)
        !contained && active && COMPACT_SQUARE,
      )}
      title={
        bot.busy
          ? "Stop this bot's turn before changing its model"
          : active
          ? `${active.displayName} · ${modelLabel(active, selection.model)}${
              modelProvider(active, selection.model) ? ` · ${modelProvider(active, selection.model)}` : ""
            }`
          : selection.model
      }
    >
      {active && <ProviderMark driverKind={active.driverKind} size={14} />}
      <span className={cn("max-w-[160px] truncate", !contained && active && "@max-4xl/chathead:hidden")}>
        {modelLabel(active, selection.model)}
        {active && modelProvider(active, selection.model) && (
          <span className="text-ink-secondary"> · {modelProvider(active, selection.model)}</span>
        )}
      </span>
      <ChevronDown
        size={14}
        className={cn(
          "text-ink-secondary transition-transform",
          open && "rotate-180",
          !contained && active && "@max-4xl/chathead:hidden",
        )}
      />
    </button>
  );

  return (
    <div ref={rootRef} className={cn(contained ? "w-full" : "relative", className)}>
      {contained ? (
        <div className="flex items-center justify-between gap-4">
          {label}
          {trigger}
        </div>
      ) : (
        trigger
      )}

      {open && !bot.busy && (
        <div
          data-model-picker-content
          role="dialog"
          aria-label="Choose model"
          className={cn(
            "flex overflow-hidden rounded-2xl border border-hairline/50 bg-card",
            contained
              ? "relative mt-3 w-full max-h-[min(420px,50dvh)]"
              : "absolute right-0 top-full z-30 mt-2 w-[380px] max-h-[min(480px,calc(100dvh-7rem))] shadow-2xl shadow-black/50",
          )}
        >
          <div className="flex w-14 shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline/40 bg-panel p-2">
            {(() => {
              const { subscription, custom: local } = splitEngineRail(state.instances);
              const railButton = (instance: InstanceInfo) => {
                const selected = instance.instanceId === railInstance?.instanceId;
                const attention = needsCli(instance) || needsSignIn(instance) || Boolean(instance.snapshot.update);
                return (
                  <button
                    type="button"
                    key={instance.instanceId}
                    onClick={() => selectRail(instance)}
                    aria-label={instance.displayName}
                    aria-pressed={selected}
                    title={`${instance.displayName} · ${engineStatus(instance)}`}
                    className={cn(
                      "relative flex size-9 items-center justify-center rounded-lg",
                      selected ? "bg-control ring-1 ring-hairline/50" : "hover:bg-control/60",
                    )}
                  >
                    <ProviderMark driverKind={instance.driverKind} size={18} />
                    {attention && (
                      <span className="absolute bottom-0.5 right-0.5 size-1.5 rounded-full bg-warning ring-2 ring-panel" />
                    )}
                  </button>
                );
              };
              return (
                <>
                  {subscription.length > 0 && (
                    <EngineGroupLabel className="px-0 pb-0.5 pt-0.5 text-center text-[9px]">Cloud</EngineGroupLabel>
                  )}
                  {subscription.map(railButton)}
                  {local.length > 0 && (
                    <EngineGroupLabel className="px-0 pb-0.5 pt-2 text-center text-[9px]">Local</EngineGroupLabel>
                  )}
                  {local.map(railButton)}
                </>
              );
            })()}
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {railInstance ? (
              <>
                <div className="shrink-0 px-4 pb-2 pt-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-[14px] font-semibold text-ink">{railInstance.displayName}</div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        data-model-refresh
                        disabled={refreshing}
                        onClick={refreshModels}
                        aria-label={
                          refreshing
                            ? `Refreshing ${railInstance.displayName} models`
                            : `Refresh ${railInstance.displayName} models`
                        }
                        title="Refresh models"
                        className="flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink disabled:cursor-wait disabled:opacity-70"
                      >
                        {refreshing ? (
                          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                        ) : (
                          <RefreshCw size={12} aria-hidden="true" />
                        )}
                      </button>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                          blocked ? "bg-warning/10 text-warning" : "bg-success/10 text-success",
                        )}
                      >
                        {pane === "custom" && !blocked ? "Local models" : engineStatus(railInstance)}
                      </span>
                    </div>
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                    {pane === "custom"
                      ? "Run this agent with a model already on your machine."
                      : "Choose a model for this bot."}
                  </div>
                </div>

                {pane === "custom" && canReturnToOfficial && (
                  <button
                    type="button"
                    onClick={() => {
                      setPane("main");
                      resetList();
                    }}
                    className="mx-2 mb-1 flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12px] text-ink-secondary hover:bg-control/60"
                  >
                    <ChevronLeft size={13} /> Back to {railInstance.displayName} models
                  </button>
                )}

                {blocked ? (
                  <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
                    <EngineSetup instance={railInstance} intent={pane === "custom" ? "inject" : "cloud"} />
                    <p className="mt-2 text-center text-[11.5px] text-ink-secondary/70">
                      {pane === "main" && official.length > 0
                        ? `${official.length} ${official.length === 1 ? "model" : "models"} will appear after setup.`
                        : "Local models will appear as soon as the agent is installed."}
                    </p>
                  </div>
                ) : (
                  <>
                    {((pane === "main" && official.length > COMPACT_MODEL_COUNT) ||
                      (pane === "custom" && custom.length > COMPACT_MODEL_COUNT)) && (
                      <ModelSearch
                        value={query}
                        local={pane === "custom"}
                        onChange={(value) => {
                          setQuery(value);
                          if (value) setShowAll(true);
                        }}
                        onEscape={() => {
                          if (query) setQuery("");
                          else if (pane === "custom" && canReturnToOfficial) setPane("main");
                        }}
                      />
                    )}

                    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                      {pane === "main" ? (
                        <>
                          {railInstance.snapshot.update && (
                            <EngineUpdateNotice update={railInstance.snapshot.update} className="mx-1 mb-2" />
                          )}
                          <EngineGroupLabel className="px-2 pb-1 pt-0.5">
                            {query ? `${filteredOfficial.length} results` : showAll ? `All models · ${official.length}` : "Suggested"}
                          </EngineGroupLabel>
                          {shownOfficial.map(renderRow)}
                          {shownOfficial.length === 0 && (
                            <div className="px-2 py-5 text-center text-[12.5px] text-ink-secondary">
                              Nothing matches “{query.trim()}”
                            </div>
                          )}
                          {!query && !showAll && official.length > compactOfficial.length && (
                            <button
                              type="button"
                              onClick={() => setShowAll(true)}
                              className="mt-1 flex w-full items-center justify-between rounded-lg border-t border-hairline/40 px-2.5 py-2 text-[12.5px] font-medium text-ink-secondary hover:bg-control/60 hover:text-ink"
                            >
                              Show all {official.length} models <ChevronDown size={13} />
                            </button>
                          )}
                          {!query && showAll && official.length > COMPACT_MODEL_COUNT && (
                            <button
                              type="button"
                              onClick={() => setShowAll(false)}
                              className="mt-1 w-full rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-control/60 hover:text-ink"
                            >
                              Show suggested only
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          {pinned.length > 0 && (
                            <EngineGroupLabel className="px-2 pb-1 pt-0.5">Loaded now</EngineGroupLabel>
                          )}
                          {pinned.map(renderRow)}
                          {pinned.length > 0 && rest.length > 0 && (
                            <div className="mx-2 my-2 border-t border-hairline/40" role="separator" />
                          )}
                          {rest.map(renderRow)}
                          {custom.length === 0 && (
                            <div className="mx-1 rounded-xl border border-dashed border-hairline/50 px-3 py-5 text-center">
                              <div className="text-[12.5px] font-medium text-ink">No local models found</div>
                              <div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
                                Start oMLX, Ollama, Unsloth, LM Studio, or EXO, then reopen this picker.
                              </div>
                            </div>
                          )}
                          {custom.length > 0 && filteredCustom.length === 0 && (
                            <div className="px-2 py-5 text-center text-[12.5px] text-ink-secondary">
                              Nothing matches “{query.trim()}”
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}

                {pane === "main" && (
                  <button
                    type="button"
                    aria-label={
                      custom.length > 0 ? `Use a local model (${custom.length} available)` : "Use a local model"
                    }
                    disabled={!canOpenCustom}
                    onClick={() => {
                      setPane("custom");
                      resetList();
                    }}
                    className="flex w-full shrink-0 items-center justify-between gap-2 border-t border-hairline/40 px-4 py-3 text-left text-[12.5px] font-medium text-ink hover:bg-control/60 disabled:cursor-not-allowed disabled:text-ink-secondary/40 disabled:hover:bg-transparent"
                  >
                    <span>Use a local model</span>
                    <span className="flex items-center gap-2">
                      {custom.length > 0 && (
                        <span className="rounded-full bg-inset px-2 py-0.5 text-[10.5px] text-ink-secondary">
                          {custom.length} available
                        </span>
                      )}
                      <ChevronRight size={14} className="text-ink-secondary" />
                    </span>
                  </button>
                )}
              </>
            ) : (
              <div className="px-4 py-5 text-[13px] text-ink-secondary">No model providers are available.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
