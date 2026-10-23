import { modelLabel, modelProvider, probeLocalModels } from "./model-picker-options";
export { probeLocalModels, LOCAL_PROBE_TIMEOUT_MS } from "./model-picker-options";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, KeyRound, Loader2, Plus, RefreshCw, Search, X } from "lucide-react";
import { useStore, currentTaskBot, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";
import type { ModelVariantOption } from "../../shared/runtime-events";
import { filterCustomModels, partitionCustomModels, suggestedModels } from "@/lib/custom-models";
import { configuredModelInstances, isClaudeAccount, isCustomOnly, SIGN_IN_FAMILY_LABEL, signInFamily, splitEngineRail, type SignInFamily } from "@/lib/engine-rail";
import { InstanceProviderMark } from "./ProviderIcons";
import { EngineSetup, EngineUpdateNotice, hasSavedApiKey, needsCli, needsSignIn } from "./EngineSetup";
import { EngineGroupLabel } from "./EngineGroupLabel";
import { ConfirmDialog } from "./ConfirmDialog";
import { ChatGptPlanStatus } from "./ChatGptPlanStatus";
import { approvalModeFor, modelSwitchNeedsAsk } from "../../shared/approval-mode";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { repeatedModelLabels, SimpleModelPane } from "./SimpleModelPane";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";

import { t } from "@/lib/i18n";
import { COMPACT_SQUARE } from "@/lib/compact-chip";
import { threadsOnOwnModel } from "../../shared/thread-model";
import { ThreadModelsLine } from "./ThreadModelsLine";
import { Select } from "./Select";
import { ModelArrangementCard } from "./ModelArrangementCard";
import { modelArrangement } from "@/lib/model-arrangement";
import { isDirectModelDriver } from "../../shared/model-arrangement";

type ModelOption = InstanceInfo["models"]["options"][number];
const COMPACT_MODEL_COUNT = 5;

export function engineStatus(instance: InstanceInfo): string {
  if (needsCli(instance)) return t("model.setupRequired");
  if (needsSignIn(instance)) return t("model.signInRequired");
  return instance.snapshot.version ?? t("model.ready");
}

export function offersLocalModels(instance: InstanceInfo | undefined, localCount: number): boolean {
  if (!instance) return false;
  return localCount > 0 || (instance.driverKind === "claudeAgent" && !needsCli(instance) && !instance.policy);
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
    return <ModelVariantRow bot={bot} threadId={threadId} updateBotDefault={updateBotDefault} className={className} label={label} compact={compact} />;
  }
  const levels = instance?.capabilities?.effortLevels;
  if (!levels?.length) return null;

  if (compact) return (
    <label className={cn("flex items-center justify-between gap-3", className)}>
      {label}
      <Select size="sm" className="max-w-[65%]" aria-label={t("model.effort.label")} value={selection.effort ?? ""}
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

function variantLabel(option: ModelVariantOption): string {
  return option.id === "default" ? t("model.variant.openCodeDefault") : option.label;
}

/** ACP variant ids are opaque; their model/session declares the available choices. */
export function ModelVariantRow({ bot, threadId, updateBotDefault, className, label, compact = false, wide = false }: {
  bot: Bot;
  threadId?: string;
  updateBotDefault?: boolean;
  className?: string;
  label?: ReactNode;
  compact?: boolean;
  wide?: boolean;
}) {
  const { state, dispatch } = useStore();
  const selection = bot.modelSelection;
  const instance = state.instances.find((candidate) => candidate.instanceId === selection.instanceId);
  if (!instance?.capabilities?.modelVariants) return null;
  const session = state.modelVariantSessions[threadId ?? bot.threadId];
  const reported = session?.instanceId === selection.instanceId && session.model === selection.model ? session.variants : undefined;
  const options = reported?.options ?? instance.models.options.find((option) => option.id === selection.model)?.variants ?? [];
  if (!options.length && selection.variant === undefined) return null;
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
        <Select size="sm" aria-label={t("model.variant.label")} disabled={bot.busy} className={wide ? "flex-1" : "max-w-[65%]"}
          value={selection.variant === undefined ? "unset" : missing ? "missing" : String(options.findIndex((option) => option.id === selection.variant))}
          onChange={(event) => choose(options[Number(event.target.value)]?.id)}>
          <option value="unset">{t("model.variant.session")}</option>
          {missing && <option value="missing" disabled>{selection.variant} ({unavailable ? t("model.variant.unavailable") : t("model.variant.unverified")})</option>}
          {options.map((option, index) => <option key={option.id} value={String(index)}>{variantLabel(option)}</option>)}
        </Select>
      </label>
      {missing && <p className="mt-1 text-[11px] text-ink-secondary">{unavailable ? t("model.variant.unavailableHelp") : t("model.variant.unverifiedHelp")}</p>}
    </div>
  );
  return (
    <div className={className}>
      {label}
      {(selection.variant === undefined || missing) && (
        <p className="mt-2 text-[12px] text-ink-secondary">
          {unavailable ? t("model.variant.unavailableChoice", { variant: selection.variant ?? "" })
            : missing ? t("model.variant.unverifiedChoice", { variant: selection.variant ?? "" }) : t("model.variant.none")}
          {current !== undefined && ` ${t("model.variant.sessionValue", { variant: variantLabel(options.find((option) => option.id === current) ?? { id: current, label: current }) })}`}
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
              title={t("model.variant.use", { variant: variantLabel(option) })}
              onClick={() => choose(option.id)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-50",
                selection.variant === option.id ? "border-accent/60 bg-control text-ink" : "border-hairline/40 text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {variantLabel(option)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function modelSelectionForPick(selection: ModelSelection, instance: InstanceInfo, model: string): ModelSelection {
  const next: ModelSelection = { instanceId: instance.instanceId, model };
  if (instance.instanceId === selection.instanceId) {
    if (instance.capabilities?.modelVariants) {
      if (model === selection.model && selection.variant !== undefined) next.variant = selection.variant;
    } else if (selection.effort) next.effort = selection.effort;
  }
  return next;
}

function ModelRow({
  option,
  current,
  defaultId,
  botModel = false,
  onPick,
}: {
  option: ModelOption;
  current: boolean;
  defaultId: string;
  botModel?: boolean;
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
        <span className="truncate">{option.id === "agent-default" ? t("model.arrangement.agentConfigured") : option.label}</span>
        {option.provider && (
          <span
            className="shrink-0 rounded bg-inset px-1.5 py-px text-[10px] text-ink-secondary"
            title={t("model.provider", { name: option.provider })}
          >
            {option.provider}
          </span>
        )}
        {option.id === defaultId && (
          <span className="shrink-0 rounded bg-inset px-1.5 py-px text-[10px] text-ink-secondary">{t("model.effort.default")}</span>
        )}
        {option.loaded && (
          <span className="shrink-0 rounded bg-accent/10 px-1.5 py-px text-[10px] text-accent">{t("model.loadedNow")}</span>
        )}
        {botModel && <span data-bot-model className="shrink-0 text-[11px] text-ink-secondary">{t("model.botModelTag")}</span>}
      </span>
      {current && <Check size={14} className="shrink-0 text-accent" />}
    </button>
  );
}

export function FollowBotModelRow({ name, model, follows, onPick }: { name: string; model: string; follows: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      data-follow-bot-model
      aria-pressed={follows}
      onClick={onPick}
      className={cn(
        "flex w-full shrink-0 items-center justify-between gap-2 border-b border-hairline/40 px-4 py-2.5 text-left text-[13px] text-ink hover:bg-control/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        follows && "bg-control/40",
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-medium">{t("model.useBotModel", { name })}</span>
        <span className="truncate text-[12px] text-ink-secondary">{model}</span>
      </span>
      {follows && <Check size={14} className="shrink-0 text-accent" aria-hidden="true" />}
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
      <div className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 focus-within:border-focus">
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

export type RailProvider = {
  instance: InstanceInfo;
  target: InstanceInfo;
  label: string;
  selected: boolean;
};

export function railProviders(instances: InstanceInfo[], selectedInstance: InstanceInfo | undefined,
  claudeInstance: InstanceInfo | undefined, openaiInstance: InstanceInfo | undefined) {
  const firstOf: Record<SignInFamily, InstanceInfo | undefined> = {
    claude: instances.find((instance) => isClaudeAccount(instance) && instance.claudeAccount?.isDefault)
      ?? instances.find(isClaudeAccount),
    openai: instances.find((instance) => signInFamily(instance) === "openai"),
  };
  const opensOn: Record<SignInFamily, InstanceInfo | undefined> = { claude: claudeInstance, openai: openaiInstance };
  const providers = instances.filter((instance) => {
    const family = signInFamily(instance);
    return !family || instance === firstOf[family];
  });
  const entry = (instance: InstanceInfo): RailProvider => {
    const family = signInFamily(instance);
    return {
      instance,
      target: family ? opensOn[family] ?? instance : instance,
      label: family ? SIGN_IN_FAMILY_LABEL[family] : instance.displayName,
      selected: family ? signInFamily(selectedInstance) === family : instance.instanceId === selectedInstance?.instanceId,
    };
  };
  const { subscription, api, custom } = splitEngineRail(providers);
  return { subscription: subscription.map(entry), api: api.map(entry), custom: custom.map(entry) };
}

function apiKeysLabel(instances: InstanceInfo[]): string {
  return t(instances.some(hasSavedApiKey) ? "model.addOrChangeApiKeys" : "model.addApiKeys");
}

export function ModelEngineRail({ instances, selectedInstance, claudeInstance, openaiInstance, onSelect, onAddApiKeys }: {
  instances: InstanceInfo[];
  selectedInstance?: InstanceInfo;
  claudeInstance?: InstanceInfo;
  openaiInstance?: InstanceInfo;
  onSelect: (instance: InstanceInfo) => void;
  onAddApiKeys?: () => void;
}) {
  const { subscription, api, custom: local } = railProviders(instances, selectedInstance, claudeInstance, openaiInstance);
  const providers = [...subscription, ...api, ...local];
  const agents = providers.filter(({ target }) => !isDirectModelDriver(target.driverKind));
  const direct = providers.filter(({ target }) => isDirectModelDriver(target.driverKind));
  const railButton = ({ instance, target, selected, label }: RailProvider) => {
    const attention = needsCli(target) || needsSignIn(target) || Boolean(target.snapshot.update);
    const managedBy = target.policy ? t("policy.managedBy", { organization: target.policy.organizationName }) : undefined;
    return (
      <button
        type="button"
        key={instance.instanceId}
        onClick={() => onSelect(target)}
        aria-label={managedBy ? `${label} · ${managedBy}` : label}
        aria-pressed={selected}
        title={`${label} · ${managedBy ?? engineStatus(target)}`}
        className={cn("relative flex size-9 items-center justify-center rounded-lg", selected ? "bg-control ring-1 ring-hairline/50" : "hover:bg-control/60", managedBy && "opacity-40")}
      >
        <InstanceProviderMark instance={target} size={18} />
        {target.access === "api" && (
          <span data-rail-key-badge className="absolute bottom-0 left-0 flex size-3.5 items-center justify-center rounded-full bg-panel text-ink-secondary">
            <KeyRound size={9} aria-hidden="true" />
          </span>
        )}
        {attention && <span className="absolute bottom-0.5 right-0.5 size-1.5 rounded-full bg-warning ring-2 ring-panel" />}
      </button>
    );
  };
  return (
    <div className="flex w-14 shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline/40 bg-panel p-2">
      {agents.length > 0 && <EngineGroupLabel className="px-0 pb-0.5 pt-0.5 text-center text-[9px] leading-tight">{t("model.rail.agents")}</EngineGroupLabel>}
      {agents.map(railButton)}
      {(direct.length > 0 || onAddApiKeys) && <EngineGroupLabel className="px-0 pb-0.5 pt-2 text-center text-[9px] leading-tight">{t("model.rail.direct")}</EngineGroupLabel>}
      {direct.map(railButton)}
      {onAddApiKeys && (
        <button
          type="button"
          data-rail-add-api-key
          onClick={onAddApiKeys}
          aria-label={apiKeysLabel(instances)}
          title={apiKeysLabel(instances)}
          className="flex size-9 items-center justify-center rounded-lg border border-dashed border-hairline text-ink-secondary hover:bg-control/60 hover:text-ink"
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      )}
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
      <Select size="sm" className="flex-1"
        aria-label={t("model.account")}
        value={selectedId}
        onChange={(event) => {
          const account = accounts.find((instance) => instance.instanceId === event.target.value);
          if (account) onSelect(account);
        }}
      >
        {accounts.map((account) => <option key={account.instanceId} value={account.instanceId}>{account.displayName}</option>)}
      </Select>
    </label>
  );
}

const POPOVER_WIDTH = 420;
export const SIMPLE_POPOVER_WIDTH = 380;
const SIMPLE_SEARCH_AFTER = 12;

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
  contained?: boolean;
  label?: ReactNode;
}) {
  const { state, dispatch, refreshInstances, refreshModels: refreshInstanceModels } = useStore();
  const [open, setOpen] = useState(false);
  const motion = useMenuMotion(open && !bot.busy);
  const [railId, setRailId] = useState<string | null>(null);
  const [pane, setPane] = useState<"main" | "custom">("main");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [probingLocal, setProbingLocal] = useState<string | null>(null);
  const [scope, setScope] = useState<"bot" | "thread">("thread");
  const advanced = useAdvancedMode();
  const ownerOrAdmin = useOwnerOrAdmin();
  // Cloud guests change only their own conversation's model, never the shared bot's default; thread-only until
  // authority loads.
  const simpleUpdatesBotDefault = !state.config?.cloudHome || ownerOrAdmin === true;
  const [fullView, setFullView] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<{ botId: string; threadId: string;
    selection: ModelSelection; updateBotDefault: boolean; name: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; maxHeight: number }>();
  const [changedBotModel, setChangedBotModel] = useState(false);
  const refreshingRef = useRef(false);
  const lastClaudeIdRef = useRef<string | null>(null);
  const lastOpenaiIdRef = useRef<string | null>(null);

  const simpleView = !advanced && !fullView;
  const popoverWidth = simpleView ? SIMPLE_POPOVER_WIDTH : POPOVER_WIDTH;
  useLayoutEffect(() => {
    if (!open || contained) return;
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(popoverWidth, window.innerWidth - 32);
      setPlacement({ left: Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16)) - rect.left,
        maxHeight: Math.max(0, Math.min(600, window.innerHeight - rect.bottom - 24)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, contained, popoverWidth]);

  const selection = bot.modelSelection;
  const active = state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const pickerInstances = configuredModelInstances(state.instances, selection.instanceId);
  const selectedVariantLabel = selection.variant === undefined ? undefined : variantLabel(
    active?.models.options.find((option) => option.id === selection.model)?.variants?.find((option) => option.id === selection.variant)
      ?? { id: selection.variant, label: selection.variant },
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
  useEffect(() => {
    if (railId !== null && railId !== displayedInstanceId) {
      setPane(customOnly || !hasOfficialModels ? "custom" : "main");
      setQuery("");
      setShowAll(false);
    } else if (customOnly || !hasOfficialModels) {
      setPane("custom");
    }
  }, [railId, displayedInstanceId, hasOfficialModels, customOnly]);

  const refreshLocalInstances = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    void refreshInstances()
      .catch(() => {
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
    const instanceId = displayedInstanceId;
    void refreshInstances()
      .then(() => instanceId ? refreshInstanceModels(instanceId) : undefined)
      .catch(() => {
      })
      .finally(() => {
        refreshingRef.current = false;
        setRefreshing(false);
      });
  }, [displayedInstanceId, refreshInstanceModels, refreshInstances]);

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
      else if (!simpleView && pane === "custom" && railInstance?.models.options.some((option) => !option.custom)) setPane("main");
      else setOpen(false);
    };
    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, pane, query, railInstance, simpleView]);

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
    if (needsCli(instance) || instance.policy || probingLocal === instance.instanceId) return;
    setProbingLocal(instance.instanceId);
    void probeLocalModels(instance.instanceId, refreshInstanceModels).then(() =>
      setProbingLocal((current) => (current === instance.instanceId ? null : current)));
  };

  const openLocalModels = (instance: InstanceInfo) => {
    setPane("custom");
    resetList();
    lookForLocal(instance);
  };

  const openApiKeys = () => {
    setOpen(false);
    dispatch({ type: "toggleAppSettings", open: true, section: "connections" });
  };

  const selectRail = (instance: InstanceInfo) => {
    if (isClaudeAccount(instance)) lastClaudeIdRef.current = instance.instanceId;
    if (signInFamily(instance) === "openai") lastOpenaiIdRef.current = instance.instanceId;
    setRailId(instance.instanceId);
    const official = instance.models.options.filter((option) => !option.custom);
    setPane(isCustomOnly(instance) || (official.length === 0 && !instance.snapshot.chatgptPlan) ? "custom" : "main");
    resetList();
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
    setOpen(false);
    if (follows !== false) return;
    const target = currentTaskBot(profile, threadId ?? bot.threadId);
    if (modelSwitchNeedsAsk(approvalModeFor(target),
      state.instances.find((candidate) => candidate.instanceId === target.modelSelection.instanceId)?.driverKind,
      botModelInstance?.driverKind)) {
      setPendingSwitch({ botId: bot.id, threadId: threadId ?? bot.threadId, selection: profile.modelSelection, updateBotDefault: false, name: botModelName });
      return;
    }
    dispatch({ type: "setModel", botId: bot.id, threadId: threadId ?? bot.threadId, updateBotDefault: false, selection: profile.modelSelection });
  };

  const pick = (instance: InstanceInfo, model: string) => {
    if (bot.busy || instance.policy) return;
    const nextSelection = modelSelectionForPick(selection, instance, model);
    const updateBotDefault = !threadId || (simpleView ? simpleUpdatesBotDefault : scope === "bot");
    const targets = updateBotDefault ? [currentTaskBot(profile, threadId ?? bot.threadId), profile] : [bot];
    if (targets.some((target) => modelSwitchNeedsAsk(approvalModeFor(target),
      state.instances.find((candidate) => candidate.instanceId === target.modelSelection.instanceId)?.driverKind,
      instance.driverKind))) {
      setPendingSwitch({ botId: bot.id, threadId: threadId ?? bot.threadId,
        selection: nextSelection, updateBotDefault, name: modelLabel(instance, model) });
      setOpen(false);
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
  const lookingForLocal = Boolean(railInstance && probingLocal === railInstance.instanceId);
  const lookingForLocalStatus = (
    <span role="status" className="flex items-center justify-center gap-2">
      <Loader2 size={12} className="animate-spin" aria-hidden="true" />
      {t("model.lookingLocal")}
    </span>
  );

  const simpleOpensOn = (accounts: InstanceInfo[], lastId: string | null) =>
    accounts.find((account) => account.instanceId === lastId)
      ?? accounts.find((account) => account.instanceId === selection.instanceId)
      ?? accounts.find((account) => !needsCli(account) && !needsSignIn(account))
      ?? accounts[0];
  const simpleProviders = (() => {
    const groups = railProviders(pickerInstances, railInstance,
      simpleOpensOn(claudeAccounts, lastClaudeIdRef.current), simpleOpensOn(openaiAccounts, lastOpenaiIdRef.current));
    return [...groups.subscription, ...groups.api, ...groups.custom];
  })();
  const simpleFamily = signInFamily(railInstance);
  const simpleAccounts = simpleFamily === "claude" ? claudeAccounts : simpleFamily === "openai" ? openaiAccounts : [];
  const simpleLabel = simpleProviders.find((provider) => provider.selected)?.label ?? railInstance?.displayName ?? "";
  const simpleSignIn = !customOnly && needsSignIn(railInstance);
  const simpleOfficial = customOnly || simpleSignIn ? [] : official;
  const simpleLocal = partitionCustomModels(custom);
  const simpleAll = [...simpleOfficial, ...simpleLocal.pinned, ...simpleLocal.rest];
  const simpleSetup = Boolean(railInstance && (railInstance.policy || needsCli(railInstance) || (simpleSignIn && simpleAll.length === 0)));
  const simpleSuggested = railInstance
    ? suggestedModels(simpleAll, railInstance.models.default, currentModel, COMPACT_MODEL_COUNT)
    : [];
  const simpleOpened = [...simpleSuggested, ...simpleAll.filter((option) => !simpleSuggested.includes(option))];
  const simpleSearch = showAll && simpleAll.length > SIMPLE_SEARCH_AFTER;
  const simpleQuery = simpleSearch ? query : "";
  const simpleModels = simpleQuery ? filterCustomModels(simpleOpened, simpleQuery) : showAll ? simpleOpened : simpleSuggested;
  const lookForLocalIn = (instance: InstanceInfo) => {
    if (offersLocalModels(instance, instance.models.options.filter((option) => option.custom).length)) lookForLocal(instance);
  };
  const browseSimple = (instance: InstanceInfo) => {
    selectRail(instance);
    lookForLocalIn(instance);
  };
  const activeLevels = active?.capabilities?.effortLevels ?? [];
  const simpleEffort = activeLevels.length > 0 ? {
    levels: [...activeLevels],
    current: selection.effort,
    onPick: (level: EffortLevel) => dispatch({ type: "setModel", botId: bot.id, threadId,
      ...(threadId && simpleUpdatesBotDefault ? { updateBotDefault: true } : {}), selection: { ...selection, effort: level } }),
  } : null;

  const botModelId = follows !== undefined && profile.modelSelection.instanceId === railInstance?.instanceId
    ? profile.modelSelection.model : undefined;
  const renderRow = (option: ModelOption) => (
    <ModelRow
      key={option.id}
      option={option}
      current={selection.instanceId === railInstance?.instanceId && selection.model === option.id}
      defaultId={railInstance?.models.default ?? ""}
      botModel={option.id === botModelId}
      onPick={() => railInstance && pick(railInstance, option.id)}
    />
  );

  const summary = active
    ? `${active.displayName} · ${modelLabel(active, selection.model)}${
        modelProvider(active, selection.model) ? ` · ${modelProvider(active, selection.model)}` : ""
      }${selectedVariantLabel ? ` · ${selectedVariantLabel}` : selection.effort ? ` · ${t("model.effort.summary", { level: effortLabel(selection.effort) })}` : ""}`
    : selection.model;
  const activeEndpoint = active?.instanceId === "openaiCompat" ? state.config?.openaiCompat?.url : undefined;
  const activeArrangement = modelArrangement(active, selection, activeEndpoint);
  const activeSummary = <ModelArrangementCard instance={active} selection={selection} endpointUrl={activeEndpoint} />;
  const browsingSelection = railInstance?.instanceId === selection.instanceId ? selection
    : { instanceId: railInstance?.instanceId ?? selection.instanceId, model: railInstance?.models.default ?? "" };
  const railEndpoint = railInstance?.instanceId === "openaiCompat" ? state.config?.openaiCompat?.url : undefined;
  const arrangementCard = <ModelArrangementCard instance={railInstance} selection={browsingSelection}
    endpointUrl={railEndpoint}
    changing={Boolean(railInstance && railInstance.instanceId !== selection.instanceId)} />;
  const followLine = follows === true ? `\n${t("model.followsBot", { name: profile.name })}` : follows === false ? `\n${t("model.ownModel")}` : "";

  const trigger = (
    <button data-tour="model"
      type="button"
      disabled={Boolean(bot.busy)}
      onClick={() => {
        if (bot.busy) return;
        if (active && isClaudeAccount(active)) lastClaudeIdRef.current = active.instanceId;
        if (active && signInFamily(active) === "openai") lastOpenaiIdRef.current = active.instanceId;
        const initial = pickerInstances.find((instance) => instance.instanceId === selection.instanceId) ?? pickerInstances[0];
        setRailId(initial?.instanceId ?? null);
        setChangedBotModel(false);
        setOpen((wasOpen) => {
          const next = !wasOpen;
          if (next) {
            openFor(initial);
            setFullView(false);
          }
          return next;
        });
      }}
      aria-expanded={open && !bot.busy}
      aria-haspopup="dialog"
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-full border border-hairline/40 bg-control/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-control/60",
        contained && "w-full justify-between",
        !contained && active && !showActiveAccount && COMPACT_SQUARE,
      )}
      title={bot.busy ? `${summary}${followLine}\n${t(threadId ? "model.threadBusy" : "model.busy")}` : `${summary}${followLine}`}
    >
      {active && <InstanceProviderMark instance={active} size={14} />}
      {!contained && active && showActiveAccount && (
        <span data-model-account-compact className="hidden max-w-20 truncate @max-4xl/chathead:inline">{active.displayName}</span>
      )}
      <span className={cn("flex min-w-0 items-center gap-1", contained && "flex-1", !contained && active && "@max-4xl/chathead:hidden")}>
        <span data-model-agent className={cn("truncate text-ink-secondary", contained ? "max-w-[40%] shrink-0" : "max-w-[100px]")}>{activeArrangement.agent} ·</span>
        <span className={cn("truncate", contained ? "min-w-0 flex-1" : "max-w-[160px]")}>
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
        <div className="flex min-w-0 flex-col items-stretch gap-3">
          {label}
          {trigger}
        </div>
      ) : (
        trigger
      )}

      {contained && <div className="mt-3 min-w-0">{activeSummary}</div>}

      {motion.shown && (
        <div
          data-model-picker-content
          role="dialog"
          aria-label={t("model.choose")}
          {...motion.exitProps}
          style={contained ? undefined : { ...placement, width: popoverWidth }}
          className={cn(
            "flex flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-card",
            contained
              ? "relative mt-3 w-full max-h-[min(420px,50dvh)]"
              : "absolute right-0 top-full z-30 mt-2 max-w-[calc(100vw-2rem)] max-h-[min(600px,calc(100dvh-7rem))] shadow-2xl shadow-black/50",
            motion.className,
          )}
        >
          {follows !== undefined && (
            <FollowBotModelRow name={profile.name} model={botModelName} follows={follows} onPick={pickBotModel} />
          )}
          <div className="flex min-h-0 min-w-0 flex-1">
          {simpleView ? (
            <SimpleModelPane
              arrangement={!contained || railInstance?.instanceId !== selection.instanceId ? arrangementCard : undefined}
              providers={simpleProviders}
              onProvider={browseSimple}
              account={railInstance && simpleAccounts.length > 1 ? (
                <ClaudeAccountSelect accounts={simpleAccounts} selectedId={railInstance.instanceId} onSelect={browseSimple} />
              ) : undefined}
              managedBy={railInstance?.policy?.organizationName ?? null}
              needsSetup={railInstance && simpleSetup ? { name: simpleAccounts.length > 1 ? railInstance.displayName : simpleLabel } : null}
              signIn={railInstance && simpleSignIn && !simpleSetup ? { name: simpleLabel } : null}
              onSetUp={() => {
                if (simpleSignIn && hasOfficialModels) setPane("main");
                setFullView(true);
              }}
              models={simpleModels}
              repeatedLabels={repeatedModelLabels(simpleAll)}
              query={simpleQuery}
              showAll={simpleAll.length > simpleSuggested.length && !simpleQuery ? {
                count: simpleAll.length,
                open: showAll,
                onToggle: () => {
                  if (showAll) {
                    resetList();
                    return;
                  }
                  setShowAll(true);
                  if (railInstance) lookForLocalIn(railInstance);
                },
              } : null}
              onRefresh={refreshModels}
              refreshing={refreshing}
              search={simpleSearch ? (
                <ModelSearch
                  value={query}
                  local={simpleOfficial.length === 0}
                  onChange={setQuery}
                  onEscape={() => (query ? setQuery("") : setOpen(false))}
                />
              ) : undefined}
              currentModelId={currentModel}
              botModelId={botModelId}
              onPick={(model) => railInstance && pick(railInstance, model)}
              variantsRow={active?.capabilities?.modelVariants ? (
                <ModelVariantRow compact wide bot={bot} threadId={threadId} updateBotDefault={Boolean(threadId) && simpleUpdatesBotDefault}
                  label={<span className="shrink-0 text-[12px] font-medium text-ink-secondary">{t("model.simple.reasoning")}</span>} />
              ) : undefined}
              effort={simpleEffort}
              onManage={() => {
                setOpen(false);
                dispatch({ type: "toggleAppSettings", open: true, section: "engines" });
              }}
            />
          ) : (
          <>
          {pickerInstances.length > 0 && <ModelEngineRail instances={pickerInstances} selectedInstance={railInstance} claudeInstance={claudeRailInstance} openaiInstance={openaiRailInstance} onSelect={selectRail}
            onAddApiKeys={window.ogb?.remoteClient?.active === true ? undefined : openApiKeys} />}

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            {(!contained || railInstance?.instanceId !== selection.instanceId) && <div className="shrink-0 p-2 pb-0">{arrangementCard}</div>}
            {threadId && (
              <div className="shrink-0 border-b border-hairline/40 px-3 py-2">
                <div role="group" aria-label={t("model.scope.label")} className="flex gap-1">
                  {(["thread", "bot"] as const).map((value) => (
                    <button key={value} type="button" aria-pressed={scope === value} onClick={() => setScope(value)}
                      className={cn("rounded-lg px-2 py-1 text-[12px]", scope === value ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60")}>
                      {value === "bot" ? t("model.scope.bot") : t("model.scope.thread")}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-ink-secondary">
                  {scope === "bot" ? t("model.scope.botHelp") : t("model.scope.threadHelp")}
                </p>
              </div>
            )}
            {railInstance ? (
              <>
                <div className="shrink-0 px-4 pb-2 pt-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-[14px] font-semibold text-ink">{signInFamily(railInstance) ? SIGN_IN_FAMILY_LABEL[signInFamily(railInstance)!] : railInstance.displayName}</div>
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
                    <p className="mt-1 truncate text-[11px] text-ink-secondary" title={[railInstance.snapshot.account.email, railInstance.snapshot.account.organization].filter(Boolean).join(" · ")}>
                      {[railInstance.snapshot.account.email, railInstance.snapshot.account.organization].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  {railInstance.snapshot.chatgptPlan && railInstance.snapshot.authenticated && (
                    <ChatGptPlanStatus key={railInstance.instanceId} instanceId={railInstance.instanceId} />
                  )}
                  {railInstance.access === "api"
                    ? <div className="mt-0.5 text-[11.5px] text-ink-secondary">{t(modelArrangement(railInstance, { instanceId: railInstance.instanceId, model: "agent-default" }, railEndpoint).location === "local" ? "model.localEndpointHint" : "model.apiKeyHint")}</div>
                    : pane === "custom" && <div className="mt-0.5 text-[11.5px] text-ink-secondary">{t("model.localHint")}</div>}
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

                {railInstance.policy ? (
                  <div data-policy-blocked className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1 text-[12.5px] leading-relaxed text-ink-secondary">
                    <p className="font-medium text-ink">{t("policy.managedBy", { organization: railInstance.policy.organizationName })}</p>
                    <p className="mt-1">{t("policy.modelBlocked", { organization: railInstance.policy.organizationName })}</p>
                  </div>
                ) : blocked ? (
                  <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
                    <EngineSetup instance={railInstance} intent={pane === "custom" ? "inject" : "cloud"} />
                    {railInstance.claudeAccount && needsSignIn(railInstance) && pane !== "custom" && (
                      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
                        {railInstance.claudeAccount.signInShell === "powershell" && `${t("engines.account.powershell")} `}
                        {t("engines.account.signInHint")}
                      </p>
                    )}
                    <p className="mt-2 text-center text-[11.5px] text-ink-tertiary">
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
                        onEscape={() => {
                          if (query) setQuery("");
                          else if (pane === "custom" && canReturnToOfficial) setPane("main");
                        }}
                      />
                    )}

                    <div data-model-list className="min-h-[min(180px,30dvh)] flex-1 overflow-y-auto px-2 pb-2">
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
                          {lookingForLocal && custom.length > 0 && (
                            <div className="flex px-2 pb-1.5 pt-0.5 text-[11.5px] text-ink-secondary">{lookingForLocalStatus}</div>
                          )}
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
                              {lookingForLocal ? (
                                <div className="text-[12.5px] text-ink-secondary">{lookingForLocalStatus}</div>
                              ) : (
                                <>
                                  <div className="text-[12.5px] font-medium text-ink">{t("model.noLocal")}</div>
                                  <div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
                                    {t("model.noLocalHint")}
                                  </div>
                                </>
                              )}
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

                {!contained && (
                  <EffortRow
                    compact
                    bot={bot}
                    threadId={threadId}
                    updateBotDefault={Boolean(threadId && scope === "bot")}
                    className="shrink-0 border-t border-hairline/40 px-4 py-2"
                    label={<span className="text-[12.5px] font-medium text-ink">{active?.capabilities?.modelVariants ? t("model.simple.reasoning") : t("model.section.effort")}</span>}
                  />
                )}

                {pane === "main" && offersLocalModels(railInstance, custom.length) && (
                  <button
                    type="button"
                    data-model-local-entry
                    aria-label={
                      custom.length > 0
                        ? t("model.useLocalCount", { count: custom.length })
                        : t("model.useLocal")
                    }
                    disabled={!canOpenCustom}
                    onClick={() => openLocalModels(railInstance)}
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
            <div className="flex shrink-0 border-t border-hairline/40">
              <button type="button" onClick={() => {
                setOpen(false);
                dispatch({ type: "toggleAppSettings", open: true, section: "engines" });
              }} className="flex-1 px-4 py-2 text-left text-[12px] text-ink-secondary hover:bg-control/60 hover:text-ink">
                {t("settings.engines.title")}
              </button>
              {window.ogb?.remoteClient?.active !== true && (
                <button type="button" data-model-add-api-keys onClick={openApiKeys} className="flex shrink-0 items-center gap-1.5 px-4 py-2 text-[12px] text-ink-secondary hover:bg-control/60 hover:text-ink">
                  <KeyRound size={12} aria-hidden="true" />
                  {apiKeysLabel(pickerInstances)}
                </button>
              )}
            </div>
          </div>
          </>
          )}
          </div>
        </div>
      )}
      {!contained && changedBotModel && !open && ownModelThreads > 0 && (
        <div data-thread-models-notice role="status"
          className="absolute right-0 top-full z-30 mt-2 flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-xl border border-hairline/50 bg-card py-2 pl-3 pr-2 shadow-xl shadow-black/30">
          <ThreadModelsLine bot={profile} />
          <button type="button" aria-label={t("common.close")} onClick={() => setChangedBotModel(false)}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control/60 hover:text-ink">
            <X size={13} aria-hidden="true" />
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
