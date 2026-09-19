// Settings → Self-modify: the operator console for the self-modification
// subsystem. Astra (or anyone holding the agent tool) proposes edits to this
// app's own TypeScript; this screen is where proposals are reviewed, applied,
// and rolled back.
//
// It is deliberately a thin view: the journal, the preflight gate, the trial
// boot, and the detached watchdog all live server-side (server/self-modify.ts),
// so the worst this screen can do is call the same apply/revert/settle
// functions the HTTP API already exposes — never weaken them.
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, ShieldCheck, Trash2, Undo2 } from "lucide-react";

import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { Card, Switch } from "./SettingsPrimitives";

/** One row of the pending inbox (public API: GET /api/self-modify). */
export interface SelfModifyPending {
  file: string;
  id: string | null;
  proposedBy: string | null;
  reason: string | null;
  bytes: number;
  /** Why this proposal cannot be applied; absent when it is ready. */
  invalid?: string;
}

export interface SelfModifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SelfModifyEntry {
  id: string;
  proposedBy: string;
  reason: string;
  status: "applied" | "verified" | "reverted" | "failed";
  appliedAt: string;
  verifiedAt: string | null;
  revertedAt: string | null;
  revertReason: string | null;
  files: string[];
  checks: SelfModifyCheck[];
}

const STATUS_LABEL: Record<SelfModifyEntry["status"], LocaleKey> = {
  applied: "settings.selfModify.status.applied",
  verified: "settings.selfModify.status.verified",
  reverted: "settings.selfModify.status.reverted",
  failed: "settings.selfModify.status.failed",
};

function statusClass(status: SelfModifyEntry["status"]): string {
  if (status === "verified") return "bg-success/15 text-success";
  if (status === "reverted" || status === "failed") return "bg-danger/15 text-danger";
  return "bg-accent/15 text-accent";
}

/** True when an entry edits the harness itself, where the trial boot — not a
 *  click — is what proves it. */
