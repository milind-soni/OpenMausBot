// Beat: your phone. The shared phone-setup state machine in its onboarding
// variant; it can always be resumed later from Settings → Companion, which
// is why skipping here costs nothing.
import { useEffect } from "react";
import { PhoneSetupFlow } from "@/components/PhoneSetupFlow";
import { track } from "@/lib/analytics";
import { useStore } from "@/state/store";
import type { BeatProps } from "./shared";

export function PhoneBeat({ onNext, onSkip, setMascot, bump }: BeatProps) {
  const { state } = useStore();
  useEffect(() => {
    setMascot("sending");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="animate-rise flex min-h-0 flex-col">
      <PhoneSetupFlow
        variant="onboarding"
        compactHeader
        profileEmail={state.config?.profile?.email ?? ""}
        onSkip={() => {
          track("phone_setup_skipped");
          onSkip();
        }}
        onComplete={() => {
          track("phone_setup_completed");
          bump("celebrate");
          onNext();
        }}
      />
    </div>
  );
}
