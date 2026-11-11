type IssueSearch = { _id: string; title: string; assignedToName?: string; assignedToEmail?: string; priority: string; dueDate?: string; labels?: string[] };

export function taskKey(id: string) {
  return `ORI-${id.slice(-4).toUpperCase()}`;
}

export function matchesIssue(task: IssueSearch, search: string, assignee = "") {
  return (!assignee || task.assignedToEmail === assignee) &&
    `${task.title} ${task.assignedToName || ""} ${task.assignedToEmail || ""} ${task.priority} ${task.dueDate || ""} ${task.labels?.join(" ") || ""} ${taskKey(task._id)}`.toLowerCase().includes(search.trim().toLowerCase());
}

/**
 * Project view keys. With an issue in focus, L belongs to labels (the workspace handles it); otherwise B and L switch
 * between board and list.
 */
export function issueShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "defaultPrevented" | "repeat" | "isComposing">, context: { editing: boolean; overlayOpen: boolean; canEdit: boolean; issueFocused?: boolean }) {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || context.editing || context.overlayOpen) return null;
  switch (event.key.toLowerCase()) {
    case "c": return context.canEdit ? "create" : null;
    case "f": case "/": return "search";
    case "b": return "board";
    case "l": return context.issueFocused ? null : "list";
    default: return null;
  }
}
