import { useId, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronRight, CircleAlert, Copy, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import type { Device } from "@/lib/devices";
import { t } from "@/lib/i18n";
import { planUpdateAll, progressText, rowFor, useUpdateAll, type UpdateAllLine, type UpdateAllPlan } from "@/lib/update-all";
import { ConfirmDialog } from "../ConfirmDialog";

/** A command to run on a skipped machine, with its copy button; spans only, as it sits inside the dialog's text. */
function CommandLine({ command }: { command: string }) {
  const { state, copy } = useCopyFeedback(command);
  return (
    <span className="flex min-w-0 items-start gap-2 rounded-lg bg-ink/[0.05] py-1 ps-3 pe-1">
      <code data-update-all-command="" className="min-w-0 flex-1 select-text py-1.5 font-mono text-[12px] leading-4 text-ink [overflow-wrap:anywhere]">{command}</code>
      <button type="button" onClick={copy} aria-label={state === "failed" ? t("common.copyFailed") : t("devicesPage.addFlow.copyCommand")} title={t("devicesPage.addFlow.copyCommand")} className="ui-icon-button shrink-0">
        {state === "copied" ? <Check size={14} aria-hidden="true" className="text-success" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </span>
  );
}

function MachineTable({ lines }: { lines: readonly UpdateAllLine[] }) {
  const head = "pb-1 text-[12px] leading-4 text-ink-tertiary";
  return (
    <span role="table" aria-label={t("devicesPage.updateAll.tableLabel")} data-update-all-table=""
      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-3 rounded-lg bg-ink/[0.04] px-3 py-2 text-[13px] leading-[18px]">
      <span role="row" className="contents">
        <span role="columnheader" className={head}>{t("devicesPage.updateAll.machine")}</span>
        <span role="columnheader" className={head}>{t("devicesPage.updateAll.whatUpdates")}</span>
      </span>
      {lines.map((line) => (
        <span key={line.deviceId} role="row" data-update-all-row={line.deviceId} className="contents">
          <span role="cell" className="break-words py-1 font-medium text-ink">{line.name}</span>
          <span role="cell" className="break-words py-1 text-ink-secondary">{line.text}</span>
        </span>
      ))}
    </span>
  );
}

function SkippedList({ lines }: { lines: readonly UpdateAllLine[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (lines.length === 0) return null;
  return (
    <span className="flex flex-col gap-2">
      <button type="button" aria-expanded={open} aria-controls={id} data-update-all-skipped={open ? "open" : "closed"} onClick={() => setOpen((now) => !now)}
        className="settings-quiet flex cursor-pointer items-center gap-1 self-start">
        <ChevronRight size={14} aria-hidden="true" className={cn("shrink-0 transition-transform duration-150 motion-reduce:transition-none rtl:-scale-x-100", open && "rotate-90")} />
        {t("devicesPage.updateAll.skipped", { count: lines.length })}
      </button>
      <span id={id} role="list" hidden={!open} className="flex flex-col gap-2 ps-[18px]">
        {lines.map((line) => (
          <span key={line.deviceId} role="listitem" data-update-all-skip={line.deviceId} className="flex flex-col gap-1">
            <span>
              <span className="font-medium text-ink">{line.name}</span>
              <span aria-hidden="true" className="text-ink-tertiary">{" · "}</span>
              {line.text}
            </span>
            {line.command && <CommandLine command={line.command} />}
          </span>
        ))}
      </span>
    </span>
  );
}

/** The one confirm before Update all: each machine and what updates on it, this app last, the skipped ones folded. */
export function UpdateAllDialog({ open, plan, checking, onCancel, onConfirm }: {
  open: boolean; plan: UpdateAllPlan; checking: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const count = plan.updating.length;
  const busy = plan.activeTurns > 0 ? t(plan.activeTurns === 1 ? "serverUpdate.confirmBusy.one" : "serverUpdate.confirmBusy.other", { count: plan.activeTurns }) : "";
  return (
    <ConfirmDialog open={open} tone="neutral" icon={<RefreshCw size={18} />} confirmDisabled={checking || count === 0}
      title={count === 0 && !checking ? t("devicesPage.updateAll.nothing") : t(count === 1 ? "devicesPage.updateAll.title.one" : "devicesPage.updateAll.title.other", { count })}
      confirmLabel={checking ? t("common.checking") : t("devicesPage.updateAll.confirm")} onCancel={onCancel} onConfirm={onConfirm}
      body={<span data-update-all-dialog="" className="flex flex-col gap-3">
        <span>{[t("devicesPage.updateAll.body"), busy].filter(Boolean).join(" ")}</span>
        <MachineTable lines={plan.updating} />
        <SkippedList lines={plan.skipped} />
      </span>} />
  );
}

/** A device's Update all state, under its row: what is happening, then a failure's reason with Try again. */
export function UpdateProgress({ name, phase, text, tone, busy, onRetry }: {
  name: string; phase: string; text: string; tone?: "danger"; busy: boolean; onRetry: () => void;
}) {
  const failed = phase === "failed";
  return (
    <div data-update-all-state={phase} className="-mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 ps-[60px] pe-4 pb-3 text-[13px] leading-[18px]">
      <span role="status" className="flex min-w-0 items-start gap-1.5">
        <span className="flex h-[18px] w-3.5 shrink-0 items-center">
          {busy ? <Loader2 size={14} aria-hidden="true" className="text-ink-tertiary motion-safe:animate-spin" />
            : failed ? <CircleAlert size={14} aria-hidden="true" className="text-danger" />
            : phase === "done" ? <Check size={14} aria-hidden="true" className="text-success" /> : null}
        </span>
        <span className={cn("min-w-0 break-words", tone === "danger" ? "text-danger" : "text-ink-secondary")}>{text}</span>
      </span>
      {failed && <button type="button" data-update-all-retry="" onClick={onRetry} aria-label={`${t("common.tryAgain")}: ${name}`} className="ui-button ui-button-sm shrink-0">{t("common.tryAgain")}</button>}
    </div>
  );
}

/**
 * Update all on This computer's Devices page: the header button (only while something would update and no run is
 * going), its dialog, and each device's state during and after the run.
 */
export function useUpdateAllOnPage({ enabled, devices, olderPhones }: { enabled: boolean; devices: readonly Device[]; olderPhones: readonly string[] }) {
  const savedIds = devices.flatMap((device) => device.sources.flatMap((source) => (source.type === "place" ? [source.id] : []))).sort().join(",");
  const update = useUpdateAll(enabled, savedIds);
  const { survey, view, app, appMessage, checking, look, start, retry } = update;
  const [asking, setAsking] = useState(false);
  const plan = useMemo(() => planUpdateAll({ devices, servers: survey?.servers ?? null, app, olderPhones }), [devices, survey, app, olderPhones]);
  const shown = update.available && plan.updating.length > 0 && !view?.running;
  const button = useMemo(() => (shown
    ? <button type="button" data-update-all="" onClick={() => { setAsking(true); void look(true); }} className="ui-button ui-button-sm shrink-0">{t("devicesPage.updateAll.button")}</button>
    : null), [shown, look]);
  const dialog = update.available ? <UpdateAllDialog open={asking} plan={plan} checking={checking} onCancel={() => setAsking(false)}
    onConfirm={() => { setAsking(false); void start(plan.serverIds, plan.withApp); }} /> : null;
  const progress = (device: Device): ReactNode => {
    const found = rowFor(view, device);
    if (!found) return null;
    const state = progressText(found.row, Date.now(), found.id === "app" ? appMessage : undefined);
    return <UpdateProgress name={device.name} phase={found.row.phase} {...state} onRetry={() => void retry(found.id)} />;
  };
  return { button, dialog, progress };
}
