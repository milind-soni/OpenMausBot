import type { NewlineKey } from "./newline-key";
import type { SteerKey } from "./steer-key";
import type { SendKey } from "./send-key";

export interface ShortcutItem {
  id: string;
  description: string;
  macKeys: string[];
  winKeys: string[];
}

export interface ShortcutGroup {
  category: string;
  items: ShortcutItem[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    category: "Navigation",
    items: [
      {
        id: "command-palette",
        description: "Open command palette (switcher & transcript search)",
        macKeys: ["⌘", "K"],
        winKeys: ["Ctrl", "K"],
      },
      {
        id: "new-bot",
        description: "Create a new bot",
        macKeys: ["⌘", "N"],
        winKeys: ["Ctrl", "N"],
      },
      {
        id: "jump-bot",
        description: "Jump to bot 1–9 in the roster",
        macKeys: ["⌘", "1–9"],
        winKeys: ["Ctrl", "1–9"],
      },
      {
        id: "switch-bot",
        description: "Switch to previous / next bot",
        macKeys: ["⌘", "⇧", "[ / ]"],
        winKeys: ["Ctrl", "Shift", "[ / ]"],
      },
      {
        id: "find-conversation",
        description: "Find in conversation",
        macKeys: ["⌘", "F"],
        winKeys: ["Ctrl", "F"],
      },
    ],
  },
  {
    category: "Chat & Composer",
    items: [
      {
        id: "send-message",
        description: "Send message",
        macKeys: ["Return"],
        winKeys: ["Enter"],
      },
      {
        id: "new-line",
        description: "Insert new line without sending",
        macKeys: ["⇧", "Return"],
        winKeys: ["Shift", "Enter"],
      },
      {
        id: "edit-last-message",
        description: "Edit last message (when composer is empty)",
        macKeys: ["↑"],
        winKeys: ["↑"],
      },
      {
        id: "close-panel",
        description: "Close active drawer, modal, or find bar",
        macKeys: ["Esc"],
        winKeys: ["Esc"],
      },
      {
        id: "shortcuts-cheat-sheet",
        description: "Show keyboard shortcuts cheat sheet",
        macKeys: ["⌘", "/"],
        winKeys: ["Ctrl", "/"],
      },
    ],
  },
  {
    category: "Calls",
    items: [
      {
        id: "live-call-mute",
        description: "Mute or unmute a Live call",
        macKeys: ["⌘", "⇧", "M"],
        winKeys: ["Ctrl", "Shift", "M"],
      },
      {
        id: "live-call-hang-up",
        description: "Hang up a Live call",
        macKeys: ["⌘", "⇧", "H"],
        winKeys: ["Ctrl", "Shift", "H"],
      },
    ],
  },
  {
    category: "Management & Groups",
    items: [
      {
        id: "save-bulletin",
        description: "Save group instruction changes",
        macKeys: ["⌘", "Return"],
        winKeys: ["Ctrl", "Enter"],
      },
      {
        id: "reorder-section",
        description: "Reorder sidebar sections (focus a section heading)",
        macKeys: ["⌥", "↑ / ↓"],
        winKeys: ["Alt", "↑ / ↓"],
      },
    ],
  },
];

type Keys = Pick<ShortcutItem, "macKeys" | "winKeys">;
const ENTER: Keys = { macKeys: ["Return"], winKeys: ["Enter"] };
const SHIFT_ENTER: Keys = { macKeys: ["⇧", "Return"], winKeys: ["Shift", "Enter"] };
const SEND_ROWS: Record<Exclude<SendKey, "enter">, [Keys, Keys]> = {
  "shift-enter": [SHIFT_ENTER, ENTER],
  "mod-enter": [{ macKeys: ["⌘", "Return"], winKeys: ["Ctrl", "Enter"] }, ENTER],
};

export function shortcutGroupsFor(sendKey: SendKey, steerKey: SteerKey = "off", newlineKey: NewlineKey = "auto"): readonly ShortcutGroup[] {
  const [send, legacyNewLine] = sendKey === "enter" ? [ENTER, SHIFT_ENTER] : SEND_ROWS[sendKey];
  const newLine: Keys = newlineKey === "auto" ? legacyNewLine
    : newlineKey === "enter" ? ENTER : newlineKey === "shift-enter" ? SHIFT_ENTER
      : newlineKey === "alt" ? { macKeys: ["⌥", "Return"], winKeys: ["Alt", "Enter"] }
        : { macKeys: ["⌘", ...(newlineKey === "mod-shift" ? ["⇧"] : []), "Return"], winKeys: ["Ctrl", ...(newlineKey === "mod-shift" ? ["Shift"] : []), "Enter"] };
  const groups = sendKey === "enter" && newlineKey === "auto" ? SHORTCUT_GROUPS : SHORTCUT_GROUPS.map((group) => ({
    ...group,
    items: group.items.map((item) =>
      item.id === "send-message" ? { ...item, ...send }
        : item.id === "new-line" ? { ...item, ...newLine }
          : item),
  }));
  if (steerKey === "off") return groups;
  const keys: Keys = steerKey === "alt" ? { macKeys: ["⌥", "Return"], winKeys: ["Alt", "Enter"] }
    : { macKeys: ["⌘", ...(steerKey === "mod-shift" ? ["⇧"] : []), "Return"], winKeys: ["Ctrl", ...(steerKey === "mod-shift" ? ["Shift"] : []), "Enter"] };
  return groups.map(group => group.category !== "Chat & Composer" ? group : {
    ...group,
    items: [...group.items, { id: "add-to-run", description: "Add draft to current run (keep queued messages)", ...keys }],
  });
}

export function shouldOpenKeyboardShortcuts(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey) return false;
  const helpKey = event.key === "?" && !event.metaKey && !event.ctrlKey;
  const helpChord = event.key === "/" && (event.metaKey || event.ctrlKey) && !event.shiftKey;
  if (!helpKey && !helpChord) return false;
  const target = event.target;
  return !(target instanceof HTMLElement && (
    target.isContentEditable || target.closest("input, textarea, select, dialog, [role=dialog]")
  ));
}

export function isMacPlatform(): boolean {
  if (typeof window !== "undefined" && window.ogb?.platform) {
    return window.ogb.platform === "darwin";
  }
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    return navigator.userAgent.includes("Mac");
  }
  return true;
}

export function shortcutKeysForPlatform(
  item: ShortcutItem,
  isMac: boolean = isMacPlatform(),
): string[] {
  return isMac ? item.macKeys : item.winKeys;
}

export function filterShortcutGroups(
  groups: readonly ShortcutGroup[],
  query: string,
  isMac: boolean = isMacPlatform(),
): ShortcutGroup[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...groups];

  return groups
    .map((group) => {
      const filteredItems = group.items.filter((item) => {
        const keys = shortcutKeysForPlatform(item, isMac).join(" ").toLowerCase();
        return (
          item.description.toLowerCase().includes(normalized) ||
          group.category.toLowerCase().includes(normalized) ||
          keys.includes(normalized)
        );
      });
      return { ...group, items: filteredItems };
    })
    .filter((group) => group.items.length > 0);
}
