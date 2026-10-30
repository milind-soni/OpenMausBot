import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, LifeBuoy, Plus } from "lucide-react";

import { cn } from "@/lib/cn";
import { configuredModelInstances } from "@/lib/engine-rail";
import { t } from "@/lib/i18n";
import type { Typeahead } from "@/lib/menu-keys";
import { pickerPlacement, type PickerPlacement } from "@/lib/picker-placement";
import { shortModelLabel } from "@/lib/model-friendly";
import { modelName, providerName, simpleModelMenu } from "@/lib/simple-model-menu";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { useStore, type Bot, type InstanceInfo } from "@/state/store";
import { useMenuMotion } from "../MenuMotion";
import { modelMenuKey, modelMenuPointerMove } from "../model-menu-keys";
import { SIMPLE_POPOVER_WIDTH } from "../ModelPicker";
import { InstanceProviderMark } from "../ProviderIcons";
import { SimpleModelMenu } from "../SimpleModelMenu";
import { buttonCls, Card, ColRow, RowIcon, RowText, TrashButton } from "./rows";

type Backup = NonNullable<Bot["fallback"]>[number];

/** As many as the server keeps for one bot. */
export const MAX_BACKUPS = 5;

const NO_SELECTION = { instanceId: "", model: "" };
const NOTHING_PROBED: ReadonlySet<string> = new Set();

function BackupChooser({ bot, current, exclude, onPick, label, title, buttonRef, className, children, ...rest }: {
  bot: Bot;
  current: Backup | null;
  exclude: ReadonlySet<string>;
  onPick: (backup: Backup) => void;
  label: string;
  title?: string;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  className: string;
  children: ReactNode;
  "data-panel-action"?: string;
}) {
  const { state, dispatch, refreshInstances, refreshModels } = useStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [placement, setPlacement] = useState<PickerPlacement | null>(null);
  const ownRef = useRef<HTMLButtonElement>(null);
  const triggerRef = buttonRef ?? ownRef;
  const menuRef = useRef<HTMLDivElement>(null);
  const typed = useRef<Typeahead | null>(null);
  const focusOnPlace = useRef(false);
  const menuId = useId();
  const motion = useMenuMotion(open);
  const inside = useRef({ contains: (target: unknown) => [triggerRef.current, menuRef.current].some((node) => node?.contains(target as Node)) });
  usePopoverDismiss(open, inside, () => setOpen(false));

  useLayoutEffect(() => {
    if (!open) return;
    const place = (event?: Event) => {
      if (event?.type === "scroll" && event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      const anchor = triggerRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      setPlacement((locked) => pickerPlacement(anchor, { width: SIMPLE_POPOVER_WIDTH, height: menu.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight }, locked ?? undefined));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open || !placement || !focusOnPlace.current) return;
    focusOnPlace.current = false;
    const menu = menuRef.current;
    const target = menu?.querySelector<HTMLElement>("[data-menu-search]") ?? menu?.querySelector<HTMLElement>("[data-current-model]")
      ?? menu?.querySelector<HTMLElement>("[data-menu-row]:not(:disabled)") ?? menu;
    target?.focus({ preventScroll: true });
  }, [open, placement]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  };
  const openMenu = () => {
    setQuery("");
    setExpanded(new Set());
    setPlacement(null);
    focusOnPlace.current = true;
    setOpen(true);
    setLoading(true);
    void refreshInstances().catch(() => {}).finally(() => setLoading(false));
  };
  const checkAgain = (instance: InstanceInfo) => {
    if (refreshing) return;
    setRefreshing(instance.instanceId);
    void refreshModels(instance.instanceId).catch(() => {}).finally(() => setRefreshing(null));
  };
  const manage = () => {
    close(false);
    dispatch({ type: "toggleAppSettings", open: true, section: "engines" });
  };

  const menuFor = () => {
    const listed = configuredModelInstances(state.instances, current?.instanceId).filter((instance) => !exclude.has(instance.instanceId));
    const built = simpleModelMenu({
      instances: state.instances, listed, selection: current ?? NO_SELECTION,
      bot: { name: bot.name, selection: bot.modelSelection }, query, expanded, probing: NOTHING_PROBED, loading, refreshing,
    });
    return current ? built : { ...built, current: null };
  };

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    if (event.key !== "Escape") return modelMenuKey(event, { query, typed, close: () => close(true) });
    event.preventDefault();
    event.stopPropagation();
    if (query) setQuery("");
    else close(true);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        {...rest}
        aria-label={label}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close(false);
          } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open) {
            event.preventDefault();
            openMenu();
          }
        }}
        className={className}
      >
        {children}
      </button>
      {motion.shown && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          data-backup-menu
          role="dialog"
          aria-label={t("botPanel.backups.choose")}
          aria-modal="false"
          tabIndex={-1}
          {...motion.exitProps}
          onKeyDown={onMenuKey}
          onPointerMove={modelMenuPointerMove}
          style={{
            position: "fixed",
            left: placement?.left ?? 0,
            top: placement?.top,
            bottom: placement?.bottom,
            width: placement?.width ?? SIMPLE_POPOVER_WIDTH,
            maxHeight: placement?.maxHeight,
            transformOrigin: placement?.origin,
            visibility: placement ? undefined : "hidden",
          }}
          className={cn("menu-surface z-[80] flex flex-col overflow-hidden", motion.className)}
        >
          <SimpleModelMenu
            menu={menuFor()}
            query={query}
            bot={bot}
            botModel={{ label: "", title: "" }}
            idPrefix={menuId}
            onQuery={setQuery}
            onPick={(instance, model) => {
              if (instance.policy) return;
              onPick({ instanceId: instance.instanceId, model });
              close(true);
            }}
            onPickCurrent={() => close(true)}
            onFollowBot={() => close(true)}
            onToggle={(instance) => setExpanded((shown) => {
              const next = new Set(shown);
              if (!next.delete(instance.instanceId)) next.add(instance.instanceId);
              return next;
            })}
            onSetUp={manage}
            onCheckAgain={checkAgain}
            onManage={manage}
          />
        </div>,
        document.body,
      )}
    </>
  );
}

