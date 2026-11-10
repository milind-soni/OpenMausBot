import { useEffect, useRef, useState } from "react";
import { Lock, Users } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useShowThreads } from "@/lib/thread-preferences";
import { openBot, useStore, type AppState, type Bot, type Group } from "@/state/store";
import { setTeamSide, showTeamSide, sideOfThread, teamSide, teamSideView, useTeamSide, type TeamSide } from "@/state/team-side";
import { markTeamPrivateChatsLineSaid, sharedChatAudience } from "./TeamPrivateChatsLine";

const SIDES = [{ side: "me", label: "teamSide.me", Icon: Lock }, { side: "team", label: "teamSide.team", Icon: Users }] as const;
const HINT_KEY = (teamId: string) => `omb.team-side-hint.${teamId}`;
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

let openedAtStart: number | null = null;
/** A conversation the app opened as it started, before it knew this is a team's Cloud, is not one the person asked for. */
function noteStart(state: Pick<AppState, "revealThread">, team: unknown): void {
  if (!team && state.revealThread) openedAtStart = state.revealThread.nonce;
}

/** What the sidebar lists on the side its switch shows; off a team, everything as ever. */
export function useTeamSideLists(state: Pick<AppState, "bots" | "groups" | "config" | "revealThread">) {
  const { team, side } = useTeamSide();
  noteStart(state, team);
  const onTeam = state.config?.team ? team : null;
  const last = useRef<{ inputs: readonly unknown[]; view: ReturnType<typeof teamSideView<Bot, Group>> } | null>(null);
  const inputs = [state.bots, state.groups, onTeam, side] as const;
  if (!last.current || inputs.some((input, index) => input !== last.current!.inputs[index])) last.current = { inputs, view: teamSideView(state.bots, state.groups, onTeam, side) };
  return last.current.view;
}

/** The side of the conversation a bot has on screen, on a team's Cloud; null anywhere else. */
export function useConversationSide(bot: Bot): TeamSide | null {
  const { state } = useStore();
  const { team } = useTeamSide();
  return state.config?.team && team ? sideOfThread(bot, bot.threadId) : null;
}

function hintDue(teamId: string): boolean {
  try {
    if (typeof localStorage === "undefined" || localStorage.getItem(HINT_KEY(teamId))) return false;
    localStorage.setItem(HINT_KEY(teamId), String(Date.now()));
    markTeamPrivateChatsLineSaid(teamId);
    return true;
  } catch {
    return false;
  }
}

/** The first time a person sees the switch on this device, one line says what its two sides are. It says who reads a
 * private chat too, so the first private chat's own sentence is not said on top of it. */
function FirstLine({ teamId }: { teamId: string }) {
  const [due] = useState(() => hintDue(teamId));
  if (!due) return null;
  return <p role="status" data-team-side-hint className="px-1 pt-1.5 text-[12px] leading-4 text-ink-secondary">{t("teamSide.hint")}</p>;
}

/**
 * At the top of a team's sidebar: "Just me", the person's private chats with each bot, and "Team", what everyone shares.
 * The sidebar lists the chosen side. `compact`: the sidebar as a rail of icons. `listOnly`: the sidebar covers the
 * conversation (a phone's bot list), so choosing a side changes the list and opens nothing.
 */
