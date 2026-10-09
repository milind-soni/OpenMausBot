// Shown on an OMB Cloud home in place of a chat until one of the person's own
// engines is signed in (docs/cloud-pro.md; lib/onboarding cloudSignInDue).
// Cloud Pro includes no AI: the person brings a Claude, ChatGPT or Grok
// account, or an API key. A free trial's AI credit runs bots until then; once
// it is used up, this says so first. Each choice opens the setup that already
// exists for it: the paste-code Claude sign-in and the Codex and Grok device codes
// (EngineSetup, the card the model picker shows), or the model-provider keys
// in Settings → Connections. Grok is offered only where this Cloud computer
// has the Grok CLI. Once an engine can run, the chat takes this screen's place.
import { useState } from "react";
import { ArrowUpRight, ChevronDown, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { EngineSetup } from "@/components/EngineSetup";
import { ProviderMark } from "@/components/ProviderIcons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type InstanceInfo } from "@/state/store";

type Choice = "claude" | "codex" | "grok";
type ChoiceKind = "claudeAgent" | "codex" | "grokAgent";

/** The person's own engine of that kind: not a local-model or read-only one. */
export function cloudEngine(instances: readonly InstanceInfo[], driverKind: ChoiceKind): InstanceInfo | undefined {
  return instances.find((instance) => instance.driverKind === driverKind && instance.access !== "custom" && !instance.readOnly);
}

export function CloudEngineSignIn() {
  const { state, dispatch, refreshInstances } = useStore();
  const [open, setOpen] = useState<Choice | null>(null);
  const [checking, setChecking] = useState(false);
  const recheck = async () => {
    setChecking(true);
    try {
      await refreshInstances();
    } finally {
      setChecking(false);
    }
  };
  const choices: Array<{ id: Choice; driverKind: ChoiceKind; label: string; hint: string }> = [
    { id: "claude", driverKind: "claudeAgent", label: t("cloudSignIn.claude"), hint: t("cloudSignIn.claudeHint") },
    { id: "codex", driverKind: "codex", label: t("cloudSignIn.codex"), hint: t("cloudSignIn.codexHint") },
    // Grok Build needs its CLI on this Cloud computer; an older image has none.
    ...(cloudEngine(state.instances, "grokAgent")?.snapshot.state === "available"
      ? [{ id: "grok" as const, driverKind: "grokAgent" as const, label: t("cloudSignIn.grok"), hint: t("cloudSignIn.grokHint") }]
      : []),
  ];
  const row = "flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-raised/40";
  // Shown here because the trial's AI credit can no longer run a bot.
  const credit = state.instances.find((instance) => instance.trialCredit && instance.trialCredit !== "active")?.trialCredit;

  return (
    <main data-cloud-sign-in className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <div className="mx-auto w-full max-w-[560px] px-6 py-12">
        <h1 className="text-[20px] font-semibold text-ink">{t("cloudSignIn.title")}</h1>
        {credit && <p role="status" data-trial-credit={credit} className="mt-1.5 text-[13.5px] font-medium leading-relaxed text-ink">{t(credit === "used_up" ? "cloudSignIn.creditUsedUp" : "cloudSignIn.creditEnded")}</p>}
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-secondary">{t("cloudSignIn.intro")}</p>
        <p role="note" className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">{t("cloudSignIn.limits")}</p>

        <div className="mt-5 divide-y divide-hairline/40 rounded-xl border border-hairline/40 bg-card">
          {choices.map((choice) => {
            const instance = cloudEngine(state.instances, choice.driverKind);
            const expanded = open === choice.id;
            return (
              <div key={choice.id} data-cloud-choice={choice.id}>
                <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : choice.id)} className={row}>
                  <span className="flex size-[18px] shrink-0 items-center justify-center">
                    <ProviderMark driverKind={choice.driverKind} size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-medium text-ink">{choice.label}</span>
                    <span className="block text-[12px] text-ink-secondary">{choice.hint}</span>
                  </span>
                  <ChevronDown size={14} className={cn("shrink-0 text-ink-secondary transition-transform duration-200", expanded && "rotate-180")} />
                </button>
                {expanded && (instance
                  ? <EngineSetup instance={instance} className="mx-3.5 mb-3.5 border-0 bg-inset" />
                  : <p role="status" className="mx-3.5 mb-3.5 text-[12px] text-ink-secondary">{t("cloudSignIn.missing")}</p>)}
              </div>
            );
          })}
          <div data-cloud-choice="api-key">
            <button type="button" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })} className={row}>
              <span className="flex size-[18px] shrink-0 items-center justify-center text-ink-secondary">
                <KeyRound size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium text-ink">{t("cloudSignIn.apiKey")}</span>
                <span className="block text-[12px] text-ink-secondary">{t("cloudSignIn.apiKeyHint")}</span>
              </span>
              <ArrowUpRight size={14} className="shrink-0 text-ink-secondary" />
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void recheck()}
          disabled={checking}
          className="mt-6 flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-60"
        >
          {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {checking ? t("common.checking") : t("common.checkAgain")}
        </button>
      </div>
    </main>
  );
}
