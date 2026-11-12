import { describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { createWindowPrefs } from "./app-settings.ts";
import { callRoute } from "./call-route.ts";

const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const phone: RequestAuth = { kind: "loopback", scopes: ["client"] };

describe("window preferences on the server", () => {
  it("keeps what an owner's window reports, drops what the schema refuses, and pushes a change as a frame", async () => {
    const frames: Record<string, unknown>[] = [];
    const prefs = createWindowPrefs({ broadcast: (frame) => frames.push(frame), ownerOrAdmin: (auth) => auth.scopes.includes("admin") });
    expect(prefs.write("appearance.skin", "midnight")).toContain("Open MausBot on this computer first");
    expect(await callRoute(prefs.routes, { method: "PUT", path: "/api/window-prefs", body: { values: { "appearance.skin": "daylight" } }, auth: phone })).toMatchObject({ status: 403 });
    expect(await callRoute(prefs.routes, { method: "PUT", path: "/api/window-prefs", body: { values: { "appearance.skin": "daylight", "appearance.font": "comic", "nope": 1 } }, auth: owner })).toMatchObject({ status: 200 });
    expect(prefs.read("appearance.skin")).toBe("daylight");
    expect(prefs.read("appearance.font")).toBeUndefined();
    expect(prefs.write("appearance.skin", "midnight")).toBeNull();
    expect(prefs.read("appearance.skin")).toBe("midnight");
    expect(frames).toEqual([{ kind: "window-pref", id: "appearance.skin", value: "midnight" }]);
  });
});
