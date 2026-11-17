import { useEffect, useState } from "react";
import type { DesktopNoticesBridge, DesktopNoticesState } from "../../electron/desktop-prefs.mjs";

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
