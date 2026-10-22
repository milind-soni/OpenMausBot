import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import { EngineSetup } from "@/components/EngineSetup";
import { engineReady } from "@/components/EngineLibrary";
import { InstanceProviderMark } from "@/components/ProviderIcons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { engineDisplayName } from "@/lib/engine-name";
import { aiChoices, organisationSignIn, plainSignIn } from "@/lib/onboarding";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { OrganisationRow } from "./OrganisationRow";
import { PrimaryButton, staggerIndex, type BeatProps } from "./shared";

/** A local-model setup and a step finished in Terminal keep their own words; every other sign-in says the same plain line
 * instead of the setup's technical one. */
function setupFor(instance: InstanceInfo) {
  if (instance.access === "custom") return { intent: "inject" as const };
  return plainSignIn(instance)
    ? { intent: "cloud" as const, description: t("onboarding.engines.signInHint", { name: engineDisplayName(instance) }) }
    : { intent: "cloud" as const };
}

function OtherWay({ instance, open, onToggle }: { instance: InstanceInfo; open: boolean; onToggle: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-raised/40"
      >
        <span className="flex size-[18px] shrink-0 items-center justify-center">
          <InstanceProviderMark instance={instance} size={18} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{engineDisplayName(instance)}</span>
        <ChevronDown size={14} className={cn("shrink-0 text-ink-secondary transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && <EngineSetup instance={instance} {...setupFor(instance)} className="mx-3.5 mb-3.5 border-0 bg-inset" />}
    </div>
  );
}

/** Shown only when no AI works yet: the one recommended way to connect one, every other way folded under it. */
export function EnginesBeat({
  onNext,
  setMascot,
  bump,
  hosted = false,
  onOpenOrganisation,
}: BeatProps & {
  hosted?: boolean;
  onOpenOrganisation?: () => void;
}) {
  const { state, dispatch } = useStore();
  const organisation = organisationSignIn(window.ogb, { hosted });
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const latestRequest = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    setChecking(true);
    try {
      const d = await api("/api/instances", { signal: AbortSignal.timeout(10_000) });
      if (request !== latestRequest.current) return;
      dispatch({ type: "instances", instances: d.instances ?? [] });
      setFailed(false);
    } catch {
      if (request === latestRequest.current) setFailed(true);
    } finally {
      if (request === latestRequest.current) setChecking(false);
    }
  }, [dispatch]);

  useEffect(() => {
    void refresh();
    return () => {
      latestRequest.current++;
    };
  }, [refresh]);

  const connected = state.instances.find(engineReady);
  const { recommended, others } = aiChoices(state.instances.filter((instance) => instance.install && !engineReady(instance)));

  useEffect(() => {
    if (connected) {
      setMascot("proud");
      bump("success");
    } else setMascot("curious");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(connected)]);

  return (
    <div className="flex min-h-0 flex-col">
      <p className="animate-rise mt-1 text-[13.5px] text-ink-secondary">{t("onboarding.engines.intro")}</p>

      {connected ? (
        <p role="status" data-ai-connected className="animate-rise mt-4 flex items-center gap-2 text-[13px] text-success">
          <Check size={14} strokeWidth={2.5} aria-hidden="true" />
          {t("onboarding.engines.connected", { name: engineDisplayName(connected) })}
        </p>
      ) : recommended ? (
        <div data-ai-recommended={recommended.instanceId} className="animate-rise mt-4 rounded-xl border border-hairline/40 bg-card" style={staggerIndex(1)}>
          <div className="flex items-center gap-3 px-3.5 pt-3">
            <span className="flex size-[18px] shrink-0 items-center justify-center">
              <InstanceProviderMark instance={recommended} size={18} />
            </span>
            <span className="truncate text-[13.5px] font-medium text-ink">{engineDisplayName(recommended)}</span>
          </div>
          <EngineSetup instance={recommended} {...setupFor(recommended)} className="mx-3.5 mb-3.5 border-0 bg-transparent" />
        </div>
      ) : !failed ? (
        <p className="mt-4 text-[12.5px] text-ink-secondary" aria-live="polite">{t("common.checking")}</p>
      ) : null}
      {failed && <p role="alert" className="mt-2 text-[13px] text-danger">{t("onboarding.engines.error")}</p>}

      {(organisation || others.length > 0) && (
        <div className="animate-rise mt-3 min-h-0 overflow-y-auto rounded-xl border border-hairline/40 bg-card [scrollbar-width:thin]" style={staggerIndex(2)}>
          <button
            type="button"
            onClick={() => setMore((value) => !value)}
            aria-expanded={more}
            className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left text-[13px] text-ink-secondary transition-colors hover:bg-raised/40 hover:text-ink"
          >
            {t("onboarding.engines.otherWays")}
            <ChevronDown size={14} className={cn("shrink-0 transition-transform duration-200", more && "rotate-180")} />
          </button>
          {more && (
            <div className="divide-y divide-hairline/40 border-t border-hairline/40">
              {organisation && (
                <OrganisationRow
                  bridge={organisation}
                  onOpenSettings={() => (onOpenOrganisation ? onOpenOrganisation() : dispatch({ type: "toggleAppSettings", open: true, section: "organization" }))}
                  onConnected={() => void refresh()}
                />
              )}
              {others.map((instance) => (
                <OtherWay key={instance.instanceId} instance={instance} open={open === instance.instanceId}
                  onToggle={() => setOpen(open === instance.instanceId ? null : instance.instanceId)} />
              ))}
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={checking}
                className="flex w-full items-center gap-1.5 px-3.5 py-2.5 text-left text-[12px] text-ink-secondary transition-colors hover:bg-raised/40 hover:text-ink disabled:opacity-50"
              >
                <RefreshCw size={12} className={checking ? "animate-spin" : ""} />
                {checking ? t("common.checking") : t("common.checkAgain")}
              </button>
            </div>
          )}
        </div>
      )}

      <PrimaryButton onClick={onNext} className="mt-5">
        {t("onboarding.continue")}
      </PrimaryButton>
    </div>
  );
}
