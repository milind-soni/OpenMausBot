import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import type { SessionState } from "./session";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import {
  cloudPhoneDestination,
  connectPhoneEntry,
  currentPhonePairingTarget,
  loadPhonePairingAccess,
  pairedDestination,
  phoneDestinations,
  phonePairingSettingsAction,
  phonePairingTarget,
  resetPhonePairingAccess,
  revealPhonePairing,
  takePhonePairingRequest,
  type PhonePairingAccess,
} from "./phone-pairing";

const owner: SessionState = { kind: "loopback" };
const admin: SessionState = { kind: "session", id: "s", label: "Mac", scopes: ["admin", "client"], expiresAt: 1 };
const chatOnly: SessionState = { kind: "session", id: "s", label: "Staff phone", scopes: ["client"], expiresAt: 1 };
const access = (session: SessionState | null, pairingCodes = true): PhonePairingAccess => ({ session, pairingCodes });
const subtitle = (entry: ReturnType<typeof connectPhoneEntry>) => (entry ? t(entry.subtitleKey) : null);

beforeEach(() => setLocale("en"));
afterEach(() => {
  vi.unstubAllGlobals();
  resetPhonePairingAccess();
});

describe("where Connect your phone pairs", () => {
  it("pairs with this computer only in the desktop app's own window", () => {
    expect(phonePairingTarget({ companion: true, remoteClient: false, cloudHome: false })).toBe("computer");
    // a remote server's page never gets the phone bridge; a browser has none
    expect(phonePairingTarget({ companion: false, remoteClient: false, cloudHome: false })).toBe("server");
    // a desktop that is a client of another server pairs phones there
    expect(phonePairingTarget({ companion: true, remoteClient: true, cloudHome: false })).toBe("server");
  });

  it("pairs with the Cloud wherever the window shows the person's own Cloud", () => {
    expect(phonePairingTarget({ companion: false, remoteClient: false, cloudHome: true })).toBe("cloud");
    expect(phonePairingTarget({ companion: true, remoteClient: true, cloudHome: true })).toBe("cloud");
    // the server answering says it is a Cloud home: its pairing is the Cloud's, whatever bridge this page has
    expect(phonePairingTarget({ companion: true, remoteClient: false, cloudHome: true })).toBe("cloud");
  });

  it("reads the window's bridges", () => {
    vi.stubGlobal("window", { ogb: { companion: {} } });
    expect(currentPhonePairingTarget(false)).toBe("computer");
    vi.stubGlobal("window", { ogb: { companion: {}, remoteClient: { active: true } } });
    expect(currentPhonePairingTarget(false)).toBe("server");
    // the reduced bridge a Cloud page gets: no companion
    vi.stubGlobal("window", { ogb: { cloudPlan: {} } });
    expect(currentPhonePairingTarget(true)).toBe("cloud");
    // a browser
    vi.stubGlobal("window", {});
    expect(currentPhonePairingTarget(false)).toBe("server");
  });
});

describe("Connect your phone in the account menu", () => {
  it("on this computer: always there, to this computer, without asking the server", () => {
    expect(subtitle(connectPhoneEntry("computer", null))).toBe("to this computer");
    expect(connectPhoneEntry("computer", access(chatOnly, false))?.target).toBe("computer");
  });

  it("on the person's own Cloud: to My Cloud, for the owner's session", () => {
    expect(subtitle(connectPhoneEntry("cloud", access(admin)))).toBe("to My Cloud");
    expect(connectPhoneEntry("cloud", access(chatOnly))).toBeNull();
  });

  it("on another server: to this server, only for a session that may make a pairing code", () => {
    expect(subtitle(connectPhoneEntry("server", access(admin)))).toBe("to this server");
    expect(subtitle(connectPhoneEntry("server", access(owner)))).toBe("to this server");
    // chat and approvals only: the server refuses it a code
    expect(connectPhoneEntry("server", access(chatOnly))).toBeNull();
    // a shared server that does not treat this machine as its owner
    expect(connectPhoneEntry("server", access({ kind: "loopback", trust: "service" }))).toBeNull();
    expect(connectPhoneEntry("server", access({ kind: "unauthenticated", error: "pair" }))).toBeNull();
    // people sign in through the organization's Admin there: codes are off
    expect(connectPhoneEntry("server", access(admin, false))).toBeNull();
  });

  it("offers nothing while it does not know yet", () => {
    expect(connectPhoneEntry("server", null)).toBeNull();
    expect(connectPhoneEntry("cloud", null)).toBeNull();
    expect(connectPhoneEntry("cloud", access(null))).toBeNull();
  });
});

