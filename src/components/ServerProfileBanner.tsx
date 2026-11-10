import { AlertTriangle, ShieldCheck } from "lucide-react";
import { api, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

export type ServerProfileNotice = { tone: "info" | "warning" | "danger"; text: string; dismissible: boolean };

const UNBOXED_FIX = {
  "switched-off": "settings.serverProfile.fix.switchedOff",
  "not-linux": "settings.serverProfile.fix.notLinux",
  "no-bwrap": "settings.serverProfile.fix.noBwrap",
  "userns-refused": "settings.serverProfile.fix.userns",
} as const;

/** What an admin is told about this server's hardened profile; the server sends a notice to admins only. */
export function serverProfileNotice(config: ConfigStatus | null | undefined): ServerProfileNotice | null {
  const notice = config?.serverProfile?.notice;
  if (!notice) return null;
  if (notice.kind === "on") return { tone: "info", text: t("settings.serverProfile.on"), dismissible: true };
  if (notice.kind === "restart") return { tone: "warning", text: t("settings.serverProfile.restart"), dismissible: false };
  const fix = t(UNBOXED_FIX[notice.fault] ?? UNBOXED_FIX["userns-refused"]);
  return {
    tone: notice.shared ? "danger" : "warning",
    text: t(notice.shared ? "settings.serverProfile.unboxedShared" : "settings.serverProfile.unboxed", { fix }),
    dismissible: notice.dismissible,
  };
}

export function ServerProfileBanner({ config }: { config: ConfigStatus | null | undefined }) {
  const notice = serverProfileNotice(config);
  if (!notice) return null;
  const Icon = notice.tone === "info" ? ShieldCheck : AlertTriangle;
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2.5 text-[13px] leading-relaxed",
        notice.tone === "danger" ? "border-danger/40 bg-danger/10 text-danger"
          : notice.tone === "warning" ? "border-warning/40 bg-warning/10 text-warning" : "border-border bg-surface-2 text-fg",
      )}
    >
      <Icon size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">{notice.text}</span>
      {notice.dismissible ? (
        <button
          type="button"
          className="shrink-0 rounded-md border border-current/30 px-2 py-0.5 text-[12px] hover:bg-current/10"
          onClick={() => void api("/api/config/server-profile-notice", { method: "POST" }).catch(() => {})}
        >
          {t("common.ok")}
        </button>
      ) : null}
    </div>
  );
}
