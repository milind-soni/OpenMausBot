import { useEffect, useRef, useState, type Ref } from "react";
import { Check, ChevronDown, CircleAlert, FolderOpen, Plug } from "lucide-react";
import { cloudEngine, cloudEngineChoices, useCloudEngineChoices } from "@/components/CloudEngineSignIn";
import { useCloudPlanSnapshot } from "@/components/CloudTrialNotice";
import { engineReady } from "@/components/EngineLibrary";
import { EngineCheckLine } from "@/components/EngineLiveCheck";
import { EngineSetup } from "@/components/EngineSetup";
import { usd } from "@/lib/cloud-plan";
import { welcomeCredit } from "@/lib/cloud-welcome";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { plainSignIn } from "@/lib/onboarding";
import { useStore, type Bot } from "@/state/store";
import { CARD, CARD_IDLE, CardIcon, Footer, PRIMARY, QUIET, SECONDARY, StepHeading } from "./parts";

/** Connecting an AI: an AI that already works when the step opens (one signed in here, or the plan's credit) is used as
 * it is and the step finishes itself; otherwise one recommended sign-in, every other way folded under it. */
export function WelcomeEngine({ name, headingRef, onFinish }: { name: string; headingRef: Ref<HTMLHeadingElement>; onFinish: () => void }) {
  const engines = useCloudEngineChoices();
  const plan = useCloudPlanSnapshot(window.ogb?.cloudPlan);
  const own = engines.instances.some((instance) => !instance.trialCredit && engineReady(instance));
  const credit = own ? null : welcomeCredit(engines.instances, plan);
  const readyOnOpen = useRef(own || credit?.state === "active");
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (readyOnOpen.current) onFinish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (readyOnOpen.current) return null;
  const claude = cloudEngine(engines.instances, "claudeAgent");
  const claudeCheck = claude && engines.live.checks[claude.instanceId];
  const others = { ...engines, choices: engines.choices.filter((choice) => choice.id !== "claude") };
  return <section aria-labelledby="cloud-welcome-step" data-welcome-step="engine" className="flex flex-col">
    <StepHeading headingRef={headingRef} title={t("cloudSetup.engine.title")} sub={t("cloudWelcome.engine.sub", { name })} />
    {credit?.state === "active" && <p role="status" data-welcome-credit className="mt-5 flex items-start gap-2.5 rounded-xl bg-success/12 px-3.5 py-3 text-[13px] leading-relaxed text-ink">
      <Check size={16} strokeWidth={2.5} aria-hidden="true" className="mt-px shrink-0 text-success" />
      <span>{credit.left !== null ? t("cloudWelcome.engine.credit", { amount: usd(credit.left) }) : t("cloudWelcome.engine.creditPlain")}</span>
    </p>}
    {credit && credit.state !== "active" && <p role="status" data-welcome-credit={credit.state} className="mt-5 flex items-start gap-2.5 rounded-xl bg-warning/10 px-3.5 py-3 text-[13px] leading-relaxed text-ink">
      <CircleAlert size={16} aria-hidden="true" className="mt-px shrink-0 text-warning" />
      <span>{t(credit.state === "used_up" ? "cloudSignIn.creditUsedUp" : "cloudSignIn.creditEnded")}</span>
    </p>}
    {claude && <div data-welcome-recommended={claude.instanceId} className="mt-6 rounded-2xl border border-hairline/50 bg-card px-4 py-4">
      {engineReady(claude)
        ? claudeCheck && <EngineCheckLine name={claude.displayName} check={claudeCheck} onRetry={() => void engines.live.run(claude.instanceId)} />
        : <EngineSetup instance={claude} unframed description={plainSignIn(claude) ? t("onboarding.engines.signInHint", { name: claude.displayName }) : undefined} />}
    </div>}
    <button type="button" data-welcome-other-ways aria-expanded={more} onClick={() => setMore((value) => !value)}
      className="mt-4 flex items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-[13px] font-medium text-ink-secondary transition-colors hover:text-ink motion-reduce:transition-none">
      {t("onboarding.engines.otherWays")}
      <ChevronDown size={14} aria-hidden="true" className={cn("transition-transform duration-200 motion-reduce:transition-none", more && "rotate-180")} />
    </button>
    {more && cloudEngineChoices(others, { columns: others.choices.length === 1 ? "grid-cols-1" : "grid-cols-1 @sm/step:grid-cols-2" })}
    <Footer className="mt-7">
      {own
        ? <button type="button" className={PRIMARY} onClick={onFinish}>{t("onboarding.continue")}</button>
        : credit?.state === "active"
          ? <button type="button" className={PRIMARY} onClick={onFinish}>{t("cloudWelcome.engine.useCredit")}</button>
          : <button type="button" className={QUIET} onClick={onFinish}>{t("cloudIntent.skip")}</button>}
    </Footer>
  </section>;
}

