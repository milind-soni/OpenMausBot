import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { api, useStore } from "@/state/store";
import { transitionComputerControlLease, type ComputerControlAction } from "@/lib/computer-control";
import type { ComputerPanelView } from "@/lib/computer-panel-view";

const computerControlSnapshotSchema = z.object({
  held: z.boolean().optional().default(false),
  helpReason: z.string().nullable().optional().default(null),
}).passthrough();

/** Who is driving the computer: the server-side control lease for this bot,
 * kept fresh by SSE and a mount fetch, plus the guarded actions that
 * transition it while every non-browser surface is gated. */
export function useComputerControl({
  botId,
  panelView,
  setError,
}: {
  botId: string;
  panelView: ComputerPanelView;
  setError: (error: Error | string | null) => void;
}) {
  const { state, dispatch } = useStore();
  const [controlPending, setControlPending] = useState(false);
  const control = state.computerControl[botId] ?? { held: false, helpReason: null };

  // who-is-driving: SSE keeps this fresh; the mount fetch covers a panel
  // opened after the last frame (e.g. an app reload mid-hold)
  useEffect(() => {
    let alive = true;
    api(`/api/bots/${botId}/computer/control`)
      .then((raw) => {
        if (!alive) return;
        const snap = computerControlSnapshotSchema.parse(raw);
        dispatch({
          type: "computerControl",
          botId,
          held: snap.held === true,
          helpReason: snap.helpReason,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  const requestControl = useCallback(async (action: ComputerControlAction) => {
    const snap = computerControlSnapshotSchema.parse(await api(`/api/bots/${botId}/computer/control`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }));
    dispatch({
      type: "computerControl",
      botId,
      held: snap.held === true,
      helpReason: snap.helpReason,
    });
    return snap;
  }, [botId, dispatch]);

  // The engine owns its browser; there is no native surface to hold.
  const setNativeBrowserControl = useCallback(async (): Promise<boolean> => true, []);

  const transitionControl = useCallback(async (action: ComputerControlAction) => {
    // BrowserPanel performs the same two-phase transition itself. Every
    // other computer surface must also gate Electron's direct browser host:
    // the server hold is bot-wide, and a shell-capable agent can otherwise
    // bypass the server proxy while the person drives Local VM/Box/VPS.
    return transitionComputerControlLease({
      action,
      syncNativeBrowser: panelView !== "browser",
      requestControl,
      setNativeBrowserControl,
    });
  }, [panelView, requestControl, setNativeBrowserControl]);

  const controlAction = useCallback(async (action: ComputerControlAction): Promise<boolean> => {
    setControlPending(true);
    setError(null);
    try {
      await transitionControl(action);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setControlPending(false);
    }
  }, [transitionControl, setError]);

  return { control, controlPending, setControlPending, controlAction, transitionControl };
}
