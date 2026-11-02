import { useEffect, useState } from "react";
import type { DesktopNoticesBridge, DesktopNoticesState } from "../../electron/desktop-prefs.mjs";
import { SIMPLE_MODE_PROMPT } from "./SimpleModePrompt";
import { UPDATES_CONSENT_POPUP } from "./UpdatesConsent";
import { WHATS_NEW_POPUP } from "./whats-new/WhatsNewPopup";

/** null until main answers; a page main refuses has nothing due. */
export function useDesktopNotices(desktop: DesktopNoticesBridge | undefined): DesktopNoticesState | null {
  const [answer, setAnswer] = useState<DesktopNoticesState | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void desktop.state().then(next => { if (active) setAnswer(next); }, () => { if (active) setAnswer({ seen: [], cloud: false }); });
    return () => { active = false; };
  }, [desktop]);
  return desktop ? answer : null;
}

const OTHER_DIALOGS = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-tour-card], [data-cloud-setup-ready]';
const QUEUE_POPUPS = [WHATS_NEW_POPUP, UPDATES_CONSENT_POPUP, SIMPLE_MODE_PROMPT].join(", ");

/** Any dialog on screen counts, modal or not, and the card that says a new Cloud is set up; never the queue's own popups. */
export function otherDialogOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>(OTHER_DIALOGS)].some(element => !element.closest(QUEUE_POPUPS) && element.checkVisibility());
}

export function useOtherDialogOpen(watch: boolean): boolean {
  const [, setOpen] = useState(false);
  useEffect(() => {
    if (!watch) return;
    const timer = setInterval(() => setOpen(otherDialogOpen()), 1_000);
    return () => clearInterval(timer);
  }, [watch]);
  return watch && otherDialogOpen();
}