/** "folders": from a browser, the desktop app shares them; in the app on a Cloud page, this computer's app does; on My Cloud
 * once it is home, its own Settings say what the person's computer shares. */
export function WelcomeFiles({ name, headingRef, onFinish }: { name: string; headingRef: Ref<HTMLHeadingElement>; onFinish: () => void }) {
  const { dispatch } = useStore();
  const lending = window.ogb?.cloudLending;
  const home = useCloudPlanSnapshot(window.ogb?.cloudPlan)?.home === true;
  const card = (id: string, icon: typeof Plug, title: string, body: string, action?: { label: string; run: () => void }) =>
    <div data-welcome-files={id} className={cn(CARD, CARD_IDLE)}>
      <CardIcon icon={icon} />
      <span className="text-[15px] font-semibold text-ink">{title}</span>
      <span className="text-[13px] leading-relaxed text-ink-secondary">{body}</span>
      {action && <span className="mt-1"><button type="button" className={SECONDARY} onClick={action.run}>{action.label}</button></span>}
    </div>;
  return <section aria-labelledby="cloud-welcome-step" data-welcome-step="files" className="flex flex-col gap-5">
    <StepHeading headingRef={headingRef} title={t("cloudWelcome.files.title")} aside={t("cloudWelcome.files.optional")} sub={t("cloudWelcome.files.sub")} />
    <div className="grid gap-3 @lg/step:grid-cols-2">
      {card("folders", FolderOpen, t("cloudWelcome.files.folders"),
        t(!lending ? "cloudWelcome.files.foldersDesktop" : home ? "cloudWelcome.files.foldersHome" : "cloudWelcome.files.foldersHint", { name }),
        lending ? { label: t(home ? "cloudWelcome.files.foldersHomeAction" : "cloudWelcome.files.foldersAction"), run: () => void lending.open().catch(() => {}) } : undefined)}
      {card("apps", Plug, t("cloudWelcome.files.apps"), t("cloudWelcome.files.appsHint"),
        { label: t("cloudWelcome.files.appsAction"), run: () => dispatch({ type: "togglePlugins", open: true, surface: "apps" }) })}
    </div>
    <Footer>
      <button type="button" className={PRIMARY} onClick={onFinish}>{t("cloudWelcome.files.finish")}</button>
      <button type="button" className={QUIET} onClick={onFinish}>{t("cloudIntent.skip")}</button>
    </Footer>
  </section>;
}

export function WelcomeDone({ name, bot, headingRef, onSayHi, onJob }: {
  name: string; bot: Bot | null; headingRef: Ref<HTMLHeadingElement>; onSayHi: () => void; onJob: () => void;
}) {
  return <section aria-labelledby="cloud-welcome-step" data-welcome-step="done" className="flex flex-col items-start gap-4">
    <span aria-hidden="true" className="check-in flex size-[42px] items-center justify-center rounded-full bg-success">
      <Check size={22} strokeWidth={2.5} />
    </span>
    <StepHeading headingRef={headingRef} title={t("cloudWelcome.done.title", { name })} sub={t("cloudWelcome.done.body")} />
    <Footer>
      <button type="button" className={PRIMARY} onClick={onSayHi}>
        {bot?.chiefOfStaff || !bot ? t("cloudWelcome.done.chief") : t("cloudWelcome.done.bot", { name: bot.name })}
      </button>
      {bot && <button type="button" className={SECONDARY} onClick={onJob}>{t("cloudSetup.job.action")}</button>}
    </Footer>
  </section>;
}
