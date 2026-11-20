import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Check, X } from "lucide-react";
import { engineDisplayName } from "@/lib/engine-rail";
import { t } from "@/lib/i18n";
import { choiceIsSelected, modelChoices, type ModelChoice } from "@/lib/model-choices";
import { modelOptionLabel } from "@/lib/model-label";
import type { Bot, InstanceInfo, ModelSelection } from "@/state/store";
import { needsCli, needsSignIn } from "./EngineSetup";
import { cn } from "@/lib/cn";
import { sidebarRowTone } from "./SidebarRowMarkers";
import { BotAvatar } from "./Avatar";
import { InstanceProviderMark } from "./ProviderIcons";

export function PhoneModelSheet({ updatesDefault, id, bot, closing, instances, instance, selection, loading, onInstance, onPick, onClose, children }: {
  updatesDefault: boolean;
  id: string;
  bot: Bot;
  closing: boolean;
  instances: InstanceInfo[];
  instance?: InstanceInfo;
  selection: ModelSelection;
  loading: boolean;
  onInstance(instance: InstanceInfo): void;
  onPick(instance: InstanceInfo, choice: ModelChoice): void;
  onClose(): void;
  children?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const sheet = dialog.current!;
    sheet.showModal();
    const body = content.current!;
    const measure = () => sheet.style.setProperty("--sheet-height", `${body.getBoundingClientRect().height}px`);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(body);
    return () => { observer?.disconnect(); sheet.close(); };
  }, []);
  const choices = instance ? modelChoices(instance, instance.models.options) : [];
  const message = !instance ? t("model.noProviders")
    : instance.policy ? t("policy.modelBlocked", { organization: instance.policy.organizationName })
    : needsCli(instance) ? t("model.simple.needsSetup", { name: engineDisplayName(instance) })
    : loading && !choices.length ? t("model.simple.lookingModels")
    : !choices.length ? t("model.simple.noModels") : null;
  return (
    <dialog ref={dialog} id={id} data-phone-model-sheet={closing ? "closing" : "open"} aria-label={t("model.choose")}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === dialog.current) onClose(); }}
      className="fixed inset-x-0 bottom-0 top-auto m-0 w-full max-w-none overflow-hidden rounded-t-[24px] bg-composer p-0 text-ink shadow-(--shadow-float) backdrop:bg-black/40">
      <div ref={content} inert={closing || undefined} className="flex max-h-[min(68dvh,34rem)] flex-col pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <header className="flex shrink-0 items-center gap-3 px-5 pb-3 pt-5">
          <BotAvatar bot={bot} size={40} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[18px] font-semibold leading-6">{bot.name}</h2>
            <p className="text-[13px] leading-5 text-ink-secondary">{t(updatesDefault ? "model.section.default" : "model.scope.thread")}</p>
          </div>
          <button type="button" aria-label={t("common.close")} onClick={onClose} className="grid size-11 shrink-0 place-items-center rounded-full text-ink-secondary interaction:bg-raised/50">
            <X size={18} />
          </button>
        </header>
        {children ?? <>
          {instances.length > 0 && <div role="group" aria-label={t("model.account")} className="flex shrink-0 flex-nowrap gap-1.5 overflow-x-auto overscroll-x-contain px-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {instances.map(item => <button key={item.instanceId} type="button" aria-pressed={item.instanceId === instance?.instanceId}
              onClick={() => onInstance(item)}
              className={cn("flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-hairline px-3 text-[13px] font-medium text-ink-secondary transition-colors aria-pressed:border-transparent aria-pressed:text-ink", sidebarRowTone(item.instanceId === instance?.instanceId))}>
              <InstanceProviderMark instance={item} size={15} />
              {engineDisplayName(item)}
            </button>)}
          </div>}
          <div key={instance?.instanceId} data-phone-model-list className="min-h-0 overflow-y-auto overscroll-contain border-t border-hairline/50 px-4 pt-2">
            {message ? <p role="status" className="px-2 py-4 text-sm text-ink-secondary">{message}</p> : instance && choices.map(choice => {
              const selected = selection.instanceId === instance.instanceId && (choice.variant === undefined ? selection.model === choice.id : choiceIsSelected(choice, selection));
              const unavailable = choice.orgBlocked || choice.needsCliUpdate !== undefined || (!choice.custom && needsSignIn(instance));
              return <button type="button" key={choice.id} disabled={unavailable} aria-pressed={selected} onClick={() => onPick(instance, choice)}
                className={cn("flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-[15px] transition-colors disabled:text-ink-tertiary", sidebarRowTone(selected))}>
                <span className="min-w-0 flex-1 break-words">{modelOptionLabel(choice)}</span>
                {unavailable && <span className="text-xs">{t("model.simple.unavailable")}</span>}
                {selected && <Check size={16} strokeWidth={1.75} className="shrink-0 text-ink-secondary" aria-hidden="true" />}
              </button>;
            })}
          </div>
        </>}
      </div>
    </dialog>
  );
}
