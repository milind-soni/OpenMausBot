// The guided tour: a short walkthrough on the real interface. Each step
// points at a control and explains it; Next moves on. The tour travels the
// way a user would: it opens the Tools menu and points at the item before
// opening the page behind it, and it closes what it opened, so the last
// step lands back in the chat. Clicking the pointed-at control also counts
// as Next. Progress is a list of done step ids in the workspace's
// onboarding record, so a tour interrupted by a restart resumes where it
// stopped.
import type { OnboardingStatus } from "@/lib/onboarding";

export type TourStepId =
  | "tour.composer"
  | "tour.model"
  | "tour.computer"
  | "tour.computer-browser"
  | "tour.tools"
  | "tour.apps"
  | "tour.apps-panel"
  | "tour.automations"
  | "tour.automations-page"
  | "tour.done";

/** Something the tour does to the app when a step begins or ends. The
 * "open" effects press the real control when it is on screen, so the app
 * reacts exactly as it would to the user. */
export type TourEffect =
  | "openComputer"
  | "closeComputer"
  | "openTools"
  | "openApps"
  | "closeApps"
  | "openAutomations"
  | "backToChat";

/** Effects the anchor's own click already performs; when the user presses
 * the control instead of Next, the tour must not do it a second time. */
export const ANCHOR_EFFECTS: ReadonlySet<TourEffect> = new Set<TourEffect>(["openComputer", "openTools", "openApps", "openAutomations"]);

export interface TourStep {
  id: TourStepId;
  /** `data-tour` id of the control this step points at; null centres the card. */
  anchor: string | null;
  /** Skip silently when the anchor is not on screen (a Tools menu that
   * did not open, a browser that is switched off). */
  skipIfMissing?: boolean;
  /** Pointed at instead when the anchor is not on screen: the Browser tab
   * only exists in the desktop app, the row of tabs always does. */
  fallbackAnchor?: string;
  placement: "above" | "below" | "right";
  onEnter?: TourEffect;
  onExit?: TourEffect;
}

export const TOUR_STEPS: TourStep[] = [
  { id: "tour.composer", anchor: "composer", placement: "above" },
  { id: "tour.model", anchor: "model", placement: "below" },
  { id: "tour.computer", anchor: "computer", placement: "below", onExit: "openComputer" },
  // every step that lives inside something the previous step opened also
  // opens it on enter, so a reload mid-tour rebuilds the scene
  { id: "tour.computer-browser", anchor: "computer-browser", fallbackAnchor: "computer-tabs", skipIfMissing: true, placement: "below", onEnter: "openComputer", onExit: "closeComputer" },
  { id: "tour.tools", anchor: "tools", placement: "right", onExit: "openTools" },
  { id: "tour.apps", anchor: "nav-apps", skipIfMissing: true, placement: "right", onEnter: "openTools", onExit: "openApps" },
  { id: "tour.apps-panel", anchor: "apps-panel", placement: "below", onEnter: "openApps", onExit: "closeApps" },
  { id: "tour.automations", anchor: "nav-automations", skipIfMissing: true, placement: "right", onEnter: "openTools", onExit: "openAutomations" },
  { id: "tour.automations-page", anchor: "automations-page", placement: "below", onEnter: "openAutomations", onExit: "backToChat" },
  // back where they started: the closing card sits on the chat itself
  { id: "tour.done", anchor: "composer", placement: "above" },
];

function stepDone(record: OnboardingStatus | undefined, id: TourStepId): boolean {
  return (record?.hintsSeen ?? []).includes(id);
}

/** The first step not yet done, or null when the tour is over. */
export function currentStep(record: OnboardingStatus | undefined): TourStep | null {
  return TOUR_STEPS.find((step) => !stepDone(record, step.id)) ?? null;
}

/** 1-based position among the steps the user actually sees. */
export function stepNumber(step: TourStep): { current: number; total: number } {
  const visible = TOUR_STEPS.filter((s) => s.id !== "tour.done");
  const index = visible.indexOf(step);
  return { current: index < 0 ? visible.length : index + 1, total: visible.length };
}

/** The hint list with every tour step removed, for a replay from the start. */
export function withTourReset(record: OnboardingStatus | undefined): string[] {
  const ids = new Set<string>(TOUR_STEPS.map((s) => s.id));
  return (record?.hintsSeen ?? []).filter((id) => !ids.has(id));
}

/** The hint list with every tour step added, for a skip. */
export function withTourFinished(record: OnboardingStatus | undefined): string[] {
  const have = new Set(record?.hintsSeen ?? []);
  for (const step of TOUR_STEPS) have.add(step.id);
  return [...have];
}
