// A server install's licence in its admins' Settings: plan, seats, renewal or expiry, grace left, where the licence came
// from, and how to put one in by hand. Read-only. The seat banner beside the licence expiry notice says when more people
// can sign in than the plan has seats. A desktop and a Cloud home show neither (their GET /api/license says `files: false`).
import { AlertTriangle } from "lucide-react";
import { namesLocale } from "@/lib/clock-time";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { overSeats, useLicenceState, type LicenceState } from "@/lib/licence-state";
import { CommandLine, SettingRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";

/** The installer's own paste line (deploy/install.sh), so the licence stays out of the shell's history. */
export const LICENCE_PASTE_COMMAND = `cd /opt/openmausbot && sudo docker compose exec -T omb sh -c 'umask 077; cat > "$OMB_DATA_DIR/license.key"' < licence.txt`;

const PLAN_NAMES: Record<string, Parameters<typeof t>[0]> = { "business-server": "settings.licence.plan.businessServer" };

/** "2026-12-31" in the reader's language, read as that calendar day wherever the reader is. */
export function licenceDate(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return day;
  try {
    return at.toLocaleDateString(namesLocale(), { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  } catch {
    return day;
  }
}

function planName(state: LicenceState): string {
  if (!state.plan) return t("settings.licence.plan.other");
  const key = PLAN_NAMES[state.plan];
  return key ? t(key) : state.plan;
}

function sourceLine(state: LicenceState): string {
  if (state.source === "file") return t(state.connected ? "settings.licence.source.connected" : "settings.licence.source.file");
  if (state.source === "env") return t("settings.licence.source.env");
  return t("settings.licence.source.lastGood");
}

const value = (text: string, tone?: "warning" | "danger") => (
  <span className={cn("text-[13px] leading-5 tabular-nums", tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-ink-secondary")}>{text}</span>
);

function DateRow({ state }: { state: LicenceState }) {
  if (state.expiresAt === null) return <SettingRow title={t("settings.licence.expires")}>{value(t("settings.licence.never"))}</SettingRow>;
  const date = licenceDate(state.expiresAt);
  if (!state.valid) {
    return <SettingRow title={t("settings.licence.expired")} message={<span className="text-danger">{t("settings.licence.lapsed")}</span>}>{value(date, "danger")}</SettingRow>;
  }
  if (state.graceDaysLeft !== null) {
    const days = state.graceDaysLeft;
    const message = t(days === 1 ? "settings.licence.graceOne" : "settings.licence.grace", { days, date: state.graceEndsAt ? licenceDate(state.graceEndsAt) : "" });
    return <SettingRow title={t("settings.licence.expired")} message={<span className="text-danger">{message}</span>}>{value(date, "danger")}</SettingRow>;
  }
  return state.connected
    ? <SettingRow title={t("settings.licence.renews")} subtitle={t("settings.licence.renewsLine")}>{value(date)}</SettingRow>
    : <SettingRow title={t("settings.licence.expires")}>{value(date)}</SettingRow>;
}

/** The card itself, for a state already read (the Overview page reads it; the picture harness hands one in). */
export function LicenceRows({ state }: { state: LicenceState }) {
  const held = state.valid || state.expiresAt !== null || state.source !== null;
  const over = overSeats(state);
  return (
    <SettingsGroup label={t("settings.licence.title")} block="licence">
      <SettingsRows>
        {held ? <>
          <SettingRow title={planName(state)} subtitle={sourceLine(state)}>{null}</SettingRow>
          <SettingRow title={t("settings.licence.seats")}
            message={over ? <span className="text-warning">{t("settings.licence.seatsOver")}</span> : undefined}>
            {value(state.seats === null
              ? t("settings.licence.seatsNoLimit", { used: state.seatsUsed ?? 0 })
              : t("settings.licence.seatsUsed", { used: state.seatsUsed ?? 0, seats: state.seats }), over ? "warning" : undefined)}
          </SettingRow>
          <DateRow state={state} />
        </> : <SettingRow title={t("settings.licence.none")} subtitle={t("settings.licence.noneLine")}>{null}</SettingRow>}
        <SettingRow title={t("settings.licence.pasteTitle")} subtitle={t("settings.licence.pasteLine")}
          message={<CommandLine command={LICENCE_PASTE_COMMAND} copyLabel={t("settings.licence.pasteCopy")} />}>{null}</SettingRow>
      </SettingsRows>
    </SettingsGroup>
  );
}

/** Overview's licence card: admins of a server install only. */
export function LicenceCard({ enabled }: { enabled: boolean }) {
  const state = useLicenceState(enabled);
  return enabled && state ? <LicenceRows state={state} /> : null;
}

/** Beside the licence expiry notice on every Settings page: more people can sign in than the plan has seats. */
export function SeatLimitBanner({ enabled }: { enabled: boolean }) {
  const over = overSeats(useLicenceState(enabled));
  if (!enabled || !over) return null;
  return (
    <div role="status" data-seat-banner="" className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-[13px] leading-relaxed text-warning">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <span>{t("settings.licence.banner", { used: over.used, seats: over.seats })}
        {over.domains.length > 0 && <> {t("settings.licence.bannerDomains", { domains: over.domains.map((domain) => domain.slice(1)).join(", ") })}</>}</span>
    </div>
  );
}
