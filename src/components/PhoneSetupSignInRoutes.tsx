import { Wifi } from "lucide-react";
import { t } from "@/lib/i18n";
import type { PhoneSetupController } from "./PhoneSetupFlow";

export function PhoneSetupSignInRoutes({ c }: { c: PhoneSetupController }) {
  return (
    <>
      <div className="my-4 flex items-center gap-3 text-[11px] text-ink-secondary">
        <span className="h-px flex-1 bg-hairline/40" /> {t("phone.signIn.or")} <span className="h-px flex-1 bg-hairline/40" />
      </div>
      <button
        disabled={c.busy || c.accountBusy}
        onClick={c.useLocal}
        className="flex items-center justify-center gap-2 rounded-lg border border-hairline/50 py-2.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
      >
        <Wifi size={15} /> {t("phone.signIn.wifiInstead")}
      </button>
      <p className="mt-2 text-center text-[11px] leading-relaxed text-ink-secondary">
        {t("phone.signIn.wifiNote")}
      </p>
      {c.tailscaleAvailable && (
        <button
          disabled={c.busy || c.accountBusy}
          onClick={c.useTailscale}
          className="mt-2 flex items-center justify-center gap-2 rounded-lg border border-hairline/50 py-2.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
        >
          {t("phone.signIn.tailscaleInstead")}
        </button>
      )}
      {c.tailscaleAvailable && (
        <p className="mt-2 text-center text-[11px] leading-relaxed text-ink-secondary">
          {t("phone.signIn.tailnetNote")}
        </p>
      )}
    </>
  );
}
