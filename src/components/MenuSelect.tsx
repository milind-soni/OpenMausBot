// A short choice list drawn like the voice picker: a field that opens a themed sheet, where a native select element would
// open the platform's own list. The sheet floats in a portal so a settings panel's scroll area never clips it.
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/cn";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { useMenuMotion } from "./MenuMotion";
import { voiceListPlace, type VoiceListPlace } from "./VoicePicker";

export interface MenuSelectOption {
  value: string;
  label: string;
  /** Rows sharing a group sit under one heading, in the order given. */
  group?: string;
}

const isRtl = (element: Element | null) =>
  typeof getComputedStyle === "function" && element ? getComputedStyle(element).direction === "rtl" : false;

export function MenuSelect({ value, options, onChange, disabled, ariaLabel, className, "data-testid": testId }: {
  value: string;
  options: MenuSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  "data-testid"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<VoiceListPlace | null>(null);
  const [active, setActive] = useState(0);
  const motion = useMenuMotion(open);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  const show = () => {
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };
  const close = () => setOpen(false);
  const pick = (option: MenuSelectOption | undefined) => {
    if (!option) return;
    close();
    triggerRef.current?.focus();
    if (option.value !== value) onChange(option.value);
  };

  const inside = useRef({
    contains: (target: unknown) => [rootRef.current, sheetRef.current].some((node) => node?.contains(target as Node)),
  });
  usePopoverDismiss(open, inside, close);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = (event?: Event) => {
      if (event?.target instanceof Node && sheetRef.current?.contains(event.target)) return;
      const trigger = triggerRef.current;
      if (trigger) setPlace(voiceListPlace(trigger.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, isRtl(trigger)));
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = options.length - 1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) return show();
      setActive((index) => Math.min(last, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (open && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      pick(options[active]);
    } else if (open && event.key === "Tab") {
      close();
    }
  };

  const sheet = motion.shown && (
    <div
      ref={sheetRef}
      {...motion.exitProps}
      style={{ position: "fixed", ...place, visibility: place ? undefined : "hidden" }}
      className={cn(
        "popover-surface z-[70] flex flex-col overflow-hidden rounded-xl border border-hairline/50 bg-menu shadow-2xl shadow-black/50",
        motion.className,
      )}
    >
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        // Keep the focus on the field when a row is clicked.
        onMouseDown={(event) => event.preventDefault()}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
      >
        {options.map((option, index) => {
          const current = option.value === value;
          const heading = option.group && option.group !== options[index - 1]?.group;
          return (
            <div key={option.value}>
              {heading && (
                <div role="presentation" className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                  {option.group}
                </div>
              )}
              <div
                id={`${listId}-${index}`}
                role="option"
                aria-selected={current}
                data-index={index}
                onMouseMove={() => index !== active && setActive(index)}
                onClick={() => pick(option)}
                className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5", index === active && "bg-raised")}
              >
                <span className={cn("min-w-0 flex-1 truncate text-[13px] leading-5 text-ink", current && "font-medium")}>{option.label}</span>
                {current && <Check size={14} aria-hidden className="shrink-0 text-accent" />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className={cn("min-w-0", className)}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        data-testid={testId}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKey}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 rounded-lg border bg-inset py-2 pl-3 pr-2 text-start text-[13px] text-ink disabled:cursor-default disabled:opacity-50",
          open ? "border-focus" : "border-hairline/40",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? value}</span>
        <ChevronDown size={14} aria-hidden className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>
      {sheet && typeof document !== "undefined" ? createPortal(sheet, document.body) : null}
    </div>
  );
}
