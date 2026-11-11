import { useEffect, useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { SETTINGS_INLINE_INPUT, SettingRow, SettingsGroup, SettingsRows, Switch } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";

/** Server bounds from server/config.ts, mirrored to reject out-of-range input before the round trip. */
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_RETENTION_DAYS = 30;
const MIB = 1024 * 1024;
const MIN_CAP_BYTES = 256 * 1024;
const MAX_CAP_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_CAP_MIB = 50;

function parseDays(value: string): number | null {
  const days = Number(value);
  return Number.isInteger(days) && days >= MIN_RETENTION_DAYS && days <= MAX_RETENTION_DAYS ? days : null;
}

export function parseCapMib(value: string): number | null {
  const mib = Number(value);
  if (!Number.isFinite(mib)) return null;
  const bytes = Math.round(mib * MIB);
  // Exact 0.25 MiB steps only: mibText shows two decimals, so 0.251 would redisplay as 0.25 and silently shrink on the
  // next save.
  return bytes >= MIN_CAP_BYTES && bytes <= MAX_CAP_BYTES && bytes % MIN_CAP_BYTES === 0 ? bytes : null;
}

function mibText(bytes: number): string {
  const mib = bytes / MIB;
  return String(Number.isInteger(mib) ? mib : Number(mib.toFixed(2)));
}

type Knob = "retention" | "cap";

export function ThreadCleanupSettings() {
  const { state, dispatch } = useStore();
  const confirmedRetentionDays = state.config?.threads?.eventLogRetentionDays ?? null;
  const confirmedCapBytes = state.config?.threads?.eventLogMaxBytes ?? null;
  const [retentionDraft, setRetentionDraft] = useState<string | null>(null);
  const [capDraft, setCapDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<Knob | null>(null);
  const [error, setError] = useState("");
  const [errorKnob, setErrorKnob] = useState<Knob | null>(null);
  const saving = useRef(false);

  const retentionValue = retentionDraft ?? (confirmedRetentionDays === null ? String(DEFAULT_RETENTION_DAYS) : String(confirmedRetentionDays));
  const capValue = capDraft ?? (confirmedCapBytes === null ? String(DEFAULT_CAP_MIB) : mibText(confirmedCapBytes));

  useEffect(() => {
    if (retentionDraft !== null && confirmedRetentionDays !== null && String(confirmedRetentionDays) === retentionDraft) setRetentionDraft(null);
  }, [confirmedRetentionDays, retentionDraft]);
  useEffect(() => {
    if (capDraft !== null && confirmedCapBytes !== null && mibText(confirmedCapBytes) === capDraft) setCapDraft(null);
  }, [confirmedCapBytes, capDraft]);

  const save = async (patch: { eventLogRetentionDays?: number | null; eventLogMaxBytes?: number | null }, knob: Knob) => {
    if (saving.current) return;
    saving.current = true;
    setPending(knob);
    setError("");
    setErrorKnob(null);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ threads: patch }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.threadCleanup.error"));
    } finally {
      saving.current = false;
      setPending(null);
    }
  };

  const toggleRetention = (enabled: boolean) => {
    if (!enabled) {
      setRetentionDraft(null);
      setError("");
      setErrorKnob(null);
      void save({ eventLogRetentionDays: null }, "retention");
      return;
    }
    const days = parseDays(retentionValue);
    if (days === null) {
      setError(t("settings.threadCleanup.invalidRetention"));
      setErrorKnob("retention");
      return;
    }
    void save({ eventLogRetentionDays: days }, "retention");
  };

  const toggleCap = (enabled: boolean) => {
    if (!enabled) {
      setCapDraft(null);
      setError("");
      setErrorKnob(null);
      void save({ eventLogMaxBytes: null }, "cap");
      return;
    }
    const bytes = parseCapMib(capValue);
    if (bytes === null) {
      setError(t("settings.threadCleanup.invalidCap"));
      setErrorKnob("cap");
      return;
    }
    void save({ eventLogMaxBytes: bytes }, "cap");
  };

  const commitRetention = () => {
    if (confirmedRetentionDays === null) return;
    const days = parseDays(retentionValue);
    if (days === null) {
      setError(t("settings.threadCleanup.invalidRetention"));
      setErrorKnob("retention");
      return;
    }
    if (days === confirmedRetentionDays) {
      setRetentionDraft(null);
      setError("");
      return;
    }
    void save({ eventLogRetentionDays: days }, "retention");
  };

  const commitCap = () => {
    if (confirmedCapBytes === null) return;
    const bytes = parseCapMib(capValue);
    if (bytes === null) {
      setError(t("settings.threadCleanup.invalidCap"));
      setErrorKnob("cap");
      return;
    }
    if (bytes === confirmedCapBytes) {
      setCapDraft(null);
      setError("");
      return;
    }
    void save({ eventLogMaxBytes: bytes }, "cap");
  };

  const field = (knob: "retention" | "cap") => {
    const retention = knob === "retention";
    return (
      <span className="mt-1 flex items-center gap-2 text-[13px] leading-5 text-ink-secondary">
        <input
          id={retention ? "thread-log-retention-days" : "thread-log-cap-mib"}
          type="number"
          min={retention ? MIN_RETENTION_DAYS : MIN_CAP_BYTES / MIB}
          max={retention ? MAX_RETENTION_DAYS : MAX_CAP_BYTES / MIB}
          step={retention ? 1 : 0.25}
          inputMode={retention ? "numeric" : "decimal"}
          value={retention ? retentionValue : capValue}
          disabled={(retention ? confirmedRetentionDays : confirmedCapBytes) === null || pending !== null}
          aria-invalid={errorKnob === knob}
          aria-label={t(retention ? "settings.threadCleanup.retention.enable" : "settings.threadCleanup.cap.enable")}
          onChange={(event) => {
            if (retention) setRetentionDraft(event.target.value); else setCapDraft(event.target.value);
            setError("");
            setErrorKnob(null);
          }}
          onBlur={retention ? commitRetention : commitCap}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          className={cn(SETTINGS_INLINE_INPUT, errorKnob === knob && "border-danger/60")}
        />
        {t(retention ? "settings.threadCleanup.retention.unit" : "settings.threadCleanup.cap.unit")}
      </span>
    );
  };

  return (
    <SettingsGroup label={t("settings.threadCleanup.title")} block="cleanup">
      <SettingsRows>
        <SettingRow title={t("settings.threadCleanup.retention.title")} subtitle={<>{t("settings.threadCleanup.retention.short")}{confirmedRetentionDays !== null && field("retention")}</>}>
          <Switch id="thread-log-retention-enabled" checked={confirmedRetentionDays !== null} disabled={pending !== null}
            aria-label={t("settings.threadCleanup.retention.title")} onClick={() => toggleRetention(confirmedRetentionDays === null)} />
        </SettingRow>
        <SettingRow title={t("settings.threadCleanup.cap.title")} subtitle={<>{t("settings.threadCleanup.cap.short")}{confirmedCapBytes !== null && field("cap")}</>}
          message={pending !== null ? <span role="status">{t("settings.threadCleanup.saving")}</span> : error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
          <Switch id="thread-log-cap-enabled" checked={confirmedCapBytes !== null} disabled={pending !== null}
            aria-label={t("settings.threadCleanup.cap.title")} onClick={() => toggleCap(confirmedCapBytes === null)} />
        </SettingRow>
      </SettingsRows>
    </SettingsGroup>
  );
}
