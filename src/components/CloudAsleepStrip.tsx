import { useEffect, useState } from "react";
import { Moon } from "lucide-react";
import { cloudAsleep, markCloudAwake, onCloudPower } from "@/lib/cloud-power";
import { t } from "@/lib/i18n";

/** A Cloud home on a plan that sleeps went to sleep (src/lib/cloud-power.ts): this page sends nothing until the person
 * does something, which wakes it in about a second. Never shown on any other server. */
export function CloudAsleepStrip() {
  const [asleep, setAsleep] = useState(cloudAsleep);
  useEffect(() => onCloudPower(setAsleep), []);
  if (!asleep) return null;
  return <div role="status" data-cloud-asleep className="flex items-center justify-center gap-2 border-b border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
    <Moon size={14} aria-hidden="true" />
    <span>{t("cloudPower.asleep")}</span>
    <button type="button" className="font-medium text-accent-text underline underline-offset-2 hover:text-ink" onClick={() => markCloudAwake()}>{t("cloudPower.wake")}</button>
  </div>;
}
