// Settings → Engines → Antigravity → "Free up space". On Windows, Google's
// Antigravity runtime unpacks a large set of files every time it starts and
// leaves them behind whenever it is stopped by force. OpenMausBot clears the
// ones in its own folder by itself; this also finds the ones left in the
// Windows temporary folder. It always says how much it found before deleting.
import { useState } from "react";
import { HardDrive, Loader2 } from "lucide-react";
import { api, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";

type Phase =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "found"; bytes: number; complete: boolean }
  | { kind: "none" }
  | { kind: "deleting" }
  | { kind: "done"; freedBytes: number; remaining: number };

/** Sizes the way Windows Explorer shows them (1 GB = 1024 MB). */
export function formatDiskSize(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  if (mb < 1) return t("engines.freeSpace.underOneMb");
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function AntigravityFreeSpace({ instance, initial = { kind: "idle" } }: {
  instance: InstanceInfo;
  /** Test seam for the static-markup tests. */
  initial?: Phase;
}) {
  const [phase, setPhase] = useState<Phase>(initial);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/instances/${encodeURIComponent(instance.instanceId)}/leftover-files`;

  const scan = async () => {
    setError(null);
    setPhase({ kind: "scanning" });
    try {
      const found = await api<{ bytes: number; folders: number; complete: boolean }>(base);
      setPhase(found.folders > 0 ? { kind: "found", bytes: found.bytes, complete: found.complete } : { kind: "none" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase({ kind: "idle" });
    }
  };

  const remove = async () => {
    setError(null);
    setPhase({ kind: "deleting" });
    try {
      const result = await api<{ freedBytes: number; remaining: number }>(`${base}/remove`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setPhase({ kind: "done", freedBytes: result.freedBytes, remaining: result.remaining });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase({ kind: "idle" });
    }
  };

  const busy = phase.kind === "scanning" || phase.kind === "deleting";
  return (
    <section className="mt-3 rounded-xl border border-hairline/40 px-3 py-2.5" aria-label={t("engines.freeSpace.title")}>
      <div className="flex flex-wrap items-center gap-2">
        <HardDrive size={13} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        <span className="text-[12px] font-medium text-ink">{t("engines.freeSpace.title")}</span>
        <span className="flex-1" />
        {(phase.kind === "idle" || phase.kind === "none" || phase.kind === "done" || busy) && (
          <button
            type="button"
            onClick={() => void scan()}
            disabled={busy}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-hairline/40 px-3 py-1 text-[12px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {t("engines.freeSpace.action")}
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{t("engines.freeSpace.intro")}</p>
      {phase.kind === "scanning" && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{t("engines.freeSpace.scanning")}</p>}
      {phase.kind === "deleting" && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{t("engines.freeSpace.deleting")}</p>}
      {phase.kind === "none" && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{t("engines.freeSpace.none")}</p>}
      {phase.kind === "found" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p role="status" className="flex-1 text-[12px] text-ink">
            {t(phase.complete ? "engines.freeSpace.found" : "engines.freeSpace.foundAtLeast", { size: formatDiskSize(phase.bytes) })}
          </p>
          <button
            type="button"
            onClick={() => setPhase({ kind: "idle" })}
            className="rounded-lg px-3 py-1 text-[12px] text-ink-secondary hover:bg-raised/50 hover:text-ink"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            className="rounded-lg bg-raised px-3 py-1 text-[12px] text-ink hover:bg-raised-hover"
          >
            {t("engines.freeSpace.delete")}
          </button>
        </div>
      )}
      {phase.kind === "done" && (
        <p role="status" className="mt-2 text-[12px] text-ink-secondary">
          {(phase.freedBytes > 0 || phase.remaining === 0) && (
            <span className="text-success">{t("engines.freeSpace.freed", { size: formatDiskSize(phase.freedBytes) })} </span>
          )}
          {phase.remaining > 0 && t("engines.freeSpace.someLeft")}
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </section>
  );
}
