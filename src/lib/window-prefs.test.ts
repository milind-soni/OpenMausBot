import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyWindowPref, reportWindowPrefs, windowPrefValues } from "./window-prefs";

const values = new Map<string, string>();
beforeEach(() => {
  values.clear();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("window preferences", () => {
  it("applies a frame with the preference's setter and ignores a value the schema refuses", async () => {
    applyWindowPref({ kind: "window-pref", id: "general.sendKey", value: "mod-enter" });
    expect(values.get("omb-send-key")).toBe("mod-enter");
    applyWindowPref({ kind: "window-pref", id: "general.sendKey", value: "space" });
    expect(values.get("omb-send-key")).toBe("mod-enter");
    applyWindowPref({ kind: "window-pref", id: "general.notificationSounds", value: false });
    applyWindowPref({ kind: "window-pref", id: "appearance.pinnedCircles", value: true });
    expect(await windowPrefValues()).toMatchObject({ "general.sendKey": "mod-enter", "general.notificationSounds": false, "appearance.pinnedCircles": true });
  });

  it("reports the window's values once after a burst of setters", async () => {
    vi.useFakeTimers();
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    applyWindowPref({ kind: "window-pref", id: "general.sendKey", value: "shift-enter" });
    reportWindowPrefs();
    reportWindowPrefs();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetched).toHaveBeenCalledTimes(1);
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/window-prefs");
    expect(JSON.parse(String(init.body)).values).toMatchObject({ "general.sendKey": "shift-enter" });
  });

  it("leaves out a preference whose desktop bridge this window lacks, so the server refuses it here", async () => {
    const values = await windowPrefValues();
    expect(values).not.toHaveProperty("remote.relay");
    expect(values).not.toHaveProperty("general.openAtLogin");
  });

  it("reads and switches a remote route through the companion bridge on this computer's page", async () => {
    const routes = { wifi: { on: false, since: null }, relay: { on: true, since: 1 } };
    const setRoute = vi.fn(async (route: "wifi" | "relay", on: boolean) => { routes[route].on = on; return { routes } as never; });
    const ogb = { companion: { state: async () => ({ routes, keepAwake: false }), setRoute } };
    vi.stubGlobal("window", { ogb });
    vi.stubGlobal("ogb", ogb);
    expect(await windowPrefValues()).toMatchObject({ "remote.wifi": false, "remote.relay": true, "remote.keepAwake": false });
    applyWindowPref({ kind: "window-pref", id: "remote.wifi", value: true });
    expect(setRoute).toHaveBeenCalledWith("wifi", true);
  });
});
