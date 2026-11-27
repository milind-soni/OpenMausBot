// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { overSeats, readLicenceState, type LicenceState } from "@/lib/licence-state";
import { SettingsLook } from "./SettingsPrimitives";
import { LICENCE_PASTE_COMMAND, LicenceCard, LicenceRows, SeatLimitBanner } from "./LicenceCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATE: LicenceState = {
  valid: true, source: "file", plan: "business-server", seats: 20, expiresAt: "2026-12-31", expiresInDays: 34, graceEndsAt: "2027-01-14",
  graceDaysLeft: null, seatsUsed: 7, files: true, connected: true,
};

let host: HTMLDivElement;
let root: Root;
const fetches: string[] = [];
let answer: unknown = STATE;

beforeEach(() => {
  setLocale("en");
  fetches.length = 0;
  answer = STATE;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    fetches.push(String(input));
    return Response.json(answer);
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const draw = (node: ReturnType<typeof createElement>) => act(() => root.render(createElement(SettingsLook.Provider, { value: true }, node)));
const text = () => host.textContent ?? "";

describe("the licence card", () => {
  it("shows the plan, where the licence came from, seats used of seats, the renewal date and the paste line", () => {
    draw(createElement(LicenceRows, { state: STATE }));
    expect(text()).toContain("Business (self-hosted)");
    expect(text()).toContain("Connected to MausBot, which renews it automatically");
    expect(text()).toContain("7 of 20 used");
    expect(text()).toContain("Renews");
    expect(text()).toContain("December 31, 2026");
    expect(host.querySelector("code")?.textContent).toBe(LICENCE_PASTE_COMMAND);
    expect(host.querySelectorAll("input, select, [role=switch]")).toHaveLength(0);
  });

  it("names a pasted file, says when it expires, and counts the days of grace left once it has", () => {
    draw(createElement(LicenceRows, { state: { ...STATE, connected: false } }));
    expect(text()).toContain("From a licence file saved on this server (license.key)");
    expect(text()).toContain("Expires");
    draw(createElement(LicenceRows, { state: { ...STATE, connected: false, expiresInDays: -4, graceDaysLeft: 10 } }));
    expect(text()).toContain("Expired");
    expect(text()).toContain("10 days of grace left. Licensed features stop on January 14, 2027");
    draw(createElement(LicenceRows, { state: { ...STATE, valid: false, connected: false, graceDaysLeft: 0, source: "last-good" } }));
    expect(text()).toContain("Licensed features are off. Bots, data and sign-in keep working.");
    expect(text()).toContain("From the copy this server kept of its last licence");
  });

  it("says so when there is no licence, and when there is no seat limit", () => {
    draw(createElement(LicenceRows, { state: { ...STATE, valid: false, source: null, plan: null, seats: null, expiresAt: null, expiresInDays: null, graceEndsAt: null, connected: false } }));
    expect(text()).toContain("No licence");
    expect(text()).toContain("Add a licence by hand");
    draw(createElement(LicenceRows, { state: { ...STATE, seats: null } }));
    expect(text()).toContain("7 in use, no limit");
  });

  it("reads GET /api/license only when asked to, and shows nothing for a place that reads no licence files", async () => {
    draw(createElement(LicenceCard, { enabled: false }));
    await act(async () => {});
    expect(fetches).toEqual([]);
    expect(text()).toBe("");
    answer = { ...STATE, files: false };
    draw(createElement(LicenceCard, { enabled: true }));
    await act(async () => {});
    expect(fetches.some((url) => url.endsWith("/api/license"))).toBe(true);
    expect(text()).toBe("");
    expect(readLicenceState({ ...STATE, files: false })).toBeNull();
  });
});

describe("the seat banner", () => {
  it("shows for an admin when more people can sign in than the plan has seats, and never otherwise", async () => {
    answer = { ...STATE, seatsUsed: 23 };
    draw(createElement(SeatLimitBanner, { enabled: true }));
    await act(async () => {});
    expect(host.querySelector("[data-seat-banner]")?.textContent).toBe(
      "23 people can sign in, more than the 20 seats on this server's plan. New invites wait until seats are added from your MausBot account. Nobody is signed out.",
    );
    expect(overSeats({ ...STATE, seatsUsed: 20 })).toBeNull();
    expect(overSeats({ ...STATE, seatsUsed: 23, valid: false })).toBeNull();
    expect(overSeats({ ...STATE, seatsUsed: 23, seats: null })).toBeNull();
    fetches.length = 0;
    draw(createElement(SeatLimitBanner, { enabled: false }));
    await act(async () => {});
    expect(host.querySelector("[data-seat-banner]")).toBeNull();
  });
});
