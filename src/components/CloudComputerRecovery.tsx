import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { DISK_WARN_PERCENT, recoveryUnderWay, type CloudComputerAnswering, type CloudComputerDisk, type CloudComputerRecovery, type CloudComputerRecoveryState } from "../../shared/cloud-computer-recovery";

const POLL_MS = 15_000;

const LINES: Record<CloudComputerRecoveryState, LocaleKey> = {
  "not-responding": "computer.recovery.notResponding",
  restoring: "computer.recovery.restoring",
  restarting: "computer.recovery.restarting",
  replacing: "computer.recovery.replacing",
  restarted: "server.cloudComputer.restarted",
  replaced: "server.cloudComputer.replaced",
  unreachable: "server.cloudComputer.unreachable",
  capped: "server.cloudComputer.capped",
  "needs-person": "server.cloudComputer.needsPerson",
};

/** The line the computer panel shows; an action the person took is worded as theirs. */
export function recoveryLine(recovery: CloudComputerRecovery, name: string): string {
  if (recovery.manual && recovery.state === "replaced") return t("computer.recovery.replacedManual", { name });
  if (recovery.manual && recovery.state === "restarted") return t("computer.recovery.restartedManual");
  return t(LINES[recovery.state], { name });
}

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Whether the computer answers its commands, in one line; nothing while it is awake and `quiet`, or was never asked. */
export function answeringLine(answering: CloudComputerAnswering | null, quiet: boolean): string | null {
  if (!answering) return null;
  if (answering.state === "awake") return quiet || answering.lastAnsweredAt === null ? null : t("computer.answering.awake", { time: clock(answering.lastAnsweredAt) });
  if (answering.state === "not-responding") return t("computer.answering.notResponding", { time: clock(answering.since ?? Date.now()) });
  return t(answering.state === "restoring" ? "computer.answering.restoring" : "computer.answering.waking");
}

/** The disk's part of the state line: how full it is once that matters, and when its caches were last cleared. */
export function diskLine(disk: CloudComputerDisk | null): string | null {
  if (!disk) return null;
  const parts = [
    disk.percent >= DISK_WARN_PERCENT ? t("computer.disk.full", { percent: disk.percent }) : null,
    disk.spaceClearedAt !== undefined ? t("computer.disk.clearedSpace", { time: clock(disk.spaceClearedAt) })
      : disk.clearedAt !== undefined ? t("computer.disk.cleared", { time: clock(disk.clearedAt) }) : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" ") : null;
}

/** What MausBot is doing about a cloud computer that stopped answering, and the person's Restart computer and Replace computer. */
/** `always`: the buttons show even while nothing is wrong (Advanced); otherwise only once MausBot is dealing with the computer. */
export function CloudComputerRecoveryRow({ botId, name, always }: { botId: string; name: string; always?: boolean }) {
  const [recovery, setRecovery] = useState<CloudComputerRecovery | null>(null);
  const [answering, setAnswering] = useState<CloudComputerAnswering | null>(null);
  const [disk, setDisk] = useState<CloudComputerDisk | null>(null);
  const [pending, setPending] = useState<"restart" | "replace" | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const path = `/api/bots/${botId}/computer/recovery`;

  const refresh = useCallback(() => {
    api<{ recovery: CloudComputerRecovery | null; answering?: CloudComputerAnswering | null; disk?: CloudComputerDisk | null }>(path, { background: true })
      .then((body) => { setRecovery(body.recovery ?? null); setAnswering(body.answering ?? null); setDisk(body.disk ?? null); })
      .catch(() => {});
  }, [path]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const act = async (action: "restart" | "replace") => {
    if (action === "replace" && !window.confirm(t("computer.recovery.confirmReplace", { name }))) return;
    setPending(action);
    setResult(null);
    try {
      const out = await api<{ answers?: boolean }>(path, { method: "POST", body: JSON.stringify({ action }) });
      if (action === "restart" && !out.answers) setResult(t("computer.recovery.stillNotAnswering", { name }));
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
      refresh();
    }
  };

  const busy = pending !== null || Boolean(recovery && recoveryUnderWay(recovery.state));
  // While MausBot is dealing with the computer its own line says more than this one.
  const state = recovery && recoveryUnderWay(recovery.state) ? null : [answeringLine(answering, !always), diskLine(disk)].filter(Boolean).join(" ") || null;
  if (!always && !recovery && !result && !state) return null;
  return (
    <div className="mt-3" data-testid="cloud-computer-recovery">
      {state && <p className="text-[12px] leading-5 text-ink-secondary" role="status" data-testid="cloud-computer-answering">{state}</p>}
      {recovery && <p className="text-[12px] leading-5 text-ink-secondary" role="status">{recoveryLine(recovery, name)}</p>}
      {result && <p className="text-[12px] leading-5 text-danger" role="alert">{result}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void act("restart")}
          disabled={busy}
          className="flex flex-auto items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
          title={t("computer.recovery.restartTitle")}
        >
          {pending === "restart" ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
          {t("computer.recovery.restart")}
        </button>
        <button
          type="button"
          onClick={() => void act("replace")}
          disabled={busy}
          className="flex flex-auto items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-danger/30 px-3 py-2 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50"
          title={t("computer.recovery.replaceTitle")}
        >
          {pending === "replace" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {t("computer.recovery.replace")}
        </button>
      </div>
    </div>
  );
}
