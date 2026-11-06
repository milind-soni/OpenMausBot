import { useEffect, useState } from "react";
import { CloudOff, Loader2 } from "lucide-react";
import { cloudAsleep, onCloudPower } from "@/lib/cloud-power";
import { t } from "@/lib/i18n";
import { retryLiveEvents } from "@/lib/live-events";

export const RECONNECTING_AFTER_MS = 4_000;
export const CONNECTION_HELP_AFTER_MS = 20_000;

/** The live stream is down: replies and other people's messages wait until it is back. A blip shorter than a few
 * seconds says nothing; a Cloud asleep has its own strip. */
export function LiveConnectionStrip({ connected, hydrated }: { connected: boolean; hydrated: boolean }) {
  const [late, setLate] = useState(false);
  const [help, setHelp] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  const [asleep, setAsleep] = useState(cloudAsleep);
  useEffect(() => onCloudPower(setAsleep), []);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  useEffect(() => {
    setLate(false);
    setHelp(false);
    if (connected) return;
    const timer = setTimeout(() => setLate(true), RECONNECTING_AFTER_MS);
    const helpTimer = setTimeout(() => setHelp(true), CONNECTION_HELP_AFTER_MS);
    return () => { clearTimeout(timer); clearTimeout(helpTimer); };
  }, [connected]);
  if (asleep) return null;
  const notice = !online ? "offline" : !connected && late && (hydrated || help) ? "reconnecting" : null;
  if (!notice) return null;
  return <div role="status" data-live-connection={notice} className="flex flex-wrap items-center justify-center gap-2 border-b border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
    {notice === "offline" ? <CloudOff size={14} className="shrink-0" aria-hidden="true" /> : <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden="true" />}
    <span>{t(notice === "offline" ? "liveConnection.offline" : help ? "liveConnection.help" : "liveConnection.reconnecting")}</span>
    {notice === "reconnecting" && help && <button type="button" onClick={retryLiveEvents} className="shrink-0 rounded px-2 py-1 text-ink underline underline-offset-2 hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2">
      {t("liveConnection.retry")}
    </button>}
  </div>;
}
