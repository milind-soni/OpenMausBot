/** Keys for one shortcut, as written in the reference: "Mod" is ⌘ on Apple devices and Ctrl elsewhere; "then" separates a sequence. */
export type ShortcutKeys = readonly string[];
export type ShortcutEntry = { group: "General" | "Issues" | "Views"; label: string; keys: ShortcutKeys };

export const SHORTCUTS: readonly ShortcutEntry[] = [
  { group: "General", label: "Open command menu", keys: ["Mod", "K"] },
  { group: "General", label: "Search", keys: ["/"] },
  { group: "General", label: "Keyboard shortcuts", keys: ["?"] },
  { group: "General", label: "Create issue", keys: ["C"] },
  { group: "General", label: "Submit (create issue, send comment)", keys: ["Mod", "Enter"] },
  { group: "General", label: "Back / close", keys: ["Esc"] },
  { group: "Issues", label: "Open focused issue", keys: ["Enter"] },
  { group: "Issues", label: "Peek focused issue", keys: ["Space"] },
  { group: "Issues", label: "Move focus", keys: ["↑", "↓", "←", "→"] },
  { group: "Issues", label: "Change status", keys: ["S"] },
  { group: "Issues", label: "Change priority", keys: ["P"] },
  { group: "Issues", label: "Change labels", keys: ["L"] },
  { group: "Issues", label: "Assign to", keys: ["A"] },
  { group: "Issues", label: "Assign to me", keys: ["I"] },
  { group: "Issues", label: "Change due date", keys: ["Shift", "D"] },
  { group: "Issues", label: "Set estimate", keys: ["Shift", "E"] },
  { group: "Issues", label: "Copy issue ID", keys: ["Mod", "."] },
  { group: "Issues", label: "Copy issue URL", keys: ["Mod", "Shift", ","] },
  { group: "Issues", label: "Copy git branch name", keys: ["Mod", "Shift", "."] },
  { group: "Issues", label: "Issue menu", keys: ["Shift", "F10"] },
  { group: "Views", label: "All issues", keys: ["1"] },
  { group: "Views", label: "Active issues", keys: ["2"] },
  { group: "Views", label: "Backlog", keys: ["3"] },
  { group: "Views", label: "Filter issues", keys: ["F"] },
  { group: "Views", label: "Display options", keys: ["Shift", "V"] },
  { group: "Views", label: "Toggle list and board", keys: ["Mod", "B"] },
  { group: "Views", label: "Board layout", keys: ["B"] },
  { group: "Views", label: "List layout", keys: ["L"] },
];

export const isApplePlatform = () => typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

/** Display labels for keys: Mod becomes ⌘ or Ctrl, Shift ⇧ on Apple devices. */
export function shortcutLabels(keys: ShortcutKeys, apple = isApplePlatform()) {
  return keys.map(key => key === "Mod" ? apple ? "⌘" : "Ctrl" : key === "Shift" && apple ? "⇧" : key === "Alt" && apple ? "⌥" : key);
}

/** Every word of `query` appears in `text` (case-insensitive). */
function matchesWords(text: string, query: string) {
  const haystack = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
}

/** Items whose label (or keywords) contain every typed word; labels starting with the query come first. */
export function filterCommands<T extends { label: string; keywords?: string }>(items: readonly T[], query: string) {
  const value = query.trim().toLowerCase();
  if (!value) return [...items];
  return items
    .filter(item => matchesWords(`${item.label} ${item.keywords ?? ""}`, value))
    .map((item, index) => ({ item, index, starts: item.label.toLowerCase().startsWith(value) ? 0 : 1 }))
    .sort((a, b) => a.starts - b.starts || a.index - b.index)
    .map(entry => entry.item);
}

/** The shortcut reference narrowed to a search, matching labels, groups and key names. */
export function filterShortcuts(query: string, entries: readonly ShortcutEntry[] = SHORTCUTS) {
  const value = query.trim();
  return value ? entries.filter(entry => matchesWords(`${entry.label} ${entry.group} ${entry.keys.join(" ")}`, value)) : [...entries];
}

/** Due date presets offered by the command menu, as YYYY-MM-DD in local time. */
export function dueDatePresets(now = new Date()) {
  const at = (days: number) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  return [
    { label: "Today", value: at(0) },
    { label: "Tomorrow", value: at(1) },
    { label: "Next week", value: at(toMonday) },
    { label: "In two weeks", value: at(14) },
  ];
}

const LABEL_HINTS: { label: string; pattern: RegExp }[] = [
  { label: "Bug", pattern: /\b(bug|fix(es|ed)?|broken|crash(es|ed)?|error|fails?|failing|regression|wrong|can'?t|cannot|doesn'?t|stale)\b/i },
  { label: "Feature", pattern: /\b(add|adds|new|support|allow|enable|implement|introduce|feature|create|build)\b/i },
  { label: "Improvement", pattern: /\b(improve|improves|better|faster|refactor|polish|tweak|clean ?up|optimi[sz]e|simplify|update|tighten|empty states?)\b/i },
];

/** Feature, Bug or Improvement suggested from what an issue says, the way Linear suggests labels while typing. */
export function suggestLabels(text: string, applied: readonly string[] = []) {
  const taken = new Set(applied.map(label => label.toLowerCase()));
  return LABEL_HINTS.filter(hint => hint.pattern.test(text) && !taken.has(hint.label.toLowerCase())).map(hint => hint.label);
}
