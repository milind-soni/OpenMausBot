import { useEffect, useRef } from "react";

import { isMacPlatform } from "@/lib/keyboard-shortcuts";
import { matchesShortcutChord, useStartFreshShortcut } from "@/lib/start-fresh-shortcut";
import { useStoreSelector } from "@/state/store-select";
import { useContextAction } from "./ContextWarning";

export interface StartFreshAvailability {
  active: boolean;
  blockedByModal: boolean;
  mayWrite: boolean;
  busy: boolean;
  pending: boolean;
  messageCount: number;
  atFreshStart: boolean;
}

/** Follows the exact availability rules of the existing Start fresh buttons while guarding modal/inactive panes. */
export function canTriggerStartFresh(state: StartFreshAvailability): boolean {
  return (
    state.active &&
    !state.blockedByModal &&
    state.mayWrite &&
    !state.busy &&
    !state.pending &&
    state.messageCount > 0 &&
    !state.atFreshStart
  );
}

/** Triggers Start fresh on the active conversation when the configured keyboard shortcut is pressed. */
export function useStartFreshShortcutAction({
  botId,
  threadId,
  active,
  mayWrite,
  busy,
  messageCount,
  atFreshStart,
}: Omit<StartFreshAvailability, "blockedByModal" | "pending"> & {
  botId: string;
  threadId: string;
}): void {
  const chord = useStartFreshShortcut();
  const { pending, run } = useContextAction();
  const blockedByModal = useStoreSelector((state) => state.shortcutsOpen || state.appSettingsOpen || state.pluginsOpen);

  const latest = useRef({ botId, threadId, chord, active, blockedByModal, mayWrite, busy, pending, messageCount, atFreshStart, run });
  latest.current = { botId, threadId, chord, active, blockedByModal, mayWrite, busy, pending, messageCount, atFreshStart, run };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = latest.current;
      if (!current.chord || event.repeat || !current.active || current.blockedByModal) return;
      if (event.target instanceof Element && event.target.closest("dialog, [role=dialog], [role=alertdialog]")) return;
      if (!matchesShortcutChord(event, current.chord, isMacPlatform())) return;
      event.preventDefault();
      if (!canTriggerStartFresh(current)) return;
      current.run(`/api/bots/${current.botId}/start-fresh`, { threadId: current.threadId });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
