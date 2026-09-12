// Runs the guided tour on the live interface. One spotlight at a time,
// pointing at a real control, with Next on every step; the tour presses the
// controls itself (the Tools menu, its items, the Computer button), so it
// never waits on the user and the app reacts exactly as it would for them.
// Clicking the pointed-at control counts as Next too. Every advance is
// written to the server's hint list first, so a reload lands on the same
// step.
import { useCallback, useEffect, useRef, useState } from "react";
import { ANCHOR_EFFECTS, currentStep, stepNumber, TOUR_STEPS, withTourFinished, type TourEffect, type TourStep } from "@/lib/guided-tour";
import { t } from "@/lib/i18n";
import type { MausState } from "@/lib/mascot";
import { hintSeenPatch } from "@/lib/onboarding";
import type { LocaleKey } from "@/locales";
import { api, useStore } from "@/state/store";
import { Spotlight } from "./Spotlight";

const MASCOT: Record<TourStep["id"], MausState> = {
  "tour.composer": "happy",
  "tour.model": "curious",
  "tour.computer": "working",
  "tour.computer-browser": "curious",
  "tour.tools": "curious",
  "tour.apps": "happy",
  "tour.apps-panel": "proud",
  "tour.automations": "happy",
  "tour.automations-page": "drowsy",
  "tour.done": "celebrate",
};

const copy = (id: TourStep["id"]) => t(`onboarding.tour.${id.slice(5)}` as LocaleKey);

function visible(anchor: string): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`));
  return all.filter((el) => el.getClientRects().length > 0).at(-1) ?? null;
}

function anchorPresent(anchor: string | null): boolean {
  return !anchor || visible(anchor) !== null;
}

/** Press a control the way the user would; false when it is not on screen. */
function press(anchor: string): boolean {
  const el = visible(anchor);
  if (!el) return false;
  el.click();
  return true;
}

export function GuidedTour() {
  const { state, dispatch } = useStore();
  const record = state.config?.onboarding;
  const step = currentStep(record);
  const saving = useRef(false);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const latestRecord = useRef(record);
  latestRecord.current = record;
  const closed = useRef(false);
  const [dismissed, setDismissed] = useState(false);
  const [failed, setFailed] = useState(false);
  const entered = useRef<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);

  useEffect(() => {
    if (!state.tourOpen) return;
    closed.current = false;
    setDismissed(false);
    setFailed(false);
  }, [state.tourOpen]);

  const run = useCallback(
    (effect: TourEffect | undefined) => {
      switch (effect) {
        case "openComputer":
          if (!state.computerOpen) dispatch({ type: "toggleComputer", open: true });
          return;
        case "closeComputer":
          dispatch({ type: "toggleComputer", open: false });
          return;
        case "openTools": {
          // the menu is a toggle: only press it when it is closed
          const trigger = visible("tools");
          if (trigger && trigger.getAttribute("aria-expanded") !== "true") trigger.click();
          return;
        }
        case "openApps":
          if (!press("nav-apps")) dispatch({ type: "togglePlugins", open: true });
          return;
        case "closeApps":
          dispatch({ type: "togglePlugins", open: false });
          return;
        case "openAutomations":
          if (!press("nav-automations")) dispatch({ type: "showRoutines" });
          return;
        case "backToChat":
          dispatch({ type: "showChat" });
          return;
        default:
          return;
      }
    },
    [dispatch, state.computerOpen],
  );

  const save = useCallback(
    (finish: boolean, id?: TourStep["id"]) => {
      // A skip must follow an in-flight Next, not disappear behind its guard.
      const operation = pending.current.then(async () => {
        const patch = finish
          ? { onboarding: { hintsSeen: withTourFinished(latestRecord.current) } }
          : id ? hintSeenPatch(latestRecord.current, id) : null;
        if (!patch) return;
        const config = await api("/api/config", { method: "PUT", body: JSON.stringify(patch), signal: AbortSignal.timeout(10_000) });
        latestRecord.current = config.onboarding;
        dispatch({ type: "configStatus", config });
      });
      pending.current = operation.catch(() => {});
      return operation;
    },
    [dispatch],
  );

  const advance = useCallback(
    (fromAnchor = false) => {
      if (!step || saving.current || closed.current) return;
      saving.current = true;
      setFailed(false);
      void save(false, step.id).then(() => {
        // Only move the interface after progress was saved. A queued skip
        // owns cleanup and must not have its panels reopened by this request.
        if (!closed.current && !(fromAnchor && step.onExit && ANCHOR_EFFECTS.has(step.onExit))) run(step.onExit);
      }).catch(() => setFailed(true)).finally(() => { saving.current = false; });
    },
    [step, run, save],
  );

  const finish = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    setDismissed(true);
    // leave nothing open behind: the panel, the menu, the Automations page
    if (state.computerOpen) run("closeComputer");
    if (state.pluginsOpen) run("closeApps");
    run("backToChat");
    void save(true).catch(() => {});
    dispatch({ type: "toggleTour", open: false });
  }, [state.computerOpen, state.pluginsOpen, run, save, dispatch]);

  const active = !dismissed && Boolean(record?.completedAt) && !state.welcomeOpen && step !== null;

  // entering a step runs its effect once per step
  useEffect(() => {
    if (!active || !step || entered.current === step.id) return;
    entered.current = step.id;
    run(step.onEnter);
  }, [active, step, run]);

  // a step whose control is not on screen points at its fallback, or skips
  // itself, after the layout has a moment to settle (a menu closing, a
  // page changing, a panel mounting). Its enter effect is pressed once
  // more first: on a cold load the sidebar may not have been there yet.
  useEffect(() => {
    if (!active || !step?.skipIfMissing) return;
    let second: ReturnType<typeof setTimeout> | undefined;
    const decide = () => {
      if (anchorPresent(step.anchor)) return;
      if (step.fallbackAnchor && anchorPresent(step.fallbackAnchor)) setFallback(step.id);
      else advance();
    };
    const first = setTimeout(() => {
      if (anchorPresent(step.anchor)) return;
      run(step.onEnter);
      second = setTimeout(decide, 300);
    }, 400);
    return () => {
      clearTimeout(first);
      if (second) clearTimeout(second);
    };
  }, [active, step, advance, run]);

  // clicking the pointed-at control is as good as Next
  useEffect(() => {
    if (!active || !step?.anchor || step.id === "tour.apps-panel" || step.id === "tour.automations-page" || step.id === "tour.done") return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(`[data-tour="${step.anchor}"]`)) advance(true);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [active, step, advance]);

  if (!active || !step) return null;
  if (window.ogb?.remoteClient?.active === true) return null;

  const { current, total } = stepNumber(step);
  const closing = step.id === "tour.done";
  const anchor = fallback === step.id && step.fallbackAnchor ? step.fallbackAnchor : step.anchor;
  return (
    <Spotlight
      anchor={anchor}
      placement={step.placement}
      mascot={MASCOT[step.id]}
      progress={closing ? undefined : t("onboarding.tour.progress", { current, total })}
      primary={{ label: closing ? t("onboarding.tour.finish") : t("onboarding.tour.next"), onClick: closing ? finish : () => advance() }}
      secondary={closing ? undefined : { label: t("onboarding.tour.skip"), onClick: finish }}
      onDone={finish}
    >
      {copy(step.id)}
      {failed && <p role="alert" className="mt-2 text-danger">{t("onboarding.tour.error")}</p>}
    </Spotlight>
  );
}

export { TOUR_STEPS };
