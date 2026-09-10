// Compact model picker: providers live on a Cloud/Local rail. Ready engines
// show a short suggested list with search and an explicit all-models view;
// engines that need setup show one focused action instead of a disabled wall.
// Reasoning effort rides along (EffortRow): model and effort are one choice to
// the person making it, so the chat header and the settings dialog render the
// same row and write through the same action.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, RefreshCw, Search } from "lucide-react";
import { useStore, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import type { EffortLevel } from "../../server/contracts.ts";
import { filterCustomModels, partitionCustomModels, suggestedModels } from "@/lib/custom-models";
import { isCustomOnly, splitEngineRail } from "@/lib/engine-rail";
import { ProviderMark } from "./ProviderIcons";
import { EngineSetup, EngineUpdateNotice, needsCli, needsSignIn } from "./EngineSetup";
import { EngineGroupLabel } from "./EngineGroupLabel";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
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
  if (needsCli(instance)) return t("model.setupRequired");
  if (needsSignIn(instance)) return t("model.signInRequired");
  return instance.snapshot.version ?? t("model.ready");
}

/** The others capitalize cleanly; "xhigh" would read "Xhigh". */
export function effortLabel(level: EffortLevel): string {
  return level === "xhigh" ? "X-High" : level[0].toUpperCase() + level.slice(1);
}

/** How hard the bot thinks, for the engine it currently runs on. Rendered
 * both in the picker's popover and in the settings dialog's Model section so
 * the two cannot drift: one list of levels, one `setModel` dispatch.
 *
 * `undefined` ("Default") is not the `none` level — Default sends nothing and
 * lets the engine decide, `none` is a level the engine is told to use. Only
 * pi offers both, and dropping either would change what an existing bot
 * sends, so both stay and the tooltips say which is which. */
export function EffortRow({
  bot,
  threadId,
  className,
  label,
}: {
  bot: Bot;
  threadId?: string;
  className?: string;
  label?: ReactNode;
}) {
  const { state, dispatch } = useStore();
  const selection = bot.modelSelection;
  const levels = state.instances.find((instance) => instance.instanceId === selection.instanceId)?.capabilities
    ?.effortLevels;
  // An engine with no levels gets no control at all, not an empty one.
  if (!levels?.length) return null;

  return (
    <div className={className}>
      {label}
      {/* wraps rather than dividing a fixed width: pi offers Default plus six
          levels, which a segmented control would squeeze in the popover */}
      <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label={t("modelPicker.effortAria")}>
        {[undefined, ...levels].map((level) => (
          <button
            key={level ?? "default"}
            type="button"
            aria-pressed={selection.effort === level}
            title={
              level === undefined
                ? t("modelPicker.noEffort")
                : t("modelPicker.askFor", { level: effortLabel(level) })
            }
            onClick={() => dispatch({ type: "setModel", botId: bot.id, threadId, selection: { ...selection, effort: level } })}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
              selection.effort === level
                ? "border-accent/60 bg-control text-ink"
                : "border-hairline/40 text-ink-secondary hover:bg-control/60 hover:text-ink",
            )}
          >
            {level === undefined ? t("modelPicker.default") : effortLabel(level)}
          </button>
        ))}
      </div>
    </div>
  );
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
            title={t("model.provider", { name: option.provider })}
          >
            {option.provider}
          </span>
        )}
        {option.id === defaultId && (
          <span className="shrink-0 rounded bg-inset px-1.5 py-px text-[10px] text-ink-secondary">{t("modelPicker.default")}</span>
        )}
        {option.loaded && (
          <span className="shrink-0 rounded bg-accent/10 px-1.5 py-px text-[10px] text-accent">{t("model.loadedChip")}</span>
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
          placeholder={t("model.search")}
          aria-label={local ? t("model.searchLocal") : t("model.search")}
          className="w-full bg-transparent text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
      </div>
    </div>
  );
}

