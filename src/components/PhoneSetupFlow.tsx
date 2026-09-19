import { PhoneSetupFlowView } from "./phone-setup/PhoneSetupFlowView";
import { usePhoneSetupController } from "./phone-setup/usePhoneSetupController";

export {
  companionAccountActionError,
  companionAccountBridge,
  companionBridge,
  companionStateRefreshIsCurrent,
  loadCompanionBridgeState,
  mutateCompanionBridgeState,
  phonePairingManualCodeMode,
  shouldHydrateCompanionEmail,
  type CompanionBridge,
  type CompanionState,
  type CompanionStateMutationEpoch,
  type PhoneDevice,
} from "./phone-setup/companionBridge";
export { usePhoneSetupController, type PhoneSetupController } from "./phone-setup/usePhoneSetupController";
export { PhoneSetupFlowView } from "./phone-setup/PhoneSetupFlowView";
export { companionPairingMode } from "../lib/phone-setup";

export function PhoneSetupFlow({
  profileEmail,
  variant,
  onSkip,
  onComplete,
  compactHeader,
}: {
  profileEmail?: string;
  variant: "settings" | "onboarding";
  onSkip?: () => void;
  onComplete?: () => void;
  compactHeader?: boolean;
}) {
  const controller = usePhoneSetupController(profileEmail);
  return (
    <PhoneSetupFlowView
      controller={controller}
      variant={variant}
      onSkip={onSkip}
      onComplete={onComplete} compactHeader={compactHeader} />
  );
}
