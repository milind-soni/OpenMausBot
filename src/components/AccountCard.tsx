import { useAccountSession, type AccountSession } from "@/lib/use-account-session";
import { t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

/** Settings → General: who is signed in on this browser, and a way out.
 * Only a signed-in session has one; the owner's own machine does not. */
export function AccountCard() {
  return <AccountCardView {...useAccountSession()} />;
}

export function AccountCardView({ session, busy, failed, onSignOut }: { session: AccountSession | null; busy: boolean; failed: boolean; onSignOut: () => void }) {
  if (session?.kind !== "session") return null;
  return (
    <Card title={t("settings.account.title")} subtitle={t("settings.account.subtitle")}>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[13.5px] text-ink" data-testid="signed-in-as">
          {session.email ? t("settings.account.signedInAs", { email: session.email }) : session.label}
        </span>
        <button type="button" className="ui-button shrink-0" disabled={busy} onClick={onSignOut}>
          {busy ? t("settings.account.signingOut") : t("settings.account.signOut")}
        </button>
      </div>
      {failed ? <p role="alert" className="mt-2 text-[13px] text-danger">{t("settings.account.signOutError")}</p> : null}
    </Card>
  );
}
