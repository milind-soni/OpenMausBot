import type { ChromeRailState, RailMark } from "../../electron/chrome-rail.mjs";
import type { TourStep } from "@/lib/guided-tour";
import type { MausState } from "@/lib/mascot";
import type { LocaleKey } from "@/locales";

/** The tour of the rail of places, in the app tour's look: a step points at a `data-tour` anchor, like TourStep's. */
export interface SidebarTourStep extends Pick<TourStep, "anchor" | "placement"> {
  id: "places" | "add" | "menu" | "strip";
  anchor: string;
  copy: LocaleKey;
  mascot: MausState;
  /** What the window's own rail marks while the step is on screen: one of its parts, or "dim" for a step on the page. */
  rail: RailMark;
}

export type SidebarTourStepId = SidebarTourStep["id"];

/** Its card's name (`data-tour-card`): a card of the notices queue's own, never another dialog in the queue's way. */
export const SIDEBAR_TOUR_CARD = "sidebar-tour";

const PLACES: SidebarTourStep = { id: "places", anchor: "rail-places", placement: "right", copy: "sidebarTour.places", mascot: "happy", rail: "places" };
const ADD: SidebarTourStep = { id: "add", anchor: "rail-add", placement: "right", copy: "sidebarTour.add", mascot: "curious", rail: "add" };
const MENU: SidebarTourStep = { id: "menu", anchor: "rail-places", placement: "right", copy: "sidebarTour.menu", mascot: "proud", rail: "places" };
const STRIP: SidebarTourStep = { id: "strip", anchor: "rail-toggle", placement: "below", copy: "sidebarTour.strip", mascot: "celebrate", rail: "dim" };
/** The rail is hidden: its button is all there is to show, and it says what the rail holds. */
const STRIP_HIDDEN: SidebarTourStep = { ...STRIP, copy: "sidebarTour.stripHidden" };

export const SIDEBAR_TOUR_ORDER: readonly SidebarTourStepId[] = ["places", "add", "menu", "strip"];

/** Where the rail this page's tour points at is drawn: the window's own rail beside the page (its own page, which the
 * tour can't reach: the rail marks its part itself), or a rail drawn on this page (an older app's). */
export type RailWhere = "chrome" | "page";

export interface SidebarTourPlan {
  where: RailWhere | null;
  steps: SidebarTourStep[];
}

/**
 * The steps this page can show: the rail's three while a rail the tour can point at stands beside it, then the button
 * that hides and shows the window's rail while the window has one. `rail`: the window's rail as this page knows it (null
 * until it answers, or where it never will); `asked`: this page can ask (null then means not yet); `markable`: this app
 * can mark the window's rail for a tour; `drawn`: a rail is drawn on this page. Null while unknown.
 */
export function sidebarTourPlan({ rail, asked, markable, drawn }: { rail: ChromeRailState | null; asked: boolean; markable: boolean; drawn: boolean }): SidebarTourPlan | null {
  if (asked && rail === null) return null;
  const beside = rail?.available === true && !rail.hidden;
  // An app that can't mark the rail beside this page: no tour until one that can.
  if (beside && !markable) return { where: null, steps: [] };
  const where: RailWhere | null = beside ? "chrome" : drawn ? "page" : null;
  return { where, steps: [...(where ? [PLACES, ADD, MENU] : []), ...(rail?.available ? [rail.hidden ? STRIP_HIDDEN : STRIP] : [])] };
}

/** The step on screen once the tour reached `at` (a place in SIDEBAR_TOUR_ORDER): the first of `steps` from there. */
export function sidebarTourStep(steps: readonly SidebarTourStep[], at: number): SidebarTourStep | null {
  return steps.find((step) => SIDEBAR_TOUR_ORDER.indexOf(step.id) >= at) ?? null;
}

/** Where the tour goes after `step`. */
export const afterStep = (step: SidebarTourStep): number => SIDEBAR_TOUR_ORDER.indexOf(step.id) + 1;

export const READING_MS = { min: 3_000, max: 10_000, base: 1_500, perWord: 280 } as const;

/** How long a step stays up before the tour moves on: long enough to read its words in the app's language. */
export function readingTimeMs(text: string, locale = "en"): number {
  let words = 0;
  try {
    for (const part of new Intl.Segmenter(locale, { granularity: "word" }).segment(text)) if (part.isWordLike) words++;
  } catch {
    words = text.split(/\s+/).filter(Boolean).length;
  }
  return Math.min(READING_MS.max, Math.max(READING_MS.min, READING_MS.base + words * READING_MS.perWord));
}
