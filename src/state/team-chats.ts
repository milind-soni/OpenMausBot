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

/** The team on screen, whether this person is a Member (no admin scope), and the conversations the server says they
 * opened: null anywhere but a team's Cloud. */
export type TeamChats = { teamId: string; member: boolean; opened?: readonly string[] };

type TaskLike = { threadId: string; createdAt?: number; updatedAt?: number; private?: unknown; routineRunId?: unknown; openedBy?: unknown; archivedAt?: unknown; closedBy?: unknown };
type BotLike = { id: string; tasks?: TaskLike[] };

let current: TeamChats | null = null;
export function setTeamChats(next: TeamChats | null) {
  current = next;
}
export function teamChats(): TeamChats | null {
  return current;
}

/** A conversation this page just made: the person's own, which the session it read before does not list yet. */
export function rememberOwnChat(teamId: string, threadId: string) {
  if (current?.teamId === teamId && !current.opened?.includes(threadId)) current = { ...current, opened: [...(current.opened ?? []), threadId] };
}

/** A person's own conversation: private, open, and opened by a person (not a routine's report or a bot's thread). */
const ownKind = (task: TaskLike) => task.private === true && !task.routineRunId && !task.openedBy && !task.archivedAt && !task.closedBy;
const newest = (tasks: TaskLike[]) => [...tasks].sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))[0];

/** The conversation clicking this team bot opens: the person's newest own (for an Admin, of those the server says they
 * opened); null when there is none yet (one is made). Never the main chat, and for an Admin never a chat only marked
 * private. */
export function ownChatOf(bot: BotLike, team: TeamChats): string | null {
  const own = (bot.tasks ?? []).filter(ownKind);
  const opened = new Set(team.opened ?? []);
  return newest(team.member ? own : own.filter((task) => opened.has(task.threadId)))?.threadId ?? null;
}

const making = new Set<string>();
/** On a team: opens the person's own conversation with `bot` through `open`, or makes it and opens it. False anywhere
 * else, so the caller opens the bot as it always has. */
export function openOwnTeamChat(dispatch: (action: Action) => void, bot: BotLike, open: (threadId: string) => void): boolean {
  const team = current;
  if (!team) return false;
  const own = ownChatOf(bot, team);
  if (own) { open(own); return true; }
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

/** Keeps the sidebar's rule in step with the page's server: on a team, the person's own conversations; a Member until
 * the session says otherwise is never assumed (an Admin's rule is the safe one). */
export function useTeamChats(config: unknown) {
  const teamId = teamOfConfig(config)?.id ?? null;
  useEffect(() => {
    if (!teamId) { setTeamChats(null); return; }
    setTeamChats({ teamId, member: false });
    let alive = true;
    void readSessionState().then((session) => {
      if (alive && session.kind === "session") setTeamChats({ teamId, member: !session.scopes.includes("admin"), opened: session.openedThreads ?? [] });
    }).catch(() => {});
    return () => { alive = false; };
  }, [teamId]);
}
