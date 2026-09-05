import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";

import { Composer } from "@/components/Composer";
import { BotAvatar } from "@/components/Avatar";
import type { Bot, Group } from "@/state/store";
import { cn } from "@/lib/cn";

function isGroup(subject: Bot | Group): subject is Group {
  return Array.isArray((subject as Group).memberIds);
}

/**
 * The floating pill. It wraps the real Composer rather than reimplementing it,
 * so attachments, queued messages, slash commands and voice all keep working;
 * what it adds is the identity chip and the redirect picker.
 */
export function SpacesComposer({
  subject,
  subjects,
  onPick,
}: {
  subject: Bot | Group;
  subjects: Array<Bot | Group>;
  onPick: (id: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  // Typing "@" into an empty composer is the fast path to the picker: the
  // Composer owns its own textarea, so we intercept before it sees the key.
  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "@") return;
    const target = event.target as HTMLTextAreaElement | null;
    if (!target || target.tagName !== "TEXTAREA" || target.value.length > 0) return;
    event.preventDefault();
    setPickerOpen(true);
  };

  return (
    <div
      ref={wrapperRef}
      onKeyDownCapture={onKeyDownCapture}
      className="pointer-events-auto absolute bottom-6 left-1/2 z-20 w-[min(52rem,calc(100vw-3rem))] -translate-x-1/2"
    >
      {pickerOpen && (
        <div className="absolute bottom-full left-3 mb-2 max-h-72 w-72 overflow-y-auto rounded-xl border border-hairline/40 bg-panel/95 p-1 shadow-2xl backdrop-blur">
          {subjects.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => {
                setPickerOpen(false);
                onPick(candidate.id);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-raised",
                candidate.id === subject.id ? "text-ink" : "text-ink-secondary",
              )}
            >
              {isGroup(candidate) ? (
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-raised text-[10px]">
                  {candidate.memberIds.length}
                </span>
              ) : (
                <BotAvatar bot={candidate} size={20} />
              )}
              <span className="truncate">{candidate.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-1 rounded-[1.75rem] border border-hairline/40 bg-panel/90 pl-2 shadow-2xl backdrop-blur">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={pickerOpen}
          aria-label={`Sending to ${subject.name}. Choose another`}
          onClick={() => setPickerOpen((open) => !open)}
          className="mb-3 flex shrink-0 items-center gap-1.5 rounded-full bg-raised px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-raised-hover"
        >
          {isGroup(subject) ? (
            <span className="grid size-4 place-items-center rounded-full bg-panel text-[9px]">
              {subject.memberIds.length}
            </span>
          ) : (
            <BotAvatar bot={subject} size={16} />
          )}
          <span className="max-w-28 truncate">{subject.name}</span>
          <ChevronDown size={12} className="text-ink-secondary" />
        </button>
        <div className="min-w-0 flex-1">
          {isGroup(subject) ? (
            <Composer key={subject.id} group={subject} />
          ) : (
            <Composer key={subject.id} bot={subject} />
          )}
        </div>
      </div>
    </div>
  );
}
