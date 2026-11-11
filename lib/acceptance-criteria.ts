/**
 * Acceptance criteria: a short checklist stored on the issue itself (`tasks.acceptanceCriteria`), edited from the
 * issue page and by agents over MCP. Edits name an item by its position, its current text, or both; with both, the
 * edit fails when the list changed underneath it, so two editors never check the wrong item.
 */

export type Criterion = { text: string; checked: boolean };
export type CriterionEdit = {
  /** Position in the current list, 0 for the first item. */
  index?: number;
  /** The item's current text (case and surrounding spaces ignored). */
  match?: string;
  text?: string;
  checked?: boolean;
  remove?: boolean;
};

export const MAX_CRITERIA = 50;
export const MAX_CRITERION_LENGTH = 500;
export const NEEDS_SPEC_LABEL = "Needs spec";

const fold = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

export function cleanCriterion(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_CRITERION_LENGTH) throw new Error(`Each acceptance criterion is 1 to ${MAX_CRITERION_LENGTH} characters`);
  return text;
}

function bounded(items: Criterion[]) {
  if (items.length > MAX_CRITERIA) throw new Error(`An issue can have up to ${MAX_CRITERIA} acceptance criteria`);
  return items;
}

export function addCriteria(current: readonly Criterion[], texts: readonly string[]) {
  if (!texts.length) throw new Error("Add at least one acceptance criterion");
  return bounded([...current, ...texts.map(text => ({ text: cleanCriterion(text), checked: false }))]);
}

export function replaceCriteria(items: readonly { text: string; checked?: boolean }[]) {
  return bounded(items.map(item => ({ text: cleanCriterion(item.text), checked: item.checked === true })));
}

/** Applies edits that all refer to positions in `current`; removals happen last. */
export function editCriteria(current: readonly Criterion[], edits: readonly CriterionEdit[]) {
  if (!edits.length) throw new Error("Give at least one change");
  const next = current.map(item => ({ ...item }));
  const removed = new Set<number>();
  const touched = new Set<number>();
  for (const edit of edits) {
    const index = criterionIndex(current, edit);
    if (touched.has(index)) throw new Error(`Acceptance criterion ${index} is changed twice`);
    touched.add(index);
    if (edit.remove) { removed.add(index); continue; }
    if (edit.text === undefined && edit.checked === undefined) throw new Error("Give text, checked or remove for each change");
    if (edit.text !== undefined) next[index]!.text = cleanCriterion(edit.text);
    if (edit.checked !== undefined) next[index]!.checked = edit.checked;
  }
  return next.filter((_, index) => !removed.has(index));
}

function criterionIndex(current: readonly Criterion[], edit: CriterionEdit) {
  const changed = "The acceptance criteria changed. Read the issue again and retry.";
  if (edit.index !== undefined) {
    if (!Number.isInteger(edit.index) || edit.index < 0 || edit.index >= current.length) throw new Error(edit.match === undefined ? `No acceptance criterion at index ${edit.index}; the issue has ${current.length}` : changed);
    if (edit.match !== undefined && fold(current[edit.index]!.text) !== fold(edit.match)) throw new Error(changed);
    return edit.index;
  }
  if (edit.match === undefined) throw new Error("Name each criterion by index or by its current text (match)");
  const matches = current.flatMap((item, index) => fold(item.text) === fold(edit.match!) ? [index] : []);
  if (matches.length !== 1) throw new Error(matches.length ? `"${edit.match}" matches more than one criterion; use its index` : `No acceptance criterion reads "${edit.match}"`);
  return matches[0]!;
}

/** An issue is specified once it has a description and at least one acceptance criterion. */
export function isSpecified(task: { description?: string; acceptanceCriteria?: readonly Criterion[] }) {
  return Boolean(task.description?.trim()) && Boolean(task.acceptanceCriteria?.length);
}

const isNeedsSpec = (label: string) => fold(label) === fold(NEEDS_SPEC_LABEL);

/**
 * The one Needs spec rule. A new issue in Draft without a description or criteria gets the label; any issue that is
 * specified loses it. Other labels are never touched. Returns null when the labels stay as they are.
 */
export function needsSpecLabels(task: { description?: string; acceptanceCriteria?: readonly Criterion[]; labels?: readonly string[] }, created?: { inDraft: boolean }) {
  const labels = task.labels ?? [];
  const has = labels.some(isNeedsSpec);
  if (isSpecified(task)) return has ? labels.filter(label => !isNeedsSpec(label)) : null;
  // 20 is the per-issue label limit (convex/lib/labels.ts MAX_LABELS).
  if (created?.inDraft && !task.description?.trim() && !task.acceptanceCriteria?.length && !has && labels.length < 20) return [...labels, NEEDS_SPEC_LABEL];
  return null;
}
