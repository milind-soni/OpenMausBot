// Paired phones on an older MausBot app that can no longer connect away from the person's Wi-Fi, because this computer's
// secure link for older phone apps ended. Only the desktop's main process says so, over the private parent port; 0 anywhere else.
import type { PromptPart } from "./system-prompt.ts";

let olderPhoneApps = 0;

/** `{ type: "openmausbot:phone-link", olderPhoneApps }`: true when it was one (then applied), false for any other
 * message; a malformed one throws and changes nothing. */
export function applyPhoneLinkMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "openmausbot:phone-link") return false;
  const count = (message as { olderPhoneApps?: unknown }).olderPhoneApps;
  if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 100) throw new Error("invalid phone link fact");
  olderPhoneApps = count as number;
  return true;
}

export function phoneLinkPrompt(count: number = olderPhoneApps): string {
  if (count <= 0) return "";
  const phones = count === 1 ? "1 phone paired with this computer has" : `${count} phones paired with this computer have`;
  return ` Phone link: this computer's secure link for older MausBot phone apps has ended, and ${phones} an older app that needed it, so it connects on the same Wi-Fi only.`
    + " If the person says their phone stopped connecting away from Wi-Fi, says \"No route to your computer\" or that \"Anywhere, through MausBot\" doesn't work, this is why:"
    + " they update the MausBot app on that phone, then open it once on the same Wi-Fi as this computer; if that doesn't reconnect it, they pair it again in Settings → Phone & devices."
    + " Turning routes off and on, Try reconnecting, force-quitting the app away from that Wi-Fi or checking a VPN won't help.";
}

export function phoneLinkPart(): PromptPart {
  return { id: "phone-link", label: "Phone link", text: phoneLinkPrompt() };
}
