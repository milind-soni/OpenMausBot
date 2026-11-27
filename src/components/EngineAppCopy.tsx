// An engine whose CLI runs the copy OpenMausBot installed: the person's terminal does not reach it, so it is
// finished here, never with a terminal step.
import { Check, KeyRound, X } from "lucide-react";
import { useStore, type InstanceInfo } from "@/state/store";
import { dismissAppCopySwitch, useAppCopySwitch } from "@/state/engine-install";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { RefreshEngines } from "./EngineLibrary";
import { keyForInstance } from "./keys/key-catalog";
import { openKeySettings } from "./keys/key-focus";

/** After an install pointed this engine at the app's own copy: says so on its card, Ready or not, until dismissed. */
export function AppCopyNotice({ instance, className }: { instance: InstanceInfo; className?: string }) {
  if (!useAppCopySwitch(instance.instanceId)) return null;
  return (
    <div data-app-copy-notice className={cn("flex items-start gap-2", className)}>
      <p role="status" className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink-secondary">
        {t("engineSetup.usingAppCopy", { name: instance.displayName })}
      </p>
      <button
        type="button"
        aria-label={t("engineSetup.usingAppCopyDismiss")}
        onClick={() => dismissAppCopySwitch(instance.instanceId)}
        className="shrink-0 rounded-md p-1 text-ink-tertiary hover:bg-control hover:text-ink"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Installed but not signed in. Only OpenCode ships such a build today, and its free models need no account. */
export function AppCopySetup({ instance, className, unframed }: { instance: InstanceInfo; className?: string; unframed: boolean }) {
  const { dispatch } = useStore();
  const remote = window.ogb?.remoteClient?.active === true;
  return (
    <div data-engine-setup-app-copy className={cn(!unframed && "rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
          <Check size={14} />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{t("engineSetup.appCopy.title", { name: instance.displayName })}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t(remote ? "engineSetup.appCopy.remote" : "engineSetup.appCopy.description", { name: instance.displayName })}
          </p>
        </div>
      </div>
      <AppCopyNotice instance={instance} className="mt-2" />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!remote && (
          <button
            type="button"
            onClick={() => dispatch(openKeySettings(keyForInstance(instance.instanceId)))}
            className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover"
          >
            <KeyRound size={13} aria-hidden="true" />
            {t("engineSetup.apiKey.open")}
          </button>
        )}
        <RefreshEngines key={instance.instanceId} />
      </div>
    </div>
  );
}
