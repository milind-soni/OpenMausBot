import { ChevronDown } from "lucide-react";
import { useContext, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { SettingRow, SettingsLook, SettingsMark } from "./SettingsPrimitives";
import type { BotMoveDialogProps } from "./BotMoveDialog";

const BUTTON = "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-40";

export function BotImportSection({ source, title, mark, Dialog }: { source: string; title: string; mark: ReactNode; Dialog: (props: BotMoveDialogProps) => ReactNode }) {
  const [started, setStarted] = useState(false);
  const [open, setOpen] = useState(false);
  if (useContext(SettingsLook)) {
    return (
      <div data-import-section={source} data-settings-block={`${source}-move`} className="flex flex-col">
        <SettingRow title={title} subtitle={t("settings.import.grokLine")} leading={<SettingsMark>{mark}</SettingsMark>}>
          <button type="button" className="ui-button" {...{ [`data-${source}-move-open`]: "" }} aria-expanded={open} onClick={() => { setStarted(true); setOpen(!open); }}>{t(open ? "common.close" : "settings.import.moveAction")}</button>
        </SettingRow>
        {started && <div className={open ? "px-4 pb-3" : "hidden"}><Dialog inline onClose={() => { setStarted(false); setOpen(false); }} /></div>}
      </div>
    );
  }
  return (
    <section data-import-section={source} className="rounded-xl bg-card p-4">
      <div className="flex items-center gap-2 text-[15px] font-medium text-ink">{mark}{title}</div>
      <div className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">{t("settings.import.grokSubtitle")}</div>
      <button type="button" {...{ [`data-${source}-move-open`]: "" }} aria-expanded={open} onClick={() => { setStarted(true); setOpen(!open); }} className={cn(BUTTON, "mt-3")}>
        {title}
        <ChevronDown size={14} aria-hidden="true" className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {started && <div className={open ? undefined : "hidden"}><Dialog inline onClose={() => { setStarted(false); setOpen(false); }} /></div>}
    </section>
  );
}

