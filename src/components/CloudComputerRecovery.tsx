import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { recoveryUnderWay, type CloudComputerRecovery, type CloudComputerRecoveryState } from "../../shared/cloud-computer-recovery";

const POLL_MS = 15_000;

const LINES: Record<CloudComputerRecoveryState, LocaleKey> = {
  "not-responding": "computer.recovery.notResponding",
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

/** What MausBot is doing about a cloud computer that stopped answering, and the person's Restart computer and Replace computer. */
/** `always`: the buttons show even while nothing is wrong (Advanced); otherwise only once MausBot is dealing with the computer. */
export function CloudComputerRecoveryRow({ botId, name, always }: { botId: string; name: string; always?: boolean }) {
  const [recovery, setRecovery] = useState<CloudComputerRecovery | null>(null);
  const [pending, setPending] = useState<"restart" | "replace" | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const path = `/api/bots/${botId}/computer/recovery`;

  const refresh = useCallback(() => {
    api<{ recovery: CloudComputerRecovery | null }>(path, { background: true })
      .then((body) => setRecovery(body.recovery ?? null))
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
  if (!always && !recovery && !result) return null;
  return (
    <div className="mt-3" data-testid="cloud-computer-recovery">
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
