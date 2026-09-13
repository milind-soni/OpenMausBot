// Hold-Ctrl+Space dictation indicator — a small pill floating bottom-center
// while the hold is live, then briefly confirming the clipboard write or
// naming what went wrong. Renders nothing in the browser/dev (no bridge) and
// whenever there is neither an active hold nor a note to show.
import { useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";

import { useClipboardDictation } from "@/lib/clipboard-dictation";

export function DictationPill() {
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<number | undefined>(undefined);

  const flash = (message: string) => {
    window.clearTimeout(noteTimer.current);
    setNote(message);
    noteTimer.current = window.setTimeout(() => setNote(null), 5000);
  };

  const active = useClipboardDictation(
    (text) => {
      const write = window.ogb?.writeClipboardText?.(text);
      if (!write) {
        flash("Clipboard unavailable");
        return;
      }
      write
        .then((result) => flash(result.written ? `Copied: ${text}` : "Clipboard unavailable"))
        .catch(() => flash("Clipboard unavailable"));
    },
    (message) => flash(message),
  );

  useEffect(() => () => window.clearTimeout(noteTimer.current), []);

  if (!active && !note) return null;

  return (
    <div className="animate-panel-in fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-hairline/40 bg-panel px-3.5 py-1.5 text-[12.5px] text-ink shadow-2xl shadow-black/50">
      {active ? (
        <span className="flex items-center gap-2">
          <Mic size={13} className="text-accent" /> Recording… release to copy
        </span>
      ) : (
        <span className="block max-w-[420px] truncate" title={note ?? ""}>
          {note}
        </span>
      )}
    </div>
  );
}
