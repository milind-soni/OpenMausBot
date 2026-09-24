// The connected Organisation panel's Company engines: whether each one can run
// on this computer, and one inline action for bots that cannot run at all.
// No dialog: nothing changes until the button is pressed, and it never moves a
// bot that works on a personal engine.
import { useState } from "react";
import { Check } from "lucide-react";
import { useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { companyInstanceFor, instanceCanRun, planCompanySwitch } from "@/lib/company-models";
import { EngineSetup, needsCli } from "./EngineSetup";

const providerNames: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter" };

export function CompanyModels({ providers }: { providers: ReadonlyArray<{ id: string; configured: boolean; models: readonly string[] }> }) {
  const { state, dispatch, flushBotPatches } = useStore();
  const [switching, setSwitching] = useState(false);
  const [done, setDone] = useState<{ name: string; bots: string[] } | null>(null);
  const plan = planCompanySwitch(state.bots, state.instances);
  const target = plan.target;
  const names = (bots: typeof plan.bots) => bots.map((bot) => bot.name).join(", ");

  const switchBots = async () => {
    if (!target || !plan.bots.length || switching) return;
    const bots = plan.bots, selection = { instanceId: target.instanceId, model: target.models.default };
    setSwitching(true); setDone(null);
    // The model chip's own path: PATCH /api/bots/:id with only the selection.
    for (const bot of bots) dispatch({ type: "setModel", botId: bot.id, selection });
    try {
      // Name only bots the server kept on the Company model. A refused PATCH
      // rolls its bot back (it is counted again) and shows the app's error.
      const settled = await Promise.all(bots.map((bot) => flushBotPatches(bot.id).catch(() => null)));
      const moved = bots.filter((_bot, index) => settled[index]?.modelSelection.instanceId === selection.instanceId);
      if (moved.length) setDone({ name: target.displayName, bots: moved.map((bot) => bot.name) });
    } finally {
      setSwitching(false);
    }
  };

  return <>
    <ul className="divide-y divide-hairline/40">{providers.map((provider) => <li key={provider.id} className="py-2 text-[13px]">
      <div className="flex flex-wrap justify-between gap-2">
        <span className="text-ink">{providerNames[provider.id] ?? provider.id}</span>
        <span className="text-ink-secondary">{provider.configured ? t("organization.modelCount", { count: provider.models.length }) : t("organization.notConfigured")}</span>
      </div>
      {provider.configured && provider.models.length > 0 &&
        <CompanyEngineReadiness instance={companyInstanceFor(state.instances, provider.id)} instances={state.instances} />}
    </li>)}</ul>
    {done && <p role="status" className="break-words text-[12px] text-ink-secondary">{t("organization.useCompanyDone", { name: done.name, names: done.bots.join(", ") })}</p>}
    {target && plan.bots.length > 0 && <div data-company-switch className="flex flex-col items-start gap-2 rounded-lg border border-hairline/40 p-3">
      <p className="break-words text-[13px] text-ink">{t("organization.useCompanyBots", { names: names(plan.bots) })}</p>
      <button type="button" className="ui-button" disabled={switching} onClick={() => void switchBots()}>
        {plan.bots.length === 1
          ? t("organization.useCompanyOne", { name: target.displayName })
          : t("organization.useCompanyMany", { name: target.displayName, count: plan.bots.length })}
      </button>
      <p className="text-[12px] leading-relaxed text-ink-secondary">{t("organization.useCompanyNote")}</p>
    </div>}
    {target && plan.needsAsk.length > 0 &&
      <p className="break-words text-[12px] text-ink-secondary">{t("organization.useCompanyElevated", { names: names(plan.needsAsk) })}</p>}
  </>;
}

/** Company Claude and Codex run the CLI installed on this computer with the
 * organisation's key, so a missing CLI reuses the personal engine's install
 * action, without its sign-in. OpenRouter needs nothing installed. */
function CompanyEngineReadiness({ instance, instances }: { instance: InstanceInfo | undefined; instances: readonly InstanceInfo[] }) {
  if (!instance) return null;
  if (instance.policy) return <p className="mt-1 text-[12px] text-ink-secondary">{instance.policy.reason}</p>;
  if (instanceCanRun(instance)) {
    return <p className="mt-1 flex items-center gap-1 text-[12px] text-ink-secondary"><Check size={12} className="text-success" aria-hidden="true" />{t("organization.engineReady")}</p>;
  }
  const local = instance.driverKind === "claudeAgent" || instance.driverKind === "codex"
    ? instances.find((candidate) => candidate.driverKind === instance.driverKind && !candidate.readOnly && candidate.install)
    : undefined;
  if (local && needsCli(local)) {
    return <EngineSetup instance={local} intent="inject" className="mt-2"
      description={t("organization.engineInstallHelp", { engine: local.displayName })} />;
  }
  return <p className="mt-1 text-[12px] text-ink-secondary">{instance.snapshot.reason ?? t("organization.engineUnavailable")}</p>;
}
