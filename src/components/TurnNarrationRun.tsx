// Providers such as Grok narrate before tools.
import { useEffect, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { t } from "@/lib/i18n";


export function TurnNarrationRun({
  label,
  title,
  forceOpen = false,
  children,
}: {
  label: string;
  title?: string;
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
          title={title ?? (open ? t("ui.turnNarrationRun.hideProgressMessages") : t("ui.turnNarrationRun.showProgressMessages"))}
          className="ui-pill"
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
