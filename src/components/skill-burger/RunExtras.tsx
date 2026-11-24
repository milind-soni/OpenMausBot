// The run card's two small extras: what a step brought back (each teammate's reply, a check's verdict), and the
// burger's last few runs, with the one-line offer to keep a fix the bot made to get past a failed step.
import { Check, ChevronRight, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import type { RowDetail } from "../../../shared/skill-burger/run-view";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { fetchBurgerRuns, keepBurgerFix, type BurgerRunRecord } from "@/lib/skill-burger";

const QUIET = "text-[11px] text-ink-tertiary";

/** A step's replies and check, folded under its row until opened. */
export function RowExtra({ detail, label }: { detail: RowDetail; label: string }) {
  const [open, setOpen] = useState(false);
  const replies = detail.replies ?? [];
  if (!replies.length && !detail.check) return null;
  return (
    <div className="mt-1 ps-[26px] text-[12px] text-ink-secondary">
      {detail.check && (
        <p className={cn("min-w-0", !detail.check.passed && "text-danger")}>
          {detail.check.passed ? t("skillBurger.run.checkPassed", { check: detail.check.says }) : t("skillBurger.run.checkFailed", { why: detail.check.why ?? detail.check.says })}
        </p>
      )}
      {replies.length ? (
        <>
          <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} title={t("skillBurger.draft.details", { step: label })}
            className="flex items-center gap-1 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
            <ChevronRight size={12} aria-hidden="true" className={cn("shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
            <span>{t("skillBurger.run.repliesFrom")}{detail.rounds && detail.rounds > 1 ? ` · ${t("skillBurger.draft.rounds", { count: detail.rounds })}` : ""}</span>
          </button>
          {open && replies.map((reply) => (
            <p key={reply.name} className={cn("mt-1 line-clamp-4 min-w-0", !reply.ok && "text-danger")}><b className="font-medium text-ink">{reply.name}</b>{" · "}{reply.text}</p>
          ))}
        </>
      ) : null}
    </div>
  );
}

const ago = (at: number) => {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  try {
    const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    return minutes < 60 ? format.format(-minutes, "minute") : minutes < 48 * 60 ? format.format(-Math.round(minutes / 60), "hour") : format.format(-Math.round(minutes / 1440), "day");
  } catch {
    return "";
  }
};

/** The burger's last runs (newest first), and "Update the burger with this fix" when the newest one in this chat went on
 * from a failed step after the bot fixed it. */
export function RunHistory({ name, botId, threadId, refreshKey }: { name: string; botId: string; threadId: string; refreshKey: string }) {
  const [runs, setRuns] = useState<BurgerRunRecord[] | null>(null);
  const [kept, setKept] = useState<"idle" | "saving" | "done" | "error">("idle");
  useEffect(() => {
    let current = true;
    void fetchBurgerRuns(name).then((found) => { if (current) setRuns(found); });
    return () => { current = false; };
  }, [name, refreshKey]);
  if (!runs?.length) return null;
  const fixed = runs.find((run) => run.threadId === threadId && run.status !== "failed" && run.fixedBy);
  const keep = async () => {
    if (!fixed?.fixedBy || kept === "saving") return;
    setKept("saving");
    try {
      await keepBurgerFix({ name, runBotId: botId, threadId, run: fixed.run, step: fixed.fixedBy });
      setKept("done");
    } catch {
      setKept("error");
    }
  };
  return (
    <div className="flex flex-col gap-[3px]">
      {fixed && kept !== "done" && (
        <button type="button" onClick={() => void keep()} disabled={kept === "saving"} data-burger-keep-fix
          className="burger-layer burger-open flex min-h-8 items-center justify-center rounded-[8px] bg-card px-3 text-[12px] font-medium text-accent-text shadow-sm outline-none hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-accent/60 disabled:text-ink-tertiary">
          {t("skillBurger.run.keepFix")}
        </button>
      )}
      {kept === "done" && <p className="px-3 text-[12px] text-ink-secondary">{t("skillBurger.run.fixKept")}</p>}
      {kept === "error" && <p role="alert" className="px-3 text-[12px] text-danger">{t("skillBurger.run.addPathFailed")}</p>}
      <details className="burger-layer burger-open rounded-[8px] bg-card px-3 py-1.5 text-[12px] shadow-sm" data-burger-history>
        <summary className="cursor-pointer text-ink-secondary outline-none focus-visible:ring-2 focus-visible:ring-accent/60">{t("skillBurger.run.history")}</summary>
        <ul className="mt-1 flex flex-col gap-0.5">
          {runs.slice(0, 5).map((run) => (
            <li key={run.run} className="flex min-w-0 items-center gap-1.5">
              {run.status === "ok" ? <Check size={12} aria-hidden="true" className="shrink-0 text-success" /> : run.status === "failed" ? <XCircle size={12} aria-hidden="true" className="shrink-0 text-danger" /> : <span aria-hidden="true" className="size-3 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">
                {run.status === "ok" ? t("skillBurger.run.historyOk") : run.status === "failed" ? t("skillBurger.run.historyFailed", { step: run.failed?.label || run.failed?.step || "" }) : t("skillBurger.run.historyWaiting")}
                {run.defaults?.length ? <span className={QUIET}>{" · "}{t("skillBurger.run.historyReused", { names: run.defaults.join(", ") })}</span> : null}
              </span>
              <span className={cn(QUIET, "shrink-0")}>{ago(run.at)}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
