// Settings → Hub: the daily check-in and the hub console, both served through server/hub-bridge.ts.
// The bridge is the only thing that talks to the hub; when it is down this section says so and nothing else changes.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

type HubHealth = { console: { ok: boolean; url: string }; scheduler: { ok: boolean; url: string } };
type HubPanel = "checkin" | "ui";

const PANELS: readonly { id: HubPanel; title: () => string; help: () => string; src: string }[] = [
  { id: "checkin", title: () => t("settings.hub.checkin"), help: () => t("settings.hub.checkinHelp"), src: "/hub/ui/#checkin" },
  { id: "ui", title: () => t("settings.hub.webui"), help: () => t("settings.hub.webuiHelp"), src: "/hub/ui/" },
];

/** Tailwind's md breakpoint, as a media query: below it the console cannot fit its three columns. */
const NARROW = "(max-width: 767.98px)";

/** True while the window is phone-width; follows the window as it is resized or the phone turns. */
function useNarrowScreen() {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW).matches : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(NARROW);
    const sync = () => setNarrow(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return narrow;
}

const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";

export function HubSection() {
  const [health, setHealth] = useState<HubHealth | null>(null);
  const [open, setOpen] = useState<HubPanel | null>(null);
  const narrow = useNarrowScreen();
  useEffect(() => {
    let live = true;
    api<HubHealth>("/hub/health")
      .then((next) => { if (live) setHealth(next); })
      .catch(() => { if (live) setHealth(null); });
    return () => { live = false; };
  }, []);
  // A phone shows the console as a full-screen sheet, so Escape closes it and the page behind stays put.
  useEffect(() => {
    if (!narrow || !open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [narrow, open]);
  const up = health !== null && health.console.ok;
  const sheet = narrow && open ? PANELS.find((panel) => panel.id === open) : undefined;
  return (
    <Card title={t("settings.hub.title")} subtitle={t("settings.hub.subtitle")}>
      <p className="flex items-center gap-1.5 text-[12px] text-ink-secondary" role="status">
        <span aria-hidden className={up ? "size-2 rounded-full bg-success" : "size-2 rounded-full bg-ink-tertiary"} />
        {up ? t("settings.hub.online") : t("settings.hub.offline")}
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {PANELS.map((panel) => (
          <div key={panel.id} className="rounded-lg border border-hairline/40">
            <div className="flex items-start justify-between gap-4 p-3">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-ink">{panel.title()}</div>
                <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{panel.help()}</p>
              </div>
              <button type="button" className="ui-button shrink-0" onClick={() => setOpen(open === panel.id ? null : panel.id)}>
                {open === panel.id ? t("settings.hub.close") : t("settings.hub.open")}
              </button>
            </div>
            {open === panel.id && !narrow && (
              <iframe
                src={panel.src}
                title={t("settings.hub.frameTitle")}
                sandbox={FRAME_SANDBOX}
                referrerPolicy="no-referrer"
                className="h-[60vh] w-full border-0 border-t border-hairline/40 bg-app"
              />
            )}
          </div>
        ))}
      </div>
      {/* Below md the console's three columns would be squeezed into 375px, so it takes the whole screen instead.
          Portalled out of the settings sheet: that sheet scrolls and clips, which would cut a fixed frame short. */}
      {sheet && createPortal(
        <div className="fixed inset-0 z-[60] flex flex-col bg-app" role="dialog" aria-modal="true" aria-label={sheet.title()} data-hub-sheet>
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline/40 bg-panel px-4 pb-2.5" data-hub-sheet-bar>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium text-ink">{sheet.title()}</div>
              <p className="mt-0.5 truncate text-[12px] text-ink-secondary">{sheet.help()}</p>
            </div>
            <button type="button" className="ui-button shrink-0" onClick={() => setOpen(null)} autoFocus>
              {t("settings.hub.close")}
            </button>
          </div>
          <iframe
            src={sheet.src}
            title={t("settings.hub.frameTitle")}
            sandbox={FRAME_SANDBOX}
            referrerPolicy="no-referrer"
            className="min-h-0 w-full flex-1 border-0 bg-app"
            data-hub-sheet-frame
          />
        </div>,
        document.body,
      )}
    </Card>
  );
}
