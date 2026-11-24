import { useLayoutEffect, useRef, useState, type Dispatch } from "react";
import { emptyPane, MAIN_PANE, paneIds, replacePane, type PaneLayout } from "@/state/pane-layout";
import type { Action, AppState } from "@/state/store";
import { loadingPanel, type PaneTarget, type WorkspacePanes } from "@/state/fork-panel";
import { randomUuid } from "@/lib/random-uuid";

type SavedWorkspace = { layout: PaneLayout; focused: string; primary: string; targets: Map<string, PaneTarget> };

function available(state: AppState, target: PaneTarget) {
  const owner = (target.kind === "group" ? state.groups : state.bots).find(item => item.id === target.ownerId);
  return owner && (owner.threadId === target.threadId || owner.tasks?.some(task => task.threadId === target.threadId));
}

export function useResponsiveWorkspace(state: AppState, dispatch: Dispatch<Action>, wide: boolean, primary?: PaneTarget) {
  const saved = useRef<SavedWorkspace | null>(null);
  const [switchingRoom, setSwitchingRoom] = useState(false);
  useLayoutEffect(() => {
    if (!primary) return;
    const panes = state.workspacePanes;
    if (!wide && panes) {
      const targets = new Map<string, PaneTarget>([[primary.threadId, primary]]);
      for (const { kind, ownerId, threadId } of Object.values(panes.panels)) targets.set(threadId, { kind, ownerId, threadId });
      saved.current = {
        layout: replacePane(panes.layout, MAIN_PANE, primary.threadId)!,
        focused: panes.focused === MAIN_PANE ? primary.threadId : panes.focused,
        primary: primary.threadId, targets,
      };
      dispatch({ type: "closeWorkspacePanes" });
      const target = panes.panels[panes.focused];
      if (target && available(state, target)) {
        if (target.kind === "bot") dispatch({ type: "switchTask", botId: target.ownerId, threadId: target.threadId });
        else {
          dispatch({ type: "select", id: target.ownerId });
          if (state.groups.find(group => group.id === target.ownerId)?.threadId !== target.threadId) {
            setSwitchingRoom(true);
            dispatch({ type: "switchGroupTask", groupId: target.ownerId, threadId: target.threadId, onSettled: () => setSwitchingRoom(false) });
          }
        }
      }
    } else if (wide && saved.current) {
      const snapshot = saved.current;
      if (switchingRoom || state.bots.find(bot => bot.id === primary.ownerId)?.switchingTo) return;
      saved.current = null;
      const selected = primary.threadId;
      const vacancyFocused = emptyPane(snapshot.focused) && selected === snapshot.primary;
      const slot = snapshot.targets.has(selected) ? selected : snapshot.focused;
      let layout = replacePane(snapshot.layout, slot, MAIN_PANE)!;
      const panels: WorkspacePanes["panels"] = {};
      const ids = paneIds(layout);
      let vacancy = 0;
      for (const id of ids) {
        const target = snapshot.targets.get(id);
        if (!target) continue;
        if (available(state, target)) panels[id] = loadingPanel(target, randomUuid());
        else {
          while (ids.includes("slot:" + vacancy)) vacancy++;
          layout = replacePane(layout, id, "slot:" + vacancy++)!;
        }
      }
      const focused = vacancyFocused ? snapshot.focused : MAIN_PANE;
      dispatch({ type: "restorePaneLayout", panes: { layout, panels, focused } });
    }
  }, [state, dispatch, wide, primary, switchingRoom]);
}
