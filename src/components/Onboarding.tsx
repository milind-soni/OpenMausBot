import { useEffect, useState } from "react";
import { Check, Info, Loader2, Mic } from "lucide-react";
import { MausAvatar } from "./Avatar";
import { identifyEmail, setEmailGateDone, track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { EngineSetup } from "./EngineSetup";
import { EngineCard, EngineSections, RefreshEngines, engineReady } from "./EngineLibrary";
import { PhoneSetupFlow } from "./PhoneSetupFlow";
import { useStore } from "@/state/store";
import { brand } from "../lib/brand";
import { t } from "@/lib/i18n";

// First-run onboarding: who you are (email), what's installed (live engine
// checks from the harness), what the app may use (TCC), then an optional
// phone setup that can always be resumed from Settings → Remote access.
// Every check is skippable — onboarding must never brick the app.

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { capabilities } = useDesktopCapabilities();
  const { state, refreshInstances } = useStore();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [checkedEngines, setCheckedEngines] = useState(false);
  const instances = state.instances;
  const [perms, setPerms] = useState<{ mic: string } | null>(null);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

  const saveProfile = () => {
    identifyEmail(email.trim().toLowerCase());
    // persisted server-side (~/.openmausbot/config.json) — the sidebar
    // footer reads it back through /api/config
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    }).catch(() => {});
    setStep(1);
  };

  useEffect(() => {
    track("onboarding_step", { step });
  }, [step]);

  useEffect(() => {
    if (step !== 1) return;
    let active = true;
    // Setup actions and focus refreshes already update this shared list. A
    // second onboarding-only snapshot otherwise stays stale after sign-in.
    void refreshInstances().finally(() => { if (active) setCheckedEngines(true); });
    return () => {
      active = false;
    };
  }, [step, refreshInstances]);

  useEffect(() => {
    if (step === 2 && capabilities.dictation.available) {
      const poll = () => window.ogb?.permStatus?.().then(setPerms).catch(() => {});
      poll();
      // keep polling — the user may grant in System Settings and come back
      const t = setInterval(poll, 2000);
      return () => clearInterval(t);
    }
  }, [step, capabilities.dictation.available]);

  const finish = () => {
    track("onboarding_completed", {
      engines_available: instances?.filter((i) => i.snapshot.state === "available").length ?? -1,
      mic: perms?.mic ?? "n/a",
    });
    setEmailGateDone("submitted");
    onDone();
  };

  const engines = instances.filter((instance) => instance.install);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app p-3 sm:p-8">
      {/* the engines step lays tiles out two across, so it gets more room —
          but never more than the window: the panel caps at the viewport and
          the engine list scrolls inside it, so the header and Continue stay
          put and nothing runs into the edges */}
      <div
        className={`flex max-h-full w-full flex-col rounded-2xl border border-hairline/40 bg-panel p-5 sm:p-8 ${step === 1 ? "max-w-[800px]" : step === 3 ? "max-w-[620px]" : "max-w-[460px]"}`}
      >
        {step === 0 && (
          <div className="flex flex-col items-center">
            {brand().logo ? (
              <img src={brand().logo} alt="" width={72} height={72} className="h-[72px] w-[72px] object-contain" />
            ) : (
              <MausAvatar color="green" state="happy" size={72} />
            )}
            <h1 className="mt-4 text-[20px] font-semibold text-ink">{t("onboarding.welcome", { app: brand().name })}</h1>
            <p className="mt-1.5 text-center text-[14px] leading-relaxed text-ink-secondary">
              {t("onboarding.intro")}
            </p>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("onboarding.name")}
              className="mt-5 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && valid && saveProfile()}
              placeholder="you@example.com"
              className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <button
              onClick={saveProfile}
              disabled={!valid}
              className="mt-3 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white disabled:opacity-40"
            >
              {t("onboarding.continue")}
            </button>
            <button
              onClick={() => {
                track("email_skipped");
                setStep(1);
              }}
              className="mt-3 text-[12px] text-ink-secondary hover:text-ink"
            >
              {t("onboarding.maybeLater")}
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="flex min-h-0 flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="text-[24px] font-semibold tracking-tight text-ink">{t("onboarding.engines.title")}</h1>
              <RefreshEngines />
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
              {t("onboarding.engines.intro")}
            </p>
            <div className="mt-6 min-h-0 overflow-y-auto pr-1 [scrollbar-width:thin]">
              {!checkedEngines && !engines.length ? (
                <div className="flex items-center gap-2 py-6 text-ink-secondary">
                  <Loader2 size={16} className="animate-spin" /> {t("common.checking")}
                </div>
              ) : (
                <EngineSections instances={engines} renderEngine={(instance) => (
                  <EngineCard instance={instance}>
                    {engineReady(instance) ? (
                      <p className="text-[13px] text-ink-secondary">{t(instance.access === "custom" ? "onboarding.engines.readyLocal" : "onboarding.engines.readyCloud")}</p>
                    ) : <EngineSetup instance={instance} intent={instance.access === "custom" ? "inject" : "cloud"} unframed />}
                  </EngineCard>
                )} />
              )}
            </div>
            <p className="mt-5 flex shrink-0 items-center gap-2 border-t border-hairline/40 pt-4 text-[12px] text-ink-secondary"><Info size={14} className="shrink-0" />{t("engines.library.later")}</p>
            <button
              onClick={() => setStep(capabilities.dictation.available ? 2 : 3)}
              className="mt-5 w-full shrink-0 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white"
            >
              {t("onboarding.continue")}
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col">
            <h1 className="text-[18px] font-semibold text-ink">{t("onboarding.perms.title")}</h1>
            <p className="mt-1 text-[13.5px] text-ink-secondary">
              {t("onboarding.perms.intro")}
            </p>
            <div className="mt-4 flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-3 rounded-xl bg-card p-3.5">
                <div className="flex items-start gap-3">
                  <Mic size={18} className="mt-0.5 shrink-0 text-ink-secondary" />
                  <div>
                    <div className="text-[14px] font-medium text-ink">{t("onboarding.perms.mic")}</div>
                    <div className="mt-0.5 text-[12.5px] text-ink-secondary">
                      {t("onboarding.perms.micDetail")}
                    </div>
                  </div>
                </div>
                {perms?.mic === "granted" ? (
                  <Check size={16} className="shrink-0 text-success" />
                ) : perms?.mic === "denied" || perms?.mic === "restricted" ? (
                  <button
                    onClick={() => window.ogb?.permOpenSettings?.("mic")}
                    className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
                  >
                    {t("onboarding.perms.openSettings")}
                  </button>
                ) : (
                  <button
                    onClick={() =>
                      window.ogb?.permRequestMic?.().then(() => window.ogb?.permStatus?.().then(setPerms))
                    }
                    className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
                  >
                    {t("onboarding.perms.enable")}
                  </button>
                )}
              </div>
              {/* Screen Recording deliberately has no row here: macOS 15+
                  makes a pre-grant unreliable (per-process status caching,
                  helper misattribution, periodic re-prompts) — the OS flow
                  triggers on the first real capture in the Computer panel,
                  which is the moment the user has context for the dialog. */}
            </div>
            <button onClick={() => setStep(3)} className="mt-5 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white">
              {t("onboarding.continue")}
            </button>
            <button onClick={() => setStep(3)} className="mt-3 text-[12px] text-ink-secondary hover:text-ink">
              {t("onboarding.skip")}
            </button>
          </div>
        )}

        {step === 3 && (
          <PhoneSetupFlow
            variant="onboarding"
            profileEmail={email}
            onSkip={() => {
              track("phone_setup_skipped");
              finish();
            }}
            onComplete={() => {
              track("phone_setup_completed");
              finish();
            }}
          />
        )}

      </div>
    </div>
  );
}
