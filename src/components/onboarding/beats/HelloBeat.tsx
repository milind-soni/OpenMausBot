import { useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { t } from "@/lib/i18n";
import type { WelcomeFields } from "@/lib/welcome-draft";
import { useStore } from "@/state/store";
import { saveWelcomeProfile, type SavedProfile } from "../save-profile";
import { inputClass, PrimaryButton, QuietButton, staggerIndex, type BeatProps } from "./shared";

/** Asks for a name only; it lives in the flow (`fields`), so Skip and a reload keep it. The email is asked once, by the
 * product-updates question, never here. */
export function HelloBeat({
  onNext,
  onSkip,
  hosted = false,
  fields,
  onFields,
  saved,
}: BeatProps & { hosted?: boolean; fields: WelcomeFields; onFields: (fields: WelcomeFields) => void; saved: SavedProfile }) {
  const { dispatch } = useStore();
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const saveProfile = async () => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setFailed(false);
    try {
      await saveWelcomeProfile(fields, saved, dispatch);
      onNext();
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  const later = () => {
    if (pending.current) return;
    track("email_skipped");
    void saveWelcomeProfile(fields, saved, dispatch).catch(() => {});
    onSkip();
  };

  if (hosted) {
    return (
      <div className="stagger flex flex-col items-center">
        <p className="animate-rise mt-1.5 text-center text-[14px] leading-relaxed text-ink-secondary" style={staggerIndex(0)}>
          {t("onboarding.hosted.intro")}
        </p>
        <PrimaryButton onClick={onNext} className="animate-rise mt-5" style={staggerIndex(1)}>
          {t("onboarding.continue")}
        </PrimaryButton>
      </div>
    );
  }

  return (
    <div className="stagger flex flex-col items-center">
      <p className="animate-rise mt-1.5 text-center text-[14px] leading-relaxed text-ink-secondary" style={staggerIndex(0)}>
        {t("onboarding.introName")}
      </p>
      <input
        autoFocus
        type="text"
        aria-label={t("onboarding.name")}
        value={fields.name}
        onChange={(e) => onFields({ ...fields, name: e.target.value })}
        onKeyDown={(e) => e.key === "Enter" && void saveProfile()}
        placeholder={t("onboarding.name")}
        className={`animate-rise mt-5 ${inputClass}`}
        style={staggerIndex(1)}
      />
      {failed && <p role="alert" className="mt-3 text-[13px] text-danger">{t("onboarding.profile.error")}</p>}
      <PrimaryButton onClick={() => void saveProfile()} disabled={saving} className="animate-rise mt-3" style={staggerIndex(2)}>
        {saving ? t("onboarding.saving") : t("onboarding.continue")}
      </PrimaryButton>
      <QuietButton onClick={later} disabled={saving} className="animate-rise mt-3 disabled:opacity-50" style={staggerIndex(3)}>
        {t("onboarding.maybeLater")}
      </QuietButton>
    </div>
  );
}
