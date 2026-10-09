// This computer's card about My Cloud for someone with a plan (docs/cloud-pro.md,
// "This computer and My Cloud"): which card, if any, comes from the plan's one
// state→view function (lib/cloud-plan cloudNoticeKind):
// - a paid plan whose My Cloud is ready: the always-on bots are there, with
//   Open My Cloud, which opens it in this window;
// - a sign-in that ended, on a plan this computer last saw active: Sign in
//   again, to reach My Cloud;
// - a saved sign-in this computer could not read and removed: sign in,
//   claiming no plan (this computer can't tell).
// One message and one action each. Not now is kept per card in this
// computer's onboarding record. When it shows is the notice queue's
// (AppNotices), which only This computer's page has.
import { Cloud } from "lucide-react";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudNoticeKind } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { NoticeCard, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";

/** Not now on the My Cloud card, kept so it does not come back. */
export const CLOUD_NOTICE_DISMISSED = "cloud-notice-my-cloud-dismissed";
/** Not now on either sign-in card, kept the same way. Settings → OpenMausBot
 * Cloud still shows the state and its one action. */
export const CLOUD_NOTICE_SIGN_IN_DISMISSED = "cloud-notice-sign-in-dismissed";

export const CLOUD_NOTICE_CARD: Record<CloudNoticeKind, { title: LocaleKey; hint: LocaleKey; action: LocaleKey; dismissed: string }> = {
  "my-cloud": { title: "cloudNotice.myCloud.title", hint: "cloudNotice.myCloud.hint", action: "cloudHome.connect", dismissed: CLOUD_NOTICE_DISMISSED },
  "sign-in-again": { title: "cloudNotice.signIn.title", hint: "cloudNotice.signIn.hint", action: "cloudAccount.signInAgain", dismissed: CLOUD_NOTICE_SIGN_IN_DISMISSED },
  removed: { title: "cloudNotice.removed.title", hint: "cloudNotice.removed.hint", action: "cloudAccount.signIn", dismissed: CLOUD_NOTICE_SIGN_IN_DISMISSED },
};

/** What the card's one action asks of the desktop's Cloud account bridge. */
export function cloudNoticeStep(kind: CloudNoticeKind, bridge: CloudAccountBridge): Promise<CloudAccountState> {
  return kind === "my-cloud" ? bridge.connectHome() : kind === "sign-in-again" ? bridge.signInAgain() : bridge.begin();
}

export function CloudNoticeCard({ kind, busy = false, failed = false, onAction, onNotNow }: {
  kind: CloudNoticeKind; busy?: boolean; failed?: boolean; onAction: () => void; onNotNow: () => void;
}) {
  const card = CLOUD_NOTICE_CARD[kind];
  return <NoticeCard titleId="cloud-notice-title" notice={`cloud-notice-${kind}`} icon={Cloud} title={t(card.title)} onDismiss={onNotNow}>
    <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{t(card.hint)}</p>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" disabled={busy} className={PRIMARY_BUTTON} onClick={onAction}>{t(card.action)}</button>
      <NotNowButton onClick={onNotNow} />
    </div>
    {failed && <p role="alert" className="mt-2 text-[12px] text-danger">{t(kind === "my-cloud" ? "cloudNotice.openFailed" : "cloudAccount.actionFailed")}</p>}
  </NoticeCard>;
}
