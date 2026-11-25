import { useEffect, useState } from "react";
import { GROK_MOVE_POPUP } from "./GrokMovePopup";
import { NEW_LOOK_NOTICE } from "./NewLookNotice";
import { SIMPLE_MODE_PROMPT } from "./SimpleModePrompt";
import { UPDATES_CONSENT_POPUP } from "./UpdatesConsent";
import { TEAMS_POPUP } from "./whats-new/TeamsPopup";
import { WHATS_NEW_POPUP } from "./whats-new/WhatsNewPopup";

export { useDesktopNotices } from "./desktop-notices";

const OTHER_DIALOGS = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-tour-card], [data-cloud-setup-ready]';
const QUEUE_POPUPS = [TEAMS_POPUP, GROK_MOVE_POPUP, WHATS_NEW_POPUP, UPDATES_CONSENT_POPUP, SIMPLE_MODE_PROMPT, NEW_LOOK_NOTICE].join(", ");
/** A first run's own screens on a Cloud: its welcome, its first ask and a team's welcome to a new member. */
const FIRST_SCREENS = "[data-cloud-welcome], [data-cloud-intent], [data-team-welcome]";

/** Any dialog on screen counts, modal or not, and the card that says a new Cloud is set up; never the queue's own popups.
 * `firstScreens`: a first run's own screens count too. */
export function otherDialogOpen(firstScreens = false): boolean {
  const selector = firstScreens ? `${OTHER_DIALOGS}, ${FIRST_SCREENS}` : OTHER_DIALOGS;
  return [...document.querySelectorAll<HTMLElement>(selector)].some(element => !element.closest(QUEUE_POPUPS) && element.checkVisibility());
}

export function useOtherDialogOpen(watch: boolean, firstScreens = false): boolean {
  const [, setOpen] = useState(false);
  useEffect(() => {
    if (!watch) return;
    const timer = setInterval(() => setOpen(otherDialogOpen(firstScreens)), 1_000);
    return () => clearInterval(timer);
  }, [watch, firstScreens]);
  return watch && otherDialogOpen(firstScreens);
}
