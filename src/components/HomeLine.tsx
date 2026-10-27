import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { t } from "@/lib/i18n";
import { setNotificationPlace } from "@/lib/notify";

type Line = { kind: "left"; name: string };

/** The words for main's one line: a team this person is no longer in. */
export function homeLineText(line: Line): string {
  return t("homeLine.left", { name: line.name });
}

/** In the desktop app, never in a browser: one plain line main has for the next page, served once (home-places.mjs):
 * after a team dropped this person, that they are no longer in it. Nothing to press; it goes with the page. (Who can
 * see a team's private chats is said in the chat itself, by the team's own page.) */
export function HomeLine() {
  const bridge = !window.ogb?.remoteClient?.active ? window.ogb?.workspaces : undefined;
  const [line, setLine] = useState<Line | null>(null);
  useEffect(() => {
    if (!bridge?.line) return;
    // Served once: the first ask gets the line even when a strict-mode remount asks again (and gets null, which must
    // not take it back); after a real unmount the set is a no-op.
    void bridge.line().then((next) => { if (next) setLine(next); }).catch(() => {});
    // A team's page (main's summary carries this person's role there): its notifications name the team.
    void bridge.state().then((place) => setNotificationPlace(place.role ? place.name : null)).catch(() => {});
  }, [bridge]);
  if (!line) return null;
  return <div role="status" data-home-line={line.kind} className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
    <Users size={14} aria-hidden="true" />
    <span dir="auto">{homeLineText(line)}</span>
  </div>;
}
