import type { CompanionBridge } from "@/components/PhoneSetupFlow";

// Its own module so the sidebar's phone button can read the phone's state without loading the setup flow and its QR code.
export const companionBridge = (): CompanionBridge | null =>
  // SAFETY: the preload owns this narrow bridge; browser builds are guarded by the optional lookup.
  (globalThis as { ogb?: { companion?: CompanionBridge } }).ogb?.companion ?? null;
