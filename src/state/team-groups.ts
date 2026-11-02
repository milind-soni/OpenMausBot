// A Team Cloud's groups of people (server/team-groups.ts): what Settings → People groups edits and a bot's Share dialog
// offers. Loaded once per screen that needs them and again after each change made here.
import { useEffect, useSyncExternalStore } from "react";

import type { GroupMembers } from "../../shared/bot-access";
import { listenLiveFrames } from "@/lib/live-events";
import { api } from "./store";

export interface TeamGroup { id: string; name: string; members: string[] }

let groups: TeamGroup[] | null = null;
const listeners = new Set<() => void>();
const publish = (next: TeamGroup[] | null) => {
  groups = next;
  for (const listener of listeners) listener();
};

export async function reloadTeamGroups(): Promise<void> {
  publish((await api<{ groups?: TeamGroup[] }>("/api/team/groups")).groups ?? []);
}

let listening = false;
/** Another admin's change, or someone leaving the team, arrives as a teamGroups frame. */
function listen(): void {
  if (listening) return;
  listening = true;
  listenLiveFrames({
    onFrame: (frame) => { if (frame.kind === "teamGroups") publish(frame.groups); },
    onMissedFrames: () => { if (groups) void reloadTeamGroups().catch(() => {}); },
  });
}

/** The team's groups, or null off a team and until they load. */
export function useTeamGroups(team: boolean): TeamGroup[] | null {
  useEffect(() => {
    if (!team) return;
    listen();
    void reloadTeamGroups().catch(() => {});
  }, [team]);
  const current = useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => groups, () => groups);
  return team ? current : null;
}

export const membersOf = (list: readonly TeamGroup[] | null): GroupMembers => (id) => list?.find((group) => group.id === id)?.members;

export async function saveTeamGroup(id: string | null, body: { name: string; members: string[] }): Promise<TeamGroup> {
  const answer = await api<{ group: TeamGroup; groups: TeamGroup[] }>(id ? `/api/team/groups/${id}` : "/api/team/groups", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
  publish(answer.groups);
  return answer.group;
}

export async function deleteTeamGroup(id: string): Promise<void> {
  publish((await api<{ groups: TeamGroup[] }>(`/api/team/groups/${id}`, { method: "DELETE" })).groups);
}
