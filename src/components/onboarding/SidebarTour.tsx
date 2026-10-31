import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { track } from "@/lib/analytics";
import { activeLocale, t } from "@/lib/i18n";
import { afterStep, readingTimeMs, SIDEBAR_TOUR_CARD, sidebarTourStep, type RailWhere, type SidebarTourStep, type SidebarTourStepId } from "@/lib/sidebar-tour";
import { useDesktopCapabilities, windowFramed } from "../DesktopCapabilities";
import { measureTourTarget, Spotlight } from "./Spotlight";

export type SidebarTourAction = "shown" | "completed" | "left";

export function reportSidebarTour(action: SidebarTourAction, step: SidebarTourStepId) {
  track("sidebar_tour", { action, step });
}

/** A step whose target isn't on screen gets this long to appear before the tour moves past it. */
const MISSING_MS = 400;
/** The window's own rail, seen from the page beside it: its places start under the top bar of a framed window (or the
 * rail's own top margin), and the card stands beside the first few. */
const RAIL_PLACES_TOP = { framed: 40, plain: 15 } as const;
const RAIL_PLACES_HEIGHT = 140;

/** Where the window's own rail stands, for the card to stand beside: the page can't reach the rail's own elements. */
function RailRoom({ anchor, framed }: { anchor: string; framed: boolean }) {
  return createPortal(
    <div data-tour={anchor} aria-hidden="true" className="pointer-events-none fixed left-0 w-[var(--rail-beside,0px)]"
      style={{ top: framed ? RAIL_PLACES_TOP.framed : RAIL_PLACES_TOP.plain, height: RAIL_PLACES_HEIGHT }} />,
    document.body,
  );
}

const markRail = (part: SidebarTourStep["rail"] | null) => { void window.ogb?.rail?.mark?.(part)?.catch(() => {}); };

/**
 * The one-time tour of the rail of places, in the app tour's Spotlight: no buttons. Each step stays its reading time and
 * the tour moves on by itself; Escape leaves; a step whose target isn't on screen is passed over. `at` is where the tour
 * is (a place in SIDEBAR_TOUR_ORDER), kept by the caller so a tour that steps aside (a turn starts) comes back there.
 */
export function SidebarTour({ steps, where, at, onStep, onShown, onLeave, onEnd }: {
  steps: readonly SidebarTourStep[];
  where: RailWhere | null;
  at: number;
  onStep: (next: number) => void;
  onShown: (step: SidebarTourStepId) => void;
  onLeave: (step: SidebarTourStepId) => void;
  onEnd: () => void;
}) {
  const { capabilities } = useDesktopCapabilities();
  const step = sidebarTourStep(steps, at);
  // The step whose card is up: the next one replaces it only once its target is on screen.
  const [card, setCard] = useState<SidebarTourStep | null>(null);
  const beside = (of: SidebarTourStep) => where === "chrome" && of.rail !== "dim";
  const anchorOf = (of: SidebarTourStep) => (beside(of) ? `rail-beside-${of.id}` : of.anchor);

  useEffect(() => {
    if (!step) onEnd();
  }, [step === null]);

  useEffect(() => {
    if (!step) return;
    const anchor = anchorOf(step);
    if (measureTourTarget(anchor)) {
      setCard(step);
      return;
    }
    const timer = setTimeout(() => {
      if (measureTourTarget(anchor)) setCard(step);
      else onStep(afterStep(step));
    }, MISSING_MS);
    return () => clearTimeout(timer);
  }, [step?.id]);

  useEffect(() => {
    if (!card || card.id !== step?.id) return;
    onShown(card.id);
    if (where === "chrome") markRail(card.rail);
    const timer = setTimeout(() => onStep(afterStep(card)), readingTimeMs(t(card.copy), activeLocale()));
    return () => clearTimeout(timer);
  }, [card?.id, step?.id]);

  useEffect(() => () => {
    if (where === "chrome") markRail(null);
  }, [where]);

  if (!step) return null;
  const total = steps.length, current = card ? steps.indexOf(card) + 1 : 0;
  return <>
    {beside(step) && <RailRoom anchor={anchorOf(step)} framed={windowFramed(capabilities.windowChrome)} />}
    {card && <Spotlight anchor={anchorOf(card)} placement={card.placement} mascot={card.mascot} highlight={!beside(card)} card={SIDEBAR_TOUR_CARD}
      progress={total > 1 ? t("onboarding.tour.progress", { current, total }) : undefined} onDone={() => onLeave(card.id)}>
      <span data-sidebar-tour={card.id}>{t(card.copy)}</span>
    </Spotlight>}
  </>;
}
