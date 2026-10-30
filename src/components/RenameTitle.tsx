import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
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
  editRequest = 0,
  title,
  className,
  editButtonClassName,
  inputClassName,
}: {
  value: string;
  onCommit: (next: string) => void;
  onEditingChange?: (editing: boolean) => void;
  onActivate?: () => void;
  showEditButton?: boolean;
  editRequest?: number;
  title?: string;
  className?: string;
  editButtonClassName?: string;
  inputClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const handledRequest = useRef(editRequest);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const setMode = (next: boolean) => {
    setEditing(next);
    onEditingChange?.(next);
  };

  useEffect(() => {
    if (editRequest === handledRequest.current) return;
    handledRequest.current = editRequest;
    setDraft(value);
    setMode(true);
  }, [editRequest]);

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
        aria-label={t("rename.aria")}
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
            aria-label={t("chat.openProfileAria", { name: value })}
            className={cn("min-w-0 truncate text-left", className)}
            title={t("chat.openProfile")}
          >
            {value}
          </button>
        ) : (
          <span className={cn("min-w-0 truncate", className)}>{value}</span>
        )}
        <button
          type="button"
          onClick={startRename}
          aria-label={t("rename.named", { name: value })}
          title={t("rename.agent")}
          className={cn("flex size-10 shrink-0 items-center justify-center rounded text-ink-secondary opacity-70 hover:bg-raised hover:text-ink hover:opacity-100", editButtonClassName)}
        >
          <Pencil size={12} />
        </button>
      </span>
    );
  }

  return (
    <span
      className={cn("cursor-text", className)}
      title={title ?? t("rename.doubleClick")}
      tabIndex={0}
      role="button"
      aria-label={t("rename.named", { name: value })}
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
