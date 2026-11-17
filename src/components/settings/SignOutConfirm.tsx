import { useState } from "react";
import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { SettingsDialog } from "./SettingsDialog";

/** "Sign out of MausBot?": the one confirm for every Sign out (the outer menu, Account, a browser's sign-out). It says
 * what keeps running, so a slip off Help never signs anyone out by itself. */
export function SignOutConfirm({ here, cloud, browser = false, onConfirm, onClose }: {
  /** the place this computer is called by on the rail */
  here: string;
  /** the person's Cloud, when they have one */
  cloud?: string | null;
  browser?: boolean;
  onConfirm: () => Promise<unknown> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const line = browser ? t("settings.signOut.browserLine", { place: here })
    : cloud ? t("settings.signOut.keepRunningBoth", { here, cloud }) : t("settings.signOut.keepRunning");
  return (
    <SettingsDialog title={t(browser ? "settings.signOut.browserTitle" : "settings.signOut.title", { app: productName() })} onClose={onClose}
      footer={<>
        <button type="button" className="ui-button ui-button-md rounded-full" data-autofocus="" onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" disabled={busy} data-sign-out-confirm="" className="ui-button ui-button-md rounded-full !bg-danger !text-danger-ink"
          onClick={() => { setBusy(true); setFailed(false); void Promise.resolve(onConfirm()).then(onClose, () => { setBusy(false); setFailed(true); }); }}>
          {t("settings.account.signOutShort")}
        </button>
      </>}>
      <p className="text-[13px] leading-[18px] text-ink-secondary">{line}</p>
      {failed && <p role="alert" className="text-[12px] leading-4 text-danger">{t("cloudAccount.actionFailed")}</p>}
    </SettingsDialog>
  );
}
