// A Team Cloud's people, for "Reports to": who a bot can report to, which of them is this person, and whether this
// person may change who a bot reports to (an Admin, or the member it reports to now). Null off a team.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { botOwner, nameFromEmail } from "../../shared/bot-owner";
import { mentionablePeople } from "../../shared/person-mention";
import type { NeedsYouItem } from "../../shared/today";
import { api } from "./api";
import { teamOfConfig } from "./team-chats";
import { openAsksOf } from "@/lib/bot-unread";
import { readSessionState } from "@/lib/session";

/** `pictureUrl`: their picture, served to the team's members only; absent when they have none. */
export interface TeamPerson { email: string; name: string; role: string; you?: true; pictureUrl?: string }
export interface TeamPeople { people: TeamPerson[]; me: TeamPerson | null; admin: boolean; needsYou: NeedsYouItem[] }

let snapshot: TeamPeople | null = null;
const listeners = new Set<() => void>();
/** The people on screen; null anywhere but a team's Cloud. */
export function setTeamPeople(next: TeamPeople | null): void {
  snapshot = next;
  for (const listener of listeners) listener();
}
const publish = setTeamPeople;

export function currentTeamPeople(): TeamPeople | null {
  return snapshot;
}

export function useTeamPeople(): TeamPeople | null {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => snapshot, () => snapshot);
}

/** On a Team Cloud: the teammates the @ list offers (everyone but this person) and each name that tags someone on the
 * team, this person included. */
export function useTeammates(): { people: TeamPerson[]; peers: Array<{ name: string; person: true }> } {
  const team = useTeamPeople();
  return useMemo(() => {
    const everyone = team?.people ?? [];
    const peers = mentionablePeople(everyone.map((person) => ({ key: person.email, name: person.name })))
      .flatMap((person) => person.names.map((name) => ({ name, person: true as const })));
    return { people: everyone.filter((person) => !person.you), peers };
  }, [team?.people]);
}

/** A person's picture: theirs as given, else the team's for that address (a person a message names). */
export function pictureOf(person: Pick<TeamPerson, "email" | "pictureUrl">, team: Pick<TeamPeople, "people"> | null): string | undefined {
  return person.pictureUrl ?? team?.people.find((known) => known.email === person.email)?.pictureUrl;
}

/** The person a bot reports to, as the picker names them; null for a bot nobody owns. */
export function ownerOf(bot: { createdBy?: string; reportsTo?: string }, team: Pick<TeamPeople, "people"> | null): TeamPerson | null {
  const email = botOwner(bot);
  if (!email) return null;
  return team?.people.find((person) => person.email === email) ?? { email, name: nameFromEmail(email), role: "member" };
}

/** The person every bot in a department reports to, when they all report to one person. */
export function departmentOwner(bots: ReadonlyArray<{ createdBy?: string; reportsTo?: string }>, team: TeamPeople | null): TeamPerson | null {
  if (!team || bots.length === 0) return null;
  const owners = bots.map((bot) => ownerOf(bot, team));
  const first = owners[0];
  return first && owners.every((owner) => owner?.email === first.email) ? first : null;
}

/** A teammate's MausBot named for its person ("MausBot · Ada"); any other bot, and the viewer's own MausBot, by its name. */
export function teamBotName(bot: { name: string; defaultBot?: { person?: string } }, team: Pick<TeamPeople, "people" | "me"> | null): string {
  const person = bot.defaultBot?.person?.trim().toLowerCase();
  if (!person || !team || team.me?.email.toLowerCase() === person) return bot.name;
  const owner = team.people.find((candidate) => candidate.email.toLowerCase() === person);
  return `${bot.name} · ${owner?.name || nameFromEmail(person)}`;
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

type VersionedBot = { id: string; reportsTo?: string; activity?: string; tasks?: ReadonlyArray<{ activity?: string; unread?: boolean; openAsks?: number }> };
/** Changes whenever something may have reached or left this person's Needs you: an owner, a bot's work, a conversation
 * read or not, an ask in their inbox answered or closed, a notification. */
export function needsYouVersion(bots: readonly VersionedBot[], groups: ReadonlyArray<{ unread?: boolean }>, notifications: ReadonlyArray<{ read: boolean }>): string {
  const bot = (one: VersionedBot) => `${one.id}:${one.reportsTo ?? ""}:${one.activity ?? ""}:${(one.tasks ?? []).filter((task) => task.activity === "waiting-on-you").length}:${(one.tasks ?? []).filter((task) => task.unread).length}:${openAsksOf(one)}`;
  return `${bots.map(bot).join("|")}|${groups.filter((group) => group.unread).length}|${notifications.length}:${notifications.filter((entry) => !entry.read).length}`;
}

let peopleTimer: ReturnType<typeof setTimeout> | null = null;
/** Someone's name or picture may have changed (every config frame follows a profile save): the people catch up
 * shortly, once. */
function refreshPeople(): void {
  if (!snapshot || peopleTimer) return;
  peopleTimer = setTimeout(() => {
    peopleTimer = null;
    void loadPeople().then((people) => { if (snapshot) publish({ ...snapshot, ...people }); }).catch(() => {});
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
  useEffect(() => { if (teamId) refreshPeople(); }, [teamId, config]);
}

/** After an owner changed here: the people list stays, Needs you catches up. */
export function ownerChanged(): void {
  refreshNeedsYou();
}
