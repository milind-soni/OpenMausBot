// Shown instead of a chat when nothing on this machine can run a bot.
//
// The alternative — which is what used to happen — is a chat that looks
// completely functional until the first message, then fails with a raw spawn
// error. Every engine unavailable is a setup state, not an error state, so it
// gets a screen that says what to do rather than a bot that can't answer.
import { ArrowUpRight, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useStore } from "@/state/store";
import { EngineGroupLabel } from "@/components/EngineGroupLabel";
import { EngineSetup, installCommandFor } from "@/components/EngineSetup";
import { InstanceProviderMark } from "@/components/ProviderIcons";
import { splitEngineRail } from "@/lib/engine-rail";
import { t } from "@/lib/i18n";
import { brand } from "../lib/brand";

export function NoEngines() {
  const { state, dispatch, refreshInstances } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const [rechecking, setRechecking] = useState(false);
  const recheck = async () => {
    setRechecking(true);
    try {
      await refreshInstances();
    } finally {
      setRechecking(false);
    }
  };

  if (remoteClient) {
    return (
      <main className="flex h-full min-w-0 flex-1 items-center justify-center bg-app px-6">
        <div className="max-w-[520px] rounded-2xl border border-hairline/40 bg-card p-6 text-center">
          <h1 className="text-[20px] font-semibold text-ink">{t("noEngines.hostNeedsEngine")}</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-secondary">
            {t("noEngines.hostConfigure")}
          </p>
          <button onClick={() => void recheck()} disabled={rechecking} className="mt-5 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-60">
            {rechecking ? t("common.checking") : t("common.checkAgain")}
          </button>
        </div>
      </main>
    );
  }

  // Only things you actually install belong on a "get started" screen. The
  // Boat cloud runner also reports unavailable here, but it's configured with
  // a token in settings rather than installed, so listing it would just be a
  // dead end alongside the real options.
  const engines = state.instances
    .filter((i) => i.install)
    // An engine with a command for this platform is one the user can act on
    // right now; the rest (GUI downloads, POSIX-only installers on Windows)
    // sort below so the actionable path is the obvious one.
    .sort((a, b) => {
      const aCmd = installCommandFor(a.install) ? 0 : 1;
      const bCmd = installCommandFor(b.install) ? 0 : 1;
      return aCmd - bCmd;
    });

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <div className="mx-auto w-full max-w-[560px] px-6 py-12">
        <h1 className="text-[20px] font-semibold text-ink">{t("noEngines.title")}</h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-secondary">
          {t("noEngines.intro", { app: brand().name })}
        </p>

        <div className="mt-6 flex flex-col gap-2.5">
          {(() => {
            const { subscription, api, custom } = splitEngineRail(engines);
            const card = (instance: (typeof engines)[number]) => (
              <div key={instance.instanceId} className="rounded-xl border border-hairline/40 bg-card p-3.5">
                <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                  <InstanceProviderMark instance={instance} size={16} />
                  {instance.displayName}
                </div>
                <EngineSetup
                  instance={instance}
                  intent={instance.access === "custom" ? "inject" : "cloud"}
                  className="mt-0.5"
                />
              </div>
            );
            return (
              <>
                {subscription.length > 0 && <EngineGroupLabel className="px-1">{t("engines.cloud")}</EngineGroupLabel>}
                {subscription.map(card)}
                {/* One way in for every pasted-key provider, not a card each:
                    they all finish in the same place. */}
                {api.length > 0 && window.ogb?.remoteClient?.active !== true && (
                  <button
                    type="button"
                    data-no-engines-api-keys
                    onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}
                    className="flex items-center gap-3 rounded-xl border border-hairline/40 bg-card p-3.5 text-left hover:bg-control/40"
                  >
                    <KeyRound size={16} className="shrink-0 text-ink-secondary" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-medium text-ink">{t("cloudSignIn.apiKey")}</span>
                      <span className="block text-[12px] text-ink-secondary">{t("cloudSignIn.apiKeyHint")}</span>
                    </span>
                    <ArrowUpRight size={14} className="shrink-0 text-ink-secondary" />
                  </button>
                )}
                {custom.length > 0 && <EngineGroupLabel className="px-1 pt-1">{t("engines.local")}</EngineGroupLabel>}
                {custom.map(card)}
              </>
            );
          })()}
        </div>

        <button
          onClick={recheck}
          disabled={rechecking}
          className="mt-6 flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-60"
        >
          {rechecking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {rechecking ? t("common.checking") : t("common.checkAgain")}
        </button>
      </div>
    </main>
  );
}
