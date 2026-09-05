// The durable who-is-driving lease for one bot's browser, as the chat dock
// and the expanded workspace both need it: read the snapshot on mount, then
// take / release through the server. BrowserPanel layers the native Electron
// gate on top (see transitionBrowserControlLease); this hook only owns the
// server half and the store copy every panel reads.
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { api, useStore } from "@/state/store";

const controlSnapshotSchema = z.looseObject({
  held: z.boolean().optional().default(false),
  helpReason: z.string().nullable().optional().default(null),
});

export type BrowserControlAction = "take" | "release" | "dismiss-help";

export function useBrowserControl(botId: string) {
  const { state, dispatch } = useStore();
  const control = state.computerControl[botId] ?? { held: false, helpReason: null };
  const [controlPending, setControlPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api(`/api/bots/${botId}/computer/control`)
      .then((raw) => {
        if (!alive) return;
        const snap = controlSnapshotSchema.parse(raw);
        dispatch({ type: "computerControl", botId, held: snap.held === true, helpReason: snap.helpReason });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [botId, dispatch]);

  /** Resolves true only when the durable lease reached the requested state:
   * a 200 that left the lease unchanged must not advance Electron's gate. */
  const controlAction = useCallback(
    async (action: BrowserControlAction): Promise<boolean> => {
      setControlPending(true);
      setError(null);
      try {
        const snap = controlSnapshotSchema.parse(
          await api(`/api/bots/${botId}/computer/control`, {
            method: "POST",
            body: JSON.stringify({ action }),
          }),
        );
        dispatch({ type: "computerControl", botId, held: snap.held === true, helpReason: snap.helpReason });
        if (action === "dismiss-help") return snap.helpReason === null;
        return snap.held === (action === "take");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        setControlPending(false);
      }
    },
    [botId, dispatch],
  );

  return { control, controlPending, controlAction, error, setError };
}
