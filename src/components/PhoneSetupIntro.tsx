import { Check, ShieldCheck, Smartphone } from "lucide-react";
import { t } from "@/lib/i18n";
import { productName } from "../lib/brand";
import type { PhoneSetupController } from "./PhoneSetupFlow";

function ValuePoints() {
  const points: Array<{ Icon: typeof Smartphone; title: string; detail: string }> = [
    { Icon: Smartphone, title: t("phone.value.chats"), detail: t("phone.value.chatsDetail") },
    { Icon: Check, title: t("phone.value.approvals"), detail: t("phone.value.approvalsDetail") },
    { Icon: ShieldCheck, title: t("phone.value.private"), detail: t("phone.value.privateDetail") },
  ];
  return (
    <div className="mt-5 grid w-full gap-2 sm:grid-cols-3">
      {points.map(({ Icon, title, detail }) => (
        <div key={title} className="rounded-xl bg-inset px-3 py-3 text-left">
          <Icon size={16} className="text-accent" />
          <div className="mt-2 text-[13px] font-medium text-ink">{title}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{detail}</div>
        </div>
      ))}
    </div>
  );
}

export function PhoneSetupIntro({ controller: c }: { controller: PhoneSetupController }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-accent/12 text-accent">
        <Smartphone size={26} />
      </div>
      <h2 className="mt-4 text-[19px] font-semibold text-ink">{t("phone.intro.title", { app: productName() })}</h2>
      <p className="mt-1.5 max-w-[460px] text-[14px] leading-relaxed text-ink-secondary">
        {t("phone.intro.detail")}
      </p>
      <ValuePoints />
      <button
        data-phone-pairing-action
        onClick={c.start}
        disabled={!c.state || c.busy || c.accountBusy}
        className="mt-5 w-full max-w-[320px] rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-40"
      >
        {c.state?.devices.length ? t("phone.intro.pairAnother") : t("phone.intro.pair")}
      </button>
      {c.error && <p role="alert" className="mt-3 max-w-[390px] text-[13px] text-danger">{c.error}</p>}
    </div>
  );
}
