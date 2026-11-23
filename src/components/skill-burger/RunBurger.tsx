import { Check, ChevronDown, ChevronUp, Plus, X, XCircle } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";

import type { RunRow, RunView } from "../../../shared/skill-burger/run-view";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { addBurgerPath, undoBurgerEdit } from "@/lib/skill-burger";
import { LayerIcon } from "./SkillBurger";

const SHEEN_PERIOD_MS = 2000;

/** The running step cooks: the same slow sheen as a bot's working phrase, and none with reduced motion. */
function Cooking({ text }: { text: string }) {
  const [delay] = useState(() => `-${Date.now() % SHEEN_PERIOD_MS}ms`);
  return (
    <span className="thinking-shimmer min-w-0 flex-1 truncate" style={{ "--sheen-period": `${SHEEN_PERIOD_MS}ms`, "--sheen-delay": delay } as CSSProperties}>
      {text}
      <span aria-hidden="true" className="thinking-sheen"><span data-text={text} /></span>
    </span>
  );
}

const ICON_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-secondary outline-none transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60 motion-reduce:transition-none";
const QUIET = "shrink-0 text-[11px] text-ink-tertiary";

function Row({ row }: { row: RunRow }) {
  const passed = row.state === "skipped" || row.state === "not_taken";
  const label = row.kind === "decide" ? t("skillBurger.run.decide", { question: row.label }) : row.label;
  return (
    <li
      data-burger-layer={row.kind}
      data-status={row.state}
      className={cn(
        "burger-layer flex min-h-9 min-w-0 flex-col justify-center rounded-[8px] bg-card px-3 py-1.5 text-[13px] shadow-sm",
        row.depth === 1 && "ms-5",
        passed && "opacity-50",
        row.state === "waiting" && "text-ink-secondary",
        row.state === "failed" && "text-danger",
      )}
    >
      {row.caseHeading && <span className="mb-0.5 text-[11px] font-medium text-ink-tertiary">{t("skillBurger.run.ifCase", { case: row.caseHeading })}</span>}
      <span className="flex min-w-0 items-center gap-2.5">
        <LayerIcon kind={row.kind} app={row.app} />
        {row.state === "running" ? <Cooking text={label} /> : <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>}
        {row.kind === "ai" && row.state !== "running" && <span className={QUIET}>{t("skillBurger.aiTag")}</span>}
        {row.state === "skipped" && <span className={QUIET}>{t("skillBurger.run.skipped")}</span>}
        {row.state === "not_taken" && <span className={QUIET}>{t("skillBurger.run.notThisTime")}</span>}
        {row.state === "done" && row.kind !== "decide" && <Check size={14} aria-label={t("skillBurger.run.done")} className="shrink-0 text-success" />}
        {row.state === "failed" && <XCircle size={14} aria-label={t("skillBurger.failed")} className="shrink-0" />}
      </span>
      {row.cases && (
        <span className="mt-1 flex flex-wrap gap-1 ps-[26px]">
          {row.cases.map((one) => (
            <span key={one} data-case={one} data-chosen={row.chosen === one ? "true" : undefined}
              className={cn("rounded-full px-2 py-px text-[11px]", row.chosen === one ? "bg-accent/15 text-accent-text" : "bg-ink/[0.05] text-ink-secondary")}>
              {one}
            </span>
          ))}
        </span>
      )}
      {row.error && <span className="mt-0.5 truncate ps-[26px] text-[12px]" title={row.error}>{row.error}</span>}
    </li>
  );
}

type Offer = { state: "idle" } | { state: "adding" } | { state: "added"; undo: string } | { state: "undone" } | { state: "error"; message: string };

/** The burger card while a saved Skill Burger runs: its steps cook and stack as the run goes, and a case nobody saved steps
 * for ends with a quiet one-tap offer to keep what the bot did. */
