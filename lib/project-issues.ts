import type { IssueTab } from "./issue-view";
type IssueSearch = { _id: string; title: string; assignedToName?: string; assignedToEmail?: string; priority: string; dueDate?: string; labels?: string[] };

export function taskKey(id: string) {
  return `ORI-${id.slice(-4).toUpperCase()}`;
}

export function matchesIssue(task: IssueSearch, search: string, assignee = "") {
  return (!assignee || task.assignedToEmail === assignee) &&
    `${task.title} ${task.assignedToName || ""} ${task.assignedToEmail || ""} ${task.priority} ${task.dueDate || ""} ${task.labels?.join(" ") || ""} ${taskKey(task._id)}`.toLowerCase().includes(search.trim().toLowerCase());
}

export type IssueShortcut = "create" | "search" | "filter" | "display" | "board" | "list" | "toggle-layout" | `tab:${IssueTab}`;

/**
 * Keys of the project issues view, as in Linear: C create, / search, F filter, Shift+V display options, Mod+B
 * toggles list and board (B and L pick one), 1 / 2 / 3 open All issues, Active and Backlog. With an issue in focus,
 * L belongs to labels (the workspace handles it).
 */
export function issueShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "defaultPrevented" | "repeat" | "isComposing">, context: { editing: boolean; overlayOpen: boolean; canEdit: boolean; issueFocused?: boolean }): IssueShortcut | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || context.editing || context.overlayOpen) return null;
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) return key === "b" && !event.shiftKey ? "toggle-layout" : null;
  if (event.shiftKey) return key === "v" ? "display" : null;
  switch (key) {
    case "c": return context.canEdit ? "create" : null;
    case "/": return "search";
    case "f": return "filter";
    case "b": return "board";
    case "l": return context.issueFocused ? null : "list";
    case "1": return "tab:all";
    case "2": return "tab:active";
    case "3": return "tab:backlog";
    default: return null;
  }
}