export function ModelEngineRail({ instances, selectedInstance, claudeInstance, onSelect }: {
  instances: InstanceInfo[];
  selectedInstance?: InstanceInfo;
  claudeInstance?: InstanceInfo;
  onSelect: (instance: InstanceInfo) => void;
}) {
  const firstClaude = instances.find((instance) => instance.driverKind === "claudeAgent" && instance.claudeAccount?.isDefault)
    ?? instances.find((instance) => instance.driverKind === "claudeAgent");
  const providers = instances.filter((instance) => instance.driverKind !== "claudeAgent" || instance === firstClaude);
  const { subscription, custom: local } = splitEngineRail(providers);
  const railButton = (instance: InstanceInfo) => {
    const claude = instance.driverKind === "claudeAgent";
    const target = claude ? claudeInstance ?? instance : instance;
    const selected = claude ? selectedInstance?.driverKind === "claudeAgent" : instance.instanceId === selectedInstance?.instanceId;
    const label = claude ? "Claude" : instance.displayName;
    const attention = needsCli(target) || needsSignIn(target) || Boolean(target.snapshot.update);
    return (
      <button
        type="button"
        key={instance.instanceId}
        onClick={() => onSelect(target)}
        aria-label={label}
        aria-pressed={selected}
        title={`${label} · ${engineStatus(target)}`}
        className={cn("relative flex size-9 items-center justify-center rounded-lg", selected ? "bg-control ring-1 ring-hairline/50" : "hover:bg-control/60")}
      >
        <ProviderMark driverKind={instance.driverKind} size={18} />
        {attention && <span className="absolute bottom-0.5 right-0.5 size-1.5 rounded-full bg-warning ring-2 ring-panel" />}
      </button>
    );
  };
  return (
    <div className="flex w-14 shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline/40 bg-panel p-2">
      {subscription.length > 0 && <EngineGroupLabel className="px-0 pb-0.5 pt-0.5 text-center text-[9px]">Cloud</EngineGroupLabel>}
      {subscription.map(railButton)}
      {local.length > 0 && <EngineGroupLabel className="px-0 pb-0.5 pt-2 text-center text-[9px]">Local</EngineGroupLabel>}
      {local.map(railButton)}
    </div>
  );
}

export function ClaudeAccountSelect({ accounts, selectedId, onSelect }: {
  accounts: InstanceInfo[];
  selectedId: string;
  onSelect: (instance: InstanceInfo) => void;
}) {
  return (
    <label className="mt-2 flex min-w-0 items-center gap-2 text-[12px] text-ink-secondary">
      <span>{t("model.account")}:</span>
      <select
        aria-label={t("model.account")}
        value={selectedId}
        onChange={(event) => {
          const account = accounts.find((instance) => instance.instanceId === event.target.value);
          if (account) onSelect(account);
        }}
        className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[12px] text-ink focus:border-accent/60 focus:outline-none"
      >
        {accounts.map((account) => <option key={account.instanceId} value={account.instanceId}>{account.displayName}</option>)}
      </select>
    </label>
  );
}

