// "Connect your phone": one entry in the account menu that opens the phone
// pairing this window can actually do. A Cloud customer once found only this
// computer's pairing and could not see how to reach their Cloud from the
// phone, so the entry names where the phone will connect.
//
// - this computer (the desktop app on its own computer): the phone flow in
//   Settings → Remote access, which pairs with this computer's companion;
// - the person's own OMB Cloud (open in this window, or a browser): that
//   Cloud's own Remote access pairing code;
// - any other server: its pairing code, only for a session that may make one.
//
// On this computer, someone with a paid Cloud that is Ready is offered both:
// their Cloud first (always on), then this computer.
import type { LocaleKey } from "@/locales";
import type { Action } from "@/state/store";
import { readMembership } from "./membership";
import { isOwnerOrAdmin, readSessionState, type SessionState } from "./session";

export type PhonePairingTarget = "computer" | "cloud" | "server";

/** Settings → Remote access, on the phone pairing this window can do (this
 * computer's phone flow, or the server's pairing code), with focus on the
 * button that shows the code. */
export const phonePairingSettingsAction = (): Extract<Action, { type: "toggleAppSettings" }> => ({
  type: "toggleAppSettings",
  open: true,
  section: "companion",
  phonePairing: true,
});

/** This window's target, from the bridges it has and the server it shows.
 * The desktop's phone bridge is only on the local app's own page, never a
 * remote server's (the preload withholds it there). */
export function currentPhonePairingTarget(cloudHome: boolean): PhonePairingTarget {
  // SAFETY: the preload's narrow bridge; `companion` is read for presence only.
  const ogb = typeof window === "undefined" ? undefined : (window.ogb as { companion?: unknown; remoteClient?: { active?: boolean } } | undefined);
  return phonePairingTarget({ companion: Boolean(ogb?.companion), remoteClient: ogb?.remoteClient?.active === true, cloudHome });
}

/** Where a phone pairs from this window. `companion`: this window has the
 * desktop's phone bridge (the local app, not a remote server's page);
 * `remoteClient`: this desktop is a client of another server, whose phones
 * pair there; `cloudHome`: the server is an OMB Cloud home. */
export function phonePairingTarget(input: { companion: boolean; remoteClient: boolean; cloudHome: boolean }): PhonePairingTarget {
  if (input.cloudHome) return "cloud";
  return input.companion && !input.remoteClient ? "computer" : "server";
}

/** What Settings → Remote access would let this session do. */
export interface PhonePairingAccess {
  session: SessionState | null;
  /** False where the server refuses pairing codes: a hosted installation
   * whose people sign in through the organization's Admin. */
  pairingCodes: boolean;
}

export interface ConnectPhoneEntry {
  target: PhonePairingTarget;
  subtitleKey: LocaleKey;
}

const SUBTITLE: Record<PhonePairingTarget, LocaleKey> = {
  computer: "sidebar.menu.connectPhone.computer",
  cloud: "sidebar.menu.connectPhone.cloud",
  server: "sidebar.menu.connectPhone.server",
};

/** The menu entry, or null when this window cannot pair a phone. This
 * computer's own phone flow is always there. A server's pairing code is
 * offered only to the owner on that machine or an admin session, and only
 * where pairing codes are on; while that answer is on its way
 * (`access` null), nothing is offered. */
export function connectPhoneEntry(target: PhonePairingTarget, access: PhonePairingAccess | null): ConnectPhoneEntry | null {
  if (target !== "computer" && !(access && access.pairingCodes && isOwnerOrAdmin(access.session))) return null;
  return { target, subtitleKey: SUBTITLE[target] };
}

/** The person's own Cloud, as a second destination on this computer:
 * "ready" (a paid plan, any tier, and the Cloud Ready: offered first),
 * "not-ready" (paid, but the Cloud is setting up, stopped or unlisted: a
 * hint only), or null (no paid plan, signed out, or not known yet). Read
 * from the verified native snapshot only. */
export type CloudPhoneDestination = "ready" | "not-ready" | null;

