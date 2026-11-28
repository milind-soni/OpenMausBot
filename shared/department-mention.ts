// @<department name>: a room line that tags a department reaches each of its bots in that room. One rule for the server,
// which routes the line, and the renderer, which draws the tag and lists it.
import { isMentionBoundary, isMentionNameContinuation } from "./mention-boundary.ts";

type Member = { name: string; section?: string | null; hidden?: boolean };

/** The unnamed department has the name the roster gives it. */
export const departmentName = (section?: string | null): string => section?.trim() || "General";

/** Each department with a visible member, in member order. A department with the name of a member has no tag: that
 * name is the member's. */
export function taggableDepartments<T extends Member>(members: readonly T[]): Array<{ name: string; members: T[] }> {
  const visible = members.filter((member) => !member.hidden && member.name.trim());
  const taken = new Set(visible.map((member) => member.name.trim().toLowerCase()));
  const departments = new Map<string, { name: string; members: T[] }>();
  for (const member of visible) {
    const name = departmentName(member.section);
    const key = name.toLowerCase();
    if (taken.has(key)) continue;
    const department = departments.get(key) ?? { name, members: [] };
    department.members.push(member);
    departments.set(key, department);
  }
  return [...departments.values()];
}

/** The members of each department the line @-tags, once each. The longest known name wins, so "@Design Lead" is the
 * bot of that name and not the Design department. */
export function departmentMentions<T extends Member>(text: string, members: readonly T[]): T[] {
  const departments = taggableDepartments(members);
  if (!departments.length) return [];
  const names = [
    ...departments.map((department) => ({ name: department.name, members: department.members })),
    ...members.filter((member) => !member.hidden && member.name.trim()).map((member) => ({ name: member.name, members: [] as T[] })),
  ].sort((a, b) => b.name.length - a.name.length);
  const tagged: T[] = [];
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (!isMentionBoundary(text, at)) continue;
    const rest = text.slice(at + 1);
    const hit = names.find(({ name }) => rest.slice(0, name.length).toLowerCase() === name.toLowerCase()
      && !isMentionNameContinuation(rest.slice(name.length)));
    for (const member of hit?.members ?? []) if (!tagged.includes(member)) tagged.push(member);
  }
  return tagged;
}
