// A Team Cloud's conversation actions: sharing a private conversation (with the team, or with one person) and saving a
// message to a bot's team memory. Which actions show follows the server's answer on the task; the server refuses
// anything else in any case.
import { createContext, useEffect, useState, useSyncExternalStore } from "react";

import { api, type Bot, type Task } from "@/state/store";

export interface ConversationTarget { botId: string; threadId: string }
export type ConversationDialog =
  | (ConversationTarget & { kind: "team" | "person" })
  | (ConversationTarget & { kind: "memory"; messageId: string; text: string });

export interface Sharing { shared: "team" | { email: string; name: string } | null; people: Array<{ email: string; name: string }> }
export interface TeamMemoryEntry { id: string; text: string; at: number; yours?: true }

export const TEAM_MEMORY_ITEM = "team-memory";
/** Whether the messages drawn below offer "Save to team memory": set once by the conversation, so a row never reads the
 * store to know. */
export const TeamMemorySavesContext = createContext(false);

let dialog: ConversationDialog | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };

export function openConversationDialog(next: ConversationDialog): void {
  dialog = next;
  changed();
}

export function closeConversationDialog(): void {
  dialog = null;
  changed();
}

export function useConversationDialog(): ConversationDialog | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => dialog, () => dialog);
}

/** What this person can do with a conversation's sharing: its own person shares a private one either way, and widens one
 * they shared with one person to the team. Never a bot's shared chat or a chat with their own MausBot. */
export function shareChoices(bot: Pick<Bot, "defaultBot">, task: Pick<Task, "private" | "shared" | "sharedWith" | "sharedChat"> | undefined, onTeam: boolean): { team: boolean; person: boolean } {
  if (!onTeam || !task || bot.defaultBot?.person || task.sharedChat) return { team: false, person: false };
  if (task.private === true && !task.shared) return { team: true, person: true };
  return { team: task.sharedWith?.byYou === true, person: false };
}

/** Saving a message to the bot's team memory: on a team, for a bot the person can chat with that isn't their own MausBot. */
export function savesToTeamMemory(bot: Pick<Bot, "defaultBot" | "yourAccess"> | undefined, onTeam: boolean): boolean {
  return onTeam && Boolean(bot) && !bot!.defaultBot?.person && bot!.yourAccess !== "view";
}

const sharePath = ({ botId, threadId }: ConversationTarget) => `/api/bots/${encodeURIComponent(botId)}/tasks/${encodeURIComponent(threadId)}/share`;

export const sharingOf = (target: ConversationTarget) => api<Sharing>(sharePath(target));

export const shareConversation = (target: ConversationTarget, to: "team" | { email: string }) =>
  api<{ shared: Sharing["shared"] }>(sharePath(target), { method: "POST", body: JSON.stringify({ with: to }) });

export const saveToTeamMemory = (target: ConversationTarget & { messageId: string; text: string }) =>
  api<{ entry: TeamMemoryEntry }>(`/api/bots/${encodeURIComponent(target.botId)}/memory/team`, {
    method: "POST", body: JSON.stringify({ threadId: target.threadId, messageId: target.messageId, text: target.text }),
  });

export const teamMemoryEntries = (botId: string) => api<{ entries: TeamMemoryEntry[] }>(`/api/bots/${encodeURIComponent(botId)}/memory/team`);

export const removeTeamMemoryEntry = (botId: string, id: string) =>
  api(`/api/bots/${encodeURIComponent(botId)}/memory/team/${encodeURIComponent(id)}`, { method: "DELETE" });

/** The lines saved to a bot's team memory that this person may take out: their own, or every line for an admin. Read
 * again whenever `version` changes. */
export function useTeamMemoryEntries(botId: string, on: boolean, version: unknown): { entries: TeamMemoryEntry[]; remove(id: string): Promise<void> } {
  const [state, setState] = useState<{ botId: string; entries: TeamMemoryEntry[] }>({ botId, entries: [] });
  const read = (cancelled?: () => boolean) => teamMemoryEntries(botId).then((answer) => { if (!cancelled?.()) setState({ botId, entries: answer.entries }); }, () => {});
  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    void read(() => cancelled);
    return () => { cancelled = true; };
  }, [botId, on, version]);
  return {
    entries: on && state.botId === botId ? state.entries : [],
    remove: async (id) => { await removeTeamMemoryEntry(botId, id); await read(); },
  };
}
