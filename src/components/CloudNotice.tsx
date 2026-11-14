import { Cloud } from "lucide-react";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudNoticeKind } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { NoticeCard, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";

export const CLOUD_NOTICE_SIGN_IN_DISMISSED = "cloud-notice-sign-in-dismissed";

export const CLOUD_NOTICE_CARD: Record<CloudNoticeKind, { title: LocaleKey; hint: LocaleKey; action: LocaleKey; dismissed: string }> = {
  "sign-in-again": { title: "cloudNotice.signIn.title", hint: "cloudNotice.signIn.hint", action: "cloudAccount.signInAgain", dismissed: CLOUD_NOTICE_SIGN_IN_DISMISSED },
  removed: { title: "cloudNotice.removed.title", hint: "cloudNotice.removed.hint", action: "cloudAccount.signIn", dismissed: CLOUD_NOTICE_SIGN_IN_DISMISSED },
};

export function cloudNoticeStep(kind: CloudNoticeKind, bridge: CloudAccountBridge): Promise<CloudAccountState> {
  return kind === "sign-in-again" ? bridge.signInAgain() : bridge.begin();
}

export function CloudNoticeCard({ kind, busy = false, failed = false, onAction, onNotNow }: {
  kind: CloudNoticeKind; busy?: boolean; failed?: boolean; onAction: () => void; onNotNow: () => void;
}) {
  const card = CLOUD_NOTICE_CARD[kind];
  return <NoticeCard titleId="cloud-notice-title" notice={`cloud-notice-${kind}`} icon={Cloud} title={t(card.title)} onDismiss={onNotNow}>
    <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t(card.hint)}</p>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" disabled={busy} className={PRIMARY_BUTTON} onClick={onAction}>{t(card.action)}</button>
      <NotNowButton onClick={onNotNow} />
    </div>
    {failed && <p role="alert" className="mt-2 text-[12px] text-danger">{t("cloudAccount.actionFailed")}</p>}
  </NoticeCard>;
}
