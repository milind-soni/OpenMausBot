// "Who reports to whom" on a Team Cloud: one column per person, each with their Chief of Staff and the bots that report
// to them grouped by department, and a column for bots nobody owns yet.
import { botOwner, nameFromEmail } from "../../shared/bot-owner";
import type { TeamPerson } from "@/state/team-people";

export interface OrgBot { id: string; name: string; hidden?: boolean; section?: string; chiefOfStaff?: boolean; createdBy?: string; reportsTo?: string }
export interface OrgDepartment<T extends OrgBot> { key: string; bots: T[] }
export interface OrgColumn<T extends OrgBot> { person: TeamPerson | null; chief: T | null; departments: OrgDepartment<T>[] }

const departmentsOf = <T extends OrgBot>(bots: T[]): OrgDepartment<T>[] => {
  const groups = new Map<string, T[]>();
  for (const bot of bots) {
    const key = bot.section?.trim() || "";
    groups.set(key, [...(groups.get(key) ?? []), bot]);
  }
  return [...groups].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([key, members]) => ({ key, bots: members.sort((x, y) => x.name.localeCompare(y.name)) }));
};

/** Every person gets a column, so a bot can be dropped on anyone; this person's comes first. */
export function buildOrgChart<T extends OrgBot>(bots: readonly T[], people: readonly TeamPerson[]): OrgColumn<T>[] {
  const shown = bots.filter((bot) => !bot.hidden);
  const known = new Set(people.map((person) => person.email));
  const unlisted = [...new Set(shown.map((bot) => botOwner(bot)).filter((email): email is string => email !== null && !known.has(email)))]
    .map((email): TeamPerson => ({ email, name: nameFromEmail(email), role: "member" }));
  const ordered = [...people, ...unlisted].sort((a, b) => Number(Boolean(b.you)) - Number(Boolean(a.you)));
  const columns: OrgColumn<T>[] = ordered.map((person) => {
    const own = shown.filter((bot) => botOwner(bot) === person.email);
    const chief = own.find((bot) => bot.chiefOfStaff) ?? null;
    return { person, chief, departments: departmentsOf(own.filter((bot) => bot !== chief)) };
  });
  const unowned = shown.filter((bot) => !botOwner(bot));
  if (unowned.length) columns.push({ person: null, chief: null, departments: departmentsOf(unowned) });
  return columns;
}
