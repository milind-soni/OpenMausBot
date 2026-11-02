import { useEffect, useState } from "react";
import { CloudOff, Loader2 } from "lucide-react";
import { cloudAsleep, onCloudPower } from "@/lib/cloud-power";
import { t } from "@/lib/i18n";

export const RECONNECTING_AFTER_MS = 4_000;

/** The live stream is down: replies and other people's messages wait until it is back. A blip shorter than a few
 * seconds says nothing; a Cloud asleep has its own strip. */
export function LiveConnectionStrip({ connected, hydrated }: { connected: boolean; hydrated: boolean }) {
  const [late, setLate] = useState(false);
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
    if (connected) return;
    const timer = setTimeout(() => setLate(true), RECONNECTING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [connected]);
  if (asleep || !hydrated) return null;
  const notice = !online ? "offline" : !connected && late ? "reconnecting" : null;
  if (!notice) return null;
  return <div role="status" data-live-connection={notice} className="flex items-center justify-center gap-2 border-b border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
    {notice === "offline" ? <CloudOff size={14} aria-hidden="true" /> : <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
    <span>{t(notice === "offline" ? "liveConnection.offline" : "liveConnection.reconnecting")}</span>
  </div>;
}
