import { Check, TriangleAlert } from "lucide-react";

import { AUTOMATION_FIX_LABEL, type Automation, type AutomationStatus } from "@/lib/automations";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import type { useAllAutomationActions } from "./app-actions";

/** A coloured dot for Working and Paused; a warning sign for Needs you; a quiet check for Done. */
export function StatusMark({ status, className }: { status: AutomationStatus; className?: string }) {
  if (status.state === "needs-you") return <TriangleAlert size={15} aria-hidden="true" className={cn("shrink-0 text-warning", className)} />;
  if (status.state === "done") return <Check size={14} aria-hidden="true" className={cn("shrink-0 text-ink-tertiary", className)} />;
  return <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-full", status.state === "working" ? "bg-success" : "bg-ink-tertiary/60", className)} />;
}

/** The one button that fixes what "Needs you" names. */
export function FixButton({ automation, status, actions, onEdit, className }: {
  automation: Automation;
  status: AutomationStatus;
  actions: ReturnType<typeof useAllAutomationActions>;
  onEdit: () => void;
  className?: string;
}) {
  const { dispatch } = useStore();
  if (status.state !== "needs-you" || !status.fix) return null;
  const fix = status.fix;
  const onClick = () => {
    if (fix === "answer" || fix === "sign-in") actions.openRun(automation, automation.runs.find((run) => run.status !== "queued"));
    else if (fix === "usage") dispatch({ type: "toggleAppSettings", open: true, section: "usage" });
    else if (fix === "edit") onEdit();
    else if (fix === "reconnect") dispatch({ type: "togglePlugins", open: true, surface: "apps" });
    else void actions.runNow(automation);
  };
  return (
    <button type="button" onClick={onClick} disabled={Boolean(actions.busy)} className={cn("shrink-0 rounded-lg bg-warning/15 px-2.5 py-1 text-[12px] font-medium text-warning hover:bg-warning/25 disabled:opacity-50", className)}>
      {t(AUTOMATION_FIX_LABEL[fix])}
    </button>
  );
}
