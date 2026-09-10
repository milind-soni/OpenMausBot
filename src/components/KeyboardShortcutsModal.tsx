import { useLayoutEffect, useRef, useState } from "react";
import { Keyboard, Search, X } from "lucide-react";

import {
  filterShortcutGroups,
  isMacPlatform,
  SHORTCUT_GROUPS,
  shortcutKeysForPlatform,
  type ShortcutItem,
} from "@/lib/keyboard-shortcuts";

/** Props for the KeyboardShortcutsModal component. */
export interface KeyboardShortcutsModalProps {
  /** Whether the dialog is currently visible. */
  open: boolean;
  /** Callback fired when the user requests closing the dialog. */
  onClose: () => void;
}

/**
 * Single shortcut row displaying its description and styled keycaps.
 */
function ShortcutRow({ item, isMac }: { item: ShortcutItem; isMac: boolean }) {
  const keys = shortcutKeysForPlatform(item, isMac);

  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-[13px] text-ink">{item.description}</span>
      <div className="flex shrink-0 items-center gap-1">
        {keys.map((key, index) => (
          <kbd
            key={index}
            className="inline-flex min-w-[22px] items-center justify-center rounded-md border border-hairline/60 bg-control px-1.5 py-0.5 font-mono text-[11.5px] font-semibold text-ink shadow-xs"
          >
            {key}
          </kbd>
        ))}
      </div>
    </div>
  );
}

/**
 * A modal cheat sheet displaying all available keyboard shortcuts categorized
 * into Navigation, Chat & Composer, and Workspace Management.
 */
export function KeyboardShortcutsModal({ open, onClose }: KeyboardShortcutsModalProps) {
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isMac = isMacPlatform();

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    setQuery("");
    dialog.showModal();
    inputRef.current?.focus();
    // Close before unmount so the browser restores focus to the opener.
    return () => dialog.close();
  }, [open]);

  if (!open) return null;

  const groups = filterShortcutGroups(SHORTCUT_GROUPS, query, isMac);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="shortcuts-dialog-title"
      className="m-auto w-[min(500px,calc(100%-32px))] max-h-[85vh] overflow-hidden rounded-2xl border border-hairline/50 bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-xs"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="flex max-h-[85vh] flex-col"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-hairline/40 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <Keyboard size={18} />
            </span>
            <div>
              <h2 id="shortcuts-dialog-title" className="text-[16px] font-semibold text-ink">
                Keyboard Shortcuts
              </h2>
              <p className="text-[12px] text-ink-secondary">
                Quick commands and navigation
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        {/* Search Input */}
        <div className="border-b border-hairline/30 px-5 py-2.5">
          <div className="flex items-center gap-2 rounded-xl border border-hairline/40 bg-inset px-3 py-1.5 focus-within:border-accent/60">
            <Search size={14} className="shrink-0 text-ink-secondary" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search shortcuts…"
              aria-label="Search shortcuts"
              className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
        </div>

        {/* Shortcuts List */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-4">
          {groups.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-ink-secondary">
              No shortcuts found for “{query}”
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.category} className="space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-secondary/70">
                  {group.category}
                </div>
                <div className="divide-y divide-hairline/20 rounded-xl bg-card/40 px-3 py-1 border border-hairline/30">
                  {group.items.map((item) => (
                    <ShortcutRow key={item.id} item={item} isMac={isMac} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between border-t border-hairline/40 bg-card/30 px-5 py-2.5 text-[11.5px] text-ink-secondary">
          <span>
            Press <kbd className="rounded bg-control px-1 py-0.5 font-mono text-[10.5px]">?</kbd> when not typing to open
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-raised px-3 py-1 font-medium text-ink hover:brightness-110"
          >
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