export function TeamSideSwitch({ compact, listOnly = false }: { compact: boolean; listOnly?: boolean }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const { team, side } = useTeamSide();
  const view = useTeamSideLists(state);
  if (!team || !view.switchable) return null;
  const choose = (next: TeamSide) => {
    if (next === side) return;
    setTeamSide(next, team);
    if (listOnly || state.activeView !== "chat") return;
    const there = teamSideView(state.bots, state.groups, team, next);
    if (there.groups.some((group) => group.id === state.selectedId)) return;
    const target = there.bots.find((bot) => bot.id === state.selectedId) ?? there.bots.find((bot) => !bot.sidebarHidden);
    const bot = target && state.bots.find((candidate) => candidate.id === target.id);
    if (bot) openBot(dispatch, bot, showThreads);
    else if (there.groups[0]) dispatch({ type: "select", id: there.groups[0].id });
  };
  return (
    <div data-team-side={side} className={compact ? "mx-auto mb-1" : "px-3 pb-1.5"}>
      <div role="radiogroup" aria-label={t("teamSide.label")}
        className={cn("flex rounded-full bg-ink/[0.06] p-0.5 ring-[0.5px] ring-inset ring-ink/[0.07]", compact && "flex-col rounded-[14px]")}>
        {SIDES.map(({ side: option, label, Icon }) => {
          const on = option === side;
          const unread = !on && view.unread[option];
          return (
            <button key={option} type="button" role="radio" aria-checked={on} data-team-side-option={option} onClick={() => choose(option)}
              aria-label={compact ? t(label) : undefined} title={compact ? t(label) : undefined}
              className={cn("relative flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-colors", FOCUS,
                compact ? "size-9 rounded-xl" : "h-8 min-w-0 flex-1 px-3 text-[13px]",
                on ? "bg-composer text-ink shadow-[0_1px_2px_rgb(0_0_0/0.12)] ring-[0.5px] ring-ink/10" : "text-ink-secondary hover:text-ink")}>
              {compact ? <Icon size={16} strokeWidth={1.75} aria-hidden="true" /> : t(label)}
              {unread && <span role="img" data-team-side-unread={option} aria-label={t("task.unread")}
                className={cn("size-1.5 rounded-full bg-accent", compact && "absolute right-1.5 top-1.5")} />}
            </button>
          );
        })}
      </div>
      {!compact && <FirstLine key={team.teamId} teamId={team.teamId} />}
    </div>
  );
}

let known = new Set<string>();
let lastChat: string | null = null;
/** Tests only. */
export function forgetShownConversations(): void {
  known = new Set();
  lastChat = null;
  openedAtStart = null;
}

/**
 * By the message box of every conversation on a team's Cloud: who can read what is typed there. It is read from the
 * conversation itself, as the server sent it, never from the sidebar's switch.
 *
 * The switch follows a conversation the person asked for (another bot or group chat, a conversation this page opened by
 * name, one they just made), and that is kept as their choice. A conversation of the other side that came on screen
 * unasked (the first one a page shows, one the app opened as it started, or the bot's own pick changing under them) is
 * never kept: the page goes back to the side they chose, to their own conversation with this bot when it is listed there.
 */
export function TeamAudienceLabel({ bot, group }: { bot?: Bot; group?: Group }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const { team } = useTeamSide();
  noteStart(state, team);
  const teamName = state.config?.team?.name;
  const side: TeamSide | null = !team || !teamName ? null : group ? "team" : bot ? sideOfThread(bot, bot.threadId) : null;
  const shown = group?.threadId ?? bot?.threadId;
  const person = team?.person;
  useEffect(() => {
    const chat = group?.id ?? bot?.id;
    if (!team || !person || !side || !shown || !chat) return;
    const justMade = known.size > 0 && !known.has(shown);
    known = new Set([...state.bots.flatMap((each) => (each.tasks ?? []).map((task) => task.threadId)), ...state.groups.map((each) => each.threadId)]);
    if (state.activeView !== "chat" || state.selectedId !== chat) return;
    const movedHere = lastChat !== null && lastChat !== chat;
    lastChat = chat;
    const showing = teamSide(team);
    if (showing === side || bot?.switchingTo) return;
    const askedFor = state.revealThread?.threadId === shown && state.revealThread.nonce !== openedAtStart;
    if (group || movedHere || askedFor || (justMade && side === "me")) { setTeamSide(side, team); return; }
    const lists = teamSideView(state.bots, state.groups, team, showing);
    const there = lists.switchable ? lists.bots : [];
    const target = there.find((candidate) => candidate.id === chat) ?? there.find((candidate) => !candidate.sidebarHidden);
    const landing = target && state.bots.find((candidate) => candidate.id === target.id);
    if (landing) openBot(dispatch, landing, showThreads);
    else showTeamSide(side, team);
  }, [team?.teamId, person, shown, side, bot?.switchingTo]);
  if (!side || !teamName) return null;
  const Icon = side === "me" ? Lock : Users;
  const label = side === "me" ? t("team.privateHeader") : group ? t("teamSide.groupAudience") : sharedChatAudience(teamName, bot?.onlyPeopleAdded);
  return (
    <div role="note" data-team-audience={side} className="relative z-[1] flex items-center gap-1 px-2 pb-1 text-[12px] leading-4 text-ink-secondary">
      <Icon size={12} aria-hidden="true" className="shrink-0" /><span className="truncate">{label}</span>
    </div>
  );
}
