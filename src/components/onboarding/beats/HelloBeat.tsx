// Beat 1: who you are. Name and email go to the workspace profile (the
// sidebar footer reads them back) and to analytics identity. Both optional;
// "Maybe later" moves on without either.
import { useRef, useState } from "react";
import { identifyEmail, track } from "@/lib/analytics";
import { t } from "@/lib/i18n";
import { api, useStore } from "@/state/store";
import { inputClass, PrimaryButton, QuietButton, staggerIndex, type BeatProps } from "./shared";

export function HelloBeat({ onNext, onSkip }: BeatProps) {
  const { dispatch } = useStore();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

  const saveProfile = async () => {
    if (!valid || pending.current) return;
    pending.current = true;
    setSaving(true);
    setFailed(false);
    const trimmedEmail = email.trim().toLowerCase();
    // persisted server-side (~/.openmausbot/config.json); the response is
    // the fresh config status, folded straight into the store
    try {
      const config = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ profile: { name: name.trim(), email: trimmedEmail } }),
        signal: AbortSignal.timeout(10_000),
      });
      dispatch({ type: "configStatus", config });
      identifyEmail(trimmedEmail);
      onNext();
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="stagger flex flex-col items-center">
      <p className="animate-rise mt-1.5 text-center text-[14px] leading-relaxed text-ink-secondary" style={staggerIndex(0)}>
        {t("onboarding.intro")}
      </p>
      <input
        autoFocus
        type="text"
        aria-label={t("onboarding.name")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("onboarding.name")}
        className={`animate-rise mt-5 ${inputClass}`}
        style={staggerIndex(1)}
      />
      <input
        type="email"
        aria-label={t("phone.signIn.email")}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void saveProfile()}
        placeholder="you@example.com"
        className={`animate-rise mt-3 ${inputClass}`}
        style={staggerIndex(2)}
      />
      {failed && <p role="alert" className="mt-3 text-[13px] text-danger">{t("onboarding.profile.error")}</p>}
      <PrimaryButton onClick={() => void saveProfile()} disabled={!valid || saving} className="animate-rise mt-3" style={staggerIndex(3)}>
        {t("onboarding.continue")}
      </PrimaryButton>
      <QuietButton
        onClick={() => {
          track("email_skipped");
          onSkip();
        }}
        className="animate-rise mt-3"
        style={staggerIndex(4)}
      >
        {t("onboarding.maybeLater")}
      </QuietButton>
    </div>
  );
}
