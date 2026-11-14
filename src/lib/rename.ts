export function nextRename(current: string, draft: string): string | null {
  const next = draft.trim();
  if (!next || next === current) return null;
  return next;
}
