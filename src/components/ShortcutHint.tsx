import { SHORTCUT_GROUPS, shortcutKeysForPlatform } from "@/lib/keyboard-shortcuts";

/** Display the real binding, without adding a second shortcut registry. */
export function shortcutLabel(id: string): string | undefined {
  const item = SHORTCUT_GROUPS.flatMap((group) => group.items).find((entry) => entry.id === id);
  return item ? shortcutKeysForPlatform(item).join(" ") : undefined;
}

export function ShortcutHint({ id }: { id: string }) {
  const label = shortcutLabel(id);
  if (!label) return null;
  return <kbd aria-hidden="true" className="shrink-0 rounded border border-hairline/50 px-1.5 py-0.5 font-sans text-[11px] leading-none text-ink-secondary">{label}</kbd>;
}
