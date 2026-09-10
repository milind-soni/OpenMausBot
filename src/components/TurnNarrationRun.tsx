// A settled turn's intermediate assistant messages. Providers such as Grok
// narrate before tools; the messages stay available without looking like six
// separate final answers after the turn is done.
import { t } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { Check, ChevronRight } from "lucide-react";

export function TurnNarrationRun({
  label,
  forceOpen = false,
  children,
}: {
  label: string;
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
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
          title={open ? t("turn.hideProgress") : t("turn.showProgress")}
          className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control"
        >
          <Check size={13} className="text-success" />
          <span>{label}</span>
          <ChevronRight size={13} className={open ? "rotate-90" : undefined} />
        </button>
      </div>
      {open && children}
    </div>
  );
}
