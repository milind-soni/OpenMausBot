type KeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "isComposing" | "defaultPrevented" | "repeat">;
type Context = { editing: boolean; overlayOpen: boolean };

export type WorkspaceShortcut = "command-menu" | "search" | "create-issue" | "shortcuts";

/** Linear's global keys: ⌘K / Ctrl+K the command menu (also from a text field), / or F search, C create, ? shortcuts. */
export function workspaceShortcut(event: KeyEvent, context: Context & { canCreate: boolean }): WorkspaceShortcut | null {
  if (event.defaultPrevented || event.isComposing || event.repeat || context.overlayOpen) return null;
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && !event.altKey && key === "k") return "command-menu";
  if (event.metaKey || event.ctrlKey || event.altKey || context.editing) return null;
  if (key === "?") return "shortcuts";
  if (key === "f" || key === "/") return "search";
  if (key === "c" && context.canCreate) return "create-issue";
  return null;
}

export type IssueAction = "status" | "priority" | "labels" | "assignee" | "due-date" | "estimate" | "assign-me";

/**
 * Single keys that act on the issue in focus (a list row, a board card, or the open issue page), as in Linear:
 * S status, P priority, L labels, A assignee, I assign to me, Shift+D due date, Shift+E estimate.
 */
export function issueActionShortcut(event: KeyEvent & Pick<KeyboardEvent, "shiftKey">, context: Context & { hasIssue: boolean; canEdit: boolean }): IssueAction | null {
  if (!context.hasIssue || !context.canEdit || context.editing || context.overlayOpen) return null;
  if (event.defaultPrevented || event.isComposing || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey) return key === "d" ? "due-date" : key === "e" ? "estimate" : null;
  return ({ s: "status", p: "priority", l: "labels", a: "assignee", i: "assign-me" } as const)[key as "s"] ?? null;
}

export function shouldFocusChatComposer(event: KeyEvent, context: Context & { canWrite: boolean; controlHasFocus: boolean }) {
  if (!context.canWrite || context.editing || context.overlayOpen || event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key === " " && context.controlHasFocus) return false;
  return Array.from(event.key).length === 1 || event.key === "Dead";
}

export function isEditingTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"], .excalidraw'));
}

export function hasOpenKeyboardOverlay() {
  return [...document.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"], [popover]:popover-open, [role="menu"], [role="listbox"], .origin-dropdown, .profile-menu, .board-filter-popover')]
    .some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
}
