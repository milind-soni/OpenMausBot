// The one place the desktop app's one-time notices appear (src/lib/notices.ts):
// the Pro plans card, then "Star us on GitHub". At most one on screen, at most
// one per launch, never over setup, a dialog, busy work or an update, and only
// in the desktop app itself: never in a browser, on a remote page or to a
// Cloud guest (useCloudPlan is null there).
import { useState } from "react";
import { Star } from "lucide-react";
import { api, CLOUD_LINK_SETTINGS, useStore } from "@/state/store";
import { APP_REPOSITORY } from "@/lib/app-links";
import { buyOfferAllowed } from "@/lib/cloud-plan";
import { emailGateDone } from "@/lib/analytics";
import { currentStep } from "@/lib/guided-tour";
import { dismissNotice, nextNotice, noticeSeen, PRO_NOTICE, STAR_NOTICE, usedBefore } from "@/lib/notices";
import { welcomeDue } from "@/lib/onboarding";
import { useUpdaterState } from "@/lib/updater";
import { t } from "@/lib/i18n";
import { LinkButton, NoticeCard, NotNowButton } from "./NoticeCard";
import { ProIntroductionCard, useCloudPlan } from "./ProIntroduction";

function StarCard({ onDismiss }: { onDismiss: () => void }) {
  return <NoticeCard titleId="github-star-title" icon={Star} title={t("star.title")} onDismiss={onDismiss}>
    <p className="mb-3 mt-1 text-[12.5px] text-ink-secondary">{t("star.body")}</p>
    <div className="flex flex-wrap items-center gap-3">
      <LinkButton url={APP_REPOSITORY} label={t("star.button")} onOpened={onDismiss} />
      <NotNowButton onClick={onDismiss} />
    </div>
  </NoticeCard>;
}

export function AppNotices({ quiet = false }: { quiet?: boolean }) {
  const { state, dispatch } = useStore();
  const view = useCloudPlan();
  const updater = useUpdaterState();
  // Closing a notice (or Sign in, which only hides the Pro card for now)
  // leaves the next one for another launch.
  const [closed, setClosed] = useState(false);
  const record = state.config?.onboarding;
  const busy = state.bots.some(bot => bot.busy || bot.tasks?.some(task => task.busy))
    || state.groups.some(group => group.working || group.busyBotId);
  const setup = state.welcomeOpen || state.tourOpen || (Boolean(record?.completedAt) && currentStep(record) !== null)
    || welcomeDue(state.config, { remoteClient: false, legacyDone: emailGateDone() });
  if (!view || closed || !state.connected || !state.config || setup || busy || quiet
    || state.appSettingsOpen || state.settingsOpen || state.newBotOpen || state.pluginsOpen || state.triggersOpen || state.shortcutsOpen
    || (updater && !["idle", "checking"].includes(updater.status))) return null;

  const notice = nextNotice({
    // Never to anyone who pays or may pay; unknown until the plan check answers.
    [PRO_NOTICE]: view.kind === "unknown" || view.kind === "connecting" ? null : buyOfferAllowed(view),
    [STAR_NOTICE]: usedBefore(state.bots),
  }, id => noticeSeen(record, id));
  if (!notice) return null;

  const dismiss = () => {
    setClosed(true);
    const patch = dismissNotice(record, notice);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then(config => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  if (notice === STAR_NOTICE) return <StarCard onDismiss={dismiss} />;
  return <ProIntroductionCard onDismiss={dismiss} onSignIn={view.kind === "signed-out" ? () => { setClosed(true); dispatch(CLOUD_LINK_SETTINGS); } : undefined} />;
}
