// Beat: what the app may use. Desktop only, microphone only. Screen
// Recording deliberately has no row: macOS 15+ makes a pre-grant unreliable
// (per-process status caching, helper misattribution, periodic re-prompts),
// so the OS flow triggers on the first real capture in the Computer panel,
// the moment the user has context for the dialog.
import { useEffect, useState } from "react";
import { Check, Mic } from "lucide-react";
import { t } from "@/lib/i18n";
import { PrimaryButton, QuietButton, staggerIndex, type BeatProps } from "./shared";

export function PermissionsBeat({ onNext, onSkip, setMascot, bump }: BeatProps) {
  const [perms, setPerms] = useState<{ mic: string } | null>(null);

  useEffect(() => {
    setMascot("listening");
    const poll = () => window.ogb?.permStatus?.().then(setPerms).catch(() => {});
    poll();
    // keep polling — the user may grant in System Settings and come back
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const granted = perms?.mic === "granted";
  useEffect(() => {
    if (granted) bump("success");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [granted]);

  const denied = perms?.mic === "denied" || perms?.mic === "restricted";

  return (
    <div className="flex flex-col">
      <p className="animate-rise mt-1 text-[13.5px] text-ink-secondary">{t("onboarding.perms.intro")}</p>
      <div className="stagger mt-4 flex flex-col gap-2.5">
        <div className="animate-rise flex items-center justify-between gap-3 rounded-xl bg-card p-3.5" style={staggerIndex(1)}>
          <div className="flex items-start gap-3">
            <Mic size={18} className="mt-0.5 shrink-0 text-ink-secondary" />
            <div>
              <div className="text-[14px] font-medium text-ink">{t("onboarding.perms.mic")}</div>
              <div className="mt-0.5 text-[12.5px] text-ink-secondary">{t("onboarding.perms.micDetail")}</div>
            </div>
          </div>
          {granted ? (
            <Check size={16} className="shrink-0 text-success" />
          ) : denied ? (
            <button
              onClick={() => window.ogb?.permOpenSettings?.("mic")}
              className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink transition-colors hover:bg-raised-hover"
            >
              {t("onboarding.perms.openSettings")}
            </button>
          ) : (
            <button
              onClick={() => window.ogb?.permRequestMic?.().then(() => window.ogb?.permStatus?.().then(setPerms))}
              className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink transition-colors hover:bg-raised-hover"
            >
              {t("onboarding.perms.enable")}
            </button>
          )}
        </div>
      </div>
      <PrimaryButton onClick={onNext} className="mt-5">
        {t("onboarding.continue")}
      </PrimaryButton>
      <QuietButton onClick={onSkip} className="mt-3 self-center">
        {t("onboarding.skip")}
      </QuietButton>
    </div>
  );
}
