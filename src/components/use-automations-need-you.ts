import { useMemo } from "react";
import { useAppTriggers } from "@/lib/app-triggers";
import { automationsFrom, hasUnseenProblemRun } from "@/lib/automations";
import { useStore } from "@/state/store";

/** An unseen failed run of an automation the Automations page lists (the same list, so opening it clears the dot), or an app trigger in trouble. */
export function useAutomationsNeedYou(): boolean {
  const { state } = useStore();
  const appTriggers = useAppTriggers();
  const routinesOnly = typeof window !== "undefined" && window.ogb?.remoteClient?.active === true;
  const unseenProblem = useMemo(() => hasUnseenProblemRun(automationsFrom({
    routines: state.routines, webhooks: routinesOnly ? [] : state.webhooks, appTriggers: appTriggers.triggers, runs: state.routineRuns, bots: state.bots,
  })), [state.routines, state.webhooks, appTriggers.triggers, state.routineRuns, state.bots, routinesOnly]);
  return unseenProblem || appTriggers.triggers.some((trigger) => trigger.enabled && trigger.problem);
}
