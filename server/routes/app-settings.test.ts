import { describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { createWindowPrefs } from "./app-settings.ts";
import { callRoute } from "./call-route.ts";

const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const phone: RequestAuth = { kind: "loopback", scopes: ["client"] };

describe("window preferences on the server", () => {
  it("keeps what an owner's window reports, drops what the schema refuses, and pushes a change as a frame", async () => {
    const frames: Record<string, unknown>[] = [];
    const prefs = createWindowPrefs({ broadcast: (frame) => frames.push(frame), ownerOrAdmin: (auth) => auth.scopes.includes("admin"), windowOpen: () => true });
    expect(await callRoute(prefs.routes, { method: "PUT", path: "/api/window-prefs", body: { values: { "appearance.skin": "daylight" } }, auth: phone })).toMatchObject({ status: 403 });
    expect(await callRoute(prefs.routes, { method: "PUT", path: "/api/window-prefs", body: { values: { "appearance.skin": "daylight", "appearance.font": "comic", "nope": 1 } }, auth: owner })).toMatchObject({ status: 200 });
    expect(prefs.read("appearance.skin")).toBe("daylight");
    expect(prefs.read("appearance.font")).toBeUndefined();
    expect(prefs.write("appearance.skin", "midnight")).toBeNull();
    expect(prefs.read("appearance.skin")).toBe("midnight");
    expect(frames).toEqual([{ kind: "window-pref", id: "appearance.skin", value: "midnight" }]);
  });

  it("changes nothing while no window is open, and works again once one reconnects", async () => {
    const frames: Record<string, unknown>[] = [];
    let open = true;
    const prefs = createWindowPrefs({ broadcast: (frame) => frames.push(frame), ownerOrAdmin: () => true, windowOpen: () => open });
    await callRoute(prefs.routes, { method: "PUT", path: "/api/window-prefs", body: { values: { "appearance.skin": "daylight" } }, auth: owner });
    expect(prefs.write("appearance.skin", "midnight")).toBeNull();
    open = false;
    expect(prefs.write("appearance.skin", "dusk")).toBe("Open MausBot on this computer first; this setting lives in the app window.");
    expect(prefs.read("appearance.skin")).toBe("midnight");
    open = true;
    expect(prefs.write("appearance.skin", "dusk")).toBeNull();
    expect(frames.map((frame) => frame.value)).toEqual(["midnight", "dusk"]);
  });

  it("refuses a preference the window never reported, such as a desktop-only one from a browser", () => {
    const frames: Record<string, unknown>[] = [];
    const prefs = createWindowPrefs({ broadcast: (frame) => frames.push(frame), ownerOrAdmin: () => true, windowOpen: () => true });
    expect(prefs.write("remote.relay", true)).toMatch(/^The open MausBot window can't change this here\./);
    expect(frames).toEqual([]);
  });
});
