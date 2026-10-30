import type { OnboardingStatus } from "@/lib/onboarding";
import type { LocaleKey } from "@/locales";

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

export type TourEffect =
  | "openComputer"
  | "closeComputer"
  | "openTools"
  | "openApps"
  | "closeApps"
  | "openAutomations"
  | "backToChat";

/** Effects the anchor's own click already performs, so a click instead of Next must not repeat them. */
export const ANCHOR_EFFECTS: ReadonlySet<TourEffect> = new Set<TourEffect>(["openComputer", "openTools", "openApps", "openAutomations"]);

export interface TourStep {
  id: TourStepId;
  anchor: string | null;
  skipIfMissing?: boolean;
  fallbackAnchor?: string;
  placement: "above" | "below" | "right";
  onEnter?: TourEffect;
  onExit?: TourEffect;
  /** The card's words, when they differ from the step's own `onboarding.tour.*` key. */
  copy?: LocaleKey;
}

export const TOUR_STEPS: TourStep[] = [
  { id: "tour.composer", anchor: "composer", placement: "above" },
  { id: "tour.model", anchor: "model", placement: "below" },
  { id: "tour.computer", anchor: "computer", placement: "below", onExit: "openComputer" },
  { id: "tour.computer-browser", anchor: "computer-browser", fallbackAnchor: "computer-tabs", skipIfMissing: true, placement: "below", onEnter: "openComputer", onExit: "closeComputer" },
  { id: "tour.tools", anchor: "tools", skipIfMissing: true, placement: "right", onExit: "openTools" },
  { id: "tour.apps", anchor: "nav-apps", skipIfMissing: true, placement: "right", onEnter: "openTools", onExit: "openApps" },
  { id: "tour.apps-panel", anchor: "apps-panel", placement: "below", onEnter: "openApps", onExit: "closeApps" },
  { id: "tour.automations", anchor: "nav-automations", skipIfMissing: true, placement: "right", onEnter: "openTools", onExit: "openAutomations" },
  { id: "tour.automations-page", anchor: "automations-page", skipIfMissing: true, placement: "below", onEnter: "openAutomations", onExit: "backToChat" },
  { id: "tour.done", anchor: "composer", placement: "above" },
];

// Simple mode's chat header holds only the bot: the model chip and the Computer button moved into the bot panel its
// pill opens. Those steps point at the pill there, and give up rather than wait if even that is missing (a group chat).
const SIMPLE_STEPS: Partial<Record<TourStepId, Partial<TourStep>>> = {
  "tour.model": { anchor: "bot-pill", skipIfMissing: true, copy: "onboarding.tour.model-simple" },
  "tour.computer": { anchor: "bot-pill", skipIfMissing: true, copy: "onboarding.tour.computer-simple" },
};

const SIMPLE_TOUR_STEPS: TourStep[] = TOUR_STEPS.map((step) => ({ ...step, ...SIMPLE_STEPS[step.id] }));

/** The steps as the current mode draws them: the same ids and order, so progress carries across a mode switch. */
export function tourSteps(advanced: boolean): TourStep[] {
  return advanced ? TOUR_STEPS : SIMPLE_TOUR_STEPS;
}

function stepDone(record: OnboardingStatus | undefined, id: TourStepId): boolean {
  return (record?.hintsSeen ?? []).includes(id);
}

export function currentStep(record: OnboardingStatus | undefined, advanced = true): TourStep | null {
  return tourSteps(advanced).find((step) => !stepDone(record, step.id)) ?? null;
}

export function stepNumber(step: TourStep): { current: number; total: number } {
  const visible = TOUR_STEPS.filter((s) => s.id !== "tour.done");
  const index = visible.findIndex((s) => s.id === step.id);
  return { current: index < 0 ? visible.length : index + 1, total: visible.length };
}

export function withTourReset(record: OnboardingStatus | undefined): string[] {
  const ids = new Set<string>(TOUR_STEPS.map((s) => s.id));
  return (record?.hintsSeen ?? []).filter((id) => !ids.has(id));
}

export function withTourFinished(record: OnboardingStatus | undefined): string[] {
  const have = new Set(record?.hintsSeen ?? []);
  for (const step of TOUR_STEPS) have.add(step.id);
  return [...have];
}
