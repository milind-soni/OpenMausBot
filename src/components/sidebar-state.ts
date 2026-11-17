import type { AppState } from "@/state/store";

/** What the sidebar list draws: a change anywhere else in the store leaves it alone. */
export const sidebarState = (s: AppState) => ({
  bots: s.bots, groups: s.groups, sections: s.sections, pendingQueued: s.pendingQueued, instances: s.instances, config: s.config, selectedId: s.selectedId,
  activeView: s.activeView, computerOpen: s.computerOpen, inspectorOpen: s.inspectorOpen, deletingBots: s.deletingBots, revealThread: s.revealThread,
  liveCall: s.liveCall, cloudHowTo: s.cloudHowTo, routineRuns: s.routineRuns, mascotMotion: s.activeView === "chat" && s.mascotMotion?.botId === s.selectedId ? s.mascotMotion : null,
});
