import { Check } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export interface SelectPopupOption {
  label: string;
  disabled: boolean;
  group?: string;
}

/** A page's dropdown list, drawn by the viewer where the page has it: headless Chrome's own popup reaches no frame. */
export function SelectPopup({ options, selectedIndex, anchor, bounds, onChoose, onClose }: {
  options: SelectPopupOption[];
  selectedIndex: number;
  /** The list's box on the surface, in CSS pixels. */
  anchor: { left: number; top: number; width: number; height: number };
  /** The surface's own size, so the popup opens upward when there is no room below. */
  bounds: { width: number; height: number };
  onChoose: (index: number) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(() => (selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled)));
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  const below = bounds.height - (anchor.top + anchor.height);
  const above = anchor.top;
  const upward = below < 160 && above > below;
  const maxHeight = Math.max(96, Math.min(320, (upward ? above : below) - 8));
  const left = Math.max(0, Math.min(anchor.left, bounds.width - Math.max(anchor.width, 160)));
  const step = (from: number, direction: 1 | -1) => {
    for (let at = from + direction; at >= 0 && at < options.length; at += direction) if (!options[at]!.disabled) return at;
    return from;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => step(current, event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? step(-1, 1) : step(options.length, -1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (options[active] && !options[active]!.disabled) onChoose(active);
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  let group: string | undefined;
  return (
    <>
      <div className="absolute inset-0 z-30" aria-hidden="true" onPointerDown={(event) => { event.preventDefault(); onClose(); }} />
      <div
        ref={list}
        role="listbox"
        aria-label="Choose an option"
        aria-activedescendant={active >= 0 ? `select-option-${active}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose(); }}
        className="absolute z-40 overflow-y-auto rounded-lg border border-hairline/60 bg-menu py-1 text-[13px] text-ink shadow-xl outline-none"
        style={{
          left,
          minWidth: Math.max(anchor.width, 160),
          maxHeight,
          ...(upward ? { bottom: bounds.height - anchor.top + 2 } : { top: anchor.top + anchor.height + 2 }),
        }}
      >
        {options.map((option, index) => {
          const heading = option.group !== undefined && option.group !== group ? option.group : null;
          group = option.group;
          return (
            <div key={index}>
              {heading !== null ? <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium text-ink-tertiary" role="presentation">{heading}</div> : null}
              <div
                id={`select-option-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === selectedIndex}
                aria-disabled={option.disabled || undefined}
                onPointerEnter={() => { if (!option.disabled) setActive(index); }}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => { if (!option.disabled) onChoose(index); }}
                className={`flex cursor-default items-center gap-2 px-3 py-1.5 ${option.group !== undefined ? "pl-5" : ""} ${option.disabled ? "text-ink-tertiary" : index === active ? "bg-accent text-accent-ink" : ""}`}
              >
                <span className="min-w-0 flex-1 truncate">{option.label || " "}</span>
                {index === selectedIndex ? <Check size={13} aria-hidden="true" /> : null}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
