import { BookmarkPlus, CheckCircle2, ChevronDown, ChevronUp, Circle, ListChecks, Loader2, X, XCircle } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { runSummary, type RunSkill, type RunStep } from "@/lib/verify-steps";

function StatusIcon({ status }: { status: RunStep["status"] }) {
  const className = "size-4 shrink-0";
  switch (status) {
    case "running":
      return <Loader2 aria-hidden="true" className={cn(className, "animate-spin text-accent")} />;
    case "passed":
      return <CheckCircle2 aria-hidden="true" className={cn(className, "text-success")} />;
    case "failed":
      return <XCircle aria-hidden="true" className={cn(className, "text-danger")} />;
    case "unverified":
      return <Circle aria-hidden="true" className={cn(className, "text-ink-secondary")} />;
  }
}

const ICON_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-secondary outline-none hover:bg-raised-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60";

export function VerifyCard({
  steps,
  canSave,
  skill,
  onDismiss,
  onSave,
}: {
  steps: RunStep[];
  canSave: boolean;
  skill: RunSkill;
  onDismiss: () => void;
  onSave: () => void;
}) {
  const defaultCollapsed = steps.length > 6;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  if (steps.length === 0) return null;
  const toggleLabel = collapsed ? t("chat.verify.expand") : t("chat.verify.collapse");
  return (
    <section
      aria-label={t("chat.verify.aria")}
      className="pointer-events-auto w-[22rem] max-w-full rounded-2xl border border-hairline/40 bg-raised/95 text-ink shadow-lg backdrop-blur-sm"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <ListChecks size={14} className="shrink-0 text-accent" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-medium">{t("chat.verify.title")}</span>
          <span role="status" aria-live="polite" aria-atomic="true" className="text-[12px] text-ink-secondary">
            {runSummary(steps).label}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((current) => !current)}
          aria-expanded={!collapsed}
          aria-label={toggleLabel}
          title={toggleLabel}
          className={ICON_BUTTON}
        >
          {collapsed ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        </button>
        <button type="button" onClick={onDismiss} aria-label={t("chat.verify.dismiss")} title={t("chat.verify.dismiss")} className={ICON_BUTTON}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {!collapsed && (
        <>
          <ol
            tabIndex={0}
            aria-label={t("chat.verify.steps")}
            className="max-h-56 overflow-y-auto border-t border-hairline/25 px-3 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {steps.map((step) => (
              <li key={step.id} className="flex min-w-0 items-center gap-2 py-1">
                <StatusIcon status={step.status} />
                <span className="shrink-0 text-[13px] font-medium">{step.label}</span>
                {step.verified && (
                  <span className="shrink-0 text-[11px] uppercase tracking-wide text-success">{t("chat.verify.verifiedTag")}</span>
                )}
                <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-secondary" title={step.command}>
                  {step.command}
                </code>
              </li>
            ))}
          </ol>
          {skill ? (
            <div className="border-t border-hairline/25 px-3 py-2 text-[12px] text-ink-secondary">
              {t(skill === "saved" ? "chat.verify.saved" : "chat.verify.staged")}
            </div>
          ) : canSave && (
            <div className="flex flex-col items-end gap-1 border-t border-hairline/25 px-3 py-2">
              <button
                type="button"
                onClick={onSave}
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-ink-secondary outline-none hover:bg-raised-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <BookmarkPlus size={13} aria-hidden="true" />
                {t("chat.verify.save")}
              </button>
              <span className="text-[12px] text-ink-secondary">{t("chat.verify.saveHint")}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