export function touchesServer(files: string[]): boolean {
  return files.some((file) => /(^|\s)(server|shared)\//.test(file));
}

/** The inbox as rows. Pure props on purpose: every component test in this
 *  repo renders static markup, where effects never run. */
export function PendingProposals({
  pending,
  busyId,
  confirmId,
  onAskApply,
  onCancelApply,
  onApply,
  onDiscard,
}: {
  pending: SelfModifyPending[];
  busyId: string | null;
  /** The id whose Apply button has been pressed once; the second press runs it. */
  confirmId: string | null;
  onAskApply: (id: string) => void;
  onCancelApply: () => void;
  onApply: (id: string) => void;
  onDiscard: (id: string) => void;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {pending.map((proposal) => {
        const id = proposal.id ?? proposal.file;
        const busy = busyId === id;
        return (
          <li key={proposal.file} className="rounded-lg border border-hairline/30 bg-inset px-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[13px] text-ink">{proposal.reason ?? proposal.file}</div>
                <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                  {t("settings.selfModify.pending.meta", {
                    by: proposal.proposedBy ?? t("settings.selfModify.unknownAuthor"),
                    id,
                    kb: Math.max(1, Math.round(proposal.bytes / 1024)),
                  })}
                </div>
                {proposal.invalid ? (
                  <div className="mt-1 flex items-start gap-1.5 text-[11.5px] text-danger">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span>{proposal.invalid}</span>
                  </div>
                ) : null}
              </div>
              {proposal.invalid ? null : (
                <div className="flex shrink-0 items-center gap-1.5">
                  {confirmId === id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => onApply(id)}
                        disabled={busy}
                        className="flex items-center gap-1 rounded-lg border border-accent/40 px-2 py-1 text-[12px] text-accent hover:bg-raised disabled:opacity-50"
                      >
                        {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                        {t("settings.selfModify.confirm")}
                      </button>
                      <button
                        type="button"
                        onClick={onCancelApply}
                        className="rounded-lg px-2 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
                      >
                        {t("settings.selfModify.cancel")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onAskApply(id)}
                      disabled={busy}
                      className="rounded-lg bg-control px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50"
                    >
                      {t("settings.selfModify.apply")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onDiscard(id)}
                    disabled={busy}
                    aria-label={t("settings.selfModify.discard")}
                    title={t("settings.selfModify.discard")}
                    className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The journal as rows: what happened, in order, with the checks it passed. */
export function SelfModifyJournal({
  entries,
  busyId,
  onRevert,
  onVerify,
}: {
  entries: SelfModifyEntry[];
  busyId: string | null;
  onRevert: (id: string) => void;
  onVerify: (id: string) => void;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {entries.map((entry) => {
        const busy = busyId === entry.id;
        const serverTouching = touchesServer(entry.files);
        const failed = entry.checks.find((check) => !check.ok);
        return (
          <li key={entry.id} className="rounded-lg border border-hairline/30 bg-inset px-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide", statusClass(entry.status))}>
                    {t(STATUS_LABEL[entry.status])}
                  </span>
                  <span className="truncate text-[13px] text-ink">{entry.reason}</span>
                </div>
                <div className="mt-1 text-[11.5px] text-ink-secondary">
                  {t("settings.selfModify.journal.meta", { by: entry.proposedBy, id: entry.id })}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {entry.files.map((file) => (
                    <code key={file} className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary">
                      {file}
                    </code>
                  ))}
                </div>
                {entry.status === "applied" ? (
                  <div className="mt-1 text-[11.5px] text-accent">
                    {serverTouching
                      ? t("settings.selfModify.journal.awaitingRestart")
                      : t("settings.selfModify.journal.awaitingVerify")}
                  </div>
                ) : null}
                {entry.status === "reverted" && entry.revertReason ? (
                  <div className="mt-1 text-[11.5px] text-danger">
                    {t("settings.selfModify.journal.revertedWhy", { why: entry.revertReason })}
                  </div>
                ) : null}
                {entry.status === "failed" && failed ? (
                  <div className="mt-1 text-[11.5px] text-danger">
                    {failed.name}: {failed.detail}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {entry.status === "applied" && !serverTouching ? (
                  <button
                    type="button"
                    onClick={() => onVerify(entry.id)}
                    disabled={busy}
                    className="flex items-center gap-1 rounded-lg border border-hairline/40 px-2 py-1 text-[12px] text-ink hover:border-hairline disabled:opacity-50"
                  >
                    <Check size={12} />
                    {t("settings.selfModify.verify")}
                  </button>
                ) : null}
                {entry.status === "verified" || entry.status === "applied" ? (
                  <button
                    type="button"
                    onClick={() => onRevert(entry.id)}
                    disabled={busy}
                    className="flex items-center gap-1 rounded-lg border border-hairline/40 px-2 py-1 text-[12px] text-ink hover:border-hairline disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
                    {t("settings.selfModify.revert")}
                  </button>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Settings → Self-modify: the switch, the inbox, and the journal. The switch
 *  is the only control that changes behavior; everything else reads or
 *  settles what the server already decided. */
export function SelfModifySection() {
  const { state, dispatch } = useStore();
  const enabled = state.config?.features?.selfModify === true;

  const [reload, setReload] = useState(0);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<SelfModifyPending[]>([]);
  const [journal, setJournal] = useState<SelfModifyEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setPending([]);
      setJournal([]);
      return;
    }
    let alive = true;
    setLoading(true);
    api("/api/self-modify")
      .then((frame: { pending?: SelfModifyPending[]; journal?: SelfModifyEntry[] }) => {
        if (!alive) return;
        setPending(frame.pending ?? []);
        setJournal(frame.journal ?? []);
      })
      .catch((cause: Error) => {
        if (alive) setError(cause.message || t("settings.selfModify.error"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [enabled, reload]);

  const setFeature = (next: boolean) => {
    if (toggling) return;
    setToggling(true);
    setError(null);
    api("/api/config", { method: "PATCH", body: JSON.stringify({ features: { selfModify: next } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setToggling(false));
  };

  const settle = (id: string, action: "apply" | "discard" | "revert" | "verify") => {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    api(`/api/self-modify/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ action }) })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => {
        setBusyId(null);
        setConfirmId(null);
        setReload((count) => count + 1);
      });
  };

  const revertAll = () => {
    if (busyId) return;
    setBusyId("__all__");
    setError(null);
    api("/api/self-modify", { method: "POST", body: JSON.stringify({ action: "revert-unverified" }) })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => {
        setBusyId(null);
        setReload((count) => count + 1);
      });
  };

  const unverified = journal.filter((entry) => entry.status === "applied").length;

  return (
    <div className="flex flex-col gap-4">
      <Card title={t("settings.selfModify.title")} subtitle={t("settings.selfModify.subtitle")}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[14px] font-medium text-ink">{t("settings.selfModify.enable")}</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("settings.selfModify.enableHint")}</div>
            </div>
            <Switch
              checked={enabled}
              aria-label={t("settings.selfModify.enable")}
              disabled={toggling}
              onClick={() => setFeature(!enabled)}
              className="disabled:cursor-wait disabled:opacity-50"
            />
          </div>

          <div className="rounded-lg border border-hairline/30 bg-inset px-3 py-2 text-[12px] leading-relaxed text-ink-secondary">
            <div className="mb-1 flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
              <ShieldCheck size={13} className="text-success" />
              {t("settings.selfModify.failsafe.title")}
            </div>
            <ul className="list-disc space-y-1 pl-4">
              <li>{t("settings.selfModify.failsafe.leash")}</li>
              <li>{t("settings.selfModify.failsafe.journal")}</li>
              <li>{t("settings.selfModify.failsafe.preflight")}</li>
              <li>{t("settings.selfModify.failsafe.trial")}</li>
              <li>{t("settings.selfModify.failsafe.switch")}</li>
            </ul>
          </div>

          {error ? (
            <p role="alert" className="text-[12px] text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </Card>

      {enabled ? (
        <>
          <Card title={t("settings.selfModify.pending.title")} subtitle={t("settings.selfModify.pending.subtitle")}>
            {loading && !pending.length ? (
              <p className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
                <Loader2 size={13} className="animate-spin" />
                {t("settings.selfModify.loading")}
              </p>
            ) : pending.length ? (
              <PendingProposals
                pending={pending}
                busyId={busyId}
                confirmId={confirmId}
                onAskApply={setConfirmId}
                onCancelApply={() => setConfirmId(null)}
                onApply={(id) => settle(id, "apply")}
                onDiscard={(id) => settle(id, "discard")}
              />
            ) : (
              <p className="text-[12.5px] leading-relaxed text-ink-secondary">{t("settings.selfModify.pending.empty")}</p>
            )}
          </Card>

          <Card title={t("settings.selfModify.journal.title")} subtitle={t("settings.selfModify.journal.subtitle")}>
            {unverified > 0 ? (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-accent/30 bg-inset px-3 py-2">
                <span className="text-[12px] text-ink">{t("settings.selfModify.unverified", { count: unverified })}</span>
                <button
                  type="button"
                  onClick={revertAll}
                  disabled={busyId !== null}
                  className="flex shrink-0 items-center gap-1 rounded-lg border border-hairline/40 px-2 py-1 text-[12px] text-ink hover:border-hairline disabled:opacity-50"
                >
                  {busyId === "__all__" ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
                  {t("settings.selfModify.revertAll")}
                </button>
              </div>
            ) : null}
            {journal.length ? (
              <SelfModifyJournal
                entries={journal}
                busyId={busyId}
                onRevert={(id) => settle(id, "revert")}
                onVerify={(id) => settle(id, "verify")}
              />
            ) : (
              <p className="text-[12.5px] leading-relaxed text-ink-secondary">{t("settings.selfModify.journal.empty")}</p>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}




