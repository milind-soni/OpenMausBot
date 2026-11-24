import { describe, expect, it } from "vitest";

import { currentModeUpdateId, readSessionModes, selectAdvertisedMode, withSessionMode } from "./session-modes.ts";

describe("readSessionModes", () => {
  it("parses Hermes advertised modes and currentModeId", () => {
    expect(readSessionModes({
      sessionId: "s-1",
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "accept_edits", name: "Accept Edits" },
          { id: "dont_ask", name: "Don't Ask" },
        ],
      },
    })).toEqual({
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "accept_edits", name: "Accept Edits" },
        { id: "dont_ask", name: "Don't Ask" },
      ],
    });
  });

  it("drops invalid entries, omits blank currentModeId, and returns null when empty or absent", () => {
    expect(readSessionModes(null)).toBeNull();
    expect(readSessionModes({})).toBeNull();
    expect(readSessionModes({ modes: {} })).toBeNull();
    expect(readSessionModes({ modes: { availableModes: [] } })).toBeNull();
    expect(readSessionModes({ modes: { currentModeId: "  ", availableModes: [{ id: "" }, { name: "Missing id" }] } })).toBeNull();
    expect(readSessionModes({
      modes: {
        currentModeId: "   ",
        availableModes: [{ id: "  " }, { id: "default", name: "  " }, { id: "accept_edits", name: "Accept Edits" }],
      },
    })).toEqual({
      availableModes: [
        { id: "default" },
        { id: "accept_edits", name: "Accept Edits" },
      ],
    });
  });
});

describe("selectAdvertisedMode", () => {
  const hermesModes = [
    { id: "default", name: "Default" },
    { id: "accept_edits", name: "Accept Edits" },
    { id: "dont_ask", name: "Don't Ask" },
  ];

  it("maps OMB approval levels onto Hermes advertised modes while keeping auto conservative", () => {
    expect(selectAdvertisedMode(hermesModes, "ask", false)).toBe("default");
    expect(selectAdvertisedMode(hermesModes, "edits", false)).toBe("accept_edits");
    expect(selectAdvertisedMode(hermesModes, "auto", false)).toBe("default");
    expect(selectAdvertisedMode(hermesModes, "full", false)).toBe("default");
    expect(selectAdvertisedMode(hermesModes, undefined, false)).toBe("default");
    expect(selectAdvertisedMode(hermesModes, undefined, true)).toBe("default");
  });

  it("never picks a don't-ask mode for full access, matches case variants, and returns null when unadvertised", () => {
    expect(selectAdvertisedMode(
      [{ id: "Default" }, { id: "acceptEdits" }, { id: "Unrestricted" }],
      "edits",
      false,
    )).toBe("acceptEdits");
    expect(selectAdvertisedMode(
      [{ id: "default" }, { id: "accept_edits" }, { id: "unrestricted" }],
      "full",
      false,
    )).toBe("default");
    expect(selectAdvertisedMode([{ id: "accept_edits" }, { id: "unrestricted" }], "full", false)).toBeNull();
    expect(selectAdvertisedMode([], "edits", false)).toBeNull();
    expect(selectAdvertisedMode([{ id: "plan" }], "edits", false)).toBeNull();
  });
});

describe("withSessionMode and currentModeUpdateId", () => {
  it("updates currentModeId without dropping advertised modes or inventing availableModes", () => {
    const initial = {
      sessionId: "s-1",
      modes: {
        currentModeId: "default",
        availableModes: [{ id: "default" }, { id: "dont_ask" }],
      },
    };
    expect(withSessionMode(initial, " dont_ask ")).toEqual({
      sessionId: "s-1",
      modes: {
        currentModeId: "dont_ask",
        availableModes: [{ id: "default" }, { id: "dont_ask" }],
      },
    });
    expect(withSessionMode(initial, "   ")).toBe(initial);
    expect(withSessionMode(initial, null)).toBe(initial);
    expect(withSessionMode(null, "default")).toEqual({ modes: { currentModeId: "default" } });
  });

  it("extracts currentModeId only from valid current_mode_update notifications", () => {
    expect(currentModeUpdateId({ sessionUpdate: "current_mode_update", currentModeId: " accept_edits " })).toBe("accept_edits");
    expect(currentModeUpdateId({ sessionUpdate: "current_mode_update", currentModeId: "  " })).toBeNull();
    expect(currentModeUpdateId({ sessionUpdate: "config_option_update", currentModeId: "dont_ask" })).toBeNull();
    expect(currentModeUpdateId(null)).toBeNull();
  });
});
