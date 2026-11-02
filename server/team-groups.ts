// A Team Cloud's groups of people ("Finance", "Support"), kept in team-groups.json. A bot's sharing can give a group a
// level (`BotAccess.groups`); each member has it while they are in the group, so adding or removing someone changes
// what they can do on every bot the group was given.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { ownerEmail } from "../shared/bot-owner.ts";
import { writeFileAtomic } from "./atomic.ts";
import { GROUP_ID, MAX_TEAM_GROUPS, MAX_VISIBILITY_PEOPLE } from "./bot-visibility.ts";

export const TEAM_GROUPS_FILE = "team-groups.json";
const MAX_NAME = 60;

const groupSchema = z.object({
  id: z.string().regex(GROUP_ID),
  name: z.string().trim().min(1).max(MAX_NAME),
  members: z.array(z.string().min(3).max(254)).max(MAX_VISIBILITY_PEOPLE),
});
const fileSchema = z.object({ version: z.literal(1), groups: z.array(groupSchema).max(MAX_TEAM_GROUPS) });

export type TeamGroup = z.infer<typeof groupSchema>;

/** What a request may set on a group: its name and the members' addresses. */
export const groupBody = z.object({
  name: z.string().trim().min(1).max(MAX_NAME),
  members: z.array(z.string().min(3).max(254)).max(MAX_VISIBILITY_PEOPLE),
}).strict();

export function createTeamGroups(dataDir: string) {
  const file = join(dataDir, TEAM_GROUPS_FILE);
  let groups: TeamGroup[] = [];
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) groups = parsed.data.groups;
    else console.warn(`team groups: ${file} is not a groups file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`team groups: ${file} is unreadable; starting fresh`);
  }
  const save = () => writeFileAtomic(file, `${JSON.stringify({ version: 1, groups })}\n`, { mode: 0o600 });
  const unique = (members: readonly string[]) => [...new Set(members.map((email) => ownerEmail(email)))].sort();
  return {
    list(): TeamGroup[] {
      return [...groups].sort((a, b) => a.name.localeCompare(b.name));
    },
    get(id: string): TeamGroup | undefined {
      return groups.find((group) => group.id === id);
    },
    members(id: string): readonly string[] | undefined {
      return groups.find((group) => group.id === id)?.members;
    },
    /** A new group when `id` is null; null when there are already as many groups as a team may have. */
    put(id: string | null, body: z.infer<typeof groupBody>): TeamGroup | null {
      const known = id ? groups.find((group) => group.id === id) : undefined;
      if (!known && groups.length >= MAX_TEAM_GROUPS) return null;
      const group: TeamGroup = { id: known?.id ?? id ?? `g-${randomBytes(6).toString("hex")}`, name: body.name.trim(), members: unique(body.members) };
      groups = [...groups.filter((one) => one.id !== group.id), group];
      save();
      return group;
    },
    /** Takes a person out of every group; the ids of the groups they were in. */
    leave(email: string): string[] {
      const address = ownerEmail(email);
      const left = groups.filter((group) => group.members.includes(address)).map((group) => group.id);
      if (!left.length) return [];
      groups = groups.map((group) => (left.includes(group.id) ? { ...group, members: group.members.filter((one) => one !== address) } : group));
      save();
      return left;
    },
    remove(id: string): TeamGroup | undefined {
      const known = groups.find((group) => group.id === id);
      if (!known) return undefined;
      groups = groups.filter((group) => group.id !== id);
      save();
      return known;
    },
  };
}

export type TeamGroups = ReturnType<typeof createTeamGroups>;
