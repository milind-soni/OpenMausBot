import { SHORTCUT_GROUPS, shortcutKeysForPlatform } from "@/lib/keyboard-shortcuts";
import { readStartFreshShortcut, shortcutChordKeys, useStartFreshShortcut } from "@/lib/start-fresh-shortcut";
import { cn } from "@/lib/cn";

export function shortcutLabel(id: string): string | undefined {
  if (id === "start-fresh") {
    const chord = readStartFreshShortcut();
    return chord ? shortcutChordKeys(chord).join(" ") : undefined;
  }
  const item = SHORTCUT_GROUPS.flatMap((group) => group.items).find((entry) => entry.id === id);
  return item ? shortcutKeysForPlatform(item).join(" ") : undefined;
}

export function ShortcutHint({ id, className }: { id: string; className?: string }) {
  const startFresh = useStartFreshShortcut();
  const label = id === "start-fresh"
    ? (startFresh ? shortcutChordKeys(startFresh).join(" ") : undefined)
    : shortcutLabel(id);
  if (!label) return null;
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        "shrink-0 rounded border border-hairline/50 px-1.5 py-0.5 font-sans text-[11px] leading-none text-ink-secondary",
        className,
      )}
    >
      {label}
    </kbd>
  );
}
