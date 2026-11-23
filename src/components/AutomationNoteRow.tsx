import { useId, useState } from "react";
import { ChevronRight, Clock3 } from "lucide-react";
import { automationNote, automationNoteTitle, knownWaits, resumedText, type AutomationNote } from "@/lib/automation-note";
import { cn } from "@/lib/cn";
import { intlLocale, t } from "@/lib/i18n";
import type { Message } from "@/state/store";

/** The note for a line an automation started a turn with, or null for every other line. `transcript` holds the wait's own card. */
export function automationNoteRow(message: Message, transcript: readonly Message[]) {
  const note = automationNote(message, knownWaits(transcript));
  return note ? <AutomationNoteRow message={message} note={note} /> : null;
}

/** The line an automation started a turn with, in the app's words; what it told the bot stays behind a disclosure. */
export function AutomationNoteRow({ message, note }: { message: Message; note: AutomationNote }) {
  const [open, setOpen] = useState(false);
  const instructionsId = useId();
  const resumed = resumedText(note);
  return (
    <div data-look="automation-note" data-testid="automation-note" className="flex w-full justify-start" title={new Date(message.at).toLocaleString(intlLocale())}>
      <div className="w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[13px] leading-[18px] text-ink-secondary">
        <div className="flex min-w-0 gap-2">
          <Clock3 size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <span dir="auto" className="min-w-0 [overflow-wrap:anywhere]">{automationNoteTitle(note)}</span>
              {note.instructions && (
                // On touch the 40px target overhangs the line instead of making the note taller.
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={instructionsId}
                  onClick={() => setOpen((shown) => !shown)}
                  className="flex shrink-0 items-center gap-1 rounded text-ink transition-colors touch:-my-3 touch:min-h-10 duration-[120ms] hover:text-ink-secondary motion-reduce:transition-none"
                >
                  <ChevronRight size={12} aria-hidden="true" className={cn("shrink-0", open ? "rotate-90" : "rtl:-scale-x-100")} />
                  {t(open ? "chat.automationNote.hide" : "chat.automationNote.show")}
                </button>
              )}
            </div>
            {(note.wait !== undefined || note.unnamed) && resumed && <p className="mt-0.5 text-[12px] leading-4 text-ink-tertiary">{resumed}</p>}
          </div>
        </div>
        {note.instructions && (
          <div id={instructionsId} hidden={!open} dir="auto" className="mt-2 border-t border-hairline/40 pt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {note.instructions}
          </div>
        )}
      </div>
    </div>
  );
}
