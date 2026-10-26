// A Team Cloud's people, for "Reports to": who a bot can report to, which of them is this person, and whether this
// person may change who a bot reports to (an Admin, or the member it reports to now). Null off a team.
import { useEffect, useSyncExternalStore } from "react";
import { botOwner, nameFromEmail } from "../../shared/bot-owner";
import type { NeedsYouItem } from "../../shared/today";
import { api } from "./api";
import { teamOfConfig } from "./team-chats";
import { readSessionState } from "@/lib/session";

export interface TeamPerson { email: string; name: string; role: string; you?: true }
export interface TeamPeople { people: TeamPerson[]; me: TeamPerson | null; admin: boolean; needsYou: NeedsYouItem[] }

let snapshot: TeamPeople | null = null;
const listeners = new Set<() => void>();
/** The people on screen; null anywhere but a team's Cloud. */
export function setTeamPeople(next: TeamPeople | null): void {
  snapshot = next;
  for (const listener of listeners) listener();
}
const publish = setTeamPeople;

export function useTeamPeople(): TeamPeople | null {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => snapshot, () => snapshot);
}

/** The person a bot reports to, as the picker names them; null for a bot nobody owns. */
export function ownerOf(bot: { createdBy?: string; reportsTo?: string }, team: Pick<TeamPeople, "people"> | null): TeamPerson | null {
  const email = botOwner(bot);
  if (!email) return null;
  return team?.people.find((person) => person.email === email) ?? { email, name: nameFromEmail(email), role: "member" };
}

export function mayChangeOwner(bot: { createdBy?: string; reportsTo?: string; defaultBot?: { person?: string } }, team: TeamPeople | null): boolean {
  return Boolean(team && !bot.defaultBot?.person && (team.admin || (team.me && botOwner(bot) === team.me.email)));
}

/** Who a card in this conversation is asking: the bot's owner in a shared chat; nobody named in a private one, which is
 * the person's own. */
export function askingWhom(bot: { createdBy?: string; reportsTo?: string }, task: { private?: boolean } | undefined, team: TeamPeople | null): TeamPerson | null {
  if (!team || task?.private) return null;
  return ownerOf(bot, team);
}

async function loadPeople(): Promise<Omit<TeamPeople, "admin" | "needsYou">> {
  const answer = await api<{ people?: TeamPerson[] }>("/api/team/people", { background: true });
  const people = Array.isArray(answer?.people) ? answer.people : [];
  return { people, me: people.find((person) => person.you) ?? null };
}
async function loadNeedsYou(): Promise<NeedsYouItem[]> {
  const answer = await api<{ items?: NeedsYouItem[] }>("/api/needs-you", { background: true });
  return Array.isArray(answer?.items) ? answer.items : [];
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Something a bot asks may have changed: this person's Needs you catches up shortly, once. */
export function refreshNeedsYou(): void {
  if (!snapshot || refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void loadNeedsYou().then((needsYou) => { if (snapshot) publish({ ...snapshot, needsYou }); }).catch(() => {});
  }, 800);
}

/** Keeps the people and this person's Needs you in step with the page's server; nothing off a team. */
export function useTeamPeopleLoader(config: unknown, botsVersion: unknown) {
  const teamId = teamOfConfig(config)?.id ?? null;
  useEffect(() => {
    if (!teamId) { publish(null); return; }
    let alive = true;
    void Promise.all([loadPeople(), readSessionState(), loadNeedsYou()]).then(([people, session, needsYou]) => {
      if (alive) publish({ ...people, admin: session.kind === "session" ? session.scopes.includes("admin") : session.kind === "loopback", needsYou });
    }).catch(() => {});
    return () => { alive = false; };
  }, [teamId]);
  useEffect(() => { if (teamId) refreshNeedsYou(); }, [teamId, botsVersion]);
}

/** After an owner changed here: the people list stays, Needs you catches up. */
export function ownerChanged(): void {
  refreshNeedsYou();
}
