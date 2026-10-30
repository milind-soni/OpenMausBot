import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, KeyRound, Loader2, RefreshCw, X } from "lucide-react";
import { useStore, currentTaskBot, type AppState, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";
import type { ModelVariantOption } from "../../shared/runtime-events";
import { filterCustomModels, partitionCustomModels, suggestedModels } from "@/lib/custom-models";
import { configuredModelInstances, isClaudeAccount, isCustomOnly, SIGN_IN_FAMILY_LABEL, signInFamily } from "@/lib/engine-rail";
import { modelName, simpleModelMenu } from "@/lib/simple-model-menu";
import { choiceIsSelected, modelChoices, modelSelectionForPick, type ModelChoice } from "@/lib/model-choices";
export { modelSelectionForPick } from "@/lib/model-choices";
import { pickerPlacement, type PickerPlacement } from "@/lib/picker-placement";
import type { Typeahead } from "@/lib/menu-keys";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { InstanceProviderMark } from "./ProviderIcons";
import { ELEVATED_FLOAT, ELEVATED_HOVER } from "./elevated";
import { ApiKeyHint, EngineSetup, EngineUpdateNotice, needsCli, needsSignIn, openKeysFor } from "./EngineSetup";
import { offersLocalModels, probeLocalModels } from "./local-model-probe";
import { ConfirmDialog } from "./ConfirmDialog";
import { ChatGptPlanStatus } from "./ChatGptPlanStatus";
import { approvalModeFor, modelSwitchNeedsAsk } from "../../shared/approval-mode";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { SimpleModelMenu, type SimpleThinking } from "./SimpleModelMenu";
import { apiKeysLabel, ClaudeAccountSelect, engineStatus, FollowBotModelRow, ModelEngineRail, ModelRow, ModelSearch } from "./ModelPickerFull";
import { MENU_LABEL, MENU_LINE, MENU_ROW, MENU_SEPARATOR, MENU_STROKE, MENU_TRAILING } from "./menu-recipe";
import { modelMenuKey, modelMenuPointerMove } from "./model-menu-keys";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";

import { t } from "@/lib/i18n";
import { COMPACT_SQUARE } from "@/lib/compact-chip";
import { useAiSwitch } from "@/lib/ai-switch";
import { usePickerPane } from "@/lib/model-picker-pane";
import { threadsOnOwnModel } from "../../shared/thread-model";
import { ThreadModelsLine } from "./ThreadModelsLine";
import { Select } from "./Select";

const COMPACT_MODEL_COUNT = 5;

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((option) => option.id === model)?.label ?? model;
}

function modelProvider(instance: InstanceInfo | undefined, model: string): string | undefined {
  return instance?.models.options.find((option) => option.id === model)?.provider;
}

export function effortLabel(level: EffortLevel): string {
  return t(`model.effort.${level}` as Parameters<typeof t>[0]);
}

/**
 * Default (undefined) sends nothing and lets the engine decide; `none` is a level the engine is told to use. Only pi
 * offers both.
 */
export function EffortRow({
  bot,
  threadId,
  updateBotDefault,
  className,
  label,
  compact = false,
}: {
  bot: Bot;
  threadId?: string;
  updateBotDefault?: boolean;
  className?: string;
  label?: ReactNode;
  compact?: boolean;
}) {
  const { state, dispatch } = useStore();
  const selection = bot.modelSelection;
  const instance = state.instances.find((candidate) => candidate.instanceId === selection.instanceId);
  if (instance?.capabilities?.modelVariants) {
    return <ModelVariantRow bot={bot} threadId={threadId} updateBotDefault={updateBotDefault} className={className} label={label} compact={compact} quiet={compact} />;
  }
  const levels = instance?.capabilities?.effortLevels;
  if (!levels?.length) return null;

  if (compact) return (
    <label className={cn("flex items-center justify-between gap-3", className)}>
      {label}
      <Select size="sm" variant="quiet" className="max-w-[65%]" aria-label={t("model.effort.label")} value={selection.effort ?? ""}
        onChange={(event) => dispatch({ type: "setModel", botId: bot.id, threadId, ...(updateBotDefault ? { updateBotDefault: true } : {}),
          selection: { ...selection, effort: levels.find((level) => level === event.target.value) } })}>
        <option value="">{t("model.effort.default")}</option>
        {levels.map((level) => <option key={level} value={level}>{effortLabel(level)}</option>)}
      </Select>
    </label>
  );

  return (
    <div className={className}>
      {label}
      <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label={t("model.effort.label")}>
        {[undefined, ...levels].map((level) => (
          <button
            key={level ?? "default"}
            type="button"
            aria-pressed={selection.effort === level}
            title={
              level === undefined
                ? t("model.effort.noLevel")
                : t("model.effort.ask", { level: effortLabel(level) })
            }
            onClick={() => dispatch({ type: "setModel", botId: bot.id, threadId, ...(updateBotDefault ? { updateBotDefault: true } : {}), selection: { ...selection, effort: level } })}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
              selection.effort === level
                ? "border-accent/60 bg-control text-ink"
                : "border-hairline/40 text-ink-secondary hover:bg-control/60 hover:text-ink",
            )}
          >
            {level === undefined ? t("model.effort.default") : effortLabel(level)}
          </button>
        ))}
      </div>
    </div>
  );
}

const variantLabel = (option: ModelVariantOption, driverKind?: string): string =>
  option.id === "default" && driverKind === "opencodeGo" ? t("model.variant.openCodeDefault") : option.label;

