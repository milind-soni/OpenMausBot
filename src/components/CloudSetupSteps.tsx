import type { CloudSetupStep } from "../../electron/cloud-home.mjs";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

const SETUP_STEPS = [
  ["reserving", "cloudHome.step.reserving"], ["storage", "cloudHome.step.storage"],
  ["starting", "cloudHome.step.starting"], ["checking", "cloudHome.step.checking"],
] as const satisfies ReadonlyArray<readonly [CloudSetupStep, LocaleKey]>;

/** The Admin's four setup steps, with the one it reports as current. */
export function CloudSetupSteps({ step }: { step: CloudSetupStep }) {
  const at = SETUP_STEPS.findIndex(([key]) => key === step);
  return <ol data-cloud-setup={step} className="flex flex-col gap-1 text-[13px]">
    {SETUP_STEPS.map(([key, label], index) => <li key={key} aria-current={index === at ? "step" : undefined}
      className={index === at ? "font-medium text-ink" : index < at ? "text-ink-secondary line-through decoration-ink-secondary/40" : "text-ink-secondary"}>{t(label)}</li>)}
  </ol>;
}