export function cloudPhoneDestination(_account: unknown): CloudPhoneDestination {
  return null;
}

/** One "Connect your phone" line. `id` "cloud": open the person's Cloud in
 * this window on its phone pairing (the Settings card's Use your Cloud on
 * your phone); "here": this window's own pairing. */
export interface PhoneDestination extends ConnectPhoneEntry {
  id: "cloud" | "here";
  /** a quiet third line: why the Cloud is not offered yet */
  noteKey?: LocaleKey;
}

/** The lines "Connect your phone" offers, in order. Only on this computer
 * does the person's Cloud join in, and first; on the Cloud itself, or any
 * other server, the window's own pairing is the only one. */
export function phoneDestinations(entry: ConnectPhoneEntry | null, cloud: CloudPhoneDestination): PhoneDestination[] {
  if (!entry) return [];
  const here: PhoneDestination = { ...entry, id: "here" };
  if (entry.target !== "computer" || !cloud) return [here];
  if (cloud === "not-ready") return [{ ...here, noteKey: "sidebar.menu.connectPhone.cloudNotReady" }];
  return [{ id: "cloud", target: "cloud", subtitleKey: "sidebar.menu.connectPhone.cloudAlwaysOn" }, here];
}

let pending: Promise<PhonePairingAccess> | null = null;

/** Asked once per page load, as Settings → Remote access asks it: a config
 * that cannot be read means what an older server's means (codes on), and the
 * card itself says so if the server refuses. */
export function loadPhonePairingAccess(fetchImpl: typeof fetch = fetch): Promise<PhonePairingAccess> {
  pending ??= readSessionState(fetchImpl).then(async (session): Promise<PhonePairingAccess> => {
    if (!isOwnerOrAdmin(session)) return { session, pairingCodes: false };
    const config: unknown = await fetchImpl("/api/config", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    return { session, pairingCodes: readMembership(config).pairingCodes };
  });
  return pending;
}

/** Tests only: forget the answer so the next load asks again. */
export function resetPhonePairingAccess(): void {
  pending = null;
}

/** The button that makes a code (Create pairing code, Pair your phone)
 * carries `data-phone-pairing-action`; focus lands there, never on a Sign
 * out beside it. */
const PHONE_PAIRING_ACTION = "data-phone-pairing-action";

interface PairingRoot {
  scrollIntoView?: (options: ScrollIntoViewOptions) => void;
  querySelector: (selector: string) => { focus: (options?: FocusOptions) => void } | null;
  focus: (options?: FocusOptions) => void;
}

/** Bring a pairing card into view and put focus on the action that shows
 * the code, so the QR is one click (or Enter) away; the card itself when
 * there is none to press yet. Deferred a frame: Settings settles its own
 * scroll position after its sections' effects run. */
export function revealPhonePairing(
  root: PairingRoot | null,
  schedule: (callback: () => void) => unknown = (callback) => window.requestAnimationFrame(callback),
): boolean {
  if (!root) return false;
  schedule(() => {
    root.scrollIntoView?.({ block: "start" });
    (root.querySelector(`[${PHONE_PAIRING_ACTION}]:not([disabled])`) ?? root).focus({ preventScroll: true });
  });
  return true;
}

/** `?desktop-settings=phone`: open Settings on the phone pairing. Main adds
 * it when "Use your Cloud on your phone" opens the Cloud in this window; it
 * asks only for a page to be shown and never makes a code by itself. Returns
 * the address without it, or null when it is not there. */
export function takePhonePairingRequest(href: string): string | null {
  const url = new URL(href);
  if (url.searchParams.get("desktop-settings") !== "phone") return null;
  url.searchParams.delete("desktop-settings");
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Where the pair page goes once this device is paired: home, carrying on
 * only that one request, so a first visit to the Cloud still ends on its
 * phone pairing. */
export function pairedDestination(search: string): string {
  return new URLSearchParams(search).get("desktop-settings") === "phone" ? "/?desktop-settings=phone" : "/";
}
