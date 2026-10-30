import { Mic, Plus } from "lucide-react";
import { t } from "@/lib/i18n";

/** The app's chat area while the first run's Chief step is up: nothing in it yet, and nothing to press. */
export function EmptyChatShell() {
  return (
    <main inert aria-hidden="true" data-empty-chat="" className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className="absolute inset-x-[50px] bottom-[17px] flex h-11 items-center gap-2 rounded-[22px] border-[0.5px] border-ink/10 bg-composer px-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink/[0.04] text-ink-secondary"><Plus size={16} /></span>
        <span className="min-w-0 flex-1 truncate text-[14px] text-ink-tertiary">{t("onboarding.shell.placeholder")}</span>
        <span className="flex size-7 shrink-0 items-center justify-center text-ink-secondary"><Mic size={16} /></span>
      </div>
    </main>
  );
}
