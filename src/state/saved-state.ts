import type { Action, BotAnnouncement, Group } from "./store";

export type SavedOwner = { botId: string } | { groupId: string };

export interface SavedSnapshot {
  bots: BotAnnouncement[];
  groups?: Array<Partial<Group> & { id: string }>;
}

export function savedStateAction(owner: SavedOwner, snapshot: SavedSnapshot): Extract<Action, { type: "botPatched" | "groupPatched" }> | undefined {
  if ("botId" in owner) {
    const bot = snapshot.bots.find((candidate) => candidate.id === owner.botId);
    if (!bot) return undefined;
    const { messages: _messages, ...settings } = bot;
    return { type: "botPatched", bot: settings };
  }
  const group = snapshot.groups?.find((candidate) => candidate.id === owner.groupId);
  if (!group) return undefined;
  const { messages: _messages, hasMore: _hasMore, ...settings } = group;
  return { type: "groupPatched", group: settings };
}
