// Shown instead of a chat when nothing on this machine can run a bot.
//
// The alternative — which is what used to happen — is a chat that looks
// completely functional until the first message, then fails with a raw spawn
// error. Every engine unavailable is a setup state, not an error state, so it
// gets a screen that says what to do rather than a bot that can't answer.
import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useStore } from "@/state/store";
import { EngineGroupLabel } from "@/components/EngineGroupLabel";
import { EngineSetup, installCommandFor } from "@/components/EngineSetup";
import { ProviderMark } from "@/components/ProviderIcons";
import { splitEngineRail } from "@/lib/engine-rail";

export function NoEngines() {
  const { state, refreshInstances } = useStore();
  const [rechecking, setRechecking] = useState(false);

  // Only things you actually install belong on a "get started" screen. The
  // Box cloud runner also reports unavailable here, but it's configured with
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

  const recheck = async () => {
    setRechecking(true);
    try {
      await refreshInstances();
    } finally {
      setRechecking(false);
    }
  };

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <div className="mx-auto w-full max-w-[560px] px-6 py-12">
        <h1 className="text-[20px] font-semibold text-ink">Install an AI engine to get started</h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-secondary">
          OpenMausBot doesn&rsquo;t ship a model of its own — your bots run on an AI CLI installed on
          this computer, using your existing login. Set up any one of these and your bots come alive.
        </p>

        <div className="mt-6 flex flex-col gap-2.5">
          {(() => {
            const { subscription, custom } = splitEngineRail(engines);
            const card = (instance: (typeof engines)[number]) => (
              <div key={instance.instanceId} className="rounded-xl border border-hairline/40 bg-card p-3.5">
                <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                  <ProviderMark driverKind={instance.driverKind} size={16} />
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
                {subscription.length > 0 && <EngineGroupLabel className="px-1">Cloud</EngineGroupLabel>}
                {subscription.map(card)}
                {custom.length > 0 && <EngineGroupLabel className="px-1 pt-1">Local</EngineGroupLabel>}
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
          {rechecking ? "Checking…" : "Check again"}
        </button>
      </div>
    </main>
  );
}