export function BackupAis({ bot, onChange }: { bot: Bot; onChange: (fallback: Backup[]) => void }) {
  const { state } = useStore();
  const chain = bot.fallback ?? [];
  const addRef = useRef<HTMLButtonElement>(null);
  const others = (except: number | null) =>
    new Set([bot.modelSelection.instanceId, ...chain.filter((_, index) => index !== except).map((entry) => entry.instanceId)]);
  const describe = (entry: Backup) => {
    const instance = state.instances.find((candidate) => candidate.instanceId === entry.instanceId);
    const option = instance?.models.options.find((candidate) => candidate.id === entry.model);
    const name = modelName(instance, entry.model);
    return { instance, name, short: instance && option ? shortModelLabel(option.label, providerName(instance)) : name };
  };

  return (
    <Card anchor="backups">
      <ColRow data-panel-row="backups">
        <div className="flex items-center gap-2.5">
          <RowIcon icon={LifeBuoy} />
          <RowText title={t("botPanel.backups.title")} />
        </div>
        <p className="-mt-1 pl-[38px] text-[13px] leading-[1.35] text-ink-secondary">{t("botPanel.backups.hint", { name: bot.name })}</p>
        {chain.length > 0 && (
          <ol aria-label={t("botPanel.backups.title")} className="flex flex-col gap-1 pl-[38px]">
            {chain.map((entry, index) => {
              const { instance, name, short } = describe(entry);
              return (
                <li key={entry.instanceId} data-backup={entry.instanceId} className="flex min-w-0 items-center gap-1.5">
                  <span className="w-3 shrink-0 text-[12px] tabular-nums text-ink-tertiary" aria-hidden="true">{index + 1}</span>
                  <BackupChooser
                    bot={bot}
                    current={entry}
                    exclude={others(index)}
                    onPick={(picked) => onChange(chain.map((candidate, at) => (at === index ? picked : candidate)))}
                    label={t("botPanel.backups.row", { position: index + 1, model: name })}
                    title={instance ? `${instance.displayName} · ${name}` : name}
                    data-panel-action="backup-change"
                    className="group flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[9px] bg-ink/[0.04] pl-2.5 pr-2 text-left text-[13px] text-ink hover:bg-ink/[0.07] aria-expanded:bg-ink/[0.08]"
                  >
                    {instance
                      ? <InstanceProviderMark instance={instance} size={14} subtle />
                      : <span className="size-3.5 shrink-0 rounded-full bg-ink/[0.08]" aria-hidden="true" />}
                    <span className="min-w-0 flex-1 truncate">{short}</span>
                    {!instance && <span className="shrink-0 text-[12px] text-warning">{t("model.simple.unavailable")}</span>}
                    <ChevronDown size={12} strokeWidth={2} aria-hidden="true" className="shrink-0 text-ink-tertiary group-hover:text-ink-secondary" />
                  </BackupChooser>
                  <TrashButton
                    data-panel-action="backup-remove"
                    label={t("botPanel.backups.remove", { model: name })}
                    onClick={() => {
                      onChange(chain.filter((_, at) => at !== index));
                      addRef.current?.focus({ preventScroll: true });
                    }}
                  />
                </li>
              );
            })}
          </ol>
        )}
        {chain.length < MAX_BACKUPS && (
          <div className="pl-[38px]">
            <BackupChooser
              bot={bot}
              current={null}
              exclude={others(null)}
              onPick={(picked) => onChange([...chain, picked])}
              label={t("model.fallback.add")}
              buttonRef={addRef}
              data-panel-action="backup-add"
              className={cn(buttonCls, "aria-expanded:bg-raised-hover")}
            >
              <Plus size={14} aria-hidden="true" />
              {t("model.fallback.add")}
            </BackupChooser>
          </div>
        )}
      </ColRow>
    </Card>
  );
}
