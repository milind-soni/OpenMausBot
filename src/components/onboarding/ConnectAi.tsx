import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, LoaderCircle, RefreshCw, X } from "lucide-react";
import { EngineSetup } from "@/components/EngineSetup";
import { engineReady } from "@/components/EngineLibrary";
import { InstanceProviderMark } from "@/components/ProviderIcons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { aiChoices, aiWorks, organisationSignIn, plainSignIn } from "@/lib/onboarding";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { freeFallback } from "../../../shared/ai-ranking";
import { OrganisationRow } from "./beats/OrganisationRow";
import type { WelcomeAiNow } from "./welcome-ai";

/** A local-model setup and a step finished in Terminal keep their own words; every other sign-in says the same plain line
 * instead of the setup's technical one. */
function setupFor(instance: InstanceInfo) {
  if (instance.access === "custom") return { intent: "inject" as const };
  return plainSignIn(instance)
    ? { intent: "cloud" as const, description: t("onboarding.engines.signInHint", { name: instance.displayName }) }
    : { intent: "cloud" as const };
}

function OtherWay({ instance, open, onToggle }: { instance: InstanceInfo; open: boolean; onToggle: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-offset-[-2px]"
      >
        <span className="flex size-[18px] shrink-0 items-center justify-center">
          <InstanceProviderMark instance={instance} size={18} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{instance.displayName}</span>
        <ChevronDown size={14} className={cn("shrink-0 text-ink-secondary transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && <EngineSetup instance={instance} {...setupFor(instance)} className="mx-4 mb-3.5 border-0 bg-inset" />}
    </div>
  );
}

/** Every way to connect an AI, until one has answered a test message (`tested`, from useWelcomeAi): the recommended
 * one's own setup first, then the organization and every other AI. One that didn't answer says why, with Check again;
 * OpenCode's free model is only ever a backup. */
export function ConnectAi({ hosted = false, tested }: { hosted?: boolean; tested: WelcomeAiNow | null }) {
  const { state, dispatch } = useStore();
  const organisation = organisationSignIn(window.ogb, { hosted });
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
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

  const connected = tested && aiWorks(tested) ? tested.instance : undefined;
  const backup = state.instances.find((instance) => engineReady(instance) && freeFallback(instance));
  const { recommended, others } = aiChoices(state.instances.filter((instance) => instance.install && !engineReady(instance)));

  return (
    <div className="flex w-full flex-col">
      {connected ? (
        <p role="status" data-ai-connected className="animate-rise flex items-center gap-2 text-[14px] text-success">
          <Check size={15} strokeWidth={2.5} aria-hidden="true" />
          {/* An AI with no way to send a test message keeps the line it always had. */}
          {t(tested?.state === "passed" ? "onboarding.engines.answered" : "onboarding.engines.connected", { name: connected.displayName })}
        </p>
      ) : tested?.state === "testing" ? (
        <p role="status" data-ai-checking className="animate-rise flex items-center gap-2 text-[14px] text-ink-secondary">
          <LoaderCircle size={15} aria-hidden="true" className="shrink-0 animate-spin" />
          {t("onboarding.engines.checkingAnswer", { name: tested.instance.displayName })}
        </p>
      ) : (
        <>
          {tested?.state === "failed" && (
            <div role="alert" data-ai-silent className="animate-rise mb-3 w-full rounded-2xl bg-warning/10 px-4 py-3 text-left text-[13px] leading-relaxed text-ink">
              {/* The check's own plain reason (signed out, a used-up limit…) when it gave one. */}
              <p data-ai-reason>{tested.error ?? t("onboarding.engines.noAnswer", { name: tested.instance.displayName })}</p>
              {tested.error && <p className="mt-1 text-ink-secondary">{t("onboarding.engines.orAnother")}</p>}
              <button
                type="button"
                onClick={tested.retry}
                className="-mx-2 mt-1.5 flex items-center gap-1.5 rounded-full px-2 py-1 text-[13px] font-medium text-ink transition-colors hover:bg-ink/[0.06]"
              >
                <RefreshCw size={12} aria-hidden="true" />
                {t("common.checkAgain")}
              </button>
            </div>
          )}
          {!tested && backup && (
            <p data-ai-backup className="animate-rise mb-3 text-[13px] text-ink-secondary">
              {t("onboarding.engines.freeBackup", { name: backup.displayName })}
            </p>
          )}
          {recommended ? (
            <div data-ai-recommended={recommended.instanceId} className="animate-rise w-full rounded-2xl bg-card p-4 text-left">
              <EngineSetup instance={recommended} {...setupFor(recommended)} className="border-0 bg-transparent p-0" />
            </div>
          ) : !tested && !backup && !failed ? (
            <p className="text-[13px] text-ink-secondary" aria-live="polite">{t("common.checking")}</p>
          ) : null}
        </>
      )}
      {failed && <p role="alert" className="mt-2 text-[13px] text-danger">{t("onboarding.engines.error")}</p>}

      {(organisation || others.length > 0) && (
        <div className="mt-3 w-full divide-y divide-hairline/40 overflow-hidden rounded-2xl bg-card text-left">
          {organisation && (
            <OrganisationRow
              bridge={organisation}
              onOpenSettings={() => dispatch({ type: "toggleAppSettings", open: true, section: "organization" })}
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
            className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-[12px] text-ink-secondary transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-offset-[-2px] disabled:opacity-50"
          >
            <RefreshCw size={12} className={checking ? "animate-spin" : ""} />
            {checking ? t("common.checking") : t("common.checkAgain")}
          </button>
        </div>
      )}
    </div>
  );
}

/** "Connect an AI": every way to connect one, over the first screen or the chat, until it is closed. */
export function ConnectAiDialog({ hosted = false, tested, onClose }: { hosted?: boolean; tested: WelcomeAiNow | null; onClose: () => void }) {
  return (
    <div
      className="ui-scrim fixed inset-0 z-[60] flex items-center justify-center p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-ai-title"
        data-connect-ai=""
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
        className="ui-modal animate-pop-in flex max-h-[min(640px,calc(100vh-32px))] w-[440px] max-w-full flex-col overflow-hidden text-left"
      >
        <div className="flex h-[52px] shrink-0 items-center justify-between pl-4 pr-3">
          <h2 id="connect-ai-title" className="text-[14px] font-semibold leading-[22px] text-ink">{t("onboarding.meet.connectAi")}</h2>
          <button type="button" autoFocus onClick={onClose} aria-label={t("common.close")} title={t("common.close")}
            className="flex size-7 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <div className="ui-modal-divider shrink-0" />
        <div className="min-h-0 overflow-y-auto p-4 [scrollbar-width:thin]">
          <ConnectAi hosted={hosted} tested={tested} />
        </div>
      </div>
    </div>
  );
}
