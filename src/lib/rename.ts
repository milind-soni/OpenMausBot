// Inline rename: keep the old name when the draft is empty or unchanged.

export function nextRename(current: string, draft: string): string | null {
  const next = draft.trim();
  if (!next || next === current) return null;
  return next;
}