/** ACP variant ids are opaque; their model/session declares the available choices. */
function variantChoices(state: Pick<AppState, "instances" | "modelVariantSessions">, selection: ModelSelection, threadId: string | undefined) {
  const instance = state.instances.find((candidate) => candidate.instanceId === selection.instanceId);
  if (!instance?.capabilities?.modelVariants) return null;
  const session = threadId === undefined ? undefined : state.modelVariantSessions[threadId];
  const reported = session?.instanceId === selection.instanceId && session.model === selection.model ? session.variants : undefined;
  const options = reported?.options ?? instance.models.options.find((option) => option.id === selection.model)?.variants ?? [];
  if (!options.length && selection.variant === undefined) return null;
  return { instance, reported, options };
}

export function ModelVariantRow({ bot, threadId, updateBotDefault, className, label, compact = false, wide = false, quiet = false }: {
  bot: Bot;
  threadId?: string;
  updateBotDefault?: boolean;
  className?: string;
  label?: ReactNode;
  compact?: boolean;
  wide?: boolean;
  quiet?: boolean;
}) {
  const { state, dispatch } = useStore();
  const selection = bot.modelSelection;
  const choices = variantChoices(state, selection, threadId ?? bot.threadId);
  if (!choices) return null;
  const { instance, reported, options } = choices;
  const missing = selection.variant !== undefined && !options.some((option) => option.id === selection.variant);
  const unavailable = missing && reported !== undefined;
  const current = reported?.currentValue;
  const choose = (variant?: string) => {
    const { effort: _effort, variant: _variant, ...model } = selection;
    dispatch({ type: "setModel", botId: bot.id, threadId, ...(updateBotDefault ? { updateBotDefault: true } : {}),
      selection: { ...model, ...(variant !== undefined ? { variant } : {}) } });
  };
  if (compact) return (
    <div className={className}>
      <label className="flex items-center justify-between gap-3">
        {label}
        <Select size="sm" variant={quiet ? "quiet" : "field"} aria-label={t("model.variant.label")} disabled={bot.busy} className={wide ? "flex-1" : "max-w-[65%]"}
          value={selection.variant === undefined ? "unset" : missing ? "missing" : String(options.findIndex((option) => option.id === selection.variant))}
          onChange={(event) => choose(options[Number(event.target.value)]?.id)}>
          <option value="unset">{t("model.variant.session")}</option>
          {missing && <option value="missing" disabled>{selection.variant} ({unavailable ? t("model.variant.unavailable") : t("model.variant.unverified")})</option>}
          {options.map((option, index) => <option key={option.id} value={String(index)}>{variantLabel(option, instance.driverKind)}</option>)}
        </Select>
      </label>
      {missing && <p className={cn("mt-1 text-ink-secondary", quiet ? "text-[12px] leading-4 text-ink-tertiary" : "text-[11px]")}>{unavailable ? t("model.variant.unavailableHelp") : t("model.variant.unverifiedHelp")}</p>}
    </div>
  );
  return (
    <div className={className}>
      {label}
      {(selection.variant === undefined || missing) && (
        <p className="mt-2 text-[12px] text-ink-secondary">
          {unavailable ? t("model.variant.unavailableChoice", { variant: selection.variant ?? "" })
            : missing ? t("model.variant.unverifiedChoice", { variant: selection.variant ?? "" }) : t("model.variant.none")}
          {current !== undefined && ` ${t("model.variant.sessionValue", { variant: variantLabel(options.find((option) => option.id === current) ?? { id: current, label: current }, instance.driverKind) })}`}
        </p>
      )}
      {selection.variant !== undefined && (
        <button type="button" disabled={bot.busy} onClick={() => choose()}
          title={t("model.variant.clearHint")}
          className="mt-2 block text-[12px] text-ink-secondary underline underline-offset-2 hover:text-ink disabled:opacity-50">
          {t("model.variant.clear")}
        </button>
      )}
      {options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label={t("model.variant.label")}>
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={bot.busy}
              aria-pressed={selection.variant === option.id}
              title={t("model.variant.use", { variant: variantLabel(option, instance.driverKind) })}
              onClick={() => choose(option.id)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-50",
                selection.variant === option.id ? "border-accent/60 bg-control text-ink" : "border-hairline/40 text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {variantLabel(option, instance.driverKind)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const POPOVER_WIDTH = 420;
const POPOVER_HEIGHT = 600;
export const SIMPLE_POPOVER_WIDTH = 300;
const MENU_ITSELF = ":scope";

export function ModelPicker({
  bot: shown,
  threadId,
  className,
  contained = false,
  label,
  size = "md",
}: {
  bot: Bot;
  threadId?: string;
  className?: string;
  contained?: boolean;
  label?: ReactNode;
  size?: "sm" | "md";
}) {
  const { state, dispatch: storeDispatch, refreshInstances, refreshModels: refreshInstanceModels } = useStore();
  const [open, setOpen] = useState(false);
  const { bot, dispatch } = useAiSwitch({ bot: shown, threadId, contained, dispatch: storeDispatch, setOpen: (next) => (next ? openMenu() : setOpen(false)) });
  const motion = useMenuMotion(open && !bot.busy);
  const [railId, setRailId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [loadingInstances, setLoadingInstances] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [probing, setProbing] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [scope, setScope] = useState<"bot" | "thread">("thread");
  const advanced = useAdvancedMode();
  const ownerOrAdmin = useOwnerOrAdmin();
  // A guest changes only their own conversation's model, never the shared bot's default; thread-only until
  // authority loads.
  const simpleUpdatesBotDefault = ownerOrAdmin === true;
  const [fullView, setFullView] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<{ botId: string; threadId: string;
    selection: ModelSelection; updateBotDefault: boolean; name: string } | null>(null);
  const [placement, setPlacement] = useState<PickerPlacement | null>(null);
  const [changedBotModel, setChangedBotModel] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const refreshingRef = useRef(false);
  const lastClaudeIdRef = useRef<string | null>(null);
  const lastOpenaiIdRef = useRef<string | null>(null);
  const focusOnPlace = useRef<string | null>(null);
  const typed = useRef<Typeahead | null>(null);
  const menuId = useId();
  const inside = useRef({ contains: (target: unknown) => [rootRef.current, menuRef.current].some((node) => node?.contains(target as Node)) });

  const floating = typeof document !== "undefined";
  const simpleView = !advanced && !fullView;
  const popoverWidth = simpleView ? SIMPLE_POPOVER_WIDTH : POPOVER_WIDTH;
  useLayoutEffect(() => {
    if (!open) return;
    const place = (event?: Event) => {
      if (event?.type === "scroll" && event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      const anchor = triggerRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      setPlacement((locked) => pickerPlacement(anchor, { width: popoverWidth, height: menu.offsetHeight }, viewport, locked ?? undefined,
        simpleView ? undefined : POPOVER_HEIGHT));
    };
    const settled = (event: Event) => {
      if (event.target instanceof Node && triggerRef.current && event.target.contains(triggerRef.current)) place();
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("animationend", settled, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("animationend", settled, true);
    };
  }, [open, popoverWidth, simpleView]);

  useEffect(() => {
    if (!open || !placement || focusOnPlace.current === null) return;
    const menu = menuRef.current;
    const wanted = focusOnPlace.current;
    focusOnPlace.current = null;
    const find = (selector: string) => (selector ? menu?.querySelector<HTMLElement>(selector) : null);
    const target = wanted === MENU_ITSELF ? menu
      : find(wanted) ?? find("[data-menu-search]") ?? find("[data-current-model]") ?? find("[data-menu-row]:not(:disabled)") ?? menu;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
  }, [open, placement]);

  const selection = bot.modelSelection;
  const active = state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const pickerInstances = configuredModelInstances(state.instances, selection.instanceId);
  const selectedVariantLabel = selection.variant === undefined ? undefined : variantLabel(
    active?.models.options.find((option) => option.id === selection.model)?.variants?.find((option) => option.id === selection.variant)
      ?? { id: selection.variant, label: selection.variant },
    active?.driverKind,
  );
  const claudeAccounts = pickerInstances.filter(isClaudeAccount);
  const openaiAccounts = pickerInstances.filter((instance) => signInFamily(instance) === "openai");
  const openaiRailInstance = openaiAccounts.find((instance) => instance.instanceId === lastOpenaiIdRef.current)
    ?? openaiAccounts.find((instance) => instance.instanceId === selection.instanceId) ?? openaiAccounts[0];
  const multipleClaudeAccounts = state.instances.filter(isClaudeAccount).length > 1;
  const showActiveAccount = (multipleClaudeAccounts && isClaudeAccount(active)) || Boolean(active?.snapshot.chatgptPlan);
  const claudeRailInstance = claudeAccounts.find((instance) => instance.instanceId === lastClaudeIdRef.current)
    ?? claudeAccounts.find((instance) => instance.instanceId === selection.instanceId) ?? claudeAccounts[0];
  const railInstance =
    pickerInstances.find((instance) => instance.instanceId === (railId ?? selection.instanceId)) ?? pickerInstances[0];
  const displayedInstanceId = railInstance?.instanceId;
  // A plan account discovers its allowed models only after sign-in: an empty catalog must still lead to cloud sign-in,
  // never local models.
  const hasOfficialModels = Boolean(railInstance?.snapshot.chatgptPlan || railInstance?.models.options.some((option) => !option.custom));
  const customOnly = isCustomOnly(railInstance);
  const { pane, setPane, loading: loadingList } = usePickerPane({ instanceId: displayedInstanceId, railId, hasOfficialModels, customOnly,
    reading: open && (loadingInstances || refreshingId !== null),
    selectedIsCustom: Boolean(railInstance?.models.options.some((option) => option.id === selection.model && option.custom)) }, () => resetList());

  const refreshLocalInstances = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setLoadingInstances(true);
    void refreshInstances()
      .catch(() => {})
      .finally(() => {
        refreshingRef.current = false;
        setLoadingInstances(false);
      });
  }, [refreshInstances]);

  const refreshModels = (instanceId: string | undefined) => {
    if (refreshingRef.current || !instanceId) return;
    refreshingRef.current = true;
    setRefreshingId(instanceId);
    void refreshInstances()
      .then(() => refreshInstanceModels(instanceId))
      .catch(() => {})
      .finally(() => {
        refreshingRef.current = false;
        setRefreshingId(null);
      });
  };

  // An engine with no models listed yet is asked for them, so the picker can say it is loading them, then show them.
  useEffect(() => {
    if (open) (hasOfficialModels || customOnly ? refreshLocalInstances : () => refreshModels(displayedInstanceId))();
  }, [open, refreshLocalInstances]);

  useEffect(() => {
    if (bot.busy) setOpen(false);
  }, [bot.busy]);

  usePopoverDismiss(open, inside, () => setOpen(false));

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  };

  const resetList = () => {
    setQuery("");
    setShowAll(false);
  };

  const openFor = (instance: InstanceInfo | undefined) => {
    const official = instance?.models.options.filter((option) => !option.custom) ?? [];
    const selectedIsCustom = instance?.models.options.some(
      (option) => option.id === selection.model && option.custom,
    );
    setPane(selectedIsCustom || isCustomOnly(instance) || (official.length === 0 && !instance?.snapshot.chatgptPlan) ? "custom" : "main");
    resetList();
  };

  const lookForLocal = (instance: InstanceInfo) => {
    if (needsCli(instance) || instance.policy || probing.has(instance.instanceId)) return;
    setProbing((current) => new Set(current).add(instance.instanceId));
    void probeLocalModels(instance.instanceId, refreshInstanceModels).then(() => setProbing((current) => {
      const next = new Set(current);
      next.delete(instance.instanceId);
      return next;
    }));
  };
  const lookForLocalIn = (instance: InstanceInfo) => {
    if (offersLocalModels(instance, instance.models.options.filter((option) => option.custom).length)) lookForLocal(instance);
  };

  const openLocalModels = (instance: InstanceInfo) => {
    setPane("custom");
    resetList();
    lookForLocal(instance);
  };

  const openApiKeys = () => {
    close(false);
    dispatch(openKeysFor(railInstance));
  };
  const openEngines = () => {
    close(false);
    dispatch({ type: "toggleAppSettings", open: true, section: "engines" });
  };

  const selectRail = (instance: InstanceInfo) => {
    if (isClaudeAccount(instance)) lastClaudeIdRef.current = instance.instanceId;
    if (signInFamily(instance) === "openai") lastOpenaiIdRef.current = instance.instanceId;
    setRailId(instance.instanceId);
    const official = instance.models.options.filter((option) => !option.custom);
    setPane(isCustomOnly(instance) || (official.length === 0 && !instance.snapshot.chatgptPlan) ? "custom" : "main");
    resetList();
  };

  const openMenu = () => {
    if (bot.busy) return;
    if (active && isClaudeAccount(active)) lastClaudeIdRef.current = active.instanceId;
    if (active && signInFamily(active) === "openai") lastOpenaiIdRef.current = active.instanceId;
    const initial = pickerInstances.find((instance) => instance.instanceId === selection.instanceId) ?? pickerInstances[0];
    setRailId(initial?.instanceId ?? null);
    setChangedBotModel(false);
    setFullView(false);
    setExpanded(new Set());
    setPlacement(null);
    openFor(initial);
    focusOnPlace.current = "";
    setOpen(true);
  };

  const openFull = (instance: InstanceInfo, keyboard: boolean) => {
    selectRail(instance);
    setScope(simpleUpdatesBotDefault ? "bot" : "thread");
    focusOnPlace.current = keyboard ? "[data-model-back]" : MENU_ITSELF;
    setFullView(true);
  };
  const backToList = (keyboard: boolean) => {
    focusOnPlace.current = keyboard && railInstance ? `[data-simple-provider="${railInstance.instanceId.replace(/["\\]/g, "\\$&")}"] [data-menu-row]` : MENU_ITSELF;
    resetList();
    setFullView(false);
  };

  const profile = state.bots.find((candidate) => candidate.id === bot.id) ?? bot;
  const follows = threadId ? profile.tasks?.find((task) => task.threadId === threadId)?.followsBotModel : undefined;
  const botModelInstance = state.instances.find((instance) => instance.instanceId === profile.modelSelection.instanceId);
  const botModelName = botModelInstance
    ? `${botModelInstance.displayName} · ${modelLabel(botModelInstance, profile.modelSelection.model)}`
    : profile.modelSelection.model;
  const ownModelThreads = threadsOnOwnModel(profile.modelSelection, profile.tasks ?? []).length;

  const pickBotModel = () => {
    if (bot.busy) return;
    if (follows !== false) {
      close(true);
      return;
    }
    const target = currentTaskBot(profile, threadId ?? bot.threadId);
    if (modelSwitchNeedsAsk(approvalModeFor(target),
      state.instances.find((candidate) => candidate.instanceId === target.modelSelection.instanceId)?.driverKind,
      botModelInstance?.driverKind)) {
      close(false);
      setPendingSwitch({ botId: bot.id, threadId: threadId ?? bot.threadId, selection: profile.modelSelection, updateBotDefault: false, name: botModelName });
      return;
    }
    close(true);
    dispatch({ type: "setModel", botId: bot.id, threadId: threadId ?? bot.threadId, updateBotDefault: false, selection: profile.modelSelection });
  };

  const pick = (instance: InstanceInfo, model: string, variant?: string) => {
    if (bot.busy || instance.policy) return;
    const nextSelection = modelSelectionForPick(selection, instance, model);
    if (variant !== undefined) nextSelection.variant = variant;
    const updateBotDefault = !threadId || (simpleView ? simpleUpdatesBotDefault : scope === "bot");
    const targets = updateBotDefault ? [currentTaskBot(profile, threadId ?? bot.threadId), profile] : [bot];
    if (targets.some((target) => modelSwitchNeedsAsk(approvalModeFor(target),
      state.instances.find((candidate) => candidate.instanceId === target.modelSelection.instanceId)?.driverKind,
      instance.driverKind))) {
      setPendingSwitch({ botId: bot.id, threadId: threadId ?? bot.threadId,
        selection: nextSelection, updateBotDefault, name: modelLabel(instance, model) });
      close(false);
      return;
    }
    dispatch({
      type: "setModel",
      botId: bot.id,
      threadId: threadId ?? bot.threadId,
      updateBotDefault,
      selection: nextSelection,
    });
    if (updateBotDefault && threadId) setChangedBotModel(true);
    close(true);
  };

  const resetVariant = contained && selection.variant !== undefined ? () => {
    const { variant: _variant, ...nextSelection } = selection;
    dispatch({ type: "setModel", botId: bot.id, threadId: threadId ?? bot.threadId, updateBotDefault: !threadId || simpleUpdatesBotDefault, selection: nextSelection });
    close(true);
  } : undefined;

  const official = railInstance ? modelChoices(railInstance, railInstance.models.options.filter((option) => !option.custom)) : [];
  const custom = railInstance?.models.options.filter((option) => option.custom) ?? [];
  const currentModel = selection.instanceId === railInstance?.instanceId
    ? official.find((option) => choiceIsSelected(option, selection))?.id : undefined;
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
  const lookingForLocal = Boolean(railInstance && probing.has(railInstance.instanceId));
  const lookingForLocalStatus = (
    <div role="status" className={cn(MENU_LINE, "justify-center text-ink-tertiary")}>
      <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden="true" />
      {t("model.lookingLocal")}
    </div>
  );
  const remote = window.ogb?.remoteClient?.active === true;

  const levels = active?.capabilities?.effortLevels ?? [];
  const writeEffort = (effort: EffortLevel | undefined) => {
    const { effort: _effort, ...model } = selection;
    dispatch({ type: "setModel", botId: bot.id, threadId, ...(threadId && simpleUpdatesBotDefault ? { updateBotDefault: true } : {}),
      selection: effort ? { ...model, effort } : model });
  };
  const thinking: SimpleThinking | null = contained ? null
    : variantChoices(state, selection, threadId ?? bot.threadId) ? {
      variants: (
        <ModelVariantRow compact quiet bot={shown} threadId={threadId} updateBotDefault={Boolean(threadId) && simpleUpdatesBotDefault} className="px-2 py-1"
          label={<span className="shrink-0 text-[12px] font-medium leading-4 text-ink-tertiary">{t("botSettings.simple.thinking")}</span>} />
      ),
    }
    : levels.length > 0 && !shown.busy ? { levels, current: selection.effort, onPick: writeEffort, onReset: () => writeEffort(undefined) }
    : null;

  const botModelSelection = follows !== undefined && profile.modelSelection.instanceId === railInstance?.instanceId
    ? profile.modelSelection : undefined;
  const renderRow = (option: ModelChoice) => (
    <ModelRow
      key={option.id}
      option={option}
      current={selection.instanceId === railInstance?.instanceId && choiceIsSelected(option, selection)}
      defaultId={railInstance?.models.default ?? ""}
      botModel={botModelSelection ? choiceIsSelected(option, botModelSelection) : false}
      onPick={() => railInstance && pick(railInstance, option.nativeModel ?? option.id, option.variant)}
    />
  );

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.defaultPrevented || !(event.target instanceof HTMLElement)) return;
    if (event.key !== "Escape") return modelMenuKey(event, { query, typed, close: () => close(true) });
    event.preventDefault();
    event.stopPropagation();
    if (query) setQuery("");
    else if (!simpleView && pane === "custom" && canReturnToOfficial) setPane("main");
    else if (fullView && !advanced) backToList(true);
    else close(true);
  };

  const currentOption = active?.models.options.find((option) => option.id === selection.model);
  const attention = !active ? undefined
    : active.policy ? t("policy.managedBy", { organization: active.policy.organizationName })
      : needsCli(active) ? t("model.setupRequired")
        : needsSignIn(active) && !isCustomOnly(active) && !currentOption?.custom ? t("model.signInRequired") : undefined;
  const summary = active
    ? `${active.displayName} · ${modelLabel(active, selection.model)}${
        modelProvider(active, selection.model) ? ` · ${modelProvider(active, selection.model)}` : ""
      }${selectedVariantLabel ? ` · ${selectedVariantLabel}` : selection.effort
        ? ` · ${t(advanced ? "model.effort.summary" : "model.simple.thinkingSummary", { level: effortLabel(selection.effort) })}` : ""}`
    : selection.model;
  const followLine = follows === true ? `\n${t("model.followsBot", { name: profile.name })}` : follows === false ? `\n${t("model.ownModel")}` : "";
  const attentionLine = !advanced && attention ? `\n${attention}` : "";
  const busyLine = bot.busy ? `\n${t(threadId ? "model.threadBusy" : "model.busy")}` : "";

  const triggerProps = {
    ref: triggerRef,
    "data-tour": "model",
    type: "button" as const,
    disabled: Boolean(bot.busy),
    onClick: () => (open ? close(false) : openMenu()),
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        close(false);
      } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open) {
        event.preventDefault();
        openMenu();
      }
    },
    "aria-expanded": open && !bot.busy,
    "aria-haspopup": "dialog" as const,
    "aria-controls": open ? menuId : undefined,
    title: `${summary}${followLine}${attentionLine}${busyLine}`,
  };

  const trigger = advanced ? (
    <button
      {...triggerProps}
      className={cn(
        "group flex items-center gap-1.5 rounded-full py-1 pl-2 pr-2.5 text-[13px] text-ink disabled:cursor-not-allowed",
        contained
          ? "hover:bg-ink/[0.06] aria-expanded:bg-ink/[0.08] disabled:opacity-50 disabled:hover:bg-transparent"
          : cn(ELEVATED_FLOAT, ELEVATED_HOVER, "disabled:text-ink-tertiary disabled:hover:bg-composer"),
        !contained && active && !showActiveAccount && COMPACT_SQUARE,
      )}
    >
      {active && (contained
        ? <InstanceProviderMark instance={active} size={14} subtle />
        : <span className="flex shrink-0 group-disabled:opacity-50"><InstanceProviderMark instance={active} size={14} subtle /></span>)}
      {!contained && active && showActiveAccount && (
        <span data-model-account-compact className="hidden max-w-20 truncate @max-4xl/chathead:inline">{active.displayName}</span>
      )}
      <span className={cn("flex min-w-0 items-center gap-1", !contained && active && "@max-4xl/chathead:hidden")}>
        <span className="max-w-[160px] truncate">
          {active && showActiveAccount && (
            <span data-model-account className="text-ink-secondary">{active.displayName} · </span>
          )}
          {modelLabel(active, selection.model)}
          {active && modelProvider(active, selection.model) && (
            <span className="text-ink-secondary"> · {modelProvider(active, selection.model)}</span>
          )}
        </span>
        {selectedVariantLabel !== undefined ? (
          <span data-model-variant className="max-w-[120px] truncate text-ink-secondary">· {selectedVariantLabel}</span>
        ) : selection.effort && (
          <span data-model-effort className="shrink-0 text-ink-secondary">
            · {effortLabel(selection.effort)}
          </span>
        )}
      </span>
      <ChevronDown
        size={12}
        className={cn(
          "text-ink-tertiary transition-transform",
          open && "rotate-180",
          !contained && active && "@max-4xl/chathead:hidden",
        )}
      />
    </button>
  ) : (
    <button
      {...triggerProps}
      className={cn(
        "group flex items-center rounded-full text-[13px] leading-[18px] text-ink-secondary disabled:cursor-not-allowed disabled:text-ink-tertiary",
        contained
          ? "min-w-0 max-w-[58%] transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink aria-expanded:bg-ink/[0.08] aria-expanded:text-ink disabled:hover:bg-transparent"
          : cn("shrink-0", ELEVATED_FLOAT, ELEVATED_HOVER, "hover:text-ink aria-expanded:text-ink disabled:hover:bg-composer"),
        size === "sm" ? "h-7 pl-2 pr-1.5" : "h-8 pl-2.5 pr-2",
      )}
    >
      <span className="relative mr-1.5 flex shrink-0 group-disabled:opacity-50">
        {active
          ? <InstanceProviderMark instance={active} size={14} subtle />
          : <span className="size-3.5 rounded-full bg-ink/[0.08]" aria-hidden="true" />}
        {attention && <span data-model-attention className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-warning ring-[1.5px] ring-app" />}
      </span>
      <span className="min-w-0 max-w-[160px] truncate">{modelName(active, selection.model)}</span>
      <ChevronDown size={12} strokeWidth={2} aria-hidden="true" className="ml-1 shrink-0 text-ink-tertiary group-hover:text-ink-secondary" />
    </button>
  );

  const simpleMenu = simpleView ? simpleModelMenu({
    instances: state.instances,
    listed: pickerInstances,
    selection,
    bot: { name: profile.name, selection: profile.modelSelection, follows },
    query,
    expanded,
    probing,
    loading: loadingInstances,
    refreshing: refreshingId,
  }) : null;

  const fullPane = (
    <>
      {fullView && !advanced && (
        <div className="shrink-0 border-b-[0.5px] border-ink/10 p-1.5">
          <button type="button" data-menu-row data-model-back onClick={(event) => backToList(event.detail === 0)} className={cn(MENU_ROW, "text-ink-secondary hover:text-ink")}>
            <ChevronLeft size={16} strokeWidth={MENU_STROKE} className="shrink-0 rtl:-scale-x-100" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{t("model.simple.back")}</span>
          </button>
        </div>
      )}
      {follows !== undefined && (
        <FollowBotModelRow name={profile.name} model={botModelName} follows={follows} onPick={pickBotModel} />
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        {pickerInstances.length > 0 && <ModelEngineRail instances={pickerInstances} selectedInstance={railInstance} claudeInstance={claudeRailInstance} openaiInstance={openaiRailInstance} onSelect={selectRail}
          onAddApiKeys={remote ? undefined : openApiKeys} />}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {threadId && (
            <div className="shrink-0 border-b-[0.5px] border-ink/10 px-3.5 py-2">
              <div role="group" aria-label={t("model.scope.label")} className="flex gap-1">
                {(["thread", "bot"] as const).map((value) => (
                  <button key={value} type="button" aria-pressed={scope === value} onClick={() => setScope(value)}
                    className={cn("h-6 rounded-full px-2.5 text-[12px] leading-4",
                      scope === value ? "bg-ink/[0.08] font-medium text-ink" : "text-ink-secondary hover:bg-ink/[0.06] hover:text-ink")}>
                    {value === "bot" ? t("model.scope.bot") : t("model.scope.thread")}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[12px] leading-4 text-ink-tertiary">
                {scope === "bot" ? t("model.scope.botHelp") : t("model.scope.threadHelp")}
              </p>
            </div>
          )}
          {railInstance ? (
            <>
              <div className="shrink-0 px-3.5 pb-2 pt-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="truncate text-[14px] font-semibold leading-5 text-ink">{signInFamily(railInstance) ? SIGN_IN_FAMILY_LABEL[signInFamily(railInstance)!] : railInstance.displayName}</div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      data-model-refresh
                      disabled={loadingInstances || refreshingId !== null}
                      onClick={() => refreshModels(railInstance.instanceId)}
                      aria-label={
                        loadingInstances || refreshingId !== null
                          ? t("model.refreshing", { name: railInstance.displayName })
                          : t("model.refresh", { name: railInstance.displayName })
                      }
                      title={t("model.refreshTitle")}
                      className="flex size-7 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink disabled:cursor-wait"
                    >
                      {loadingInstances || refreshingId !== null ? (
                        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                      ) : (
                        <RefreshCw size={14} strokeWidth={MENU_STROKE} aria-hidden="true" />
                      )}
                    </button>
                    <span
                      className={cn(
                        "flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium leading-4",
                        blocked ? "bg-warning/10 text-warning" : "bg-success/10 text-success",
                      )}
                    >
                      {pane === "custom" && !blocked && railInstance.access !== "api" ? t("model.localModels") : engineStatus(railInstance)}
                    </span>
                  </div>
                </div>
                {isClaudeAccount(railInstance) && claudeAccounts.length > 1 && (
                  <ClaudeAccountSelect accounts={claudeAccounts} selectedId={railInstance.instanceId} onSelect={selectRail} />
                )}
                {signInFamily(railInstance) === "openai" && openaiAccounts.length > 1 && (
                  <ClaudeAccountSelect accounts={openaiAccounts} selectedId={railInstance.instanceId} onSelect={selectRail} />
                )}
                {railInstance.snapshot.authenticated && railInstance.snapshot.account && (
                  <p className="mt-1 truncate text-[12px] leading-4 text-ink-tertiary" title={[railInstance.snapshot.account.email, railInstance.snapshot.account.organization].filter(Boolean).join(" · ")}>
                    {[railInstance.snapshot.account.email, railInstance.snapshot.account.organization].filter(Boolean).join(" · ")}
                  </p>
                )}
                {railInstance.snapshot.chatgptPlan && railInstance.snapshot.authenticated && (
                  <ChatGptPlanStatus key={railInstance.instanceId} instanceId={railInstance.instanceId} />
                )}
                {railInstance.access === "api"
                  ? <ApiKeyHint instance={railInstance} />
                  : pane === "custom" && <div className="mt-0.5 text-[12px] leading-4 text-ink-tertiary">{t("model.localHint")}</div>}
              </div>

              {pane === "custom" && canReturnToOfficial && (
                <div className="shrink-0 px-1.5 pb-1">
                  <button
                    type="button"
                    data-menu-row
                    onClick={() => {
                      setPane("main");
                      resetList();
                    }}
                    className={cn(MENU_ROW, "text-ink-secondary hover:text-ink")}
                  >
                    <ChevronLeft size={16} strokeWidth={MENU_STROKE} className="shrink-0 rtl:-scale-x-100" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{t("model.backTo", { name: railInstance.displayName })}</span>
                  </button>
                </div>
              )}

              {railInstance.policy ? (
                <div data-policy-blocked className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-3 pt-1 text-[13px] leading-[18px] text-ink-secondary">
                  <p className="font-medium text-ink">{t("policy.managedBy", { organization: railInstance.policy.organizationName })}</p>
                  <p className="mt-1">{t("policy.modelBlocked", { organization: railInstance.policy.organizationName })}</p>
                </div>
              ) : blocked ? (
                <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1">
                  <EngineSetup instance={railInstance} intent={pane === "custom" ? "inject" : "cloud"} quiet={!advanced} />
                  {railInstance.claudeAccount && needsSignIn(railInstance) && pane !== "custom" && (
                    <p className="mt-2 px-1.5 text-[12px] leading-4 text-ink-tertiary">
                      {railInstance.claudeAccount.signInShell === "powershell" && `${t("engines.account.powershell")} `}
                      {t("engines.account.signInHint")}
                    </p>
                  )}
                  <p className="mt-2 text-center text-[12px] leading-4 text-ink-tertiary">
                    {railInstance.snapshot.chatgptPlan ? t("engineSetup.chatgpt.modelsAfterSignIn") : pane === "main" && official.length > 0
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
                    />
                  )}

                  <div data-model-list className="flex min-h-[min(180px,30dvh)] flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
                    {pane === "main" && loadingList ? (
                      <div role="status" className={cn(MENU_LINE, "justify-center text-ink-tertiary")}>
                        <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden="true" />
                        {t("model.loadingModels", { name: railInstance.displayName })}
                      </div>
                    ) : pane === "main" ? (
                      <>
                        {railInstance.snapshot.update && (
                          <EngineUpdateNotice update={railInstance.snapshot.update} instance={railInstance} className="mx-0.5 mb-1.5" />
                        )}
                        <div className={MENU_LABEL}>
                          {query
                            ? t("model.results", { count: filteredOfficial.length })
                            : showAll
                              ? t("model.allModels", { count: official.length })
                              : t("model.suggested")}
                        </div>
                        {shownOfficial.map(renderRow)}
                        {shownOfficial.length === 0 && (
                          <div className="px-2 py-5 text-center text-[13px] leading-[18px] text-ink-secondary">
                            {t("model.noMatch", { query: query.trim() })}
                          </div>
                        )}
                        {!query && !showAll && official.length > compactOfficial.length && (
                          <button type="button" data-menu-row onClick={() => setShowAll(true)} className={cn(MENU_ROW, "text-ink-secondary hover:text-ink")}>
                            <span className="min-w-0 flex-1 truncate">{t("model.showAll", { count: official.length })}</span>
                            <ChevronDown size={16} strokeWidth={MENU_STROKE} className={MENU_TRAILING} aria-hidden="true" />
                          </button>
                        )}
                        {!query && showAll && official.length > COMPACT_MODEL_COUNT && (
                          <button type="button" data-menu-row onClick={() => setShowAll(false)} className={cn(MENU_ROW, "text-ink-secondary hover:text-ink")}>
                            <span className="min-w-0 flex-1 truncate">{t("model.showSuggested")}</span>
                            <ChevronUp size={16} strokeWidth={MENU_STROKE} className={MENU_TRAILING} aria-hidden="true" />
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        {lookingForLocal && custom.length > 0 && lookingForLocalStatus}
                        {pinned.length > 0 && <div className={MENU_LABEL}>{t("model.loadedNow")}</div>}
                        {pinned.map(renderRow)}
                        {pinned.length > 0 && rest.length > 0 && <div role="separator" className={MENU_SEPARATOR} />}
                        {rest.map(renderRow)}
                        {custom.length === 0 && (lookingForLocal ? lookingForLocalStatus : (
                          <div className="px-3 py-6 text-center">
                            <div className="text-[13px] leading-[18px] text-ink">{t("model.noLocal")}</div>
                            <div className="mt-1 text-[12px] leading-4 text-ink-tertiary">{t("model.noLocalHint")}</div>
                          </div>
                        ))}
                        {custom.length > 0 && filteredCustom.length === 0 && (
                          <div className="px-2 py-5 text-center text-[13px] leading-[18px] text-ink-secondary">
                            {t("model.noMatch", { query: query.trim() })}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}

              {!contained && (
                <EffortRow
                  compact
                  bot={shown}
                  threadId={threadId}
                  updateBotDefault={Boolean(threadId && scope === "bot")}
                  className="shrink-0 border-t-[0.5px] border-ink/10 px-3.5 py-[5px]"
                  label={<span className="text-[13px] leading-[18px] text-ink">{active?.capabilities?.modelVariants ? t("model.simple.reasoning") : t("model.section.effort")}</span>}
                />
              )}

              {pane === "main" && offersLocalModels(railInstance, custom.length) && (
                <button
                  type="button"
                  data-model-local-entry
                  data-menu-row
                  aria-label={
                    custom.length > 0
                      ? t("model.useLocalCount", { count: custom.length })
                      : t("model.useLocal")
                  }
                  disabled={!canOpenCustom}
                  onClick={() => openLocalModels(railInstance)}
                  className="flex h-10 w-full shrink-0 items-center justify-between gap-2 border-t-[0.5px] border-ink/10 px-3.5 text-left text-[13px] leading-[18px] text-ink hover:bg-ink/[0.06] focus:bg-ink/[0.06] disabled:cursor-not-allowed disabled:text-ink-tertiary disabled:hover:bg-transparent"
                >
                  <span>{t("model.useLocal")}</span>
                  <span className="flex items-center gap-2">
                    {custom.length > 0 && (
                      <span className="text-[12px] leading-4 text-ink-tertiary">{t("model.available", { count: custom.length })}</span>
                    )}
                    <ChevronRight size={16} strokeWidth={MENU_STROKE} className={MENU_TRAILING} aria-hidden="true" />
                  </span>
                </button>
              )}
            </>
          ) : (
            <div className="px-3.5 py-5 text-[13px] leading-[18px] text-ink-secondary">{t("model.noProviders")}</div>
          )}
          <div className="flex h-9 shrink-0 items-center gap-1 border-t-[0.5px] border-ink/10 px-1.5">
            <button type="button" onClick={openEngines}
              className="h-7 min-w-0 flex-1 truncate rounded-md px-2 text-left text-[12px] leading-4 text-ink-secondary hover:bg-ink/[0.06] hover:text-ink">
              {t("settings.engines.title")}
            </button>
            {!remote && (
              <button type="button" data-model-add-api-keys onClick={openApiKeys}
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] leading-4 text-ink-secondary hover:bg-ink/[0.06] hover:text-ink">
                <KeyRound size={14} strokeWidth={MENU_STROKE} aria-hidden="true" />
                {apiKeysLabel(pickerInstances)}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );

  const menu = motion.shown && (
    <div
      ref={menuRef}
      id={menuId}
      data-model-picker-content
      role="dialog"
      aria-label={t("model.choose")}
      aria-modal="false"
      tabIndex={-1}
      {...motion.exitProps}
      onKeyDown={onMenuKey}
      onPointerMove={modelMenuPointerMove}
      style={floating ? {
        position: "fixed",
        left: placement?.left ?? 0,
        top: placement?.top,
        bottom: placement?.bottom,
        width: placement?.width ?? popoverWidth,
        maxHeight: placement?.maxHeight,
        transformOrigin: placement?.origin,
        visibility: placement ? undefined : "hidden",
      } : { width: popoverWidth }}
      className={cn("menu-surface z-[80] flex flex-col overflow-hidden", motion.className)}
    >
      {simpleMenu ? (
        <SimpleModelMenu
          menu={simpleMenu}
          query={query}
          bot={profile}
          botModel={{ label: modelName(botModelInstance, profile.modelSelection.model), title: botModelName }}
          thinking={thinking}
          idPrefix={menuId}
          onQuery={setQuery}
          onPick={pick}
          onPickCurrent={() => close(true)}
          onFollowBot={pickBotModel}
          onToggle={(instance) => {
            const opening = !expanded.has(instance.instanceId);
            setExpanded((current) => {
              const next = new Set(current);
              if (opening) next.add(instance.instanceId);
              else next.delete(instance.instanceId);
              return next;
            });
            if (opening) lookForLocalIn(instance);
          }}
          onSetUp={openFull}
          onCheckAgain={(instance) => refreshModels(instance.instanceId)}
          onManage={openEngines}
          onResetVariant={resetVariant}
        />
      ) : fullPane}
    </div>
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
      {menu && floating ? createPortal(menu, document.body) : menu}
      {!contained && changedBotModel && !open && ownModelThreads > 0 && (
        <div data-thread-models-notice role="status"
          className="menu-surface absolute right-0 top-full z-30 mt-1 flex w-max max-w-[min(300px,calc(100vw-2rem))] items-center gap-2 py-1.5 pl-3 pr-1.5 text-[13px] leading-[18px]">
          <ThreadModelsLine bot={profile} />
          <button type="button" aria-label={t("common.close")} onClick={() => setChangedBotModel(false)}
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      <ConfirmDialog
        open={pendingSwitch !== null}
        title={t("model.providerSwitch.title")}
        body={t(pendingSwitch?.updateBotDefault ? "model.providerSwitch.botBody" : "model.providerSwitch.threadBody", {
          model: pendingSwitch?.name ?? "",
        })}
        tone="neutral"
        confirmLabel={t("model.providerSwitch.confirm")}
        onCancel={() => setPendingSwitch(null)}
        onConfirm={() => {
          if (!pendingSwitch || bot.busy || pendingSwitch.botId !== bot.id || pendingSwitch.threadId !== (threadId ?? bot.threadId)) {
            setPendingSwitch(null); return;
          }
          dispatch({ type: "setModel", botId: pendingSwitch.botId, threadId: pendingSwitch.threadId,
            selection: pendingSwitch.selection, updateBotDefault: pendingSwitch.updateBotDefault,
            resetApprovalToAsk: true });
          if (pendingSwitch.updateBotDefault && threadId) setChangedBotModel(true);
          setPendingSwitch(null);
        }}
      />
    </div>
  );
}
