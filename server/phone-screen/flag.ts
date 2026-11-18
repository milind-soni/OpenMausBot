import type { BundledSkill } from "../skill-library.ts";
import type { PhoneHold } from "./hold.ts";

/** `features.usbPhoneTakeover`: a person watches and takes over the bots' USB phone. Off unless true. */
export function usbPhoneTakeoverEnabled({ features }: { features?: unknown }): boolean {
  return typeof features === "object" && features !== null && "usbPhoneTakeover" in features && features.usbPhoneTakeover === true;
}

/** For `onConfigSaved`: a hold must not outlive the feature, and with no stream open nothing else notices it going off. */
export function endHoldUnlessOn(hold: Pick<PhoneHold, "release">, saved: { features?: unknown }): void {
  if (!usbPhoneTakeoverEnabled(saved)) hold.release();
}

/** Every turn the engine can mount it, whatever its words: they pick only the skill's instructions. */
export function usbPhoneOffered(instance: { adapter: { capabilities: { phoneMcp?: boolean } } }, skills: readonly BundledSkill[]): boolean {
  return instance.adapter.capabilities.phoneMcp === true &&
    skills.some(({ manifest }) => manifest.defaultEnabled && manifest.requiredCapabilities.includes("phoneMcp"));
}
