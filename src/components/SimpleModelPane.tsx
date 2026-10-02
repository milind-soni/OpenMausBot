// The model picker as Simple mode shows it: providers in a column on the
// left, that provider's models by name on the right, and along the bottom how
// hard the bot thinks and whether new chats follow. Everything else the
// full picker does (API-key and local engines, every model, accounts, setup)
// is one "More" away, in the same popover.
import type { ReactNode } from "react";
import { Check, ChevronRight, MoreHorizontal } from "lucide-react";
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
  models,
  currentModelId,
  onPick,
  effort,
  variantsRow,
  newChats,
  onMore,
  onManage,
}: {
  botName: string;
  providers: RailProvider[];
  onProvider: (instance: InstanceInfo) => void;
  /** The browsed provider cannot list models yet (setup, sign-in or policy). */
  needsSetup?: { name: string } | null;
  models: ModelOption[];
  currentModelId?: string;
  onPick: (modelId: string) => void;
  effort?: { levels: EffortLevel[]; current?: EffortLevel; onPick: (level: EffortLevel) => void } | null;
  /** Engines that name their reasoning modes keep their own control. */
  variantsRow?: ReactNode;
  /** Only in a thread: whether the pick also becomes the bot's default. */
  newChats?: { checked: boolean; onChange: (checked: boolean) => void } | null;
  onMore: () => void;
  onManage: () => void;
}) {
  const thinkLabel = t("model.simple.think", { name: botName });
  const row = "flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";
  return (
    <div data-simple-model-pane className="flex min-h-0 w-full flex-col">
      <div className="flex min-h-0 flex-1">
        {/* Providers: a quiet column on the left; More is its last row. */}
        <div
          data-simple-providers
          role="group"
          aria-label={t("model.simple.provider")}
          className="flex w-[150px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-hairline/40 bg-panel p-2"
        >
          {providers.map((provider) => (
            <button
              key={provider.instance.instanceId}
              type="button"
              aria-pressed={provider.selected}
              onClick={() => onProvider(provider.target)}
              className={cn(
                row,
                "text-[13px] font-medium",
                provider.selected ? "bg-raised-hover text-accent-text" : "text-ink hover:bg-control/60",
              )}
            >
              <InstanceProviderMark instance={provider.target} size={18} />
              <span className="min-w-0 flex-1 truncate">{provider.label}</span>
            </button>
          ))}
          <button
            type="button"
            data-simple-model-more
            onClick={onMore}
            title={t("model.simple.moreOptions")}
            aria-label={`${t("model.simple.more")}: ${t("model.simple.moreOptions")}`}
            className={cn(row, "text-[13px] font-medium text-ink-secondary hover:bg-control/60 hover:text-ink")}
          >
            <MoreHorizontal size={18} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{t("model.simple.more")}</span>
            <ChevronRight size={14} className="shrink-0 opacity-60" aria-hidden="true" />
          </button>
        </div>

        {/* Models for the chosen provider, or what it needs first. */}
        <div data-simple-models className="min-h-0 min-w-0 flex-1 overflow-y-auto p-2">
          {needsSetup ? (
            <div className="flex flex-col items-start gap-3 px-2.5 py-2 text-[12.5px] text-ink-secondary">
              <span>{t("model.simple.needsSetup", { name: needsSetup.name })}</span>
              <button type="button" onClick={onMore} className="rounded-full bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                {t("model.simple.setUp")}
              </button>
            </div>
          ) : models.length === 0 ? (
            <p className="px-2.5 py-2 text-[12.5px] text-ink-secondary">{t("model.simple.noModels")}</p>
          ) : (
            <div className="flex flex-col gap-0.5" role="group" aria-label={t("model.simple.model")}>
              {models.map((option) => {
                const current = option.id === currentModelId;
                const blurb = modelBlurb(option);
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={current}
                    onClick={() => onPick(option.id)}
                    className={cn(row, "gap-3", current ? "bg-raised-hover" : "hover:bg-control/60")}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13.5px] font-semibold text-ink">{option.label}</span>
                      {blurb && <span className="truncate text-[12px] text-ink-secondary">{blurb}</span>}
                    </span>
                    {current && <Check size={15} className="shrink-0 text-accent-text" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Effort and scope along the bottom, spanning both columns. */}
      <div data-simple-effort-band className="flex shrink-0 flex-col gap-3 border-t border-hairline/40 px-4 py-3">
        {variantsRow ?? (effort && effort.levels.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <span className="text-[12.5px] font-medium text-ink">{thinkLabel}</span>
            <div
              className="grid min-w-[240px] flex-1 gap-1 rounded-xl bg-inset p-1"
              style={{ gridTemplateColumns: `repeat(${effort.levels.length}, minmax(0, 1fr))` }}
              role="group"
              aria-label={thinkLabel}
            >
              {effort.levels.map((level) => (
                <button
                  key={level}
                  type="button"
                  aria-pressed={effort.current === level}
                  onClick={() => effort.onPick(level)}
                  className={cn(
                    "rounded-lg px-1 py-1.5 text-[12.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                    effort.current === level ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {friendlyEffort(level)}
                </button>
              ))}
            </div>
          </div>
        ))}

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {newChats ? (
            <label className="flex min-w-0 cursor-pointer items-center gap-2 text-[12.5px] text-ink">
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
            className="-mr-1.5 ml-auto flex shrink-0 items-center gap-0.5 rounded-lg px-1.5 py-1 text-[12.5px] font-medium text-accent-text hover:bg-control/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {t("model.simple.manage")}
            <ChevronRight size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
