import { AppWindow, Bot as BotIcon, Cloud, Smartphone, Sparkles, type LucideIcon } from "lucide-react";

import { t } from "@/lib/i18n";
import { setupSteps, type SetupStep } from "@/lib/default-bot";
import { phonePairingSettingsAction } from "@/lib/phone-pairing";
import type { LocaleKey } from "@/locales";
import { useStore, type Action } from "@/state/store";
import { engineReady } from "./EngineLibrary";

const STEPS: Record<SetupStep, { label: LocaleKey; icon: LucideIcon }> = {
  ai: { label: "helperIntro.step.ai", icon: Sparkles },
  bots: { label: "helperIntro.step.bots", icon: BotIcon },
  apps: { label: "helperIntro.step.apps", icon: AppWindow },
  phone: { label: "helperIntro.step.phone", icon: Smartphone },
  cloud: { label: "helperIntro.step.cloud", icon: Cloud },
};

/** Each step opens the app's own flow for it. */
export function setupAction(step: SetupStep): Action {
  switch (step) {
    case "ai": return { type: "toggleAppSettings", open: true, section: "engines" };
    case "bots": return { type: "toggleNewBot", open: true };
    case "apps": return { type: "togglePlugins", open: true, surface: "apps" };
    case "phone": return phonePairingSettingsAction();
    case "cloud": return { type: "openCloudAdd", source: "app_onboarding" };
  }
}

/** What is left to set up, under MausBot's intro on a new install. */
export function HelperSetup() {
  const { state, dispatch } = useStore();
  const steps = setupSteps({
    aiReady: state.instances.some(engineReady),
    ownBots: state.bots.filter((bot) => !bot.hidden && !bot.defaultBot).length,
    onCloud: state.config?.cloudHome === true,
    team: Boolean(state.config?.team),
    remote: typeof window !== "undefined" && window.ogb?.remoteClient?.active === true,
  });
  if (!steps.length) return null;
  return (
    <div role="group" aria-label={t("helperIntro.setup")} data-helper-setup="" className="flex max-w-full flex-col items-start gap-1.5">
      <span className="text-[12.5px] text-ink-secondary">{t("helperIntro.setup")}</span>
      <div className="flex flex-wrap gap-1.5">
        {steps.map((step) => {
          const { label, icon: Icon } = STEPS[step];
          return (
            <button key={step} type="button" data-helper-step={step} onClick={() => dispatch(setupAction(step))}
              className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-accent/20">
              <Icon size={14} aria-hidden="true" className="text-accent" />{t(label)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
