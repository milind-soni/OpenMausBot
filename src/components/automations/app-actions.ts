// The automation actions with app events added: pause, run now and delete reach /api/app-triggers for kind "app".
import { useState } from "react";

import { appTriggerApi } from "@/lib/app-triggers";
import type { Automation } from "@/lib/automations";
import { useAutomationActions } from "./actions";

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
  return {
    ...base,
    busy: busy ?? base.busy,
    error: error || base.error,
    setError: (message: string) => { setError(message); base.setError(message); },
    toggle: (automation: Automation) => automation.kind === "app"
      ? void attempt(`toggle:${automation.id}`, () => appTriggerApi.update(automation.id, { enabled: !automation.enabled }))
      : base.toggle(automation),
    runNow: (automation: Automation) => automation.kind === "app"
      ? attempt(`run:${automation.id}`, () => appTriggerApi.test(automation.id))
      : base.runNow(automation),
    remove: async (automation: Automation, question: string): Promise<boolean> => {
      if (automation.kind !== "app") return base.remove(automation, question);
      if (!window.confirm(question)) return false;
      await attempt(`delete:${automation.id}`, () => appTriggerApi.remove(automation.id));
      return true;
    },
  };
}
