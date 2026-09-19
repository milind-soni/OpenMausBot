// Room/group cases. Case bodies moved verbatim from the reducer switch;
// reducer.ts dispatches each contiguous run to reduceGroups below.

import type { Action } from "../action";
import type { AppState } from "../reducer";
import type { Group } from "../model";
import { optimisticUserMessage } from "./helpers";

export type GroupsAction = Extract<Action, { type: "groupPatched" | "groupDeleted" | "patchGroup" | "renameGroupTask" | "sendGroup" }>;

export function reduceGroups(state: AppState, action: GroupsAction): AppState {
  switch (action.type) {
    case "groupPatched": {
      const exists = state.groups.some((g) => g.id === action.group.id);
      const groups = exists
        ? state.groups.map((g) => (g.id === action.group.id ? {
            ...g, ...action.group,
            section: typeof action.group.threadId === "string" || Object.hasOwn(action.group, "section") ? action.group.section : g.section,
            messages: action.group.messages ?? g.messages,
          } : g))
        : [{ ...(action.group as Group), messages: action.group.messages ?? [] }, ...state.groups];
      return { ...state, groups };
    }
    case "groupDeleted": {
      const groups = state.groups.filter((g) => g.id !== action.groupId);
      const selectedId = state.selectedId === action.groupId ? (state.bots[0]?.id ?? "") : state.selectedId;
      return { ...state, groups, selectedId };
    }
    // optimistic room edits; the server's group frame confirms them later
    case "patchGroup":
      return {
        ...state,
        groups: state.groups.map((g) => (g.id === action.groupId ? { ...g, ...action.patch } : g)),
      };
    case "renameGroupTask":
      return {
        ...state,
        groups: state.groups.map((group) =>
          group.id === action.groupId
            ? {
                ...group,
                tasks: (group.tasks ?? []).map((task) =>
                  task.threadId === action.threadId ? { ...task, title: action.title } : task,
                ),
              }
            : group,
        ),
      };
    case "sendGroup": {
      if (!action.sendId) return state;
      const group = state.groups.find((candidate) => candidate.id === action.groupId);
      const threadId = action.threadId ?? group?.threadId;
      if (!group || threadId !== group.threadId) return state;
      if (group.messages.some((message) => message.sendId === action.sendId)) return state;
      const message = optimisticUserMessage(
        action.text,
        action.sendId,
        action.replyToId,
        null,
        action.mode ?? "chat",
      );
      return {
        ...state,
        groups: state.groups.map((candidate) => candidate.id === group.id
          ? { ...candidate, messages: [...candidate.messages, message] }
          : candidate),
      };
    }
  }
  return action satisfies never;
}
