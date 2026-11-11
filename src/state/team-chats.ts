// On a team's Cloud a bot's main chat is the team's; a conversation a person opens with the bot is theirs alone (no other
// member and no admin sees it, `private: true` on the wire). Clicking a team bot in the sidebar opens that conversation,
// and makes it the first time through the server's own new-conversation route (POST /api/bots/<id>/tasks), which records
// the person who opened it. Group chats and every other place open as before.
//
// The server sends each person only their own private chats, an Admin's included. It also says which conversations they
// opened (`openedThreads` on /api/auth/session), and an Admin's own chat is still picked from those: a server from before
// private chats were theirs alone sent an Admin every member's.
import { useEffect } from "react";
import { api } from "./api";
import type { Action, Bot } from "./store";
import { readSessionState } from "@/lib/session";

/** The team on screen, whether this person is a Member (no admin scope), the conversations the server says they opened
 * and the address they signed in with: null anywhere but a team's Cloud. */
export type TeamChats = { teamId: string; member: boolean; opened?: readonly string[]; person?: string };

type TaskLike = { threadId: string; createdAt?: number; updatedAt?: number; private?: unknown; inbox?: unknown; routineRunId?: unknown; openedBy?: unknown; archivedAt?: unknown; closedBy?: unknown };
type BotLike = { id: string; tasks?: TaskLike[]; yourAccess?: string };

let current: TeamChats | null = null;
const watchers = new Set<() => void>();
/** Hears every change of the team on screen, the person signed in and the conversations known to be theirs. */
export function onTeamChats(watcher: () => void): void {
  watchers.add(watcher);
}
export function setTeamChats(next: TeamChats | null) {
  current = next;
  for (const watcher of watchers) watcher();
}
export function teamChats(): TeamChats | null {
  return current;
}

/** A conversation this page just made: the person's own, which the session it read before does not list yet. */
export function rememberOwnChat(teamId: string, threadId: string) {
  if (current?.teamId === teamId && !current.opened?.includes(threadId)) setTeamChats({ ...current, opened: [...(current.opened ?? []), threadId] });
}

/** A conversation this person started on a team (the session's list, and one this page just made before its task arrives):
 * theirs alone, so it is never shown as the shared chat. */
export const ownChatStarted = (threadId: string | undefined) => Boolean(threadId && current?.opened?.includes(threadId));

/** A person's own conversation: private, open, and opened by a person (not a routine's report or a bot's thread). */
const ownKind = (task: TaskLike) => task.private === true && !task.routineRunId && !task.openedBy && !task.archivedAt && !task.closedBy;
const newest = (tasks: TaskLike[]) => [...tasks].sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))[0];

/** The conversation clicking this team bot opens: the person's inbox when this bot is where it lives (the server marks it
 * for its person alone), else their newest own (for an Admin, of those the server says they opened); null when there is
 * none yet (one is made). Never the main chat, and for an Admin never a chat only marked private. */
export function ownChatOf(bot: BotLike, team: TeamChats): string | null {
  const own = (bot.tasks ?? []).filter(ownKind);
  const opened = new Set(team.opened ?? []);
  const mine = team.member ? own : own.filter((task) => opened.has(task.threadId));
  return (own.find((task) => task.inbox === true) ?? newest(mine))?.threadId ?? null;
}

const making = new Set<string>();
/** On a team: opens the person's own conversation with `bot` through `open`, or makes it and opens it, once the session
 * has said which conversations are theirs: before that their own chat is not known from anyone's, and a second one would
 * be made. False anywhere else, and for a bot this person can only view and has no conversation of their own with, so the caller opens the bot
 * as it always has: its main chat. */
export function openOwnTeamChat(dispatch: (action: Action) => void, bot: BotLike, open: (threadId: string) => void): boolean {
  const team = current;
  if (!team) return false;
  if (team.opened === undefined) {
    const whenRead = () => {
      if (current && current.opened === undefined) return;
      watchers.delete(whenRead);
      if (current) openOwnTeamChat(dispatch, bot, open);
    };
    watchers.add(whenRead);
    return true;
  }
  const own = ownChatOf(bot, team);
  if (own) { open(own); return true; }
  if (bot.yourAccess === "view") return false;
  if (making.has(bot.id)) return true;
  making.add(bot.id);
  void api<{ bot?: Bot; task?: { threadId?: string } }>(`/api/bots/${bot.id}/tasks`, { method: "POST", body: "{}" })
    .then((response) => {
      if (typeof response?.task?.threadId === "string") rememberOwnChat(team.teamId, response.task.threadId);
      if (!response?.bot) return;
      dispatch({ type: "taskSwitched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
    })
    .catch((error: unknown) => dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) }))
    .finally(() => making.delete(bot.id));
  return true;
}

/** The team this page's server is the home of (its config's `team`), else null. */
export function teamOfConfig(config: unknown): { id: string } | null {
  const team = (config as { team?: { id?: unknown } } | null | undefined)?.team;
  return typeof team?.id === "string" && team.id ? { id: team.id } : null;
}

const chatsOf = (teamId: string, session: { scopes: string[]; openedThreads?: string[]; email?: string }): TeamChats =>
  ({ teamId, member: !session.scopes.includes("admin"), opened: session.openedThreads ?? [], ...(session.email?.trim() ? { person: session.email.trim().toLowerCase() } : {}) });

/** The person's role may have changed: read the session again. */
export function rereadTeamChats(): void {
  const teamId = current?.teamId;
  if (!teamId) return;
  void readSessionState().then((session) => {
    if (current?.teamId === teamId && session.kind === "session") setTeamChats(chatsOf(teamId, session));
  }).catch(() => {});
}

/** Keeps the sidebar's rule in step with the page's server: on a team, the person's own conversations; a Member until
 * the session says otherwise is never assumed (an Admin's rule is the safe one). */
export function useTeamChats(config: unknown) {
  const teamId = teamOfConfig(config)?.id ?? null;
  useEffect(() => {
    if (!teamId) { setTeamChats(null); return; }
    setTeamChats({ teamId, member: false });
    let alive = true;
    void readSessionState().then((session) => {
      if (alive) setTeamChats(session.kind === "session" ? chatsOf(teamId, session) : { teamId, member: false, opened: [] });
    }).catch(() => { if (alive) setTeamChats({ teamId, member: false, opened: [] }); });
    return () => { alive = false; };
  }, [teamId]);
}
