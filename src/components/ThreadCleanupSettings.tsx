import { useEffect, useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

/** Server bounds from server/config.ts, mirrored here so the form can
 * reject out-of-range input before the round trip. */
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
  // mibText shows at most two decimals, so accept only exact 0.25 MiB steps:
  // 0.251 would persist as 263193 bytes, redisplay as 0.25, and silently
  // shrink to 262144 on the next save.
  return bytes >= MIN_CAP_BYTES && bytes <= MAX_CAP_BYTES && bytes % MIN_CAP_BYTES === 0 ? bytes : null;
}

/** 52428800 → "50", 262144 → "0.25" — the input shows whole MiB when it can. */
function mibText(bytes: number): string {
  const mib = bytes / MIB;
  return String(Number.isInteger(mib) ? mib : Number(mib.toFixed(2)));
}

type Knob = "retention" | "cap";

export function ThreadCleanupSettings() {
  const { state, dispatch } = useStore();
  const confirmedRetentionDays = state.config?.threads?.eventLogRetentionDays ?? null;
  const confirmedCapBytes = state.config?.threads?.eventLogMaxBytes ?? null;
  // a draft is the field the user is typing in; null means follow the server
  const [retentionDraft, setRetentionDraft] = useState<string | null>(null);
  const [capDraft, setCapDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<Knob | null>(null);
  const [error, setError] = useState("");
  const [errorKnob, setErrorKnob] = useState<Knob | null>(null);
  const saving = useRef(false);

  const retentionValue = retentionDraft ?? (confirmedRetentionDays === null ? String(DEFAULT_RETENTION_DAYS) : String(confirmedRetentionDays));
  const capValue = capDraft ?? (confirmedCapBytes === null ? String(DEFAULT_CAP_MIB) : mibText(confirmedCapBytes));

  // a save from the other knob replaces the config object, so only drop the
  // draft that matches the value the server just confirmed
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

  return (
    <Card title={t("settings.threadCleanup.title")} subtitle={t("settings.threadCleanup.subtitle")}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="thread-log-retention-enabled"
            type="checkbox"
            checked={confirmedRetentionDays !== null}
            disabled={pending !== null}
            onChange={(event) => toggleRetention(event.target.checked)}
            className="size-4 accent-accent"
          />
          <label htmlFor="thread-log-retention-enabled" className="text-[13px] font-medium text-ink">{t("settings.threadCleanup.retention.enable")}</label>
          <div className={`flex max-w-[160px] items-center rounded-lg border bg-inset ${errorKnob === "retention" ? "border-danger/60" : "border-hairline/40 focus-within:border-hairline"}`}>
            <input
              id="thread-log-retention-days"
              type="number"
              min={MIN_RETENTION_DAYS}
              max={MAX_RETENTION_DAYS}
              step={1}
              inputMode="numeric"
              value={retentionValue}
              disabled={confirmedRetentionDays === null || pending !== null}
              aria-invalid={errorKnob === "retention"}
              aria-describedby="thread-log-retention-help"
              onChange={(event) => {
                setRetentionDraft(event.target.value);
                setError("");
                setErrorKnob(null);
              }}
              onBlur={commitRetention}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-[14px] tabular-nums text-ink focus:outline-none"
            />
            <span className="pr-3 text-[13px] text-ink-secondary">{t("settings.threadCleanup.retention.unit")}</span>
          </div>
        </div>
        <p id="thread-log-retention-help" className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.threadCleanup.retention.help")}</p>
      </div>
      <div className="mt-4 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="thread-log-cap-enabled"
            type="checkbox"
            checked={confirmedCapBytes !== null}
            disabled={pending !== null}
            onChange={(event) => toggleCap(event.target.checked)}
            className="size-4 accent-accent"
          />
          <label htmlFor="thread-log-cap-enabled" className="text-[13px] font-medium text-ink">{t("settings.threadCleanup.cap.enable")}</label>
          <div className={`flex max-w-[160px] items-center rounded-lg border bg-inset ${errorKnob === "cap" ? "border-danger/60" : "border-hairline/40 focus-within:border-hairline"}`}>
            <input
              id="thread-log-cap-mib"
              type="number"
              min={MIN_CAP_BYTES / MIB}
              max={MAX_CAP_BYTES / MIB}
              step={0.25}
              inputMode="decimal"
              value={capValue}
              disabled={confirmedCapBytes === null || pending !== null}
              aria-invalid={errorKnob === "cap"}
              aria-describedby="thread-log-cap-help"
              onChange={(event) => {
                setCapDraft(event.target.value);
                setError("");
                setErrorKnob(null);
              }}
              onBlur={commitCap}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-[14px] tabular-nums text-ink focus:outline-none"
            />
            <span className="pr-3 text-[13px] text-ink-secondary">{t("settings.threadCleanup.cap.unit")}</span>
          </div>
        </div>
        <p id="thread-log-cap-help" className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.threadCleanup.cap.help")}</p>
      </div>
      {pending !== null && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{t("settings.threadCleanup.saving")}</p>}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}
