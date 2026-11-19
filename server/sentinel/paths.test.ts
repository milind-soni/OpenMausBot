import { describe, expect, it } from "vitest";

import { defaultSentinelOut, isInside } from "./paths.ts";

describe("sentinel paths", () => {
  it("keeps Sentinel's files in the platform's state folder, outside the data dir", () => {
    expect(defaultSentinelOut("/Users/ind/.openindbot", "darwin", "/Users/ind", {})).toBe("/Users/ind/Library/Application Support/openindbot-sentinel");
    expect(defaultSentinelOut("/home/ind/.openindbot", "linux", "/home/ind", {})).toBe("/home/ind/.local/state/openindbot-sentinel");
    expect(defaultSentinelOut("/home/ind/.openindbot", "linux", "/home/ind", { XDG_STATE_HOME: "/var/state/ind" })).toBe("/var/state/ind/openindbot-sentinel");
    // a relative XDG_STATE_HOME is invalid by the spec and ignored
    expect(defaultSentinelOut("/home/ind/.openindbot", "linux", "/home/ind", { XDG_STATE_HOME: "state" })).toBe("/home/ind/.local/state/openindbot-sentinel");
    expect(defaultSentinelOut("C:\\Users\\ind\\.openindbot", "win32", "C:\\Users\\ind", { LOCALAPPDATA: "D:\\Local" })).toBe("D:\\Local\\openindbot-sentinel");
  });

  it("gives any other data dir its own subfolder, the same one every time", () => {
    const other = defaultSentinelOut("/srv/omb-data", "linux", "/home/ind", {});
    expect(other).toMatch(/^\/home\/ind\/\.local\/state\/openindbot-sentinel\/data-[0-9a-f]{12}$/);
    expect(defaultSentinelOut("/srv/omb-data", "linux", "/home/ind", {})).toBe(other);
    expect(defaultSentinelOut("/srv/omb-data-2", "linux", "/home/ind", {})).not.toBe(other);
  });

  it("knows when a folder is inside another", () => {
    expect(isInside("/d/omb/sentinel", "/d/omb", "linux")).toBe(true);
    expect(isInside("/d/omb", "/d/omb", "linux")).toBe(true);
    expect(isInside("/d/omb-sentinel", "/d/omb", "linux")).toBe(false);
    expect(isInside("/d", "/d/omb", "linux")).toBe(false);
    expect(isInside("C:\\d\\omb\\x", "C:\\d\\omb", "win32")).toBe(true);
  });
});