export function RunBurger({ view, summary, everyChat, botId, threadId, busy, onDismiss, edited }: {
  view: RunView;
  summary: string;
  everyChat: boolean;
  botId: string;
  threadId: string;
  busy: boolean;
  onDismiss: () => void;
  /** Set when the turn changed the burger's steps: its Undo. */
  edited?: { undo: string };
}) {
  const [folded, setFolded] = useState(false);
  const [offer, setOffer] = useState<Offer>({ state: "idle" });
  const [editUndone, setEditUndone] = useState(false);
  const live = view.rows.some((row) => row.state === "running");
  const failed = view.rows.some((row) => row.state === "failed");
  // The case offered stays named after its path is added, so its Undo stays in reach.
  const [offered, setOffered] = useState(view.missing);
  useEffect(() => { if (view.missing) setOffered(view.missing); }, [view.missing]);
  const missing = view.missing ?? (offer.state === "idle" ? undefined : offered);
  const toggleLabel = folded ? t("skillBurger.expand") : t("skillBurger.collapse");
  const fail = (cause: unknown) => setOffer({ state: "error", message: cause instanceof Error && cause.message ? cause.message : t("skillBurger.run.addPathFailed") });

  const addPath = async () => {
    if (!missing || offer.state === "adding") return;
    setOffer({ state: "adding" });
    try {
      const { undo } = await addBurgerPath({ name: view.name, everyChat, runBotId: botId, threadId, run: view.run, decide: missing.decide, case: missing.case });
      setOffer({ state: "added", undo });
    } catch (cause) {
      fail(cause);
    }
  };
  const undo = async (id: string, after: () => void) => {
    try {
      await undoBurgerEdit({ name: view.name, everyChat, botId, undo: id });
      after();
    } catch (cause) {
      fail(cause);
    }
  };

  const status = edited ? t("skillBurger.run.updated")
    : live ? t("skillBurger.run.running")
    : failed ? t("skillBurger.run.stopped")
    : view.run ? t("skillBurger.run.finished")
    : "";
  return (
    <section
      aria-label={t("skillBurger.aria")}
      data-skill-burger={live ? "running" : failed ? "failed" : edited ? "edited" : "ran"}
      className="skill-burger pointer-events-auto flex w-[21rem] max-w-full flex-col gap-[3px] text-ink"
    >
      <div className="burger-bun burger-bun-top relative flex items-start gap-1.5 rounded-t-[18px] rounded-b-[8px] bg-raised px-3 pb-2 pt-3.5 shadow-sm">
        <span aria-hidden="true" className="burger-sesame" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span dir="auto" className="min-w-0 truncate text-[13px] font-medium" title={summary}>{summary}</span>
          <span role="status" aria-live="polite" aria-atomic="true" className="truncate text-[12px] text-ink-secondary">{status}</span>
        </div>
        <button type="button" onClick={() => setFolded((value) => !value)} aria-expanded={!folded} aria-label={toggleLabel} title={toggleLabel} className={ICON_BUTTON}>
          {folded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
        </button>
        <button type="button" onClick={onDismiss} aria-label={t("skillBurger.dismiss")} title={t("skillBurger.dismiss")} className={ICON_BUTTON}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="burger-fold" data-folded={folded ? "true" : "false"} inert={folded} aria-hidden={folded || undefined}>
        <ol aria-label={t("skillBurger.layers")} className="burger-layers flex max-h-72 min-h-0 flex-col gap-[3px] overflow-y-auto">
          {view.rows.map((row) => <Row key={row.id} row={row} />)}
        </ol>
      </div>

      {(edited || (missing && !busy && !live)) && (
        <div className="burger-bun burger-bun-bottom flex min-h-10 items-center rounded-b-[18px] rounded-t-[8px] bg-raised shadow-sm">
          {edited ? (
            <div className="flex w-full items-center gap-2 px-3 text-[13px]">
              <Check size={14} aria-hidden="true" className="shrink-0 text-success" />
              <span className="min-w-0 flex-1 truncate">{editUndone ? t("skillBurger.run.editUndone") : t("skillBurger.run.updated")}</span>
              {!editUndone && (
                <button type="button" onClick={() => void undo(edited.undo, () => setEditUndone(true))} className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-accent-text outline-none hover:bg-ink/[0.06] focus-visible:ring-2 focus-visible:ring-accent/60">
                  {t("common.undo")}
                </button>
              )}
            </div>
          ) : offer.state === "added" ? (
            <div className="flex w-full items-center gap-2 px-3 text-[13px]">
              <Check size={14} aria-hidden="true" className="shrink-0 text-success" />
              <span className="min-w-0 flex-1 truncate">{t("skillBurger.run.pathAdded", { case: missing!.case })}</span>
              <button type="button" onClick={() => void undo(offer.undo, () => setOffer({ state: "undone" }))} className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-accent-text outline-none hover:bg-ink/[0.06] focus-visible:ring-2 focus-visible:ring-accent/60">
                {t("common.undo")}
              </button>
            </div>
          ) : offer.state === "undone" ? (
            <span className="px-3 text-[13px] text-ink-secondary">{t("skillBurger.run.pathUndone")}</span>
          ) : (
            <button
              type="button"
              onClick={() => void addPath()}
              disabled={offer.state === "adding"}
              className="flex h-10 w-full items-center justify-center gap-1.5 rounded-b-[18px] rounded-t-[8px] text-[13px] font-medium text-accent-text outline-none transition-colors hover:bg-ink/[0.05] focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:text-ink-tertiary motion-reduce:transition-none"
            >
              <Plus size={14} aria-hidden="true" />{t("skillBurger.run.addPath", { case: missing!.case })}
            </button>
          )}
        </div>
      )}
      {offer.state === "error" && <p role="alert" className="px-3 text-[12px] text-danger">{offer.message}</p>}
    </section>
  );
}
