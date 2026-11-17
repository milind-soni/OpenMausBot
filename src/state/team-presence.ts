// Who is here on a team's Cloud (docs/team-cloud.md "Who is here"): this window tells the server which shared
// conversation is in front of the person, and keeps what the server says back: who is here (on the people list) and who
// else has a shared conversation open. A private chat is never named to the server here: the window says it shows no
// conversation. Nothing at all against a server that sends no presence.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { HERE_REPEAT_MS, PRESENCE_HERE_PATH, type PresenceFrame, type PresenceHereBody } from "../../shared/team-presence";
import type { ServerFrame } from "../../shared/wire";
import { listenLiveFrames } from "@/lib/live-events";
import { api } from "./api";
import type { AppState } from "./store";
import { rereadTeamChats } from "./team-chats";
import { currentTeamPeople, reloadTeamPeople, setTeamPeople, useTeamPeople, type TeamPerson } from "./team-people";

const NOBODY: readonly string[] = [];
let threads = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
function setThreads(next: Map<string, readonly string[]>): void {
  threads = next;
  for (const listener of listeners) listener();
}

/** A frame about presence, from the live stream. */
export function applyPresenceFrame(frame: PresenceFrame): void {
  switch (frame.kind) {
    case "team.presence": {
      const team = currentTeamPeople();
      if (!team) return;
      if (!team.people.some((person) => person.email === frame.email)) return reloadTeamPeople();
      const people = team.people.map((person) => person.email === frame.email ? { ...person, here: frame.here } : person);
      setTeamPeople({ ...team, people, me: people.find((person) => person.you) ?? null, presence: true });
      return;
    }
    case "thread.presence":
      return setThreads(new Map(threads).set(frame.threadId, frame.people));
    case "team.people":
      reloadTeamPeople();
      rereadTeamChats();
  }
}

const PRESENCE_KINDS = new Set<string>(["team.presence", "thread.presence", "team.people"]);
const isPresenceFrame = (frame: ServerFrame): frame is PresenceFrame => PRESENCE_KINDS.has(frame.kind);

/** The others who have this shared conversation open now; empty for any other conversation. */
export function useThreadPresence(threadId: string | null | undefined): { here: TeamPerson[] } {
  const team = useTeamPeople();
  const emails = useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => (threadId ? threads.get(threadId) : undefined) ?? NOBODY, () => NOBODY);
  return useMemo(() => {
    if (!team?.presence || !threadId) return { here: [] };
    return { here: emails.flatMap((email) => {
      const person = team.people.find((one) => one.email === email);
      return person && !person.you ? [person] : [];
    }) };
  }, [team, threadId, emails]);
}

/** The conversation in front of the person when it is one others can read too: a team bot's shared chat or a group
 * chat. Null for a private chat, a member's own MausBot, and anywhere that is not a chat. */
export function sharedThreadOf(state: Pick<AppState, "activeView" | "selectedId" | "bots" | "groups">): string | null {
  if (state.activeView !== "chat") return null;
  const group = state.groups.find((one) => one.id === state.selectedId);
  if (group) return group.threadId;
  const bot = state.bots.find((one) => one.id === state.selectedId);
  if (!bot || bot.defaultBot?.person) return null;
  const threadId = bot.switchingTo ?? bot.threadId;
  return bot.tasks?.find((task) => task.threadId === threadId)?.private === true ? null : threadId;
}

const newTab = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).slice(0, 64);

/** On a team whose server says who is here: keeps the server told which shared conversation this window shows, and keeps
 * what it says back. */
export function useTeamPresence(state: Pick<AppState, "activeView" | "selectedId" | "bots" | "groups">): void {
  const team = useTeamPeople();
  const supported = team?.presence === true;
  const open = supported ? sharedThreadOf(state) : null;
  const latest = useRef({ open, supported });
  latest.current = { open, supported };
  const send = useRef<() => void>(() => {});
  const missed = useRef<() => void>(() => {});

  // A stream that came back without its replay missed frames: the people again, and this window anew, so the server
  // sends the lists again.
  useEffect(() => listenLiveFrames({
    onFrame: (frame) => { if (isPresenceFrame(frame)) applyPresenceFrame(frame); },
    onMissedFrames: () => { setThreads(new Map()); reloadTeamPeople(); missed.current(); },
  }), []);

  useEffect(() => {
    if (!supported) { setThreads(new Map()); return; }
    let tab = newTab();
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const post = (body: PresenceHereBody, background: boolean) =>
      void api(PRESENCE_HERE_PATH, { method: "POST", body: JSON.stringify(body), background }).catch(() => {});
    send.current = () => {
      if (latest.current.supported) post({ tab, threadId: visible() ? latest.current.open : null }, visible());
    };
    const onVisibility = () => send.current();
    const repeat = setInterval(() => { if (visible()) send.current(); }, HERE_REPEAT_MS);
    missed.current = () => { tab = newTab(); send.current(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(repeat);
      document.removeEventListener("visibilitychange", onVisibility);
      send.current = () => {};
      missed.current = () => {};
    };
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    const timer = setTimeout(() => send.current(), 250);
    return () => clearTimeout(timer);
  }, [supported, open]);
}
