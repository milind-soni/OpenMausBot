// Providers such as Grok narrate before tools.
import { memo, useEffect, useState, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { sameItems } from "@/state/store-select";

type Props = {
  label: string;
  title?: string;
  forceOpen?: boolean;
} & ({ children: ReactNode; steps?: never; step?: never } | { steps: readonly Message[]; step: (message: Message) => ReactNode; children?: never });

const sameProps = (a: Props, b: Props) =>
  a.label === b.label && a.title === b.title && a.forceOpen === b.forceOpen && a.children === b.children && a.step === b.step &&
  (a.steps === b.steps || (a.steps !== undefined && b.steps !== undefined && sameItems(a.steps, b.steps)));

export const TurnNarrationRun = memo(function TurnNarrationRun({ label, title, forceOpen = false, children, steps, step }: Props) {
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-start">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={title ?? t(open ? "chat.narration.hide" : "chat.narration.show")}
          className="ui-pill"
        >
          <Check size={13} className="text-success" />
          <span>{label}</span>
          <ChevronRight size={13} className={open ? "rotate-90" : undefined} />
        </button>
      </div>
      {open && (steps ? steps.map(step) : children)}
    </div>
  );
}, sameProps);
