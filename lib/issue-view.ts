/**
 * The query model the project list and board share: filters, grouping, ordering and which properties rows show.
 * Saved per person and project in this browser.
 */
export type Priority = "low" | "medium" | "high";
export type IssueLayout = "board" | "list";
export type IssueGrouping = "status" | "priority" | "assignee" | "label" | "none";
export type IssueOrdering = "manual" | "priority" | "estimate" | "dueDate" | "created" | "updated" | "title";
export type DisplayProperty = "id" | "status" | "priority" | "assignee" | "labels" | "estimate" | "dueDate" | "pullRequest" | "created";
export type IssueFilters = { statuses: string[]; priorities: Priority[]; assignees: string[]; labels: string[] };
/**
 * The project's issue views, as Linear's team pages: All issues, Active and Backlog. Origin keeps its own model:
 * Backlog is the draft column, and completed is a flag on the issue (no Done column).
 */
export type IssueTab = "all" | "active" | "backlog";
export type IssueViewState = {
  version?: number;
  tab: IssueTab;
  layout: IssueLayout;
  grouping: IssueGrouping;
  ordering: IssueOrdering;
  showEmptyGroups: boolean;
  showSubIssues: boolean;
  /** All issues only: completed issues stay in their column, after the open ones. */
  showCompleted: boolean;
  properties: DisplayProperty[];
  filters: IssueFilters;
};
export type FilterKey = keyof IssueFilters;
export type ViewTask = { _id: string; title: string; priority: Priority; assignedToEmail?: string; labels?: string[]; dueDate?: string; estimate?: number; createdAt: number; updatedAt: number; order: number };

/** The view tabs in order, with their single-key shortcut. */
export const ISSUE_TABS: { value: IssueTab; label: string; key: string }[] = [
  { value: "all", label: "All issues", key: "1" }, { value: "active", label: "Active", key: "2" }, { value: "backlog", label: "Backlog", key: "3" },
];

/**
 * Whether an issue belongs to a view tab. `draft` is whether its column is the draft (Backlog) column.
 * All issues: everything, completed included unless Display hides them. Active: open issues outside the Backlog.
 * Backlog: open issues in the Backlog column.
 */
export function inIssueTab(task: { done?: boolean }, draft: boolean, tab: IssueTab, showCompleted = true): boolean {
  if (tab === "all") return !task.done || showCompleted;
  if (task.done) return false;
  return tab === "backlog" ? draft : !draft;
}

export const GROUPINGS: { value: IssueGrouping; label: string }[] = [
  { value: "status", label: "Status" }, { value: "priority", label: "Priority" }, { value: "assignee", label: "Assignee" }, { value: "label", label: "Label" }, { value: "none", label: "No grouping" },
];
export const ORDERINGS: { value: IssueOrdering; label: string }[] = [
  { value: "manual", label: "Manual" }, { value: "priority", label: "Priority" }, { value: "estimate", label: "Estimate" }, { value: "dueDate", label: "Due date" }, { value: "created", label: "Created" }, { value: "updated", label: "Updated" }, { value: "title", label: "Title" },
];
export const DISPLAY_PROPERTIES: { value: DisplayProperty; label: string }[] = [
  { value: "id", label: "ID" }, { value: "status", label: "Status" }, { value: "assignee", label: "Assignee" }, { value: "priority", label: "Priority" },
  { value: "estimate", label: "Estimate" }, { value: "dueDate", label: "Due date" }, { value: "labels", label: "Labels" }, { value: "pullRequest", label: "Pull requests" }, { value: "created", label: "Created" },
];
/** Version of the stored view; properties added since a stored version are switched on when it is read. */
export const VIEW_VERSION = 2;
const ADDED_PROPERTIES: Record<number, DisplayProperty[]> = { 2: ["estimate"] };
export const PRIORITY_ORDER: Priority[] = ["high", "medium", "low"];
export const UNASSIGNED = "";
export const NO_LABEL = "";

export const DEFAULT_VIEW: IssueViewState = {
  version: 2,
  tab: "active",
  layout: "board", grouping: "status", ordering: "manual", showEmptyGroups: false, showSubIssues: true, showCompleted: true,
  properties: ["id", "status", "priority", "assignee", "estimate", "dueDate", "labels", "pullRequest"],
  filters: { statuses: [], priorities: [], assignees: [], labels: [] },
};

const pick = <T extends string>(value: unknown, allowed: readonly { value: T }[], fallback: T) => allowed.some(option => option.value === value) ? value as T : fallback;
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 100) : [];

/** A stored view, with anything unknown or malformed replaced by the default. */
export function readIssueView(raw: unknown, legacyLayout?: string | null): IssueViewState {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const filters = value.filters && typeof value.filters === "object" ? value.filters as Record<string, unknown> : {};
  const properties = strings(value.properties).filter(property => DISPLAY_PROPERTIES.some(option => option.value === property)) as DisplayProperty[];
  // A view saved before a property existed shows it, as a new default would.
  const version = typeof value.version === "number" ? value.version : 1;
  for (let next = version + 1; next <= VIEW_VERSION; next++) for (const added of ADDED_PROPERTIES[next] ?? []) if (!properties.includes(added)) properties.push(added);
  return {
    version: VIEW_VERSION,
    tab: pick(value.tab, ISSUE_TABS, DEFAULT_VIEW.tab),
    layout: value.layout === "list" || value.layout === "board" ? value.layout : legacyLayout === "list" ? "list" : "board",
    grouping: pick(value.grouping, GROUPINGS, DEFAULT_VIEW.grouping),
    ordering: pick(value.ordering, ORDERINGS, DEFAULT_VIEW.ordering),
    showEmptyGroups: typeof value.showEmptyGroups === "boolean" ? value.showEmptyGroups : DEFAULT_VIEW.showEmptyGroups,
    showSubIssues: typeof value.showSubIssues === "boolean" ? value.showSubIssues : DEFAULT_VIEW.showSubIssues,
    showCompleted: typeof value.showCompleted === "boolean" ? value.showCompleted : DEFAULT_VIEW.showCompleted,
    properties: Array.isArray(value.properties) ? properties : DEFAULT_VIEW.properties,
    filters: {
      statuses: strings(filters.statuses),
      priorities: strings(filters.priorities).filter((item): item is Priority => (PRIORITY_ORDER as string[]).includes(item)),
      assignees: strings(filters.assignees),
      labels: strings(filters.labels).map(label => label.toLowerCase()),
    },
  };
}

