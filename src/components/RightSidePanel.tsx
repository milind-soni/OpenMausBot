import { useEffect, type ComponentProps, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { roundButtonCls } from "./bot-panel/rows";

const PANEL = "[data-right-side-panel]";
const BLOCKING = `:is(dialog[open], [aria-modal="true"], [role="menu"]):not(${PANEL}, [inert], [inert] *)`;

export function useRightSidePanelEscape(name: string, open: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector(BLOCKING)) return;
      const modal = document.querySelector(`${PANEL}[aria-modal="true"]:not([inert], [inert] *)`);
      const focused = event.target instanceof Element ? event.target.closest(PANEL) : null;
      const panels = document.querySelectorAll(`${PANEL}:not([inert], [inert] *)`);
      const panel = modal ?? focused ?? panels[panels.length - 1];
      if (panel?.getAttribute("data-right-side-panel") !== name) return;
      event.preventDefault();
      onEscape();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [name, open, onEscape]);
}

export function RightSidePanel({ className, ...props }: ComponentProps<"aside">) {
  return <aside {...props} className={cn("relative flex h-full max-w-full shrink-0 flex-col overflow-hidden border-l-[0.5px] border-ink/[0.06] bg-app", className)} />;
}

export function RightSidePanelHeader({ children, label, onClose, className, ...props }: ComponentProps<"div"> & {
  children: ReactNode;
  label: string;
  onClose: () => void;
}) {
  return (
    <div {...props} className={cn("flex h-[50px] shrink-0 items-start gap-2.5 px-[13px] pt-[13px]", className)}>
      {children}
      <button type="button" data-side-panel-close onClick={onClose} aria-label={label} title={label} className={roundButtonCls}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