describe("asking the server", () => {
  const respond = (routes: Record<string, unknown>) =>
    vi.fn(async (path: string) => {
      const body = routes[path];
      if (body instanceof Error) throw body;
      return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : 200 });
    }) as unknown as typeof fetch;

  it("reads the session, then whether pairing codes are on", async () => {
    const fetchImpl = respond({ "/api/auth/session": { kind: "session", id: "s", label: "Mac", scopes: ["admin"], expiresAt: 1 }, "/api/config": { membership: { authority: "portal", pairingCodes: false } } });
    expect(await loadPhonePairingAccess(fetchImpl)).toMatchObject({ session: { kind: "session" }, pairingCodes: false });
  });

  it("does not ask for the config of a session that cannot pair anyway", async () => {
    const fetchImpl = respond({ "/api/auth/session": { kind: "session", id: "s", label: "Phone", scopes: ["client"], expiresAt: 1 } });
    expect(await loadPhonePairingAccess(fetchImpl)).toMatchObject({ pairingCodes: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a config it cannot read means codes on, as an older server's does; asked once per page", async () => {
    const fetchImpl = respond({ "/api/auth/session": {}, "/api/config": new Error("offline") });
    expect(await loadPhonePairingAccess(fetchImpl)).toEqual({ session: { kind: "loopback" }, pairingCodes: true });
    await loadPhonePairingAccess(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("opening Settings on the phone pairing", () => {
  it("is Remote access, asking for the pairing to be revealed", () => {
    expect(phonePairingSettingsAction()).toEqual({ type: "toggleAppSettings", open: true, section: "companion", phonePairing: true });
  });

  type Focusable = { focus: (options?: FocusOptions) => void };
  const focusable = () => ({ focus: vi.fn<(options?: FocusOptions) => void>() });
  const element = (action: Focusable | null) => ({
    scrollIntoView: vi.fn<(options: ScrollIntoViewOptions) => void>(),
    focus: vi.fn<(options?: FocusOptions) => void>(),
    querySelector: vi.fn((_selector: string) => action),
  });
  const now = (callback: () => void) => callback();

  it("scrolls the card into view and focuses the button that shows the code", () => {
    const action = focusable();
    const root = element(action);
    expect(revealPhonePairing(root, now)).toBe(true);
    expect(root.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(root.querySelector).toHaveBeenCalledWith("[data-phone-pairing-action]:not([disabled])");
    expect(action.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(root.focus).not.toHaveBeenCalled();
  });

  it("focuses the card itself when there is no button to press yet", () => {
    const root = element(null);
    revealPhonePairing(root, now);
    expect(root.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("waits a frame, and reports a card that is not drawn yet", () => {
    const root = element(focusable());
    const frames: Array<() => void> = [];
    revealPhonePairing(root, (callback) => frames.push(callback));
    expect(root.scrollIntoView).not.toHaveBeenCalled();
    frames[0]!();
    expect(root.scrollIntoView).toHaveBeenCalled();
    expect(revealPhonePairing(null, now)).toBe(false);
  });
});

describe("the ?desktop-settings=phone request", () => {
  it("is taken off the address, keeping everything else", () => {
    expect(takePhonePairingRequest("https://home.fly.dev/?desktop-settings=phone")).toBe("/");
    expect(takePhonePairingRequest("https://home.fly.dev/?a=1&desktop-settings=phone#x")).toBe("/?a=1#x");
    expect(takePhonePairingRequest("https://home.fly.dev/?desktop-settings=workspaces")).toBeNull();
    expect(takePhonePairingRequest("https://home.fly.dev/")).toBeNull();
  });

  it("survives pairing, and nothing else does", () => {
    expect(pairedDestination("?desktop-settings=phone")).toBe("/?desktop-settings=phone");
    expect(pairedDestination("?desktop-settings=phone&next=https://evil.example")).toBe("/?desktop-settings=phone");
    expect(pairedDestination("?desktop-settings=workspaces")).toBe("/");
    expect(pairedDestination("?next=//evil.example")).toBe("/");
    expect(pairedDestination("")).toBe("/");
  });
});

describe("the person's Cloud as a destination on this computer", () => {
  const origin = "https://home-7f3k2.fly.dev";
  const paid = (patch: Partial<CloudAccountState> = {}): CloudAccountState => ({
    status: "connected", entitlement: { plan: "pro", tier: "personal", status: "active", expiresAt: null, version: 1 }, machine: { status: "ready", origin }, ...patch,
  });

  it("a paid plan, any tier, with the Cloud Ready, is not offered (Vopwe local-only)", () => {
    for (const tier of [undefined, "personal", "pro", "max", "team"]) {
      expect(cloudPhoneDestination(paid({ entitlement: { plan: "pro", ...(tier ? { tier } : {}), status: "active", expiresAt: null, version: 1 } }))).toBeNull();
    }
    expect(cloudPhoneDestination(paid({ checking: true }))).toBeNull();
  });

  it("a paid plan whose Cloud is not Ready is nothing (Vopwe local-only)", () => {
    for (const machine of [{ status: "provisioning" }, { status: "stopped", origin }, { status: "payment-problem", origin }, { status: "failed", origin }] as const) {
      expect(cloudPhoneDestination(paid({ machine }))).toBeNull();
    }
    expect(cloudPhoneDestination(paid({ machine: undefined }))).toBeNull();
  });

  it("no paid plan, signed out or not known yet: nothing", () => {
    expect(cloudPhoneDestination(null)).toBeNull();
    expect(cloudPhoneDestination({ status: "signed-out" })).toBeNull();
    expect(cloudPhoneDestination({ status: "signed-out", message: "restoring" })).toBeNull();
    expect(cloudPhoneDestination(paid({ entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } }))).toBeNull();
    expect(cloudPhoneDestination(paid({ entitlement: { plan: "pro", status: "inactive", expiresAt: null, version: 1 } }))).toBeNull();
    expect(cloudPhoneDestination({ status: "unavailable", lastPlan: { tier: "pro", active: true }, machine: { status: "ready", origin } })).toBeNull();
    expect(cloudPhoneDestination({ status: "reauth-required", lastPlan: { tier: "pro", active: true } })).toBeNull();
  });

  it("joins this computer's line, first, and only on this computer", () => {
    const here = connectPhoneEntry("computer", null);
    expect(phoneDestinations(here, "ready").map((d) => [d.id, d.target, t(d.subtitleKey)])).toEqual([
      ["cloud", "cloud", "to My Cloud (always on)"],
      ["here", "computer", "to this computer"],
    ]);
    expect(phoneDestinations(here, "not-ready").map((d) => [d.id, d.noteKey && t(d.noteKey)])).toEqual([["here", "My Cloud shows here once it is ready."]]);
    expect(phoneDestinations(here, null).map((d) => [d.id, d.noteKey])).toEqual([["here", undefined]]);
    const cloud = connectPhoneEntry("cloud", access(admin));
    for (const state of ["ready", "not-ready", null] as const) {
      expect(phoneDestinations(cloud, state).map((d) => [d.id, t(d.subtitleKey), d.noteKey])).toEqual([["here", "to My Cloud", undefined]]);
      expect(phoneDestinations(connectPhoneEntry("server", access(admin)), state).map((d) => d.id)).toEqual(["here"]);
      expect(phoneDestinations(null, state)).toEqual([]);
    }
  });
});