export function toggleFilter(filters: IssueFilters, key: FilterKey, value: string): IssueFilters {
  const current = filters[key] as string[];
  const next = current.includes(value) ? current.filter(item => item !== value) : [...current, value];
  return { ...filters, [key]: next };
}

export const activeFilterCount = (filters: IssueFilters) => filters.statuses.length + filters.priorities.length + filters.assignees.length + filters.labels.length;

/**
 * Whether an issue passes the filters. Values within one filter are alternatives (any of them); different filters
 * all have to match. `status` is the issue's status id as the board shows it. Label values are lowercased names;
 * `NO_LABEL` matches issues without labels, `UNASSIGNED` issues without an assignee.
 */
export function matchesFilters(task: ViewTask, filters: IssueFilters, status: string) {
  if (filters.statuses.length && !filters.statuses.includes(status)) return false;
  if (filters.priorities.length && !filters.priorities.includes(task.priority)) return false;
  if (filters.assignees.length && !filters.assignees.includes(task.assignedToEmail ?? UNASSIGNED)) return false;
  if (filters.labels.length) {
    const labels = (task.labels ?? []).map(label => label.toLowerCase());
    if (!filters.labels.some(label => label === NO_LABEL ? !labels.length : labels.includes(label))) return false;
  }
  return true;
}

const rank = (priority: Priority) => PRIORITY_ORDER.indexOf(priority);

/** Issues in display order. Manual keeps the board's own order; ties fall back to it as well. */
export function sortIssues<T extends ViewTask>(tasks: readonly T[], ordering: IssueOrdering) {
  const manual = (a: T, b: T) => a.order - b.order || a.createdAt - b.createdAt;
  const compare: Record<IssueOrdering, (a: T, b: T) => number> = {
    manual,
    priority: (a, b) => rank(a.priority) - rank(b.priority) || manual(a, b),
    // Largest first; issues without an estimate go last.
    estimate: (a, b) => (b.estimate ?? -1) - (a.estimate ?? -1) || manual(a, b),
    // Issues without a due date go last.
    dueDate: (a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || manual(a, b),
    created: (a, b) => b.createdAt - a.createdAt,
    updated: (a, b) => b.updatedAt - a.updatedAt,
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || manual(a, b),
  };
  return [...tasks].sort(compare[ordering]);
}

export type IssueGroup<T> = { key: string; title: string; tasks: T[] };
type GroupContext = {
  /** Status lanes in board order. */
  statuses: { id: string; title: string }[];
  statusOf: (task: ViewTask) => string;
  people: { email: string; name: string }[];
  /** Workspace labels in display order (names). */
  labels: string[];
};

/**
 * Splits sorted issues into list groups. An issue with several labels shows under each of them, as in Linear.
 * Groups come in a fixed order (board lanes, priority, people, labels) with "No …" groups last.
 */
export function groupIssues<T extends ViewTask>(tasks: readonly T[], grouping: IssueGrouping, context: GroupContext, showEmpty: boolean): IssueGroup<T>[] {
  let groups: IssueGroup<T>[];
  if (grouping === "none") return [{ key: "all", title: "All issues", tasks: [...tasks] }];
  if (grouping === "status") groups = context.statuses.map(status => ({ key: status.id, title: status.title, tasks: tasks.filter(task => context.statusOf(task) === status.id) }));
  else if (grouping === "priority") groups = PRIORITY_ORDER.map(priority => ({ key: priority, title: priority[0]!.toUpperCase() + priority.slice(1), tasks: tasks.filter(task => task.priority === priority) }));
  else if (grouping === "assignee") {
    const emails = [...new Set(tasks.flatMap(task => task.assignedToEmail ? [task.assignedToEmail] : []))];
    const name = (email: string) => context.people.find(person => person.email === email)?.name || email;
    groups = [
      ...(showEmpty ? [...new Set([...context.people.map(person => person.email), ...emails])] : emails).sort((a, b) => name(a).localeCompare(name(b))).map(email => ({ key: email, title: name(email), tasks: tasks.filter(task => task.assignedToEmail === email) })),
      { key: UNASSIGNED, title: "No assignee", tasks: tasks.filter(task => !task.assignedToEmail) },
    ];
  } else {
    const names = new Map<string, string>();
    for (const label of context.labels) names.set(label.toLowerCase(), label);
    for (const task of tasks) for (const label of task.labels ?? []) if (!names.has(label.toLowerCase())) names.set(label.toLowerCase(), label);
    groups = [
      ...[...names].map(([key, title]) => ({ key, title, tasks: tasks.filter(task => task.labels?.some(label => label.toLowerCase() === key)) })),
      { key: NO_LABEL, title: "No labels", tasks: tasks.filter(task => !task.labels?.length) },
    ];
  }
  return showEmpty ? groups : groups.filter(group => group.tasks.length);
}