export function ModelPicker({
  bot,
  threadId,
  className,
  contained = false,
  label,
}: {
  bot: Bot;
  threadId?: string;
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
  const lastClaudeIdRef = useRef<string | null>(null);

  const selection = bot.modelSelection;
  const active = state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const claudeAccounts = state.instances.filter((instance) => instance.driverKind === "claudeAgent");
  const multipleClaudeAccounts = claudeAccounts.length > 1;
  const showActiveAccount = multipleClaudeAccounts && active?.driverKind === "claudeAgent";
  const claudeRailInstance = claudeAccounts.find((instance) => instance.instanceId === lastClaudeIdRef.current)
    ?? (active?.driverKind === "claudeAgent" ? active : claudeAccounts[0]);
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
    if (instance.driverKind === "claudeAgent") lastClaudeIdRef.current = instance.instanceId;
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
      threadId,
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
        if (active?.driverKind === "claudeAgent") lastClaudeIdRef.current = active.instanceId;
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
        // resolved engine keeps its label — the mark is what would hide it).
        // Multiple Claude accounts keep their name even in the compact chip.
        !contained && active && !showActiveAccount && COMPACT_SQUARE,
      )}
      title={
        bot.busy
          ? t(threadId ? "model.threadBusy" : "model.busy")
          : active
          ? `${active.displayName} · ${modelLabel(active, selection.model)}${
              modelProvider(active, selection.model) ? ` · ${modelProvider(active, selection.model)}` : ""
            }${selection.effort ? ` · ${effortLabel(selection.effort)} effort` : ""}`
          : selection.model
      }
    >
      {active && <ProviderMark driverKind={active.driverKind} size={14} />}
      {!contained && showActiveAccount && (
        <span data-model-account-compact className="hidden max-w-20 truncate @max-4xl/chathead:inline">{active.displayName}</span>
      )}
      <span className={cn("flex min-w-0 items-center gap-1", !contained && active && "@max-4xl/chathead:hidden")}>
        <span className="max-w-[160px] truncate">
          {showActiveAccount && (
            <span data-model-account className="text-ink-secondary">{active.displayName} · </span>
          )}
          {modelLabel(active, selection.model)}
          {active && modelProvider(active, selection.model) && (
            <span className="text-ink-secondary"> · {modelProvider(active, selection.model)}</span>
          )}
        </span>
        {/* outside the truncating span: a long model name must not be what
            hides the effort the header exists to surface */}
        {selection.effort && (
          <span data-model-effort className="shrink-0 text-ink-secondary">
            · {effortLabel(selection.effort)}
          </span>
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
          aria-label={t("model.choose")}
          className={cn(
            "flex overflow-hidden rounded-2xl border border-hairline/50 bg-card",
            contained
              ? "relative mt-3 w-full max-h-[min(420px,50dvh)]"
              : "absolute right-0 top-full z-30 mt-2 w-[380px] max-w-[calc(100vw-2rem)] max-h-[min(480px,calc(100dvh-7rem))] shadow-2xl shadow-black/50",
          )}
        >
          <ModelEngineRail instances={state.instances} selectedInstance={railInstance} claudeInstance={claudeRailInstance} onSelect={selectRail} />

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {railInstance ? (
              <>
                <div className="shrink-0 px-4 pb-2 pt-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-[14px] font-semibold text-ink">{railInstance.driverKind === "claudeAgent" ? "Claude" : railInstance.displayName}</div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        data-model-refresh
                        disabled={refreshing}
                        onClick={refreshModels}
                        aria-label={
                          refreshing
                            ? t("model.refreshing", { name: railInstance.displayName })
                            : t("model.refresh", { name: railInstance.displayName })
                        }
                        title={t("model.refreshTitle")}
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
                        {pane === "custom" && !blocked ? t("model.localModels") : engineStatus(railInstance)}
                      </span>
                    </div>
                  </div>
                  {railInstance.driverKind === "claudeAgent" && (
                    <ClaudeAccountSelect accounts={claudeAccounts} selectedId={railInstance.instanceId} onSelect={selectRail} />
                  )}
                  {railInstance.snapshot.authenticated && railInstance.snapshot.account && (
                    <p className="mt-1 break-words text-[11px] text-ink-secondary">
                      {[railInstance.snapshot.account.email, railInstance.snapshot.account.organization].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                    {pane === "custom" ? t("model.localHint") : t(threadId ? "model.chooseThreadHint" : "model.chooseHint")}
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
                    <ChevronLeft size={13} /> {t("model.backTo", { name: railInstance.displayName })}
                  </button>
                )}

                {blocked ? (
                  <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
                    <EngineSetup instance={railInstance} intent={pane === "custom" ? "inject" : "cloud"} />
                    {railInstance.claudeAccount && needsSignIn(railInstance) && pane !== "custom" && (
                      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
                        {railInstance.claudeAccount.signInShell === "powershell" && `${t("engines.account.powershell")} `}
                        {t("engines.account.signInHint")}
                      </p>
                    )}
                    <p className="mt-2 text-center text-[11.5px] text-ink-secondary/70">
                      {pane === "main" && official.length > 0
                        ? official.length === 1
                          ? t("model.afterSetupOne")
                          : t("model.afterSetupMany", { count: official.length })
                        : t("model.localSoon")}
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
                            <EngineUpdateNotice update={railInstance.snapshot.update} instance={railInstance} className="mx-1 mb-2" />
                          )}
                          <EngineGroupLabel className="px-2 pb-1 pt-0.5">
                            {query
                              ? t("model.results", { count: filteredOfficial.length })
                              : showAll
                                ? t("model.allModels", { count: official.length })
                                : t("model.suggested")}
                          </EngineGroupLabel>
                          {shownOfficial.map(renderRow)}
                          {shownOfficial.length === 0 && (
                            <div className="px-2 py-5 text-center text-[12.5px] text-ink-secondary">
                              {t("model.noMatch", { query: query.trim() })}
                            </div>
                          )}
                          {!query && !showAll && official.length > compactOfficial.length && (
                            <button
                              type="button"
                              onClick={() => setShowAll(true)}
                              className="mt-1 flex w-full items-center justify-between rounded-lg border-t border-hairline/40 px-2.5 py-2 text-[12.5px] font-medium text-ink-secondary hover:bg-control/60 hover:text-ink"
                            >
                              {t("model.showAll", { count: official.length })} <ChevronDown size={13} />
                            </button>
                          )}
                          {!query && showAll && official.length > COMPACT_MODEL_COUNT && (
                            <button
                              type="button"
                              onClick={() => setShowAll(false)}
                              className="mt-1 w-full rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-control/60 hover:text-ink"
                            >
                              {t("model.showSuggested")}
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          {pinned.length > 0 && (
                            <EngineGroupLabel className="px-2 pb-1 pt-0.5">{t("model.loadedNow")}</EngineGroupLabel>
                          )}
                          {pinned.map(renderRow)}
                          {pinned.length > 0 && rest.length > 0 && (
                            <div className="mx-2 my-2 border-t border-hairline/40" role="separator" />
                          )}
                          {rest.map(renderRow)}
                          {custom.length === 0 && (
                            <div className="mx-1 rounded-xl border border-dashed border-hairline/50 px-3 py-5 text-center">
                              <div className="text-[12.5px] font-medium text-ink">{t("model.noLocal")}</div>
                              <div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
                                {t("model.noLocalHint")}
                              </div>
                            </div>
                          )}
                          {custom.length > 0 && filteredCustom.length === 0 && (
                            <div className="px-2 py-5 text-center text-[12.5px] text-ink-secondary">
                              {t("model.noMatch", { query: query.trim() })}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}

                {/* The header has nowhere else to put effort, so the popover
                    carries it. `contained` callers (the settings dialog) render
                    their own EffortRow card, and two copies of one control in
                    one view read as a bug. Reads the bot's active engine, not
                    the rail being browsed: effort applies to the model this bot
                    runs on now, and picking a model on another rail closes the
                    popover. */}
                {!contained && (
                  <EffortRow
                    bot={bot}
                    threadId={threadId}
                    className="shrink-0 border-t border-hairline/40 px-4 py-3"
                    label={<span className="text-[12.5px] font-medium text-ink">{t("botSettings.model.effort")}</span>}
                  />
                )}

                {pane === "main" && (
                  <button
                    type="button"
                    aria-label={
                      custom.length > 0
                        ? t("model.useLocalCount", { count: custom.length })
                        : t("model.useLocal")
                    }
                    disabled={!canOpenCustom}
                    onClick={() => {
                      setPane("custom");
                      resetList();
                    }}
                    className="flex w-full shrink-0 items-center justify-between gap-2 border-t border-hairline/40 px-4 py-3 text-left text-[12.5px] font-medium text-ink hover:bg-control/60 disabled:cursor-not-allowed disabled:text-ink-secondary/40 disabled:hover:bg-transparent"
                  >
                    <span>{t("model.useLocal")}</span>
                    <span className="flex items-center gap-2">
                      {custom.length > 0 && (
                        <span className="rounded-full bg-inset px-2 py-0.5 text-[10.5px] text-ink-secondary">
                          {t("model.available", { count: custom.length })}
                        </span>
                      )}
                      <ChevronRight size={14} className="text-ink-secondary" />
                    </span>
                  </button>
                )}
              </>
            ) : (
              <div className="px-4 py-5 text-[13px] text-ink-secondary">{t("model.noProviders")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
