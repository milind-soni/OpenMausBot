// The model picker as Simple mode shows it: every provider the picker knows in
// a narrow column on the left (one on an API key carries a small key), that
// provider's models by name on the right, and along the bottom how hard the
// bot thinks and whether new chats follow. A long model list opens in place
// with "Show all" (and a search box when it is very long), so no model needs
// the full picker; only a provider that needs setup goes there.
import type { ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, KeyRound } from "lucide-react";
import type { InstanceInfo } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";
import { InstanceProviderMark } from "./ProviderIcons";
import type { RailProvider } from "./ModelPicker";
import { friendlyEffort, modelBlurb } from "@/lib/model-friendly";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

type ModelOption = InstanceInfo["models"]["options"][number];

export function SimpleModelPane({
  botName,
  providers,
  onProvider,
  needsSetup,
  onSetUp,
  models,
  query,
  showAll,
  search,
  currentModelId,
  onPick,
  effort,
  variantsRow,
  newChats,
  onManage,
}: {
  botName: string;
  providers: RailProvider[];
  onProvider: (instance: InstanceInfo) => void;
  /** The browsed provider cannot list models yet (setup, sign-in or policy). */
  needsSetup?: { name: string } | null;
  /** Opens the full picker on the browsed provider's setup. */
  onSetUp: () => void;
  /** The rows to show now: suggested, every model, or search results. */
  models: ModelOption[];
  /** The search the rows are filtered by, if any. */
  query?: string;
  /** The provider has more models than the rows show. */
  showAll?: { count: number; onShow: () => void } | null;
  /** A search box over the opened list, when it is long. */
  search?: ReactNode;
  currentModelId?: string;
  onPick: (modelId: string) => void;
  effort?: { levels: EffortLevel[]; current?: EffortLevel; onPick: (level: EffortLevel) => void } | null;
  /** Engines that name their reasoning modes keep their own control. */
  variantsRow?: ReactNode;
  /** Only in a thread: whether the pick also becomes the bot's default. */
  newChats?: { checked: boolean; onChange: (checked: boolean) => void } | null;
  onManage: () => void;
}) {
  const row = "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";
  const note = "px-2 py-1.5 text-[12.5px] text-ink-secondary";
  return (
    <div data-simple-model-pane className="flex min-h-0 w-full flex-col">
      <div className="flex min-h-0 flex-1">
        {/* Providers: every one the picker knows, in a quiet column. */}
        <div
          data-simple-providers
          role="group"
          aria-label={t("model.simple.provider")}
          className="flex w-32 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-hairline/40 bg-panel p-1.5"
        >
          {providers.map((provider) => {
            // The same vendor can sit here twice (a sign-in and a pasted
            // key); the key marks which is which.
            const apiKey = provider.target.access === "api";
            return (
              <button
                key={provider.instance.instanceId}
                type="button"
                data-simple-provider={provider.instance.instanceId}
                aria-pressed={provider.selected}
                aria-label={apiKey ? `${provider.label} · ${t("model.simple.apiKey")}` : undefined}
                title={apiKey ? `${provider.label} · ${t("model.apiKeyHint")}` : provider.label}
                onClick={() => onProvider(provider.target)}
                className={cn(
                  row,
                  "font-medium",
                  provider.selected ? "bg-raised-hover text-accent-text" : "text-ink hover:bg-control/60",
                )}
              >
                <InstanceProviderMark instance={provider.target} size={16} />
                <span className="min-w-0 flex-1 truncate">{provider.label}</span>
                {apiKey && <KeyRound data-simple-key size={11} className="shrink-0 opacity-60" aria-hidden="true" />}
              </button>
            );
          })}
        </div>

        {/* Models for the chosen provider, or what it needs first. */}
        <div data-simple-models className="flex min-h-0 min-w-0 flex-1 flex-col">
          {search && <div data-simple-model-search className="shrink-0 pt-2">{search}</div>}
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {providers.length === 0 ? (
              <p className={note}>{t("model.noProviders")}</p>
            ) : needsSetup ? (
              <div className="flex flex-col items-start gap-3 px-2 py-1.5 text-[12.5px] text-ink-secondary">
                <span>{t("model.simple.needsSetup", { name: needsSetup.name })}</span>
                <button type="button" data-simple-set-up onClick={onSetUp} className="rounded-full bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                  {t("model.simple.setUp")}
                </button>
              </div>
            ) : models.length === 0 ? (
              <p className={note}>{query ? t("model.noMatch", { query: query.trim() }) : t("model.simple.noModels")}</p>
            ) : (
              <>
                <div className="flex flex-col gap-0.5" role="group" aria-label={t("model.simple.model")}>
                  {models.map((option) => {
                    const current = option.id === currentModelId;
                    // Names only; a blurb is a hover hint, never a second line.
                    const blurb = modelBlurb(option);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={current}
                        title={blurb ? `${option.label} · ${blurb}` : option.label}
                        onClick={() => onPick(option.id)}
                        className={cn(row, "font-medium text-ink", current ? "bg-raised-hover" : "hover:bg-control/60")}
                      >
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        {current && <Check size={14} className="shrink-0 text-accent-text" aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
                {showAll && (
                  <button
                    type="button"
                    data-simple-show-all
                    onClick={showAll.onShow}
                    className={cn(row, "mt-0.5 text-[12px] text-ink-secondary hover:bg-control/60 hover:text-ink")}
                  >
                    <span className="min-w-0 flex-1 truncate">{t("model.showAll", { count: showAll.count })}</span>
                    <ChevronDown size={13} className="shrink-0" aria-hidden="true" />
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Effort and scope along the bottom, spanning both columns. */}
      <div data-simple-effort-band className="flex shrink-0 flex-col gap-2.5 border-t border-hairline/40 px-3 py-2.5">
        {variantsRow ?? (effort && effort.levels.length > 0 && (
          <div
            data-simple-effort
            className="grid w-full gap-1 rounded-xl bg-inset p-1"
            style={{ gridTemplateColumns: `repeat(${effort.levels.length}, minmax(0, 1fr))` }}
            role="group"
            aria-label={t("model.simple.effort")}
          >
            {effort.levels.map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={effort.current === level}
                onClick={() => effort.onPick(level)}
                className={cn(
                  "truncate rounded-lg px-1 py-1.5 text-[12.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                  effort.current === level ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                )}
              >
                {friendlyEffort(level)}
              </button>
            ))}
          </div>
        ))}

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          {newChats ? (
            <label className="flex min-w-0 cursor-pointer items-center gap-2 text-[12px] text-ink">
              <input
                type="checkbox"
                checked={newChats.checked}
                onChange={(event) => newChats.onChange(event.target.checked)}
                className="size-4 shrink-0 accent-[var(--color-accent)]"
              />
              {t("model.simple.newChats", { name: botName })}
            </label>
          ) : <span />}
          <button
            type="button"
            data-simple-manage
            onClick={onManage}
            className="-mr-1 ml-auto flex shrink-0 items-center gap-0.5 rounded-lg px-1 py-1 text-[12px] font-medium text-accent-text hover:bg-control/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {t("model.simple.manage")}
            <ChevronRight size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
