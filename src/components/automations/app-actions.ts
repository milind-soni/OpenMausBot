// The automation actions with app events added: pause, run now and delete reach /api/app-triggers for kind "app".
import { useState } from "react";

import { appTriggerApi } from "@/lib/app-triggers";
import type { Automation } from "@/lib/automations";
import { useAutomationActions } from "./actions";

/** What `busy` is while "Pause all" / "Resume all" writes: every switch waits for it. */
export const SET_ALL_BUSY = "toggle:all";

export function useAllAutomationActions() {
  const base = useAutomationActions();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const attempt = async (key: string, work: () => Promise<unknown>) => {
    if (busy || base.busy) return;
    setBusy(key);
    setError("");
    try { await work(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(null); }
  };
  /** Runs a schedule's or another app's own action: an earlier "Pause all" refusal is no longer the latest word. */
  const handOn = <T>(action: () => T): T => {
    if (!base.busy) setError("");
    return action();
  };
  return {
    ...base,
    busy: busy ?? base.busy,
    error: error || base.error,
    setError: (message: string) => { setError(message); base.setError(message); },
    /** "Pause all" / "Resume all": turns each of `automations` on or off in turn, stopping at the first refusal. */
    setAllEnabled: (automations: readonly Automation[], enabled: boolean) => attempt(SET_ALL_BUSY, async () => {
      // An earlier refusal is about one automation; this change is about all of them, so its own refusal shows below the list.
      base.clearError();
      for (const automation of automations) {
        if (automation.kind === "app") await appTriggerApi.update(automation.id, { enabled });
        else await base.setEnabled(automation, enabled);
      }
    }),
    toggle: (automation: Automation) => automation.kind === "app"
      ? void attempt(`toggle:${automation.id}`, () => appTriggerApi.update(automation.id, { enabled: !automation.enabled }))
      : busy ? undefined : handOn(() => base.toggle(automation)),
    runNow: (automation: Automation) => automation.kind === "app"
      ? attempt(`run:${automation.id}`, () => appTriggerApi.test(automation.id))
      : handOn(() => base.runNow(automation)),
    remove: async (automation: Automation, question: string): Promise<boolean> => {
      if (automation.kind !== "app") {
        const removed = await base.remove(automation, question);
        if (removed) setError("");
        return removed;
      }
      if (!window.confirm(question)) return false;
      await attempt(`delete:${automation.id}`, () => appTriggerApi.remove(automation.id));
      return true;
    },
  };
}
