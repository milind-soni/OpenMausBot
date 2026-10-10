// Settings, above every section: this workspace's enterprise license is
// about to lapse, or has lapsed and is in its grace period. The server sends
// the dates to admins only (configStatus → editionForSettings), and only
// inside the 30-day warning window or the 7-day grace period, so the banner
// is simply "whatever the server says", and silent everywhere else.
import { AlertTriangle } from "lucide-react";
import type { ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

export type LicenseNotice = { tone: "warning" | "danger"; text: string };

export function licenseNotice(config: ConfigStatus | null | undefined): LicenseNotice | null {
  const license = config?.edition?.license;
  if (!license || typeof license.expiresAt !== "string" || !Number.isFinite(license.expiresInDays)) return null;
  if (license.graceEndsAt) {
    return { tone: "danger", text: t("settings.license.grace", { date: license.expiresAt, graceEnd: license.graceEndsAt }) };
  }
  return { tone: "warning", text: t("settings.license.expiring", { date: license.expiresAt, days: String(Math.max(0, license.expiresInDays)) }) };
}

export function LicenseExpiryBanner({ config }: { config: ConfigStatus | null | undefined }) {
  const notice = licenseNotice(config);
  if (!notice) return null;
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2.5 text-[12.5px] leading-relaxed",
        notice.tone === "danger" ? "border-danger/40 bg-danger/10 text-danger" : "border-warning/40 bg-warning/10 text-warning",
      )}
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <span>{notice.text}</span>
    </div>
  );
}
