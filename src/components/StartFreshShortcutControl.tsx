import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { isMacPlatform, SHORTCUT_GROUPS, shortcutDescription } from "@/lib/keyboard-shortcuts";
import {
  chordFromKeyboardEvent,
  isDefaultStartFreshShortcut,
  resetStartFreshShortcut,
  setStartFreshShortcut,
  shortcutChordKeys,
  shortcutConflict,
  useStartFreshShortcut,
} from "@/lib/start-fresh-shortcut";
import { SettingRow } from "./SettingsPrimitives";

function conflictMessage(conflict: NonNullable<ReturnType<typeof shortcutConflict>>): string {
  if (conflict.kind === "reserved") return t("settings.startFreshShortcut.reserved");
  const item = SHORTCUT_GROUPS.flatMap((group) => group.items).find((entry) => entry.id === conflict.itemId);
  const name = item ? shortcutDescription(item) : conflict.itemId;
  return t("settings.startFreshShortcut.conflict", { name });
}

/** Interactive recorder/editor for the Start fresh shortcut, shared between Settings and Keyboard Shortcuts. */
export function StartFreshShortcutControl({
  compact = false,
  onErrorChange,
}: {
  compact?: boolean;
  onErrorChange?: (error: string) => void;
}) {
  const chord = useStartFreshShortcut();
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const changeRef = useRef<HTMLButtonElement>(null);
  const isMac = isMacPlatform();

  const updateError = (next: string) => {
    setError(next);
    onErrorChange?.(next);
  };

  const stopRecording = () => {
    setRecording(false);
    changeRef.current?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      updateError("");
      stopRecording();
      return;
    }

    if ((event.key === "Backspace" || event.key === "Delete") && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      setStartFreshShortcut(null);
      updateError("");
      stopRecording();
      return;
    }

    const parsed = chordFromKeyboardEvent(event.nativeEvent, isMac);
    if (!parsed.ok) {
      if (parsed.reason !== "modifier-only") {
        updateError(t("settings.startFreshShortcut.needModifier"));
      }
      return;
    }

    const conflict = shortcutConflict(parsed.chord, isMac);
    if (conflict) {
      updateError(conflictMessage(conflict));
      return;
    }

    setStartFreshShortcut(parsed.chord);
    updateError("");
    stopRecording();
  };

  const keys = chord ? shortcutChordKeys(chord, isMac) : [];
  const isDefault = isDefaultStartFreshShortcut(chord);
  const buttonClass = compact ? "ui-button ui-button-sm" : "ui-button";

  return (
    <div className={cn("flex flex-col", compact ? "items-end gap-1" : "items-end gap-1.5")}>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {recording ? (
          <button
            type="button"
            autoFocus
            data-start-fresh-recorder=""
            onKeyDown={handleKeyDown}
            onBlur={() => { setRecording(false); }}
            onClick={() => { updateError(""); stopRecording(); }}
            aria-label={t("shortcuts.pressKeys")}
            className={cn(
              buttonClass,
              "border-accent bg-accent/10 text-accent-text",
            )}
          >
            {t("shortcuts.pressKeys")}
          </button>
        ) : (
          <>
            {keys.length > 0 ? (
              <div className="flex shrink-0 items-center gap-1" data-start-fresh-keys="">
                {keys.map((key, index) => (
                  <kbd
                    key={index}
                    className={cn(
                      "inline-flex min-w-[22px] items-center justify-center rounded-md border border-ink/15 bg-control px-1.5 py-0.5 font-mono font-semibold text-ink shadow-xs",
                      compact ? "text-[12px] leading-4" : "text-[12px] leading-4",
                    )}
                  >
                    {key}
                  </kbd>
                ))}
              </div>
            ) : (
              <span className="text-[12px] leading-4 text-ink-secondary" data-start-fresh-unset="">
                {t("shortcuts.notSet")}
              </span>
            )}
            <button
              ref={changeRef}
              type="button"
              data-start-fresh-change=""
              className={buttonClass}
              onClick={() => {
                updateError("");
                setRecording(true);
              }}
            >
              {t("shortcuts.change")}
            </button>
            {chord && (
              <button
                type="button"
                data-start-fresh-clear=""
                className={buttonClass}
                onClick={() => {
                  updateError("");
                  setStartFreshShortcut(null);
                }}
              >
                {t("shortcuts.clear")}
              </button>
            )}
            {!isDefault && (
              <button
                type="button"
                data-start-fresh-reset=""
                className={buttonClass}
                onClick={() => {
                  updateError("");
                  resetStartFreshShortcut();
                }}
              >
                {t("shortcuts.reset")}
              </button>
            )}
          </>
        )}
      </div>
      {error && !onErrorChange && (
        <div role="alert" className="text-right text-[12px] leading-4 text-danger">
          {error}
        </div>
      )}
    </div>
  );
}

/** General settings row for configuring the Start fresh keyboard shortcut. */
export function StartFreshShortcutRow() {
  const [error, setError] = useState("");
  return (
    <SettingRow
      title={t("settings.startFreshShortcut.title")}
      subtitle={t("settings.startFreshShortcut.subtitle")}
      message={error ? <div role="alert" className="text-danger">{error}</div> : null}
    >
      <StartFreshShortcutControl onErrorChange={setError} />
    </SettingRow>
  );
}
