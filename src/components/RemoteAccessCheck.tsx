import { useState } from "react";
import { Check, Circle, X } from "lucide-react";

import { desktopAppVersion } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import {
  diagnoseRemoteAccess,
  remoteAccessDiagnosisText,
  remoteAccessStepMark,
  type RemoteAccessDiagnosis,
  type RemoteAccessFacts,
} from "@/lib/remote-access-diagnosis";
import type { CompanionAccountState } from "../types/ogb";
import type { CompanionState } from "@/lib/companion-types";
import { SettingsFoldRow } from "./SettingsPrimitives";

const ICON = { ok: Check, failed: X, unchecked: Circle } as const;

export function remoteAccessFacts(account: CompanionAccountState | null, state: CompanionState | null, setupTimedOut = false, accountWanted = false): RemoteAccessFacts {
  return { account, companion: state, setupTimedOut, appVersion: desktopAppVersion(), accountWanted };
}

/** The steps, what to try, and Copy diagnostics: shown under a failure message and in Settings, never on its own. */
export function RemoteAccessSteps({ diagnosis, className }: { diagnosis: RemoteAccessDiagnosis; className?: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    const result = await copyText(remoteAccessDiagnosisText(diagnosis));
    if (result !== "empty") setCopied(result);
  };
  return (
    <div className={cn("flex flex-col gap-3 text-left", className)} data-remote-access-check="">
      <ol className="flex flex-col gap-2">
        {diagnosis.steps.map((step) => {
          const Icon = ICON[step.result];
          return (
            <li key={step.id} data-step={step.id} data-result={step.result} className="flex items-start gap-2.5">
              <Icon size={14} aria-hidden="true" className={cn("mt-[3px] shrink-0", step.result === "ok" ? "text-success" : step.result === "failed" ? "text-danger" : "text-ink-tertiary")} />
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] leading-[18px] text-ink">
                  {step.label}<span className="sr-only">{`: ${remoteAccessStepMark(step.result)}`}</span>
                </span>
                <span className="text-[12px] leading-4 text-ink-secondary">{step.reason}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {diagnosis.next.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium leading-4 text-ink-secondary">{t("remote.diagnosis.nextTitle")}</span>
          <ul className="flex list-disc flex-col gap-1 ps-4 text-[12px] leading-4 text-ink-secondary">
            {diagnosis.next.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="ui-button" data-copy-diagnostics="" onClick={() => void copy()}>{t("remote.diagnosis.copy")}</button>
        <span role="status" className="text-[12px] leading-4 text-ink-secondary">
          {copied === "copied" ? t("remote.diagnosis.copied") : copied === "failed" ? t("common.copyFailed") : t("remote.diagnosis.copyNote")}
        </span>
      </div>
    </div>
  );
}

/** Under the pairing screen's failure message: the same model as Settings, without a second headline. */
export function PairingFailureCheck({ account, state, setupTimedOut }: { account: CompanionAccountState | null; state: CompanionState | null; setupTimedOut: boolean }) {
  return <RemoteAccessSteps className="mt-4" diagnosis={diagnoseRemoteAccess(remoteAccessFacts(account, state, setupTimedOut, true))} />;
}

/** Settings → Devices: a closed row whose value is the headline; open, the steps. */
export function RemoteAccessCheckRow({ account, state }: { account: CompanionAccountState | null; state: CompanionState }) {
  const [open, setOpen] = useState(false);
  const diagnosis = diagnoseRemoteAccess(remoteAccessFacts(account, state));
  return (
    <SettingsFoldRow id="connection-check" title={t("remote.diagnosis.title")} open={open} onToggle={() => setOpen(!open)}
      subtitle={<span data-remote-access-headline="" className={cn(diagnosis.failed && "text-danger")}>{diagnosis.headline}</span>}>
      <div className="px-4 py-3"><RemoteAccessSteps diagnosis={diagnosis} /></div>
    </SettingsFoldRow>
  );
}
