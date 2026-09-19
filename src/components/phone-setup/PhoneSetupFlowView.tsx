import { t } from "@/lib/i18n";
import { PhonePreview } from "@/components/onboarding/PhonePreview";
import {
  ArrowLeft,
  Check,
  Loader2,
  Mail,
  QrCode,
  ShieldCheck,
  Smartphone,
  Wifi,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { ConnectionDetail } from "../ConnectionDetail";
import { brand } from "@/lib/brand";
import {
  companionAccountActionError,
  phonePairingManualCodeMode,
} from "./companionBridge";
import type { PhoneSetupController } from "./usePhoneSetupController";

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
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">{detail}</div>
        </div>
      ))}
    </div>
  );
}

export function PhoneSetupFlowView({
  controller,
  variant,
  onSkip,
  onComplete,
  compactHeader = false,
}: {
  controller: PhoneSetupController;
  variant: "settings" | "onboarding";
  onSkip?: () => void;
  onComplete?: () => void;
  /** The host already shows a title for this step (the welcome tour does),
   * so the intro drops its own icon and heading and keeps the detail. */
  compactHeader?: boolean;
}) {
  const c = controller;
  const actionError = companionAccountActionError(c.account, c.accountError);
  const canSubmitEmail = /^\S+@\S+\.\S+$/.test(c.email.trim());
  const manualCodeMode = phonePairingManualCodeMode(Boolean(c.state?.pairing), c.pairingLink);

  if (c.phase === "intro" && compactHeader) {
    const points: Array<{ Icon: typeof Smartphone; title: string; detail: string }> = [
      { Icon: Smartphone, title: t("phone.value.chats"), detail: t("phone.value.chatsDetail") },
      { Icon: Check, title: t("phone.value.approvals"), detail: t("phone.value.approvalsDetail") },
      { Icon: ShieldCheck, title: t("phone.value.private"), detail: t("phone.value.privateDetail") },
    ];
    return (
      <div className="flex flex-col">
        <p className="mt-1 text-[13.5px] leading-relaxed text-ink-secondary">{t("phone.intro.detail")}</p>
        <div className="mt-4 grid grid-cols-[200px_1fr] items-center gap-6">
          <PhonePreview />
          <ul className="flex flex-col gap-3.5">
            {points.map(({ Icon, title, detail }) => (
              <li key={title} className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
                  <Icon size={14} />
                </span>
                <span>
                  <span className="block text-[13.5px] font-medium text-ink">{title}</span>
                  <span className="block text-[12px] leading-relaxed text-ink-secondary">{detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <button
          onClick={c.start}
          disabled={!c.state || c.busy || c.accountBusy}
          className="mt-5 w-full rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-40"
        >
          {t("phone.intro.setUp")}
        </button>
        {c.error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{c.error}</p>}
        <button
          onClick={() => {
            c.skip();
            onSkip?.();
          }}
          className="mt-3 self-center text-[12.5px] text-ink-secondary hover:text-ink"
        >
          {t("phone.intro.notNow")}
        </button>
        <p className="mt-1.5 self-center text-[11.5px] text-ink-secondary">{t("phone.intro.resume")}</p>
      </div>
    );
  }

  if (c.phase === "intro") {
    return (
      <div className={compactHeader ? "flex flex-col items-start" : "flex flex-col items-center text-center"}>
        {!compactHeader && (
          <>
            <div className="flex size-14 items-center justify-center rounded-2xl bg-accent/12 text-accent">
              <Smartphone size={26} />
            </div>
            <h2 className="mt-4 text-[19px] font-semibold text-ink">{t("phone.intro.title", { app: brand().name })}</h2>
          </>
        )}
        <p className={compactHeader ? "mt-1 text-[13.5px] leading-relaxed text-ink-secondary" : "mt-1.5 max-w-[460px] text-[13.5px] leading-relaxed text-ink-secondary"}>
          {t("phone.intro.detail")}
        </p>
        <ValuePoints />
        <button
          onClick={c.start}
          disabled={!c.state || c.busy || c.accountBusy}
          className={compactHeader
            ? "mt-5 w-full rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-40"
            : "mt-5 w-full max-w-[320px] rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-40"}
        >
          {variant === "settings"
            ? c.state?.devices.length
              ? t("phone.intro.pairAnother")
              : t("phone.intro.pair")
            : t("phone.intro.setUp")}
        </button>
        {c.error && <p role="alert" className="mt-3 max-w-[390px] text-[12.5px] text-danger">{c.error}</p>}
        {variant === "onboarding" && (
          <>
            <button
              onClick={() => {
                c.skip();
                onSkip?.();
              }}
              className={compactHeader ? "mt-3 self-center text-[12.5px] text-ink-secondary hover:text-ink" : "mt-2.5 text-[12.5px] text-ink-secondary hover:text-ink"}
            >
              {t("phone.intro.notNow")}
            </button>
            <p className={compactHeader ? "mt-2 self-center text-[11.5px] text-ink-secondary" : "mt-2 text-[11.5px] text-ink-secondary"}>
              {t("phone.intro.resume")}
            </p>
          </>
        )}
      </div>
    );
  }

  if (c.phase === "sign-in") {
    const unavailable = !c.account?.available;
    const failed = c.account?.status === "error" || c.setupTimedOut;
    return (
      <div className="mx-auto flex w-full max-w-[430px] flex-col">
        <button onClick={c.cancel} className="mb-4 flex w-fit items-center gap-1.5 text-[12px] text-ink-secondary hover:text-ink">
          <ArrowLeft size={13} /> {t("phone.back")}
        </button>
        <div className="flex size-11 items-center justify-center rounded-xl bg-accent/12 text-accent">
          <Mail size={20} />
        </div>
        <h2 className="mt-3 text-[18px] font-semibold text-ink">
          {unavailable || failed ? t("phone.signIn.attention") : t("phone.signIn.title")}
        </h2>
        <p
          role={c.setupTimedOut ? "alert" : undefined}
          className="mt-1 text-[13px] leading-relaxed text-ink-secondary"
        >
          {unavailable
            ? t("phone.signIn.unavailable")
            : c.setupTimedOut
              ? t("phone.signIn.timedOut")
            : failed
              ? c.account?.message ?? t("phone.signIn.failed")
              : t("phone.signIn.emailPrompt")}
        </p>

        {!unavailable && !failed && (
          <div className="mt-5 flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ink-secondary">{t("phone.signIn.email")}</span>
              <input
                autoFocus
                autoComplete="email"
                inputMode="email"
                value={c.email}
                disabled={c.accountBusy || c.codeSent}
                onChange={(event) => c.setEmail(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !c.codeSent && canSubmitEmail) c.requestCode();
                }}
                placeholder="you@example.com"
                className="rounded-lg border border-hairline/50 bg-inset px-3 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent disabled:opacity-50"
              />
            </label>
            {c.codeSent && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-ink-secondary">{t("phone.signIn.code")}</span>
                <input
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={c.code}
                  disabled={c.accountBusy}
                  onChange={(event) => c.setCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && c.code.length === 8) c.verifyCode();
                  }}
                  placeholder="12345678"
                  className="rounded-lg border border-hairline/50 bg-inset px-3 py-2.5 font-mono text-[16px] tracking-[0.18em] text-ink outline-none placeholder:tracking-normal placeholder:text-ink-secondary/60 focus:border-accent disabled:opacity-50"
                />
              </label>
            )}
            <button
              disabled={c.accountBusy || (!c.codeSent && !canSubmitEmail) || (c.codeSent && c.code.length !== 8)}
              onClick={c.codeSent ? c.verifyCode : c.requestCode}
              className="rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {c.accountBusy ? t("phone.signIn.working") : c.codeSent ? t("phone.signIn.verify") : t("phone.signIn.sendCode")}
            </button>
            {c.codeSent && (
              <button
                disabled={c.accountBusy}
                onClick={c.changeEmail}
                className="text-[12px] text-ink-secondary hover:text-ink disabled:opacity-40"
              >
                {t("phone.signIn.otherEmail")}
              </button>
            )}
            {c.codeSent && !actionError && (
              <p className="text-[11.5px] text-ink-secondary">{t("phone.signIn.expires")}</p>
            )}
          </div>
        )}

        {(unavailable || failed) && (
          <button
            disabled={c.accountBusy}
            onClick={c.retryAccount}
            className="mt-5 rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white disabled:opacity-40"
          >
            {c.accountBusy ? t("remote.account.retrying") : t("phone.signIn.retry")}
          </button>
        )}
        {actionError && <p role="alert" className="mt-3 text-[12.5px] text-danger">{actionError}</p>}
        <div className="my-4 flex items-center gap-3 text-[11px] text-ink-secondary">
          <span className="h-px flex-1 bg-hairline/40" /> {t("phone.signIn.or")} <span className="h-px flex-1 bg-hairline/40" />
        </div>
        {variant === "onboarding" && c.tailscaleAvailable && (
          <>
            <button
              disabled={c.busy || c.accountBusy}
              onClick={c.useTailscale}
              className="flex items-center justify-center gap-2 rounded-lg border border-hairline/50 py-2.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
            >
              <ShieldCheck size={15} /> {t("remote.pairOverTailscale")}
            </button>
            <p className="mt-2 text-center text-[11px] leading-relaxed text-ink-secondary">
              {t("phone.signIn.tailnetNote")}
            </p>
          </>
        )}
        <button
          disabled={c.busy || c.accountBusy}
          onClick={c.useLocal}
          className={`${variant === "onboarding" && c.tailscaleAvailable ? "mt-3" : ""} flex items-center justify-center gap-2 rounded-lg border border-hairline/50 py-2.5 text-[13px] text-ink hover:bg-control disabled:opacity-40`}
        >
          <Wifi size={15} /> {t("phone.signIn.wifiInstead")}
        </button>
        <p className="mt-2 text-center text-[11px] leading-relaxed text-ink-secondary">
          {t("phone.signIn.wifiNote")}
        </p>
      </div>
    );
  }

  if (c.phase === "verifying") {
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-accent/12 text-accent">
          <Loader2 size={25} className="animate-spin" />
        </div>
        <h2 className="mt-4 text-[18px] font-semibold text-ink">
          {c.localFallback
            ? t("phone.verifying.local")
            : c.tailscaleFallback
              ? t("phone.verifying.tailscale")
              : t("phone.verifying.secure")}
        </h2>
        <p className="mt-1.5 max-w-[360px] text-[13px] leading-relaxed text-ink-secondary">
          {c.localFallback
            ? t("phone.verifying.localDetail")
            : c.tailscaleFallback
              ? t("phone.verifying.tailscaleDetail")
            : t("phone.verifying.secureDetail")}
        </p>
        {(c.error || c.accountError) && (
          <p role="alert" className="mt-3 max-w-[380px] text-[12.5px] text-danger">{c.error ?? c.accountError}</p>
        )}
        <button onClick={c.cancel} className="mt-5 text-[12px] text-ink-secondary hover:text-ink">{t("common.cancel")}</button>
      </div>
    );
  }

  if (c.phase === "success") {
    return (
      <div className="flex flex-col items-center py-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-success/15 text-success">
          <Check size={28} />
        </div>
        <h2 className="mt-4 text-[19px] font-semibold text-ink">{t("phone.success.title")}</h2>
        <p className="mt-1.5 text-[13px] text-ink-secondary">
          {t("phone.success.detail")}
        </p>
        <button
          onClick={() => {
            c.finish();
            onComplete?.();
          }}
          className="mt-5 w-full max-w-[280px] rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white"
        >
          {variant === "onboarding" ? t("phone.success.start", { app: brand().name }) : t("phone.success.done")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-white text-black">
        <QrCode size={23} />
      </div>
      <h2 className="mt-3 text-[18px] font-semibold text-ink">
        {c.pairingExpired ? t("phone.code.expired") : t("phone.code.title")}
      </h2>
      <p className="mt-1 text-[13px] text-ink-secondary">
        {c.pairingExpired ? t("phone.code.expiredDetail") : t("phone.code.detail")}
      </p>
      {!c.pairingExpired && c.pairingLink && (
        <div className="mt-4 rounded-2xl bg-white p-3.5" aria-label={t("phone.code.qrAria")}>
          <QRCodeSVG value={c.pairingLink} size={180} level="M" bgColor="#ffffff" fgColor="#111111" />
        </div>
      )}
      {!c.pairingExpired && manualCodeMode === "direct" && c.state?.pairing && (
        <div className="mt-4 w-full max-w-[320px] rounded-xl bg-inset px-4 py-3 text-[12.5px] text-ink-secondary">
          <div>{t("phone.code.manualIntro")}</div>
          <div className="mt-2 font-mono text-[22px] tracking-[0.25em] text-ink">
            {c.state.pairing.code}
          </div>
        </div>
      )}
      {!c.pairingExpired && manualCodeMode === "details" && c.state?.pairing && (
        <p className="mt-3 text-[11.5px] text-ink-secondary">{t("phone.code.expiresIn", { seconds: c.secondsLeft })}</p>
      )}
      {c.pairingExpired && (
        <button onClick={c.refreshCode} className="mt-5 rounded-lg bg-accent px-5 py-2.5 text-[14px] font-medium text-white">
          {t("phone.code.createNew")}
        </button>
      )}
      {!c.pairingExpired && c.state?.pairing && (
        <details className="mt-4 w-full max-w-[390px] rounded-lg border border-hairline/40 px-3 py-2 text-left">
          <summary className="cursor-pointer text-[12px] text-ink-secondary">{t("phone.code.trouble")}</summary>
          <div className="mt-3 text-[12px] text-ink-secondary">
            {t("phone.code.manual")}
            <div className="mt-1 font-mono text-[22px] tracking-[0.25em] text-ink">{c.state.pairing.code}</div>
            {c.address && (
              <div className="mt-3">
                <ConnectionDetail label={t("phone.code.address")} value={`${c.address}:${c.pairingPort}`} />
              </div>
            )}
          </div>
        </details>
      )}
      <button onClick={c.cancel} className="mt-4 text-[12px] text-ink-secondary hover:text-ink">{t("common.cancel")}</button>
    </div>
  );
}
