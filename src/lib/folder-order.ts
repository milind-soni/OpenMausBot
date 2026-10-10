/** A separate payload prevents folder drags from reordering sidebar sections. */
export const FOLDER_DRAG_TYPE = "application/x-openmausbot-folder";

export function draggedFolder(raw: string, botId: string, projectIds: readonly string[]): string | null {
  try {
    const value = JSON.parse(raw);
    return value?.botId === botId && typeof value.projectId === "string" && projectIds.includes(value.projectId)
      ? value.projectId : null;
  } catch { return null; }
}

export function placeFolder(ids: readonly string[], from: string, target: string, place: "before" | "after"): string[] {
  if (from === target || !ids.includes(from) || !ids.includes(target)) return [...ids];
  const next = ids.filter((id) => id !== from);
  next.splice(next.indexOf(target) + (place === "after" ? 1 : 0), 0, from);
  return next;
}

export function moveFolder(ids: readonly string[], id: string, direction: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const target = ids[index + direction];
  return index < 0 || !target ? [...ids] : placeFolder(ids, id, target, direction < 0 ? "before" : "after");
}
