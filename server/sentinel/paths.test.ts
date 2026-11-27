import { describe, expect, it } from "vitest";

import { defaultSentinelOut, isInside } from "./paths.ts";

describe("sentinel paths", () => {
  it("keeps Sentinel's files in the platform's state folder, outside the data dir", () => {
    expect(defaultSentinelOut("/Users/maus/.openmausbot", "darwin", "/Users/maus", {})).toBe("/Users/maus/Library/Application Support/openmausbot-sentinel");
    expect(defaultSentinelOut("/home/maus/.openmausbot", "linux", "/home/maus", {})).toBe("/home/maus/.local/state/openmausbot-sentinel");
    expect(defaultSentinelOut("/home/maus/.openmausbot", "linux", "/home/maus", { XDG_STATE_HOME: "/var/state/maus" })).toBe("/var/state/maus/openmausbot-sentinel");
    // a relative XDG_STATE_HOME is invalid by the spec and ignored
    expect(defaultSentinelOut("/home/maus/.openmausbot", "linux", "/home/maus", { XDG_STATE_HOME: "state" })).toBe("/home/maus/.local/state/openmausbot-sentinel");
    expect(defaultSentinelOut("C:\\Users\\maus\\.openmausbot", "win32", "C:\\Users\\maus", { LOCALAPPDATA: "D:\\Local" })).toBe("D:\\Local\\openmausbot-sentinel");
  });

  it("gives any other data dir its own subfolder, the same one every time", () => {
    const other = defaultSentinelOut("/srv/omb-data", "linux", "/home/maus", {});
    expect(other).toMatch(/^\/home\/maus\/\.local\/state\/openmausbot-sentinel\/data-[0-9a-f]{12}$/);
    expect(defaultSentinelOut("/srv/omb-data", "linux", "/home/maus", {})).toBe(other);
    expect(defaultSentinelOut("/srv/omb-data-2", "linux", "/home/maus", {})).not.toBe(other);
  });

  it("knows when a folder is inside another", () => {
    expect(isInside("/d/omb/sentinel", "/d/omb", "linux")).toBe(true);
    expect(isInside("/d/omb", "/d/omb", "linux")).toBe(true);
    expect(isInside("/d/omb-sentinel", "/d/omb", "linux")).toBe(false);
    expect(isInside("/d", "/d/omb", "linux")).toBe(false);
    expect(isInside("C:\\d\\omb\\x", "C:\\d\\omb", "win32")).toBe(true);
  });
});
