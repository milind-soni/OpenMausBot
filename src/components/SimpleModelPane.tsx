// The model picker as Simple mode shows it: pick a provider, a model by name,
// how hard the bot thinks, and whether new chats follow. Everything else the
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
  const label = "text-[12px] font-semibold text-ink-secondary";
  return (
    <div data-simple-model-pane className="flex min-h-0 w-full flex-col gap-3 overflow-y-auto p-4">
      <div className={label}>{t("model.simple.provider")}</div>
      <div className="-mt-1.5 grid grid-cols-4 gap-1.5" role="group" aria-label={t("model.simple.provider")}>
        {providers.map((provider) => (
          <button
            key={provider.instance.instanceId}
            type="button"
            aria-pressed={provider.selected}
            onClick={() => onProvider(provider.target)}
            className={cn(
              "flex min-w-0 flex-col items-center gap-1 rounded-xl border px-1 py-2 text-[12px] font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
              provider.selected ? "border-accent bg-raised-hover" : "border-hairline/50 hover:bg-control/60",
            )}
          >
            <InstanceProviderMark instance={provider.target} size={20} />
            <span className="w-full truncate text-center">{provider.label}</span>
          </button>
        ))}
        <button
          type="button"
          data-simple-model-more
          onClick={onMore}
          title={t("model.simple.moreOptions")}
          className="flex min-w-0 flex-col items-center gap-1 rounded-xl border border-hairline/50 px-1 py-2 text-[12px] font-medium text-ink hover:bg-control/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <MoreHorizontal size={20} className="text-ink-secondary" aria-hidden="true" />
          <span>{t("model.simple.more")}</span>
        </button>
      </div>

      {needsSetup ? (
        <div className="flex items-center gap-3 rounded-xl border border-hairline/50 px-3 py-3 text-[12.5px] text-ink-secondary">
          <span className="flex-1">{t("model.simple.needsSetup", { name: needsSetup.name })}</span>
          <button type="button" onClick={onMore} className="shrink-0 rounded-full bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink">
            {t("model.simple.setUp")}
          </button>
        </div>
      ) : (
        <>
          <div className={label}>{t("model.simple.model")}</div>
          <div className="-mt-2 flex flex-col" role="group" aria-label={t("model.simple.model")}>
            {models.map((option) => {
              const current = option.id === currentModelId;
              const blurb = modelBlurb(option);
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={current}
                  onClick={() => onPick(option.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                    current ? "bg-raised-hover" : "hover:bg-control/60",
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13.5px] font-semibold text-ink">{option.label}</span>
                    {blurb && <span className="truncate text-[12px] text-ink-secondary">{blurb}</span>}
                  </span>
                  {current && <Check size={15} className="shrink-0 text-accent" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </>
      )}

      {variantsRow ?? (effort && effort.levels.length > 0 && (
        <>
          <div className={label}>{t("model.simple.think", { name: botName })}</div>
          <div
            className="-mt-1.5 grid gap-1 rounded-xl bg-inset p-1"
            style={{ gridTemplateColumns: `repeat(${effort.levels.length}, minmax(0, 1fr))` }}
            role="group"
            aria-label={t("model.simple.think", { name: botName })}
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
        </>
      ))}

      {newChats && (
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink">
          <input
            type="checkbox"
            checked={newChats.checked}
            onChange={(event) => newChats.onChange(event.target.checked)}
            className="size-4 accent-[var(--color-accent)]"
          />
          {t("model.simple.newChats", { name: botName })}
        </label>
      )}

      <div className="-mx-4 -mb-4 mt-1 flex border-t border-hairline/40">
        <button type="button" onClick={onMore} className="flex-1 px-4 py-2.5 text-left text-[12px] text-ink-secondary hover:bg-control/60 hover:text-ink">
          {t("model.simple.moreOptions")}
        </button>
        <button type="button" onClick={onManage} className="flex shrink-0 items-center gap-1 px-4 py-2.5 text-[12px] font-medium text-accent-text hover:bg-control/60">
          {t("model.simple.manage")}
          <ChevronRight size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
