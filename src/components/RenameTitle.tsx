// Double-click a title to rename it in place. Settings still exists for
// the rest of the profile — this is just the fast path for the name.
import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";

import { nextRename } from "@/lib/rename";
import { cn } from "@/lib/cn";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";

export function RenameTitle({
  value,
  onCommit,
  onEditingChange,
  onActivate,
  showEditButton = false,
  className,
  inputClassName,
}: {
  value: string;
  onCommit: (next: string) => void;
  onEditingChange?: (editing: boolean) => void;
  /** Optional single-click action for locations where the title opens a profile. */
  onActivate?: () => void;
  /** Preserve deliberate inline rename beside an onActivate title. */
  showEditButton?: boolean;
  className?: string;
  inputClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const setMode = (next: boolean) => {
    setEditing(next);
    onEditingChange?.(next);
  };

  const finish = (save: boolean) => {
    const next = save ? nextRename(value, draft) : null;
    setMode(false);
    if (next) onCommit(next);
    else setDraft(value);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        maxLength={BOT_PROFILE_LIMITS.name}
        aria-label="Rename"
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(true)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            finish(true);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
        }}
        className={cn("min-w-0 bg-transparent text-ink focus:outline-none", inputClassName)}
      />
    );
  }

  const startRename = (event: { preventDefault(): void; stopPropagation(): void }) => {
    event.preventDefault();
    event.stopPropagation();
    setDraft(value);
    setMode(true);
  };

  if (showEditButton) {
    return (
      <span className="flex min-w-0 items-center gap-0.5">
        {onActivate ? (
          <button
            type="button"
            onClick={onActivate}
            aria-label={`Open ${value}'s profile`}
            className={cn("min-w-0 truncate text-left", className)}
            title="Open agent profile"
          >
            {value}
          </button>
        ) : (
          <span className={cn("min-w-0 truncate", className)}>{value}</span>
        )}
        <button
          type="button"
          onClick={startRename}
          aria-label={`Rename ${value}`}
          title="Rename agent"
          className="flex size-10 shrink-0 items-center justify-center rounded text-ink-secondary opacity-70 hover:bg-raised hover:text-ink hover:opacity-100"
        >
          <Pencil size={12} />
        </button>
      </span>
    );
  }

  return (
    <span
      className={cn("cursor-text", className)}
      title="Double-click to rename"
      tabIndex={0}
      role="button"
      aria-label={`Rename ${value}`}
      onDoubleClick={startRename}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          startRename(event);
        }
      }}
    >
      {value}
    </span>
  );
}
