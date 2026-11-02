import { Check, KeyRound, Plus, Search } from "lucide-react";
import type { InstanceInfo } from "@/state/store";
import { isClaudeAccount, SIGN_IN_FAMILY_LABEL, signInFamily, splitEngineRail, type SignInFamily } from "@/lib/engine-rail";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { InstanceProviderMark } from "./ProviderIcons";
import { hasSavedApiKey, needsCli, needsSignIn } from "./EngineSetup";
import { MENU_META, MENU_ROW, MENU_STROKE } from "./menu-recipe";
import { Select } from "./Select";

type ModelOption = InstanceInfo["models"]["options"][number];

export function engineStatus(instance: InstanceInfo): string {
  if (needsCli(instance)) return t("model.setupRequired");
  if (needsSignIn(instance)) return t("model.signInRequired");
  return instance.snapshot.version ?? t("model.ready");
}

export function apiKeysLabel(instances: InstanceInfo[]): string {
  return t(instances.some(hasSavedApiKey) ? "model.addOrChangeApiKeys" : "model.addApiKeys");
}

export function ModelRow({ option, current, defaultId, botModel = false, onPick }: {
  option: ModelOption;
  current: boolean;
  defaultId: string;
  botModel?: boolean;
  onPick: () => void;
}) {
  const meta = [option.provider, option.id === defaultId ? t("model.effort.default") : undefined].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      data-menu-row
      data-current-model={current || undefined}
      aria-pressed={current}
      title={option.provider ? t("model.provider", { name: option.provider }) : undefined}
      onClick={onPick}
      className={MENU_ROW}
    >
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {botModel && <span data-bot-model className="shrink-0 text-[12px] leading-4 text-ink-tertiary">{t("model.botModelTag")}</span>}
      {meta && <span className={MENU_META}>{meta}</span>}
      {option.loaded && (
        <span className="flex shrink-0 items-center gap-1 text-[12px] leading-4 text-ink-tertiary">
          <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
          {t("model.loadedNow")}
        </span>
      )}
      {current && <Check size={14} className="shrink-0 text-accent" aria-hidden="true" />}
    </button>
  );
}

export function FollowBotModelRow({ name, model, follows, onPick }: { name: string; model: string; follows: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      data-follow-bot-model
      data-menu-row
      aria-pressed={follows}
      onClick={onPick}
      className="flex h-9 w-full shrink-0 items-center justify-between gap-2 border-b-[0.5px] border-ink/10 px-3.5 text-left text-[13px] leading-[18px] text-ink hover:bg-ink/[0.06] focus:bg-ink/[0.06]"
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-medium">{t("model.useBotModel", { name })}</span>
        <span className="truncate text-[12px] leading-4 text-ink-tertiary">{model}</span>
      </span>
      {follows && <Check size={14} className="shrink-0 text-accent" aria-hidden="true" />}
    </button>
  );
}

export function ModelSearch({ value, onChange, local }: { value: string; onChange: (value: string) => void; local: boolean }) {
  return (
    <div className="group/search flex h-9 shrink-0 items-center gap-2 border-b-[0.5px] border-ink/10 px-3.5">
      <Search size={16} strokeWidth={MENU_STROKE} className="shrink-0 text-ink-tertiary group-focus-within/search:text-ink-secondary" aria-hidden="true" />
      <input
        data-menu-search
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("model.search")}
        aria-label={local ? t("model.searchLocal") : t("model.search")}
        className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] text-ink outline-none placeholder:text-ink-tertiary"
      />
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

const RAIL_LABEL = "pb-0.5 text-center text-[11px] leading-[14px] text-ink-tertiary";

export function ModelEngineRail({ instances, selectedInstance, claudeInstance, openaiInstance, onSelect, onAddApiKeys }: {
  instances: InstanceInfo[];
  selectedInstance?: InstanceInfo;
  claudeInstance?: InstanceInfo;
  openaiInstance?: InstanceInfo;
  onSelect: (instance: InstanceInfo) => void;
  onAddApiKeys?: () => void;
}) {
  const { subscription, api, custom: local } = railProviders(instances, selectedInstance, claudeInstance, openaiInstance);
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
        className={cn(
          "group relative flex size-9 shrink-0 items-center justify-center rounded-[8px]",
          selected ? "bg-ink/[0.08]" : "hover:bg-ink/[0.06]",
          managedBy && "opacity-40",
        )}
      >
        <InstanceProviderMark instance={target} size={18} subtle={!selected} />
        {target.access === "api" && (
          <span data-rail-key-badge className="absolute bottom-0 left-0 flex size-3.5 items-center justify-center rounded-full bg-menu text-ink-secondary">
            <KeyRound size={9} aria-hidden="true" />
          </span>
        )}
        {attention && <span className="absolute bottom-0.5 right-0.5 size-1.5 rounded-full bg-warning ring-2 ring-menu" />}
      </button>
    );
  };
  return (
    <div className="flex w-14 shrink-0 flex-col gap-1 overflow-y-auto border-r-[0.5px] border-ink/10 p-2">
      {subscription.length > 0 && <div className={cn(RAIL_LABEL, "pt-0.5")}>{t("model.rail.cloud")}</div>}
      {subscription.map(railButton)}
      {(api.length > 0 || onAddApiKeys) && <div className={cn(RAIL_LABEL, subscription.length > 0 ? "pt-2" : "pt-0.5")}>{t("model.rail.apiKeys")}</div>}
      {api.map(railButton)}
      {onAddApiKeys && (
        <button
          type="button"
          data-rail-add-api-key
          onClick={onAddApiKeys}
          aria-label={apiKeysLabel(instances)}
          title={apiKeysLabel(instances)}
          className="flex size-9 shrink-0 items-center justify-center rounded-[8px] border border-dashed border-ink/20 text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink"
        >
          <Plus size={16} strokeWidth={MENU_STROKE} aria-hidden="true" />
        </button>
      )}
      {local.length > 0 && <div className={cn(RAIL_LABEL, "pt-2")}>{t("model.rail.local")}</div>}
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
    <label className="mt-2 flex min-w-0 items-center gap-2 text-[12px] leading-4 text-ink-secondary">
      <span>{t("model.account")}:</span>
      <Select size="sm" variant="quiet" className="flex-1"
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
